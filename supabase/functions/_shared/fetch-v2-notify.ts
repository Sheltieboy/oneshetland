/**
 * fetch-v2-notify.ts — drains the Fetch v2 notification outbox (docs/FETCH_V2_IMPLEMENTATION.md, Step 8).
 *
 * The database decides everything: who is told, what it says, where it opens, whether it may push now. It has already written each
 * notice's Notification Centre (inbox) row before anything here runs. This module only pushes the notices it is handed, through an
 * injected gateway, and reports each outcome back. One member's failure never stops another's.
 *
 * Outcomes reported to fetch_v2_settle_notification:
 *   accepted                  Expo accepted the push for at least one device (accepted, not "delivered")
 *   no_token                  the member has no push device
 *   invalid_token             every device was rejected as no longer registered (those tokens are removed)
 *   push_unavailable          push is not set up for the member's devices (e.g. Android without push credentials)
 *   provider_error_retryable  network / 5xx / rate-limited: retried later with back-off, a bounded number of times
 *   provider_error            refused for another reason; not retried
 */

export type PushMessage = { title: string; body: string; data: Record<string, unknown>; categoryId: string };
export type PushAttempt = { ok: true } | { ok: false; reason: 'device_not_registered' | 'retryable' | 'unavailable' | 'rejected'; error: string };
export interface PushGateway {
  tokens: (userId: string) => Promise<string[]>;
  send: (token: string, message: PushMessage) => Promise<PushAttempt>;
  prune: (userId: string, token: string) => Promise<void>;
}
export type RpcResult = { data: unknown; error: unknown };
export interface NotifyDeps {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<RpcResult>;
  push: PushGateway;
}
type Leased = { notification_id: number; recipient_id: string; category: string; title: string; body: string; data: Record<string, unknown> };
type Result = 'accepted' | 'no_token' | 'invalid_token' | 'push_unavailable' | 'provider_error_retryable' | 'provider_error';

/** Push one leased notice to every device the member has, and classify the outcome. */
export async function pushOne(push: PushGateway, n: Leased): Promise<{ result: Result; error?: string }> {
  const tokens = await push.tokens(n.recipient_id);
  if (tokens.length === 0) return { result: 'no_token' };
  const reasons: string[] = [];
  let lastError: string | undefined;
  for (const token of tokens) {
    let a: PushAttempt;
    try { a = await push.send(token, { title: n.title, body: n.body, data: n.data, categoryId: n.category }); } catch (e) {
      a = { ok: false, reason: 'retryable', error: e instanceof Error ? e.message : 'send failed' };
    }
    if (a.ok) return { result: 'accepted' };
    reasons.push(a.reason); lastError = a.error;
    if (a.reason === 'device_not_registered') { try { await push.prune(n.recipient_id, token); } catch { /* best effort */ } }
  }
  const result: Result = reasons.includes('retryable') ? 'provider_error_retryable'
    : reasons.every((r) => r === 'device_not_registered') ? 'invalid_token'
    : reasons.every((r) => r === 'unavailable' || r === 'device_not_registered') ? 'push_unavailable'
    : 'provider_error';
  return { result, error: lastError?.slice(0, 300) };
}

/** One drain pass: write pending inbox rows (in the database), then push what is due. Repeat-safe. */
export async function drainNotifications(deps: NotifyDeps, limit = 50): Promise<Record<string, number>> {
  const out: Record<string, number> = { pushed: 0, accepted: 0, skipped: 0, retry: 0, failed: 0, errors: 0 };
  const { data, error } = await deps.rpc('fetch_v2_claim_notifications', { p_limit: limit });
  if (error) { out.errors++; return out; }
  for (const n of (data ?? []) as Leased[]) {
    out.pushed++;
    try {
      const r = await pushOne(deps.push, n);
      const s = await deps.rpc('fetch_v2_settle_notification', { p_id: n.notification_id, p_result: r.result, p_error: r.error ?? null });
      if (s.error) { out.errors++; continue; }
      const settled = (Array.isArray(s.data) ? s.data[0] : s.data) as { retry?: boolean; push_result?: string };
      if (settled?.retry) out.retry++;
      else if (settled?.push_result === 'accepted') out.accepted++;
      else if (r.result === 'provider_error' || r.result === 'provider_error_retryable') out.failed++;
      else out.skipped++;
    } catch { out.errors++; }
  }
  return out;
}
