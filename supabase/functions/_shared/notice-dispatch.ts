/**
 * notice-dispatch.ts — announce a notice (or an approved funeral notice) to the people who should hear about it, once.
 *
 * Pure orchestration, no Deno / network imports: the edge functions inject `rpc` (a service-role Supabase client's rpc) and `send` (the existing
 * sendUserPush, which still applies the master switch, the notices module toggle, quiet hours and device tokens to every recipient). That is also what lets
 * `node --test` run it with a mocked sender — no real push is ever sent by a test.
 *
 * EVERY safety rule lives in the database (migrations 20261129020000 / 20261129030000); this file only calls it in the right order and never passes a
 * recipient list in or accepts one from a request:
 *   1. authorise   — the caller's right to announce THIS notice to THIS audience (can_dispatch_notice / can_dispatch_funeral)
 *   2. eligible    — notice_dispatchable: published, started, unexpired, not hidden, NOT an official import, right audience (also the R2 rule)
 *   3. claim       — one dispatch per notice per audience, ever (a completed one can never repeat; a crashed one resumes on the same row)
 *   4. batches     — recipients are chosen BY THE DATABASE from current state each batch (a notice withdrawn mid-run yields nobody), one delivery row per
 *                    member, so area overlaps / several devices / retries can never produce a second push
 *   5. outcomes    — sent | held_quiet | skipped | failed recorded per member; a sent row is final; failures retry up to 3 times
 *   6. complete    — or fail, so the dispatch can be resumed
 * Quiet hours are NEVER bypassed here: send() is always called with urgent:false (the one approved emergency bypass is the existing admin broadcast).
 */

export type PushStatus = 'sent' | 'skipped_pref' | 'skipped_quiet' | 'no_token' | 'error';
export type DeliveryStatus = 'sent' | 'held_quiet' | 'skipped' | 'failed';
export type DispatchKind = 'essential' | 'official' | 'community' | 'hub' | 'funeral';
export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
export type Authorisation = { ok: true } | { ok: false; status: number; error: string };

export type DispatchDeps = {
  rpc: Rpc;
  send: (userId: string) => Promise<{ status: PushStatus; error?: string }>;
  authorise: () => Promise<Authorisation>;
  batchSize?: number;
  maxBatches?: number;
  concurrency?: number;
};
export type DispatchSubject = { type: 'notice' | 'funeral'; id: string; kind: DispatchKind; by: string | null };
export type DispatchOutcome =
  | { ok: true; dispatch: string; recipients: number; sent: number; held: number; skipped: number; failed: number }
  | { ok: false; status: number; error: string };

export const deliveryStatus = (s: PushStatus): DeliveryStatus =>
  s === 'sent' ? 'sent' : s === 'skipped_quiet' ? 'held_quiet' : s === 'error' ? 'failed' : 'skipped';

const fail = (status: number, error: string): DispatchOutcome => ({ ok: false, status, error });
const refusalStatus = (reason: string) => (/does not exist/i.test(reason) ? 404 : /Already|in progress/i.test(reason) ? 409 : 400);

export async function runDispatch(deps: DispatchDeps, subject: DispatchSubject): Promise<DispatchOutcome> {
  const { rpc } = deps;
  const isFuneral = subject.type === 'funeral';
  const batchSize = Math.min(Math.max(deps.batchSize ?? 200, 1), 1000);
  const maxBatches = Math.min(Math.max(deps.maxBatches ?? 50, 1), 200);
  const concurrency = Math.min(Math.max(deps.concurrency ?? 10, 1), 25);

  const auth = await deps.authorise();
  if (!auth.ok) return fail(auth.status, auth.error);

  const eligible = isFuneral
    ? await rpc('funeral_dispatchable', { p_id: subject.id })
    : await rpc('notice_dispatchable', { p_notice: subject.id, p_kind: subject.kind });
  if (eligible.error) return fail(500, 'Could not check that notice');
  if (typeof eligible.data === 'string' && eligible.data) return fail(refusalStatus(eligible.data), eligible.data);

  const claim = isFuneral
    ? await rpc('funeral_claim_dispatch', { p_id: subject.id, p_by: subject.by })
    : await rpc('notice_claim_dispatch', { p_notice: subject.id, p_kind: subject.kind, p_by: subject.by });
  if (claim.error) {
    return fail(claim.error.code === '23505' || /Already|in progress/i.test(claim.error.message) ? 409 : /not|expired|hidden|started|never/i.test(claim.error.message) ? 400 : 500, claim.error.message);
  }
  const dispatch = String(claim.data);

  const counts = { sent: 0, held: 0, skipped: 0, failed: 0 };
  let recipients = 0;
  try {
    for (let b = 0; b < maxBatches; b++) {
      const rows = isFuneral
        ? await rpc('funeral_dispatch_recipients', { p_id: subject.id, p_limit: batchSize })
        : await rpc('notice_dispatch_recipients', { p_notice: subject.id, p_kind: subject.kind, p_limit: batchSize });
      if (rows.error) throw new Error(rows.error.message);
      const ids = [...new Set(((rows.data as { user_id: string }[]) ?? []).map((r) => r.user_id))];
      if (ids.length === 0) break;                                   // nobody left (or the notice stopped being eligible): the database says so
      recipients += ids.length;
      for (let i = 0; i < ids.length; i += concurrency) {
        const slice = ids.slice(i, i + concurrency);
        const results = await Promise.allSettled(slice.map((u) => deps.send(u)));
        await Promise.all(results.map(async (r, k) => {
          const res = r.status === 'fulfilled' ? r.value : { status: 'error' as PushStatus, error: String((r as PromiseRejectedResult).reason).slice(0, 200) };
          const status = deliveryStatus(res.status);
          if (status === 'sent') counts.sent++; else if (status === 'held_quiet') counts.held++; else if (status === 'skipped') counts.skipped++; else counts.failed++;
          const rec = isFuneral
            ? await rpc('funeral_record_delivery', { p_id: subject.id, p_user: slice[k], p_status: status, p_error: res.error ?? null })
            : await rpc('notice_record_delivery', { p_notice: subject.id, p_user: slice[k], p_kind: subject.kind, p_status: status, p_error: res.error ?? null });
          if (rec.error) throw new Error(rec.error.message);
        }));
      }
    }
    const done = await rpc('notice_complete_dispatch', { p_dispatch: dispatch });
    if (done.error) throw new Error(done.error.message);
  } catch (e) {
    await rpc('notice_fail_dispatch', { p_dispatch: dispatch, p_error: e instanceof Error ? e.message : String(e) });
    return fail(500, 'The announcement was interrupted; it can be resumed');
  }
  return { ok: true, dispatch, recipients, ...counts };
}

const clamp = (s: string, n: number) => { const t = (s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

/** The push text for a notice. Essential alerts lead with what people need to do. Plain text; never a link or an HTML fragment. */
export function noticePushText(kind: DispatchKind, n: { title: string; body?: string | null; action_text?: string | null }, hubName?: string | null): { title: string; body: string } {
  if (kind === 'essential') return { title: clamp(`Essential alert: ${n.title}`, 110), body: clamp(n.action_text || n.body || 'Tap for details.', 150) };
  if (kind === 'hub') return { title: clamp(`New notice from ${hubName ?? 'your hub'}`, 110), body: clamp(n.title, 150) };
  if (kind === 'community') return { title: clamp(n.title, 110), body: clamp(n.body || 'Tap for details.', 150) };
  return { title: clamp(n.title, 110), body: clamp(n.body || 'Tap for details.', 150) };
}

export const AUDIENCE_KINDS = ['essential', 'official', 'community'] as const;
