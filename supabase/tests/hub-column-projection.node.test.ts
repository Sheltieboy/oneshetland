/**
 * hub-column-projection.node.test.ts — never ask hubs for a column you cannot have.
 *
 * WHAT WENT WRONG
 *
 * 20260928130000 took table-level SELECT on public.hubs away from anon and
 * authenticated and granted 21 safe columns back. Before applying it I audited
 * every hub read in both repositories — by grepping for `from('hubs')`. That
 * missed PostgREST's OTHER syntax entirely:
 *
 *     .select("role, hub:hubs(*)")
 *
 * An embedded select-star. getMyHubs used it, so the moment the grant landed an
 * owner opened "My hubs" and was told they run none, while their hub and their
 * active owner row sat there in perfect order. The error was never checked, so
 * a permission failure rendered as an empty state.
 *
 * WHAT IS ASSERTED
 *
 * Not "the string hubs(*) is absent" — that only bans the shape that already
 * bit us. Every hub projection in either repository, direct or embedded, is
 * extracted and every column in it checked against the grant list read out of
 * the migration itself. A column added to that migration is allowed here
 * automatically; one that is not on it fails, whatever syntax asked for it.
 *
 *   · no select-star on hubs, direct or embedded, in either repository
 *   · every named hub column any client asks for is granted to some client role
 *   · stripe_account_id is asked for by nobody
 *   · getMyHubs names its columns, and only whitelisted ones
 *   · getMyHubs surfaces a query error instead of rendering "you have none"
 *   · the page says which hubs it means, and points elsewhere for the rest
 *
 * SAFETY
 * Source inspection of both repositories plus one migration file. No database,
 * no network, no writes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');
const GRANTS = join(REPO_ROOT, 'supabase/migrations/20260928130000_hub_column_grants.sql');
const SERVER = join(WEB, 'lib/hubs-server.ts');
const PAGE = join(WEB, 'app/account/hubs/page.tsx');

const src = (p: string) => readFileSync(p, 'utf8');
const strip = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/**
 * The grant list, read from the migration rather than retyped here. If a column
 * is later granted, this test allows it without being edited; if one is granted
 * that should not be, that is the migration's review, not this file's.
 */
