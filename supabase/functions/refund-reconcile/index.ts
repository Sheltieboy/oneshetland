import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';
import { listRefundedChargeIds, listWalletOrdersToCheck, reconcileCharge, reconcileWalletOrder } from '../_shared/refund-reconcile.ts';

/**
 * refund-reconcile — ADMIN ONLY.
 *
 *   { action: 'list' }                       reconciliation rows, open ones first (read-only)
 *   { action: 'scan' }                       re-check every refunded charge in Stripe (read-only, flags only)
 *   { action: 'repair', charge_id, confirm } complete a missing transfer reversal / fee refund
 *
 * Wallet-funded event orders appear in the same list (rail event_ticket_wallet) and are
 * checked by 'scan', but are never repaired here: a Wallet refund is completed by running
 * the refund again, and 'repair' only accepts a card charge (ch_…).
 *
 * 'repair' MOVES MONEY (it debits the merchant's connected account and
 * returns the platform fee to it). It runs only on an explicit admin request
 * with confirm: true, only for a FULL refund, and is recorded in
 * refund_reconciliation_events with the admin's id. The live state is
 * recomputed from Stripe first, so a repeat is a no-op.
 */
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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
    const action = typeof body.action === 'string' ? body.action : 'list';

    if (action === 'repair') {
      const chargeId = typeof body.charge_id === 'string' ? body.charge_id : '';
      if (!/^ch_[A-Za-z0-9]+$/.test(chargeId)) return json({ error: 'charge_id required' }, 400);
      if (body.confirm !== true) return json({ error: 'confirm: true is required to move money' }, 400);
      // Only a charge this system has already seen and flagged can be repaired.
      const { data: row } = await svc.from('refund_reconciliation')
        .select('state').eq('charge_id', chargeId).maybeSingle();
      if (!row) return json({ error: 'This charge has not been flagged yet — run a scan first.' }, 409);
      if (row.state !== 'needs_repair' && row.state !== 'repair_failed') {
        return json({ error: `Nothing to repair (state is ${row.state}).` }, 409);
      }
      const result = await reconcileCharge(svc, chargeId, { actor: `admin:${user.id}`, allowRepair: true, force: true });
      return json({ ok: true, result });
    }

    if (action === 'scan') {
      const ids = await listRefundedChargeIds();
      const results = [];
      for (const id of ids.slice(0, 60)) results.push(await reconcileCharge(svc, id, { actor: `admin:${user.id}`, allowRepair: false }));
      // Wallet-funded event orders: verified from the ledger and the Connect transfer (read-only).
      const walletResults = [];
      for (const id of await listWalletOrdersToCheck(svc, 36500, 60)) {
        walletResults.push(await reconcileWalletOrder(svc, id, `admin:${user.id}`));
      }
      return json({ ok: true, checked: results.length + walletResults.length, results, wallet_results: walletResults });
    }

    const [{ data: rows }, { data: unverified }] = await Promise.all([
      svc.from('refund_reconciliation').select('*').order('updated_at', { ascending: false }).limit(50),
      svc.from('event_refund_reconciliation').select('order_id, payment_intent_id, total_pence, refunded_at')
        .eq('reconciliation_state', 'unverified'),
    ]);
    const list = (rows ?? []) as { state: string }[];
    const open = list.filter((r) => r.state !== 'reconciled' && r.state !== 'repaired');
    return json({
      open_count: open.length,
      rows: [...open, ...list.filter((r) => r.state === 'reconciled' || r.state === 'repaired')],
      unverified_event_refunds: unverified ?? [],
    });
  } catch (err) {
    console.error('[refund-reconcile]', err instanceof Error ? err.name : 'error');
    return json({ error: safeError('refund-reconcile', err) }, 500);
  }
});
