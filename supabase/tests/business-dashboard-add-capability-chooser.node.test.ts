/**
 * business-dashboard-add-capability-chooser.node.test.ts
 *
 * "Add to your business" — discoverability for every unused capability, not
 * just Events.
 *
 * THE PROBLEM
 * Business Dashboard hid Sell things / Take bookings / Run events / Keep
 * customers coming back until each had already been used (isWorking(i)), and
 * the one discovery mechanism that existed for the never-used state — the
 * "Also possible on OneShetland" shelf — only appeared once Be found reached
 * `state === 'good'`. A freshly claimed business (every business at launch)
 * is very unlikely to have a 'good' profile yet, so the shelf effectively
 * never showed for the cohort that needed it most. A prior phase patched
 * this narrowly for Events alone (see business-dashboard-events-card.node.
 * test.ts) as a launch exception; this is the general fix.
 *
 * THE FIX
 * A compact "Add to your business" row, shown whenever any of outcomes[1..4]
 * is `state === 'available'`, independent of outcomes[0] (Be found). Tapping
 * it opens the app's existing Sheet component (AddCapabilitySheet) listing
 * exactly the unused capabilities, reusing the same DISCOVERY_ITEMS
 * title/blurb/plan/icon/route already defined for the retired shelf — no new
 * capability system, no new routes, no entitlement change.
 *
 * WHAT THIS FILE CANNOT PROVE
 * Source-level assertions only — this repo has no RN render/component test
 * infrastructure. These prove the trigger condition, the item list, the
 * routes and the mutual exclusivity with isWorking() are genuinely wired as
 * described; they cannot render the sheet or tap a row.
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

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

const dashboardPath = 'app/local-business-dashboard.tsx';
const dashboardRaw = read(dashboardPath);
const dashboardSrc = code(dashboardRaw);

/* ── 1. Visible regardless of Be found's own state ──────────────────────── */

describe('a newly claimed business sees "Add to your business" even when Be found is not "good"', () => {
  test('the trigger condition is discovery.length > 0 alone', () => {
    const idx = dashboardSrc.indexOf('{discovery.length > 0 && (');
    assert.notEqual(idx, -1);
  });

  test('the retired Be-found-good gate ("showDiscovery") no longer exists anywhere', () => {
    assert.doesNotMatch(dashboardSrc, /showDiscovery/);
  });

  test('discovery itself does not read outcomes[0] (Be found) at all', () => {
    const discoveryDeclIdx = dashboardSrc.indexOf('const discovery = home');
    const nextConstIdx = dashboardSrc.indexOf('const ', discoveryDeclIdx + 10);
    const between = dashboardSrc.slice(discoveryDeclIdx, nextConstIdx);
    assert.doesNotMatch(between, /outcomes\[0\]/);
  });
});

/* ── 2/3. All four unused capabilities appear, with correct copy/plan/route ── */

describe('all four capabilities are discoverable when unused, each with its existing copy, plan label and route', () => {
  test('DISCOVERABLE covers exactly outcomes 1-4 (Be found, index 0, is never in the chooser)', () => {
    assert.match(dashboardSrc, /const DISCOVERABLE = \[1, 2, 3, 4\] as const;/);
  });

  test('the sheet receives exactly discovery.map(i => DISCOVERY_ITEMS[i]) — nothing hand-picked, nothing extra', () => {
    assert.match(dashboardSrc, /items=\{discovery\.map\(\(i\) => DISCOVERY_ITEMS\[i\]\)\}/);
  });

  const expected: Record<number, { title: string; blurb: string; plan: string; route: string }> = {
    1: { title: 'Sell things', blurb: 'Products and passes people can buy', plan: 'Premium', route: "pathname: '/business-products', params: { businessId: activeBusiness!.id }" },
    2: { title: 'Take bookings', blurb: 'Let customers book your services', plan: 'Pro', route: "pathname: '/local-book-services', params: { businessId: activeBusiness!.id }" },
    3: { title: 'Run events', blurb: 'Publish events and manage tickets', plan: 'Free', route: "pathname: '/event-create', params: { businessId: activeBusiness!.id }" },
    4: { title: 'Keep customers coming back', blurb: 'Offers and loyalty for returning customers', plan: 'Pro', route: "pathname: '/local-offer-new', params: { businessId: activeBusiness!.id }" },
  };

  for (const [key, item] of Object.entries(expected)) {
    test(`capability ${key} ("${item.title}") keeps its existing title, blurb, plan and route`, () => {
      assert.match(dashboardSrc, new RegExp(`title: '${item.title.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}'`));
      assert.match(dashboardSrc, new RegExp(`blurb: '${item.blurb.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}'`));
      assert.match(dashboardSrc, new RegExp(`plan: '${item.plan}'`));
      assert.ok(dashboardSrc.includes(item.route), `expected route for ${item.title}: ${item.route}`);
    });
  }
});

