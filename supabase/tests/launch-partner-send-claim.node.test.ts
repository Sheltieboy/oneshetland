/**
 * launch-partner-send-claim.node.test.ts — the atomic "reserve the send" step for the invitation email, against the real SQL.
 *
 * Migration 20261109000000. One new column (launch_partner_campaigns.send_claimed_at) and two admin-only functions:
 *   admin_launch_partner_claim_send(uuid)   -> jsonb   {"ok":true} | {"ok":false,"reason":"already_sent"|"not_ready"|"send_in_progress"}
 *   admin_launch_partner_release_send(uuid) -> boolean true when it cleared a reservation, false otherwise
 * A reservation older than 30 minutes is abandoned and may be re-claimed. Nothing but send_claimed_at is ever written.
 *
 *   A  the column and the two functions: shape, grants, no http, no other function changed, update whitelist untouched
 *   B  admin-only matrix for BOTH functions; unknown id P0002
 *   C  claim: one winner, a second claim is send_in_progress (sequential AND from a second connection); not_ready; already_sent
 *   D  the 30-minute window: 29 minutes still reserved, 31 minutes re-claimable
 *   E  release: clears, a new claim then succeeds, no-op once sent or when nothing is reserved
 *   F  admin_launch_partner_update cannot set send_claimed_at (or sent_at / stage)
 *   G  audit: 'send_claimed' / 'send_released' hold ids only (no recipient, no email text); a refusal writes nothing
 *   H  nothing else changes (row hashes of the protected tables, sent_at, stage); idempotent re-apply
 *   K  mutations: the sent_at check, the 30-minute window and the admin gate are each load-bearing
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
const FEATURE = join(MIG, '20261109000000_launch_partner_send_claim.sql');
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
const PROTECTED = ['local_businesses', 'products', 'launch_invites', 'business_claims', 'launch_plan_grants', 'book_services', 'book_unit_items', 'local_offers'];
const hashes = () => Object.fromEntries(PROTECTED.map((t) => [t, hashOf(t)]));

// ── helpers specific to this suite ──────────────────────────────────────────
const EMAIL_MARK = 'recipient-MARKER-7c1d@example.org';
const BODY_MARK = 'BODY-MARKER-55aa-do-not-log';
const claim = (id: string) => A(`public.admin_launch_partner_claim_send('${id}')`);
const release = (id: string) => A(`public.admin_launch_partner_release_send('${id}')`);
const set = (id: string, sql: string) => raw(`update public.launch_partner_campaigns set ${sql} where id='${id}'`);
const claimedAt = (id: string): string => scalar(`select coalesce(send_claimed_at::text, 'NULL') from public.launch_partner_campaigns where id='${id}'`);
const ageMinutes = (id: string): number => Number(scalar(`select extract(epoch from (now() - send_claimed_at)) / 60 from public.launch_partner_campaigns where id='${id}'`));
const events = (id: string, kind: string) => scalar(`select count(*) from public.launch_partner_events where campaign_id='${id}' and kind='${kind}'`);
/** A campaign with a preview, contact details and email text (carrying the markers), at ready_to_invite, with a live invitation. */
function ready(biz = SHOP, slug = SLUG): string {
  const id = mk(biz, slug);
  upd(id, { preview_config: { headline: 'Gifts from Voe' }, contact_email: EMAIL_MARK, email_subject: 'Your launch preview', email_body: BODY_MARK, email_opening: BODY_MARK });
  A(`public.admin_launch_partner_set_stage('${id}', 'ready_to_invite')`);
  issue(slug, biz);
  return id;
}
const FNS = ['admin_launch_partner_claim_send', 'admin_launch_partner_release_send'];

