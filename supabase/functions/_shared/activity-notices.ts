/**
 * activity-notices.ts — telling followers when a Regular Activity session changes.
 *
 * WHAT IT DOES. The database writes a row to activity_change_notices whenever a session is cancelled, changed, restored, added, or a
 * break is set (only for sessions in the next three weeks, and never the same state twice). This reads that outbox and sends AT MOST ONE
 * message per activity per run to the people who follow it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   • No reminders. Following is for CHANGES; a weekly "your class is on" message to everyone is noise.
 *   • No duplicates. Several edits of one session inside the settle window collapse to the last. A state followers were already told
 *     (activity_notice_state) is not sent again. "Cancelled" then "restored" before anything was sent, sends nothing at all.
 *   • No promise of delivery. Delivery is whatever the existing sender achieves: sendUserPush writes the in-app inbox row for every
 *     attempt (even for someone with no device), and pushes only reach people who have the app and a token — today that is almost
 *     nobody, because the app is not yet published. Email is NOT sent from here. Failures are returned, not hidden, and a message whose
 *     every delivery errored stays in the outbox to be retried.
 *
 * Pure logic with injected dependencies, so the rules are tested without a database or a push service.
 */

export interface NoticeRow {
  id: string; activity_id: string; kind: 'cancelled' | 'changed' | 'extra' | 'restored' | 'break';
  session_key: string; session_starts_at: string; new_starts_at: string | null; new_venue: string | null; note: string | null;
  state_hash: string; created_at: string;
}
export interface ActivityInfo { id: string; title: string; slug: string; is_public: boolean }
export interface PushResult { sent: number; skipped: number; errored: number }

export interface Deps {
  now(): Date;
  loadPending(limit: number): Promise<NoticeRow[]>;
  loadLastStates(keys: string[]): Promise<Map<string, string>>;
  loadActivity(id: string): Promise<ActivityInfo | null>;
  loadFollowers(activityId: string, limit: number): Promise<string[]>;
  push(userIds: string[], msg: { title: string; body: string; data: Record<string, unknown> }): Promise<PushResult>;
  markProcessed(ids: string[]): Promise<void>;
  saveStates(rows: { session_key: string; activity_id: string; state_hash: string }[]): Promise<void>;
}

export interface Summary {
  pending: number; settling: number; superseded: number; identical: number; past: number; neverTold: number; inactive: number;
  messages: number; recipients: number; sent: number; skipped: number; errored: number; retained: number; noFollowers: number;
}

export const SETTLE_MS = 2 * 60_000;
export const MAX_PER_RUN = 200;
export const MAX_FOLLOWERS = 2000;
const SITE = 'https://oneshetland.com';

