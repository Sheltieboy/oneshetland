/**
 * launch-partner-enrichment.node.test.ts — the directory reader and the enrichment provenance log, against the real SQL.
 *
 * Migration 20261110000000. Two admin-only readers/writers and one append-only table:
 *   admin_launch_partner_directory_records(uuid[])        STABLE, read-only: the few Directory fields a draft is built from,
 *                                                         for a business that is NOT publicly listed too
 *   admin_launch_partner_enrichment_record(uuid, jsonb)   INSERTS one run row (and one audit event); nothing else
 *   admin_launch_partner_enrichment_list(uuid)            newest first, at most 10
 *
 *   A  shape: functions, volatility, grants, RLS and no client privilege on the table, no http, no other function changed
 *   B  admin-only matrix for all three functions
 *   C  directory_records: an INACTIVE business is readable by an admin; exactly the whitelisted fields; limits
 *   D  record/list: sequential run numbers, validation, audit event holds counts only (no page text, no proposal)
 *   E  append-only: UPDATE, DELETE and TRUNCATE are refused
 *   F  the real Directory and commerce data is byte-identical after preparing a private enrichment draft end to end
 *   G  idempotent re-apply
 *   K  mutations: the admin gate, the 25-id ceiling and the append-only trigger are each load-bearing
 *
 * SAFETY — ISOLATED DATABASE ONLY: requires PASS_PROOF_DSN, refuses a DSN mentioning Supabase.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = join(REPO_ROOT, 'supabase/migrations');
const BASELINE = join(MIG, '20260623000000_baseline_remote_schema.sql');
const COMMERCE = join(MIG, '20260801130000_commerce_engine.sql');
const MEETS = join(MIG, '20260916120000_business_meets_tier.sql');
const FIX = join(MIG, '20261031030000_business_claims_claimants_submit_only.sql');
const DECIDER = join(MIG, '20261031040000_business_claims_record_the_decider.sql');
const REFUNDFIX = join(MIG, '20261007120000_business_wallet_refunds.sql');
const GRANTS = join(MIG, '20261103000000_launch_plan_grants.sql');
const LOCALITY = join(MIG, '20261104000000_public_business_locality.sql');
const CLAIMS = join(MIG, '20261104030000_launch_partner_claims.sql');
const IMPORT = join(MIG, '20261105000000_product_import_foundation.sql');
const CAMPAIGNS = join(MIG, '20261106000000_launch_partner_campaigns.sql');
const VERSIONS = join(MIG, '20261107000000_launch_partner_profile_versions.sql');
const EMAILOPEN = join(MIG, '20261108000000_launch_partner_email_opening.sql');
const SENDCLAIM = join(MIG, '20261109000000_launch_partner_send_claim.sql');
const FEATURE = join(MIG, '20261110000000_launch_partner_enrichment.sql');
const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
const src = (p: string) => readFileSync(p, 'utf8');

/** VERBOSITY=verbose so an error line carries its SQLSTATE: "ERROR:  42501: message". */
function raw(body: string): string {
  try {
    return execFileSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=0', '-v', 'VERBOSITY=verbose', '-c', body],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  } catch (e) { const err = e as { stdout?: string; stderr?: string }; return `${err.stdout ?? ''}${err.stderr ?? ''}`; }
}
const TAG = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|TRUNCATE.*|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !TAG.test(l));
const scalar = (sql: string) => rowsOf(raw(sql)).pop() ?? '';
const asUser = (uid: string | null, sql: string) =>
  raw(`begin; ${uid ? `set local request.jwt.claim.sub = '${uid}';` : ''} set local role ${uid ? 'authenticated' : 'anon'}; ${sql}; commit;`);
const asService = (sql: string) => raw(`begin; set local role service_role; ${sql}; commit;`);
/** An expression, as a role; the JSON value it returns, null for SQL NULL, or the raw error text. */
const fn = (uid: string | null, expr: string): any => {
  const l = rowsOf(asUser(uid, `select coalesce((${expr})::text, 'null')`));
  const last = l[l.length - 1];
  try { return JSON.parse(last); } catch { return l.join('\n'); }
};
const isErr = (v: unknown, code?: string) => typeof v === 'string' && /ERROR/.test(v) && (!code || v.includes(code));