function grantedColumns(): Set<string> {
  const s = src(GRANTS);
  const arr = s.slice(s.indexOf('safe_cols constant text[] := array['), s.indexOf('];', s.indexOf('safe_cols')));
  const cols = [...arr.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(cols.length >= 20, `only found ${cols.length} granted columns — the migration shape changed`);
  // owner_id is granted to authenticated only, further down the same migration.
  assert.match(s, /grant select \(owner_id\) on public\.hubs to authenticated/);
  return new Set([...cols, 'owner_id']);
}

/** Every .ts/.tsx a client role could execute, in both repositories. */
function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (['node_modules', '.next', '.expo', 'ios', 'android', 'dist', 'build'].includes(e.name)) continue;
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const CLIENT_DIRS = [
  join(REPO_ROOT, 'lib'), join(REPO_ROOT, 'app'), join(REPO_ROOT, 'components'), join(REPO_ROOT, 'hooks'),
  join(WEB, 'lib'), join(WEB, 'app'), join(WEB, 'components'),
];
const FILES = CLIENT_DIRS.flatMap((d) => walk(d));

type Projection = { file: string; line: number; how: string; cols: string };

/** Resolve `select(HUB_COLS)` back to the literal it names, in the same file. */
function resolveConst(name: string, body: string): string | null {
  const m = body.match(new RegExp(`(?:const|let)\\s+${name}\\s*(?::[^=]+)?=\\s*([\`'"])([\\s\\S]*?)\\1`));
  return m ? m[2] : null;
}

/** Every place either repository asks public.hubs for columns. */
function projections(): Projection[] {
  const found: Projection[] = [];
  for (const file of FILES) {
    const body = strip(src(file));
    const rel = relative(join(REPO_ROOT, '..'), file);
    const lineOf = (i: number) => body.slice(0, i).split('\n').length;

    // Direct: .from('hubs') … .select(<arg>)
    for (const m of body.matchAll(/from\(\s*['"]hubs['"]\s*\)\s*\n?\s*\.select\(\s*([^)]*?)\s*\)/g)) {
      let arg = m[1].trim();
      if (/^[`'"]/.test(arg)) arg = arg.slice(1, -1);
      else {
        const resolved = resolveConst(arg.replace(/\s*as const\s*$/, ''), body);
        arg = resolved ?? `«unresolved:${arg}»`;
      }
      found.push({ file: rel, line: lineOf(m.index!), how: 'direct', cols: arg });
    }

    // Embedded: hub:hubs( … ) or hubs( … ) inside any select string. The inner
    // list may itself be a template interpolation of a named constant, which is
    // how getMyHubs states its columns.
    for (const m of body.matchAll(/(?:[a-z_]+\s*:\s*)?\bhubs\s*\(([^()]*)\)/gi)) {
      if (/from\(\s*['"]hubs/.test(body.slice(Math.max(0, m.index! - 12), m.index!))) continue;
      let cols = m[1].trim();
      const interp = cols.match(/^\$\{([A-Za-z_$][\w$]*)\}$/);
      if (interp) cols = resolveConst(interp[1], body) ?? `«unresolved:${interp[1]}»`;
      found.push({ file: rel, line: lineOf(m.index!), how: 'embedded', cols });
    }
  }
  return found;
}

const GRANTED = grantedColumns();
const PROJECTIONS = projections();

describe('the guard can see what it is guarding', () => {
  test('it read the grant list out of the migration', () => {
    assert.ok(GRANTED.has('name') && GRANTED.has('payout_enabled') && GRANTED.has('owner_id'));
    assert.equal(GRANTED.has('stripe_account_id'), false, 'the migration is granting the account id');
  });

  test('it found the hub projections in BOTH repositories', () => {
    assert.ok(PROJECTIONS.length >= 10, `only found ${PROJECTIONS.length} hub projections — the scanner is not seeing them`);
    const repos = new Set(PROJECTIONS.map((p) => p.file.split('/')[0]));
    assert.ok(repos.has('oneshetland-web'), 'no web projections found');
    assert.ok(repos.has('oneshetland-delivers'), 'no mobile projections found');
  });

  test('and it can resolve a named column constant', () => {
    const viaConst = PROJECTIONS.filter((p) => p.cols.includes('brand_color') && p.how === 'direct');
    assert.ok(viaConst.length > 0, 'HUB_COLS was not resolved to its literal');
    assert.ok(!PROJECTIONS.some((p) => p.cols.startsWith('«unresolved')),
      `a projection could not be resolved: ${PROJECTIONS.filter((p) => p.cols.startsWith('«unresolved')).map((p) => `${p.file}:${p.line}`).join(', ')}`);
  });
});

describe('no client asks hubs for everything', () => {
  test('no select-star, direct or embedded, in either repository', () => {
    const stars = PROJECTIONS.filter((p) => p.cols.split(',').some((c) => c.trim() === '*'));
    assert.deepEqual(stars.map((p) => `${p.file}:${p.line} (${p.how})`), [],
      'select-star on hubs is a permission error for every client role');
  });
});

describe('every column any client asks for is one it may have', () => {
  for (const p of PROJECTIONS) {
    test(`${p.file}:${p.line} (${p.how})`, () => {
      const cols = p.cols.split(',').map((c) => c.trim()).filter(Boolean)
        // Nested embeds inside a projection are checked as their own entry.
        .filter((c) => !c.includes('(')).map((c) => c.split(':').pop()!.trim());
      const ungranted = cols.filter((c) => !GRANTED.has(c));
      assert.deepEqual(ungranted, [], `asks hubs for ${ungranted.join(', ')} — not granted to any client role`);
    });
  }

  test('and nobody asks for the Connect account id', () => {
    const leaks = PROJECTIONS.filter((p) => p.cols.includes('stripe_account_id'));
    assert.deepEqual(leaks.map((p) => `${p.file}:${p.line}`), []);
  });
});

describe('getMyHubs, specifically', () => {
  const c = strip(src(SERVER));

  test('names its columns rather than embedding a star', () => {
    assert.match(c, /const MANAGED_HUB_COLS = "id, name, slug, type, logo_url, brand_color, is_active"/);
    assert.match(c, /\.select\(`role, hub:hubs\(\$\{MANAGED_HUB_COLS\}\)`\)/);
    assert.doesNotMatch(c, /hub:hubs\(\*\)/);
  });

  test('every one of those columns is granted', () => {
    const cols = 'id, name, slug, type, logo_url, brand_color, is_active'.split(',').map((s) => s.trim());
    assert.deepEqual(cols.filter((x) => !GRANTED.has(x)), []);
  });

  test('a query error is raised, not rendered as "you have none"', () => {
    const fn = c.slice(c.indexOf('export async function getMyHubs'));
    const body = fn.slice(0, fn.indexOf('\n}') + 2);
    assert.match(body, /if \(error\) throw new Error/,
      'a permission failure would show an empty state again');
    assert.match(body, /const \{ data, error \}/);
  });

  test('the owner/committee criteria are unchanged', () => {
    const fn = c.slice(c.indexOf('export async function getMyHubs'));
    const body = fn.slice(0, fn.indexOf('\n}') + 2);
    assert.match(body, /\.in\("role", \["owner", "committee"\]\)/);
    assert.match(body, /\.eq\("status", "active"\)/);
    assert.match(body, /h\.is_active/);
  });
});

describe('the page says which hubs it means', () => {
  const p = strip(src(PAGE));

  test('it is titled for management, not ownership of the whole idea', () => {
    assert.match(p, /Hubs I manage<\/h1>/);
    assert.match(p, /title: "Hubs I manage"/);
    assert.doesNotMatch(p, /My hubs/);
  });

  test('the subtitle says what that means', () => {
    assert.match(p, /Hubs you own or help run\./);
  });

  test('the empty state still offers to start one', () => {
    assert.match(p, /Start a hub/);
    assert.match(p, /href="\/hubs\/new"/);
  });

  test('and points joiners at their memberships instead of dead-ending', () => {
    assert.match(p, /Looking for hubs you&apos;ve joined\?/);
    assert.match(p, /href="\/account\/memberships"/);
    assert.match(p, /View your memberships/);
  });

  test('memberships were not consolidated into this page', () => {
    assert.doesNotMatch(p, /getMyHubMemberships|getMyMembershipPurchases/,
      'this page lists hubs you manage; memberships stay on their own page');
  });
});

describe('the account navigation agrees with the page', () => {
  for (const f of ['app/account/page.tsx', 'components/account/AccountSidebar.tsx']) {
    test(`${f} calls it "Hubs I manage"`, () => {
      const c = strip(src(join(WEB, f)));
      const row = c.split('\n').find((l) => l.includes('/account/hubs'));
      assert.ok(row, `${f} no longer links to /account/hubs`);
      assert.match(row, /Hubs I manage/);
      assert.doesNotMatch(row, /My hubs/);
    });
  }

  test('the route itself did not move', () => {
    assert.match(strip(src(join(WEB, 'components/account/AccountSidebar.tsx'))), /href: "\/account\/hubs"/);
  });
});
