/**
 * notices-structural-readiness.node.test.ts — Notices Stage 2: the notices table is structurally ready for four publishers
 * (person, hub, business, platform / official external source), proven in an ISOLATED Postgres.
 *
 * Starting state = the pre-Stage-2 production notices model: attribution-prefix-schema.sql + migration 20261121000000 (the 8 Oct attribution
 * guard) + the live geography layer, seeded with the one legacy hub notice. The REAL migration 20261128000000 is then applied.
 *
 * PROVES: the legacy notice is unchanged and still public; hub / business publishing still works exactly as before; nobody can spoof a hub,
 * a business, the platform or an official source; a person publishes only as themselves and only into review; pending / withdrawn / resolved /
 * not-yet-started / expired notices are not public; (source, source_reference) is unique and upsertable; imports must expire; shetland-wide,
 * multi-area and no-area are three different things; categories are constrained; urgent rules are not loosened; event / fundraiser notices still
 * generate; the publisher label is never "Member"; deleting an account leaves a valid notice; and the guard is load-bearing.
 *
 * SAFETY — ISOLATED DATABASE ONLY: requires PASS_PROOF_DSN, refuses a Supabase DSN. No network, no production row.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { noticePublisher } from '../../lib/notice-publisher.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rd = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const PREFIX = rd('supabase/tests/_support/attribution-prefix-schema.sql');
const ATTRIBUTION = rd('supabase/migrations/20261121000000_event_notice_attribution.sql');
const GEO1 = rd('supabase/migrations/20261127000000_canonical_geography_foundation.sql');
const GEO2 = rd('supabase/migrations/20261127010000_geography_alias_ambiguity.sql');
const MIGRATION = rd('supabase/migrations/20261128000000_notices_structural_readiness.sql');
const MIGRATION2 = rd('supabase/migrations/20261128010000_notices_read_protection.sql');
const DSN = process.env.PASS_PROOF_DSN ?? '';
const PSQL = process.env.PASS_PROOF_PSQL ?? 'psql';
if (!DSN) throw new Error('PASS_PROOF_DSN is required (isolated database only) — run via `npm run test:isolated`');
if (/supabase/i.test(DSN)) throw new Error('refusing to run against a Supabase DSN');

const run = (args: string[], input?: string) => { const r = spawnSync(PSQL, [DSN, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], { input, encoding: 'utf8', timeout: 180_000 }); return `${r.stdout ?? ''}${r.stderr ?? ''}`; };
const raw = (sql: string) => run(['-c', sql]);
const file = (sql: string) => run([], sql);
const last = (o: string) => o.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
const scalar = (sql: string) => last(raw(sql));
const failed = (o: string) => /ERROR/.test(o);

const U = {
  A: 'a0000000-0000-4000-8000-0000000000a1',   // ordinary person
  A2: 'a0000000-0000-4000-8000-0000000000a2',  // another ordinary person
  B: 'b0000000-0000-4000-8000-0000000000b1',   // owns BIZ_B (no urgent)
  V: 'c0000000-0000-4000-8000-0000000000c1',   // owns BIZ_V (urgent allowed)
  H: 'd0000000-0000-4000-8000-0000000000d1',   // owns HUB_V
  C: 'd0000000-0000-4000-8000-0000000000d2',   // committee of HUB_V
  M: 'd0000000-0000-4000-8000-0000000000d3',   // member of HUB_V
  S: 'e0000000-0000-4000-8000-0000000000e1',   // admin
};
const BIZ_B = 'bb000000-0000-4000-8000-0000000000bb', BIZ_V = 'cc000000-0000-4000-8000-0000000000cc', HUB_V = 'dd000000-0000-4000-8000-0000000000dd';
const HUB_O = 'dd000000-0000-4000-8000-0000000000d0';      // a second hub nobody in the cast controls
const CAMP_V = 'ca000000-0000-4000-8000-0000000000ca';
const EV_HUB = 'e1000000-0000-4000-8000-000000000001', EV_OTHER = 'e1000000-0000-4000-8000-000000000002';
const N_LEGACY = 'a1000000-0000-4000-8000-000000000001';

type Who = keyof typeof U | 'anon' | 'service';
const as = (who: Who, sql: string) => {
  const role = who === 'service' ? 'service_role' : who === 'anon' ? 'anon' : 'authenticated';
  const sub = who === 'anon' || who === 'service' ? '' : U[who];
  return raw(`set role ${role}; select set_config('request.jwt.claim.sub','${sub}',false); ${sql}; reset role;`);
};
const count = (who: Who, where: string) => Number(last(as(who, `select count(*) from notices where ${where}`)));
const n = (sql: string) => scalar(sql);
/** clear a person's pending notices so the 5-pending cap does not leak between tests */
const clear = (u: keyof typeof U) => file(`delete from notices where is_person_notice and publisher_user_id='${U[u]}'`);
let seq = 0;
const T = (p: string) => `${p}-${++seq}`;
/**
 * insert a notice as `who` WITHOUT RETURNING (a pending / scheduled row is not readable by its publisher any more - Stage 3A read protection);
 * returns the new id on success, the error text on failure. The legacy `.insert().select()` shape is covered in notices-read-protection.
 */