function slice(file: string, opener: string, closer: string): string {
  const s = src(file); const start = s.indexOf(opener);
  assert.notEqual(start, -1, `${opener} is gone from ${file}`);
  const end = s.indexOf(closer, start); assert.notEqual(end, -1);
  return s.slice(start, end + closer.length);
}
function createTable(file: string, opener: string): string {
  const s = src(file); const start = s.indexOf(opener); assert.notEqual(start, -1, `${opener} is gone`);
  const open = s.indexOf('(', start); let d = 0, end = -1;
  for (let i = open; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (d === 0) { end = i; break; } } }
  return s.slice(start, end + 1) + ';';
}
const policies = (table: string) =>
  [...src(BASELINE).matchAll(new RegExp(`CREATE POLICY "[^"]+" ON public\\.${table}[^;]*;`, 'g'))].map((m) => m[0]);

const ADMIN = 'a0a0a0a0-0000-4000-8000-a0a0a0a0a0a0';
const ALICE = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';   // the invited owner of SHOP
const BOB = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';     // owned PREV before any launch claim
const EVE = 'e3e3e3e3-3333-4333-8333-e3e3e3e3e3e3';     // an ordinary user
const CAROL = 'ca0a0a0a-4444-4444-8444-ca0a0a0a0a0a';   // owner of OTHERBIZ, which has its own campaign and launch claim
const SHOP = 'c2c2c2c2-bbbb-4bbb-8bbb-c2c2c2c2c2c2';
const CAFE = 'c1c1c1c1-aaaa-4aaa-8aaa-c1c1c1c1c1c1';
const PREV = 'c3c3c3c3-cccc-4ccc-8ccc-c3c3c3c3c3c3';    // owned by BOB, no launch claim
const FRESH = 'c4c4c4c4-dddd-4ddd-8ddd-c4c4c4c4c4c4';
const OTHERBIZ = 'c5c5c5c5-eeee-4eee-8eee-c5c5c5c5c5c5'; // owned by CAROL
const NOPE = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0';
const SLUG = 'voe-gift-shop';

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const jb = (o: unknown) => `${q(JSON.stringify(o))}::jsonb`;
const A = (expr: string) => fn(ADMIN, expr);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function buildSchema(): string {
  return raw([
    'drop schema if exists public cascade; create schema public;',
    'drop schema if exists auth cascade; create schema auth;',
    `do $r$ begin
       if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
       if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
       if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
     end $r$;`,
    'alter role service_role bypassrls;',
    'alter default privileges in schema public grant all on tables to anon, authenticated, service_role;',
    'alter default privileges in schema public grant all on functions to anon, authenticated, service_role;',
    'grant usage on schema public, auth to anon, authenticated, service_role;',
    'create table auth.users (id uuid primary key);',
    `create or replace function auth.uid() returns uuid language sql stable as $$
       select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`,
    'grant execute on function auth.uid() to anon, authenticated, service_role;',
    `create table public.profiles (id uuid primary key, role text default 'customer', full_name text, is_platform_owner boolean default false);`,
    `create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
       select exists (select 1 from public.profiles where id = auth.uid() and (role = 'admin' or is_platform_owner = true)) $$;`,
    createTable(BASELINE, 'CREATE TABLE public.local_businesses ('),
    'alter table public.local_businesses add primary key (id);',
    'alter table public.local_businesses enable row level security;',
    ...policies('local_businesses'),
    createTable(BASELINE, 'CREATE TABLE public.business_claims ('),
    'alter table public.business_claims add primary key (id);',
    'alter table public.business_claims add foreign key (business_id) references public.local_businesses(id) on delete cascade;',
    'alter table public.business_claims add foreign key (user_id) references public.profiles(id) on delete cascade;',
    'CREATE UNIQUE INDEX uq_business_claims_open ON public.business_claims USING btree (business_id, user_id) WHERE (status = \'pending\'::text);',
    'alter table public.business_claims enable row level security;',
    ...policies('business_claims'),
    slice(BASELINE, 'CREATE FUNCTION public.approve_business_claim', '$$;'),
    slice(REFUNDFIX, 'create or replace function public.tg_is_server_write', '$$;'),
    createTable(COMMERCE, 'create table if not exists public.products ('),
    createTable(BASELINE, 'CREATE TABLE public.book_services ('),
    createTable(BASELINE, 'CREATE TABLE public.book_unit_items ('),
    createTable(BASELINE, 'CREATE TABLE public.local_offers ('),
    createTable(IMPORT, 'create table if not exists public.import_batches ('),
    slice(MEETS, 'create or replace function public.business_meets_tier(', '$$;'),
    slice(LOCALITY, 'create or replace function public.business_locality(', '$$;'),
    createTable(GRANTS, 'create table if not exists public.launch_plan_grants ('),
    slice(GRANTS, 'create or replace function public.launch_plan_authorised()', '$$;'),
    src(FIX),
    src(DECIDER),
    src(CLAIMS),
    src(CAMPAIGNS),
    src(VERSIONS),
    src(EMAILOPEN),
    src(SENDCLAIM),
    src(FEATURE),
  ].join('\n'));
}

