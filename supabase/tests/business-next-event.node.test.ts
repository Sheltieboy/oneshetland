/**
 * business-next-event.node.test.ts — the dashboard scans the right door.
 *
 * WHAT WAS WRONG
 *
 * fetchBusinessEvents() orders `starts_at` DESCENDING with no future filter.
 * The dashboard's Events card took `bizEvents[0]` as "the next event" and
 * wired both the displayed date and the Scan tickets / Manage events
 * shortcuts to that one index. For a business with more than one event,
 * index [0] is whichever has the LATEST date — not the nearest one. On the
 * actual night of an earlier event, "Scan tickets" opened the scanner wired
 * to a different, later event, which recognises none of that night's
 * tickets: a core operational dead-end at the door.
 *
 * WHAT IS ASSERTED
 *   · multiple future events — the soonest one wins, regardless of array/DB
 *     order (both ascending- and descending-fed inputs are checked)
 *   · past + future mixed — a past event never outranks a future one
 *   · an event currently in progress (started, not yet ended) is preferred
 *     over a later future one — staff at the door right now matters more
 *     than what's next week
 *   · an event with no `ends_at` counts as "in progress" only at its exact
 *     start instant (matching formatEventDate's existing treatment of a
 *     missing end as a point in time, not an open-ended duration), then
 *     rolls into "past" and stops being selectable
 *   · no upcoming or in-progress event → no selection at all (never falls
 *     back to a stale past event — the exact bug, aimed at the fallback path)
 *   · a starts_at tie breaks deterministically on id, not on input order
 *   · the dashboard actually wires this in: it imports and calls
 *     selectNextBusinessEvent, and no longer indexes bizEvents[0] directly
 *
 * SAFETY
 * Pure function tests, no database, no network, no writes. The wiring check
 * reads source only.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectNextBusinessEvent, type NextEventCandidate } from '../../lib/business-next-event.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const NOW = new Date('2026-09-15T12:00:00Z');
const iso = (offsetHours: number) => new Date(NOW.getTime() + offsetHours * 3_600_000).toISOString();

const ev = (id: string, startsOffsetH: number, endsOffsetH?: number): NextEventCandidate => ({
  id,
  starts_at: iso(startsOffsetH),
  ends_at: endsOffsetH === undefined ? null : iso(endsOffsetH),
});

describe('selectNextBusinessEvent — multiple future events', () => {
  test('the soonest future event wins regardless of input order', () => {
    const far    = ev('far',    24 * 20); // 20 days out
    const near   = ev('near',   24 * 2);  // 2 days out
    const middle = ev('middle', 24 * 8);  // 8 days out

    assert.equal(selectNextBusinessEvent([far, near, middle], NOW)!.id, 'near');
    assert.equal(selectNextBusinessEvent([near, middle, far], NOW)!.id, 'near'); // already-ascending input
    assert.equal(selectNextBusinessEvent([middle, far, near], NOW)!.id, 'near'); // arbitrary order
  });
});

describe('selectNextBusinessEvent — past + future mixed', () => {
  test('a past event never outranks a future one, however it sorts by date', () => {
    const longPast   = ev('long-past',   -24 * 90); // 90 days ago, no end — a point, long over
    const recentPast = ev('recent-past', -24 * 1, -12); // started & ended yesterday
    const future      = ev('future',     24 * 5);

    const result = selectNextBusinessEvent([longPast, recentPast, future], NOW);
    assert.equal(result!.id, 'future');
  });

  test('THE REPORTED CASE: the furthest-future event (old [0] under descending order) does not win over a nearer one', () => {
    const nearest = ev('nearest', 24 * 1);
    const latest  = ev('latest',  24 * 30);
    // Old code took index [0] of a DESCENDING-ordered array — i.e. `latest`.
    const descendingOrder = [latest, nearest];
    assert.equal(selectNextBusinessEvent(descendingOrder, NOW)!.id, 'nearest');
  });
});

describe('selectNextBusinessEvent — an event currently in progress', () => {
  test('an in-progress event is preferred over a later future one', () => {
    const liveNow = ev('live-now', -1, 2); // started an hour ago, ends in 2h
    const future  = ev('future',   24 * 3);
    assert.equal(selectNextBusinessEvent([future, liveNow], NOW)!.id, 'live-now');
  });

  test('a no-end event that has started stays current, and beats a later one the same day', () => {
    const rightAtStart = ev('right-at-start', 0); // starts_at === now, no ends_at
    assert.equal(selectNextBusinessEvent([rightAtStart], NOW)!.id, 'right-at-start');

    // This assertion is the reverse of what it was. A no-end event used to be
    // a point in time — current at its start instant and past a second later —
    // which is what the public What's On rule does. On the dashboard that took
    // Scan tickets away from staff standing at the door of an event that had
    // simply begun. It now holds until the end of its own Shetland day.
    const startedEarlierNoEnd = ev('started-earlier-no-end', -2); // started 2h ago
    const laterToday          = ev('later-today', 3);
    assert.equal(
      selectNextBusinessEvent([startedEarlierNoEnd, laterToday], NOW)!.id,
      'started-earlier-no-end',
      'a no-end event that has started must stay selectable during its own day',
    );
  });

  test('two overlapping in-progress events resolve deterministically (earlier start wins)', () => {
    const a = ev('a', -3, 1);
    const b = ev('b', -1, 2);
    assert.equal(selectNextBusinessEvent([a, b], NOW)!.id, 'a');
    assert.equal(selectNextBusinessEvent([b, a], NOW)!.id, 'a'); // order-independent
  });
});

/* ── A ticketed event with no end time, through its own Shetland day ──────── */

