import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPush } from '../_shared/send-push.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// How long a scan-to-charge request stays actionable before it lapses.
const EXPIRY_SECONDS = 180;

/**
 * wallet-charge-request
 *
 * BUSINESS side of charge-by-scan. The business scans the customer's ONE member
 * card and asks for a payment of `amount_pence`. This creates a PENDING request
 * only — no money moves until the customer approves it on their own phone
 * (wallet-charge-approve). Mirrors loyalty-till's business + member resolution.
 *
 * Body: { member_code, business_id?, amount_pence }
 * Returns: { request_id, customer_name, amount_pence, expires_at }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);
    const anon = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);
    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

    const { member_code, business_id, amount_pence } = await req.json();
    if (!member_code) return json({ error: 'member_code required' }, 400);
    if (amount_pence == null || amount_pence < 50) return json({ error: 'Enter an amount of at least £0.50' }, 400);

    // Which of the caller's businesses is the till for? (Same resolution as loyalty-till.)
    const { data: myBiz } = await svc
      .from('local_businesses')
      .select('id, name, owner_id, accepts_wallet, stripe_account_id, payout_enabled')
      .eq('owner_id', user.id).eq('is_active', true);
    const biz = business_id ? (myBiz ?? []).find((b) => b.id === business_id) : (myBiz ?? [])[0];
    if (!biz) return json({ error: (myBiz ?? []).length ? 'Pick which business this is for' : 'You do not run a business' }, 403);

    // The business must be able to actually receive the money before we ask the
    // customer to approve — otherwise they'd approve into a dead end.
    if (!biz.accepts_wallet) return json({ error: "This business doesn't accept wallet payments yet" }, 400);
    if (!biz.stripe_account_id || !biz.payout_enabled) return json({ error: "Finish Stripe onboarding before taking wallet payments" }, 400);

    // Resolve the customer from their member code.
    const { data: cust } = await svc.from('profiles').select('id, display_name, full_name').eq('member_code', String(member_code).toUpperCase().trim()).maybeSingle();
    if (!cust) return json({ error: 'Member code not found' }, 404);
    if (cust.id === user.id) return json({ error: "That's your own code" }, 400);
    const custName = cust.display_name || cust.full_name || 'Member';

    const expiresAt = new Date(Date.now() + EXPIRY_SECONDS * 1000).toISOString();
    const { data: reqRow, error: insErr } = await svc
      .from('wallet_charge_requests')
      .insert({
        business_id:  biz.id,
        requested_by: user.id,
        customer_id:  cust.id,
        amount_pence,
        status:       'pending',
        expires_at:   expiresAt,
      })
      .select('id')
      .single();
    if (insErr || !reqRow) throw (insErr ?? new Error('Could not create the charge request'));

    // Nudge the customer's phone (realtime already delivers it; this is a belt-
    // and-braces push in case the approval screen isn't open).
    try {
      await sendUserPush(svc, {
        userId: cust.id, module: 'wallet', categoryId: 'wallet.charge_request',
        title: 'Approve a payment?',
        body: `${biz.name} is asking you to pay £${(amount_pence / 100).toFixed(2)}. Tap to approve or decline.`,
        data: { screen: 'local-wallet', charge_request_id: reqRow.id },
        urgent: true,
      });
    } catch (e) { console.error('[wallet-charge-request] push failed', e); }

    return json({ request_id: reqRow.id, customer_name: custName, amount_pence, expires_at: expiresAt });
  } catch (err) {
    console.error('[wallet-charge-request]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});