// ═══ A ═════════════════════════════════════════════════════════════════════
describe('A · the column and the two functions', () => {
  before(reset);
  test('send_claimed_at exists as nullable timestamptz with no default, and is null on a new and a ready campaign', () => {
    assert.equal(scalar(`select data_type || '|' || is_nullable || '|' || coalesce(column_default, 'none')
       from information_schema.columns where table_schema='public' and table_name='launch_partner_campaigns' and column_name='send_claimed_at'`), 'timestamp with time zone|YES|none');
    const id = mk();
    assert.equal(campaignRow(id).send_claimed_at, null);
    const r = ready(CAFE, 'harbour-cafe');
    assert.equal(campaignRow(r).send_claimed_at, null, 'becoming ready reserves nothing');
  });
  test('signatures, return types, SECURITY DEFINER, pinned search_path, VOLATILE', () => {
    const out = rowsOf(raw(`select p.proname || '|' || pg_get_function_identity_arguments(p.oid) || '|' || pg_get_function_result(p.oid) || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|' || coalesce(array_to_string(p.proconfig, ','), '')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname in ('admin_launch_partner_claim_send','admin_launch_partner_release_send') order by 1`)).filter((l) => l.includes('|'));
    assert.deepEqual(out, [
      'admin_launch_partner_claim_send|p_id uuid|jsonb|true|v|search_path=public, pg_temp',
      'admin_launch_partner_release_send|p_id uuid|boolean|true|v|search_path=public, pg_temp',
    ]);
  });
  test('grants: anon cannot execute; authenticated and service_role can; PUBLIC cannot', () => {
    for (const f of FNS) {
      assert.equal(scalar(`select has_function_privilege('anon', 'public.${f}(uuid)', 'execute')`), 'f');
      assert.equal(scalar(`select has_function_privilege('authenticated', 'public.${f}(uuid)', 'execute')`), 't');
      assert.equal(scalar(`select has_function_privilege('service_role', 'public.${f}(uuid)', 'execute')`), 't');
      assert.equal(scalar(`select count(*) from pg_proc p, aclexplode(p.proacl) a where p.oid='public.${f}(uuid)'::regprocedure and a.grantee = 0`), '0', 'no PUBLIC grant');
    }
  });
  test('the migration creates exactly the two functions, no policy/trigger/table writes, and never touches http or pg_net', () => {
    const text = src(FEATURE);
    const code = text.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    const created = [...code.matchAll(/create (?:or replace )?function public\.(\w+)/gi)].map((m) => m[1]).sort();
    assert.deepEqual(created, FNS);
    assert.doesNotMatch(code, /create policy|alter policy|drop policy|enable row level security|disable row level security|create trigger|create table|drop /i);
    assert.doesNotMatch(code, /(insert into|delete from)\s+public\./i);
    assert.doesNotMatch(text, /net\.http|http_post|http_get|pg_net|dblink/i, 'nowhere, not even in a comment');
    // the only table the migration updates is the campaign table, and only send_claimed_at
    const updates = [...code.matchAll(/update\s+(public\.\w+)\s+set\s+([^;]*?)\s+where/gi)].map((m) => `${m[1]}|${m[2].trim()}`);
    assert.deepEqual(updates, ['public.launch_partner_campaigns|send_claimed_at = now()', 'public.launch_partner_campaigns|send_claimed_at = null']);
  });
  test('admin_launch_partner_update / get / list / mark_sent are not redefined by this migration', () => {
    const code = src(FEATURE);
    assert.doesNotMatch(code, /function public\.admin_launch_partner_(update|get|list|mark_sent|set_stage|create)/i);
  });
  test('get and list do not expose send_claimed_at', () => {
    reset(); const id = ready(); claim(id);
    assert.ok(!('send_claimed_at' in get(id)));
    assert.ok(!JSON.stringify(A(`public.admin_launch_partner_list()`)).includes('send_claimed'));
  });
});

