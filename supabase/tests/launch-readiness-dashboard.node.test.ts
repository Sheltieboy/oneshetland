/**
 * launch-readiness-dashboard.node.test.ts — the launch dashboard tells the
 * truth, and only to an admin.
 *
 * /admin/launch-readiness (oneshetland-web) renders from a source-controlled
 * dataset. Two things must hold:
 *
 *   1. ACCESS. Only a platform admin (profiles.role = 'admin', via the one
 *      adminAccessFor rule behind requireAdmin) can see it, and the dataset is
 *      reachable through no other door: not an API route, not a client bundle.
 *   2. HONESTY. The percentage is a deterministic weighted mean that a
 *      malformed entry can only pull down, and it never hides a blocker.
 *
 * The access rule and the calculation are imported and executed. The wiring
 * (who calls requireAdmin, who imports the data) is proven against the real
 * source. When a production build exists, its client chunks are searched for
 * the dataset; set LAUNCH_READINESS_BASE_URL to also probe a running server.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');

type Model = typeof import('../../../oneshetland-web/lib/launch-readiness.ts');
type Item = import('../../../oneshetland-web/lib/launch-readiness.ts').ReadinessItem;
type Dataset = import('../../../oneshetland-web/lib/launch-readiness.ts').ReadinessDataset;

const M = await import(join(WEB_ROOT, 'lib/launch-readiness.ts')) as Model;
const { LAUNCH_READINESS } = await import(join(WEB_ROOT, 'lib/launch-readiness-data.ts')) as
  typeof import('../../../oneshetland-web/lib/launch-readiness-data.ts');
const { adminAccessFor } = await import(join(WEB_ROOT, 'lib/admin-access.ts')) as
  typeof import('../../../oneshetland-web/lib/admin-access.ts');

/** Comments stripped, so an assertion can never pass on a promise in prose. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|\*|\{\/\*).*$/gm, '');
const web = (p: string) => code(readFileSync(join(WEB_ROOT, p), 'utf8'));

const CATS = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }];
const item = (over: Partial<Item> & { id: string }): Item => ({
  area: 'a', title: over.id, description: 'd', status: 'not_started', criticality: 'important',
  weight: 1, evidence: 'e', lastUpdated: '2026-09-01', ...over,
});
const ds = (items: Item[]): Dataset => ({ categories: CATS, items });

/* ── 1–2. access ──────────────────────────────────────────────────────────── */