const ins = (who: Who, cols: string, vals: string) => { const id = randomUUID(); const o = as(who, `insert into notices (id, ${cols}) values ('${id}', ${vals})`); return failed(o) ? o : id; };
/** a publisher's own view through the management function (non-public rows are not readable directly any more) */
const managed = (who: Who, scope: string, id: string | null, where = 'true') => Number(last(as(who, `select count(*) from public.manage_notices('${scope}', ${id ? `'${id}'` : 'null'}) m where ${where}`)));
const idOf = (o: string) => (o.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []).pop() ?? '';
const statusOf = (id: string) => n(`select status from notices where id='${id}'`);

const ORIG_COLS = 'id, publisher_business_id, publisher_user_id, severity, title, body, locality, lat, lng, is_pinned, is_hidden, expires_at, published_at, created_at, publisher_hub_id, visibility, image_url, category, campaign_id, event_id, broadcast_at, broadcast_by';
const legacyRow = () => n(`select md5(row(${ORIG_COLS})::text) from notices where id='${N_LEGACY}'`);
let LEGACY_BEFORE = '', OTHER_BEFORE = '';

before(() => {
  let o = file(PREFIX); assert.doesNotMatch(o, /ERROR/i, `prefix failed:\n${o.slice(0, 600)}`);
  o = file(`
    grant usage on schema public to anon, authenticated, service_role;
    create function public.is_admin() returns boolean language sql stable security definer set search_path to 'public' as $$
      select exists (select 1 from public.profiles where id = auth.uid() and (role = 'admin' or is_platform_owner = true)); $$;
    alter table notices add column lat numeric, add column lng numeric; alter table profiles add column display_name text; alter table profiles add column location_area text;
    create table regions (id uuid primary key default gen_random_uuid(), slug text unique not null, name text not null, display_order int);
    create table jobs (id uuid primary key default gen_random_uuid(), title text, locality text, location text);
    create table runs (id uuid primary key default gen_random_uuid(), origin_region_id uuid references regions(id), destination_region_id uuid references regions(id));
    create table delivery_requests (id uuid primary key default gen_random_uuid(), destination_region_id uuid references regions(id), destination_address text);
    create table content_reports (id uuid primary key default gen_random_uuid(), reporter_id uuid, content_type text not null, content_id uuid not null, reason text);
    grant select on all tables in schema public to anon; grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
    insert into profiles (id, role, display_name) values ('${U.A}','customer','Ann'), ('${U.A2}','customer',null), ('${U.B}','customer','Bea'), ('${U.V}','customer','Vic'),
      ('${U.H}','customer','Hal'), ('${U.C}','customer','Cat'), ('${U.M}','customer','Meg'), ('${U.S}','admin','Staff');
    insert into local_businesses (id, owner_id, name, slug, can_publish_urgent) values ('${BIZ_B}','${U.B}','Bea Bakery','bea',false), ('${BIZ_V}','${U.V}','Vic Garage','vic',true);
    alter table hubs disable trigger tg_zz_lock_hub_columns;
    insert into hubs (id, owner_id, name, slug, is_verified, payout_enabled) values ('${HUB_V}','${U.H}','Voe Hall','voe',true,true), ('${HUB_O}','${U.S}','Other Hub','other',false,false);
    alter table hubs enable trigger tg_zz_lock_hub_columns;
    insert into hub_members (hub_id, user_id, role) values ('${HUB_V}','${U.C}','committee'), ('${HUB_V}','${U.M}','member');
    insert into hub_campaigns (id, hub_id, title) values ('${CAMP_V}','${HUB_V}','Roof fund');
    insert into events (id, title, starts_at, status, organiser_hub_id) values ('${EV_HUB}','Hub night', now()+interval '3 day','published','${HUB_V}'), ('${EV_OTHER}','Other night', now()+interval '3 day','published','${HUB_O}');
    insert into notices (id, publisher_hub_id, severity, title, body, visibility, published_at, created_at)
      values ('${N_LEGACY}','${HUB_V}','info','OneShetland is getting ready to launch','Legacy body','public','2026-10-04 11:20:42+00','2026-10-04 11:20:42+00');`);
  assert.doesNotMatch(o, /ERROR/i, `seed failed:\n${o.slice(0, 600)}`);
  for (const [name, m] of [['attribution', ATTRIBUTION], ['geo1', GEO1], ['geo2', GEO2]] as const) {
    o = file(m); assert.doesNotMatch(o, /ERROR/i, `${name} migration failed:\n${o.slice(0, 800)}`);
  }
  LEGACY_BEFORE = legacyRow();
  OTHER_BEFORE = n(`select md5(coalesce(string_agg(md5(to_jsonb(x)::text), ',' order by md5(to_jsonb(x)::text)),'')) from (select * from hubs) x`)
    + n(`select md5(coalesce(string_agg(md5(to_jsonb(x)::text), ',' order by md5(to_jsonb(x)::text)),'')) from (select * from local_businesses) x`);
  o = file(MIGRATION); assert.doesNotMatch(o, /ERROR/i, `notices migration failed:\n${o.slice(0, 800)}`);
  o = file(MIGRATION2); assert.doesNotMatch(o, /ERROR/i, `read-protection migration failed:\n${o.slice(0, 800)}`);
});

