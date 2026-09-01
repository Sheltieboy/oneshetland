/**
 * directory-public-read.node.test.ts — a signed-out visitor can see the Directory.
 *
 * The regression this exists to stop happening again: wallet_live was added as
 * a PostgREST computed column on local_businesses. Evaluating one requires a
 * WHOLE-ROW reference, and Postgres checks a whole-row var against TABLE-level
 * SELECT — not against the columns the function reads. anon and authenticated
 * hold only COLUMN-level SELECT here, deliberately, so Stripe ids, NFC tokens
 * and import provenance stay private. Every public business read 401'd with
 * 42501, both loaders turned that into [], and /directory said "0 listings"
 * while all 528 active businesses sat untouched in the table.
 *
 * So these tests do the thing that would have caught it: a real HTTP request
 * with the anon key, asserting on the STATUS as well as the rows. Counting rows
 * alone is exactly how an error-as-empty-array hides.
 *
 * Run: npm test
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');
const readWeb = (p: string) => readFileSync(join(WEB, p), 'utf8');

function sql(body: string): Record<string, unknown>[] {
  const out = execFileSync('npx',
    ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${body}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 });
  const parsed = JSON.parse(out.slice(out.indexOf('{'))) as { rows?: Record<string, unknown>[]; error?: unknown };
  if (parsed.error) throw new Error(JSON.stringify(parsed.error).slice(0, 400));
  return parsed.rows ?? [];
}

/* The anon key is the one a signed-out browser holds; it is public by design.
   Read from the web app's own env so this tests what actually ships. */
function env(): { url: string; key: string } {
  for (const f of ['.env.local', '.env']) {
    const p = join(WEB, f);
    if (!existsSync(p)) continue;
    const t = readFileSync(p, 'utf8');
    const url = /NEXT_PUBLIC_SUPABASE_URL\s*=\s*"?([^"\n]+)"?/.exec(t)?.[1]?.trim();
    const key = /NEXT_PUBLIC_SUPABASE_ANON_KEY\s*=\s*"?([^"\n]+)"?/.exec(t)?.[1]?.trim();
    if (url && key) return { url, key };
  }
  throw new Error('no anon credentials found for the signed-out probe');
}

type Res = { status: number; body: unknown };
async function anonGet(path: string): Promise<Res> {
  const { url, key } = env();
  const r = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  return { status: r.status, body: await r.json() };
}

/** Exactly the select the deployed Directory list uses. */
const LIST_COLS = (() => {
  const m = /const LIST_COLS =\s*\n\s*"([^"]+)"/.exec(readWeb('lib/local-data.ts'));
  assert.ok(m, 'LIST_COLS must still be findable — this test follows the real query');
  return m[1].replace(/\s+/g, '');
})();

describe('a signed-out visitor can load the Directory', () => {
  let list: Res;
  before(async () => {
    list = await anonGet(`local_businesses_public?select=${LIST_COLS}&is_active=eq.true&limit=200`);
  });

  test('1. the query succeeds — status, not just row count', () => {
    assert.equal(list.status, 200,
      `signed-out Directory read failed: ${JSON.stringify(list.body).slice(0, 300)}`);
  });

  test('2. it returns active businesses', () => {
    assert.ok(Array.isArray(list.body));
    assert.ok((list.body as unknown[]).length > 100,
      'hundreds of active listings are expected, not a handful');
  });

  test('3. wallet_live is selectable by the anonymous query', () => {
    const rows = list.body as Record<string, unknown>[];
    assert.ok('wallet_live' in rows[0], 'the effective-Wallet answer must still come back');
    for (const r of rows) assert.equal(typeof r.wallet_live, 'boolean');
  });

  test('4. an ordinary active business with Wallet off is still returned', () => {
    const rows = list.body as Record<string, unknown>[];
    assert.ok(rows.some((r) => r.accepts_wallet !== true), 'Wallet is not a condition of being listed');
  });

  test('5 & 6. Directory visibility does not depend on a paid tier', () => {
    const rows = list.body as Record<string, unknown>[];
    const free = rows.filter((r) => r.subscription_tier === 'free');
    assert.ok(free.length > 50, `free businesses must be listed — saw ${free.length}`);
  });

  test('7. Wallet presentation is still effective-tier aware', () => {
    const rows = list.body as Record<string, unknown>[];
    // Nothing may claim Wallet without the stored flag; the tier half is proved
    // against the deployed rule below and by the Wallet suite.
    for (const r of rows) {
      if (r.wallet_live === true) assert.equal(r.accepts_wallet, true);
    }
    const [v] = sql(`select pg_get_viewdef('public.local_businesses_public'::regclass, true) as d;`);
    assert.match(String(v.d), /business_meets_tier\(id, 'pro'::text\)/);
    assert.match(String(v.d), /accepts_wallet AND is_active/);
  });

  test('8. inactive businesses stay hidden', async () => {
    const r = await anonGet('local_businesses_public?select=id,is_active&is_active=eq.false&limit=5');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, [], 'RLS still hides unpublished listings through the view');
  });

  test('the private columns are still unreachable through the view', async () => {
    for (const c of ['owner_id', 'stripe_account_id', 'nfc_token', 'source']) {
      const r = await anonGet(`local_businesses_public?select=id,${c}&limit=1`);
      assert.notEqual(r.status, 200, `${c} must not be readable by a signed-out visitor`);
    }
  });

  test('the original failure is genuinely fixed, not merely routed around', async () => {
    // The table still refuses a whole-row reference — that is correct and is why
    // the view exists. What must never come back is a public select that asks
    // the TABLE for wallet_live.
    const bad = await anonGet(`local_businesses?select=id,wallet_live&limit=1`);
    assert.notEqual(bad.status, 200, 'the computed column on the table is still not anon-selectable');
    const src = readWeb('lib/local-data.ts');
    const listUses = /const PUBLIC_BUSINESS = "local_businesses_public"/.test(src);
    assert.ok(listUses, 'public reads must go through the view');
    for (const m of src.matchAll(/\.from\("local_businesses"\)([\s\S]{0,160})/g)) {
      assert.doesNotMatch(m[1], /LIST_COLS|DETAIL_COLS/,
        'a public column list must never be selected from the table again');
    }
  });
});