/** "Fri 13 Nov 10:30", in Shetland's timezone, built from parts so every runtime prints the same. */
export function londonWhen(iso: string): string {
  const p = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/London' })
    .formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('weekday')} ${g('day')} ${g('month')} ${g('hour')}:${g('minute')}`;
}

const tidy = (s: string | null) => (s ?? '').trim();

export function lineFor(n: NoticeRow): string {
  const when = londonWhen(n.session_starts_at);
  const note = tidy(n.note) ? ` (${tidy(n.note)})` : '';
  switch (n.kind) {
    case 'cancelled': return `${when} is cancelled${note}`;
    case 'restored':  return `${when} is back on`;
    case 'extra':     return `extra session on ${when}${note}`;
    case 'break':     return `no sessions ${tidy(n.note) || 'for a short break'}`;
    case 'changed':
      if (n.new_starts_at) return `${when} has moved to ${londonWhen(n.new_starts_at)}${n.new_venue ? ` at ${n.new_venue}` : ''}${note}`;
      if (n.new_venue) return `${when} is now at ${n.new_venue}${note}`;
      return `update for ${when}${note}`;
  }
}

export function buildMessage(a: ActivityInfo, notices: NoticeRow[]): { title: string; body: string; data: Record<string, unknown> } {
  const ordered = [...notices].sort((x, y) => x.session_starts_at.localeCompare(y.session_starts_at));
  const url = `${SITE}/whats-on/regular/${a.slug}`;
  const body = ordered.length === 1
    ? lineFor(ordered[0])
    : `${ordered.length} changes to upcoming sessions. Open to see the latest times.`;
  return {
    title: a.title,
    body: body.charAt(0).toUpperCase() + body.slice(1),
    data: { screen: 'activity', activity_id: a.id, slug: a.slug, url },
  };
}

export async function runActivityNotices(deps: Deps): Promise<Summary> {
  const s: Summary = { pending: 0, settling: 0, superseded: 0, identical: 0, past: 0, neverTold: 0, inactive: 0, messages: 0, recipients: 0, sent: 0, skipped: 0, errored: 0, retained: 0, noFollowers: 0 };
  const now = deps.now();
  const rows = await deps.loadPending(MAX_PER_RUN);
  s.pending = rows.length;

  // Leave very recent rows alone: the organiser is probably still editing, and the last edit should win.
  const ready = rows.filter((r) => now.getTime() - new Date(r.created_at).getTime() >= SETTLE_MS);
  s.settling = rows.length - ready.length;

  // Several rows for one session collapse to the latest; the older ones are consumed without a message.
  const latest = new Map<string, NoticeRow>();
  for (const r of ready) {
    const cur = latest.get(r.session_key);
    if (!cur || r.created_at > cur.created_at || (r.created_at === cur.created_at && r.id > cur.id)) latest.set(r.session_key, r);
  }
  const consume = new Set<string>(ready.map((r) => r.id));
  s.superseded = ready.length - latest.size;

  const last = await deps.loadLastStates([...latest.keys()]);
  const byActivity = new Map<string, NoticeRow[]>();
  for (const r of latest.values()) {
    const sessionEnd = new Date(r.session_starts_at).getTime();
    const isPast = r.kind === 'break' ? sessionEnd < now.getTime() - 86_400_000 : sessionEnd < now.getTime();
    if (isPast) { s.past++; continue; }
    const told = last.get(r.session_key);
    if (told === r.state_hash) { s.identical++; continue; }
    if (r.kind === 'restored' && told === undefined) { s.neverTold++; continue; }   // followers never heard it was off
    (byActivity.get(r.activity_id) ?? byActivity.set(r.activity_id, []).get(r.activity_id)!).push(r);
  }

  const toSave: { session_key: string; activity_id: string; state_hash: string }[] = [];
  const retained = new Set<string>();
  for (const [activityId, notices] of byActivity) {
    const a = await deps.loadActivity(activityId);
    if (!a || !a.is_public) { s.inactive += notices.length; continue; }
    const followers = await deps.loadFollowers(activityId, MAX_FOLLOWERS);
    if (followers.length === 0) {
      s.noFollowers++;
      for (const n of notices) toSave.push({ session_key: n.session_key, activity_id: activityId, state_hash: n.state_hash });
      continue;
    }
    const msg = buildMessage(a, notices);
    const r = await deps.push(followers, msg);
    s.messages++; s.recipients += followers.length; s.sent += r.sent; s.skipped += r.skipped; s.errored += r.errored;
    // Every delivery failed: keep these rows for the next run rather than pretending they were told.
    if (r.sent + r.skipped === 0 && r.errored > 0) { for (const n of notices) retained.add(n.id); s.retained += notices.length; continue; }
    for (const n of notices) toSave.push({ session_key: n.session_key, activity_id: activityId, state_hash: n.state_hash });
  }

  // Rows that produced no message are consumed too (superseded / identical / past / never told / inactive / no followers).
  // The ones retained for retry stay pending. Superseded rows that belong to a retained session also stay: the latest row carries it.
  const keepKeys = new Set([...latest.values()].filter((r) => retained.has(r.id)).map((r) => r.session_key));
  const done = ready.filter((r) => !retained.has(r.id) && !keepKeys.has(r.session_key)).map((r) => r.id);
  if (toSave.length) await deps.saveStates(toSave);
  if (done.length) await deps.markProcessed(done);
  void consume;
  return s;
}