/* ── 4. An active capability shows its full card, not a duplicate in the chooser ── */

describe('an already-active capability appears only as its full dashboard card, never duplicated in the chooser', () => {
  test('discovery is filtered to state === "available" only — an active outcome (saved/live/upcoming/etc) is excluded', () => {
    assert.match(dashboardSrc, /DISCOVERABLE\.filter\(\(i\) => outcomes\[i\]\?\.state === 'available'\)/);
  });

  test('isWorking(i) and discovery membership are complementary by construction: isWorking excludes exactly "available", discovery includes exactly "available"', () => {
    assert.match(dashboardSrc, /const isWorking = \(i: number\) => !!outcomes\[i\] && outcomes\[i\]\.state !== 'available';/);
    assert.match(dashboardSrc, /outcomes\[i\]\?\.state === 'available'/);
  });

  test('the four dashboard cards are still gated on isWorking(N), independent of the chooser', () => {
    assert.match(dashboardSrc, /\{isWorking\(1\) && \(/);
    assert.match(dashboardSrc, /\{isWorking\(2\) && \(/);
    assert.match(dashboardSrc, /\{isWorking\(3\) && \(/);
    assert.match(dashboardSrc, /\{isWorking\(4\) && \(/);
  });
});

/* ── 5. `unknown` is never treated as available ─────────────────────────── */

describe('a capability whose read failed ("unknown") is never offered as available', () => {
  test('the discovery filter matches the literal string "available", not any other state', () => {
    // asUnknown() in business-outcomes.ts returns state: "unknown" — a
    // distinct string from "available", so the strict === filter here
    // already excludes it. This pins that the filter stays a strict
    // equality check rather than, say, a falsy/truthy or negated check
    // that could accidentally admit "unknown" too.
    assert.match(dashboardSrc, /outcomes\[i\]\?\.state === 'available'/);
    assert.doesNotMatch(dashboardSrc, /outcomes\[i\]\?\.state !== 'unknown'/);
  });

  const outcomesSrc = code(read('lib/business-outcomes.ts'));
  test('business-outcomes.ts itself keeps "unknown" and "available" as distinct, never-conflated states', () => {
    assert.match(outcomesSrc, /state: "unknown"/);
    assert.match(outcomesSrc, /state: "available"/);
  });
});

/* ── 6. No unused capabilities → no trigger ─────────────────────────────── */

describe('when every capability is already active, the "Add to your business" row does not render', () => {
  test('the row is wrapped in {discovery.length > 0 && (...)}, with no other unconditional render path', () => {
    const bannerIdx = dashboardSrc.indexOf('Add to your business');
    const guardIdx = dashboardSrc.lastIndexOf('{discovery.length > 0 && (', bannerIdx);
    assert.ok(guardIdx !== -1 && guardIdx < bannerIdx);
  });
});

/* ── 7. Events: chooser item while unused, normal card once active ─────── */

describe('Run events moves itself from the chooser to a normal card the moment it becomes active — no separate code path', () => {
  test('Events (index 3) is covered by the same DISCOVERABLE/isWorking mechanism as the other three — no Events-only branch remains', () => {
    assert.match(dashboardSrc, /const DISCOVERABLE = \[1, 2, 3, 4\] as const;/);
    assert.doesNotMatch(dashboardSrc, /isWorking\(3\)\s*\|\|\s*outcomes\[3\]\?\.state === 'available'/);
  });

  test('DISCOVERY_ITEMS still defines the Events entry the chooser shows while outcomes[3].state === "available"', () => {
    assert.match(dashboardSrc, /3: \{ title: 'Run events'/);
  });
});

/* ── 8. Fixed card order is untouched by this change ────────────────────── */

describe('the fixed 0-4 card render order is untouched', () => {
  test('outcomes[0] through outcomes[4] still appear in that source order', () => {
    const idx = [0, 1, 2, 3, 4].map((i) => dashboardSrc.indexOf(`outcomes[${i}]`));
    assert.ok(idx.every((n) => n !== -1));
    assert.deepEqual([...idx].sort((a, b) => a - b), idx);
  });
});

/* ── The chooser reuses the existing Sheet component, not a new UI pattern ── */

describe('AddCapabilitySheet reuses the app\'s existing Sheet component', () => {
  test('it renders <Sheet ... title="Add to your business">, not a bespoke Modal', () => {
    assert.match(dashboardSrc, /<Sheet visible=\{visible\} onClose=\{onClose\} title="Add to your business">/);
  });

  test('tapping a row closes the sheet before navigating', () => {
    assert.match(dashboardSrc, /onPress=\{\(\) => \{ onClose\(\); it\.onPress\(\); \}\}/);
  });
});
