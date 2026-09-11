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

  test('a no-end event is "in progress" only at its exact start instant, then rolls into past', () => {
    const rightAtStart = ev('right-at-start', 0); // starts_at === now, no ends_at
    assert.equal(selectNextBusinessEvent([rightAtStart], NOW)!.id, 'right-at-start');

    const startedEarlierNoEnd = ev('started-earlier-no-end', -2); // started 2h ago, no ends_at
    const laterToday          = ev('later-today', 3);
    assert.equal(
      selectNextBusinessEvent([startedEarlierNoEnd, laterToday], NOW)!.id,
      'later-today',
      'a no-end event that started in the past must not be treated as still ongoing',
    );
  });

  test('two overlapping in-progress events resolve deterministically (earlier start wins)', () => {
    const a = ev('a', -3, 1);
    const b = ev('b', -1, 2);
    assert.equal(selectNextBusinessEvent([a, b], NOW)!.id, 'a');
    assert.equal(selectNextBusinessEvent([b, a], NOW)!.id, 'a'); // order-independent
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