describe('a no-end event lasts its start day, in Europe/London', () => {
  /**
   * The operational case, in real instants rather than offsets. September, so
   * London is on BST (UTC+1): the doors open at 19:00 local, which is 18:00Z.
   */
  const at = (iso: string) => new Date(iso);
  const doors = (): NextEventCandidate => ({ id: 'tonight', starts_at: '2026-09-15T18:00:00Z', ends_at: null });

  test('19:00 event, no end time, dashboard opened at 19:10 — still selectable', () => {
    assert.equal(selectNextBusinessEvent([doors()], at('2026-09-15T18:10:00Z'))!.id, 'tonight');
  });

  test('and at 23:59 local, still selectable', () => {
    assert.equal(selectNextBusinessEvent([doors()], at('2026-09-15T22:59:00Z'))!.id, 'tonight');
  });

  test('but at 00:05 the next local morning, gone', () => {
    // 23:05Z is still the 15th in UTC and already the 16th in London. The
    // event must drop on London's midnight, not UTC's.
    assert.equal(selectNextBusinessEvent([doors()], at('2026-09-15T23:05:00Z')), null);
  });

  test('a future no-end event is upcoming as before', () => {
    const future: NextEventCandidate = { id: 'next-week', starts_at: '2026-09-22T18:00:00Z', ends_at: null };
    assert.equal(selectNextBusinessEvent([future], at('2026-09-15T18:10:00Z'))!.id, 'next-week');
  });

  test('the day is London\u2019s, not the device\u2019s or the server\u2019s', () => {
    // 23:30Z on the 15th is 00:30 on the 16th in London. Anything reading the
    // device clock on UTC would call start and now different days and drop the
    // event; on London time they are the same day and it stays.
    const lateDoors: NextEventCandidate = { id: 'after-midnight', starts_at: '2026-09-15T23:30:00Z', ends_at: null };
    assert.equal(
      selectNextBusinessEvent([lateDoors], at('2026-09-16T01:00:00Z'))!.id,
      'after-midnight',
      'the start day was computed in the wrong timezone',
    );
  });

  test('it is a calendar day, not a fixed 24 hours — the clocks-back day is 25 hours long', () => {
    // 25 Oct 2026 is the BST->GMT transition. These two instants are EXACTLY
    // 24 hours apart and both fall on that one London day, so a "24 hours from
    // start" grace would have just expired it while the day has not ended.
    const dstDay: NextEventCandidate = { id: 'clocks-back', starts_at: '2026-10-24T23:30:00Z', ends_at: null };
    assert.equal(selectNextBusinessEvent([dstDay], at('2026-10-25T23:30:00Z'))!.id, 'clocks-back');
    // And it does end when that day does.
    assert.equal(selectNextBusinessEvent([dstDay], at('2026-10-26T00:30:00Z')), null);
  });

  test('the same holds in winter, on GMT', () => {
    const winter: NextEventCandidate = { id: 'yule', starts_at: '2026-12-15T19:00:00Z', ends_at: null };
    assert.equal(selectNextBusinessEvent([winter], at('2026-12-15T23:30:00Z'))!.id, 'yule');
    assert.equal(selectNextBusinessEvent([winter], at('2026-12-16T00:10:00Z')), null);
  });

  test('an explicit end still decides it — the day rule never overrides one', () => {
    // Ends at 20:00 local; at 21:00 local it is over, even though its own day
    // has hours left. The no-end rule is a fallback, not a floor.
    const ended: NextEventCandidate = { id: 'short', starts_at: '2026-09-15T18:00:00Z', ends_at: '2026-09-15T19:00:00Z' };
    assert.equal(selectNextBusinessEvent([ended], at('2026-09-15T20:00:00Z')), null);
    // ...and an explicit end that runs past midnight keeps it, as before.
    const overnight: NextEventCandidate = { id: 'overnight', starts_at: '2026-09-15T18:00:00Z', ends_at: '2026-09-16T02:00:00Z' };
    assert.equal(selectNextBusinessEvent([overnight], at('2026-09-16T00:30:00Z'))!.id, 'overnight');
  });

  test('a started no-end event beats a future one, and loses to nothing else', () => {
    const live: NextEventCandidate   = { id: 'live',   starts_at: '2026-09-15T18:00:00Z', ends_at: null };
    const future: NextEventCandidate = { id: 'future', starts_at: '2026-09-20T18:00:00Z', ends_at: null };
    const now = at('2026-09-15T18:10:00Z');
    assert.equal(selectNextBusinessEvent([future, live], now)!.id, 'live');
    assert.equal(selectNextBusinessEvent([live, future], now)!.id, 'live', 'input order changed the answer');
  });

  test('it uses the repo\u2019s timezone convention, and cannot drift from it', () => {
    // The module is deliberately dependency-free — node --test executes it, and
    // its ESM resolver wants an extension tsc rejects — so the constant is
    // repeated rather than imported. This is the guard that keeps the two the
    // same: change SHETLAND_TZ and this fails until both move together.
    const src = readFileSync(join(REPO_ROOT, 'lib/business-next-event.ts'), 'utf8');
    const canonical = readFileSync(join(REPO_ROOT, 'lib/shetland-time.ts'), 'utf8');
    const here = src.match(/const SHETLAND_TZ = '([^']+)'/)?.[1];
    const there = canonical.match(/export const SHETLAND_TZ = '([^']+)'/)?.[1];
    assert.equal(here, there, 'the dashboard rule and lib/shetland-time.ts disagree on the timezone');
    assert.equal(here, 'Europe/London');
    assert.match(src, /toLocaleDateString\('en-CA', \{ timeZone: SHETLAND_TZ \}\)/,
      'the day key no longer matches shetlandDayKey\u2019s definition');
    assert.ok(!/24 \* 60|86400|hours?\s*\*\s*3_?600/.test(src),
      'a fixed duration crept in where a calendar day was approved');
    assert.ok(!/new Date\(\)\.getTimezoneOffset|toLocaleDateString\(\)/.test(src),
      'a device-local date call crept in');
  });
});

