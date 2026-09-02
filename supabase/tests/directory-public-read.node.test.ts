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

/**
 * A fingerprint of the Directory rows this suite must not touch, captured at
 * import — before any test body has run — and compared again at the end.
 *
 * This used to assert a literal 536 businesses, 528 active. That could never
 * prove the invariant it was named for: real businesses join OneShetland, so
 * the number moves for reasons that have nothing to do with this file, and the
 * guard failed on the day a 537th listing appeared. A snapshot of production
 * measures the calendar, not the code.
 *
 * The digest covers id AND is_active, ordered by id, because counts alone are
 * fooled by a create paired with a delete, and by a row swapped for another.
 *
 * Scope is deliberate: the id set and activation, not every column. A guard
 * over the whole row would fail whenever a real owner edited their description
 * while the suite happened to be running, which is a false alarm about
 * somebody else's work rather than a finding about this one.
 */
const FINGERPRINT_EXPR = `
  count(*)::text || '/' || count(*) filter (where is_active)::text || '/' ||
  coalesce(md5(string_agg(id::text || ':' || is_active::text, ',' order by id)), 'empty')`;

function directoryFingerprint(): { total: string; active: string; digest: string } {
  const [row] = sql(`select ${FINGERPRINT_EXPR} as fp from public.local_businesses;`);
  const [total, active, digest] = String(row.fp).split('/');
  return { total, active, digest };
}

/* Captured at import, so it precedes every test in this file. */
const DIRECTORY_BEFORE = directoryFingerprint();

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

  /* Comparing the fingerprint against itself cannot prove the fingerprint is
     worth anything: weaken it — drop is_active, say — and both readings weaken
     together and still agree. So make it earn the guarantee, by mutating a
     copy of production inside a transaction that is thrown away. */
  test('the fingerprint actually notices the mutations it guards against', () => {
    const [row] = sql(`
      begin;
      create temp table probe (case_name text, differs boolean) on commit drop;
      do $p$
      declare base text; owner uuid; fresh uuid; victim uuid;
      begin
        select ${FINGERPRINT_EXPR} into base from public.local_businesses;
        select owner_id into owner from public.local_businesses where owner_id is not null limit 1;
        select id into victim from public.local_businesses where is_active order by id limit 1;

        fresh := gen_random_uuid();
        insert into public.local_businesses (id,name,category,address,owner_id,subscription_tier,is_active)
        values (fresh,'ZZ fingerprint probe','other','Lerwick',owner,'free',true);
        insert into probe select 'created',
          (select ${FINGERPRINT_EXPR} from public.local_businesses) is distinct from base;
        delete from public.local_businesses where id = fresh;

        update public.local_businesses set is_active = not is_active where id = victim;
        insert into probe select 'deactivated',
          (select ${FINGERPRINT_EXPR} from public.local_businesses) is distinct from base;
        update public.local_businesses set is_active = not is_active where id = victim;

        delete from public.local_businesses where id = victim;
        insert into probe select 'deleted',
          (select ${FINGERPRINT_EXPR} from public.local_businesses) is distinct from base;

        -- One row swapped for another. Both counts come back to where they
        -- started, so this is the case the old count-only guard could not see
        -- and the only one that makes the digest worth carrying.
        insert into public.local_businesses (id,name,category,address,owner_id,subscription_tier,is_active)
        values (gen_random_uuid(),'ZZ fingerprint probe 2','other','Lerwick',owner,'free',true);
        insert into probe select 'swapped, counts identical',
          (select ${FINGERPRINT_EXPR} from public.local_businesses) is distinct from base;
      end $p$;
      select bool_and(differs)::text as all_caught,
             count(*)::text as cases,
             string_agg(case_name, ',' order by case_name) filter (where not differs) as missed
        from probe;
      rollback;`);
    assert.equal(row.cases, '4', 'the sensitivity probe did not run every case');
    assert.equal(row.all_caught, 'true',
      `the fingerprint is blind to: ${row.missed} — it cannot prove this suite touched nothing`);
  });

  test('no business data was mutated', () => {
    const after = directoryFingerprint();
    assert.equal(after.total, DIRECTORY_BEFORE.total,
      `this suite created or deleted a business: ${DIRECTORY_BEFORE.total} before, ${after.total} after`);
    assert.equal(after.active, DIRECTORY_BEFORE.active,
      `this suite changed whether a business is active: ${DIRECTORY_BEFORE.active} before, ${after.active} after`);
    assert.equal(after.digest, DIRECTORY_BEFORE.digest,
      'the set of businesses, or the active state of one of them, changed while this suite ran');
  });
});