describe('the live notice and existing publishers are untouched', () => {
  test('1 the legacy notice is byte-identical in every original column, still published, still public', () => {
    assert.equal(legacyRow(), LEGACY_BEFORE);
    assert.equal(statusOf(N_LEGACY), 'published');
    assert.equal(count('anon', `id='${N_LEGACY}'`), 1);
    assert.equal(n(`select (updated_at = created_at)::text from notices where id='${N_LEGACY}'`), 'true');
  });
  test('2 hubs and businesses are untouched, and a hub can still be created', () => {
    const now = n(`select md5(coalesce(string_agg(md5(to_jsonb(x)::text), ',' order by md5(to_jsonb(x)::text)),'')) from (select * from hubs) x`)
      + n(`select md5(coalesce(string_agg(md5(to_jsonb(x)::text), ',' order by md5(to_jsonb(x)::text)),'')) from (select * from local_businesses) x`);
    assert.equal(now, OTHER_BEFORE);
    const o = as('A', `insert into hubs (owner_id, name, slug) values ('${U.A}','A hub','a-hub') returning id`);
    assert.ok(!failed(o), o);
  });
  test('3 hub owner and committee publish exactly as before (immediate, status published); a plain member cannot', () => {
    const h = ins('H', 'publisher_hub_id, title', `'${HUB_V}','${T('hub')}'`); assert.ok(!failed(h), h);
    assert.equal(statusOf(idOf(h)), 'published');
    const c = ins('C', 'publisher_hub_id, title', `'${HUB_V}','${T('cmte')}'`); assert.ok(!failed(c), c);
    assert.ok(failed(ins('M', 'publisher_hub_id, title', `'${HUB_V}','${T('mem')}'`)));
    const forced = ins('H', 'publisher_hub_id, title, status', `'${HUB_V}','${T('hubp')}','pending'`);
    assert.equal(statusOf(idOf(forced)), 'published', 'an old/new client cannot park a hub notice in review - behaviour unchanged');
  });
  test('4 business owner publishes for their own business only', () => {
    const o = ins('B', 'publisher_business_id, title', `'${BIZ_B}','${T('biz')}'`); assert.ok(!failed(o), o);
    assert.equal(statusOf(idOf(o)), 'published');
    assert.ok(failed(ins('B', 'publisher_business_id, title', `'${BIZ_V}','${T('x')}'`)), 'not their business');
    assert.ok(failed(ins('H', 'publisher_business_id, title', `'${BIZ_B}','${T('x')}'`)), 'a hub owner is not the business owner');
  });
});

describe('spoofing is rejected', () => {
  test('5 a stranger cannot publish as a hub', () => assert.ok(failed(ins('A', 'publisher_hub_id, title', `'${HUB_V}','${T('s')}'`))));
  test('6 a stranger cannot publish as a business', () => assert.ok(failed(ins('A', 'publisher_business_id, title', `'${BIZ_V}','${T('s')}'`))));
  test('7 nobody but staff can publish as the platform or carry an official source', () => {
    for (const who of ['A', 'H', 'V', 'anon'] as Who[]) {
      assert.ok(failed(ins(who, 'is_platform_notice, title, source, source_reference, source_label, expires_at', `true,'${T('p')}','nhs','1','NHS Shetland', now()+interval '1 day'`)), `${who} platform+source`);
      assert.ok(failed(ins(who, 'is_platform_notice, title', `true,'${T('p')}'`)), `${who} platform`);
    }
    assert.ok(failed(ins('A', 'is_person_notice, title, source, source_reference, source_label, expires_at', `true,'${T('p')}','nhs','1','NHS Shetland', now()+interval '1 day'`)), 'person with a source');
    assert.ok(failed(ins('H', 'publisher_hub_id, title, source_label', `'${HUB_V}','${T('h')}','NHS Shetland'`)), 'hub with a source label');
    const up = as('H', `update notices set source_label='Shetland Islands Council' where id='${N_LEGACY}'`);
    assert.ok(failed(up), 'editing a source label on an existing notice');
  });
  test('8 a hub or business notice cannot be re-pointed, turned platform/person, or pinned/hidden/broadcast', () => {
    const id = idOf(ins('H', 'publisher_hub_id, title', `'${HUB_V}','${T('h')}'`));
    for (const set of [`publisher_hub_id='${HUB_O}'`, `is_platform_notice=true, publisher_hub_id=null`, `is_person_notice=true, publisher_hub_id=null`, `is_pinned=true`, `is_hidden=true`, `broadcast_at=now()`]) {
      assert.ok(failed(as('H', `update notices set ${set} where id='${id}'`)), set);
    }
  });
});