before(() => {
  assert.ok(DSN, 'PASS_PROOF_DSN is not set — run `npm run test:isolated`.');
  assert.ok(!/supabase\.co|pooler\.supabase/.test(DSN), 'PASS_PROOF_DSN points at Supabase. Refusing to run.');
  const out = buildSchema();
  assert.doesNotMatch(out, /ERROR/i, `fixture did not build:\n${out.slice(0, 1800)}`);
  const seed = raw(`
    insert into public.profiles (id, role, full_name) values
      ('${ADMIN}', 'admin', 'Ada Admin'), ('${ALICE}', 'customer', 'Alice Owner'), ('${BOB}', 'customer', 'Bob Previous'),
      ('${EVE}', 'customer', 'Eve Ordinary'), ('${CAROL}', 'customer', 'Carol Elsewhere');
    insert into public.local_businesses (id, name, category, address, description) values
      ('${SHOP}', 'Voe Gift Shop', 'retail', ' Voe, Shetland ', 'Soap and gifts'),
      ('${CAFE}', 'Harbour Cafe', 'food_drink', 'Lerwick', 'Coffee'),
      ('${PREV}', 'Previously Owned Croft', 'other', 'Walls', 'Croft'),
      ('${FRESH}', 'Fresh Listing', 'other', 'Unst', 'Fresh'),
      ('${OTHERBIZ}', 'Carol Knitwear', 'retail', 'Whalsay', 'Knit');`);
  assert.doesNotMatch(seed, /ERROR/i, seed);
});

// ── fixtures ────────────────────────────────────────────────────────────────
/** The versions table is immutable by trigger; the harness (a superuser) switches the user triggers off just to sweep. */
const reset = () => raw(`
  alter table public.launch_partner_enrichment_runs disable trigger user;
  delete from public.launch_partner_enrichment_runs;
  alter table public.launch_partner_enrichment_runs enable trigger user;
  update public.launch_partner_campaigns set approved_version_id = null, published_version_id = null;
  alter table public.launch_partner_page_versions disable trigger user;
  delete from public.launch_partner_page_versions;
  alter table public.launch_partner_page_versions enable trigger user;
  delete from public.launch_partner_events; delete from public.launch_partner_campaigns;
  delete from public.launch_invites; delete from public.business_claims; delete from public.launch_plan_grants;
  delete from public.import_batches; delete from public.products; delete from public.book_services;
  delete from public.book_unit_items; delete from public.local_offers;
  update public.local_businesses set owner_id=null, is_claimed=false, subscription_tier='free', subscription_until=null;
  update public.local_businesses set owner_id='${BOB}', is_claimed=true where id='${PREV}';
  update public.local_businesses set owner_id='${CAROL}', is_claimed=true where id='${OTHERBIZ}';`);

const OPENING_TEXT = 'I saw your soap stall at the Voe show and loved it.';
const MARKER = 'OPENING-MARKER-9f3b71c2';
const issue = (slug = SLUG, biz = SHOP) =>
  A(`public.admin_issue_launch_invite('${slug}', '${biz}', now() + interval '30 days')::jsonb`) as { token: string };