// ═══ B ═════════════════════════════════════════════════════════════════════
describe('B · admin-only, both functions', () => {
  test('anon, an ordinary user, a business owner and a pending claimant are refused; nothing changes', () => {
    reset(); const id = ready();
    // ALICE: pending claimant on SHOP; BOB: owner of PREV; CAROL: owner of OTHERBIZ; EVE: ordinary
    assert.equal(submit(ALICE, issue().token).state, 'pending');
    const before = scalar(`select to_jsonb(c)::text from public.launch_partner_campaigns c where id='${id}'`);
    const ev = eventKinds(id);
    for (const uid of [null, EVE, BOB, CAROL, ALICE] as const) {
      for (const f of FNS) {
        assert.match(asUser(uid, `select public.${f}('${id}')`), /permission denied|42501/, `${uid} ran ${f}`);
      }
    }
    for (const uid of [EVE, BOB, CAROL, ALICE]) {
      const c1 = fn(uid, `public.admin_launch_partner_claim_send('${id}')`);
      assert.ok(isErr(c1, '42501'), `${uid} -> ${c1}`); assert.match(c1, /Only an administrator can reserve an invitation send/);
      const r1 = fn(uid, `public.admin_launch_partner_release_send('${id}')`);
      assert.ok(isErr(r1, '42501'), `${uid} -> ${r1}`); assert.match(r1, /Only an administrator can release an invitation send/);
    }
    assert.equal(scalar(`select to_jsonb(c)::text from public.launch_partner_campaigns c where id='${id}'`), before);
    assert.equal(eventKinds(id), ev);
  });
  test('an approved owner is refused too (a business owner is not an admin)', () => {
    reset(); const id = ready();
    assert.equal(submit(ALICE, issue().token).state, 'pending');
    approve(SHOP);
    assert.equal(scalar(`select owner_id from public.local_businesses where id='${SHOP}'`), ALICE);
    assert.ok(isErr(fn(ALICE, `public.admin_launch_partner_claim_send('${id}')`), '42501'));
    assert.ok(isErr(fn(ALICE, `public.admin_launch_partner_release_send('${id}')`), '42501'));
    assert.equal(campaignRow(id).send_claimed_at, null);
  });
  test('the admin, the service role and direct SQL are allowed; the audit names who', () => {
    reset(); const id = ready();
    assert.deepEqual(claim(id), { ok: true });
    assert.equal(release(id), true);
    assert.match(rowsOf(asService(`select public.admin_launch_partner_claim_send('${id}')::text`)).pop() ?? '', /"ok": true/);
    assert.match(rowsOf(asService(`select public.admin_launch_partner_release_send('${id}')::text`)).pop() ?? '', /true/);
    assert.deepEqual(JSON.parse(scalar(`select public.admin_launch_partner_claim_send('${id}')::text`)), { ok: true });
    assert.equal(scalar(`select public.admin_launch_partner_release_send('${id}')::text`), 'true');
    assert.equal(scalar(`select string_agg(actor_label, ',' order by created_at, id) from public.launch_partner_events where kind in ('send_claimed','send_released') and campaign_id='${id}'`),
      'admin,admin,service_role,service_role,direct_sql,direct_sql');
  });
  test('an unknown id is P0002 for both functions, for an admin', () => {
    assert.ok(isErr(A(`public.admin_launch_partner_claim_send('${NOPE}')`), 'P0002'));
    assert.ok(isErr(A(`public.admin_launch_partner_release_send('${NOPE}')`), 'P0002'));
  });
  test('a non-admin asking about an unknown id learns nothing: 42501, not P0002', () => {
    assert.ok(isErr(fn(EVE, `public.admin_launch_partner_claim_send('${NOPE}')`), '42501'));
    assert.ok(isErr(fn(EVE, `public.admin_launch_partner_release_send('${NOPE}')`), '42501'));
  });
});