describe('person publisher', () => {
  const person = (who: Who, extra = '') => ins(who, 'is_person_notice, title' + (extra ? ', ' + extra.split('|')[0] : ''), `true,'${T('person')}'` + (extra ? ', ' + extra.split('|')[1] : ''));
  test('9 a person publishes under their own identity only, always pending', () => {
    const o = person('A', `publisher_user_id|'${U.B}'`);
    assert.ok(!failed(o), o);
    assert.equal(n(`select publisher_user_id from notices where id='${idOf(o)}'`), U.A, 'author is server-stamped');
    assert.equal(statusOf(idOf(o)), 'pending');
    const claimed = person('A', `status|'published'`);
    assert.equal(statusOf(idOf(claimed)), 'pending', 'cannot self-publish');
    assert.ok(failed(ins('anon', 'is_person_notice, title', `true,'${T('anon')}'`)), 'anonymous cannot post');
  });
  test('10 a person cannot name a hub/business, be urgent, be members-only or link events', () => {
    assert.ok(failed(ins('A', 'is_person_notice, publisher_hub_id, title', `true,'${HUB_V}','${T('x')}'`)));
    assert.ok(failed(ins('A', 'is_person_notice, severity, title', `true,'urgent','${T('x')}'`)), 'urgent');
    assert.ok(failed(ins('A', 'is_person_notice, visibility, title', `true,'members','${T('x')}'`)));
    assert.ok(failed(ins('A', 'is_person_notice, event_id, title', `true,'${EV_HUB}','${T('x')}'`)));
  });
  test('11 pending notices are not public; the author and staff see them; other people do not', () => {
    clear('A');
    const id = idOf(person('A'));
    assert.equal(count('anon', `id='${id}'`), 0);
    assert.equal(count('A', `id='${id}'`), 0, 'not even the author reads it directly (Stage 3A): it would surface in feeds of released builds');
    assert.equal(count('A2', `id='${id}'`), 0);
    assert.equal(count('H', `id='${id}'`), 0);
    assert.equal(count('S', `id='${id}'`), 0, 'staff use the management function');
    assert.equal(managed('A', 'mine', null, `m.id='${id}'`), 1, 'the author still manages it');
    assert.equal(managed('S', 'all', null, `m.id='${id}'`), 1, 'staff still review it');
    assert.equal(managed('A2', 'mine', null, `m.id='${id}'`), 0);
    assert.equal(managed('H', 'hub', HUB_V, `m.id='${id}'`), 0);
  });
  test('12 only staff approve; the author can withdraw; an approved edit returns to review; the cap is 5 pending', () => {
    const id = idOf(person('A2'));
    assert.equal(last(as('A2', `with u as (update notices set status='published' where id='${id}' returning 1) select count(*) from u`)) === '1' ? 'self-approved' : 'blocked', 'blocked');
    assert.equal(statusOf(id), 'pending');
    assert.equal(last(as('S', `select public.manage_set_notice_status('${id}','published')`)), 'published');
    assert.equal(count('anon', `id='${id}'`), 1, 'staff approval makes it public');
    assert.ok(failed(as('A2', `update notices set title='edited after approval' where id='${id}'`)), 'Stage 3A: the edit would send it back to review (non-public), which a direct UPDATE is refused; the guard rule itself still holds for the service role');
    assert.equal(n(`select title from notices where id='${id}'`) !== 'edited after approval', true, 'approved content cannot be changed behind the moderators');
    assert.equal(statusOf(id), 'published');
    file(`update notices set title='edited by service' where id='${id}'`);
    as('A2', `select public.manage_set_notice_status('${id}','withdrawn')`);
    assert.equal(statusOf(id), 'withdrawn');
    assert.equal(count('anon', `id='${id}'`), 0);
    assert.equal(n(`select (withdrawn_at is not null)::text from notices where id='${id}'`), 'true');
    clear('M');
    for (let i = 0; i < 5; i++) assert.ok(!failed(person('M')), 'within cap');
    assert.ok(failed(person('M')), 'the 6th pending notice is refused');
    assert.equal(n(`select count(*) from notices where is_person_notice and status='pending' and publisher_user_id='${U.M}'`), '5');
    clear('M');
  });
  test('13 another person cannot edit or delete the notice', () => {
    const id = idOf(person('A'));
    assert.equal(last(as('A2', `with u as (update notices set title='hijack' where id='${id}' returning 1) select count(*) from u`)), '0');
    assert.equal(last(as('A2', `with d as (delete from notices where id='${id}' returning 1) select count(*) from d`)), '0');
    assert.equal(last(as('H', `with d as (delete from notices where id='${id}' returning 1) select count(*) from d`)), '0');
  });
  test('14 account deletion leaves a valid notice labelled "Former member"', () => {
    const id = idOf(person('A2'));
    as('S', `select public.manage_set_notice_status('${id}','published')`);
    file(`delete from profiles where id='${U.A2}'`);
    assert.equal(n(`select publisher_user_id is null from notices where id='${id}'`), 't');
    assert.equal(n(`select (public.notice_publisher_display('${id}')->>'label')`), 'Former member');
    assert.equal(count('anon', `id='${id}'`), 1);
    file(`insert into profiles (id, role) values ('${U.A2}','customer')`);
  });
});

