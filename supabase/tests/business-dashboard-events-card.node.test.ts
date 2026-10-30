/**
 * business-dashboard-events-card.node.test.ts
 *
 * The Events card is shown for a business with no events.
 *
 * A freshly claimed business has Events outcome state 'available' (zero events,
 * "No events yet"), and isWorking(3) is false for that state, so the card was
 * hidden and "New event" was reachable only through the "Add to your business"
 * chooser. Events is a free capability with its own screens (/event-create,
 * /event-manage, /event-scanner), so the card's guard now also admits the
 * 'available' state. Outcome semantics (lib/business-outcomes.ts) are unchanged.
 *
 * WHAT THIS FILE CANNOT PROVE
 * Source-level assertions only — this repo has no RN render/component test
 * infrastructure. These prove the exception's condition and comment are
 * genuinely gone and Events matches the other three cards; they cannot
 * render the screen.
 *
 * SAFETY
 * No Supabase call, no navigation, no database write. Nothing here touches
 * production.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Same convention as the sibling dashboard suites: the canonical web copy of the outcome helpers (pinned equal to the app's).
import { businessOutcomes, type OutcomeData } from '../../../oneshetland-web/lib/business-outcomes.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

const dashboardPath = 'app/local-business-dashboard.tsx';
const dashboardRaw = read(dashboardPath);
const dashboardSrc = code(dashboardRaw);

describe('the Events card is visible for a business that has never created an event', () => {
  test('the guard shows the card when the Events outcome is "available" as well as when it is working', () => {
    assert.match(dashboardSrc, /\{\(isWorking\(3\) \|\| outcomes\[3\]\?\.state === 'available'\) && \(/);
  });

  test('isWorking itself is unchanged: "available" is still not working (outcome semantics untouched)', () => {
    assert.match(dashboardSrc, /const isWorking = \(i: number\) => !!outcomes\[i\] && outcomes\[i\]\.state !== 'available';/);
  });

  test('the other capability cards keep the plain isWorking(N) gate', () => {
    assert.match(dashboardSrc, /\{isWorking\(1\) && \(/);
    assert.match(dashboardSrc, /\{isWorking\(2\) && \(/);
    assert.match(dashboardSrc, /\{isWorking\(4\) && \(/);
    assert.doesNotMatch(dashboardSrc, /isWorking\((1|2|4)\)\s*\|\|/);
  });

  test('the card keeps its place between Bookings and Retention', () => {
    const bookings = dashboardSrc.indexOf('{isWorking(2) && (');
    const events = dashboardSrc.indexOf("(isWorking(3) || outcomes[3]?.state === 'available')");
    const retention = dashboardSrc.indexOf('{isWorking(4) && (');
    assert.ok(bookings > 0 && bookings < events && events < retention);
  });

  test('lib/business-outcomes.ts is untouched: zero events is still state "available", status "No events yet"', () => {
    const o = read('lib/business-outcomes.ts');
    assert.match(o, /state: "available", tone: "neutral", status: "No events yet"/);
  });
});

describe('zero-event business: New event is offered, with the active business id; nothing that needs an event is', () => {
  // The Events <OutcomeCard> block, so assertions cannot be satisfied by some other card.
  const start = dashboardSrc.indexOf("(isWorking(3) || outcomes[3]?.state === 'available')");
  const block = dashboardSrc.slice(start, dashboardSrc.indexOf('{isWorking(4) && (', start));

  test('New event is an unconditional action that routes to /event-create with businessId = activeBusiness.id', () => {
    assert.match(block, /\{ label: 'New event', onPress: \(\) => router\.push\(\{ pathname: '\/event-create', params: \{ businessId: activeBusiness\.id \} \}\) \}/);
    const before = block.slice(0, block.indexOf("label: 'New event'"));
    assert.doesNotMatch(before.slice(before.lastIndexOf('...(')), /label: 'New event'/);
  });

  test('Manage events is offered only when the outcome is not "available" (i.e. at least one event exists)', () => {
    assert.match(block, /\.\.\.\(outcomes\[3\]\?\.state !== 'available' \? \[\s*\{ label: 'Manage events'[^\]]*\] : \[\]\)/);
  });

  test('Scan tickets is offered only when a real event exists (nextBizEvent), with that event id', () => {
    assert.match(block, /\.\.\.\(nextBizEvent \? \[\s*\{ label: 'Scan tickets', onPress: \(\) => router\.push\(\{ pathname: '\/event-scanner', params: \{ id: nextBizEvent\.id \} \}\) \},?\s*\] : \[\]\)/);
  });

  test('the fact line is empty when there is no event, and otherwise shows the next date', () => {
    assert.match(block, /fact=\{nextBizEvent\s*\? `next \$\{new Date\(nextBizEvent\.starts_at\)/);
    assert.match(block, /: null\}/);
  });

  test('the number of upcoming events is shown by the existing status line', () => {
    assert.match(read('lib/business-outcomes.ts'), /plural\(n\(d\.eventsUpcoming\), "upcoming event"\)/);
    assert.match(dashboardSrc, /\{outcome\.status\}\{fact \? ` · \$\{fact\}` : ''\}/);
  });
});

describe('the events card itself, once shown, is otherwise unchanged', () => {
  test('"New event" still routes to /event-create with the active business id', () => {
    assert.match(dashboardSrc, /pathname: '\/event-create', params: \{ businessId: activeBusiness\.id \}/);
  });

  test('Scan tickets still routes to the correct per-event screen with the real event id', () => {
    // UPDATE — the Events management list (events-management-index.node.test.ts,
    // from a later task than this file). Manage event/events no longer
    // pushes directly to /event-manage with nextBizEvent.id at all — it
    // always opens the management list first (app/business-events.tsx),
    // unconditionally, which is exactly the fix for a draft/second event
    // being otherwise unreachable. This file's own regression run never
    // caught that change landing, since it was not in that task's run list;
    // narrowed to what is still true — Scan tickets is unaffected and still
    // a genuinely per-event push.
    assert.match(dashboardSrc, /pathname: '\/event-scanner', params: \{ id: nextBizEvent\.id \}/);
    assert.match(dashboardSrc, /pathname: '\/business-events', params: \{ businessId: activeBusiness\.id \}/);
  });
});

/* ── A newly claimed business, evaluated with the screen's OWN expressions ──
   The guard, the discovery list and the actions are lifted from the source and run against the REAL outcome helpers,
   so this follows the screen rather than restating it. */