const submit = (uid: string, tok: string, slug = SLUG) =>
  fn(uid, `public.submit_launch_partner_claim('${slug}', '${tok}', 'Esther', 'esther@example.com', null, 'Owner', 'I run it')`);
const approve = (biz: string) => {
  const id = scalar(`select id from public.business_claims where business_id='${biz}' and status='pending' limit 1`);
  assert.match(id, UUID);
  return asUser(ADMIN, `select public.approve_business_claim('${id}')`);
};
const mk = (biz = SHOP, slug = SLUG): string => {
  const out = A(`public.admin_launch_partner_create('${biz}', '${slug}')`);
  assert.match(String(out), UUID, `create failed: ${out}`);
  return out as string;
};
const upd = (id: string, patch: unknown) => A(`public.admin_launch_partner_update('${id}', ${jb(patch)})`);
const get = (id: string) => A(`public.admin_launch_partner_get('${id}')`);
const campaignRow = (id: string) => JSON.parse(scalar(`select to_jsonb(c)::text from public.launch_partner_campaigns c where id='${id}'`));
const eventKinds = (id: string) => scalar(`select coalesce(string_agg(kind, ',' order by created_at, id), '') from public.launch_partner_events where campaign_id='${id}'`);
const hashOf = (table: string) => scalar(`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.${table} t`);
const PROTECTED = ['local_businesses', 'products', 'launch_invites', 'business_claims', 'launch_plan_grants', 'book_services', 'book_unit_items', 'local_offers'];
const hashes = () => Object.fromEntries(PROTECTED.map((t) => [t, hashOf(t)]));


// ── helpers specific to this suite ──────────────────────────────────────────
const FNS = ['admin_launch_partner_directory_records(uuid[])', 'admin_launch_partner_enrichment_record(uuid, jsonb)', 'admin_launch_partner_enrichment_list(uuid)'];
const run = (over: Record<string, unknown> = {}) => ({
  status: 'applied', mode: 'first', source_url: 'https://avril.example.org/', model: 'test-model',
  pages: [{ url: 'https://avril.example.org/', status: 'ok' }], images: [{ url: 'https://avril.example.org/a.jpg', mime: 'image/jpeg' }],
  proposal: { description: 'Original paintings.' }, dropped: [{ item: 'a price', why: 'not in the page text' }], flags: ['Check the price list'],
  applied_hash: 'a'.repeat(64), ...over,
});
const rec = (id: string, r: unknown) => A(`public.admin_launch_partner_enrichment_record('${id}', ${jb(r)})`);
const list = (id: string) => A(`public.admin_launch_partner_enrichment_list('${id}')`);
const DIR = (ids: string[]) => A(`public.admin_launch_partner_directory_records(array[${ids.map((i) => `'${i}'::uuid`).join(',')}])`);
const INACTIVE = 'c6c6c6c6-ffff-4fff-8fff-c6c6c6c6c6c6';
const MARK_PAGE = 'PAGE-TEXT-MARKER-3e91-do-not-log';

