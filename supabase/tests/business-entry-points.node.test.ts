/**
 * business-entry-points.node.test.ts — the two doors into managing a business.
 *
 * Both were broken in ways that only show up to somebody doing it for the
 * first time, which is why they survived: creating a business dropped the new
 * owner on their own public listing — the one page that tells an owner nothing
 * about what to do next — and the dashboard's "Money in" offered an analytics
 * add-on at a route that does not exist.
 *
 * Narrow on purpose. This is not the Business Experience 2.0 redesign; it is
 * the two places that were actually broken.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');
const readWeb = (p: string) => readFileSync(join(WEB, p), 'utf8');
const webPath = (p: string) => join(WEB, p);

const CREATE = readWeb('components/directory/BusinessCreateForm.tsx');
const TOP = readWeb('components/business/DashboardTop.tsx');

function sql(body: string): Record<string, unknown>[] {
  const out = execFileSync('npx',
    ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${body}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  const parsed = JSON.parse(out.slice(out.indexOf('{'))) as { rows?: Record<string, unknown>[]; error?: unknown };
  if (parsed.error) throw new Error(JSON.stringify(parsed.error).slice(0, 400));
  return parsed.rows ?? [];
}

/** The success branch of the create form, isolated from the rest of the file. */
const successBranch = (() => {
  const at = CREATE.indexOf('if (plan) router.push');
  assert.ok(at > 0, 'could not find the create success branch');
  return CREATE.slice(at, CREATE.indexOf('} catch', at));
})();

/* ── 1. Creating a business puts you in charge of it ────────────────────── */

describe('creating a business lands you in the management area', () => {
  test('it no longer sends the new owner to the public listing', () => {
    assert.ok(!/router\.push\(`\/directory\//.test(successBranch),
      'a new owner must not be shown their own listing as a stranger sees it');
  });

  test('it goes to the canonical management route for the business just created', () => {
    assert.match(successBranch, /router\.push\(`\/business\/\$\{data\.id\}\/manage`\)/);
    // Keyed on the id, which is what the route takes — not the slug.
    assert.ok(!/\/business\/\$\{data\.slug/.test(successBranch));
  });

  test('that route actually exists', () => {
    assert.ok(existsSync(webPath('app/business/[id]/manage/page.tsx')));
  });

  test('choosing a plan still continues to billing', () => {
    assert.match(successBranch, /if \(plan\) router\.push\(`\/business\/\$\{data\.id\}\/manage\/billing\?plan=\$\{plan\}`\)/);
    assert.ok(existsSync(webPath('app/business/[id]/manage/billing/page.tsx')));
  });

  test('both destinations are scoped to the business that was just created', () => {
    // Every push in the branch is keyed on the inserted row's own id.
    const pushes = [...successBranch.matchAll(/router\.push\(`([^`]+)`\)/g)].map((m) => m[1]);
    assert.equal(pushes.length, 2, 'exactly two destinations: billing, or manage');
    for (const p of pushes) assert.match(p, /^\/business\/\$\{data\.id\}\/manage/);
  });

  test('nothing else about creating a business changed', () => {
    for (const kept of ['owner_id: user.id', 'is_claimed: true', 'source: "owner"',
                        'subscription_tier: "free"', 'is_active: true']) {
      assert.ok(CREATE.includes(kept), `creation payload changed: ${kept}`);
    }
  });
});

/* ── 2. No dashboard action may lead to a 404 ───────────────────────────── */

describe('every dashboard action goes somewhere that exists', () => {
  test('the /manage/addons dead end is gone', () => {
    assert.ok(!/href=\{`\$\{base\}\/addons`\}/.test(TOP), 'the dead CTA must not remain');
    assert.ok(!existsSync(webPath('app/business/[id]/manage/addons')),
      'if this route were ever created, this test should be revisited rather than deleted');
  });

  test('"Money in" points at the statement in both branches', () => {
    const stat = TOP.slice(TOP.indexOf('week.revenuePence === null'));
    const both = stat.slice(0, stat.indexOf('</section>'));
    assert.equal((both.match(/\$\{base\}\/transactions/g) ?? []).length, 2,
      'unknown and known revenue should both lead to where the money is');
  });

  test('the destination is real, and open to every business', () => {
    assert.ok(existsSync(webPath('app/business/[id]/manage/transactions/page.tsx')));
    const page = readWeb('app/business/[id]/manage/transactions/page.tsx');
    assert.ok(!/addon|has_addon/.test(page), 'the statement must not itself be add-on gated');
  });

  test('it no longer offers an add-on nothing sells', () => {
    assert.ok(!/Needs the analytics add-on/.test(TOP));
  });

  test('every href in DashboardTop resolves to a route that exists', () => {
    const hrefs = [...TOP.matchAll(/\$\{base\}\/([a-z-]+)/g)].map((m) => m[1]);
    assert.ok(hrefs.length >= 5, 'expected the dashboard to link somewhere');
    for (const r of new Set(hrefs)) {
      assert.ok(existsSync(webPath(`app/business/[id]/manage/${r}/page.tsx`)),
        `dashboard links to /manage/${r}, which does not exist`);
    }
  });
});

/* ── 3. What this task was not allowed to touch ─────────────────────────── */

describe('nothing else moved', () => {
  test('DashboardTop still shows the things, not counts of them', () => {
    for (const kept of ['Orders to deal with', 'Coming up', 'Job leads waiting', 'Job applications',
                        'Nothing needs you right now', 'Last 7 days', 'Profile views', 'Contacts',
                        'Followers', 'Open counter mode']) {
      assert.ok(TOP.includes(kept), `DashboardTop changed: ${kept}`);
    }
  });

  test('no setup wizard, checklist or next-action was smuggled in', () => {
    for (const src of [CREATE, TOP]) {
      for (const forbidden of ['setup_state', 'setupState', 'archetype', 'nextAction',
                               'Setup progress', 'checklist']) {
        assert.ok(!src.includes(forbidden), `Phase 0 must not introduce ${forbidden}`);
      }
    }
  });

  test('claims are still submitted for admin review', () => {
    const claim = readWeb('components/directory/BusinessClaimForm.tsx');
    assert.match(claim, /status: "pending"/);
    assert.match(claim, /Claim under review|we&rsquo;ll review it|we'll review it/);
    assert.ok(!/owner_id/.test(claim), 'claiming must not grant ownership directly');
  });

  test('Directory-only management is still outside commercial terms', () => {
    for (const r of ['profile', 'analytics', 'alerts', 'jobs', 'shifts', 'leads', 'orders', 'transactions']) {
      assert.ok(!/commercialTermsGate/.test(readWeb(`app/business/[id]/manage/${r}/page.tsx`)), r);
    }
    assert.ok(!/commercialTermsGate|CommercialTermsAccept/.test(CREATE),
      'creating a listing must not require seller terms');
  });

  test('W3I enforcement and the terms version are untouched', () => {
    const [row] = sql(`
      select (select count(*)::int from pg_trigger
               where tgname='commercial_terms_guard' and not tgisinternal) as guarded,
             (select count(*)::int from pg_trigger
               where tgname='local_businesses_commercial_guard' and not tgisinternal) as lb_guard,
             public.commercial_terms_version() as version;`);
    assert.equal(row.guarded, 9);
    assert.equal(row.lb_guard, 1);
    assert.equal(row.version, '1.0');
  });
});
