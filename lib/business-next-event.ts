/**
 * business-next-event.ts — which of a business's own events is "the next
 * one" for the dashboard's Scan tickets / Manage events shortcut.
 *
 * WHY THIS EXISTS
 *
 * fetchBusinessEvents() (events-api.ts) orders `starts_at` DESCENDING with no
 * future filter, and the dashboard's Events card just took index [0] as "the
 * next event" — so for any business with more than one event, [0] was
 * whichever event has the LATEST date, not the nearest one. On the actual
 * night of an earlier event, tapping "Scan tickets" opened the scanner wired
 * to a different, later event: it recognised none of that night's tickets.
 *
 * fetchBusinessEvents() itself is left untouched — it has exactly one call
 * site (this dashboard card) and no other current consumer depends on its
 * ordering, but selection is done here rather than by re-ordering the query
 * because "nearest relevant" isn't just a sort direction: a long-past event
 * (small starts_at) must not outrank a genuinely future one just because
 * ascending order would put it first too. This works regardless of the
 * order fetchBusinessEvents returns.
 *
 * SELECTION RULE
 *   1. An event currently IN PROGRESS (started, not yet ended) is the most
 *      relevant thing on the dashboard right now — staff are at the door.
 *      No canonical "in progress" concept existed anywhere else in this
 *      codebase to preserve, so this establishes the obvious one: `now` is
 *      between `starts_at` and `ends_at`. An event with no `ends_at` is
 *      treated as a point in time (matching how formatEventDate already
 *      treats a missing end — not a duration), so it counts as "in
 *      progress" only at its exact start instant, then rolls into "past".
 *   2. Otherwise, the soonest event that hasn't started yet.
 *   3. Otherwise (nothing upcoming or in progress): none. A past event is
 *      never selected as a fallback "next" — that's the exact bug this
 *      fixes, just aimed at a fallback path instead of the main one.
 *   4. Ties on `starts_at` break on `id` — arbitrary but deterministic, so
 *      the choice does not depend on network/array order.
 *
 * NOT handled here, deliberately out of scope for this fix: event `status`
 * (a cancelled/draft event can still be "selected" by this function). The
 * reported defect is about picking the wrong DATE, not about status
 * filtering, and the dashboard had no status filtering before either.
 */

export interface NextEventCandidate {
  id:        string;
  starts_at: string;
  ends_at?:  string | null;
}

export function selectNextBusinessEvent<T extends NextEventCandidate>(
  events: readonly T[],
  now: Date = new Date(),
): T | null {
  const nowMs = now.getTime();

  const notYetFinished = events.filter(e => {
    const startMs = new Date(e.starts_at).getTime();
    const endMs   = e.ends_at ? new Date(e.ends_at).getTime() : startMs;
    return endMs >= nowMs || startMs >= nowMs;
  });

  if (notYetFinished.length === 0) return null;

  const sorted = [...notYetFinished].sort((a, b) => {
    const aStart = new Date(a.starts_at).getTime();
    const bStart = new Date(b.starts_at).getTime();
    if (aStart !== bStart) return aStart - bStart;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return sorted[0];
}