// ═══ C ═════════════════════════════════════════════════════════════════════
describe('C · claim', () => {
  test('the first claim wins and sets send_claimed_at; a second immediate claim is send_in_progress and does not move the timestamp', () => {
    reset(); const id = ready();
    assert.equal(claimedAt(id), 'NULL');
    assert.deepEqual(claim(id), { ok: true });
    const t = claimedAt(id); assert.notEqual(t, 'NULL');
    assert.deepEqual(claim(id), { ok: false, reason: 'send_in_progress' });
    assert.deepEqual(claim(id), { ok: false, reason: 'send_in_progress' });
    assert.equal(claimedAt(id), t, 'a refused claim does not touch the reservation');
  });
  test('two claims inside ONE transaction: the second sees the first (sequential in-transaction proof)', () => {
    reset(); const id = ready();
    const out = rowsOf(asUser(ADMIN, `select public.admin_launch_partner_claim_send('${id}')::text; select public.admin_launch_partner_claim_send('${id}')::text`));
    assert.deepEqual(out.map((l) => JSON.parse(l)), [{ ok: true }, { ok: false, reason: 'send_in_progress' }]);
  });
  test('two real connections: a second session blocks on the row lock, then sees the reservation; exactly one winner', async () => {
    reset(); const id = ready();
    const first = spawn(PSQL, [DSN, '-X', '-q', '-t', '-A', '-c',
      `begin; set local request.jwt.claim.sub = '${ADMIN}'; set local role authenticated; select public.admin_launch_partner_claim_send('${id}')::text; select pg_sleep(2.5); commit;`],
      { cwd: REPO_ROOT });
    let firstOut = ''; first.stdout.on('data', (d) => { firstOut += d; });
    const firstDone = new Promise<void>((res) => first.on('close', () => res()));
    await new Promise((r) => setTimeout(r, 1000));            // the first session now holds the row lock
    const t0 = Date.now();
    const second = A(`public.admin_launch_partner_claim_send('${id}')`);   // blocks until the first commits
    const waited = Date.now() - t0;
    await firstDone;
    assert.deepEqual(JSON.parse(firstOut.trim().split('\n')[0]), { ok: true }, 'the first session won');
    assert.deepEqual(second, { ok: false, reason: 'send_in_progress' }, 'the second session lost');
    assert.ok(waited >= 800, `the second session waited on the lock (${waited}ms)`);
    assert.equal(events(id, 'send_claimed'), '1', 'exactly one reservation was recorded');
  });
  test('N parallel connections racing: exactly one winner', async () => {
    reset(); const id = ready();
    const run = () => new Promise<string>((res) => {
      const p = spawn(PSQL, [DSN, '-X', '-q', '-t', '-A', '-c',
        `begin; set local request.jwt.claim.sub = '${ADMIN}'; set local role authenticated; select public.admin_launch_partner_claim_send('${id}')::text; commit;`], { cwd: REPO_ROOT });
      let o = ''; p.stdout.on('data', (d) => { o += d; }); p.on('close', () => res(o.trim().split('\n')[0]));
    });
    const results = (await Promise.all([run(), run(), run(), run(), run(), run()])).map((s) => JSON.parse(s));
    assert.equal(results.filter((r) => r.ok === true).length, 1, JSON.stringify(results));
    assert.equal(results.filter((r) => r.reason === 'send_in_progress').length, 5, JSON.stringify(results));
    assert.equal(events(id, 'send_claimed'), '1');
  });
  test('not_ready for candidate, preparing and archived; nothing reserved, nothing written', () => {
    reset();
    const id = mk();                                           // candidate
    const stages: Array<[string, () => void]> = [
      ['candidate', () => {}],
      ['preparing', () => A(`public.admin_launch_partner_set_stage('${id}', 'preparing')`)],
      ['archived', () => A(`public.admin_launch_partner_set_stage('${id}', 'archived')`)],
    ];
    for (const [stage, go] of stages) {
      go();
      assert.equal(campaignRow(id).stage, stage);
      const ev = eventKinds(id);
      assert.deepEqual(claim(id), { ok: false, reason: 'not_ready' }, stage);
      assert.equal(campaignRow(id).send_claimed_at, null, stage);
      assert.equal(eventKinds(id), ev, `${stage}: a refusal writes no event`);
    }
  });
  test('already_sent after mark_sent (stage is then sent); the reservation is untouched and nothing is written', () => {
    reset(); const id = ready();
    assert.deepEqual(claim(id), { ok: true });
    assert.ok(!isErr(A(`public.admin_launch_partner_mark_sent('${id}')`)));
    assert.equal(campaignRow(id).stage, 'sent');
    const ev = eventKinds(id); const t = claimedAt(id);
    assert.deepEqual(claim(id), { ok: false, reason: 'already_sent' });
    assert.equal(eventKinds(id), ev); assert.equal(claimedAt(id), t);
  });
  test('sent_at wins over everything else: already_sent even if the stage were still ready_to_invite or a reservation were live', () => {
    reset(); const id = ready();
    set(id, `sent_at = now()`);
    assert.equal(campaignRow(id).stage, 'ready_to_invite');
    assert.deepEqual(claim(id), { ok: false, reason: 'already_sent' });
    set(id, `send_claimed_at = now()`);
    assert.deepEqual(claim(id), { ok: false, reason: 'already_sent' });
  });
  test('the order of reasons: not_ready beats send_in_progress; a stale-looking reservation on a not-ready record is still not_ready', () => {
    reset(); const id = ready();
    assert.deepEqual(claim(id), { ok: true });
    A(`public.admin_launch_partner_set_stage('${id}', 'preparing')`);
    assert.deepEqual(claim(id), { ok: false, reason: 'not_ready' });
  });
  test('a claim never touches sent_at, the stage, or the invitation', () => {
    reset(); const id = ready();
    const b = campaignRow(id); const inv = hashOf('launch_invites');
    claim(id);
    const a = campaignRow(id);
    assert.equal(a.sent_at, null); assert.equal(a.stage, 'ready_to_invite');
    for (const k of Object.keys(b)) if (k !== 'send_claimed_at') assert.deepEqual(a[k], b[k], `${k} unchanged (updated_at included)`);
    assert.equal(hashOf('launch_invites'), inv);
  });
  test('mark_sent still works on a claimed campaign (the intended sequence claim -> mark_sent) and keeps working with no claim at all', () => {
    reset(); const id = ready();
    claim(id);
    A(`public.admin_launch_partner_mark_sent('${id}', 'sent via postmark')`);
    assert.equal(campaignRow(id).stage, 'sent'); assert.notEqual(campaignRow(id).sent_at, null);
    const id2 = ready(CAFE, 'harbour-cafe');
    A(`public.admin_launch_partner_mark_sent('${id2}')`);
    assert.equal(campaignRow(id2).stage, 'sent');
  });
});

