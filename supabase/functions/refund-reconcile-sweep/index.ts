import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createServiceClient } from '../_shared/send-push.ts';
import { requireCronSecret } from '../_shared/cron-auth.ts';
import { listRefundedChargeIds, reconcileCharge } from '../_shared/refund-reconcile.ts';

/**
 * refund-reconcile-sweep — scheduled, FLAG ONLY. It never moves money.
 *
 * Re-checks every charge refunded in the last 30 days plus anything still
 * flagged, and records whether the customer refund, the merchant transfer
 * reversal and the platform-fee refund all happened. This is what catches a
 * refund issued straight from the Stripe Dashboard if its webhook was missed,
 * and what flags historical refunds (which the webhook's automatic repair
 * deliberately never touches).
 *
 * Auth: shared `x-cron-secret`, fails closed (see ../_shared/cron-auth.ts).
 * Deploy with --no-verify-jwt (cron-invoked, no user JWT).
 */
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};
const LOOKBACK_DAYS = 30;
const MAX_CHARGES_PER_RUN = 40;

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const denied = requireCronSecret(req, corsHeaders);
  if (denied) return denied;

  try {
    const svc = createServiceClient();
    const since = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400;
    const ids = new Set<string>(await listRefundedChargeIds(since));
    const { data: open } = await svc.from('refund_reconciliation')
      .select('charge_id').in('state', ['needs_repair', 'needs_review', 'repair_failed']);
    for (const r of (open ?? []) as { charge_id: string }[]) ids.add(r.charge_id);

    const counts: Record<string, number> = {};
    for (const id of [...ids].slice(0, MAX_CHARGES_PER_RUN)) {
      const r = await reconcileCharge(svc, id, { actor: 'sweep', allowRepair: false });
      counts[r.state] = (counts[r.state] ?? 0) + 1;
    }
    return json({ ok: true, checked: Math.min(ids.size, MAX_CHARGES_PER_RUN), by_state: counts });
  } catch (e) {
    console.error('[refund-reconcile-sweep]', e instanceof Error ? e.message : 'error');
    return json({ error: 'sweep failed' }, 500);
  }
});