// ═══ A ═════════════════════════════════════════════════════════════════════
describe('A · shape', () => {
  before(() => { reset(); raw(`insert into public.local_businesses (id, name, category, address, description, is_active, website) values ('${INACTIVE}', 'Avril Thomson Smith Art Fixture', 'retail', 'Walls, Shetland', 'Paintings', false, 'https://avril.example.org/')`); });
  test('signatures, return types, SECURITY DEFINER, pinned search_path; readers STABLE, the writer VOLATILE', () => {
    const out = rowsOf(raw(`select p.proname || '|' || pg_get_function_identity_arguments(p.oid) || '|' || pg_get_function_result(p.oid) || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|' || coalesce(array_to_string(p.proconfig, ','), '')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname in ('admin_launch_partner_directory_records','admin_launch_partner_enrichment_record','admin_launch_partner_enrichment_list') order by 1`)).filter((l) => l.includes('|'));
    assert.deepEqual(out, [
      'admin_launch_partner_directory_records|p_ids uuid[]|jsonb|true|s|search_path=public, pg_temp',
      'admin_launch_partner_enrichment_list|p_campaign_id uuid|jsonb|true|s|search_path=public, pg_temp',
      'admin_launch_partner_enrichment_record|p_campaign_id uuid, p_run jsonb|jsonb|true|v|search_path=public, pg_temp',
    ]);
  });
  test('grants: anon cannot execute; authenticated and service_role can; PUBLIC cannot', () => {
    for (const f of FNS) {
      assert.equal(scalar(`select has_function_privilege('anon', 'public.${f}', 'execute')`), 'f', f);
      assert.equal(scalar(`select has_function_privilege('authenticated', 'public.${f}', 'execute')`), 't', f);
      assert.equal(scalar(`select has_function_privilege('service_role', 'public.${f}', 'execute')`), 't', f);
    }
  });
  test('the table: RLS on, no policy, and no privilege for anon or authenticated', () => {
    assert.equal(scalar(`select relrowsecurity::text from pg_class where oid='public.launch_partner_enrichment_runs'::regclass`), 'true');
    assert.equal(scalar(`select count(*) from pg_policies where tablename='launch_partner_enrichment_runs'`), '0');
    for (const role of ['anon', 'authenticated']) for (const priv of ['select', 'insert', 'update', 'delete']) {
      assert.equal(scalar(`select has_table_privilege('${role}', 'public.launch_partner_enrichment_runs', '${priv}')`), 'f', `${role} ${priv}`);
    }
  });
  test('the migration writes only its own table, calls no network, and changes no existing function', () => {
    const text = src(FEATURE).replace(/--.*$/gm, '');
    assert.doesNotMatch(text, /pg_net|http_|net\.http|\bcurl\b/i);
    assert.doesNotMatch(text, /\b(insert\s+into|update|delete\s+from)\s+public\.(local_businesses|products|book_services|book_unit_items|local_offers|business_claims|launch_invites|launch_plan_grants|launch_partner_campaigns|launch_partner_page_versions)\b/i);
    assert.doesNotMatch(text, /create\s+or\s+replace\s+function\s+public\.(admin_launch_partner_update|admin_launch_partner_get|admin_launch_partner_create|admin_launch_partner_candidates)\b/i);
  });
  test('admin_launch_partner_update still refuses to write anything but its whitelist (an enrichment cannot be smuggled in as a column)', () => {
    reset(); const id = mk();
    for (const k of ['enrichment', 'enrichment_runs', 'sent_at', 'stage', 'business_id']) assert.ok(isErr(upd(id, { [k]: 'x' }), '22023'), k);
  });
});

// ═══ B ═════════════════════════════════════════════════════════════════════
describe('B · administrators only', () => {
  before(reset);
  test('every function refuses an ordinary user, the invited owner and a visitor; the admin is served', () => {
    const id = mk();
    const calls = (u: string | null) => [
      fn(u, `public.admin_launch_partner_directory_records(array['${SHOP}'::uuid])`),
      fn(u, `public.admin_launch_partner_enrichment_record('${id}', ${jb(run())})`),
      fn(u, `public.admin_launch_partner_enrichment_list('${id}')`),
    ];
    for (const u of [EVE, ALICE, BOB, CAROL]) for (const r of calls(u)) assert.ok(isErr(r, '42501'), `${u}: ${r}`);
    for (const r of calls(null)) assert.ok(isErr(r), `anon: ${r}`);
    assert.equal(scalar(`select count(*) from public.launch_partner_enrichment_runs`), '0', 'a refusal writes nothing');
    assert.ok(Array.isArray(DIR([SHOP])));
    assert.ok(!isErr(rec(id, run())));
    assert.ok(Array.isArray(list(id)));
  });
  test('an owner of the business cannot read its enrichment record either (it is Darren’s working note, not theirs)', () => {
    reset(); raw(`update public.local_businesses set owner_id='${ALICE}', is_claimed=true where id='${SHOP}'`);
    const id = mk(); rec(id, run());
    assert.ok(isErr(fn(ALICE, `public.admin_launch_partner_enrichment_list('${id}')`), '42501'));
  });
});

