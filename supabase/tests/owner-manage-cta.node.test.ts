/**
 * owner-manage-cta.node.test.ts — the owner of a listing can get into it.
 *
 * The public directory page had an owner bar and a "Manage business" button,
 * and neither had rendered for anybody in a long time. The condition was:
 *
 *     const isOwner = !!account && !!b.owner_id && account.id === b.owner_id;
 *
 * `b` comes from the PUBLIC listing query, and `anon` has no SELECT grant on
 * local_businesses.owner_id — deliberately, because who owns a listing is not
 * public. Asking for it returns 42501, so the column was simply absent from
 * the row and `b.owner_id` was always undefined. The comparison was therefore
 * always false, the CTA never appeared, and owners had to go out to Account →
 * Your businesses → find it → Manage to reach their own dashboard.
 *
 * Ownership is now ASKED as a question — filtered under the signed-in user's
 * own session — rather than read and compared. The tempting wrong fix is to
 * add owner_id to the public column list, which would both expose the
 * business → person mapping and 42501 the whole page for signed-out visitors.
 * There is a test below that fails if anyone does that.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');

const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

const pageRaw = readFileSync(join(WEB_ROOT, 'app/directory/[id]/page.tsx'), 'utf8');
const page    = code(pageRaw);
const server  = code(readFileSync(join(WEB_ROOT, 'lib/business-data.server.ts'), 'utf8'));
const data    = code(readFileSync(join(WEB_ROOT, 'lib/local-data.ts'), 'utf8'));
const bizSrv  = code(readFileSync(join(WEB_ROOT, 'lib/business-server.ts'), 'utf8'));

/**
 * A JSX expression, brace-matched from the `{` the marker itself opens.
 *
 * The marker must BE the opening brace, not something near it: searching
 * backwards for the nearest `{` lands inside `style={{…}}` and quietly scopes
 * every assertion to the wrong fragment.
 */