// ═══ D ═════════════════════════════════════════════════════════════════════
describe('D · the 30-minute window', () => {
  test('a reservation 29 minutes old still blocks; one 31 minutes old can be re-claimed (and becomes fresh)', () => {
    reset(); const id = ready();
    claim(id);
    set(id, `send_claimed_at = now() - interval '29 minutes'`);
    assert.deepEqual(claim(id), { ok: false, reason: 'send_in_progress' });
    assert.ok(ageMinutes(id) >= 28.9 && ageMinutes(id) < 30, 'a refused claim left the 29-minute-old timestamp alone');
    set(id, `send_claimed_at = now() - interval '31 minutes'`);
    assert.deepEqual(claim(id), { ok: true });
    assert.ok(ageMinutes(id) < 1, `the re-claim reset the reservation (${ageMinutes(id)} min)`);
    assert.deepEqual(claim(id), { ok: false, reason: 'send_in_progress' }, 'and the new one blocks again');
  });
  test('the boundary: just under and just over 30 minutes', () => {
    reset(); const id = ready();
    set(id, `send_claimed_at = now() - interval '29 minutes 50 seconds'`);
    assert.deepEqual(claim(id), { ok: false, reason: 'send_in_progress' });
    set(id, `send_claimed_at = now() - interval '30 minutes 10 seconds'`);
    assert.deepEqual(claim(id), { ok: true });
  });
  test('a stale re-claim is audited as another send_claimed; a reservation in the future is treated as live', () => {
    reset(); const id = ready();
    claim(id); set(id, `send_claimed_at = now() - interval '31 minutes'`); claim(id);
    assert.equal(events(id, 'send_claimed'), '2');
    set(id, `send_claimed_at = now() + interval '5 minutes'`);
    assert.deepEqual(claim(id), { ok: false, reason: 'send_in_progress' });
  });
});

