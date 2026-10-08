import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';
import { getWalletLiquiditySnapshot } from '../_shared/wallet-liquidity.ts';
import { OPEN_SESSION_STATUSES } from '../_shared/wallet-funding-match.ts';

/**
 * wallet-liquidity-funding-session — ADMIN ONLY. Records that the operator is
 * sending a push bank transfer to fund the Wallet liquidity reserve, so the
 * transfer can be recognised when it reaches Stripe.
 *
 * THIS MOVES NO MONEY. It makes no Stripe write of any kind (the only Stripe
 * read is the live balance snapshot used as the baseline), creates no Topup,
 * and touches no customer Wallet balance or ledger.
 *
 * Body: { action: 'start', requested_amount_pence, client_request_id }
 *       { action: 'cancel', session_id }
 */
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const MIN_PENCE = 1_000;      // £10
const MAX_PENCE = 1_000_000;  // £10,000 — a ceiling against a mistyped amount

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

    const { data: me } = await svc.from('profiles')
      .select('role, is_platform_owner').eq('id', user.id).maybeSingle();
    const isAdmin = me?.role === 'admin' || me?.is_platform_owner === true;
    if (!isAdmin) return json({ error: 'Admin only' }, 403);

    const body = await req.json().catch(() => ({}));

    if (body.action === 'cancel') {
      const sessionId = typeof body.session_id === 'string' ? body.session_id : '';
      if (!sessionId) return json({ error: 'session_id required' }, 400);
      // Only a session still waiting for funds can be withdrawn; once Stripe
      // has seen the money it is real and stays on the record.
      const { data: cancelled, error } = await svc.from('wallet_liquidity_funding_sessions')
        .update({ status: 'cancelled', resolution_note: 'Cancelled by an admin before any funds were seen at Stripe.', updated_at: new Date().toISOString() })
        .eq('id', sessionId).eq('status', 'awaiting_funds').select('id').maybeSingle();
      if (error) return json({ error: 'Could not cancel this funding session.' }, 500);
      if (!cancelled) return json({ error: 'Only a session still awaiting funds can be cancelled.' }, 409);
      return json({ ok: true });
    }

    if (body.action !== 'start') return json({ error: 'Unknown action' }, 400);

    const amount = Number(body.requested_amount_pence);
    const clientRequestId = typeof body.client_request_id === 'string' ? body.client_request_id.trim() : '';
    if (!Number.isInteger(amount)) return json({ error: 'requested_amount_pence must be a whole number of pence' }, 400);
    if (amount < MIN_PENCE || amount > MAX_PENCE) {
      return json({ error: `Amount must be between £${(MIN_PENCE / 100).toFixed(2)} and £${(MAX_PENCE / 100).toFixed(2)}` }, 400);
    }
    if (clientRequestId.length < 8 || clientRequestId.length > 100) return json({ error: 'client_request_id required' }, 400);

    // Baseline comes from Stripe's live balance via the one canonical snapshot
    // — never from a client-supplied figure.
    const snap = await getWalletLiquiditySnapshot(svc);
    if (snap.status === 'unknown' || snap.status === 'disabled') {
      return json({ error: 'Stripe\'s balance could not be read just now, so a baseline cannot be recorded. Try again shortly.' }, 503);
    }

    const { data: inserted, error: insertErr } = await svc.from('wallet_liquidity_funding_sessions')
      .insert({
        client_request_id: clientRequestId,
        requested_amount_pence: amount,
        target_available_pence: snap.reserve_pence + snap.desired_headroom_pence,
        baseline_available_pence: snap.available_pence,
        baseline_pending_pence: snap.pending_pence,
        reserve_target_pence: snap.reserve_pence,
        desired_headroom_pence: snap.desired_headroom_pence,
        initiated_by: user.id,
        status: 'awaiting_funds',
      })
      .select('*').single();

    if (insertErr) {
      if (insertErr.code === '23505') {
        // Either this exact request was already recorded (double-tap), or
        // another session is already open. In both cases return the existing
        // one rather than creating a second intent.
        const { data: dup } = await svc.from('wallet_liquidity_funding_sessions')
          .select('*').eq('client_request_id', clientRequestId).maybeSingle();
        if (dup) return json({ ok: true, session: dup, replay: true });
        const { data: open } = await svc.from('wallet_liquidity_funding_sessions')
          .select('*').in('status', OPEN_SESSION_STATUSES).order('created_at', { ascending: false }).limit(1).maybeSingle();
        return json({ error: 'A funding transfer is already being tracked. Wait for it to resolve, or cancel it first.', session: open ?? null }, 409);
      }
      console.error('[wallet-liquidity-funding-session] insert failed:', insertErr.code);
      return json({ error: 'Could not record this funding transfer. Please try again.' }, 500);
    }
    return json({ ok: true, session: inserted });
  } catch (err) {
    console.error('[wallet-liquidity-funding-session]', err instanceof Error ? err.name : 'error');
    return json({ error: safeError('wallet-liquidity-funding-session', err) }, 500);
  }
});