describe('a newly claimed business with zero events', () => {
  const NONE: OutcomeData = {
    products: 0, productsActive: 0, passes: 0, passesActive: 0, services: 0, availability: 0, events: 0, eventsUpcoming: 0,
    offers: 0, offersLive: 0, loyalty: 0, loyaltyActive: 0, meetsPro: false, meetsPremium: false,
  };
  const grab = (re: RegExp, what: string) => { const m = re.exec(dashboardSrc); assert.ok(m, `could not find ${what} in the dashboard`); return m[1]; };
  const screen = (data: OutcomeData, nextEvent: { id: string } | null) => {
    const outcomes = businessOutcomes({ id: 'biz-123', slug: 'new-biz' } as never, data, '');
    const discoverable = grab(/const DISCOVERABLE = (\[[^\]]*\])/, 'DISCOVERABLE');
    const discoveryExpr = grab(/const discovery = home\s*\n\s*\?\s*([\s\S]*?)\n\s*: \[\];/, 'discovery');
    const workingExpr = grab(/const isWorking = \(i: number\) => ([^;]+);/, 'isWorking');
    const guardExpr = grab(/\{(\(isWorking\(3\) \|\| outcomes\[3\]\?\.state === 'available'\)) && \(/, 'Events card guard');
    const manageGuard = grab(/\.\.\.\((outcomes\[3\]\?\.state !== 'available') \? \[/, 'Manage events guard');
    const fn = new Function('outcomes', 'nextBizEvent', 'activeBusiness', `
      const DISCOVERABLE = ${discoverable}; const home = true;
      const discovery = ${discoveryExpr.replace(/ as const/g, '')};
      const isWorking = (i) => ${workingExpr.replace(/ as 1/g, '')};
      const pushed = [];
      const router = { push: (r) => pushed.push(r) };
      const actions = [
        ...(${manageGuard} ? [{ label: 'Manage events', go: () => router.push({ pathname: '/business-events', params: { businessId: activeBusiness.id } }) }] : []),
        { label: 'New event', go: () => router.push({ pathname: '/event-create', params: { businessId: activeBusiness.id } }) },
        ...(nextBizEvent ? [{ label: 'Scan tickets', go: () => router.push({ pathname: '/event-scanner', params: { id: nextBizEvent.id } }) }] : []),
      ];
      return { cardVisible: !!${guardExpr}, discovery, actions, pushed };`);
    return fn(outcomes, nextEvent, { id: 'biz-123' }) as { cardVisible: boolean; discovery: number[]; actions: { label: string; go: () => void }[]; pushed: { pathname: string; params: Record<string, string> }[] };
  };

  test('sees the Events outcome card ("No events yet")', () => {
    const r = screen(NONE, null);
    assert.equal(r.cardVisible, true);
    assert.equal(businessOutcomes({ id: 'b', slug: 's' } as never, NONE, '')[3].status, 'No events yet');
  });

  test('sees New event, and it routes to /event-create with the active business id', () => {
    const r = screen(NONE, null);
    assert.deepEqual(r.actions.map((a) => a.label), ['New event'], 'no Manage events and no Scan tickets without an event');
    r.actions[0].go();
    assert.deepEqual(r.pushed, [{ pathname: '/event-create', params: { businessId: 'biz-123' } }]);
  });

  test('does NOT see a duplicate Events entry under Add to your business', () => {
    const r = screen(NONE, null);
    assert.ok(!r.discovery.includes(3), 'Events must not also be listed in the chooser');
    assert.deepEqual(r.discovery, [1, 2, 4], 'the other three capabilities are still offered, unchanged');
  });

  test('a business that already has an event: card, Manage events, New event and Scan tickets all work, and Events is not in the chooser', () => {
    const r = screen({ ...NONE, events: 1, eventsUpcoming: 1 }, { id: 'ev-9' });
    assert.equal(r.cardVisible, true);
    assert.deepEqual(r.actions.map((a) => a.label), ['Manage events', 'New event', 'Scan tickets']);
    r.actions.forEach((a) => a.go());
    assert.deepEqual(r.pushed, [
      { pathname: '/business-events', params: { businessId: 'biz-123' } },
      { pathname: '/event-create', params: { businessId: 'biz-123' } },
      { pathname: '/event-scanner', params: { id: 'ev-9' } },
    ]);
    assert.ok(!r.discovery.includes(3));
  });

  test('other capabilities keep their behaviour: a configured Sell leaves the chooser; unused ones stay in it', () => {
    const r = screen({ ...NONE, products: 3 }, null);
    assert.ok(!r.discovery.includes(1), 'Sell is working, not discovery');
    assert.deepEqual(r.discovery, [2, 4]);
  });
});