// ═══ E ═════════════════════════════════════════════════════════════════════
describe('E · release', () => {
  test('release clears a reservation (true), a new claim then succeeds', () => {
    reset(); const id = ready();
    claim(id);
    assert.deepEqual(claim(id), { ok: false, reason: 'send_in_progress' });
    assert.equal(release(id), true);
    assert.equal(campaignRow(id).send_claimed_at, null);
    assert.deepEqual(claim(id), { ok: true });
    assert.equal(campaignRow(id).stage, 'ready_to_invite'); assert.equal(campaignRow(id).sent_at, null);
  });
  test('release with nothing reserved is false and writes nothing', () => {
    reset(); const id = ready();
    const ev = eventKinds(id); const row = scalar(`select to_jsonb(c)::text from public.launch_partner_campaigns c where id='${id}'`);
    assert.equal(release(id), false);
    claim(id); assert.equal(release(id), true); assert.equal(release(id), false, 'the second release is a no-op');
    assert.equal(events(id, 'send_released'), '1');
    assert.notEqual(row, '');
    assert.equal(eventKinds(id), `${ev},send_claimed,send_released`);
  });
  test('release is a no-op (false) once sent_at is set: the reservation and the sent record stay', () => {
    reset(); const id = ready();
    claim(id); A(`public.admin_launch_partner_mark_sent('${id}')`);
    const row = scalar(`select to_jsonb(c)::text from public.launch_partner_campaigns c where id='${id}'`); const ev = eventKinds(id);
    assert.equal(release(id), false);
    assert.equal(scalar(`select to_jsonb(c)::text from public.launch_partner_campaigns c where id='${id}'`), row);
    assert.equal(eventKinds(id), ev);
    assert.notEqual(campaignRow(id).sent_at, null); assert.notEqual(campaignRow(id).send_claimed_at, null);
  });
  test('release works on a stale reservation and on a reservation of a record that has since left ready_to_invite', () => {
    reset(); const id = ready();
    claim(id); set(id, `send_claimed_at = now() - interval '2 hours'`);
    assert.equal(release(id), true);
    claim(id); A(`public.admin_launch_partner_set_stage('${id}', 'preparing')`);
    assert.equal(release(id), true);
    assert.equal(campaignRow(id).send_claimed_at, null);
  });
  test('a release changes only send_claimed_at (updated_at, stage, sent_at, everything else identical)', () => {
    reset(); const id = ready(); claim(id);
    const b = campaignRow(id); release(id); const a = campaignRow(id);
    for (const k of Object.keys(b)) if (k !== 'send_claimed_at') assert.deepEqual(a[k], b[k], k);
  });
});

// ═══ F ═════════════════════════════════════════════════════════════════════
describe('F · the update whitelist did not move', () => {
  test('admin_launch_partner_update refuses send_claimed_at (22023, naming the key), alone or beside a valid field, and applies nothing', () => {
    reset(); const id = ready();
    const row = scalar(`select to_jsonb(c)::text from public.launch_partner_campaigns c where id='${id}'`); const ev = eventKinds(id);
    for (const v of [null, '2026-01-01T00:00:00Z', 'now()']) {
      for (const patch of [{ send_claimed_at: v }, { notes: 'valid change', send_claimed_at: v }]) {
        const out = upd(id, patch);
        assert.ok(isErr(out, '22023'), String(out).slice(0, 200));
        assert.ok(out.includes('"send_claimed_at"'), `names the key: ${out}`);
      }
    }
    assert.equal(scalar(`select to_jsonb(c)::text from public.launch_partner_campaigns c where id='${id}'`), row);
    assert.equal(eventKinds(id), ev);
  });
  test('it cannot clear a live reservation either, and sent_at / stage / view_count are still refused', () => {
    reset(); const id = ready(); claim(id); const t = claimedAt(id);
    assert.ok(isErr(upd(id, { send_claimed_at: null }), '22023'));
    assert.equal(claimedAt(id), t);
    for (const k of ['sent_at', 'stage', 'view_count', 'live_at', 'setup_ready_at']) {
      const out = upd(id, { [k]: k === 'stage' ? 'sent' : '2026-01-01T00:00:00Z' });
      assert.ok(isErr(out, '22023') && out.includes(`"${k}"`), `${k}: ${out}`);
    }
    assert.equal(campaignRow(id).stage, 'ready_to_invite'); assert.equal(campaignRow(id).sent_at, null);
  });
  test('a legitimate update (even of the email text) leaves the reservation alone; set_stage does not clear it either', () => {
    reset(); const id = ready(); claim(id); const t = claimedAt(id);
    upd(id, { email_body: 'edited while a send is in flight' });
    assert.equal(claimedAt(id), t);
    A(`public.admin_launch_partner_set_stage('${id}', 'preparing')`);
    assert.equal(claimedAt(id), t, 'set_stage is not this migration\'s business');
  });
  test('there is still no direct write path for a client role', () => {
    reset(); const id = ready();
    for (const uid of [null, ALICE, ADMIN] as const) {
      assert.match(asUser(uid, `update public.launch_partner_campaigns set send_claimed_at = now() where id='${id}'`), /permission denied/);
      assert.match(asUser(uid, `select send_claimed_at from public.launch_partner_campaigns`), /permission denied/);
    }
    assert.equal(campaignRow(id).send_claimed_at, null);
  });
});