function branchFrom(src: string, marker: string): string {
  const open = src.indexOf(marker);
  assert.notEqual(open, -1, `could not find ${marker}`);
  assert.equal(src[open], '{', `${marker} must start at its opening brace`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  throw new Error(`unbalanced braces after ${marker}`);
}

function publicConfig(): { url: string; anonKey: string } | null {
  let url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  let anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!url || !anonKey) {
    try {
      for (const line of readFileSync(join(REPO_ROOT, '.env'), 'utf8').split('\n')) {
        const m = line.match(/^\s*(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_ANON_KEY)\s*=\s*(.+)\s*$/);
        if (!m) continue;
        const v = m[2].trim().replace(/^["']|["']$/g, '');
        if (m[1].endsWith('URL')) url ||= v; else anonKey ||= v;
      }
    } catch { /* handled by the null return */ }
  }
  return url && anonKey ? { url, anonKey } : null;
}
const cfg = publicConfig();

/* ── 1. who sees it ───────────────────────────────────────────────────────── */
describe('the Manage business CTA appears for the owner and nobody else', () => {
  const hero = branchFrom(page, '{isOwner ? (');

  test('the owner sees it', () => {
    assert.match(hero, /isOwner \?/, 'the action slot no longer branches on ownership');
    const shown = hero.slice(hero.indexOf('isOwner ?'), hero.indexOf(') : ('));
    assert.match(shown, /Manage business/);
  });

  test('a signed-in visitor who does not own it sees Follow instead', () => {
    const other = hero.slice(hero.indexOf(') : ('));
    assert.match(other, /<FollowButton/);
    assert.ok(!/Manage business/.test(other), 'a non-owner is offered the dashboard');
  });

  test('a signed-out visitor sees Follow, and no ownership question is asked', () => {
    // `!!account &&` short-circuits, so a signed-out request never even runs
    // the query — the page stays as cheap as it was.
    assert.match(page, /const isOwner = !!account && \(await ownsBusiness\(account\.id, b\.id\)\)/);
  });

  test('the owner-only bar is gated on the same answer', () => {
    assert.match(page, /\{isOwner && \(/);
  });
});

/* ── 2. where it goes ─────────────────────────────────────────────────────── */
describe('it goes straight to that business’s own dashboard', () => {
  test('the href names this business and the existing management route', () => {
    const hero = branchFrom(page, '{isOwner ? (');
    assert.match(hero, /href=\{`\/business\/\$\{b\.id\}\/manage`\}/);
  });

  test('no intermediate list, and no new route invented', () => {
    const hero = branchFrom(page, '{isOwner ? (');
    assert.ok(!/\/account/.test(hero), 'the owner is sent via the account page again');
    assert.ok(!/manage\/[a-z]/.test(hero), 'the CTA points at a sub-page rather than the dashboard');
  });

  test('the tier nudge still offers billing, and is the only other owner link', () => {
    assert.match(page, /href=\{`\/business\/\$\{b\.id\}\/manage\/billing`\}/);
    assert.equal((page.match(/\/business\/\$\{b\.id\}\/manage`/g) ?? []).length, 1,
      'the same dashboard link is repeated on the page');
  });
});

/* ── 3. asked, not read ───────────────────────────────────────────────────── */
describe('ownership is asked as a question', () => {
  const fn = server.slice(server.indexOf('export async function ownsBusiness'));

  test('it filters on owner_id and never selects it', () => {
    assert.match(fn, /\.eq\("owner_id", userId\)/);
    assert.match(fn, /\.eq\("id", businessId\)/);
    assert.match(fn, /count: "exact", head: true/);
    assert.ok(!/select\(["'`][^)]*owner_id/.test(fn.slice(0, fn.indexOf('return'))),
      'owner_id is selected back out');
  });

  test('it runs under the caller’s own session, not a service key', () => {
    assert.match(fn, /await createServerClient\(\)/);
    assert.ok(!/SERVICE_ROLE|serviceClient/.test(fn), 'it escalates privilege to answer');
  });

  test('it answers false rather than throwing', () => {
    assert.match(fn, /catch \{ return false; \}/);
  });
});

/* ── 4. the wrong fix stays shut ──────────────────────────────────────────── */
describe('the public listing query still cannot see who owns anything', () => {
  test('owner_id is not added to the public column list', () => {
    const cols = data.slice(data.indexOf('const DETAIL_COLS'), data.indexOf('const LIST_COLS'));
    assert.ok(!/owner_id/.test(cols),
      'owner_id was added to the public detail columns — that exposes the ' +
      'business-to-person mapping AND 42501s the page for signed-out visitors');
    const list = data.slice(data.indexOf('const LIST_COLS'), data.indexOf('const LIST_COLS') + 400);
    assert.ok(!/owner_id/.test(list), 'owner_id was added to the public list columns');
  });

  test('anon really is refused that column, live', { skip: !cfg }, async () => {
    const res = await fetch(
      `${cfg!.url}/rest/v1/local_businesses?select=owner_id&limit=1`,
      { headers: { apikey: cfg!.anonKey, Authorization: `Bearer ${cfg!.anonKey}` } },
    );
    assert.ok([401, 403].includes(res.status), `anon read owner_id and got ${res.status}`);
    const body = await res.json().catch(() => ({}));
    assert.equal((body as { code?: string }).code, '42501');
  });

  test('the public page still renders for everyone else', { skip: !cfg }, async () => {
    const res = await fetch(
      `${cfg!.url}/rest/v1/local_businesses?select=id,name,slug&is_active=eq.true&limit=1`,
      { headers: { apikey: cfg!.anonKey, Authorization: `Bearer ${cfg!.anonKey}` } },
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json() as unknown[]).length, 1);
  });
});

/* ── 5. still only a link ─────────────────────────────────────────────────── */
describe('the CTA is navigation, not authorisation', () => {
  test('the destination proves ownership for itself', () => {
    assert.match(bizSrv, /export async function requireBusinessOwner/);
    assert.match(bizSrv, /business\.owner_id !== account\.id/);
    assert.match(bizSrv, /redirect\(`\/sign-in\?next=/);
  });

  test('nothing was relaxed to make the button work', () => {
    assert.ok(!/ownsBusiness/.test(bizSrv), 'the management guard now leans on the UI helper');
  });
});

/* ── 6. Follow is untouched for ordinary visitors ─────────────────────────── */
describe('following still works for the people it is for', () => {
  test('the button keeps every prop it had', () => {
    assert.match(page, /<FollowButton businessId=\{b\.id\} accent=\{accent\} isLoggedIn=\{isLoggedIn\} signInHref=\{signInHref\} \/>/);
  });

  test('a signed-out visitor is still sent to sign in, and comes back here', () => {
    assert.match(page, /const signInHref = `\/sign-in\?next=\/directory\/\$\{id\}`/);
  });

  test('the owner is not offered a pointless follow of their own listing', () => {
    assert.equal((page.match(/<FollowButton/g) ?? []).length, 1);
    const hero = branchFrom(page, '{isOwner ? (');
    assert.ok(hero.indexOf('isOwner ?') < hero.indexOf('<FollowButton'),
      'Follow is rendered ahead of the ownership branch');
  });
});
