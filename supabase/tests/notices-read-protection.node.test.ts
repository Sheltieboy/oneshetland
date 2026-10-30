/**
 * notices-read-protection.node.test.ts — Notices Stage 3A step 1: released app builds must never be able to read a non-public notice.
 *
 * PART 1 reproduces the exposure on the Stage 2 state (migration 20261128000000 only) using the SQL equivalent of every direct notices read the
 * released app builds (144, 146, OTA) and the live website make. PART 2 applies 20261128010000 over the same data and proves the exposure is closed
 * for every role while the management functions still serve the people who legitimately manage non-public notices.
 *
 * SAFETY — ISOLATED DATABASE ONLY: requires PASS_PROOF_DSN, refuses a Supabase DSN. No network, no production row.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rd = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const PREFIX = rd('supabase/tests/_support/attribution-prefix-schema.sql');
const ATTRIBUTION = rd('supabase/migrations/20261121000000_event_notice_attribution.sql');
const GEO1 = rd('supabase/migrations/20261127000000_canonical_geography_foundation.sql');
const GEO2 = rd('supabase/migrations/20261127010000_geography_alias_ambiguity.sql');
const STAGE2 = rd('supabase/migrations/20261128000000_notices_structural_readiness.sql');
const PROTECT = rd('supabase/migrations/20261128010000_notices_read_protection.sql');
const ROLLBACK = rd('supabase/rollbacks/20261128010000_notices_read_protection_rollback.sql');
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
  A: 'a0000000-0000-4000-8000-0000000000a1',   // person notice author
  A2: 'a0000000-0000-4000-8000-0000000000a2',  // ordinary authenticated user, member of nothing
  B: 'b0000000-0000-4000-8000-0000000000b1',   // business owner
  B2: 'b0000000-0000-4000-8000-0000000000b2',  // owner of a different business
  V: 'c0000000-0000-4000-8000-0000000000c1',   // owns BIZ_V (urgent allowed)
  H: 'd0000000-0000-4000-8000-0000000000d1',   // hub owner
  C: 'd0000000-0000-4000-8000-0000000000d2',   // hub committee
  M: 'd0000000-0000-4000-8000-0000000000d3',   // ordinary hub MEMBER
  S: 'e0000000-0000-4000-8000-0000000000e1',   // staff (admin)
  S2: 'e0000000-0000-4000-8000-0000000000e2',  // staff (moderator)
};
type Who = keyof typeof U | 'anon' | 'service';
const BIZ_B = 'bb000000-0000-4000-8000-0000000000bb', BIZ_B2 = 'bb000000-0000-4000-8000-0000000000b2', BIZ_V = 'cc000000-0000-4000-8000-0000000000cc';
const HUB_V = 'dd000000-0000-4000-8000-0000000000dd', HUB_O = 'dd000000-0000-4000-8000-0000000000d0';
const CAMP_V = 'ca000000-0000-4000-8000-0000000000ca', EV_HUB = 'e1000000-0000-4000-8000-000000000001';
const as = (who: Who, sql: string) => {
  const role = who === 'service' ? 'service_role' : who === 'anon' ? 'anon' : 'authenticated';
  const sub = who === 'anon' || who === 'service' ? '' : U[who];
  return raw(`set role ${role}; select set_config('request.jwt.claim.sub','${sub}',false); ${sql}; reset role;`);
};
const nid = (k: number) => `f1000000-0000-4000-8000-${String(k).padStart(12, '0')}`;

// ── the seeded notices ────────────────────────────────────────────────────────────────────────────
// PUBLIC (must stay readable) and NON-PUBLIC (must never come back from a direct read)
const PUBLIC_IDS = { legacy: nid(1), hubPub: nid(2), bizPub: nid(3), platPub: nid(4), personPub: nid(5), hubMembers: nid(6), hubCommittee: nid(7) };
const NP = {
  personPending: nid(20), personWithdrawn: nid(21), personResolved: nid(22),
  hubWithdrawn: nid(30), hubResolved: nid(31), hubScheduled: nid(32), hubPending: nid(33), hubHidden: nid(34), hubExpired: nid(35),
  bizWithdrawn: nid(40), bizScheduled: nid(41), bizHidden: nid(42),
  platPending: nid(50), platResolved: nid(51), platExpired: nid(52),
};
const NP_IDS = Object.values(NP);
const NPS = NP_IDS.map((i) => `'${i}'`).join(',');

function seed() {
  const o = file(`
    insert into notices (id, publisher_hub_id, severity, title, visibility, published_at, created_at) values
      ('${PUBLIC_IDS.legacy}','${HUB_V}','info','OneShetland is getting ready to launch','public','2026-10-04 11:20:42+00','2026-10-04 11:20:42+00');
    insert into notices (id, publisher_hub_id, title, visibility) values
      ('${PUBLIC_IDS.hubPub}','${HUB_V}','hub public','public'), ('${PUBLIC_IDS.hubMembers}','${HUB_V}','hub members only','members'), ('${PUBLIC_IDS.hubCommittee}','${HUB_V}','hub committee only','committee');
    insert into notices (id, publisher_business_id, title) values ('${PUBLIC_IDS.bizPub}','${BIZ_B}','biz public');
    insert into notices (id, is_platform_notice, title) values ('${PUBLIC_IDS.platPub}', true, 'platform public');
    insert into notices (id, is_person_notice, publisher_user_id, title, status) values ('${PUBLIC_IDS.personPub}', true, '${U.A}', 'person approved', 'published');
    -- non-public
    insert into notices (id, is_person_notice, publisher_user_id, title, status) values
      ('${NP.personPending}', true, '${U.A}', 'person pending', 'pending'), ('${NP.personWithdrawn}', true, '${U.A}', 'person withdrawn', 'withdrawn'), ('${NP.personResolved}', true, '${U.A}', 'person resolved', 'resolved');
    insert into notices (id, publisher_hub_id, title, status, starts_at, is_hidden, expires_at) values
      ('${NP.hubWithdrawn}','${HUB_V}','hub withdrawn','withdrawn',null,false,null), ('${NP.hubResolved}','${HUB_V}','hub resolved','resolved',null,false,null),
      ('${NP.hubScheduled}','${HUB_V}','hub scheduled','published', now()+interval '2 day',false,null), ('${NP.hubPending}','${HUB_V}','hub in review','pending',null,false,null),
      ('${NP.hubHidden}','${HUB_V}','hub hidden','published',null,true,null), ('${NP.hubExpired}','${HUB_V}','hub expired','published',null,false, now()-interval '1 day');
    insert into notices (id, publisher_business_id, title, status, starts_at, is_hidden) values
      ('${NP.bizWithdrawn}','${BIZ_B}','biz withdrawn','withdrawn',null,false), ('${NP.bizScheduled}','${BIZ_B}','biz scheduled','published', now()+interval '2 day',false), ('${NP.bizHidden}','${BIZ_B}','biz hidden','published',null,true);
    insert into notices (id, is_platform_notice, title, status, expires_at) values
      ('${NP.platPending}', true, 'plat pending','pending', null), ('${NP.platResolved}', true, 'plat resolved','resolved', null), ('${NP.platExpired}', true, 'plat expired','published', now()-interval '1 day');`);
  assert.doesNotMatch(o, /ERROR/i, `seed failed:\n${o.slice(0, 600)}`);
}

// ── the reads released builds actually make (SQL equivalents of the PostgREST requests; file:line in the audit) ──
const NOT_EXPIRED = `(n.expires_at is null or n.expires_at > now())`;
const OLD_CLIENT_READS: Record<string, string> = {
  'app fetchHomeNotices (lib/concierge-api.ts:98)': `select n.id from notices n left join hubs h on h.id=n.publisher_hub_id left join local_businesses b on b.id=n.publisher_business_id where n.is_hidden=false and n.visibility='public' and ${NOT_EXPIRED} order by n.is_pinned desc, n.published_at desc limit 200`,
  'app fetchPublicNotices (lib/hubs-api.ts:952)': `select n.id from notices n left join hubs h on h.id=n.publisher_hub_id where n.visibility='public' and n.is_hidden=false and ${NOT_EXPIRED} order by n.published_at desc limit 200`,
  'app fetchHubNotices (lib/hubs-api.ts:591)': `select n.id from notices n where n.publisher_hub_id='${HUB_V}' and n.is_hidden=false and ${NOT_EXPIRED} order by n.is_pinned desc, n.published_at desc limit 200`,
  'web fetchNotices (lib/home-data.ts:262)': `select n.id from notices n where n.is_hidden=false and n.visibility='public' and ${NOT_EXPIRED} order by n.is_pinned desc, n.published_at desc limit 200`,
  'web local feed (lib/local-data.ts:754) - no hidden / expiry filter': `select n.id from notices n where n.visibility='public' order by n.published_at desc limit 200`,
  'web getHubNotices (lib/hubs-data.ts:303) - no filter at all': `select n.id from notices n where n.publisher_hub_id='${HUB_V}' order by n.is_pinned desc, n.published_at desc limit 200`,
  'select * (any client)': `select n.id from notices n limit 500`,
  'broadcast lookup by id (lib/notices-broadcast.ts:22)': `select n.id from notices n where n.id in (${NPS})`,
};
const ROLES: Who[] = ['anon', 'A2', 'M', 'A', 'H', 'C', 'B', 'S', 'S2'];
const idsFor = (who: Who, q: string): string[] => {
  const full = as(who, `select 'IDS:' || coalesce(string_agg(id::text, ','), '') from (${q}) q`);
  const o = last(full).replace(/^IDS:/, '');
  assert.ok(!failed(full) && last(full).startsWith('IDS:'), `read errored (an error must not look like "no leak"): ${full.slice(0, 300)}`);
  return o ? o.split(',') : [];
};
const leak = (who: Who, q: string) => idsFor(who, q).filter((i) => NP_IDS.includes(i));

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
    grant select on all tables in schema public to anon; grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
    insert into profiles (id, role, display_name) values ('${U.A}','customer','Ann'), ('${U.A2}','customer','Zed'), ('${U.B}','customer','Bea'), ('${U.B2}','customer','Bo'),
      ('${U.V}','customer','Vic'), ('${U.H}','customer','Hal'), ('${U.C}','customer','Cat'), ('${U.M}','customer','Meg'), ('${U.S}','admin','Staff'), ('${U.S2}','moderator','Mod');
    insert into local_businesses (id, owner_id, name, slug, can_publish_urgent) values ('${BIZ_B}','${U.B}','Bea Bakery','bea',false), ('${BIZ_B2}','${U.B2}','Bo Boats','bo',false), ('${BIZ_V}','${U.V}','Vic Garage','vic',true);
    alter table hubs disable trigger tg_zz_lock_hub_columns;
    insert into hubs (id, owner_id, name, slug, is_verified, payout_enabled) values ('${HUB_V}','${U.H}','Voe Hall','voe',true,true), ('${HUB_O}','${U.S}','Other Hub','other',false,false);
    alter table hubs enable trigger tg_zz_lock_hub_columns;
    insert into hub_members (hub_id, user_id, role) values ('${HUB_V}','${U.C}','committee'), ('${HUB_V}','${U.M}','member');
    insert into hub_campaigns (id, hub_id, title) values ('${CAMP_V}','${HUB_V}','Roof fund');
    insert into events (id, title, starts_at, status, organiser_hub_id) values ('${EV_HUB}','Hub night', now()+interval '3 day','published','${HUB_V}');`);
  assert.doesNotMatch(o, /ERROR/i, `setup failed:\n${o.slice(0, 600)}`);
  for (const [name, m] of [['attribution', ATTRIBUTION], ['geo1', GEO1], ['geo2', GEO2], ['stage2', STAGE2]] as const) {
    o = file(m); assert.doesNotMatch(o, /ERROR/i, `${name} migration failed:\n${o.slice(0, 800)}`);
  }
  seed();
});

// state captured between the two parts
const STAGE2_LEAKS: Record<string, Record<string, string[]>> = {};
let LEGACY_BEFORE = '';
const ORIG = 'id, publisher_business_id, publisher_user_id, severity, title, body, locality, lat, lng, is_pinned, is_hidden, expires_at, published_at, created_at, publisher_hub_id, visibility, image_url, category, campaign_id, event_id, broadcast_at, broadcast_by, is_platform_notice, status, starts_at, source';
const legacyRow = () => scalar(`select md5(row(${ORIG})::text) from notices where id='${PUBLIC_IDS.legacy}'`);

describe('PART 1 - the exposure, reproduced on the Stage 2 state with the real client reads', () => {
  test('1.1 anonymous visitors, ordinary members and hub members are not exposed (they never were)', () => {
    for (const who of ['anon', 'A2', 'M'] as Who[]) for (const [name, q] of Object.entries(OLD_CLIENT_READS)) {
      assert.deepEqual(leak(who, q), [], `${who} / ${name}`);
    }
  });
  test('1.2 CONTROL: person author, hub owner, committee, business owner and staff DO receive non-public notices from the released-build reads', () => {
    for (const who of ['A', 'H', 'C', 'B', 'S', 'S2'] as Who[]) {
      STAGE2_LEAKS[who] = {};
      let total = 0;
      for (const [name, q] of Object.entries(OLD_CLIENT_READS)) { const l = leak(who, q); STAGE2_LEAKS[who][name] = l; total += l.length; }
      assert.ok(total > 0, `${who} should be exposed on the Stage 2 state`);
    }
    // the concrete cases from the audit
    assert.ok(STAGE2_LEAKS.A['app fetchHomeNotices (lib/concierge-api.ts:98)'].includes(NP.personPending), "an author's PENDING person notice appears in their home feed");
    assert.ok(STAGE2_LEAKS.H['app fetchPublicNotices (lib/hubs-api.ts:952)'].includes(NP.hubWithdrawn), "a hub owner's WITHDRAWN notice appears in the public feed");
    assert.ok(STAGE2_LEAKS.H['app fetchHomeNotices (lib/concierge-api.ts:98)'].includes(NP.hubScheduled), "a SCHEDULED notice appears before its start time");
    assert.ok(STAGE2_LEAKS.S['web fetchNotices (lib/home-data.ts:262)'].includes(NP.personPending), 'staff see every pending notice in the public feed');
    assert.ok(STAGE2_LEAKS.S['web local feed (lib/local-data.ts:754) - no hidden / expiry filter'].includes(NP.hubHidden), 'staff also receive hidden + expired rows from the unfiltered web feed');
  });
});

describe('PART 2 - the fix (20261128010000) closes it for released builds', () => {
  before(() => {
    LEGACY_BEFORE = legacyRow();
    const o = file(PROTECT); assert.doesNotMatch(o, /ERROR/i, `protection migration failed:\n${o.slice(0, 800)}`);
  });

  test('2.1 NO role receives any non-public notice from ANY released-build read (anon, member, author, hub owner, committee, business owner, staff x2)', () => {
    for (const who of ROLES) for (const [name, q] of Object.entries(OLD_CLIENT_READS)) {
      assert.deepEqual(leak(who, q), [], `${who} / ${name}`);
    }
  });
  test('2.2 public visibility rules are preserved: public notices appear for everyone, members-only only to members, committee-only only to committee', () => {
    const direct = (who: Who) => idsFor(who, `select id from notices where id in (${Object.values(PUBLIC_IDS).map((i) => `'${i}'`).join(',')})`);
    for (const who of ROLES) {
      const got = direct(who);
      for (const k of ['legacy', 'hubPub', 'bizPub', 'platPub', 'personPub'] as const) assert.ok(got.includes(PUBLIC_IDS[k]), `${who} sees ${k}`);
      assert.equal(got.includes(PUBLIC_IDS.hubMembers), who === 'M' || who === 'C' || who === 'H', `${who} / members-only (members, committee and owner only)`);
      assert.equal(got.includes(PUBLIC_IDS.hubCommittee), who === 'C' || who === 'H', `${who} / committee-only`);
    }
    // identical to Stage 2 for the people who were never exposed
    assert.equal(idsFor('anon', `select id from notices`).length, 5);
  });
  test('2.3 the live notice is byte-identical across the migration and still readable by a signed-out visitor', () => {
    assert.equal(legacyRow(), LEGACY_BEFORE);
    assert.equal(idsFor('anon', `select id from notices where id='${PUBLIC_IDS.legacy}'`).length, 1);
  });
  test('2.4 the legacy publishing shapes still work with RETURNING: hub notice, event notice, fundraiser notice, members notice, business notice, urgent business notice, platform notice by staff, official import by the service role', () => {
    const t = (who: Who, sql: string, what: string) => { const o = as(who, sql); assert.ok(!failed(o), `${what}: ${o}`); assert.match(last(o), /^[0-9a-f-]{36}$/, what); };
    t('H', `insert into notices (publisher_hub_id, severity, visibility, title) values ('${HUB_V}','community','public','h') returning id`, 'hub notice');
    t('H', `insert into notices (publisher_hub_id, severity, visibility, title, event_id) values ('${HUB_V}','community','public','e','${EV_HUB}') returning id`, 'event notice');
    t('H', `insert into notices (publisher_hub_id, severity, visibility, title, campaign_id) values ('${HUB_V}','community','public','f','${CAMP_V}') returning id`, 'fundraiser notice');
    t('C', `insert into notices (publisher_hub_id, severity, visibility, title) values ('${HUB_V}','community','members','m') returning id`, 'members-only notice by committee');
    t('B', `insert into notices (publisher_business_id, severity, visibility, title) values ('${BIZ_B}','community','public','b') returning id`, 'business notice');
    t('V', `insert into notices (publisher_business_id, severity, visibility, title) values ('${BIZ_V}','urgent','public','u') returning id`, 'approved business urgent');
    t('S', `insert into notices (is_platform_notice, severity, title) values (true,'urgent','p') returning id`, 'platform urgent by staff');
    t('service', `insert into notices (is_platform_notice, title, source, source_reference, source_label, source_url, expires_at) values (true,'Ferry','nhs','r-${Date.now()}','NHS Shetland','https://x', now()+interval '2 day') returning id`, 'official import');
    assert.ok(failed(as('B', `insert into notices (publisher_business_id, severity, title) values ('${BIZ_B}','urgent','x') returning id`)), 'unapproved business urgent still refused');
    assert.ok(failed(as('H', `insert into notices (publisher_hub_id, severity, title) values ('${HUB_V}','urgent','x') returning id`)), 'hub urgent still refused');
    assert.ok(failed(as('A2', `insert into notices (publisher_hub_id, title) values ('${HUB_V}','spoof')`)), 'spoofing still refused');
    assert.ok(failed(as('A2', `insert into notices (is_platform_notice, title, source, source_reference, source_label, expires_at) values (true,'x','nhs','z','NHS Shetland', now()+interval '1 day')`)), 'official source spoof still refused');
  });
  test('2.5 documented consequence: a not-yet-public insert cannot be read back, so it is refused on RETURNING; without RETURNING it succeeds and stays hidden', () => {
    assert.ok(failed(as('A', `insert into notices (is_person_notice, title) values (true,'x') returning id`)), 'person insert returning (pending row is unreadable)');
    const id = '9a000000-0000-4000-8000-000000000001';
    assert.ok(!failed(as('A', `insert into notices (id, is_person_notice, title) values ('${id}', true, 'x')`)));
    assert.equal(scalar(`select status from notices where id='${id}'`), 'pending');
    assert.equal(idsFor('A', `select id from notices where id='${id}'`).length, 0);
    assert.ok(failed(as('H', `insert into notices (publisher_hub_id, title, starts_at) values ('${HUB_V}','later', now()+interval '1 day') returning id`)), 'scheduled insert returning');
  });
  test('2.6 direct UPDATE / DELETE of PUBLIC notices still work for their managers', () => {
    const cnt = (who: Who, sql: string) => Number(last(as(who, `with x as (${sql} returning 1) select count(*) from x`)));
    assert.equal(cnt('H', `update notices set title='edited' where id='${PUBLIC_IDS.hubPub}'`), 1, 'hub owner edits a public notice');
    assert.equal(cnt('C', `update notices set body='b' where id='${PUBLIC_IDS.hubPub}'`), 1, 'committee edits');
    assert.equal(cnt('B', `update notices set body='b' where id='${PUBLIC_IDS.bizPub}'`), 1, 'business owner edits');
    assert.equal(cnt('S', `update notices set is_pinned=true where id='${PUBLIC_IDS.hubPub}'`), 1, 'staff pin');
    assert.equal(cnt('A2', `update notices set title='x' where id='${PUBLIC_IDS.hubPub}'`), 0, 'a stranger cannot');
    assert.equal(cnt('M', `delete from notices where id='${PUBLIC_IDS.hubPub}'`), 0, 'a member cannot delete');
    const d = '9a000000-0000-4000-8000-000000000002';
    file(`insert into notices (id, publisher_hub_id, title) values ('${d}','${HUB_V}','to delete')`);
    assert.equal(cnt('H', `delete from notices where id='${d}'`), 1, 'hub owner deletes a public notice (what both clients do)');
    // content edit that stays public is fine; an update that would make it non-public is refused by RLS instead of silently succeeding
    assert.ok(failed(as('H', `update notices set status='withdrawn' where id='${PUBLIC_IDS.hubPub}'`)), 'a direct withdraw is refused - use manage_set_notice_status');
    assert.equal(scalar(`select status from notices where id='${PUBLIC_IDS.hubPub}'`), 'published');
  });
  test('2.7 direct UPDATE / DELETE cannot reach a non-public notice at all (no side door)', () => {
    for (const who of ['A', 'H', 'C', 'B', 'S', 'A2'] as Who[]) {
      const u = last(as(who, `with x as (update notices set title='hijack' where id in (${NPS}) returning 1) select count(*) from x`));
      const d = last(as(who, `with x as (delete from notices where id in (${NPS}) returning 1) select count(*) from x`));
      assert.equal(u, '0', `${who} update`); assert.equal(d, '0', `${who} delete`);
    }
    assert.equal(scalar(`select count(*) from notices where id in (${NPS})`), String(NP_IDS.length));
  });
});

describe('PART 2 - management access still works, and only for what you manage', () => {
  const list = (who: Who, scope: string, id: string | null, status: string | null = null) => {
    const full = as(who, `select 'IDS:' || coalesce(string_agg(id::text, ','), '') from public.manage_notices('${scope}', ${id ? `'${id}'` : 'null'}, ${status ? `'${status}'` : 'null'})`);
    const o = last(full).replace(/^IDS:/, '');
    return failed(full) ? null : o ? o.split(',') : [];
  };
  const HUB_NP = [NP.hubWithdrawn, NP.hubResolved, NP.hubScheduled, NP.hubPending, NP.hubHidden, NP.hubExpired];
  const BIZ_NP = [NP.bizWithdrawn, NP.bizScheduled, NP.bizHidden];
  const PERSON_NP = [NP.personPending, NP.personWithdrawn, NP.personResolved];

  test('3.1 hub owner and committee manage every notice of their hub, including all six non-public kinds', () => {
    for (const who of ['H', 'C'] as Who[]) { const l = list(who, 'hub', HUB_V)!; for (const i of HUB_NP) assert.ok(l.includes(i), `${who} sees ${i}`); }
    assert.deepEqual(list('H', 'hub', HUB_V, 'withdrawn'), [NP.hubWithdrawn]);
  });
  test('3.2 business owner manages their business notices; person author manages their own', () => {
    const b = list('B', 'business', BIZ_B)!; for (const i of BIZ_NP) assert.ok(b.includes(i));
    const m = list('A', 'mine', null)!; for (const i of PERSON_NP) assert.ok(m.includes(i)); assert.ok(m.includes(PUBLIC_IDS.personPub));
  });
  test('3.3 staff (admin and moderator) manage everything', () => {
    for (const who of ['S', 'S2'] as Who[]) {
      const all = list(who, 'all', null)!;
      for (const i of [...HUB_NP, ...BIZ_NP, ...PERSON_NP, NP.platPending, NP.platResolved, NP.platExpired]) assert.ok(all.includes(i), `${who} ${i}`);
      assert.ok(list(who, 'hub', HUB_V)!.length >= HUB_NP.length); assert.ok(list(who, 'business', BIZ_B));
    }
  });
  test('3.4 management cannot be used to read someone else\'s notices', () => {
    assert.equal(list('A2', 'hub', HUB_V), null, 'stranger / hub'); assert.equal(list('M', 'hub', HUB_V), null, 'plain member / hub');
    assert.equal(list('B', 'hub', HUB_V), null, 'business owner / hub'); assert.equal(list('H', 'hub', HUB_O), null, 'hub owner / another hub');
    assert.equal(list('A2', 'business', BIZ_B), null, 'stranger / business'); assert.equal(list('B2', 'business', BIZ_B), null, 'other business owner');
    assert.equal(list('H', 'business', BIZ_B), null, 'hub owner / business');
    assert.deepEqual(list('A2', 'mine', null), [], "'mine' returns nothing for someone with no person notices");
    assert.ok(!list('B', 'mine', null)!.some((i) => PERSON_NP.includes(i)), "'mine' never includes anyone else's person notices");
    assert.ok(!list('H', 'mine', null)!.some((i) => HUB_NP.includes(i)), "'mine' never includes hub notices");
    for (const who of ['A', 'H', 'C', 'B', 'A2', 'M'] as Who[]) assert.equal(list(who, 'all', null), null, `${who} / all is staff only`);
    assert.equal(list('H', 'bogus', null), null, 'unknown scope'); assert.equal(list('H', 'hub', null), null, 'hub scope needs an id');
    assert.ok(failed(as('anon', `select * from public.manage_notices('all')`)), 'anonymous cannot call it');
    assert.ok(failed(as('H', `select * from public.manage_notices('hub','${HUB_V}','nonsense')`)), 'bad status');
  });
  test('3.5 status changes: staff approve a pending person notice and it becomes public; owners withdraw / resolve / republish their own; nobody else can', () => {
    const st = (who: Who, id: string, s: string) => as(who, `select public.manage_set_notice_status('${id}','${s}')`);
    const status = (id: string) => scalar(`select status from notices where id='${id}'`);
    assert.ok(failed(st('A', NP.personPending, 'published')), 'author cannot approve own notice'); assert.equal(status(NP.personPending), 'pending');
    assert.ok(failed(st('A2', NP.personPending, 'published')), 'stranger cannot');
    assert.ok(!failed(st('S2', NP.personPending, 'published'))); assert.equal(status(NP.personPending), 'published');
    assert.equal(idsFor('anon', `select id from notices where id='${NP.personPending}'`).length, 1, 'approved notice is now public');
    assert.ok(!failed(st('A', NP.personPending, 'withdrawn'))); assert.equal(status(NP.personPending), 'withdrawn');
    assert.ok(failed(st('A', NP.personWithdrawn, 'published')), 'author cannot re-publish a withdrawn notice');
    assert.ok(!failed(st('H', NP.hubWithdrawn, 'published')), 'hub owner re-publishes their own withdrawn notice'); assert.equal(idsFor('anon', `select id from notices where id='${NP.hubWithdrawn}'`).length, 1);
    assert.ok(!failed(st('H', NP.hubWithdrawn, 'resolved'))); assert.equal(scalar(`select (resolved_at is not null)::text from notices where id='${NP.hubWithdrawn}'`), 'true');
    assert.ok(failed(st('H', NP.hubPending, 'published')), 'a controller cannot lift a staff review hold'); assert.ok(failed(st('H', NP.hubResolved, 'pending')), 'nor place anything in review');
    assert.ok(failed(st('H', NP.platPending, 'published')) && failed(st('B', NP.platPending, 'published')), 'nor touch a platform notice');
    assert.ok(failed(st('H', NP.bizWithdrawn, 'published')) && failed(st('B2', NP.bizWithdrawn, 'published')), 'nor someone else\'s notice');
    assert.ok(failed(st('A2', '00000000-0000-4000-8000-000000000000', 'published')), 'unknown id answers like "not yours"');
    assert.ok(!failed(st('S', NP.platPending, 'published')), 'staff publish a platform notice'); assert.ok(failed(st('S', NP.platResolved, 'bogus')));
  });
  test('3.6 delete: managers delete their own non-public notices; staff = admins only; strangers cannot', () => {
    const del = (who: Who, id: string) => last(as(who, `select public.manage_delete_notice('${id}')`));
    assert.ok(failed(as('A2', `select public.manage_delete_notice('${NP.personResolved}')`))); assert.ok(failed(as('H', `select public.manage_delete_notice('${NP.personResolved}')`)));
    assert.equal(del('A', NP.personResolved), 't');
    assert.equal(del('H', NP.hubHidden), 't'); assert.ok(failed(as('H', `select public.manage_delete_notice('${NP.bizHidden}')`)));
    assert.equal(del('B', NP.bizHidden), 't');
    assert.ok(failed(as('H', `select public.manage_delete_notice('${NP.platExpired}')`)), 'controller cannot delete a platform notice'); assert.ok(failed(as('S2', `select public.manage_delete_notice('${NP.platExpired}')`)), 'moderators cannot delete (policy: admin only)');
    assert.equal(del('S', NP.platExpired), 't');
    assert.ok(failed(as('anon', `select public.manage_delete_notice('${NP.hubExpired}')`)));
  });
  test('3.7 notice_areas: managers read the areas of their non-public notice; nobody else, and anon only for public notices', () => {
    const nid2 = '9a000000-0000-4000-8000-000000000010';
    file(`insert into notices (id, is_person_notice, publisher_user_id, title, status) values ('${nid2}', true, '${U.A}', 'p', 'pending');
          insert into notice_areas (notice_id, area_id) values ('${nid2}','shetland_west'), ('${PUBLIC_IDS.hubPub}','shetland_west')`);
    const c = (who: Who, id: string) => Number(last(as(who, `select count(*) from notice_areas where notice_id='${id}'`)));
    assert.equal(c('A', nid2), 1); assert.equal(c('S', nid2), 1); assert.equal(c('A2', nid2), 0); assert.equal(c('anon', nid2), 0); assert.equal(c('H', nid2), 0);
    assert.equal(c('anon', PUBLIC_IDS.hubPub), 1);
  });
});

describe('PART 2 - person identity cannot be revealed before approval', () => {
  const label = (who: Who, u: string) => last(as(who, `select public.notice_person_label('${u}')`));
  const reset = (set: string) => file(`update notices set ${set} where id='${PUBLIC_IDS.personPub}'`);
  test('4.1 while the only notice is not public NOW (pending, withdrawn, resolved, hidden, scheduled, expired) strangers learn nothing; self and staff still can', () => {
    const states = ["status='pending'", "status='withdrawn'", "status='resolved'", 'is_hidden=true', "starts_at=now()+interval '1 day'", "expires_at=now()-interval '1 day'", "visibility='members'"];
    file(`delete from notices where is_person_notice and publisher_user_id='${U.A}' and id <> '${PUBLIC_IDS.personPub}'`);
    for (const s of states) {
      reset(s);
      for (const who of ['anon', 'A2', 'M', 'H', 'B'] as Who[]) assert.equal(label(who, U.A), 'A OneShetland member', `${who} / ${s}`);
      assert.equal(label('A', U.A), 'Ann', `self / ${s}`); assert.equal(label('S', U.A), 'Ann', `staff / ${s}`);
      reset("status='published', is_hidden=false, starts_at=null, expires_at=null, visibility='public'");
    }
  });
  test('4.2 once the notice is public the name is shown to everyone; the display function returns nothing for a notice you cannot read', () => {
    for (const who of ['anon', 'A2', 'H'] as Who[]) assert.equal(label(who, U.A), 'Ann');
    assert.equal(last(as('anon', `select public.notice_publisher_display('${PUBLIC_IDS.personPub}')->>'label'`)), 'Ann');
    reset("status='pending'");
    for (const who of ['anon', 'A2', 'A', 'S'] as Who[]) assert.equal(last(as(who, `select public.notice_publisher_display('${PUBLIC_IDS.personPub}') is null`)), 't', `${who}: display of a non-public notice`);
    reset("status='published'");
    assert.equal(label('anon', '00000000-0000-4000-8000-0000000000ff'), 'A OneShetland member', 'an unknown user id learns nothing');
    assert.equal(label('anon', U.A2), 'A OneShetland member', 'someone with no notice is not disclosed');
  });
});

describe('PART 3 - ordering and rollback', () => {
  test('5.1 migration order: the new migration sorts after Stage 2, nothing sits between, and the Stage 2 file is unchanged from its committed version', () => {
    const files = readdirSync(join(ROOT, 'supabase/migrations')).filter((f) => f >= '20261128');
    assert.deepEqual(files, ['20261128000000_notices_structural_readiness.sql', '20261128010000_notices_read_protection.sql']);
    const r = spawnSync('git', ['diff', '--quiet', 'HEAD', '--', 'supabase/migrations/20261128000000_notices_structural_readiness.sql'], { cwd: ROOT });
    assert.equal(r.status, 0, 'Stage 2 migration must be byte-identical to the committed (and production-applied) file');
    const r2 = spawnSync('git', ['log', '--format=%h', '--', 'supabase/migrations/20261128000000_notices_structural_readiness.sql'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r2.stdout.trim().split('\n').length, 1, 'Stage 2 migration has exactly one commit (never edited since it was applied)');
  });
  test('5.2 rollback refuses while non-published notices exist, restores the Stage 2 read policy, and the migration re-applies cleanly afterwards', () => {
    const strip = (s: string) => s.replace(/^begin;/m, '').replace(/commit;\s*$/, '');
    const refused = file('begin;' + strip(ROLLBACK) + 'rollback;');
    assert.match(refused, /rollback refused/);
    const o = file(`begin; delete from notices where status <> 'published' or is_person_notice; ${strip(ROLLBACK)}
      select 'policy:' || count(*) from pg_policies where tablename='notices' and policyname='notices read' and qual ilike '%is_person_notice%';
      select 'fn:' || count(*) from pg_proc where proname in ('manage_notices','manage_set_notice_status','manage_delete_notice');
      select 'wrapper:' || count(*) from pg_proc where proname='controls_notice_publisher';
      ${strip(PROTECT)}
      select 'again-fn:' || count(*) from pg_proc where proname in ('manage_notices','manage_set_notice_status','manage_delete_notice');
      select 'again-policy:' || count(*) from pg_policies where tablename='notices' and policyname='notices read' and qual ilike '%is_person_notice%';
      rollback;`);
    assert.doesNotMatch(o, /ERROR/); assert.match(o, /policy:1/); assert.match(o, /fn:0/); assert.match(o, /wrapper:1/); assert.match(o, /again-fn:3/); assert.match(o, /again-policy:0/);
  });
  test('5.3 a fresh installation (prefix + attribution + geography + Stage 2 + this migration) reproduces the same policies and functions', () => {
    assert.equal(scalar(`select count(*) from pg_policies where tablename='notices'`), '4');
    assert.equal(scalar(`select count(*) from pg_proc where proname in ('manage_notices','manage_set_notice_status','manage_delete_notice')`), '3');
    assert.equal(scalar(`select count(*) from pg_proc where proname='controls_notice_publisher'`), '0');
    assert.equal(scalar(`select has_function_privilege('anon','public.manage_notices(text,uuid,text,integer)','execute')::text`), 'false');
  });
});