// ═══ G ═════════════════════════════════════════════════════════════════════
describe('G · audit: ids only', () => {
  test('a successful claim and a release each write exactly one event whose detail is the campaign id and nothing else', () => {
    reset(); const id = ready();
    assert.equal(eventKinds(id), 'created,updated,stage');
    claim(id); assert.equal(eventKinds(id), 'created,updated,stage,send_claimed');
    release(id); assert.equal(eventKinds(id), 'created,updated,stage,send_claimed,send_released');
    for (const kind of ['send_claimed', 'send_released']) {
      assert.deepEqual(JSON.parse(scalar(`select detail::text from public.launch_partner_events where campaign_id='${id}' and kind='${kind}'`)), { campaign_id: id }, kind);
      assert.equal(scalar(`select actor::text from public.launch_partner_events where campaign_id='${id}' and kind='${kind}'`), ADMIN);
    }
  });
  test('no event anywhere contains the recipient, the subject or any email text (markers prove it)', () => {
    reset(); const id = ready();
    assert.equal(campaignRow(id).contact_email, EMAIL_MARK); assert.equal(campaignRow(id).email_body, BODY_MARK);
    claim(id); claim(id); release(id); release(id); claim(id);
    A(`public.admin_launch_partner_mark_sent('${id}', 'sent')`);
    claim(id); release(id);
    const all = scalar(`select coalesce(string_agg(to_jsonb(e)::text, ' '), '') from public.launch_partner_events e`);
    for (const secret of [EMAIL_MARK, 'recipient-MARKER', BODY_MARK, 'BODY-MARKER', 'Your launch preview', 'Gifts from Voe', '@']) {
      assert.ok(!all.includes(secret), `an event holds ${secret}`);
    }
    assert.ok(get(id).events.every((e: any) => !JSON.stringify(e).includes('MARKER')), 'get\'s event list is clean too');
  });
  test('refusals (not_ready, send_in_progress, already_sent, 42501, P0002) write no event', () => {
    reset(); const id = ready();
    claim(id);
    const n = scalar(`select count(*) from public.launch_partner_events`);
    claim(id);                                                        // send_in_progress
    fn(EVE, `public.admin_launch_partner_claim_send('${id}')`);       // 42501
    fn(EVE, `public.admin_launch_partner_release_send('${id}')`);     // 42501
    A(`public.admin_launch_partner_claim_send('${NOPE}')`);           // P0002
    A(`public.admin_launch_partner_release_send('${NOPE}')`);         // P0002
    const id2 = mk(CAFE, 'harbour-cafe');
    claim(id2);                                                       // not_ready
    release(id2);                                                     // nothing reserved
    assert.equal(scalar(`select count(*) from public.launch_partner_events`), String(Number(n) + 1), '+1 is the created event of id2 only');
    A(`public.admin_launch_partner_mark_sent('${id}')`);
    const n2 = scalar(`select count(*) from public.launch_partner_events`);
    claim(id); release(id);                                           // already_sent / no-op
    assert.equal(scalar(`select count(*) from public.launch_partner_events`), n2);
  });
});