describe('platform, official source and de-duplication', () => {
  const imp = (ref: string, extra = '') => as('service', `insert into notices (is_platform_notice, title, source, source_reference, source_url, source_label, source_published_at, source_verified_at, expires_at${extra ? ', ' + extra.split('|')[0] : ''})
    values (true,'Ferry delayed','nhs_shetland','${ref}','https://example.org/${ref}','NHS Shetland', now()-interval '1 hour', now(), now()+interval '7 day'${extra ? ', ' + extra.split('|')[1] : ''}) returning id`);
  test('15 staff publish platform notices directly; display is "OneShetland", never "Member"', () => {
    const o = ins('S', 'is_platform_notice, title', `true,'${T('plat')}'`); assert.ok(!failed(o), o);
    assert.equal(statusOf(idOf(o)), 'published');
    assert.equal(n(`select public.notice_publisher_display('${idOf(o)}')->>'label'`), 'OneShetland');
  });
  test('16 the trusted importer (service role) stores source fields; official source is attributed, OneShetland is not the author', () => {
    const o = imp(T('r')); assert.ok(!failed(o), o);
    const d = JSON.parse(n(`select public.notice_publisher_display('${idOf(o)}')::text`));
    assert.equal(d.label, 'NHS Shetland'); assert.equal(d.byline, 'Source: NHS Shetland'); assert.equal(d.is_official_source, true);
    assert.equal(n(`select (source_published_at is not null and source_verified_at is not null and source_url is not null)::text from notices where id='${idOf(o)}'`), 'true');
  });
  test('17 (source, source_reference) is unique; an upsert updates without duplicating; reference-less rows are not constrained', () => {
    const ref = T('dup');
    assert.ok(!failed(imp(ref)));
    assert.ok(failed(imp(ref)), 'duplicate rejected');
    const up = as('service', `insert into notices (is_platform_notice, title, source, source_reference, source_label, expires_at)
      values (true,'Ferry delayed - updated','nhs_shetland','${ref}','NHS Shetland', now()+interval '9 day')
      on conflict (source, source_reference) where source is not null and source_reference is not null do update set title=excluded.title, expires_at=excluded.expires_at, source_verified_at=now()`);
    assert.ok(!failed(up), up);
    assert.equal(n(`select count(*) from notices where source='nhs_shetland' and source_reference='${ref}'`), '1');
    assert.equal(n(`select title from notices where source_reference='${ref}'`), 'Ferry delayed - updated');
    assert.ok(!failed(ins('S', 'is_platform_notice, title', `true,'a'`)) && !failed(ins('S', 'is_platform_notice, title', `true,'a'`)));
  });
  test('18 an import must expire, must be a platform notice, must carry a label and a reference', () => {
    assert.ok(failed(as('service', `insert into notices (is_platform_notice, title, source, source_reference, source_label) values (true,'x','nhs','${T('e')}','NHS Shetland')`)), 'no expiry');
    assert.ok(failed(as('service', `insert into notices (publisher_hub_id, title, source, source_reference, source_label, expires_at) values ('${HUB_V}','x','nhs','${T('e')}','NHS Shetland', now()+interval '1 day')`)), 'hub + source');
    assert.ok(failed(as('service', `insert into notices (is_platform_notice, title, source, source_reference, expires_at) values (true,'x','nhs','${T('e')}', now()+interval '1 day')`)), 'no label');
    assert.ok(failed(as('service', `insert into notices (is_platform_notice, title, source_url) values (true,'x','https://x')`)), 'source fields without a source');
    assert.ok(failed(as('service', `insert into notices (is_platform_notice, title, starts_at, expires_at) values (true,'x', now()+interval '2 day', now()+interval '1 day')`)), 'window inverted');
  });
});

describe('lifecycle and read rule', () => {
  test('19 start time prevents early display; expiry hides; hidden hides', () => {
    const future = idOf(ins('H', 'publisher_hub_id, title, starts_at', `'${HUB_V}','${T('later')}', now()+interval '1 day'`));
    const past = idOf(ins('H', 'publisher_hub_id, title, starts_at', `'${HUB_V}','${T('now')}', now()-interval '1 minute'`));
    assert.equal(count('anon', `id='${future}'`), 0); assert.equal(count('anon', `id='${past}'`), 1);
    assert.equal(count('H', `id='${future}'`), 0, 'the owner does not read their own scheduled notice directly (Stage 3A)');
    assert.equal(managed('H', 'hub', HUB_V, `m.id='${future}'`), 1, 'but manages it through the management function');
    assert.equal(managed('A', 'mine', null, `m.id='${future}'`), 0, 'a stranger does not');
  });
  test('20 expired notices are hidden from the public but kept', () => {
    const id = idOf(as('service', `insert into notices (publisher_hub_id, title, expires_at) values ('${HUB_V}','${T('old')}', now()-interval '1 minute') returning id`));
    assert.equal(count('anon', `id='${id}'`), 0); assert.equal(n(`select count(*) from notices where id='${id}'`), '1');
  });
  test('21 resolved is not expired: the original and its source are preserved; it is not public yet; owner and staff still see it', () => {
    const ref = T('res');
    const id = idOf(as('service', `insert into notices (is_platform_notice, title, body, source, source_reference, source_url, source_label, expires_at)
      values (true,'Prescription request system unavailable','Use the phone line','nhs_shetland','${ref}','https://nhs.example/${ref}','NHS Shetland', now()+interval '3 day') returning id`));
    assert.equal(count('anon', `id='${id}'`), 1);
    as('service', `update notices set status='resolved' where id='${id}'`);
    assert.equal(n(`select title||'|'||source_label||'|'||source_reference||'|'||(resolved_at is not null)||'|'||(expires_at > now()) from notices where id='${id}'`), `Prescription request system unavailable|NHS Shetland|${ref}|true|true`);
    assert.equal(count('anon', `id='${id}'`), 0); assert.equal(count('S', `id='${id}'`), 0); assert.equal(managed('S', 'all', null, `m.id='${id}'`), 1);
    const hubId = idOf(ins('H', 'publisher_hub_id, title', `'${HUB_V}','${T('hres')}'`));
    assert.ok(failed(as('H', `update notices set status='resolved' where id='${hubId}'`)), 'a direct UPDATE that makes a notice non-public is refused (Stage 3A) ...');
    as('H', `select public.manage_set_notice_status('${hubId}','resolved')`);
    assert.equal(statusOf(hubId), 'resolved', '... the management function does it'); assert.equal(count('H', `id='${hubId}'`), 0); assert.equal(managed('H', 'hub', HUB_V, `m.id='${hubId}'`), 1, 'hub owner manages its own resolved notice'); assert.equal(count('anon', `id='${hubId}'`), 0);
    assert.equal(managed('A2', 'mine', null, `m.id='${hubId}'`), 0, 'a stranger does not');
  });
  test('22 withdrawn and updated_at: withdrawn is not public; updated_at moves on edit', () => {
    const id = idOf(ins('B', 'publisher_business_id, title', `'${BIZ_B}','${T('w')}'`));
    const t0 = n(`select updated_at from notices where id='${id}'`);
    file(`select pg_sleep(0.05)`);
    assert.ok(failed(as('B', `update notices set status='bogus' where id='${id}'`)));
    assert.ok(failed(as('B', `update notices set status='pending' where id='${id}'`)), 'only staff place a hub/business notice in review');
    assert.ok(failed(as('B', `update notices set status='withdrawn' where id='${id}'`)), 'a direct withdraw is refused (Stage 3A) ...');
    assert.ok(!failed(as('B', `select public.manage_set_notice_status('${id}','withdrawn')`)), '... the management function withdraws');
    assert.equal(count('anon', `id='${id}'`), 0); assert.notEqual(n(`select updated_at from notices where id='${id}'`), t0);
    assert.equal(n(`select (withdrawn_at is not null)::text from notices where id='${id}'`), 'true');
  });
});

