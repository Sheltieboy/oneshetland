/**
 * event-occurrence-dates.ts — Social Studio's view of an event that runs on several dates (Events Phase 1).
 *
 * An event with rows in event_occurrences is a DATED RUN: separate performances, never a continuous span. For social posts that means
 *   · list the production ONCE, under its NEXT LIVE date (a live date = not cancelled and still in the future);
 *   · if every remaining date is cancelled or past, there is nothing to advertise;
 *   · an event with NO occurrence rows is untouched — same date, same behaviour as before.
 *
 * TOLERANT BY DESIGN: this never depends on the Phase-1 migration. If the event_occurrences table does not exist (or the read fails for any
 * reason) loadOccurrences returns an empty map, and every event then behaves exactly as it did before. No column is added to any events
 * select, so an events query can never start failing because a column is absent.
 *
 * Pure apart from the one read in loadOccurrences. No remote imports (so the module also runs under node for tests).
 */

export type OccurrenceRow = { event_id: string; starts_at: string; status: string | null };

/** The service client's shape that we use; kept structural so tests can pass an in-memory fake. */
type Svc = { from: (t: string) => any };

/** event_id -> its occurrence rows. Missing table / failed read / no ids => empty map (behave as today). */
export async function loadOccurrences(svc: Svc, eventIds: string[]): Promise<Map<string, OccurrenceRow[]>> {
  const out = new Map<string, OccurrenceRow[]>();
  const ids = [...new Set(eventIds.filter(Boolean))];
  if (!ids.length) return out;
  try {
    const { data, error } = await svc.from('event_occurrences').select('event_id, starts_at, status').in('event_id', ids).limit(5000);
    if (error || !Array.isArray(data)) return out;
    for (const r of data as OccurrenceRow[]) {
      if (!r?.event_id || !r.starts_at) continue;
      const list = out.get(r.event_id) ?? [];
      list.push(r);
      out.set(r.event_id, list);
    }
  } catch { /* table absent or unreachable: act as if there are no occurrences */ }
  return out;
}

export type RunState =
  | { kind: 'plain' }                       // no occurrence rows: leave the event exactly as it is
  | { kind: 'run'; next: string }           // a dated run with a live date: advertise `next`
  | { kind: 'gone' };                       // a dated run with no live date left: do not advertise

/** Next live date strictly after `after`, or the state that says there is none. */
export function runState(rows: OccurrenceRow[] | undefined, after: Date): RunState {
  if (!rows || rows.length === 0) return { kind: 'plain' };
  const t = after.getTime();
  const live = rows
    .filter((r) => (r.status ?? 'scheduled') !== 'cancelled' && new Date(r.starts_at).getTime() > t)
    .map((r) => r.starts_at)
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
  return live.length ? { kind: 'run', next: live[0] } : { kind: 'gone' };
}

/**
 * Applies runState to a list of events (each with id + starts_at). Plain events pass through untouched (same object);
 * runs are re-dated to their next live date; gone runs are dropped; a production appears at most once.
 * `windowEnd` (optional) drops a run whose next live date falls outside the window being advertised.
 */
export function listOncePerProduction<E extends { id: string; starts_at: string }>(
  events: E[], occ: Map<string, OccurrenceRow[]>, after: Date, windowEnd?: Date,
): E[] {
  const seen = new Set<string>();
  const out: E[] = [];
  for (const e of events) {
    if (seen.has(e.id)) continue;
    const s = runState(occ.get(e.id), after);
    if (s.kind === 'gone') continue;
    if (s.kind === 'run') {
      if (windowEnd && new Date(s.next).getTime() >= windowEnd.getTime()) continue;
      seen.add(e.id); out.push({ ...e, starts_at: s.next });
    } else { seen.add(e.id); out.push(e); }
  }
  return out;
}

/**
 * Send-time check for the publisher. True = this event must NOT be posted now. Only ever true for an event that HAS occurrence rows,
 * so an event without occurrences is never newly blocked. `event` is the events row (status / is_hidden), if it could be read.
 */
export function runBlocksPost(rows: OccurrenceRow[] | undefined, event: { status?: string | null; is_hidden?: boolean | null } | null | undefined, now: Date): string | null {
  const s = runState(rows, now);
  if (s.kind === 'plain') return null;
  if (event && (event.status === 'cancelled' || event.is_hidden === true)) return 'event cancelled or hidden';
  if (s.kind === 'gone') return 'no live date left (all dates cancelled or past)';
  return null;
}

/* ── Who an event is "by" (Events Phase 1, decided 6 Nov 2026) ───────────────────────────────────────────────────────────────────────
   events.source / events.organiser_name only exist once the Phase-1 migration is applied, so they are read in a SEPARATE, tolerant query
   (never added to an existing events select): on any error the map is empty and every event is treated as an ordinary listing, as today.
   Platform OWNERSHIP never means "organised by OneShetland": 120 curated platform events are third-party. Social copy therefore
     · credits a community event to its organiser ("shared by <name>");
     · says nothing about the organiser for every other event, including curated platform events;
     · never credits a community or curated event to a business or to OneShetland.                                                         */
export type Attribution = { source: string | null; organiser_name: string | null };

export async function loadAttribution(svc: Svc, eventIds: string[]): Promise<Map<string, Attribution>> {
  const out = new Map<string, Attribution>();
  const ids = [...new Set(eventIds.filter(Boolean))];
  if (!ids.length) return out;
  try {
    const { data, error } = await svc.from('events').select('id, source, organiser_name').in('id', ids).limit(5000);
    if (error || !Array.isArray(data)) return out;
    for (const r of data as Array<{ id: string; source?: string | null; organiser_name?: string | null }>) {
      if (r?.id) out.set(r.id, { source: r.source ?? null, organiser_name: r.organiser_name ?? null });
    }
  } catch { /* old schema: no attribution columns */ }
  return out;
}

const cleanName = (n: string | null | undefined): string => (n ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);

/** ' (shared by Name)' for a community event with a name; '' for everything else. */
export function creditSuffix(a: Attribution | undefined): string {
  if (a?.source !== 'community_submission') return '';
  const name = cleanName(a.organiser_name);
  return name ? ` (shared by ${name})` : '';
}

/** A community event with no usable organiser name cannot be credited, so it is not advertised. */
export function creditable(a: Attribution | undefined): boolean {
  return a?.source !== 'community_submission' || cleanName(a.organiser_name) !== '';
}

/** event_spotlight is for business-owned events only ("Event by <business>"). Anything carrying a source marker is never spotlighted. */
export function spotlightAllowed(a: Attribution | undefined): boolean {
  return !a?.source;
}
