/**
 * business-dashboard-focus-refresh.node.test.ts
 *
 * Business Dashboard stayed mounted while the owner used a capability flow
 * (create an event, add a product, set up bookings) and never refetched
 * `home.outcomes` on return.
 *
 * REPRODUCTION (ZZ Test)
 * 1. ZZ Test has zero events — Run events is 'available', shown in "Add to
 *    your business".
 * 2. Owner taps Run events → creates an event → event-create replaces
 *    itself with event-manage → owner taps back → lands on the SAME,
 *    still-mounted dashboard screen instance.
 * 3. The dashboard's only fetch was a plain
 *    `useEffect(() => { loadAll(); }, [loadAll])`, whose dependency
 *    (`loadAll`) never changes on this return trip — no useFocusEffect, no
 *    React Query, nothing else asks again. `home.outcomes` (and therefore
 *    `discovery`) stay exactly as they were before the event existed.
 * 4. Run events keeps showing in the chooser; the normal active card never
 *    appears — not a cache bug, not an ownership/query/outcome-rule bug
 *    (all independently verified against production data), purely a
 *    missing refetch-on-focus.
 *
 * THE FIX
 * Replace the mount-only effect with the same
 * `useFocusEffect(useCallback(() => { load(); }, [load]))` idiom already
 * used by business-orders.tsx, business-alerts.tsx, business-jobs.tsx and
 * others — not alongside the mount effect, INSTEAD of it, since
 * useFocusEffect already fires once on initial mount (a freshly mounted
 * screen is focused). Two effects doing the same job on first load would
 * have doubled the initial fetch.
 *
 * The one wrinkle sibling screens don't have: loadAll's optional `biz`
 * argument is how the in-page business switcher keeps its selection (it
 * calls `loadAll(b)` directly) — the route's own businessId param does not
 * track that switch. If the focus effect's useCallback had `activeBusiness`
 * in its dependency array (or closed over it directly), it would (a) not
 * see a business switch made without a re-render in between, and worse, (b)
 * since loadAll calls setActiveBusiness on every single call, closing over
 * activeBusiness as a dependency would hand the effect a new callback
 * identity on every refetch while still focused — re-triggering itself
 * immediately, a self-sustaining refetch loop. A ref
 * (activeBusinessRef, written unconditionally during render) sidesteps
 * both: it is never a dependency, so the callback identity is stable and
 * tied only to `loadAll` itself, yet it always reads the latest business at
 * the moment focus actually happens.
 *
 * WHAT THIS FILE CANNOT PROVE
 * Source-level assertions only — this repo has no RN render/navigation-
 * lifecycle test infrastructure, so it cannot mount the screen, simulate an
 * actual focus/blur transition, or observe a real infinite-loop at runtime.
 * These prove the wiring — one fetch path, on useFocusEffect, with a stable
 * dependency array and the ref read at call time — genuinely matches the
 * description above and the codebase's own established pattern; the
 * outcome-level transition (0 events → 'available' → 'upcoming') is proven
 * against the real business-outcomes.ts functions, which a fresh loadAll()
 * call would feed with real data.
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
// Same convention as mobile-business-home.node.test.ts and
// business-outcomes.node.test.ts: import the canonical web copy, which
// supabase/tests pins byte-for-byte against the mobile copy — see
// "the copied helpers stay identical to web" in mobile-business-home.
import { businessOutcomes, type OutcomeData } from '../../../oneshetland-web/lib/business-outcomes.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

const dashboardPath = 'app/local-business-dashboard.tsx';
const dashboardRaw = read(dashboardPath);
const dashboardSrc = code(dashboardRaw);

/* ── 1 & 6. One fetch path: useFocusEffect replaces the mount effect ─────── */