// ═══ C ═════════════════════════════════════════════════════════════════════
describe('C · the directory reader', () => {
  before(reset);
  test('an administrator can read an INACTIVE business that the table’s own policy hides from them', () => {
    const direct = rowsOf(asUser(ADMIN, `select count(*) from public.local_businesses where id='${INACTIVE}'`)).pop();
    assert.equal(direct, '0', 'precondition: the admin cannot read an inactive row directly (this is the gap)');
    const r = DIR([INACTIVE]) as any[];
    assert.equal(r.length, 1); assert.equal(r[0].name, 'Avril Thomson Smith Art Fixture'); assert.equal(r[0].website, 'https://avril.example.org/');
    assert.equal(r[0].locality, scalar(`select public.business_locality('Walls, Shetland')`), 'locality derived by business_locality');
  });
  test('it returns EXACTLY the whitelisted fields — no owner, e-mail, phone, plan or counts', () => {
    const r = (DIR([SHOP]) as any[])[0];
    assert.deepEqual(Object.keys(r).sort(), ['address', 'category', 'cover_url', 'description', 'id', 'locality', 'logo_url', 'name', 'tags', 'website']);
  });
  test('unknown ids are simply absent; an empty or oversized list is refused', () => {
    assert.deepEqual(DIR([NOPE]), []);
    assert.ok(isErr(A(`public.admin_launch_partner_directory_records(array[]::uuid[])`), '22023'));
    assert.ok(isErr(A(`public.admin_launch_partner_directory_records(null)`), '22023'));
    const many = Array.from({ length: 26 }, (_, i) => `'00000000-0000-4000-8000-${String(i).padStart(12, '0')}'::uuid`).join(',');
    assert.ok(isErr(A(`public.admin_launch_partner_directory_records(array[${many}])`), '22023'));
    assert.ok(!isErr(A(`public.admin_launch_partner_directory_records(array[${many.split(',').slice(0, 25).join(',')}])`)));
  });
});

// ═══ D ═════════════════════════════════════════════════════════════════════
describe('D · record and list', () => {
  before(reset);
  test('run numbers are sequential per campaign; list is newest first; fields round-trip', () => {
    const a = mk(SHOP, SLUG), b = mk(CAFE, 'harbour-cafe');
    assert.equal(rec(a, run({ status: 'failed', mode: 'first', error_code: 'fetch_failed', error_detail: 'The site did not answer.', applied_hash: null, proposal: {} })).run_no, 1);
    assert.equal(rec(a, run({ mode: 'retry' })).run_no, 2);
    assert.equal(rec(b, run()).run_no, 1, 'another campaign counts from 1');
    assert.equal(rec(a, run({ mode: 'regenerate', overwrote_edits: true })).run_no, 3);
    const l = list(a) as any[];
    assert.deepEqual(l.map((r) => r.run_no), [3, 2, 1]);
    assert.equal(l[2].status, 'failed'); assert.equal(l[2].error_code, 'fetch_failed'); assert.equal(l[0].overwrote_edits, true);
    assert.deepEqual(l[1].flags, ['Check the price list']); assert.equal(l[1].applied_hash, 'a'.repeat(64));
    assert.ok(!('created_by' in l[0]), 'the actor id is not handed back');
    assert.equal((list(b) as any[]).length, 1);
  });
  test('only the 10 newest are listed', () => {
    reset(); const id = mk(); for (let i = 0; i < 12; i++) rec(id, run());
    const l = list(id) as any[]; assert.equal(l.length, 10); assert.equal(l[0].run_no, 12); assert.equal(l[9].run_no, 3);
  });
  test('validation: bad status, bad mode, a non-https source, a bad hash, an unknown key, a non-object — refused, nothing written', () => {
    reset(); const id = mk();
    const bad: [unknown, string][] = [
      [run({ status: 'maybe' }), '23514'], [run({ mode: 'always' }), '23514'], [run({ source_url: 'http://insecure.example/' }), '23514'],
      [run({ applied_hash: 'xyz' }), '23514'], [run({ pages: {} }), '23514'], [run({ proposal: [] }), '23514'],
      [run({ campaign_id: id }), '22023'], [run({ created_by: ADMIN }), '22023'], [['x'], '22023'],
    ];
    for (const [r, code] of bad) assert.ok(isErr(rec(id, r), code), `${JSON.stringify(r).slice(0, 60)} → ${code}`);
    assert.equal(scalar(`select count(*) from public.launch_partner_enrichment_runs`), '0');
    assert.ok(isErr(rec(NOPE, run()), 'P0002'));
  });
  test('size ceilings hold', () => {
    reset(); const id = mk();
    assert.ok(isErr(rec(id, run({ pages: [{ t: 'x'.repeat(70_000) }] })), '23514'));
    assert.ok(isErr(rec(id, run({ proposal: { t: 'x'.repeat(140_000) } })), '23514'));
  });
  test('the audit event holds counts and the mode only — never the page text, the proposal or the pictures', () => {
    reset(); const id = mk();
    rec(id, run({ proposal: { description: MARK_PAGE }, pages: [{ url: 'https://avril.example.org/', note: MARK_PAGE }], dropped: [{ item: MARK_PAGE }] }));
    rec(id, run({ status: 'failed', applied_hash: null, error_code: 'model_failed' }));
    const ev = scalar(`select string_agg(kind || ':' || detail::text, ' | ' order by created_at, id) from public.launch_partner_events where campaign_id='${id}' and kind in ('enriched','enrichment_failed')`);
    assert.match(ev, /enriched:/); assert.match(ev, /enrichment_failed:/); assert.doesNotMatch(ev, new RegExp(MARK_PAGE)); assert.doesNotMatch(ev, /avril\.example|https?:/);
  });
  test('recording a run changes nothing on the campaign: preview, page, positioning, stage, contact, email, sent', () => {
    reset(); const id = mk(); upd(id, { positioning: 'Art', preview_config: { x: 1 }, page_config: { y: 2 }, contact_email: 'a@b.co', email_subject: 's', email_body: 'b' });
    const before = campaignRow(id); rec(id, run());
    const after = campaignRow(id); delete before.updated_at; delete after.updated_at;
    assert.deepEqual(after, before);
  });
});

