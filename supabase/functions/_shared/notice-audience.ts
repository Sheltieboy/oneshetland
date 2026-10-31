/**
 * notice-audience.ts — the request handler behind notify-notice-audience (announce ONE notice, ONCE, to the members who opted in and follow its areas).
 *
 *   body { notice_id, kind }   kind: 'essential' | 'official' | 'community' | 'member'
 *
 * Everything outside it (who the caller is, the service-role rpc, loading the notice, the actual push, rate limiting) is INJECTED, so the same code runs in the
 * Edge Function and, with a mocked sender, in the local acceptance tests. Nothing in the request chooses recipients, text or urgency.
 *
 * 'member' is the MODERATOR-CONTROLLED notification of an approved personal notice:
 *   - authorisation is the database's (can_dispatch_notice: staff only; a closed account is refused), never the request's; a notice author or publisher has no right;
 *   - eligibility, the once-only claim, the audience, the recipient estimate and the per-member limits are database functions (migration 20261129080000);
 *   - per recipient, in this order: notice_push_gate (account, device, master/notices switches, QUIET HOURS: never overridden, urgent is always false) →
 *     notice_member_reserve (atomic "at most 2 per 24 h": over the limit = skipped, no catch-up) → the push. The outcome is recorded by the shared dispatcher:
 *     sent only when the sender says sent; a quiet-hours hold is held_quiet; a mute / no device / closed account / daily limit is skipped; an error is failed
 *     (retried up to 3 times, never recorded as delivered).
 * Approving a notice never calls this. Editing a notice never calls this.
 */
import { runDispatch, noticePushText, AUDIENCE_KINDS, type DispatchKind, type PushStatus, type Rpc } from './notice-dispatch.ts';

export type Caller = { userId: string; isServiceRole: boolean };
export interface AudienceDeps {
  cors: Record<string, string>;
  authenticate: (req: Request) => Promise<{ caller: Caller } | { denied: Response }>;
  limit?: (caller: Caller) => Promise<Response | null>;
  rpc: Rpc;
  loadNotice: (id: string) => Promise<{ id: string; title: string; body?: string | null; action_text?: string | null } | null>;
  push: (userId: string, text: { title: string; body: string }, ctx: { kind: DispatchKind; noticeId: string }) => Promise<{ status: PushStatus; error?: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleNoticeAudience(req: Request, deps: AudienceDeps): Promise<Response> {
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...deps.cors, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response('ok', { headers: deps.cors });
  const gate = await deps.authenticate(req);
  if ('denied' in gate) return gate.denied;
  const caller = gate.caller;
  if (!caller.isServiceRole && deps.limit) { const denied = await deps.limit(caller); if (denied) return denied; }

  const body = await req.json().catch(() => ({})) as { notice_id?: unknown; kind?: unknown };
  const noticeId = typeof body.notice_id === 'string' && UUID.test(body.notice_id) ? body.notice_id : null;
  const kind = typeof body.kind === 'string' && (AUDIENCE_KINDS as readonly string[]).includes(body.kind) ? (body.kind as DispatchKind) : null;
  if (!noticeId || !kind) return json({ error: 'notice_id and a valid kind are required' }, 400);

  const notice = await deps.loadNotice(noticeId);
  if (!notice) return json({ error: 'That notice does not exist' }, 404);
  let text = noticePushText(kind, notice);
  if (kind === 'member') {
    const t = await deps.rpc('notice_member_push_text', { p_notice: noticeId });
    const row = Array.isArray(t.data) ? (t.data[0] as { title?: string; body?: string } | undefined) : undefined;
    if (t.error || !row?.title || !row?.body) return json({ error: 'Could not prepare that notification' }, 500);
    text = { title: row.title, body: row.body };
  }

  const outcome = await runDispatch({
    rpc: deps.rpc,
    authorise: async () => {
      if (caller.isServiceRole) return { ok: true as const };
      const { data } = await deps.rpc('can_dispatch_notice', { p_user: caller.userId, p_notice: noticeId, p_kind: kind });
      return data === true ? { ok: true as const } : { ok: false as const, status: 403, error: 'Not allowed' };
    },
    send: async (userId) => {
      if (kind === 'member') {
        const g = await deps.rpc('notice_push_gate', { p_user: userId });
        if (g.error) return { status: 'error' as PushStatus, error: 'gate_failed' };           // an unreadable decision is a failure, never permission
        if (g.data === 'quiet_hours') return { status: 'skipped_quiet' as PushStatus, error: 'quiet_hours' };
        if (g.data !== 'ok') return { status: 'skipped_pref' as PushStatus, error: String(g.data) };
        const r = await deps.rpc('notice_member_reserve', { p_notice: noticeId, p_user: userId });
        if (r.error) return { status: 'error' as PushStatus, error: 'reserve_failed' };
        if (r.data === 'daily_limit') return { status: 'skipped_pref' as PushStatus, error: 'daily_limit' };
        if (r.data !== 'ok') return { status: 'skipped_pref' as PushStatus, error: String(r.data) };
      }
      return deps.push(userId, text, { kind, noticeId });
    },
  }, { type: 'notice', id: noticeId, kind, by: caller.isServiceRole ? null : caller.userId });
  return outcome.ok ? json(outcome) : json({ error: outcome.error }, outcome.status);
}
