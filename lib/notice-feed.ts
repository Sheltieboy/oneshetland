/**
 * notice-feed.ts — how the app and the website READ public notices, in one place.
 *
 * Row-level security is the security boundary (migration 20261128010000: a direct read returns only notices that are published, started,
 * unexpired, not hidden and within their visibility). These filters are a second, explicit line so no public reader depends on RLS alone, and so
 * a future change to the policy cannot silently put a pending, withdrawn, resolved or scheduled notice into a feed.
 *
 *   status = 'published'  AND  (starts_at IS NULL OR starts_at <= now)  AND  (expires_at IS NULL OR expires_at > now)
 *
 * (is_hidden and visibility stay at each reader, exactly as before: hub pages show members-only notices to members, feeds show public ones.)
 * `now` is rendered as an absolute UTC instant, never local wall-clock text. Management reads (a publisher's own non-public notices) do NOT use
 * this: they go through the manage_notices RPC.
 *
 * Pure apart from the injected rpc: no imports, so it runs in the app, the website and `node --test`. Identical copy in both repos.
 */
import { noticePublisher, type NoticePublisher, type NoticePublisherInput, type PublisherRef } from './notice-publisher';

/** The columns that name a notice's publisher; add to any public notice select. */
export const NOTICE_PUBLISHER_COLUMNS =
  'publisher_kind, is_platform_notice, is_person_notice, publisher_user_id, publisher_hub_id, publisher_business_id, source, source_label, source_url';

export function publicNoticeWindow(now: Date | number | string = new Date()) {
  const nowIso = new Date(now).toISOString();
  return {
    nowIso,
    status: 'published' as const,
    startsOr: `starts_at.is.null,starts_at.lte.${nowIso}`,
    expiresOr: `expires_at.is.null,expires_at.gt.${nowIso}`,
  };
}

type Filterable = { eq(col: string, v: unknown): Filterable; or(expr: string): Filterable };

/** Adds the publication filters to a notices query (any PostgREST-style builder; the builder's own type is returned unchanged). */
export function applyPublicNoticeFilters<Q>(q: Q, now: Date | number | string = new Date()): Q {
  const w = publicNoticeWindow(now);
  return (q as unknown as Filterable).eq('status', w.status).or(w.startsOr).or(w.expiresOr) as unknown as Q;
}

export type NoticeRpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;

/**
 * Display names for the PERSON notices in a result, from the authorised attribution RPC (notice_publisher_display). The RPC releases a name
 * only for a notice that is public right now and answers "A OneShetland member" otherwise; profiles is never read. A failed call simply leaves
 * the notice on the approved fallback.
 */
export async function loadPersonNames(
  rpc: NoticeRpc,
  rows: Array<{ id: string; publisher_kind?: string | null; is_person_notice?: boolean | null; publisher_user_id?: string | null }>,
  max = 30,
): Promise<Record<string, string>> {
  const people = rows.filter((r) => (r.publisher_kind === 'person' || r.is_person_notice === true) && r.publisher_user_id !== null).slice(0, max);
  const out: Record<string, string> = {};
  await Promise.all(people.map(async (r) => {
    try {
      const { data, error } = await rpc('notice_publisher_display', { p_notice: r.id });
      const label = !error && data && typeof data === 'object' ? (data as { label?: unknown }).label : null;
      if (typeof label === 'string' && label.trim()) out[r.id] = label.trim();
    } catch { /* fallback applies */ }
  }));
  return out;
}

export type NoticeRowLike = NoticePublisherInput & { id: string };

/** One notice row (with its embedded hub / business) -> how to show its publisher. */
export function attributionFor(row: NoticeRowLike, personNames: Record<string, string> = {}): NoticePublisher {
  return noticePublisher({ ...row, person_name: personNames[row.id] ?? null });
}

export type { NoticePublisher, PublisherRef };
