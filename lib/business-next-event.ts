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
 *      With an explicit `ends_at`, that is simply `now` between the two.
 *
 *      WITH NO `ends_at`, it is the rest of the event's own calendar day.
 *      `ends_at` is nullable and both event forms label the end time
 *      "(optional)" — the only validation either performs before saving is on
 *      the title — so a ticketed event genuinely can have none, and one in
 *      production does. Treating such an event as a point in time, current
 *      only at its exact start instant, is what the public What's On rule
 *      does (oneshetland-web/lib/events-data.ts: "no end time and hasn't
 *      started yet"). That is right for a browse listing, where the cost of
 *      dropping out is that an event leaves a list. It is wrong here, where
 *      the cost is staff losing Scan tickets at 19:10 for an event that
 *      started at 19:00. Same rule, very different consequence — so the
 *      dashboard keeps a no-end event current until the end of the day it
 *      started on, and public discovery is deliberately left alone.
 *
 *      The day is Shetland's, not the device's: the zone is named
 *      explicitly (lib/shetland-time.ts is the convention), so a phone
 *      abroad, a server on UTC and a till in Lerwick all agree, and
 *      BST/GMT is the timezone database's
 *      problem rather than an offset this file guesses at. Comparing day
 *      keys rather than computing an end-of-day instant is what keeps that
 *      true across the transitions: the tz database decides which calendar
 *      day an instant falls on, including the days that are 23 or 25 hours
 *      long.
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

/**
 * Shetland's timezone, and the calendar day an instant falls on within it.
 *
 * This repeats the two lines of lib/shetland-time.ts rather than importing
 * them, because the suites that EXECUTE this module run under node --test,
 * whose ESM resolver needs a file extension that tsc then rejects. Both lib
 * modules a node test imports directly are dependency-free for that reason,
 * and this one stays that way. The duplication is not left to drift: a test
 * asserts this literal still equals SHETLAND_TZ, so changing the convention in
 * one place fails the build rather than quietly splitting the two.
 */
const SHETLAND_TZ = 'Europe/London';
const dayKey = (d: Date): string => d.toLocaleDateString('en-CA', { timeZone: SHETLAND_TZ });

/**
 * Is `now` still within the Shetland calendar day this event started on?
 *
 * Only ever asked about an event that has already started, so the two answers
 * that matter are "same day" (still on) and "a later day" (over). The string
 * form is YYYY-MM-DD, so comparing them is chronological — and the timezone
 * database, not this file, decides where the boundary falls, which is what
 * keeps it right on the 23- and 25-hour days.
 *
 * If the runtime cannot format with a timezone at all, this fails toward
 * keeping the event selectable. cruise-api.ts records a doubt about JSC and
 * Intl; the booking screens and book-slots.ts already depend on the same call
 * so it is exercised in production — but the wrong way to be wrong here is to
 * hide a live event from the staff standing at its door.
 */
function stillOnItsStartDay(start: Date, now: Date): boolean {
  try {
    return dayKey(now) <= dayKey(start);
  } catch {
    return true;
  }
}

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
    const start   = new Date(e.starts_at);
    const startMs = start.getTime();
    // Not started yet: upcoming, whatever its end time says.
    if (startMs >= nowMs) return true;
    // Started. An explicit end decides it; otherwise its own day does.
    if (e.ends_at) return new Date(e.ends_at).getTime() >= nowMs;
    return stillOnItsStartDay(start, now);
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
