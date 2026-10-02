import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';

/**
 * wallet-funding-details — ADMIN ONLY. The Stripe-provided bank details that
 * the operator pushes a Wallet-reserve transfer to (beneficiary, account
 * number, sort code, optional instructions).
 *
 * Stripe exposes no API for these, so an admin enters them once. They live in
 * wallet_funding_bank_details, which only service_role can read; this
 * function is the only path to them, and it is admin-gated. They are never
 * logged, never included in the liquidity snapshot payload, and an edit is
 * audited (who, when, which fields, last four digits only — never the values).
 *
 * Body: { action: 'get' }
 *       { action: 'set', beneficiary, account_number, sort_code, instructions? }
 */
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), {
      status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);

    const anon = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);

    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

    // Admin check BEFORE any read of the details table.
    const { data: me } = await svc.from('profiles')
      .select('role, is_platform_owner').eq('id', user.id).maybeSingle();
    const isAdmin = me?.role === 'admin' || me?.is_platform_owner === true;
    if (!isAdmin) return json({ error: 'Admin only' }, 403);

    const body = await req.json().catch(() => ({}));
    const action = body.action === 'set' ? 'set' : 'get';

    const { data: current } = await svc.from('wallet_funding_bank_details')
      .select('beneficiary, account_number, sort_code, instructions, updated_at').eq('id', true).maybeSingle();

    if (action === 'get') {
      return json({ configured: !!current, details: current ?? null });
    }

    // ── set ────────────────────────────────────────────────────────────────
    const beneficiary = typeof body.beneficiary === 'string' ? body.beneficiary.trim() : '';
    const accountNumber = typeof body.account_number === 'string' ? body.account_number.replace(/\s+/g, '') : '';
    const sortCode = typeof body.sort_code === 'string' ? body.sort_code.replace(/[\s-]/g, '') : '';
    const instructions = typeof body.instructions === 'string' && body.instructions.trim()
      ? body.instructions.trim() : null;

    if (beneficiary.length < 1 || beneficiary.length > 120) return json({ error: 'Beneficiary name is required (max 120 characters).' }, 400);
    if (!/^[0-9]{8}$/.test(accountNumber)) return json({ error: 'Account number must be 8 digits.' }, 400);
    if (!/^[0-9]{6}$/.test(sortCode)) return json({ error: 'Sort code must be 6 digits.' }, 400);
    if (instructions && instructions.length > 600) return json({ error: 'Instructions are limited to 600 characters.' }, 400);

    const changed: string[] = [];
    if (current?.beneficiary !== beneficiary) changed.push('beneficiary');
    if (current?.account_number !== accountNumber) changed.push('account_number');
    if (current?.sort_code !== sortCode) changed.push('sort_code');
    if ((current?.instructions ?? null) !== instructions) changed.push('instructions');
    if (changed.length === 0) return json({ configured: true, details: current, unchanged: true });

    const { error: auditErr } = await svc.from('wallet_funding_bank_details_audit').insert({
      changed_by: user.id, changed_fields: changed, account_number_last4: accountNumber.slice(-4),
    });
    if (auditErr) {
      console.error('[wallet-funding-details] audit write failed:', auditErr.code);
      return json({ error: 'Could not record the audit entry, so the change was not saved.' }, 500);
    }

    const { data: saved, error: saveErr } = await svc.from('wallet_funding_bank_details')
      .upsert({
        id: true, beneficiary, account_number: accountNumber, sort_code: sortCode,
        instructions, updated_by: user.id, updated_at: new Date().toISOString(),
      })
      .select('beneficiary, account_number, sort_code, instructions, updated_at').single();
    if (saveErr) {
      console.error('[wallet-funding-details] save failed:', saveErr.code);
      return json({ error: 'Could not save the funding details.' }, 500);
    }
    return json({ configured: true, details: saved });
  } catch (err) {
    console.error('[wallet-funding-details]', err instanceof Error ? err.name : 'error');
    return json({ error: safeError('wallet-funding-details', err) }, 500);
  }
});
