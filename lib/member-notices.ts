/**
 * member-notices.ts - a signed-in member posts, edits and withdraws THEIR OWN notice (database: submit_person_notice, my_person_notices,
 * edit_my_person_notice, withdraw_my_person_notice; migration 20261129050000). Pure: no imports, so it runs in the app and under `node --test`.
 *
 * The server decides everything; this file only mirrors its rules so the form can say so before sending:
 *   title 5-120, text 10-2000, a listed category, ONE explicit area choice (Shetland-wide, or 1-8 specific areas, never both), an optional expiry
 *   (left out = 30 days, at most 90). A notice starts awaiting approval and is public only after staff approve it; editing an approved notice sends it
 *   back for approval. There is deliberately no way to pick urgent, an Essential Alert, a hub / business, or an event.
 *
 * AREA TARGETING has three states and they are never conflated: specific areas, explicit Shetland-wide (['shetland_wide']), and unspecified (no
 * areas). This form can only send the first two; `areaScopeLabel` shows unspecified as NO geography at all (it is never labelled Shetland-wide).
 */
export const TITLE_MIN = 5, TITLE_MAX = 120, BODY_MIN = 10, BODY_MAX = 2000, AREAS_MAX = 8, EXPIRY_MAX_DAYS = 90, EXPIRY_DEFAULT_DAYS = 30, PENDING_MAX = 5;
export const WIDE = 'shetland_wide';

export type AreaScope = 'wide' | 'specific' | null;
export type NoticeForm = { title: string; body: string; category: string | null; scope: AreaScope; areaIds: string[]; expiry: string };
export const EMPTY_NOTICE_FORM: NoticeForm = { title: '', body: '', category: null, scope: null, areaIds: [], expiry: '' };

export type MemberNoticeState = 'pending' | 'published' | 'expired' | 'withdrawn' | 'declined' | 'resolved';
export type MyNotice = {
  id: string; title: string; body: string; category: string | null; categoryLabel: string | null; state: MemberNoticeState; createdAt: string; publishedAt: string | null;
  expiresAt: string | null; areaIds: string[]; areaNames: string[]; declineReason: string | null; canEdit: boolean; canWithdraw: boolean;
};

const STATES: readonly string[] = ['pending', 'published', 'expired', 'withdrawn', 'declined', 'resolved'];
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function mapMyNoticeRow(r: any): MyNotice {
  return {
    id: String(r.id), title: String(r.title ?? ''), body: String(r.body ?? ''), category: str(r.category), categoryLabel: str(r.category_label),
    state: (STATES.includes(r.state) ? r.state : 'pending') as MemberNoticeState, createdAt: String(r.created_at ?? ''), publishedAt: str(r.published_at),
    expiresAt: str(r.expires_at), areaIds: strs(r.area_ids), areaNames: strs(r.area_names), declineReason: str(r.decline_reason), canEdit: r.can_edit === true, canWithdraw: r.can_withdraw === true,
  };
}

export const STATE_LABEL: Record<MemberNoticeState, string> = {
  pending: 'Awaiting approval', published: 'Published', expired: 'Ended', withdrawn: 'Withdrawn', declined: 'Not approved', resolved: 'Closed',
};
export const STATE_HELP: Record<MemberNoticeState, string> = {
  pending: 'Only you can see this until our team approves it.', published: 'Everyone can see this.', expired: 'This notice has reached its end date.',
  withdrawn: 'You withdrew this notice. It is no longer shown.', declined: 'Our team did not approve this notice.', resolved: 'This notice is closed.',
};
/** which badge colour family a state uses (the screen maps these to theme colours) */
export const STATE_TONE: Record<MemberNoticeState, 'amber' | 'green' | 'grey' | 'red'> = {
  pending: 'amber', published: 'green', expired: 'grey', withdrawn: 'grey', declined: 'red', resolved: 'grey',
};