describe('the dashboard loads on initial focus, with no duplicate mount-time fetch', () => {
  test('useFocusEffect is imported from expo-router, alongside the existing hooks', () => {
    assert.match(dashboardSrc, /import \{ useLocalSearchParams, useRouter, useFocusEffect \} from 'expo-router';/);
  });

  test('the old mount-only effect is gone — no bare useEffect(() => { loadAll(); }, [loadAll])', () => {
    assert.doesNotMatch(dashboardSrc, /useEffect\(\(\) => \{ loadAll\(\); \}, \[loadAll\]\);/);
  });

  test('loadAll is now driven by exactly one useFocusEffect call', () => {
    const matches = dashboardSrc.match(/useFocusEffect\(/g) ?? [];
    assert.equal(matches.length, 1, 'exactly one useFocusEffect — not one per screen concern, and not duplicated');
    assert.match(dashboardSrc, /useFocusEffect\(useCallback\(\(\) => \{\s*\n\s*loadAll\(activeBusinessRef\.current \?\? undefined\);\s*\n\s*\}, \[loadAll\]\)\);/);
  });

  test('this is the same idiom already used by sibling business screens, not a bespoke mechanism', () => {
    for (const sibling of ['app/business-orders.tsx', 'app/business-alerts.tsx', 'app/business-jobs.tsx']) {
      const s = code(read(sibling));
      assert.match(s, /useFocusEffect\(useCallback\(\(\) => \{/, `${sibling} sets the precedent this fix follows`);
    }
  });
});

/* ── 2. Returning to the still-mounted screen re-runs loadAll ────────────── */

describe('returning to the still-mounted dashboard causes loadAll() to run again', () => {
  test('the focus effect carries no "already loaded once" guard that would suppress a second run', () => {
    const fx = dashboardSrc.slice(
      dashboardSrc.indexOf('useFocusEffect(useCallback(() => {'),
      dashboardSrc.indexOf('}, [loadAll]));') + '}, [loadAll]));'.length,
    );
    assert.doesNotMatch(fx, /if \(|hasLoaded|didLoad|loaded\.current/,
      'useFocusEffect already only fires on an actual focus event — a home-grown guard here would just be a second way to suppress the refetch this fix exists to add');
  });

  test('the dependency array is exactly [loadAll] — not activeBusiness, which would make the callback identity change on every load and refetch in a loop', () => {
    assert.match(dashboardSrc, /useFocusEffect\(useCallback\(\(\) => \{[\s\S]*?\}, \[loadAll\]\)\);/);
    assert.doesNotMatch(dashboardSrc, /\}, \[loadAll, activeBusiness\]\)\);/);
  });

  test('activeBusinessRef is written unconditionally on every render, not inside an effect gated on something else', () => {
    assert.match(dashboardSrc, /const activeBusinessRef = useRef<LocalBusiness \| null>\(null\);\s*\n\s*activeBusinessRef\.current = activeBusiness;/);
  });
});

/* ── 3 & 4. The outcome-level transition a fresh loadAll() would surface ─── */

const NONE: OutcomeData = {
  products: 0, productsActive: 0, passes: 0, passesActive: 0,
  services: 0, availability: 0, events: 0, eventsUpcoming: 0,
  offers: 0, offersLive: 0, loyalty: 0, loyaltyActive: 0,
  meetsPro: false, meetsPremium: false,
};

describe('a capability that was "available" before leaving becomes active after a fresh focus load — no remount required', () => {
  test('before: zero events → Run events is available (discoverable, not a working card)', () => {
    const before = businessOutcomes({ id: 'zz', slug: 'zz-test' } as never, NONE, '');
    assert.equal(before[3].state, 'available');
  });

  test('after: the same business with one published, upcoming event → Run events is upcoming (working, not discoverable)', () => {
    const after = businessOutcomes({ id: 'zz', slug: 'zz-test' } as never,
      { ...NONE, events: 1, eventsUpcoming: 1 }, '');
    assert.equal(after[3].state, 'upcoming');
    assert.equal(after[3].tone, 'positive');
  });

  test('the screen\'s own discovery filter and isWorking gate agree with that transition', () => {
    // discovery: DISCOVERABLE.filter((i) => outcomes[i]?.state === 'available')
    // isWorking: !!outcomes[i] && outcomes[i].state !== 'available'
    const before = businessOutcomes({ id: 'zz', slug: 'zz-test' } as never, NONE, '');
    const after = businessOutcomes({ id: 'zz', slug: 'zz-test' } as never,
      { ...NONE, events: 1, eventsUpcoming: 1 }, '');
    const isDiscovery = (o: { state: string }) => o.state === 'available';
    const isWorking = (o: { state: string } | undefined) => !!o && o.state !== 'available';
    assert.equal(isDiscovery(before[3]), true, 'Events starts in the chooser');
    assert.equal(isWorking(before[3]), false, 'and not as a working card');
    assert.equal(isDiscovery(after[3]), false, 'Events leaves the chooser once created');
    assert.equal(isWorking(after[3]), true, 'and the normal card appears');
  });

  test('what makes this reach the screen at all: loadAll is the one thing that (re)fetches home.outcomes, and it is now wired to run on every focus, not just on mount', () => {
    assert.match(dashboardSrc, /const home = homeData as BusinessHome \| null;/);
    assert.match(dashboardSrc, /setHome\(home\);/);
    assert.match(dashboardSrc, /useFocusEffect\(useCallback\(\(\) => \{\s*\n\s*loadAll\(/);
  });
});

/* ── 5. Active-business switching still refreshes correctly ─────────────── */

describe('switching the active business (the in-page switcher) still refreshes correctly, and survives a later focus refetch', () => {
  test('the switcher still calls loadAll(b) directly — untouched by this fix', () => {
    assert.match(dashboardSrc, /onPress=\{\(\) => loadAll\(b\)\}/);
  });

  test('a later focus refetch reads the ref (the latest activeBusiness), not the original route param — so a manual switch is not silently reverted on return', () => {
    assert.match(dashboardSrc, /loadAll\(activeBusinessRef\.current \?\? undefined\);/);
    // loadAll's own fallback: an explicit `biz` argument wins over the
    // route-requested business, so passing the ref preserves whichever
    // business is actually active rather than resetting to routeBusinessId.
    const loadAllSrc = dashboardSrc.slice(dashboardSrc.indexOf('const loadAll = useCallback'), dashboardSrc.indexOf('}, [profile?.id, routeBusinessId]);'));
    assert.match(loadAllSrc, /const target = biz \?\? requested \?\? withPrivate\[0\];/);
  });
});