describe('a failed Directory fetch must not look like an empty Shetland', () => {
  test('9. the loader no longer discards the error it was handed', () => {
    const src = readWeb('lib/local-data.ts');
    const fn = src.slice(src.indexOf('export async function getAllBusinesses'),
                         src.indexOf('export async function getBookableBusinesses'));
    assert.ok(fn.includes('.from(PUBLIC_BUSINESS)'), 'the slice must be the Directory loader');
    // This is what hid a platform-wide 401 for days: `const { data } = await q`
    // throws the error away, and `data ?? []` then reads as "no businesses".
    assert.match(fn, /const \{ data, error \}/,
      'the error must be received, so a failure can be told apart from an empty result');
    assert.match(fn, /if \(error\) throw error/, 'and acted on rather than discarded');
    assert.doesNotMatch(fn, /catch \{\s*return \[\];/,
      'an empty array must never stand in for a failed fetch');
  });
});

describe('nothing was weakened to achieve it', () => {
  test('the base table still refuses a whole-row reference to anon', () => {
    const [row] = sql(`select has_table_privilege('anon','public.local_businesses','SELECT') as t;`);
    assert.equal(row.t, false, 'granting table-level SELECT would expose every hidden column');
  });

  test('the column grants are exactly as they were', () => {
    const [row] = sql(`
      select string_agg(c.column_name, ',' order by c.column_name) as hidden
        from information_schema.columns c
       where c.table_schema='public' and c.table_name='local_businesses'
         and not exists (select 1 from information_schema.column_privileges p
                          where p.grantee='anon' and p.table_schema='public'
                            and p.table_name='local_businesses' and p.column_name=c.column_name
                            and p.privilege_type='SELECT');`);
    assert.equal(String(row.hidden).split(',').length, 19,
      'anon must still be blind to the same 19 columns');
    assert.match(String(row.hidden), /owner_id/);
    assert.match(String(row.hidden), /stripe_account_id/);
  });

  test('the view runs as the caller, so RLS still decides the rows', () => {
    const [row] = sql(`
      select c.reloptions::text as opts from pg_class c
       where c.oid='public.local_businesses_public'::regclass;`);
    assert.match(String(row.opts), /security_invoker=(true|on)/,
      'a definer view here would hand anon every row RLS is meant to hide');
  });

  test('Wallet entitlement itself is untouched', () => {
    const [g] = sql(`select pg_get_functiondef('public.local_businesses_wallet_tier_guard'::regproc) as d;`);
    assert.match(String(g.d), /business_meets_tier\(new\.id, 'pro'\)/);
    const [w] = sql(`select pg_get_functiondef('public.wallet_live'::regproc) as d;`);
    assert.match(String(w.d), /b\.accepts_wallet/, 'the computed column stays for owner/server callers');
  });

  test('no business data was mutated', () => {
    const [row] = sql(`
      select count(*)::text as total, count(*) filter (where is_active)::text as active
        from public.local_businesses;`);
    assert.equal(row.total, '536');
    assert.equal(row.active, '528');
  });
});