describe('categories and urgency', () => {
  test('23 the nine workbook categories exist; unknown is rejected; null / legacy rows stay valid', () => {
    assert.equal(n(`select count(*) from notice_categories`), '9');
    assert.equal(n(`select string_agg(label, ' | ' order by sort_order) from notice_categories`),
      'Travel & transport | Health | Council & public services | Schools & education | Community | Consultations & funding | Lost & found | Appeals & volunteering | Other');
    assert.ok(!failed(ins('H', 'publisher_hub_id, title, category', `'${HUB_V}','${T('c')}','health'`)));
    assert.ok(failed(ins('H', 'publisher_hub_id, title, category', `'${HUB_V}','${T('c')}','Free text'`)));
    assert.equal(n(`select category is null from notices where id='${N_LEGACY}'`), 't');
    assert.ok(failed(as('A', `insert into notice_categories values ('x','x',null,1)`)), 'users cannot add categories');
  });
  test('24 urgent rules are not loosened', () => {
    assert.ok(!failed(ins('V', 'publisher_business_id, severity, title', `'${BIZ_V}','urgent','${T('u')}'`)), 'approved business');
    assert.ok(failed(ins('B', 'publisher_business_id, severity, title', `'${BIZ_B}','urgent','${T('u')}'`)), 'unapproved business');
    assert.ok(failed(ins('H', 'publisher_hub_id, severity, title', `'${HUB_V}','urgent','${T('u')}'`)), 'hub owner');
    assert.ok(failed(ins('A', 'is_person_notice, severity, title', `true,'urgent','${T('u')}'`)), 'person');
    assert.ok(!failed(ins('S', 'is_platform_notice, severity, title', `true,'urgent','${T('u')}'`)), 'staff');
    assert.ok(!failed(as('service', `insert into notices (is_platform_notice, severity, title, source, source_reference, source_label, expires_at) values (true,'urgent','Road closed','sic','${T('u')}','Shetland Islands Council', now()+interval '1 day')`)), 'trusted importer');
  });
});