// ═══ H ═════════════════════════════════════════════════════════════════════
describe('H · nothing else changes; idempotent', () => {
  test('claim, refused claims, release and re-claims leave every protected table byte-identical', () => {
    reset();
    raw(`
      insert into public.products (business_id, title, price_pence) values ('${SHOP}', 'Soap', 500);
      insert into public.book_services (business_id, name, duration_minutes, price_pence) values ('${SHOP}', 'Gift wrap', 30, 300);
      insert into public.book_unit_items (business_id, name, price_pence) values ('${SHOP}', 'Ten-visit pass', 4000);
      insert into public.local_offers (business_id, title, valid_until) values ('${SHOP}', 'Winter 10%', now() + interval '10 days');
      insert into public.launch_plan_grants (business_id, tier, expires_at, reason, granted_via) values ('${SHOP}', 'pro', now() + interval '30 days', 'launch partner trial', 'admin');
      update public.local_businesses set subscription_tier='pro', subscription_until=now() + interval '30 days' where id='${SHOP}';`);
    const id = mk();
    upd(id, { preview_config: { headline: 'x' } });
    A(`public.admin_launch_partner_set_stage('${id}', 'ready_to_invite')`);
    const tok = issue().token;
    assert.equal(submit(ALICE, tok).state, 'pending');
    const h = hashes();
    for (const t of PROTECTED) assert.notEqual(scalar(`select count(*) from public.${t}`), '0', `${t} has a row to protect`);
    claim(id); claim(id); release(id); claim(id);
    set(id, `send_claimed_at = now() - interval '40 minutes'`); claim(id); release(id); release(id);
    fn(EVE, `public.admin_launch_partner_claim_send('${id}')`);
    assert.deepEqual(hashes(), h);
    A(`public.admin_launch_partner_mark_sent('${id}')`);          // the next step is the only one that moves anything
    const h2 = hashes(); claim(id); release(id);
    assert.deepEqual(hashes(), h2);
  });
  test('applying the migration twice is a no-op: reservation, data, column and function results survive', () => {
    reset(); const id = ready(); claim(id);
    const before = scalar(`select to_jsonb(c)::text from public.launch_partner_campaigns c where id='${id}'`);
    for (let i = 0; i < 2; i++) assert.doesNotMatch(raw(src(FEATURE)), /ERROR/i, `apply #${i + 1}`);
    assert.equal(scalar(`select to_jsonb(c)::text from public.launch_partner_campaigns c where id='${id}'`), before, 'the live reservation survived');
    assert.equal(scalar(`select count(*) from information_schema.columns where table_schema='public' and table_name='launch_partner_campaigns' and column_name='send_claimed_at'`), '1');
    assert.deepEqual(claim(id), { ok: false, reason: 'send_in_progress' });
    assert.equal(release(id), true);
    assert.deepEqual(claim(id), { ok: true });
    for (const f of FNS) {
      assert.equal(scalar(`select has_function_privilege('anon', 'public.${f}(uuid)', 'execute')`), 'f');
      assert.equal(scalar(`select has_function_privilege('authenticated', 'public.${f}(uuid)', 'execute')`), 't');
    }
    assert.ok(isErr(fn(EVE, `public.admin_launch_partner_claim_send('${id}')`), '42501'));
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

  test('M1 without the sent_at check, a campaign that was already sent can be reserved again', () => {
    reset(); const id = ready(); set(id, `sent_at = now()`);
    assert.deepEqual(claim(id), { ok: false, reason: 'already_sent' }, 'baseline');
    mutate(`  if c.sent_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_sent');
  end if;
`, ``);
    try {
      assert.deepEqual(claim(id), { ok: true }, 'the mutation lets a second send through');
    } finally { restore(); }
    set(id, `send_claimed_at = null`);
    assert.deepEqual(claim(id), { ok: false, reason: 'already_sent' }, 'restored');
  });

  test('M2 without the 30-minute window check, a live reservation does not block a second claim', () => {
    reset(); const id = ready(); claim(id);
    assert.deepEqual(claim(id), { ok: false, reason: 'send_in_progress' }, 'baseline');
    mutate(`  if c.send_claimed_at is not null and c.send_claimed_at > now() - interval '30 minutes' then
    return jsonb_build_object('ok', false, 'reason', 'send_in_progress');
  end if;
`, ``);
    try {
      assert.deepEqual(claim(id), { ok: true }, 'the mutation lets a double send through');
    } finally { restore(); }
    assert.deepEqual(claim(id), { ok: false, reason: 'send_in_progress' }, 'restored');
  });

  test('M3 without the admin gate, an ordinary signed-in user can reserve a send', () => {
    reset(); const id = ready();
    assert.ok(isErr(fn(EVE, `public.admin_launch_partner_claim_send('${id}')`), '42501'), 'baseline');
    mutate(`  if v_via is null then
    raise exception 'Only an administrator can reserve an invitation send' using errcode = '42501';
  end if;
`, ``);
    try {
      assert.deepEqual(fn(EVE, `public.admin_launch_partner_claim_send('${id}')`), { ok: true }, 'the mutation lets EVE in');
      assert.notEqual(campaignRow(id).send_claimed_at, null);
    } finally { restore(); }
    set(id, `send_claimed_at = null`);
    assert.ok(isErr(fn(EVE, `public.admin_launch_partner_claim_send('${id}')`), '42501'), 'restored');
    assert.equal(campaignRow(id).send_claimed_at, null);
  });
});