describe('only a platform admin gets in', () => {
  test('signed out is sent to sign in', () => {
    assert.equal(adminAccessFor(null), 'sign_in');
  });

  test('a signed-in non-admin is denied', () => {
    for (const role of ['user', 'business', 'driver', 'Admin', 'ADMIN', '', null, undefined]) {
      assert.equal(adminAccessFor({ profile: { role } }), 'deny', `role ${String(role)}`);
    }
    assert.equal(adminAccessFor({ profile: null }), 'deny', 'no profile row');
  });

  test('an admin is allowed', () => {
    assert.equal(adminAccessFor({ profile: { role: 'admin' } }), 'allow');
  });

  test('requireAdmin acts on that rule and redirects both refusals', () => {
    const guard = web('lib/admin-data.server.ts');
    assert.match(guard, /const access = adminAccessFor\(a\);/);
    assert.match(guard, /if \(access === "sign_in"\) redirect\("\/sign-in\?next=\/admin"\);/);
    assert.match(guard, /if \(access === "deny"\) redirect\("\/account"\);/);
    assert.doesNotMatch(guard, /@oneshetland|darren/i, 'no hard-coded identity');
  });

  test('the page, its loader and the admin layout each check before rendering', () => {
    const page = web('app/admin/launch-readiness/page.tsx');
    const loader = web('lib/launch-readiness.server.ts');
    assert.ok(page.indexOf('await requireAdmin()') > -1);
    assert.ok(page.indexOf('await requireAdmin()') < page.indexOf('await getLaunchReadiness()'));
    assert.ok(loader.indexOf('await requireAdmin()') > -1);
    assert.ok(loader.indexOf('await requireAdmin()') < loader.indexOf('return LAUNCH_READINESS'));
    assert.match(web('app/admin/layout.tsx'), /await requireAdmin\(\)/);
    assert.match(page, /export const dynamic = "force-dynamic"/);
    assert.match(page, /robots: \{ index: false, follow: false \}/);
  });

  test('it is linked only from inside the admin area', () => {
    const hits = sourceFiles().filter((f) => /["'`]\/admin\/launch-readiness/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(WEB_ROOT, f)).sort();
    assert.deepEqual(hits, [
      'app/admin/page.tsx',
      'components/admin/AdminSidebar.tsx',
      'components/admin/LaunchReadiness.tsx',
    ]);
  });
});

/* ── 3–4. the calculation ─────────────────────────────────────────────────── */

describe('the percentage is a transparent weighted mean', () => {
  test('status contributions are the published ones', () => {
    assert.deepEqual(M.STATUS_CONTRIBUTION, {
      complete: 1, needs_verification: 0.75, in_progress: 0.5, blocked: 0, not_started: 0,
    });
  });

  test('weights decide how much each item moves it', () => {
    // (10·1 + 4·0.75 + 2·0.5 + 3·0 + 1·0) / 20 = 14/20 = 70%
    const s = M.computeReadiness(ds([
      item({ id: 'x1', status: 'complete', weight: 10 }),
      item({ id: 'x2', status: 'needs_verification', weight: 4 }),
      item({ id: 'x3', status: 'in_progress', weight: 2 }),
      item({ id: 'x4', status: 'blocked', weight: 3 }),
      item({ id: 'x5', status: 'not_started', weight: 1 }),
    ]));
    assert.equal(s.percent, 70);
    assert.deepEqual(s.counts, { complete: 1, needs_verification: 1, in_progress: 1, blocked: 1, not_started: 1 });
  });

  test('it rounds down, so 99.9% is never shown as 100%', () => {
    const items = [item({ id: 'big', status: 'complete', weight: 10 })];
    for (let n = 0; n < 99; n++) items.push(item({ id: `c${n}`, status: 'complete', weight: 10 }));
    items.push(item({ id: 'last', status: 'needs_verification', weight: 1 }));
    assert.equal(M.computeReadiness(ds(items)).percent, 99);
  });

  test('post-launch items are excluded from the percentage and counts', () => {
    const base = [item({ id: 'x1', status: 'complete', weight: 5 })];
    const withPost = [...base, item({ id: 'p1', status: 'not_started', weight: 10, criticality: 'launch_blocker', scope: 'post_launch' })];
    assert.equal(M.computeReadiness(ds(withPost)).percent, 100);
    assert.equal(M.computeReadiness(ds(withPost)).openBlockers, 0);
    assert.equal(M.computeReadiness(ds(withPost)).totalLaunchItems, 1);
  });

  test('deterministic: same input, same answer, regardless of order', () => {
    const items = LAUNCH_READINESS.items;
    const a = M.computeReadiness(LAUNCH_READINESS);
    const b = M.computeReadiness({ ...LAUNCH_READINESS, items: [...items].reverse() });
    const c = M.computeReadiness(LAUNCH_READINESS);
    assert.deepEqual(a, b);
    assert.deepEqual(a, c);
  });

  test('last updated is the newest item date', () => {
    const s = M.computeReadiness(ds([
      item({ id: 'x1', lastUpdated: '2026-09-02' }), item({ id: 'x2', lastUpdated: '2026-09-20' }),
      item({ id: 'x3', lastUpdated: '2026-08-30' }),
    ]));
    assert.equal(s.lastUpdated, '2026-09-20');
  });
});

/* ── 5–6. blockers ────────────────────────────────────────────────────────── */

describe('the percentage never hides a blocker', () => {
  test('a blocked launch blocker is counted', () => {
    const s = M.computeReadiness(ds([
      item({ id: 'x1', status: 'complete', weight: 10 }),
      item({ id: 'x2', status: 'blocked', criticality: 'launch_blocker', weight: 1 }),
    ]));
    assert.equal(s.openBlockers, 1);
    assert.ok(s.percent >= 90, 'a high percentage and an open blocker coexist');
  });

  test('every non-complete status of a blocker keeps it open', () => {
    for (const status of ['needs_verification', 'in_progress', 'blocked', 'not_started'] as const) {
      assert.equal(M.computeReadiness(ds([item({ id: 'x', status, criticality: 'launch_blocker' })])).openBlockers, 1, status);
    }
  });

  test('a completed blocker no longer counts', () => {
    const s = M.computeReadiness(ds([item({ id: 'x', status: 'complete', criticality: 'launch_blocker' })]));
    assert.equal(s.openBlockers, 0);
  });

  test('non-blocker criticality is never a blocker', () => {
    const s = M.computeReadiness(ds([item({ id: 'x', status: 'blocked', criticality: 'important' })]));
    assert.equal(s.openBlockers, 0);
  });

  test('the page states blockers remain whenever the count is above zero', () => {
    const ui = web('components/admin/LaunchReadiness.tsx');
    assert.match(ui, /summary\.openBlockers > 0 \? \(/);
    assert.match(ui, /Launch blockers remain\. OneShetland is not ready to launch, whatever the percentage says\./);
  });
});

/* ── 7. filters ───────────────────────────────────────────────────────────── */

describe('filters', () => {
  const items = [
    item({ id: 'done', status: 'complete' }),
    item({ id: 'done-blocker', status: 'complete', criticality: 'launch_blocker' }),
    item({ id: 'open-blocker', status: 'in_progress', criticality: 'launch_blocker', area: 'b' }),
    item({ id: 'verify', status: 'needs_verification' }),
    item({ id: 'stuck', status: 'blocked', area: 'b' }),
    item({ id: 'later', status: 'not_started' }),
    item({ id: 'going', status: 'in_progress' }),
  ];
  const ids = (xs: Item[]) => xs.map((x) => x.id).sort();

  test('all', () => assert.equal(M.filterItems(items, 'all').length, items.length));
  test('launch blockers = open blockers only', () => assert.deepEqual(ids(M.filterItems(items, 'blockers')), ['open-blocker']));
  test('needs attention = blocked, needs verification or an open blocker', () =>
    assert.deepEqual(ids(M.filterItems(items, 'attention')), ['open-blocker', 'stuck', 'verify']));
  test('complete', () => assert.deepEqual(ids(M.filterItems(items, 'complete')), ['done', 'done-blocker']));
  test('by category, combined with a filter', () => {
    assert.deepEqual(ids(M.filterItems(items, 'all', 'b')), ['open-blocker', 'stuck']);
    assert.deepEqual(ids(M.filterItems(items, 'attention', 'b')), ['open-blocker', 'stuck']);
  });
  test('an unknown filter value falls back to all', () => {
    assert.equal(M.parseFilter('everything'), 'all');
    assert.equal(M.parseFilter(undefined), 'all');
    assert.equal(M.parseFilter('blockers'), 'blockers');
  });
});

/* ── 8. recently completed ────────────────────────────────────────────────── */

describe('recently completed', () => {
  test('newest first, only complete items, stable on ties, limited', () => {
    const got = M.recentlyCompleted([
      item({ id: 'old', status: 'complete', lastUpdated: '2026-08-01' }),
      item({ id: 'new-b', status: 'complete', lastUpdated: '2026-09-20' }),
      item({ id: 'new-a', status: 'complete', lastUpdated: '2026-09-20' }),
      item({ id: 'mid', status: 'complete', lastUpdated: '2026-09-10' }),
      item({ id: 'not-done', status: 'in_progress', lastUpdated: '2026-09-24' }),
    ], 3).map((i) => i.id);
    assert.deepEqual(got, ['new-a', 'new-b', 'mid']);
  });
});

/* ── 9. malformed data ────────────────────────────────────────────────────── */

describe('malformed data cannot flatter the number', () => {
  const good = [item({ id: 'x1', status: 'complete', weight: 5 }), item({ id: 'x2', status: 'not_started', weight: 5 })];

  test('an unknown status counts as 0% but keeps its weight, and is reported', () => {
    const bad = [...good, item({ id: 'x3', status: 'done' as never, weight: 5 })];
    const s = M.computeReadiness(ds(bad));
    assert.equal(s.percent, 33, '5 / 15, not 5 / 10');
    assert.ok(s.percent <= M.computeReadiness(ds(good)).percent);
    assert.ok(s.issues.some((m) => m.includes('unknown status "done"')));
    assert.equal(Object.values(s.counts).reduce((a, b) => a + b, 0), 2, 'not counted under any real status');
  });

  test('an unknown status on a blocker keeps the blocker open', () => {
    const s = M.computeReadiness(ds([item({ id: 'x', status: 'shipped' as never, criticality: 'launch_blocker' })]));
    assert.equal(s.openBlockers, 1);
  });

  test('an absurd weight is clamped to 1, not allowed to dominate', () => {
    const s = M.computeReadiness(ds([...good, item({ id: 'x3', status: 'complete', weight: 1000 })]));
    assert.equal(s.percent, 54, '(5 + 1) / 11');
    assert.ok(s.issues.some((m) => m.includes('weight 1000')));
  });

  test('duplicate ids, unknown areas and bad dates are reported', () => {
    const issues = M.validateDataset(ds([
      item({ id: 'x1' }), item({ id: 'x1' }), item({ id: 'x2', area: 'nowhere' }), item({ id: 'x3', lastUpdated: '24/09/2026' }),
    ]));
    assert.ok(issues.some((m) => m.includes('duplicated')));
    assert.ok(issues.some((m) => m.includes('unknown area')));
    assert.ok(issues.some((m) => m.includes('invalid lastUpdated')));
  });

  test('the page shows data problems rather than swallowing them', () => {
    assert.match(web('components/admin/LaunchReadiness.tsx'), /summary\.issues\.length > 0 &&/);
  });
});

/* ── 10. no public door ───────────────────────────────────────────────────── */

function sourceFiles(dir = WEB_ROOT): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.next', '.git', 'public', 'scripts', 'supabase'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(tsx?|mts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe('no readiness data through any public route', () => {
  const files = sourceFiles();
  const importers = (mod: string) => files
    .filter((f) => new RegExp(`from ["'][^"']*${mod}(\\.ts)?["']`).test(readFileSync(f, 'utf8')))
    .map((f) => relative(WEB_ROOT, f)).sort();

  test('the dataset is imported only by its server-only loader', () => {
    assert.deepEqual(importers('launch-readiness-data'), ['lib/launch-readiness.server.ts']);
    assert.match(web('lib/launch-readiness.server.ts'), /^import "server-only";/m);
  });

  test('the loader is imported only by the admin page', () => {
    assert.deepEqual(importers('launch-readiness\\.server'), ['app/admin/launch-readiness/page.tsx']);
  });

  test('no API route, and no client component, touches readiness', () => {
    for (const f of files) {
      const rel = relative(WEB_ROOT, f);
      const src = readFileSync(f, 'utf8');
      const touches = /launch-readiness/.test(src);
      if (!touches) continue;
      assert.ok(!rel.startsWith('app/api/'), `${rel} is an API route`);
      if (/^["']use client["']/m.test(src)) {
        // The sidebar holds only the link text; it must not import anything.
        assert.doesNotMatch(src, /from ["'][^"']*launch-readiness/, `${rel} is a client component importing readiness`);
      }
    }
  });

  test('the dataset module has no side effects: data only, types erased', () => {
    const src = web('lib/launch-readiness-data.ts');
    assert.deepEqual(src.match(/^import .*$/gm), ['import type { ReadinessDataset } from "./launch-readiness.ts";']);
  });

  test('robots keeps /admin/ out of search', () => {
    assert.match(web('app/robots.ts'), /"\/admin\/"/);
  });

  const staticDir = join(WEB_ROOT, '.next', 'static');
  const built = existsSync(staticDir) &&
    statSync(staticDir).mtimeMs > statSync(join(WEB_ROOT, 'lib', 'launch-readiness-data.ts')).mtimeMs;
  test('no client bundle of the current build contains the dataset', { skip: built ? false : 'no production build newer than the dataset' }, () => {
    const sentinels = LAUNCH_READINESS.items.flatMap((i) => [i.id, i.evidence.slice(0, 40)]);
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : n.endsWith('.js') ? [p] : [];
    });
    for (const f of walk(staticDir)) {
      const js = readFileSync(f, 'utf8');
      for (const s of sentinels) assert.ok(!js.includes(s), `${relative(WEB_ROOT, f)} contains "${s}"`);
    }
  });

  const base = process.env.LAUNCH_READINESS_BASE_URL;
  test('a signed-out request is redirected and receives none of the data', { skip: base ? false : 'set LAUNCH_READINESS_BASE_URL' }, async () => {
    for (const path of ['/admin/launch-readiness', '/admin/launch-readiness?view=blockers']) {
      const res = await fetch(new URL(path, base), { redirect: 'manual' });
      const body = await res.text();
      assert.ok([303, 307, 308].includes(res.status) || /NEXT_REDIRECT|\/sign-in/.test(body), `${path} → ${res.status}`);
      for (const i of LAUNCH_READINESS.items) {
        assert.ok(!body.includes(i.evidence.slice(0, 40)), `${path} leaked evidence for ${i.id}`);
      }
    }
  });
});

/* ── 11. the real dataset ─────────────────────────────────────────────────── */

describe('the committed dataset', () => {
  test('is valid', () => assert.deepEqual(M.validateDataset(LAUNCH_READINESS), []));

  test('every category has at least one item', () => {
    for (const c of LAUNCH_READINESS.categories) {
      assert.ok(LAUNCH_READINESS.items.some((i) => i.area === c.id), c.id);
    }
  });

  test('Stripe live-mode cutover is an open launch blocker until it is done', () => {
    const live = LAUNCH_READINESS.items.find((i) => i.id === 'payments-live-cutover');
    assert.ok(live);
    assert.equal(live.criticality, 'launch_blocker');
  });

  test('its headline numbers', () => {
    const s = M.computeReadiness(LAUNCH_READINESS);
    assert.ok(s.percent > 0 && s.percent < 100);
    assert.ok(s.openBlockers > 0);
    console.log(`  readiness ${s.percent}% · open blockers ${s.openBlockers} · ${s.totalLaunchItems} launch items · last updated ${s.lastUpdated}`);
  });
});