describe('geography link', () => {
  const mk = () => idOf(ins('H', 'publisher_hub_id, title', `'${HUB_V}','${T('geo')}'`));
  test('25 one area, several areas, shetland_wide, and none (= unspecified) are distinct; wide cannot be mixed', () => {
    const one = mk(), many = mk(), wide = mk(), none = mk(), mixed = mk();
    assert.ok(!failed(as('H', `insert into notice_areas (notice_id, area_id) values ('${one}','shetland_west')`)));
    assert.ok(!failed(as('H', `insert into notice_areas (notice_id, area_id) values ('${many}','shetland_west'), ('${many}','shetland_north')`)));
    assert.ok(!failed(as('H', `insert into notice_areas (notice_id, area_id) values ('${wide}','shetland_wide')`)));
    assert.ok(failed(as('H', `insert into notice_areas (notice_id, area_id) values ('${mixed}','shetland_wide'), ('${mixed}','shetland_west')`)), 'wide + specific');
    assert.ok(failed(as('H', `insert into notice_areas (notice_id, area_id) values ('${wide}','shetland_west')`)), 'specific added to wide');
    assert.ok(failed(as('H', `insert into notice_areas (notice_id, area_id) values ('${none}','not_an_area')`)), 'unknown area');
    file(`insert into areas (id, name, type, is_active, confidence) values ('zz_pending','Pending place','area',false,'low') on conflict do nothing`);
    assert.ok(failed(as('H', `insert into notice_areas (notice_id, area_id) values ('${none}','zz_pending')`)), 'inactive area');
    const kind = (id: string) => n(`select case when exists (select 1 from notice_areas where notice_id='${id}' and area_id='shetland_wide') then 'wide' when exists (select 1 from notice_areas where notice_id='${id}') then 'specific' else 'unspecified' end`);
    assert.deepEqual([kind(one), kind(many), kind(wide), kind(none)], ['specific', 'specific', 'wide', 'unspecified']);
    assert.equal(n(`select count(*) from notice_areas where notice_id='${many}'`), '2');
  });
  test('26 area writes follow ownership; areas of pending notices are not public; deleting a notice removes its links; old locality survives', () => {
    clear('A');
    const id = mk();
    assert.ok(failed(as('A', `insert into notice_areas (notice_id, area_id) values ('${id}','shetland_west')`)), 'stranger');
    assert.ok(failed(as('anon', `insert into notice_areas (notice_id, area_id) values ('${id}','shetland_west')`)), 'anon');
    as('H', `insert into notice_areas (notice_id, area_id) values ('${id}','shetland_west')`);
    assert.equal(last(as('anon', `select count(*) from notice_areas where notice_id='${id}'`)), '1');
    const p = idOf(ins('A', 'is_person_notice, title', `true,'${T('p')}'`));
    as('A', `insert into notice_areas (notice_id, area_id) values ('${p}','shetland_north')`);
    assert.equal(last(as('anon', `select count(*) from notice_areas where notice_id='${p}'`)), '0');
    assert.equal(last(as('A', `select count(*) from notice_areas where notice_id='${p}'`)), '1');
    as('H', `delete from notices where id='${id}'`);
    assert.equal(n(`select count(*) from notice_areas where notice_id='${id}'`), '0');
    const loc = idOf(ins('H', 'publisher_hub_id, title, locality, lat, lng', `'${HUB_V}','${T('loc')}','Burra',60.1,-1.3`));
    assert.equal(n(`select locality||lat||lng from notices where id='${loc}'`), 'Burra60.1-1.3');
  });
});

describe('generated notices, display, compatibility', () => {
  test('27 event and fundraiser notices still generate exactly as the app sends them (no new fields)', () => {
    assert.ok(!failed(ins('H', 'publisher_hub_id, title, body, event_id, visibility', `'${HUB_V}','New event','Come along','${EV_HUB}','public'`)));
    assert.ok(!failed(ins('H', 'publisher_hub_id, title, body, campaign_id', `'${HUB_V}','New fundraiser','Give','${CAMP_V}'`)));
    assert.ok(failed(ins('H', 'publisher_hub_id, title, event_id', `'${HUB_V}','x','${EV_OTHER}'`)), 'another hub\'s event');
    assert.ok(failed(ins('H', 'publisher_hub_id, title, event_id', `'${HUB_O}','x','${EV_OTHER}'`)), 'a hub they do not control');
  });
  test('28 the display label is the hub / business / person name, never "Member"', () => {
    clear('A');
    const label = (id: string) => n(`select public.notice_publisher_display('${id}')->>'label'`);
    assert.equal(label(N_LEGACY), 'Voe Hall');
    assert.equal(label(idOf(ins('B', 'publisher_business_id, title', `'${BIZ_B}','${T('l')}'`))), 'Bea Bakery');
    const pid = idOf(ins('A', 'is_person_notice, title', `true,'${T('l')}'`));
    assert.equal(label(pid), 'A OneShetland member', 'a pending notice does not disclose the name to anyone else');
    assert.equal(last(as('A', `select public.notice_person_label('${U.A}')`)), 'Ann', 'the author sees their own name');
    assert.equal(last(as('A', `select public.notice_publisher_display('${pid}') is null`)), 't', 'a pending notice is not readable, so the display function returns nothing');
    file(`update notices set status='published' where id='${pid}'`);
    assert.equal(label(pid), 'Ann');
    assert.equal(last(as('anon', `select public.notice_publisher_display('${pid}')->>'label'`)), 'Ann', 'public once approved');
    const anon = JSON.parse(n(`select public.notice_publisher_display('${N_LEGACY}')::text`));
    assert.equal(anon.kind, 'hub');
    const all = n(`select string_agg(distinct public.notice_publisher_display(id)->>'label', '|') from notices`);
    assert.doesNotMatch(all, /\bMember\b/);
  });
  test('29 anonymous read: only public published notices; writes denied; the display function does not leak a pending notice', () => {
    clear('A');
    assert.ok(failed(ins('anon', 'publisher_hub_id, title', `'${HUB_V}','x'`)));
    assert.equal(last(as('anon', `select count(*) from notices where status<>'published' or is_hidden`)), '0');
    const p = idOf(ins('A', 'is_person_notice, title', `true,'${T('hidden')}'`));
    assert.equal(last(as('anon', `select public.notice_publisher_display('${p}') is null`)), 't');
    assert.ok(failed(as('anon', `insert into notice_categories values ('x','x',null,1)`)));
    assert.equal(last(as('anon', `select count(*) from notice_categories`)), '9');
  });
  test('30 content_reports already accepts notice reports (no schema change needed)', () => {
    const id = idOf(ins('H', 'publisher_hub_id, title', `'${HUB_V}','${T('rep')}'`));
    assert.ok(!failed(raw(`insert into content_reports (reporter_id, content_type, content_id, reason) values ('${U.A}','notice','${id}','spam')`)));
  });
  test('31 the original columns still exist with their original names and types (no rename, no removal)', () => {
    const cols = n(`select string_agg(column_name, ',') from information_schema.columns where table_schema='public' and table_name='notices' and column_name in ('publisher_business_id','publisher_user_id','severity','title','body','locality','lat','lng','is_pinned','is_hidden','expires_at','published_at','created_at','publisher_hub_id','visibility','image_url','category','campaign_id','event_id','broadcast_at','broadcast_by','is_platform_notice')`);
    assert.equal(cols.split(',').length, 22);
    assert.equal(n(`select count(*) from pg_trigger where tgrelid='public.notices'::regclass and not tgisinternal and tgname in ('aa_notices_attribution_guard','notices_lifecycle')`), '2');
  });
  test('32 no notification path was added: nothing on notices references push or notifications', () => {
    assert.doesNotMatch(MIGRATION, /pg_notify|net\.http|supabase_functions|notification_queue|push_tokens/i);
    assert.equal(n(`select count(*) from pg_trigger t join pg_proc p on p.oid=t.tgfoid where tgrelid='public.notices'::regclass and not tgisinternal and p.prosrc ~* '(http|pg_notify|push)'`), '0');
  });
  test('33 load-bearing: with the guard removed, a person could self-publish (so the guard is what stops it)', () => {
    const o = file(`begin; alter table notices disable trigger aa_notices_attribution_guard;
      set local role authenticated; select set_config('request.jwt.claim.sub','${U.A}',true);
      insert into notices (is_person_notice, publisher_user_id, title, status) values (true,'${U.A}','guard off','published') returning status; reset role; rollback;`);
    assert.match(o, /published/);
  });
});

