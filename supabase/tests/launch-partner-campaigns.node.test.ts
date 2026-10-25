/**
 * launch-partner-campaigns.node.test.ts — the admin's launch-partner record, against the real SQL.
 *
 * Migration 20261106000000. An administrator prepares a private preview and a private Page V2 draft for ONE existing
 * listing. This proves the record is reachable only through its functions, that every admin function is admin-only,
 * and that none of it changes a listing, product, plan, grant, invitation or claim.
 *
 *   A  privacy of the tables; every admin function refuses everyone but admin / service role / direct SQL
 *   B  create: clean duplicate messages, defaults, never touches other tables
 *   C  update: whitelist only (nothing can set stage / sent_at / view_count / live_at), shape and size, round-trip
 *   D  stage: allowed and forbidden moves, ready_to_invite precondition
 *   E  mark_sent: the ONLY way to sent_at, needs a live invitation
 *   F  list / get / candidates: facts joined from existing tables, no secrets where they must not be
 *   G  record_view: token-validated, 30-minute debounce, writes nothing for an invalid token
 *   H  preview_config: served only against a valid token
 *   I  page draft access matrix
 *   J  nothing else changed (row hashes), audit trail, no outbound calls
 *   K  mutations: the admin gate, the debounce and the approved-claim test are each load-bearing
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
const FEATURE = join(MIG, '20261106000000_launch_partner_campaigns.sql');
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
const TAG = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
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
const ALICE = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';   // the invited owner
const BOB = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';     // owned PREV before any launch claim
const EVE = 'e3e3e3e3-3333-4333-8333-e3e3e3e3e3e3';     // an ordinary user
const CAROL = 'ca0a0a0a-4444-4444-8444-ca0a0a0a0a0a';   // owner of a different business
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
      ('${OTHERBIZ}', 'Carol Knitwear', 'retail', 'Whalsay', 'Knit');
    ${Array.from({ length: 17 }, (_, n) => `insert into public.local_businesses (id, name, category, address) values (gen_random_uuid(), 'Zed Filler ${n}', 'other', 'Yell');`).join('\n')}`);
  assert.doesNotMatch(seed, /ERROR/i, seed);
});

// ── fixtures ────────────────────────────────────────────────────────────────
const reset = () => raw(`
  delete from public.launch_partner_events; delete from public.launch_partner_campaigns;
  delete from public.launch_invites; delete from public.business_claims; delete from public.launch_plan_grants;
  delete from public.import_batches; delete from public.products; delete from public.book_services;
  delete from public.book_unit_items; delete from public.local_offers;
  update public.local_businesses set owner_id=null, is_claimed=false, subscription_tier='free', subscription_until=null;
  update public.local_businesses set owner_id='${BOB}', is_claimed=true where id='${PREV}';
  update public.local_businesses set owner_id='${CAROL}', is_claimed=true where id='${OTHERBIZ}';`);
const PREVIEW = { headline: 'Gifts from Voe', sections: [{ kind: 'hero', text: 'Soap, candles and more ☕' }] };
const PAGE = { blocks: [{ type: 'about', body: 'Draft only' }], theme: { accent: '#224466' } };

function mk(biz = SHOP, slug = SLUG, args = ''): string {
  const out = A(`public.admin_launch_partner_create('${biz}', '${slug}'${args})`);
  assert.match(String(out), UUID, `create failed: ${out}`);
  return out as string;
}
const withPreview = (extra = '') => `, p_preview => ${jb(PREVIEW)}${extra}`;
const issue = (slug = SLUG, biz = SHOP) =>
  A(`public.admin_issue_launch_invite('${slug}', '${biz}', now() + interval '30 days')::jsonb`) as { token: string };
const get = (id: string) => A(`public.admin_launch_partner_get('${id}')`);
const campaignRow = (id: string) => JSON.parse(scalar(`select to_jsonb(c)::text from public.launch_partner_campaigns c where id='${id}'`));
const eventKinds = (id: string) => scalar(`select coalesce(string_agg(kind, ',' order by created_at, id), '') from public.launch_partner_events where campaign_id='${id}'`);
const view = (uid: string | null, slug: string, tok: string) => fn(uid, `public.launch_invite_record_view('${slug}', '${tok}')`);
const preview = (uid: string | null, slug: string, tok: string) => fn(uid, `public.launch_invite_preview_config('${slug}', '${tok}')`);
const draft = (uid: string | null, biz: string) => fn(uid, `public.launch_partner_page_draft('${biz}')`);
const submit = (uid: string, tok: string, slug = SLUG, email = 'esther@example.com') =>
  fn(uid, `public.submit_launch_partner_claim('${slug}', '${tok}', 'Esther', '${email}', null, 'Owner', 'I run it')`);
const approve = (biz: string) => {
  const id = scalar(`select id from public.business_claims where business_id='${biz}' and status='pending' limit 1`);
  assert.match(id, UUID);
  return asUser(ADMIN, `select public.approve_business_claim('${id}')`);
};
const hashOf = (table: string) => scalar(`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.${table} t`);
const PROTECTED = ['local_businesses', 'products', 'book_services', 'book_unit_items', 'local_offers', 'launch_invites', 'business_claims', 'launch_plan_grants'];
const hashes = () => Object.fromEntries(PROTECTED.map((t) => [t, hashOf(t)]));

const ADMIN_CALLS = (id: string) => [
  `public.admin_launch_partner_candidates('voe')`,
  `public.admin_launch_partner_create('${FRESH}', 'fresh-listing')`,
  `public.admin_launch_partner_update('${id}', '{"notes":"x"}'::jsonb)`,
  `public.admin_launch_partner_set_stage('${id}', 'preparing')`,
  `public.admin_launch_partner_mark_sent('${id}')`,
  `public.admin_launch_partner_list()`,
  `public.admin_launch_partner_get('${id}')`,
];

// ═══ A ═════════════════════════════════════════════════════════════════════
describe('A · private tables, admin-only functions', () => {
  before(reset);
  test('neither table can be read or written directly by anon or authenticated', () => {
    const id = mk();
    for (const uid of [null, ALICE, ADMIN] as const) {
      for (const t of ['launch_partner_campaigns', 'launch_partner_events']) {
        assert.match(asUser(uid, `select * from public.${t}`), /permission denied/, `${uid} select ${t}`);
      }
      assert.match(asUser(uid, `insert into public.launch_partner_campaigns (business_id, slug) values ('${CAFE}', 'cafe-direct')`), /permission denied/);
      assert.match(asUser(uid, `insert into public.launch_partner_events (campaign_id, kind) values ('${id}', 'x')`), /permission denied/);
      assert.match(asUser(uid, `update public.launch_partner_campaigns set stage='sent', sent_at=now() where id='${id}'`), /permission denied/);
      assert.match(asUser(uid, `delete from public.launch_partner_campaigns`), /permission denied/);
    }
    for (const t of ['launch_partner_campaigns', 'launch_partner_events']) {
      assert.equal(scalar(`select relrowsecurity from pg_class where oid = 'public.${t}'::regclass`), 't');
      assert.equal(scalar(`select count(*) from pg_policies where schemaname='public' and tablename='${t}'`), '0', 'no policy at all');
    }
  });

  test('anon, an ordinary user, a previous owner and the invited owner are refused by EVERY admin function', () => {
    reset(); const id = mk();
    for (const uid of [null, EVE, BOB, ALICE, CAROL] as const) {
      for (const expr of ADMIN_CALLS(id)) {
        const out = asUser(uid, `select ${expr}`);
        assert.match(out, /permission denied|42501/, `${uid} ran ${expr}`);
      }
    }
    assert.equal(scalar(`select count(*) from public.launch_partner_campaigns`), '1', 'nothing was created');
    assert.equal(eventKinds(id), 'created', 'and nothing was audited');
  });

  test('an authenticated non-admin reaches the function and is refused with 42501 (the gate itself, not just the grant)', () => {
    const id = mk(CAFE, 'harbour-cafe');
    for (const expr of ADMIN_CALLS(id)) {
      const out = fn(EVE, expr);
      assert.ok(isErr(out, '42501'), `${expr} -> ${out}`);
      assert.match(out, /Only an administrator/);
    }
  });

  test('anon cannot execute any admin function or the draft reader, but can execute the two visitor functions', () => {
    const adminFns = ['admin_launch_partner_candidates(text)', 'admin_launch_partner_create(uuid,text,text,jsonb,jsonb,boolean,text)',
      'admin_launch_partner_update(uuid,jsonb)', 'admin_launch_partner_set_stage(uuid,text,text)', 'admin_launch_partner_mark_sent(uuid,text)',
      'admin_launch_partner_list()', 'admin_launch_partner_get(uuid)', 'launch_partner_page_draft(uuid)'];
    for (const f of adminFns) {
      assert.equal(scalar(`select has_function_privilege('anon', 'public.${f}', 'execute')`), 'f', `anon can run ${f}`);
      assert.equal(scalar(`select has_function_privilege('authenticated', 'public.${f}', 'execute')`), 't', `authenticated cannot run ${f}`);
    }
    for (const f of ['launch_invite_record_view(text,text)', 'launch_invite_preview_config(text,text)']) {
      assert.equal(scalar(`select has_function_privilege('anon', 'public.${f}', 'execute')`), 't');
    }
    for (const f of ['_launch_partner_event(uuid,text,jsonb,text)', '_launch_partner_summary(uuid)']) {
      for (const r of ['anon', 'authenticated']) assert.equal(scalar(`select has_function_privilege('${r}', 'public.${f}', 'execute')`), 'f', `${r} can run helper ${f}`);
    }
  });

  test('the service role, an admin session and a direct SQL session are all allowed', () => {
    reset(); const id = mk();
    assert.match(rowsOf(asService(`select public.admin_launch_partner_list()::text`)).pop() ?? '', /"slug"/);
    assert.match(rowsOf(asService(`select public.admin_launch_partner_get('${id}')::text`)).pop() ?? '', /"events"/);
    assert.match(scalar(`select public.admin_launch_partner_list()::text`), /"slug"/);
    assert.equal(A(`public.admin_launch_partner_list()`).length, 1);
    assert.equal(scalar(`select actor_label from public.launch_partner_events where campaign_id='${id}'`), 'admin');
    const svc = rowsOf(asService(`select public.admin_launch_partner_create('${CAFE}', 'cafe-by-service')::text`)).pop() ?? '';
    assert.match(svc, UUID);
    assert.equal(scalar(`select actor_label from public.launch_partner_events where campaign_id='${svc}'`), 'service_role');
    const sql = scalar(`select public.admin_launch_partner_create('${FRESH}', 'fresh-by-sql')::text`);
    assert.equal(scalar(`select actor_label from public.launch_partner_events where campaign_id='${sql}'`), 'direct_sql');
  });
});

// ═══ B ═════════════════════════════════════════════════════════════════════
describe('B · create', () => {
  before(reset);
  test('a bare create is a candidate with empty content; a preview makes it preparing; a stage can be chosen', () => {
    const id = mk();
    const r = campaignRow(id);
    assert.equal(r.stage, 'candidate'); assert.equal(r.business_id, SHOP); assert.equal(r.slug, SLUG);
    assert.deepEqual(r.preview_config, {}); assert.deepEqual(r.page_config, {});
    assert.equal(r.is_test, false); assert.equal(r.view_count, 0);
    assert.equal(r.sent_at, null); assert.equal(r.setup_ready_at, null); assert.equal(r.live_at, null);
    assert.equal(r.created_by, ADMIN);
    const id2 = mk(CAFE, 'harbour-cafe', withPreview(`, p_positioning => '  Coffee by the pier ', p_is_test => true`));
    const r2 = campaignRow(id2);
    assert.equal(r2.stage, 'preparing'); assert.equal(r2.is_test, true); assert.equal(r2.positioning, 'Coffee by the pier');
    assert.deepEqual(r2.preview_config, PREVIEW);
    const id3 = mk(FRESH, 'fresh-listing', withPreview(`, p_stage => 'ready_to_invite'`));
    assert.equal(campaignRow(id3).stage, 'ready_to_invite');
    assert.ok(isErr(A(`public.admin_launch_partner_create('${PREV}', 'prev-croft', p_stage => 'ready_to_invite')`), '22023'), 'ready needs a preview');
    assert.ok(isErr(A(`public.admin_launch_partner_create('${PREV}', 'prev-croft', p_stage => 'sent')`), '22023'));
    assert.ok(isErr(A(`public.admin_launch_partner_create('${PREV}', 'prev-croft', p_stage => 'bogus')`), '22023'));
  });
  test('a second record for the same business is refused with the clean message and 23505', () => {
    const out = A(`public.admin_launch_partner_create('${SHOP}', 'a-different-slug')`);
    assert.ok(isErr(out, '23505')); assert.match(out, /This business already has a launch-partner record/);
  });
  test('a duplicate slug is refused with its own clean message and 23505', () => {
    const out = A(`public.admin_launch_partner_create('${OTHERBIZ}', '${SLUG}')`);
    assert.ok(isErr(out, '23505')); assert.match(out, /That preview name is already used/);
    assert.equal(scalar(`select count(*) from public.launch_partner_campaigns where business_id='${OTHERBIZ}'`), '0');
  });
  test('unknown business, bad slug, bad content are refused', () => {
    assert.ok(isErr(A(`public.admin_launch_partner_create('${NOPE}', 'nowhere-slug')`), 'P0002'));
    for (const bad of ['Bad Slug', 'ab', '-lead', 'x'.repeat(70), 'UPPER']) {
      assert.ok(isErr(A(`public.admin_launch_partner_create('${PREV}', ${q(bad)})`), '22023'), bad);
    }
    assert.ok(isErr(A(`public.admin_launch_partner_create('${PREV}', 'prev-croft', p_preview => '[1]'::jsonb)`), '22023'));
    assert.ok(isErr(A(`public.admin_launch_partner_create('${PREV}', 'prev-croft', p_page => '"str"'::jsonb)`), '22023'));
    assert.ok(isErr(A(`public.admin_launch_partner_create('${PREV}', 'prev-croft', p_preview => jsonb_build_object('x', repeat('a', 262200)))`), '22023'));
    assert.ok(isErr(A(`public.admin_launch_partner_create('${PREV}', 'prev-croft', p_positioning => repeat('a', 201))`), '22023'));
    assert.equal(scalar(`select count(*) from public.launch_partner_campaigns where business_id='${PREV}'`), '0');
  });
  test('the table itself also refuses malformed content and email shape (defence in depth)', () => {
    const base = `insert into public.launch_partner_campaigns (business_id, slug`;
    assert.match(raw(`${base}, preview_config) values ('${PREV}', 'prev-croft', '[]'::jsonb)`), /violates check constraint/);
    assert.match(raw(`${base}, contact_email) values ('${PREV}', 'prev-croft', 'not-an-email')`), /violates check constraint/);
    assert.match(raw(`${base}, page_config) values ('${PREV}', 'prev-croft', jsonb_build_object('x', repeat('a', 262200)))`), /violates check constraint/);
    assert.match(raw(`${base}, stage) values ('${PREV}', 'prev-croft', 'live')`), /violates check constraint/);
    assert.match(raw(`${base}) values ('${PREV}', 'Bad Slug')`), /violates check constraint/);
  });
  test('a campaign cannot outlive its business silently: the business reference restricts deletion', () => {
    assert.match(raw(`delete from public.local_businesses where id='${SHOP}'`), /violates foreign key constraint/);
  });
});

// ═══ C ═════════════════════════════════════════════════════════════════════
describe('C · update', () => {
  let id = '';
  before(() => { reset(); id = mk(); });
  test('every field in the whitelist saves and trims; blank becomes null', () => {
    const r = A(`public.admin_launch_partner_update('${id}', ${jb({
      positioning: '  Gifts from Voe ', contact_name: ' Esther ', contact_email: ' esther@example.com ',
      email_subject: 'Your launch preview', email_body: 'Hello Esther', notes: 'phoned 5 Oct',
    })})`);
    assert.equal(r.positioning, 'Gifts from Voe'); assert.equal(r.contact_name, 'Esther');
    const row = campaignRow(id);
    assert.equal(row.contact_email, 'esther@example.com'); assert.equal(row.email_subject, 'Your launch preview');
    assert.equal(row.email_body, 'Hello Esther'); assert.equal(row.notes, 'phoned 5 Oct');
    A(`public.admin_launch_partner_update('${id}', '{"notes":"   ", "contact_name": null}'::jsonb)`);
    assert.equal(campaignRow(id).notes, null); assert.equal(campaignRow(id).contact_name, null);
  });
  test('nothing outside the whitelist can be set, and the refusal names the key and changes nothing', () => {
    const before = scalar(`select to_jsonb(c)::text from public.launch_partner_campaigns c where id='${id}'`);
    const evBefore = eventKinds(id);
    const forbidden: Record<string, unknown> = {
      stage: 'sent', sent_at: '2026-01-01T00:00:00Z', view_count: 99, live_at: '2026-01-01T00:00:00Z',
      setup_ready_at: '2026-01-01T00:00:00Z', id: NOPE, business_id: CAFE, slug: 'hijacked-slug', is_test: true,
      first_viewed_at: '2026-01-01T00:00:00Z', last_viewed_at: '2026-01-01T00:00:00Z', created_by: EVE,
      created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z', unknown_key: 1, Notes: 'x',
    };
    for (const [k, v] of Object.entries(forbidden)) {
      const out = A(`public.admin_launch_partner_update('${id}', ${jb({ notes: 'valid change', [k]: v })})`);
      assert.ok(isErr(out, '22023'), `${k}: ${out}`);
      assert.ok(out.includes(`"${k}"`), `message names ${k}: ${out}`);
    }
    assert.equal(scalar(`select to_jsonb(c)::text from public.launch_partner_campaigns c where id='${id}'`), before, 'not even the valid key was applied');
    assert.equal(eventKinds(id), evBefore);
  });
  test('shape and size are validated', () => {
    const bad: Array<[string, unknown]> = [
      ['preview_config', [1, 2]], ['preview_config', 'text'], ['preview_config', null], ['page_config', 5],
      ['positioning', 'x'.repeat(201)], ['contact_name', 'x'.repeat(201)], ['contact_email', 'nope'],
      ['contact_email', `${'a'.repeat(250)}@b.co`], ['contact_email', 'two words@b.co'], ['email_subject', 'x'.repeat(201)],
      ['email_body', 'x'.repeat(8001)], ['notes', 'x'.repeat(4001)], ['notes', 12], ['positioning', { a: 1 }],
    ];
    for (const [k, v] of bad) assert.ok(isErr(A(`public.admin_launch_partner_update('${id}', ${jb({ [k]: v })})`), '22023'), `${k} ${JSON.stringify(v).slice(0, 30)}`);
    assert.ok(isErr(A(`public.admin_launch_partner_update('${id}', jsonb_build_object('page_config', jsonb_build_object('x', repeat('a', 262200))))`), '22023'));
    assert.ok(isErr(A(`public.admin_launch_partner_update('${id}', '[1]'::jsonb)`), '22023'));
    assert.ok(isErr(A(`public.admin_launch_partner_update('${id}', null)`), '22023'));
    assert.ok(isErr(A(`public.admin_launch_partner_update('${NOPE}', '{}'::jsonb)`), 'P0002'));
    // the largest allowed values still save
    assert.ok(!isErr(A(`public.admin_launch_partner_update('${id}', jsonb_build_object('email_body', repeat('b', 8000), 'notes', repeat('n', 4000)))`)));
  });
  test('preview_config and page_config round-trip exactly through get, and the list shows only booleans', () => {
    A(`public.admin_launch_partner_update('${id}', ${jb({ preview_config: PREVIEW, page_config: PAGE })})`);
    const g = get(id);
    assert.deepEqual(g.preview_config, PREVIEW); assert.deepEqual(g.page_config, PAGE);
    assert.equal(g.has_preview, true); assert.equal(g.has_page_draft, true);
    const l = A(`public.admin_launch_partner_list()`)[0];
    assert.equal(l.has_preview, true); assert.equal(l.has_page_draft, true);
    for (const k of ['preview_config', 'page_config', 'contact_email', 'email_subject', 'email_body', 'notes']) assert.ok(!(k in l), `list leaks ${k}`);
  });
  test('an update that changes nothing writes nothing; updated_at moves only on a real change', () => {
    const t1 = campaignRow(id).updated_at; const n = eventKinds(id).split(',').length;
    A(`public.admin_launch_partner_update('${id}', ${jb({ preview_config: PREVIEW })})`);
    assert.equal(campaignRow(id).updated_at, t1); assert.equal(eventKinds(id).split(',').length, n);
    A(`public.admin_launch_partner_update('${id}', '{"notes":"another"}'::jsonb)`);
    assert.notEqual(campaignRow(id).updated_at, t1);
  });
  test('an archived record accepts only notes; a ready or sent preview cannot be emptied', () => {
    A(`public.admin_launch_partner_set_stage('${id}', 'ready_to_invite')`);
    assert.ok(isErr(A(`public.admin_launch_partner_update('${id}', '{"preview_config":{}}'::jsonb)`), '55000'));
    assert.ok(!isErr(A(`public.admin_launch_partner_update('${id}', ${jb({ preview_config: { headline: 'v2' } })})`)));
    A(`public.admin_launch_partner_set_stage('${id}', 'archived')`);
    assert.ok(isErr(A(`public.admin_launch_partner_update('${id}', '{"positioning":"x"}'::jsonb)`), '55000'));
    assert.ok(isErr(A(`public.admin_launch_partner_update('${id}', '{"page_config":{}}'::jsonb)`), '55000'));
    assert.ok(!isErr(A(`public.admin_launch_partner_update('${id}', '{"notes":"archived note"}'::jsonb)`)));
    assert.equal(campaignRow(id).notes, 'archived note');
  });
});

// ═══ D ═════════════════════════════════════════════════════════════════════
describe('D · stage', () => {
  let id = '';
  before(() => { reset(); id = mk(); });
  const setStage = (s: string, note = '') => A(`public.admin_launch_partner_set_stage('${id}', '${s}'${note ? `, ${q(note)}` : ''})`);
  test('"sent" is never settable here; unknown stages are refused', () => {
    assert.ok(isErr(setStage('sent'), '22023')); assert.match(setStage('sent'), /marked? the invitation as sent|mark the invitation as sent/);
    assert.ok(isErr(setStage('live'), '22023')); assert.ok(isErr(setStage(''), '22023'));
    assert.ok(isErr(A(`public.admin_launch_partner_set_stage('${id}', null)`), '22023'));
    assert.ok(isErr(A(`public.admin_launch_partner_set_stage('${NOPE}', 'preparing')`), 'P0002'));
    assert.equal(campaignRow(id).stage, 'candidate'); assert.equal(campaignRow(id).sent_at, null);
  });
  test('ready_to_invite needs a prepared preview', () => {
    assert.ok(isErr(setStage('ready_to_invite'), '22023'));
    assert.equal(campaignRow(id).stage, 'candidate');
    A(`public.admin_launch_partner_update('${id}', ${jb({ preview_config: PREVIEW })})`);
    assert.ok(!isErr(setStage('ready_to_invite', 'checked the copy')));
    assert.equal(campaignRow(id).stage, 'ready_to_invite');
    const ev = JSON.parse(scalar(`select detail::text from public.launch_partner_events where campaign_id='${id}' and kind='stage'`));
    assert.deepEqual(ev, { from: 'candidate', to: 'ready_to_invite', note: 'checked the copy' });
  });
  test('moving back, archiving and un-archiving work; the same stage twice is a silent no-op', () => {
    assert.ok(!isErr(setStage('preparing'))); assert.equal(campaignRow(id).stage, 'preparing');
    const n = eventKinds(id).split(',').length; setStage('preparing'); assert.equal(eventKinds(id).split(',').length, n);
    assert.ok(!isErr(setStage('archived'))); assert.equal(campaignRow(id).stage, 'archived');
    assert.ok(!isErr(setStage('candidate'))); assert.equal(campaignRow(id).stage, 'candidate');
    assert.ok(isErr(A(`public.admin_launch_partner_set_stage('${id}', 'archived', repeat('n', 501))`), '22023'));
  });
  test('once sent, the only move is to archived', () => {
    setStage('preparing'); setStage('ready_to_invite'); issue();
    assert.ok(!isErr(A(`public.admin_launch_partner_mark_sent('${id}')`)));
    for (const s of ['candidate', 'preparing', 'ready_to_invite']) assert.ok(isErr(setStage(s), '22023'), s);
    assert.equal(campaignRow(id).stage, 'sent');
    assert.ok(!isErr(setStage('archived'))); assert.equal(campaignRow(id).stage, 'archived');
    assert.notEqual(campaignRow(id).sent_at, null, 'archiving does not erase when it was sent');
  });
});

// ═══ E ═════════════════════════════════════════════════════════════════════
describe('E · mark sent', () => {
  let id = '';
  const mark = (note = '') => A(`public.admin_launch_partner_mark_sent('${id}'${note ? `, ${q(note)}` : ''})`);
  before(() => { reset(); id = mk(SHOP, SLUG, withPreview()); });
  test('sent_at has no other door: not update, not set_stage, not a direct write', () => {
    assert.ok(isErr(A(`public.admin_launch_partner_update('${id}', '{"sent_at":"2026-01-01T00:00:00Z"}'::jsonb)`), '22023'));
    assert.ok(isErr(A(`public.admin_launch_partner_set_stage('${id}', 'sent')`), '22023'));
    assert.match(asUser(ADMIN, `update public.launch_partner_campaigns set sent_at = now() where id='${id}'`), /permission denied/);
    assert.equal(campaignRow(id).sent_at, null);
  });
  test('it needs stage ready_to_invite AND a live invitation for THIS business and preview', () => {
    assert.ok(isErr(mark(), '55000'), 'preparing is not ready');
    A(`public.admin_launch_partner_set_stage('${id}', 'ready_to_invite')`);
    assert.ok(isErr(mark(), '55000')); assert.match(mark(), /invitation/);                 // no invitation at all
    const inv = issue(); raw(`select public.admin_revoke_launch_invite('${SLUG}', 'wrong person')`);
    assert.ok(isErr(mark(), '55000'), 'a revoked invitation does not count');
    issue(); raw(`update public.launch_invites set expires_at = now() - interval '1 minute' where revoked_at is null`);
    assert.ok(isErr(mark(), '55000'), 'an expired invitation does not count');
    issue(SLUG, CAFE);                                                                       // live, but for another business
    assert.ok(isErr(mark(), '55000'), 'an invitation for a different business does not count');
    assert.equal(campaignRow(id).stage, 'ready_to_invite'); assert.equal(campaignRow(id).sent_at, null);
    assert.ok(typeof inv.token === 'string');
  });
  test('with a live invitation it records the manual send and nothing else', () => {
    issue();
    assert.ok(!isErr(mark('emailed from my own account')));
    const r = campaignRow(id);
    assert.equal(r.stage, 'sent'); assert.notEqual(r.sent_at, null);
    assert.equal(r.first_viewed_at, null); assert.equal(r.view_count, 0);
    const ev = JSON.parse(scalar(`select detail::text from public.launch_partner_events where campaign_id='${id}' and kind='marked_sent'`));
    assert.deepEqual(ev, { note: 'emailed from my own account' });
    assert.ok(isErr(mark(), '55000'), 'cannot be marked twice');
    assert.equal(get(id).invitation.status, 'open');
  });
  test('archived and candidate records cannot be marked sent', () => {
    const c2 = mk(CAFE, 'harbour-cafe');
    assert.ok(isErr(A(`public.admin_launch_partner_mark_sent('${c2}')`), '55000'));
    assert.ok(isErr(A(`public.admin_launch_partner_mark_sent('${NOPE}')`), 'P0002'));
  });
});

// ═══ F ═════════════════════════════════════════════════════════════════════
describe('F · list, get, candidates', () => {
  let id = ''; let tok = '';
  before(() => {
    reset();
    raw(`
      insert into public.products (business_id, title, price_pence, is_active) values
        ('${SHOP}', 'Soap', 500, true), ('${SHOP}', 'Candle', 800, true), ('${SHOP}', 'Draft Mug', 900, false);
      insert into public.book_services (business_id, name, duration_minutes, price_pence) values ('${SHOP}', 'Gift wrap', 30, 300);
      insert into public.book_unit_items (business_id, name, price_pence) values ('${SHOP}', 'Ten-visit pass', 4000), ('${SHOP}', 'Five-visit pass', 2200);
      insert into public.local_offers (business_id, title, valid_until) values ('${SHOP}', 'Winter 10%', now() + interval '10 days');
      insert into public.import_batches (business_id, created_by, total_items) values ('${SHOP}', '${ADMIN}', 3), ('${SHOP}', '${ADMIN}', 4);
      insert into public.launch_plan_grants (business_id, tier, expires_at, reason, granted_via)
        values ('${SHOP}', 'premium', now() + interval '60 days', 'launch partner trial', 'admin');
      update public.local_businesses set subscription_tier='premium', subscription_until = now() + interval '60 days' where id='${SHOP}';`);
    id = mk(SHOP, SLUG, withPreview(`, p_positioning => 'Gifts from Voe'`));
    A(`public.admin_launch_partner_update('${id}', '{"contact_email":"owner-contact@example.net","email_body":"Dear Esther"}'::jsonb)`);
    tok = issue().token;
  });
  test('list returns scalar fields and facts joined from the existing tables', () => {
    const l = A(`public.admin_launch_partner_list()`);
    assert.equal(l.length, 1);
    const r = l[0];
    assert.equal(r.id, id); assert.equal(r.business_id, SHOP); assert.equal(r.slug, SLUG); assert.equal(r.stage, 'preparing');
    assert.equal(r.has_contact_email, true); assert.equal(r.has_email_draft, true);
    assert.equal(r.has_preview, true); assert.equal(r.has_page_draft, false);
    assert.equal(r.view_count, 0); assert.equal(r.live_at, null); assert.equal(r.setup_ready_at, null);
    assert.equal(r.business.name, 'Voe Gift Shop'); assert.equal(r.business.category, 'retail');
    assert.equal(r.business.locality, 'Voe, Shetland'); assert.equal(r.business.is_active, true);
    assert.equal(r.business.is_claimed, false); assert.equal(r.business.has_owner, false);
    assert.equal(r.tier, 'premium'); assert.equal(r.plan_live, true);
    assert.equal(r.grant.tier, 'premium');
    assert.equal(r.product_count, 3); assert.equal(r.active_product_count, 2); assert.equal(r.import_batch_count, 2);
    assert.equal(r.invitation.status, 'open'); assert.ok(r.invitation.expires_at);
    assert.equal(r.claim, null);
    assert.ok(r.last_activity);
  });
  test('the invitation and claim facts follow the real claim flow: pending, then claimed', () => {
    assert.equal(submit(ALICE, tok).state, 'pending');
    let r = A(`public.admin_launch_partner_list()`)[0];
    assert.equal(r.invitation.status, 'claim pending'); assert.equal(r.claim.status, 'pending');
    assert.equal(r.business.has_owner, false);
    approve(SHOP);
    r = A(`public.admin_launch_partner_list()`)[0];
    assert.equal(r.invitation.status, 'claimed'); assert.equal(r.claim.status, 'approved');
    assert.equal(r.business.has_owner, true); assert.equal(r.business.is_claimed, true);
    raw(`select public.admin_revoke_launch_invite('${SLUG}', 'done')`);
    assert.equal(A(`public.admin_launch_partner_list()`)[0].invitation.status, 'revoked');
    issue(); raw(`update public.launch_invites set expires_at = now() - interval '1 minute' where revoked_at is null`);
    assert.equal(A(`public.admin_launch_partner_list()`)[0].invitation.status, 'expired');
    raw(`delete from public.launch_invites`);
    assert.equal(A(`public.admin_launch_partner_list()`)[0].invitation.status, 'none');
  });
  test('a lapsed grant is not reported as active; an ordinary claim is not reported as a launch claim', () => {
    raw(`update public.launch_plan_grants set expires_at = now() - interval '1 day', starts_at = now() - interval '2 days'`);
    assert.equal(A(`public.admin_launch_partner_list()`)[0].grant, null);
    raw(`update public.business_claims set source = null, source_ref = null`);
    assert.equal(A(`public.admin_launch_partner_list()`)[0].claim, null);
  });
  test('get adds the private fields and the 50 latest events; contact_email appears nowhere else', () => {
    const g = get(id);
    assert.equal(g.contact_email, 'owner-contact@example.net'); assert.equal(g.email_body, 'Dear Esther');
    assert.deepEqual(g.preview_config, PREVIEW); assert.ok(Array.isArray(g.events)); assert.ok(g.events.length >= 2);
    assert.equal(g.events[0].kind, 'updated');
    assert.equal(g.product_count, 3);
    assert.equal(A(`public.admin_launch_partner_get('${NOPE}')`), null);
    for (let i = 0; i < 55; i++) raw(`insert into public.launch_partner_events (campaign_id, kind) values ('${id}', 'filler')`);
    assert.equal(get(id).events.length, 50);
    raw(`delete from public.launch_partner_events where kind = 'filler'`);
    const everywhere = JSON.stringify([
      A(`public.admin_launch_partner_list()`), A(`public.admin_launch_partner_candidates('voe')`),
      A(`public.admin_launch_partner_update('${id}', '{"notes":"n"}'::jsonb)`), draft(ADMIN, SHOP),
      A(`public.launch_invite_preview_config('${SLUG}', 'x')`),
    ]);
    assert.ok(!everywhere.includes('owner-contact@example.net'), 'contact_email leaked outside get');
    assert.ok(!everywhere.includes('Dear Esther'), 'the email body leaked outside get');
  });
  test('list is ordered by last activity, most recent first', () => {
    const c2 = mk(CAFE, 'harbour-cafe');
    A(`public.admin_launch_partner_update('${c2}', '{"notes":"touched"}'::jsonb)`);
    let l = A(`public.admin_launch_partner_list()`);
    assert.deepEqual(l.map((x: any) => x.slug), ['harbour-cafe', SLUG]);
    A(`public.admin_launch_partner_update('${id}', '{"notes":"touched later"}'::jsonb)`);
    l = A(`public.admin_launch_partner_list()`);
    assert.deepEqual(l.map((x: any) => x.slug), [SLUG, 'harbour-cafe']);
    assert.equal(l[1].invitation.status, 'none'); assert.equal(l[1].product_count, 0); assert.equal(l[1].tier, 'free'); assert.equal(l[1].plan_live, false);
  });
  test('candidates: by name or id, locality, owner name (no email), plans, counts and the existing-campaign flag', () => {
    const c = A(`public.admin_launch_partner_candidates('voe gift')`);
    assert.equal(c.length, 1);
    const r = c[0];
    assert.equal(r.business_id, SHOP); assert.equal(r.locality, 'Voe, Shetland'); assert.equal(r.owner_name, 'Alice Owner');
    assert.equal(r.has_owner, true); assert.equal(r.tier, 'premium'); assert.equal(r.plan_live, true); assert.equal(r.premium_live, true);
    assert.equal(r.product_count, 3); assert.equal(r.service_count, 1); assert.equal(r.offer_count, 1); assert.equal(r.pass_count, 2);
    assert.equal(r.has_campaign, true); assert.equal(r.campaign_id, id); assert.equal(r.campaign_slug, SLUG); assert.equal(r.campaign_stage, 'preparing');
    const s = JSON.stringify(c);
    for (const leak of ['esther@example.com', 'owner-contact@example.net', '@']) assert.ok(!s.includes(leak), `leaked ${leak}`);
    assert.ok(!Object.keys(r).some((k) => /email/i.test(k)));
    const fresh = A(`public.admin_launch_partner_candidates('${FRESH}')`)[0];
    assert.equal(fresh.has_campaign, false); assert.equal(fresh.campaign_id, null); assert.equal(fresh.owner_name, null);
    assert.equal(fresh.plan_live, false); assert.equal(fresh.premium_live, false); assert.equal(fresh.product_count, 0);
    assert.equal(A(`public.admin_launch_partner_candidates('${NOPE}')`).length, 0);
    assert.equal(A(`public.admin_launch_partner_candidates('zed filler')`).length, 15, 'capped at 15');
    assert.equal(A(`public.admin_launch_partner_candidates('100%')`).length, 0, 'wildcards are escaped');
    assert.ok(isErr(A(`public.admin_launch_partner_candidates('vo')`), '22023'));
    assert.ok(isErr(A(`public.admin_launch_partner_candidates('')`), '22023'));
  });
});

// ═══ G ═════════════════════════════════════════════════════════════════════
describe('G · record_view', () => {
  let id = ''; let tok = '';
  const setup = () => { reset(); id = mk(SHOP, SLUG, withPreview()); A(`public.admin_launch_partner_set_stage('${id}', 'ready_to_invite')`); tok = issue().token; };
  const snapshot = () => JSON.stringify([campaignRow(id), scalar(`select count(*) from public.launch_partner_events`), hashOf('launch_invites')]);
  before(setup);
  test('an invalid token returns false and writes nothing at all', () => {
    const s = snapshot();
    for (const t of ['x'.repeat(64), tok.slice(0, -1), `${tok}0`, tok.toUpperCase(), 'short', '']) assert.equal(view(null, SLUG, t), false, t);
    assert.equal(view(null, 'another-preview', tok), false, 'a token belongs to its own slug');
    assert.equal(view(EVE, SLUG, 'y'.repeat(64)), false);
    assert.equal(snapshot(), s);
  });
  test('the first valid view sets first_viewed_at and counts 1; a second within 30 minutes does not count', () => {
    assert.equal(view(null, SLUG, tok), true);
    let r = campaignRow(id);
    assert.equal(r.view_count, 1); assert.ok(r.first_viewed_at); assert.ok(r.last_viewed_at);
    const first = r.first_viewed_at; const last = r.last_viewed_at;
    assert.equal(view(null, SLUG, tok), false); assert.equal(view(EVE, SLUG, tok), false);
    r = campaignRow(id);
    assert.equal(r.view_count, 1); assert.equal(r.first_viewed_at, first); assert.equal(r.last_viewed_at, last);
    assert.equal(eventKinds(id).split(',').filter((k) => k === 'first_viewed').length, 1);
  });
  test('after 31 minutes the next view counts again; first_viewed_at never moves and no second event is written', () => {
    const first = campaignRow(id).first_viewed_at;
    raw(`update public.launch_partner_campaigns set last_viewed_at = now() - interval '31 minutes' where id='${id}'`);
    assert.equal(view(null, SLUG, tok), true);
    assert.equal(campaignRow(id).view_count, 2); assert.equal(campaignRow(id).first_viewed_at, first);
    raw(`update public.launch_partner_campaigns set last_viewed_at = now() - interval '29 minutes' where id='${id}'`);
    assert.equal(view(null, SLUG, tok), false); assert.equal(campaignRow(id).view_count, 2);
    assert.equal(eventKinds(id).split(',').filter((k) => k === 'first_viewed').length, 1);
  });
  test('a revoked, expired, superseded or archived invitation records nothing; so does an unknown campaign', () => {
    setup(); const old = tok;
    raw(`select public.admin_revoke_launch_invite('${SLUG}', 'x')`);
    assert.equal(view(null, SLUG, old), false);
    tok = issue().token; raw(`update public.launch_invites set expires_at = now() - interval '1 minute' where revoked_at is null`);
    assert.equal(view(null, SLUG, tok), false);
    tok = issue().token; const newer = issue().token;
    assert.equal(view(null, SLUG, tok), false, 'superseded');
    A(`public.admin_launch_partner_set_stage('${id}', 'archived')`);
    assert.equal(view(null, SLUG, newer), false, 'archived');
    assert.equal(campaignRow(id).view_count, 0); assert.equal(campaignRow(id).first_viewed_at, null);
  });
  test('a valid invitation for a slug with no campaign returns false', () => {
    reset(); const t = issue('lonely-preview', CAFE).token;
    assert.equal(view(null, 'lonely-preview', t), false);
    assert.equal(scalar(`select count(*) from public.launch_partner_events`), '0');
  });
  test('the token appears in no returned value, no event row and no campaign row; no other table changes', () => {
    setup();
    const h = hashes();
    const outs = [view(null, SLUG, tok), view(null, SLUG, tok), preview(null, SLUG, tok)];
    assert.ok(!JSON.stringify(outs).includes(tok));
    assert.equal(scalar(`select count(*) from public.launch_partner_events where to_jsonb(launch_partner_events)::text like '%${tok}%'`), '0');
    assert.equal(scalar(`select count(*) from public.launch_partner_campaigns where to_jsonb(launch_partner_campaigns)::text like '%${tok}%'`), '0');
    assert.deepEqual(hashes(), h, 'record_view only reads the invitation');
  });
});

// ═══ H ═════════════════════════════════════════════════════════════════════
describe('H · preview_config is served only against a valid token', () => {
  let id = ''; let tok = '';
  before(() => { reset(); id = mk(SHOP, SLUG, withPreview()); tok = issue().token; });
  test('a valid token (signed out or in) gets the preview and nothing else', () => {
    assert.deepEqual(preview(null, SLUG, tok), PREVIEW); assert.deepEqual(preview(EVE, SLUG, tok), PREVIEW);
    assert.ok(!JSON.stringify(preview(null, SLUG, tok)).includes('Draft only'), 'never the page draft');
  });
  test('wrong, other-slug, revoked, expired and malformed tokens all return null', () => {
    for (const t of ['x'.repeat(64), tok.slice(0, -1), `${tok}0`, 'short', '']) assert.equal(preview(null, SLUG, t), null, t);
    assert.equal(preview(null, 'another-preview', tok), null);
    raw(`update public.launch_invites set expires_at = now() - interval '1 minute'`);
    assert.equal(preview(null, SLUG, tok), null);
    const t2 = issue().token; assert.deepEqual(preview(null, SLUG, t2), PREVIEW);
    raw(`select public.admin_revoke_launch_invite('${SLUG}')`);
    assert.equal(preview(null, SLUG, t2), null);
  });
  test('an archived campaign, an empty preview, a missing campaign and an invitation for another business return null', () => {
    const t = issue().token;
    A(`public.admin_launch_partner_set_stage('${id}', 'archived')`); assert.equal(preview(null, SLUG, t), null);
    A(`public.admin_launch_partner_set_stage('${id}', 'candidate')`); assert.deepEqual(preview(null, SLUG, t), PREVIEW);
    raw(`update public.launch_partner_campaigns set preview_config = '{}'::jsonb where id='${id}'`); assert.equal(preview(null, SLUG, t), null);
    const t3 = issue('no-campaign-slug', CAFE).token; assert.equal(preview(null, 'no-campaign-slug', t3), null);
    raw(`update public.launch_partner_campaigns set preview_config = '${JSON.stringify(PREVIEW)}'::jsonb where id='${id}'`);
    const t4 = issue(SLUG, CAFE).token;
    assert.equal(preview(null, SLUG, t4), null, 'the invitation is for a different business than the campaign');
  });
});

// ═══ I ═════════════════════════════════════════════════════════════════════
describe('I · page draft access', () => {
  let tok = '';
  before(() => {
    reset(); const id = mk(SHOP, SLUG, withPreview());
    A(`public.admin_launch_partner_update('${id}', ${jb({ page_config: PAGE })})`);
    mk(PREV, 'prev-croft'); mk(OTHERBIZ, 'carol-knitwear');
    A(`public.admin_launch_partner_update('${(JSON.parse(scalar(`select to_jsonb(c)::text from public.launch_partner_campaigns c where slug='prev-croft'`))).id}', ${jb({ page_config: { secret: 'prev-draft' } })})`);
    tok = issue().token;
  });
  const D = (uid: string | null, biz = SHOP) => draft(uid, biz);
  test('anon cannot call it at all, and a random signed-in user gets NULL', () => {
    assert.match(asUser(null, `select public.launch_partner_page_draft('${SHOP}')`), /permission denied/);
    assert.equal(D(EVE), null);
    assert.equal(D(EVE, NOPE), null);
  });
  test('an owner of the business from before, with no launch claim, gets NULL', () => {
    assert.equal(D(BOB, PREV), null);
  });
  test('the owner of a DIFFERENT business gets NULL for this one', () => {
    assert.equal(D(CAROL, SHOP), null);
    assert.equal(D(CAROL, OTHERBIZ), null, 'and for their own: no launch-partner claim');
  });
  test('a pending or rejected launch-partner claimant gets NULL', () => {
    assert.equal(submit(ALICE, tok).state, 'pending');
    assert.equal(D(ALICE), null);
    raw(`update public.business_claims set status='rejected' where user_id='${ALICE}'`);
    assert.equal(D(ALICE), null);
    assert.equal(submit(ALICE, tok).state, 'pending');
    assert.equal(D(ALICE), null);
  });
  test('an approved launch-partner claimant who is the owner gets the draft — and only that draft', () => {
    approve(SHOP);
    const d = D(ALICE);
    assert.equal(d.slug, SLUG); assert.equal(d.stage, 'preparing'); assert.deepEqual(d.page_config, PAGE);
    assert.ok(UUID.test(d.campaign_id));
    assert.deepEqual(Object.keys(d).sort(), ['campaign_id', 'page_config', 'slug', 'stage']);
    assert.equal(D(ALICE, PREV), null); assert.equal(D(ALICE, OTHERBIZ), null);
  });
  test('an approved claim alone is not enough: ownership must still be theirs; an ordinary approved claim is not enough either', () => {
    raw(`update public.local_businesses set owner_id = '${EVE}' where id='${SHOP}'`);
    assert.equal(D(ALICE), null, 'no longer the owner');
    assert.equal(D(EVE), null, 'the new owner has no launch claim');
    raw(`update public.local_businesses set owner_id = '${ALICE}' where id='${SHOP}'`);
    assert.notEqual(D(ALICE), null);
    raw(`update public.business_claims set source = null, source_ref = null where user_id='${ALICE}'`);
    assert.equal(D(ALICE), null, 'an ordinary approved claim is not a launch-partner claim');
    raw(`update public.business_claims set source = 'launch_partner_invitation', source_ref = '${SLUG}' where user_id='${ALICE}'`);
  });
  test('an administrator gets the draft; a business with no campaign gives NULL to everyone', () => {
    assert.deepEqual(D(ADMIN).page_config, PAGE);
    assert.deepEqual(fn(ADMIN, `public.launch_partner_page_draft('${PREV}')`).page_config, { secret: 'prev-draft' });
    assert.equal(D(ADMIN, FRESH), null); assert.equal(D(ADMIN, NOPE), null);
    assert.match(rowsOf(asService(`select public.launch_partner_page_draft('${SHOP}')::text`)).pop() ?? '', /page_config/);
  });
  test('the draft is in no public surface: no view and no other function exposes page_config', () => {
    assert.equal(scalar(`select count(*) from pg_views where schemaname='public' and definition ilike '%launch_partner_campaigns%'`), '0');
    assert.equal(scalar(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname !~ 'launch_partner|launch_invite' and p.prosrc ilike '%launch_partner_campaigns%'`), '0');
    assert.equal(scalar(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.prosrc ~ 'page_config' and p.proname not in
       ('admin_launch_partner_update','admin_launch_partner_get','admin_launch_partner_create','launch_partner_page_draft','_launch_partner_summary')`), '0');
  });
});

// ═══ J ═════════════════════════════════════════════════════════════════════
describe('J · nothing else changes; audit; no outbound calls', () => {
  test('create + update + stage + mark_sent + record_view leave every other table byte-identical', () => {
    reset();
    raw(`
      insert into public.products (business_id, title, price_pence) values ('${SHOP}', 'Soap', 500);
      insert into public.book_services (business_id, name, duration_minutes, price_pence) values ('${SHOP}', 'Gift wrap', 30, 300);
      insert into public.launch_plan_grants (business_id, tier, expires_at, reason, granted_via) values ('${SHOP}', 'pro', now() + interval '30 days', 'launch partner trial', 'admin');
      update public.local_businesses set subscription_tier='pro', subscription_until=now() + interval '30 days' where id='${SHOP}';`);
    const tok = issue().token;
    assert.equal(submit(ALICE, tok).state, 'pending');
    const h = hashes();
    const id = mk(SHOP, SLUG, withPreview());
    A(`public.admin_launch_partner_update('${id}', ${jb({ page_config: PAGE, contact_email: 'someone@example.org', email_body: 'SECRET-BODY-TEXT', email_subject: 'SECRET-SUBJECT', notes: 'SECRET-NOTE' })})`);
    A(`public.admin_launch_partner_set_stage('${id}', 'ready_to_invite', 'looks right')`);
    A(`public.admin_launch_partner_mark_sent('${id}', 'sent by hand')`);
    assert.equal(view(null, SLUG, tok), true);
    A(`public.admin_launch_partner_list()`); A(`public.admin_launch_partner_candidates('voe')`); get(id); draft(ADMIN, SHOP); preview(null, SLUG, tok);
    assert.deepEqual(hashes(), h);
    A(`public.admin_launch_partner_set_stage('${id}', 'archived')`);
    assert.deepEqual(hashes(), h);
  });
  test('the audit trail records each action, and never an email, a token or a body', () => {
    const id = scalar(`select id from public.launch_partner_campaigns limit 1`);
    assert.equal(eventKinds(id), 'created,updated,stage,marked_sent,first_viewed,stage');
    const upd = JSON.parse(scalar(`select detail::text from public.launch_partner_events where kind='updated'`));
    assert.deepEqual([...upd.fields].sort(), ['contact_email', 'email_body', 'email_subject', 'notes', 'page_config']);
    const all = scalar(`select coalesce(string_agg(to_jsonb(e)::text, ' '), '') from public.launch_partner_events e`);
    for (const secret of ['SECRET-BODY-TEXT', 'SECRET-SUBJECT', 'SECRET-NOTE', 'someone@example.org', 'Draft only']) assert.ok(!all.includes(secret), `event holds ${secret}`);
    assert.equal(scalar(`select count(*) from public.launch_partner_events where actor_label is null`), '0');
    assert.equal(scalar(`select count(*) from public.launch_partner_events where kind='created' and actor='${ADMIN}'`), '1');
    assert.equal(scalar(`select actor_label from public.launch_partner_events where kind='first_viewed'`), 'invitation');
    assert.equal(scalar(`select actor is null from public.launch_partner_events where kind='first_viewed'`), 't');
  });
  test('deleting a campaign removes its audit rows (cascade), and the index for the audit read exists', () => {
    assert.equal(scalar(`select count(*) from pg_indexes where tablename='launch_partner_events' and indexdef ilike '%(campaign_id, created_at desc)%'`), '1');
  });
  test('no function in the migration, and none installed from it, calls out to the network', () => {
    const code = src(FEATURE).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    assert.doesNotMatch(code, /net\.http|http_post|http_get|http_request|pg_net|\bhttp\s*\(|extensions\.http|dblink|\bcopy\b[^;]*program/i);
    assert.equal(scalar(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and (p.proname like '%launch_partner%' or p.proname like 'launch_invite_%')
         and p.prosrc ~* '(net\\.http|http_post|http_get|pg_net|dblink)'`), '0');
  });
  test('every function is SECURITY DEFINER with a pinned search_path', () => {
    const out = rowsOf(raw(`select p.proname || '|' || p.prosecdef || '|' || coalesce(array_to_string(p.proconfig, ','), '')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname in ('admin_launch_partner_candidates','admin_launch_partner_create','admin_launch_partner_update',
        'admin_launch_partner_set_stage','admin_launch_partner_mark_sent','admin_launch_partner_list','admin_launch_partner_get',
        'launch_invite_record_view','launch_invite_preview_config','launch_partner_page_draft','_launch_partner_event','_launch_partner_summary')`))
      .filter((l) => l.includes('|'));
    assert.equal(out.length, 12);
    for (const l of out) { assert.match(l, /\|true\|search_path=public, pg_temp$/, l); }
  });
  test('the existing invitation functions and token lookup are untouched by this migration', () => {
    const code = src(FEATURE);
    assert.doesNotMatch(code, /create (or replace )?function public\.(_launch_invite_find|admin_issue_launch_invite|admin_revoke_launch_invite|admin_list_launch_invites|submit_launch_partner_claim|launch_invite_resolve|launch_invite_claim_state|admin_grant_launch_plan|launch_plan_authorised)/i);
    assert.doesNotMatch(code, /(insert into|update|delete from)\s+public\.(local_businesses|products|launch_invites|launch_plan_grants|business_claims)\b/i);
  });
});

// ═══ K ═════════════════════════════════════════════════════════════════════
// Each protection must be load-bearing: install the migration with it removed and watch the proof break, then put the
// real migration back.
describe('K · mutations', () => {
  const original = src(FEATURE);
  const mutate = (from: string, to: string) => {
    assert.ok(original.includes(from), `mutation anchor is gone: ${from.slice(0, 60)}`);
    const out = raw(original.replace(from, to));
    assert.doesNotMatch(out, /ERROR/i, `mutated migration did not install:\n${out.slice(0, 800)}`);
  };
  const restore = () => { const out = raw(original); assert.doesNotMatch(out, /ERROR/i, out.slice(0, 800)); };
  after(restore);

  test('M1 without the admin gate on list, an ordinary user can read every record', () => {
    reset(); mk();
    assert.ok(isErr(fn(EVE, `public.admin_launch_partner_list()`), '42501'), 'baseline: refused');
    mutate(`  if public.launch_plan_authorised() is null then
    raise exception 'Only an administrator can list launch-partner records'`, `  if false then
    raise exception 'Only an administrator can list launch-partner records'`);
    try { assert.equal(fn(EVE, `public.admin_launch_partner_list()`).length, 1, 'the mutation lets an ordinary user in'); }
    finally { restore(); }
    assert.ok(isErr(fn(EVE, `public.admin_launch_partner_list()`), '42501'), 'restored');
  });

  test('M2 without the 30-minute debounce, a refresh counts as a new view', () => {
    reset(); const id = mk(SHOP, SLUG, withPreview()); const tok = issue().token;
    assert.equal(view(null, SLUG, tok), true); assert.equal(view(null, SLUG, tok), false);
    mutate(`v_count := c.last_viewed_at is null or c.last_viewed_at < now() - interval '30 minutes';`, `v_count := true;`);
    try {
      assert.equal(view(null, SLUG, tok), true, 'the mutation counts an immediate repeat');
      assert.equal(campaignRow(id).view_count, 2);
    } finally { restore(); }
    assert.equal(view(null, SLUG, tok), false);
  });

  test('M3 without the approved-status test, a merely pending claimant is handed the draft', () => {
    reset(); const id = mk(SHOP, SLUG, withPreview()); const tok = issue().token;
    A(`public.admin_launch_partner_update('${id}', ${jb({ page_config: PAGE })})`);
    submit(ALICE, tok);
    raw(`update public.local_businesses set owner_id='${ALICE}' where id='${SHOP}'`);   // an owner by some other route
    assert.equal(draft(ALICE, SHOP), null, 'baseline: pending claimant refused');
    mutate(`and cl.source = 'launch_partner_invitation' and cl.status = 'approved');`, `and cl.source = 'launch_partner_invitation');`);
    try { assert.deepEqual(draft(ALICE, SHOP).page_config, PAGE, 'the mutation leaks the draft'); }
    finally { restore(); }
    assert.equal(draft(ALICE, SHOP), null);
  });

  test('M4 without the whitelist, an update can forge sent_at', () => {
    reset(); const id = mk();
    assert.ok(isErr(A(`public.admin_launch_partner_update('${id}', '{"sent_at":"2026-01-01T00:00:00Z"}'::jsonb)`), '22023'));
    mutate(`if k not in ('positioning', 'preview_config', 'page_config', 'contact_name', 'contact_email',
                 'email_subject', 'email_body', 'notes') then`, `if false then`);
    try {
      // with the guard gone the key is simply ignored by the field loop (no write path remains) — but the refusal is gone
      assert.ok(!isErr(A(`public.admin_launch_partner_update('${id}', '{"sent_at":"2026-01-01T00:00:00Z"}'::jsonb)`), '22023'), 'the refusal is what stops it');
    } finally { restore(); }
    assert.ok(isErr(A(`public.admin_launch_partner_update('${id}', '{"sent_at":"2026-01-01T00:00:00Z"}'::jsonb)`), '22023'));
  });
});