// ═══ E ═════════════════════════════════════════════════════════════════════
describe('E · append-only', () => {
  test('UPDATE, DELETE and TRUNCATE are refused, even for the database owner', () => {
    reset(); const id = mk(); rec(id, run());
    assert.match(raw(`update public.launch_partner_enrichment_runs set status='failed'`), /55000/);
    assert.match(raw(`delete from public.launch_partner_enrichment_runs`), /55000/);
    assert.match(raw(`truncate public.launch_partner_enrichment_runs`), /55000/);
    assert.equal(scalar(`select count(*) from public.launch_partner_enrichment_runs`), '1');
  });
});

// ═══ F ═════════════════════════════════════════════════════════════════════
describe('F · preparing a private enrichment draft never touches the real Directory', () => {
  test('read the record, create the campaign, write the proposed draft, record the run, list it, regenerate: every protected table is byte-identical', () => {
    reset();
    raw(`
      insert into public.products (business_id, title, price_pence) values ('${SHOP}', 'Soap', 500);
      insert into public.book_services (business_id, name, duration_minutes, price_pence) values ('${SHOP}', 'Gift wrap', 30, 300);
      insert into public.book_unit_items (business_id, name, price_pence) values ('${SHOP}', 'Ten-visit pass', 4000);
      insert into public.local_offers (business_id, title, valid_until) values ('${SHOP}', 'Winter 10%', now() + interval '10 days');
      insert into public.launch_plan_grants (business_id, tier, expires_at, reason, granted_via) values ('${SHOP}', 'pro', now() + interval '30 days', 'launch partner trial', 'admin');`);
    mk(SHOP, SLUG); const tok = issue().token; assert.equal(submit(ALICE, tok).state, 'pending');   // a live invitation and a claim to protect
    const h = hashes();
    for (const t of PROTECTED) assert.notEqual(scalar(`select count(*) from public.${t}`), '0', `${t} has a row to protect`);
    DIR([SHOP, INACTIVE, CAFE]);
    const id = mk(INACTIVE, 'avril-fixture');
    upd(id, { positioning: 'Original art', preview_config: { business: { description: 'AI-proposed' }, products: [{ id: 'p1', title: 'Print', price: 20 }] }, page_config: { version: 1, hero: { tagline: 'AI-proposed' } } });
    rec(id, run()); list(id);
    upd(id, { preview_config: { business: { description: 'edited by Darren' } } });
    rec(id, run({ mode: 'regenerate', overwrote_edits: true }));
    assert.deepEqual(hashes(), h, 'the Directory, products, services, passes, offers, claims, invitations and grants never moved');
    assert.equal(scalar(`select count(*) from public.local_businesses where id='${INACTIVE}' and is_active=false`), '1', 'the inactive business is still inactive');
  });
  test('a campaign for an inactive, unclaimed business can be created without activating, claiming or granting anything', () => {
    reset(); const before = scalar(`select to_jsonb(b)::text from public.local_businesses b where id='${INACTIVE}'`);
    mk(INACTIVE, 'avril-fixture');
    assert.equal(scalar(`select to_jsonb(b)::text from public.local_businesses b where id='${INACTIVE}'`), before);
    assert.equal(scalar(`select count(*) from public.launch_invites`), '0'); assert.equal(scalar(`select count(*) from public.launch_plan_grants`), '0');
  });
});