/** What to show for where a notice applies. [] (unspecified) -> null: it carries no geography label and is never called Shetland-wide. */
export function areaScopeLabel(areaIds: readonly string[] | null | undefined, areaNames: readonly string[] | null | undefined, max = 2): string | null {
  const ids = areaIds ?? [];
  if (ids.length === 0) return null;
  if (ids.length === 1 && ids[0] === WIDE) return 'Shetland-wide';
  const names = (areaNames ?? []).filter(Boolean);
  if (names.length === 0) return null;
  return names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} +${names.length - max}`;
}

/** DD/MM/YYYY -> the END of that local day (so "until the 20th" includes the 20th), or null when it is not a real date. */
export function parseExpiry(text: string): Date | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 23, 59, 0, 0);
  return d.getFullYear() === Number(m[3]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[1]) ? d : null;
}
export function formatExpiryInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

/** Plain-English problems with the form, in the order they appear. Empty = ready to send. */
export function validateNoticeForm(f: NoticeForm, categories: readonly { id: string }[], now: Date = new Date()): string[] {
  const p: string[] = [];
  const title = f.title.trim(), body = f.body.trim();
  if (title.length < TITLE_MIN || title.length > TITLE_MAX) p.push(`Give your notice a title of ${TITLE_MIN} to ${TITLE_MAX} characters.`);
  if (body.length < BODY_MIN || body.length > BODY_MAX) p.push(`Say what is happening in ${BODY_MIN} to ${BODY_MAX} characters.`);
  if (!f.category || !categories.some((c) => c.id === f.category)) p.push('Choose a category.');
  if (f.scope === null) p.push('Say where this is relevant: all of Shetland, or particular places.');
  else if (f.scope === 'specific') {
    if (f.areaIds.length === 0) p.push('Choose at least one place, or choose Shetland-wide.');
    if (f.areaIds.length > AREAS_MAX) p.push(`Choose at most ${AREAS_MAX} places, or choose Shetland-wide.`);
  }
  if (f.expiry.trim()) {
    const d = parseExpiry(f.expiry);
    if (!d) p.push('Write the end date as DD/MM/YYYY, or leave it blank.');
    else if (d.getTime() <= now.getTime()) p.push('The end date must be in the future.');
    else if (d.getTime() > now.getTime() + EXPIRY_MAX_DAYS * 86400000) p.push(`The end date can be at most ${EXPIRY_MAX_DAYS} days away.`);
  }
  return p;
}

/** the area list to send: ['shetland_wide'] alone, or the chosen specific areas (never both, never empty from this form) */
export function areasToSend(f: NoticeForm): string[] { return f.scope === 'wide' ? [WIDE] : f.scope === 'specific' ? [...new Set(f.areaIds)].sort() : []; }

export function buildSubmitArgs(f: NoticeForm) {
  return { p_title: f.title.trim(), p_body: f.body.trim(), p_category: f.category, p_area_ids: areasToSend(f), p_expires_at: f.expiry.trim() ? (parseExpiry(f.expiry) as Date).toISOString() : null };
}
/** An edit: the expiry is sent only when the member wrote one (blank keeps what is there). */
export function buildEditArgs(id: string, f: NoticeForm) {
  const a = buildSubmitArgs(f);
  return { p_notice: id, p_title: a.p_title, p_body: a.p_body, p_category: a.p_category, p_area_ids: a.p_area_ids, p_expires_at: a.p_expires_at };
}

/** pre-fill the form from one of the member's own notices */
export function formFromNotice(n: MyNotice): NoticeForm {
  const wide = n.areaIds.length === 1 && n.areaIds[0] === WIDE;
  return { title: n.title, body: n.body, category: n.category, scope: wide ? 'wide' : n.areaIds.length ? 'specific' : null, areaIds: wide ? [] : n.areaIds, expiry: formatExpiryInput(n.expiresAt) };
}

/** A server refusal in words for the member (the limit message is passed through; nothing technical is shown). */
export function friendlyError(message: string | null | undefined): string {
  const m = (message ?? '').trim();
  if (/5 notices awaiting review/i.test(m)) return 'You already have 5 notices awaiting approval. Please wait for them to be checked, or withdraw one.';
  if (/Sign in/i.test(m)) return 'Please sign in to post a notice.';
  if (m && m.length < 140 && !/violates|constraint|function|schema|PGRST|syntax/i.test(m)) return m;
  return 'Something went wrong. Please try again.';
}
