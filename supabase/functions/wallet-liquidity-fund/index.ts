import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';
import { getConfigBulk } from '../_shared/admin-config.ts';

/**
 * wallet-liquidity-fund — ADMIN ONLY. Creates a real Stripe Topup to fund
 * the platform's Wallet liquidity reserve. PLATFORM working capital only —
 * never touches a customer's Wallet balance, never calls any debit/credit
 * primitive.
 *
 * Gated on wallet.liquidity.funding_enabled (admin_config) — a live
 * capability check found no external bank-account source and no
 * topup-related capability flag on this account, so this defaults to
 * 'false' until Stripe confirms programmatic Topup creation is actually
 * enabled. While false, this refuses with a clear message; the admin panel
 * shows Stripe Dashboard funding instructions instead.
 *
 * Double idempotency: client_request_id is UNIQUE in
 * wallet_liquidity_topups (a duplicate submission returns the EXISTING row
 * rather than creating a second attempt), and the SAME value is sent to
 * Stripe as the request's own Idempotency-Key, so even a request that
 * reached Stripe but lost its response replays to the same Topup.
 *
 * Body: { amount_pence: number, client_request_id: string }
 */
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const STRIPE_API_VERSION = '2023-10-16';
const MIN_PENCE = 1_000;    // £10 — below this is not worth the operational overhead.
const MAX_PENCE = 100_000;  // £1,000 — a sensible ceiling against a fat-fingered amount.

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);

    const anon = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);

    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

    // Admin-only, checked BEFORE anything else privileged — the same
    // profiles.role/is_platform_owner pattern as refund-payment and
    // wallet-liquidity-snapshot. An ordinary business owner must never
    // reach the Stripe call below.
    const { data: me } = await svc.from('profiles')
      .select('role, is_platform_owner').eq('id', user.id).maybeSingle();
    const isAdmin = me?.role === 'admin' || me?.is_platform_owner === true;
    if (!isAdmin) return json({ error: 'Admin only' }, 403);

    const body = await req.json().catch(() => ({}));
    const amountPence = Number(body.amount_pence);
    const clientRequestId = typeof body.client_request_id === 'string' ? body.client_request_id.trim() : '';
    if (!Number.isFinite(amountPence) || !Number.isInteger(amountPence)) {
      return json({ error: 'amount_pence must be a whole number of pence' }, 400);
    }
    if (amountPence < MIN_PENCE || amountPence > MAX_PENCE) {
      return json({ error: `Amount must be between £${(MIN_PENCE / 100).toFixed(2)} and £${(MAX_PENCE / 100).toFixed(2)}` }, 400);
    }
    if (clientRequestId.length < 8 || clientRequestId.length > 100) {
      return json({ error: 'client_request_id required' }, 400);
    }

    const cfg = await getConfigBulk(svc, [
      'wallet.liquidity.funding_enabled',
      'wallet.liquidity.reserve_pence',
      'wallet.liquidity.desired_headroom_pence',
    ]);
    if (cfg.get('wallet.liquidity.funding_enabled') !== 'true') {
      return json({ error: 'Funding must currently be completed in Stripe — programmatic Topup creation is not enabled for this account.' }, 400);
    }
    const reservePence = Number(cfg.get('wallet.liquidity.reserve_pence')) || 10_000;
    const headroomPence = Number(cfg.get('wallet.liquidity.desired_headroom_pence')) || 5_000;

    // ── Idempotent claim ───────────────────────────────────────────────────
    // A duplicate submission (double-tap, retried request) with the SAME
    // client_request_id hits this unique constraint and we return the
    // EXISTING row — never a second Stripe call.
    const { data: inserted, error: insertErr } = await svc
      .from('wallet_liquidity_topups')
      .insert({
        client_request_id: clientRequestId,
        amount_pence: amountPence,
        status: 'creating',
        initiated_by: user.id,
        reserve_target_pence: reservePence,
        desired_headroom_pence: headroomPence,
      })
      .select('id')
      .single();

    if (insertErr) {
      if (insertErr.code === '23505') { // unique_violation on client_request_id
        const { data: existing } = await svc
          .from('wallet_liquidity_topups')
          .select('*')
          .eq('client_request_id', clientRequestId)
          .maybeSingle();
        // A failed attempt is dead: report it as a failure rather than a
        // successful replay, so the caller starts a fresh attempt.
        if (existing?.status === 'error') {
          return json({ error: existing.failure_message ?? 'The previous funding attempt failed.' }, 409);
        }
        return json({ ok: true, topup: existing, replay: true });
      }
      console.error('[wallet-liquidity-fund] could not claim request:', insertErr);
      return json({ error: 'Could not start this funding request. Please try again.' }, 500);
    }

    // ── The one real Stripe call, server-side only ──────────────────────────
    // Idempotency-Key = client_request_id, so a lost response replays to the
    // SAME Topup at Stripe rather than creating a second one.
    const stripeRes = await fetch('https://api.stripe.com/v1/topups', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': STRIPE_API_VERSION,
        'Idempotency-Key': clientRequestId,
      },
      body: new URLSearchParams({
        amount: String(amountPence),
        currency: 'gbp',
        description: 'OneShetland Local Wallet liquidity reserve funding',
        'metadata[purpose]': 'wallet_liquidity',
        'metadata[initiated_by]': user.id,
        'metadata[reserve_target_pence]': String(reservePence),
      }),
    });
    const topup = await stripeRes.json();

    if (!stripeRes.ok) {
      const message = topup.error?.message ?? `Stripe Topup request failed (HTTP ${stripeRes.status})`;
      await svc.from('wallet_liquidity_topups')
        .update({ status: 'error', failure_message: message, updated_at: new Date().toISOString() })
        .eq('id', inserted.id);
      console.error('[wallet-liquidity-fund] Stripe rejected the Topup:', message);
      return json({ error: message }, 502);
    }

    const { data: row } = await svc.from('wallet_liquidity_topups')
      .update({
        stripe_topup_id: topup.id,
        status: topup.status,
        failure_message: topup.failure_message ?? null,
        expected_availability_date: topup.expected_availability_date
          ? new Date(topup.expected_availability_date * 1000).toISOString().slice(0, 10)
          : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', inserted.id)
      .select('*')
      .single();

    return json({ ok: true, topup: row });
  } catch (err) {
    console.error('[wallet-liquidity-fund]', err);
    return json({ error: safeError('wallet-liquidity-fund', err) }, 500);
  }
});