// ═══ G ═════════════════════════════════════════════════════════════════════
describe('G · idempotent', () => {
  test('applying the migration twice is a no-op: runs, the table and the functions survive', () => {
    reset(); const id = mk(); rec(id, run());
    for (let i = 0; i < 2; i++) assert.doesNotMatch(raw(src(FEATURE)), /ERROR/i, `apply #${i + 1}`);
    assert.equal((list(id) as any[]).length, 1);
    assert.match(raw(`delete from public.launch_partner_enrichment_runs`), /55000/, 'still append-only after re-apply');
  });
});

// ═══ K ═════════════════════════════════════════════════════════════════════
describe('K · mutations', () => {
  const original = src(FEATURE);
  const mutate = (from: string, to: string) => {
    assert.ok(original.includes(from), `mutation anchor is gone: ${from.slice(0, 70)}`);
    const out = raw(original.replace(from, () => to));
    assert.doesNotMatch(out, /ERROR/i, `mutated migration did not install:\n${out.slice(0, 800)}`);
  };
  const restore = () => { const out = raw(original); assert.doesNotMatch(out, /ERROR/i, out.slice(0, 800)); };
  after(restore);

  test('M1 without the admin gate on the reader, an ordinary user could read directory records', () => {
    reset();
    assert.ok(isErr(fn(EVE, `public.admin_launch_partner_directory_records(array['${SHOP}'::uuid])`), '42501'), 'baseline');
    mutate(`  if public.launch_plan_authorised() is null then
    raise exception 'Only an administrator can read directory records for launch partners' using errcode = '42501';
  end if;
`, ``);
    try { assert.ok(Array.isArray(fn(EVE, `public.admin_launch_partner_directory_records(array['${SHOP}'::uuid])`)), 'the mutation opens the reader'); } finally { restore(); }
    assert.ok(isErr(fn(EVE, `public.admin_launch_partner_directory_records(array['${SHOP}'::uuid])`), '42501'), 'restored');
  });
  test('M2 without the 25-id ceiling, the reader would accept an unbounded list', () => {
    const many = Array.from({ length: 26 }, (_, i) => `'00000000-0000-4000-8000-${String(i).padStart(12, '0')}'::uuid`).join(',');
    assert.ok(isErr(A(`public.admin_launch_partner_directory_records(array[${many}])`), '22023'), 'baseline');
    mutate(`  if cardinality(p_ids) > 25 then
    raise exception 'At most 25 business ids at a time' using errcode = '22023';
  end if;
`, ``);
    try { assert.ok(!isErr(A(`public.admin_launch_partner_directory_records(array[${many}])`)), 'the mutation lifts the ceiling'); } finally { restore(); }
  });
  test('M3 without the append-only trigger, a recorded run could be rewritten', () => {
    reset(); const id = mk(); rec(id, run());
    assert.match(raw(`update public.launch_partner_enrichment_runs set status='failed'`), /55000/, 'baseline');
    raw(`alter table public.launch_partner_enrichment_runs disable trigger launch_partner_enrichment_no_update`);
    try { assert.doesNotMatch(raw(`update public.launch_partner_enrichment_runs set status='failed'`), /ERROR/, 'the mutation allows a rewrite'); } finally { restore(); }
  });
});
