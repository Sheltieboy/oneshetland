/**
 * launch-partner-email-opening.node.test.ts — the editable "personalised opening" of the outreach email, against the real SQL.
 *
 * Migration 20261108000000. One new column (launch_partner_campaigns.email_opening, null by default, <= 1000 characters)
 * and exactly one new whitelisted key on admin_launch_partner_update; admin_launch_partner_get returns it. Nothing else
 * about the record, its gate, its audit trail or any other table changes.
 *
 *   A  the column: exists, null by default, bounded at the table; the two functions carry it and no other function changed
 *   B  update: accepted, trimmed, blank -> null, bounded (22023), non-text refused, get returns it, list does not leak it
 *   C  admin-only: anon, an ordinary user, a previous owner, the invited (approved) owner and another owner are refused
 *   D  everything that was forbidden before is still forbidden, and a refusal changes nothing
 *   E  audit: the event names the field, never the opening text; one 'updated' event; updated_at moves only on a change
 *   F  regression: every previously whitelisted field still updates; an archived record still accepts notes only
 *   G  nothing else changed (row hashes of the protected tables); idempotent re-apply
 *   K  mutations: the whitelist entry and the length check are each load-bearing
 *
 * SAFETY — ISOLATED DATABASE ONLY: requires PASS_PROOF_DSN, refuses a DSN mentioning Supabase.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
const FEATURE = join(MIG, '20261108000000_launch_partner_email_opening.sql');
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
const PROTECTED = ['local_businesses', 'products', 'launch_invites', 'business_claims', 'launch_plan_grants'];
const hashes = () => Object.fromEntries(PROTECTED.map((t) => [t, hashOf(t)]));

// ═══ A ═════════════════════════════════════════════════════════════════════
describe('A · the column and the two functions', () => {
  before(reset);
  test('email_opening exists as nullable text, and is null by default', () => {
    assert.equal(scalar(`select data_type || '|' || is_nullable || '|' || coalesce(column_default, 'none')
       from information_schema.columns where table_schema='public' and table_name='launch_partner_campaigns' and column_name='email_opening'`), 'text|YES|none');
    const id = mk();
    assert.equal(campaignRow(id).email_opening, null);
    assert.ok('email_opening' in get(id), 'get returns the key even when empty');
    assert.equal(get(id).email_opening, null);
  });
  test('the table itself bounds it at 1000 characters (defence in depth)', () => {
    const id = mk(CAFE, 'harbour-cafe');
    assert.match(raw(`update public.launch_partner_campaigns set email_opening = repeat('x', 1001) where id='${id}'`), /violates check constraint/);
    assert.doesNotMatch(raw(`update public.launch_partner_campaigns set email_opening = repeat('x', 1000) where id='${id}'`), /ERROR/);
    assert.equal(scalar(`select count(*) from pg_constraint where conrelid='public.launch_partner_campaigns'::regclass and contype='c' and pg_get_constraintdef(oid) ilike '%email_opening%'`), '1');
  });
  test('get returns every previous key plus exactly email_opening; list does not carry it', () => {
    reset(); const id = mk();
    const keys = Object.keys(get(id)).sort();
    assert.ok(keys.includes('email_opening') && keys.includes('email_subject') && keys.includes('email_body') && keys.includes('versions') && keys.includes('approved_version_id'));
    const l = A(`public.admin_launch_partner_list()`)[0];
    assert.ok(!('email_opening' in l), 'the list must not carry the opening');
    upd(id, { email_opening: MARKER });
    assert.ok(!JSON.stringify(A(`public.admin_launch_partner_list()`)).includes(MARKER), 'nor its text');
  });
  test('the migration redefines only admin_launch_partner_update and admin_launch_partner_get, and changes no policy', () => {
    const code = src(FEATURE).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    const created = [...code.matchAll(/create (?:or replace )?function public\.(\w+)/gi)].map((m) => m[1]).sort();
    assert.deepEqual(created, ['admin_launch_partner_get', 'admin_launch_partner_update']);
    assert.doesNotMatch(code, /create policy|alter policy|drop policy|enable row level security|disable row level security|create trigger/i);
    assert.doesNotMatch(code, /(insert into|delete from)\s+public\./i);
    assert.doesNotMatch(code, /net\.http|http_post|http_get|pg_net|dblink/i);
  });
  test('both functions are still SECURITY DEFINER with a pinned search_path; grants are unchanged', () => {
    const out = rowsOf(raw(`select p.proname || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|' || coalesce(array_to_string(p.proconfig, ','), '')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname in ('admin_launch_partner_update','admin_launch_partner_get') order by 1`)).filter((l) => l.includes('|'));
    assert.deepEqual(out, ['admin_launch_partner_get|true|s|search_path=public, pg_temp', 'admin_launch_partner_update|true|v|search_path=public, pg_temp']);
    for (const f of ['admin_launch_partner_update(uuid,jsonb)', 'admin_launch_partner_get(uuid)']) {
      assert.equal(scalar(`select has_function_privilege('anon', 'public.${f}', 'execute')`), 'f');
      assert.equal(scalar(`select has_function_privilege('authenticated', 'public.${f}', 'execute')`), 't');
      assert.equal(scalar(`select has_function_privilege('service_role', 'public.${f}', 'execute')`), 't');
    }
  });
});

// ═══ B ═════════════════════════════════════════════════════════════════════
describe('B · update accepts email_opening', () => {
  let id = '';
  before(() => { reset(); id = mk(); });
  test('it saves, get returns it, and it is trimmed', () => {
    const r = upd(id, { email_opening: `  ${OPENING_TEXT}  ` });
    assert.equal(r.id, id);
    assert.equal(campaignRow(id).email_opening, OPENING_TEXT);
    assert.equal(get(id).email_opening, OPENING_TEXT);
    assert.equal(get(id).email_body, null, 'the body is a separate field');
  });
  test('an empty or blank string, or null, becomes null', () => {
    for (const blank of ['', '   ', null]) {
      upd(id, { email_opening: OPENING_TEXT });
      assert.equal(campaignRow(id).email_opening, OPENING_TEXT);
      upd(id, { email_opening: blank });
      assert.equal(campaignRow(id).email_opening, null, JSON.stringify(blank));
      assert.equal(get(id).email_opening, null);
    }
  });
  test('1000 characters save (counted as characters, not bytes); 1001 are refused with 22023 and change nothing', () => {
    assert.ok(!isErr(upd(id, { email_opening: 'a'.repeat(1000) })));
    assert.equal(campaignRow(id).email_opening.length, 1000);
    assert.ok(!isErr(upd(id, { email_opening: '☕'.repeat(1000) })), 'a thousand multi-byte characters are allowed');
    const before = scalar(`select to_jsonb(c)::text from public.launch_partner_campaigns c where id='${id}'`);
    const ev = eventKinds(id);
    for (const bad of ['a'.repeat(1001), '☕'.repeat(1001)]) {
      const out = upd(id, { email_opening: bad, notes: 'a valid change that must not be applied' });
      assert.ok(isErr(out, '22023'), String(out).slice(0, 200));
      assert.match(out, /email_opening is limited to 1000 characters/);
    }
    assert.equal(scalar(`select to_jsonb(c)::text from public.launch_partner_campaigns c where id='${id}'`), before);
    assert.equal(eventKinds(id), ev);
  });
  test('a value that is not text is refused (22023)', () => {
    for (const bad of [12, true, ['x'], { a: 1 }]) assert.ok(isErr(upd(id, { email_opening: bad }), '22023'), JSON.stringify(bad));
  });
  test('the opening and the other email fields are independent', () => {
    upd(id, { email_subject: 'Your launch preview', email_body: 'Hello {{PERSONALISED_OPENING}} bye', email_opening: OPENING_TEXT });
    let r = campaignRow(id);
    assert.equal(r.email_body, 'Hello {{PERSONALISED_OPENING}} bye'); assert.equal(r.email_opening, OPENING_TEXT);
    upd(id, { email_body: 'Changed body' });
    r = campaignRow(id); assert.equal(r.email_opening, OPENING_TEXT, 'untouched when the patch does not name it');
    upd(id, { email_opening: null });
    r = campaignRow(id); assert.equal(r.email_body, 'Changed body'); assert.equal(r.email_subject, 'Your launch preview');
  });
  test('the summary still reports has_email_draft from subject/body only (the opening alone is not a draft)', () => {
    reset(); const id2 = mk();
    upd(id2, { email_opening: OPENING_TEXT });
    assert.equal(get(id2).has_email_draft, false);
    upd(id2, { email_subject: 'Hi' });
    assert.equal(get(id2).has_email_draft, true);
  });
});

// ═══ C ═════════════════════════════════════════════════════════════════════
describe('C · still admin-only', () => {
  test('anon, an ordinary user, a previous owner, the approved invited owner and another owner are refused; nothing changes', () => {
    reset(); const id = mk();
    const tok = issue().token;
    assert.equal(submit(ALICE, tok).state, 'pending');
    approve(SHOP);
    assert.equal(scalar(`select owner_id from public.local_businesses where id='${SHOP}'`), ALICE, 'ALICE is now the real owner');
    const before = scalar(`select to_jsonb(c)::text from public.launch_partner_campaigns c where id='${id}'`);
    for (const uid of [null, EVE, BOB, ALICE, CAROL] as const) {
      for (const expr of [`public.admin_launch_partner_update('${id}', ${jb({ email_opening: MARKER })})`, `public.admin_launch_partner_get('${id}')`]) {
        assert.match(asUser(uid, `select ${expr}`), /permission denied|42501/, `${uid} ran ${expr}`);
      }
    }
    for (const uid of [EVE, BOB, ALICE, CAROL]) {
      const out = fn(uid, `public.admin_launch_partner_update('${id}', ${jb({ email_opening: MARKER })})`);
      assert.ok(isErr(out, '42501'), `${uid} -> ${out}`);
      assert.match(out, /Only an administrator can edit a launch-partner record/);
    }
    assert.equal(scalar(`select to_jsonb(c)::text from public.launch_partner_campaigns c where id='${id}'`), before);
  });
  test('the service role and direct SQL are allowed, and the audit names who', () => {
    reset(); const id = mk();
    assert.match(rowsOf(asService(`select public.admin_launch_partner_update('${id}', ${jb({ email_opening: 'by service' })})::text`)).pop() ?? '', /"slug"/);
    assert.equal(campaignRow(id).email_opening, 'by service');
    assert.match(scalar(`select public.admin_launch_partner_update('${id}', ${jb({ email_opening: 'by sql' })})::text`), /"slug"/);
    assert.equal(campaignRow(id).email_opening, 'by sql');
    assert.equal(scalar(`select string_agg(actor_label, ',' order by created_at, id) from public.launch_partner_events where kind='updated' and campaign_id='${id}'`), 'service_role,direct_sql');
  });
});

// ═══ D ═════════════════════════════════════════════════════════════════════
describe('D · what was forbidden is still forbidden', () => {
  test('unknown and protected keys are refused by name next to a valid email_opening, and nothing is applied', () => {
    reset(); const id = mk();
    const before = scalar(`select to_jsonb(c)::text from public.launch_partner_campaigns c where id='${id}'`);
    const ev = eventKinds(id);
    const forbidden: Record<string, unknown> = {
      stage: 'sent', sent_at: '2026-01-01T00:00:00Z', view_count: 99, live_at: '2026-01-01T00:00:00Z', setup_ready_at: '2026-01-01T00:00:00Z',
      approved_at: '2026-01-01T00:00:00Z', approved_by: EVE, approved_version_id: NOPE, published_version_id: NOPE,
      id: NOPE, business_id: CAFE, slug: 'hijacked-slug', is_test: true, first_viewed_at: '2026-01-01T00:00:00Z', last_viewed_at: '2026-01-01T00:00:00Z',
      created_by: EVE, created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z', unknown_key: 1, Email_Opening: 'x', emailOpening: 'x', email_opening2: 'x',
    };
    for (const [k, v] of Object.entries(forbidden)) {
      const out = upd(id, { email_opening: MARKER, [k]: v });
      assert.ok(isErr(out, '22023'), `${k}: ${out}`);
      assert.ok(out.includes(`"${k}"`), `message names ${k}: ${out}`);
    }
    assert.equal(scalar(`select to_jsonb(c)::text from public.launch_partner_campaigns c where id='${id}'`), before, 'not even the valid key was applied');
    assert.equal(eventKinds(id), ev);
    assert.ok(isErr(A(`public.admin_launch_partner_update('${id}', '[1]'::jsonb)`), '22023'));
    assert.ok(isErr(A(`public.admin_launch_partner_update('${id}', null)`), '22023'));
    assert.ok(isErr(A(`public.admin_launch_partner_update('${NOPE}', ${jb({ email_opening: 'x' })})`), 'P0002'));
  });
  test('there is still no direct write path to the table', () => {
    reset(); const id = mk();
    for (const uid of [null, ALICE, ADMIN] as const) {
      assert.match(asUser(uid, `update public.launch_partner_campaigns set email_opening = 'x' where id='${id}'`), /permission denied/);
      assert.match(asUser(uid, `select email_opening from public.launch_partner_campaigns`), /permission denied/);
    }
  });
});

// ═══ E ═════════════════════════════════════════════════════════════════════
describe('E · audit: field names only', () => {
  test('an update changing only email_opening bumps updated_at and writes ONE updated event naming the field, never the text', () => {
    reset(); const id = mk();
    const t0 = campaignRow(id).updated_at; assert.equal(eventKinds(id), 'created');
    upd(id, { email_opening: `${MARKER} ${OPENING_TEXT}` });
    assert.notEqual(campaignRow(id).updated_at, t0, 'updated_at moved');
    assert.equal(eventKinds(id), 'created,updated');
    const detail = JSON.parse(scalar(`select detail::text from public.launch_partner_events where kind='updated' and campaign_id='${id}'`));
    assert.deepEqual(detail.fields, ['email_opening']);
    const all = scalar(`select coalesce(string_agg(to_jsonb(e)::text, ' '), '') from public.launch_partner_events e`);
    assert.ok(!all.includes(MARKER) && !all.includes('soap stall'), 'the event holds the field name only');
    // and it appears nowhere else but the campaign row and the admin read
    assert.ok(!scalar(`select coalesce(string_agg(detail::text, ' '), '') from public.launch_partner_events`).includes(MARKER));
    assert.ok(get(id).events.every((e: any) => !JSON.stringify(e).includes(MARKER)), 'get\'s event list never shows the text');
    // a clear is audited by name too
    upd(id, { email_opening: null });
    assert.equal(eventKinds(id), 'created,updated,updated');
    const last = JSON.parse(scalar(`select detail::text from public.launch_partner_events where kind='updated' and campaign_id='${id}' order by created_at desc, id desc limit 1`));
    assert.deepEqual(last.fields, ['email_opening']);
  });
  test('an identical value writes nothing and leaves updated_at alone; a real change moves it', () => {
    reset(); const id = mk();
    upd(id, { email_opening: OPENING_TEXT });
    const t1 = campaignRow(id).updated_at; const n = eventKinds(id);
    upd(id, { email_opening: `  ${OPENING_TEXT} ` });   // trims to the same value
    assert.equal(campaignRow(id).updated_at, t1); assert.equal(eventKinds(id), n);
    upd(id, { email_opening: 'A different opening.' });
    assert.notEqual(campaignRow(id).updated_at, t1); assert.notEqual(eventKinds(id), n);
  });
  test('a mixed update lists every changed field name, including email_opening, and none of the values', () => {
    reset(); const id = mk();
    upd(id, { email_opening: MARKER, notes: 'SECRET-NOTE', email_body: 'SECRET-BODY', contact_email: 'someone@example.org' });
    const d = JSON.parse(scalar(`select detail::text from public.launch_partner_events where kind='updated' and campaign_id='${id}'`));
    assert.deepEqual([...d.fields].sort(), ['contact_email', 'email_body', 'email_opening', 'notes']);
    const all = scalar(`select coalesce(string_agg(to_jsonb(e)::text, ' '), '') from public.launch_partner_events e`);
    for (const secret of [MARKER, 'SECRET-NOTE', 'SECRET-BODY', 'someone@example.org']) assert.ok(!all.includes(secret), `event holds ${secret}`);
  });
});

// ═══ F ═════════════════════════════════════════════════════════════════════
describe('F · regression: the earlier whitelist behaves as before', () => {
  const PREVIEW = { headline: 'Gifts from Voe', sections: [{ kind: 'hero', text: 'Soap, candles and more ☕' }] };
  const PAGE = { blocks: [{ type: 'about', body: 'Draft only' }], theme: { accent: '#224466' } };
  test('every previously whitelisted field still saves, trims and round-trips; blank becomes null', () => {
    reset(); const id = mk();
    const r = upd(id, {
      positioning: '  Gifts from Voe ', contact_name: ' Esther ', contact_email: ' esther@example.com ',
      email_subject: 'Your launch preview', email_body: 'Hello Esther', notes: 'phoned 5 Oct', preview_config: PREVIEW, page_config: PAGE,
    });
    assert.equal(r.positioning, 'Gifts from Voe'); assert.equal(r.contact_name, 'Esther');
    const row = campaignRow(id);
    assert.equal(row.contact_email, 'esther@example.com'); assert.equal(row.email_subject, 'Your launch preview');
    assert.equal(row.email_body, 'Hello Esther'); assert.equal(row.notes, 'phoned 5 Oct');
    assert.deepEqual(row.preview_config, PREVIEW); assert.deepEqual(row.page_config, PAGE); assert.equal(row.email_opening, null, 'and the opening was not touched');
    const g = get(id);
    assert.deepEqual(g.preview_config, PREVIEW); assert.deepEqual(g.page_config, PAGE); assert.equal(g.contact_email, 'esther@example.com');
    assert.equal(g.email_subject, 'Your launch preview'); assert.equal(g.email_body, 'Hello Esther'); assert.equal(g.notes, 'phoned 5 Oct');
    upd(id, { notes: '   ', contact_name: null });
    assert.equal(campaignRow(id).notes, null); assert.equal(campaignRow(id).contact_name, null);
    const d = JSON.parse(scalar(`select detail::text from public.launch_partner_events where kind='updated' and campaign_id='${id}' order by created_at, id limit 1`));
    assert.deepEqual([...d.fields].sort(), ['contact_email', 'contact_name', 'email_body', 'email_subject', 'notes', 'page_config', 'positioning', 'preview_config']);
  });
  test('the previous size and shape limits still hold', () => {
    reset(); const id = mk();
    const bad: Array<[string, unknown]> = [
      ['preview_config', [1, 2]], ['page_config', 5], ['positioning', 'x'.repeat(201)], ['contact_name', 'x'.repeat(201)], ['contact_email', 'nope'],
      ['email_subject', 'x'.repeat(201)], ['email_body', 'x'.repeat(8001)], ['notes', 'x'.repeat(4001)], ['notes', 12],
    ];
    for (const [k, v] of bad) assert.ok(isErr(upd(id, { [k]: v }), '22023'), `${k} ${JSON.stringify(v).slice(0, 30)}`);
    assert.ok(!isErr(upd(id, { email_body: 'b'.repeat(8000), notes: 'n'.repeat(4000), email_subject: 's'.repeat(200) })));
  });
  test('a ready preview still cannot be emptied; an archived record still accepts only notes (email_opening included in the refusal)', () => {
    reset(); const id = mk();
    upd(id, { preview_config: PREVIEW });
    A(`public.admin_launch_partner_set_stage('${id}', 'ready_to_invite')`);
    assert.ok(isErr(upd(id, { preview_config: {} }), '55000'));
    assert.ok(!isErr(upd(id, { email_opening: OPENING_TEXT })), 'a ready record can have its opening edited');
    A(`public.admin_launch_partner_set_stage('${id}', 'archived')`);
    assert.ok(isErr(upd(id, { email_opening: 'late edit' }), '55000'));
    assert.ok(isErr(upd(id, { positioning: 'x' }), '55000'));
    assert.ok(isErr(upd(id, { page_config: {} }), '55000'));
    assert.ok(isErr(upd(id, { notes: 'n', email_opening: 'late edit' }), '55000'), 'notes + opening together is refused as a whole');
    assert.equal(campaignRow(id).email_opening, OPENING_TEXT, 'the archived opening did not move');
    assert.equal(campaignRow(id).notes, null);
    assert.ok(!isErr(upd(id, { notes: 'archived note' })));
    assert.equal(campaignRow(id).notes, 'archived note');
  });
});

// ═══ G ═════════════════════════════════════════════════════════════════════
describe('G · nothing else changes; idempotent', () => {
  test('updating email_opening (and reading it) leaves every protected table byte-identical', () => {
    reset();
    raw(`
      insert into public.products (business_id, title, price_pence) values ('${SHOP}', 'Soap', 500);
      insert into public.launch_plan_grants (business_id, tier, expires_at, reason, granted_via) values ('${SHOP}', 'pro', now() + interval '30 days', 'launch partner trial', 'admin');
      update public.local_businesses set subscription_tier='pro', subscription_until=now() + interval '30 days' where id='${SHOP}';`);
    const tok = issue().token;
    assert.equal(submit(ALICE, tok).state, 'pending');
    const h = hashes();
    for (const t of PROTECTED) assert.notEqual(scalar(`select count(*) from public.${t}`), '0', `${t} has a row to protect`);
    const id = mk();
    upd(id, { email_opening: OPENING_TEXT });
    upd(id, { email_opening: '' });
    upd(id, { email_opening: MARKER, notes: 'also a note' });
    get(id); A(`public.admin_launch_partner_list()`);
    assert.deepEqual(hashes(), h);
  });
  test('applying the migration twice is a no-op: data, column, constraint and function results survive', () => {
    reset(); const id = mk(); upd(id, { email_opening: OPENING_TEXT });
    const before = scalar(`select to_jsonb(c)::text from public.launch_partner_campaigns c where id='${id}'`);
    for (let i = 0; i < 2; i++) assert.doesNotMatch(raw(src(FEATURE)), /ERROR/i, `apply #${i + 1}`);
    assert.equal(scalar(`select to_jsonb(c)::text from public.launch_partner_campaigns c where id='${id}'`), before);
    assert.equal(scalar(`select count(*) from information_schema.columns where table_schema='public' and table_name='launch_partner_campaigns' and column_name='email_opening'`), '1');
    assert.equal(scalar(`select count(*) from pg_constraint where conrelid='public.launch_partner_campaigns'::regclass and contype='c' and pg_get_constraintdef(oid) ilike '%email_opening%'`), '1');
    assert.equal(get(id).email_opening, OPENING_TEXT);
    assert.ok(isErr(upd(id, { email_opening: 'x'.repeat(1001) }), '22023'));
    assert.equal(scalar(`select has_function_privilege('anon', 'public.admin_launch_partner_update(uuid,jsonb)', 'execute')`), 'f');
  });
});

// ═══ K ═════════════════════════════════════════════════════════════════════
// Each protection must be load-bearing: install the migration with it removed and watch the proof break, then put the
// real migration back.
describe('K · mutations', () => {
  const original = src(FEATURE);
  const mutate = (from: string, to: string) => {
    assert.ok(original.includes(from), `mutation anchor is gone: ${from.slice(0, 70)}`);
    const out = raw(original.replace(from, () => to));
    assert.doesNotMatch(out, /ERROR/i, `mutated migration did not install:\n${out.slice(0, 800)}`);
  };
  const restore = () => { const out = raw(original); assert.doesNotMatch(out, /ERROR/i, out.slice(0, 800)); };
  after(restore);

  test('M1 without email_opening in the whitelist, the opening cannot be edited at all', () => {
    reset(); const id = mk();
    assert.ok(!isErr(upd(id, { email_opening: OPENING_TEXT })), 'baseline: accepted');
    assert.equal(get(id).email_opening, OPENING_TEXT);
    mutate(`'email_subject', 'email_body', 'email_opening', 'notes') then`, `'email_subject', 'email_body', 'notes') then`);
    try {
      const out = upd(id, { email_opening: 'changed under M1' });
      assert.ok(isErr(out, '22023'), 'the mutation refuses the key');
      assert.match(out, /Field "email_opening" cannot be changed here/);
      assert.equal(campaignRow(id).email_opening, OPENING_TEXT);
    } finally { restore(); }
    assert.ok(!isErr(upd(id, { email_opening: 'changed after restore' })), 'restored');
    assert.equal(get(id).email_opening, 'changed after restore');
  });

  test('M2 without the function length check, 1001 characters lose the clean 22023 refusal (only the table constraint is left)', () => {
    reset(); const id = mk();
    const tooLong = { email_opening: 'z'.repeat(1001) };
    assert.ok(isErr(upd(id, tooLong), '22023'), 'baseline: clean refusal');
    mutate(`if char_length(coalesce(s, '')) > 1000 then raise exception 'email_opening is limited to 1000 characters' using errcode = '22023'; end if;`, ``);
    try {
      const out = upd(id, tooLong);
      assert.ok(isErr(out), 'the table constraint is the only thing still refusing it');
      assert.ok(!out.includes('22023') && /23514|check constraint/.test(out), `no clean refusal: ${String(out).slice(0, 200)}`);
      assert.equal(campaignRow(id).email_opening, null, 'and nothing was stored');
    } finally { restore(); }
    assert.ok(isErr(upd(id, tooLong), '22023'), 'restored');
    assert.match(upd(id, tooLong), /email_opening is limited to 1000 characters/);
  });
});