describe('TypeScript helper matches the SQL helper', () => {
  test('34 noticePublisher() gives the same label and byline as notice_publisher_display() for every publisher kind', () => {
    const sql = (id: string) => JSON.parse(n(`select public.notice_publisher_display('${id}')::text`));
    const cmp = (id: string, input: Parameters<typeof noticePublisher>[0]) => {
      const a = sql(id), b = noticePublisher(input);
      assert.deepEqual({ kind: a.kind, label: a.label, byline: a.byline, is_official_source: a.is_official_source }, { kind: b.kind, label: b.label, byline: b.byline, is_official_source: b.is_official_source });
    };
    cmp(N_LEGACY, { publisher_hub_id: HUB_V, hub_name: 'Voe Hall' });
    const biz = idOf(ins('B', 'publisher_business_id, title', `'${BIZ_B}','${T('p')}'`)); cmp(biz, { publisher_business_id: BIZ_B, business_name: 'Bea Bakery' });
    const plat = idOf(ins('S', 'is_platform_notice, title', `true,'${T('p')}'`)); cmp(plat, { is_platform_notice: true });
    const imp = idOf(as('service', `insert into notices (is_platform_notice, title, source, source_reference, source_label, expires_at) values (true,'t','nhs','${T('p')}','NHS Shetland', now()+interval '1 day') returning id`));
    cmp(imp, { is_platform_notice: true, source: 'nhs', source_label: 'NHS Shetland' });
    clear('A'); const per = idOf(ins('A', 'is_person_notice, title', `true,'${T('p')}'`)); file(`update notices set status='published' where id='${per}'`);
    cmp(per, { is_person_notice: true, publisher_user_id: U.A, person_name: 'Ann' });
    assert.equal(noticePublisher({ is_person_notice: true, publisher_user_id: null }).label, 'Former member');
    assert.doesNotMatch(JSON.stringify([noticePublisher({}), noticePublisher({ publisher_hub_id: 'x' }), noticePublisher({ is_person_notice: true, publisher_user_id: 'u' })]), /\bMember\b/);
  });
});

describe('rollback', () => {
  test('35 the rollback restores the pre-Stage-2 shape (and refuses while person / non-published notices exist)', () => {
    const RB2 = rd('supabase/rollbacks/20261128010000_notices_read_protection_rollback.sql').replace(/^begin;/m, '').replace(/commit;\s*$/, '');
    const RB = rd('supabase/rollbacks/20261128000000_notices_structural_readiness_rollback.sql').replace(/^begin;/m, '');
    const refused = file('begin;' + RB2 + RB.replace(/commit;\s*$/, 'rollback;'));
    assert.match(refused, /rollback refused/);
    file(`delete from notices where is_person_notice or status <> 'published'`);
    const o = file('begin;' + RB2 + RB.replace(/commit;\s*$/, `select 'cols:' || count(*) from information_schema.columns where table_name='notices' and column_name in ('status','source','starts_at','is_person_notice','updated_at');
      select 'tables:' || count(*) from pg_tables where tablename in ('notice_areas','notice_categories');
      select 'legacy:' || count(*) from notices where id='${N_LEGACY}';
      select 'policies:' || count(*) from pg_policies where tablename='notices';
      rollback;`));
    assert.match(o, /cols:0/); assert.match(o, /tables:0/); assert.match(o, /legacy:1/); assert.match(o, /policies:4/);
    assert.doesNotMatch(o, /ERROR/);
  });
});