/* ── Public discovery is deliberately untouched ───────────────────────────── */

describe('the public What\u2019s On rule is not changed by this', () => {
  const WEB = join(REPO_ROOT, '..', 'oneshetland-web');

  test('web discovery still treats a no-end event as a point in time', () => {
    const src = readFileSync(join(WEB, 'lib/events-data.ts'), 'utf8');
    assert.match(src, /ends_at\.gte\.\$\{now\},and\(ends_at\.is\.null,starts_at\.gte\.\$\{now\}\)/,
      'the public discovery filter changed — this fix was for the dashboard only');
  });

  test('and the dashboard rule lives only in the dashboard helper', () => {
    const src = readFileSync(join(REPO_ROOT, 'lib/events-api.ts'), 'utf8');
    assert.ok(!/shetlandDayKey/.test(src), 'the day rule leaked into the shared events API');
  });
});

describe('selectNextBusinessEvent — no upcoming event', () => {
  test('an empty list selects nothing', () => {
    assert.equal(selectNextBusinessEvent([], NOW), null);
  });

  test('only past events selects nothing — never falls back to a stale event', () => {
    const past1 = ev('past1', -24 * 10);
    const past2 = ev('past2', -24 * 1, -12);
    assert.equal(selectNextBusinessEvent([past1, past2], NOW), null);
  });
});

