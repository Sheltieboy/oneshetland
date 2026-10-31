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

export type PersonNameOptions = {
  /** Most DISTINCT authors looked up for one result (default 30). */
  max?: number;
  /** A lookup slower than this is abandoned and the notice keeps the approved fallback label (default 1500ms). */
  timeoutMs?: number;
  /** How long a looked-up name is reused (default 2 minutes; 0 disables). */
  ttlMs?: number;
  /** Injected for tests; null disables caching. */
  cache?: Map<string, { label: string; at: number }> | null;
  now?: () => number;
};

const NAME_CACHE = new Map<string, { label: string; at: number }>();
const NAME_CACHE_MAX = 200;
export const clearPersonNameCache = () => NAME_CACHE.clear();

/**
 * Display names for the PERSON notices in a result, from the authorised attribution RPC (notice_publisher_display). The RPC releases a name
 * only for a notice that is public right now and answers "A OneShetland member" otherwise; profiles is never read.
 *
 * Cost control (measured in docs/notices-person-attribution-performance.md): one lookup per DISTINCT AUTHOR, not per notice (a person's label is
 * the same on every public notice they have); all lookups run in parallel; each is abandoned after timeoutMs so a slow lookup never holds
 * up the feed for long; a successful label is reused for ttlMs (cached per notice id) so a refresh does not repeat it; at most `max` authors are asked about. A failed
 * or timed-out lookup simply leaves that notice on the approved fallback ("A OneShetland member"). Nothing here retries or loops.
 */
export async function loadPersonNames(
  rpc: NoticeRpc,
  rows: Array<{ id: string; publisher_kind?: string | null; is_person_notice?: boolean | null; publisher_user_id?: string | null }>,
  opts: PersonNameOptions | number = {},
): Promise<Record<string, string>> {
  const o: PersonNameOptions = typeof opts === 'number' ? { max: opts } : opts;
  const max = o.max ?? 30, timeoutMs = o.timeoutMs ?? 1500, ttlMs = o.ttlMs ?? 120_000;
  const cache = o.cache === undefined ? NAME_CACHE : o.cache;
  const t0 = (o.now ?? Date.now)();

  const byAuthor = new Map<string, string[]>();
  for (const r of rows) {
    if (!((r.publisher_kind === 'person' || r.is_person_notice === true) && r.publisher_user_id !== null)) continue;
    const key = r.publisher_user_id ?? `notice:${r.id}`;
    const ids = byAuthor.get(key); if (ids) ids.push(r.id); else byAuthor.set(key, [r.id]);
  }

  const out: Record<string, string> = {};
  await Promise.all([...byAuthor.values()].slice(0, max).map(async (ids) => {
    // The cache is keyed by NOTICE id (never by author): a name remembered for one notice is never offered for another.
    const missing: string[] = [];
    for (const id of ids) {
      const hit = cache && ttlMs > 0 ? cache.get(id) : undefined;
      if (hit && t0 - hit.at < ttlMs) out[id] = hit.label; else missing.push(id);
    }
    if (missing.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ask = Promise.resolve(rpc('notice_publisher_display', { p_notice: missing[0] })).then(({ data, error }) => {
        const label = !error && data && typeof data === 'object' ? (data as { label?: unknown }).label : null;
        return typeof label === 'string' && label.trim() ? label.trim() : null;
      });
      const label = await Promise.race([ask, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); })]);
      if (!label) return;
      for (const id of missing) {
        out[id] = label;
        if (cache && ttlMs > 0) {
          if (cache.size >= NAME_CACHE_MAX) cache.delete(cache.keys().next().value as string);
          cache.set(id, { label, at: t0 });
        }
      }
    } catch { /* fallback applies */ } finally { if (timer) clearTimeout(timer); }
  }));
  return out;
}

export type NoticeRowLike = NoticePublisherInput & { id: string };

/** One notice row (with its embedded hub / business) -> how to show its publisher. */
export function attributionFor(row: NoticeRowLike, personNames: Record<string, string> = {}): NoticePublisher {
  return noticePublisher({ ...row, person_name: personNames[row.id] ?? null });
}

export type { NoticePublisher, PublisherRef };
