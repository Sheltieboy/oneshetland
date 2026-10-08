import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createServiceClient, sendPush } from '../_shared/send-push.ts';
import { requireCronSecret } from '../_shared/cron-auth.ts';
import { getWalletLiquiditySnapshot } from '../_shared/wallet-liquidity.ts';
import { reconcileFundingSessions } from '../_shared/wallet-funding-sessions.ts';

/**
 * wallet-liquidity-monitor
 *
 * Scheduled check of Local Wallet liquidity (see _shared/wallet-liquidity.ts
 * and migration 20261025050000). Pages every admin with a device token when
 * the status WORSENS (healthy→low, low→critical, healthy→critical) — never
 * on every tick while a status persists, which would train admins to ignore
 * the alert. The single-row local_wallet_liquidity_alert_state table is the
 * only state this keeps.
 *
 * Auth: callers must present the shared `x-cron-secret` header (see
 * ../_shared/cron-auth.ts) — fails closed, same as the other scheduled
 * functions. Deploy with --no-verify-jwt (cron-invoked, no user JWT).
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

const SEVERITY: Record<string, number> = { healthy: 0, disabled: 0, unknown: 1, low: 1, critical: 2 };

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  // Fails CLOSED: no server secret is a 503, a bad or absent header is a 401.
  // Nothing privileged happens above this line.
  const denied = requireCronSecret(req, corsHeaders);
  if (denied) return denied;

  const svc = createServiceClient();
  const snapshot = await getWalletLiquiditySnapshot(svc);

  // Recognise an operator's push bank transfer when it reaches Stripe. Reads
  // Stripe only when a funding session is open; never throws.
  const funding = await reconcileFundingSessions(svc);

  const { data: state } = await svc
    .from('local_wallet_liquidity_alert_state')
    .select('last_status, last_alerted_at')
    .eq('id', true)
    .maybeSingle();
  const lastStatus = state?.last_status ?? 'healthy';

  const worsened = (SEVERITY[snapshot.status] ?? 0) > (SEVERITY[lastStatus] ?? 0);
  let notified = 0;

  if (worsened && (snapshot.status === 'low' || snapshot.status === 'critical' || snapshot.status === 'unknown')) {
    const { data: admins } = await svc
      .from('profiles')
      .select('push_token')
      .eq('role', 'admin')
      .not('push_token', 'is', null);

    const headroomGbp = (snapshot.headroom_pence / 100).toFixed(2);
    const coverageTxt = snapshot.coverage_bps === null ? 'n/a' : `${(snapshot.coverage_bps / 100).toFixed(0)}%`;
    const title = snapshot.status === 'critical' ? 'Wallet liquidity CRITICAL'
      : snapshot.status === 'unknown' ? 'Wallet liquidity unreadable'
      : 'Wallet liquidity Low';
    const body = snapshot.status === 'unknown'
      ? `Stripe balance could not be read: ${snapshot.error ?? 'unknown error'}. New Wallet payments are being declined safely.`
      : `Headroom £${headroomGbp}, coverage ${coverageTxt}. ${snapshot.status === 'critical' ? 'New Wallet payments may be declined where headroom is short.' : 'Wallet remains usable; review before it reaches Critical.'}`;

    for (const a of (admins ?? []) as { push_token: string | null }[]) {
      if (!a.push_token) continue;
      await sendPush(a.push_token, title, body, { kind: 'wallet_liquidity', status: snapshot.status }, 'admin.wallet_liquidity').catch(() => {});
      notified++;
    }
  }

  if (snapshot.status !== lastStatus) {
    await svc.from('local_wallet_liquidity_alert_state')
      .update({ last_status: snapshot.status, last_alerted_at: notified > 0 ? new Date().toISOString() : state?.last_alerted_at ?? null })
      .eq('id', true);
  }

  return json({ ok: true, status: snapshot.status, previous: lastStatus, worsened, notified, funding_open: funding.open, funding_changed: funding.changed.length });
});