describe('selectNextBusinessEvent — deterministic tie-break', () => {
  test('identical starts_at breaks on id, independent of input order', () => {
    const sameTimeA = ev('bbb', 24);
    const sameTimeB = ev('aaa', 24);
    assert.equal(selectNextBusinessEvent([sameTimeA, sameTimeB], NOW)!.id, 'aaa');
    assert.equal(selectNextBusinessEvent([sameTimeB, sameTimeA], NOW)!.id, 'aaa');
  });
});

describe('the dashboard actually uses the fix', () => {
  const dashboardSrc = readFileSync(join(REPO_ROOT, 'app/local-business-dashboard.tsx'), 'utf8');

  test('imports and calls selectNextBusinessEvent', () => {
    assert.match(dashboardSrc, /import\s*\{\s*selectNextBusinessEvent\s*\}\s*from\s*'@\/lib\/business-next-event'/);
    assert.match(dashboardSrc, /selectNextBusinessEvent\(\s*\n\s*bizEventsRaw\.filter/);
  });

  test('selection is sourced from bizEventsRaw (includes in-progress events), not bizEvents (which excludes them)', () => {
    // bizEvents deliberately excludes anything already started — its filter
    // is pinned against lib/business-home.ts's "upcoming" count, checked in
    // mobile-business-home.node.test.ts, and must not be touched here. An
    // event currently in progress would otherwise never be reachable.
    assert.match(dashboardSrc, /new Date\(e\.starts_at\) > now/, 'bizEvents\' own future-only filter must remain, unchanged, for that pin');
    assert.match(dashboardSrc, /setBizEventsRaw\(evRows as OsEvent\[\]\)/, 'the raw, not-yet-time-filtered list must still be captured');
    const nextAnchor = dashboardSrc.indexOf('const nextBizEvent = selectNextBusinessEvent(');
    assert.notEqual(nextAnchor, -1);
    const block = dashboardSrc.slice(nextAnchor, nextAnchor + 200);
    assert.match(block, /bizEventsRaw\.filter\(e => e\.status === 'published' && !e\.is_hidden\)/,
      'published/not-hidden is preserved (same sanity check as bizEvents), but not the future-only clause');
  });

  test('no longer indexes bizEvents[0] directly for the Scan tickets / Manage events shortcuts', () => {
    assert.doesNotMatch(dashboardSrc, /bizEvents\[0\]/);
  });

  test('fetchBusinessEvents() itself is untouched — the fix is selection, not re-ordering the only call site', () => {
    const eventsApiSrc = readFileSync(join(REPO_ROOT, 'lib/events-api.ts'), 'utf8');
    const start = eventsApiSrc.indexOf('export async function fetchBusinessEvents');
    assert.notEqual(start, -1);
    const body = eventsApiSrc.slice(start, eventsApiSrc.indexOf('\n}', start));
    assert.match(body, /ascending:\s*false/, 'fetchBusinessEvents query ordering is unchanged by this fix');
  });
});
