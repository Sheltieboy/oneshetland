/**
 * notices-postgrest.node.test.ts — Notices Stage 3A.1 verified through the REAL API layer (PostgREST + supabase-js), not SQL equivalents.
 *
 * ENVIRONMENT (all local, nothing near production):
 *   · Postgres 17.6 from the Supabase image (same major.minor as production) with the real Supabase roles (anon / authenticated / service_role /
 *     authenticator), production's auth.uid() definition and production's DEFAULT FUNCTION PRIVILEGES (new functions are NOT executable by anon /
 *     authenticated unless granted - the read-only production check showed this differs from a stock Supabase image and from the other suite).
 *   · PostgREST (image chosen by POSTGREST_IMAGE) validating signed HS256 JWTs: anon, authenticated with a `sub`, service_role.
 *   · The real @supabase/supabase-js client, through a tiny proxy that adds the `/rest/v1` prefix the hosted platform serves.
 *
 * Run:  docker start notices-proof-pg   (see scripts in the verification report)  then
 *       POSTGREST_IMAGE=public.ecr.aws/supabase/postgrest:v14.5 node --test supabase/tests/api/notices-postgrest.node.test.ts
 * This file is NOT part of `npm run test:isolated` (it needs Docker).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { loadModule } from '../_support/load-source.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const rd = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const IMAGE = process.env.POSTGREST_IMAGE ?? 'public.ecr.aws/supabase/postgrest:v14.5';
const PG = 'notices-proof-pg', REST = 'notices-proof-rest', NET = 'notices-api-proof';
const REST_PORT = 54782, PROXY_PORT = 54783, SECRET = 'a-proof-only-secret-that-is-at-least-32-characters-long';

const docker = (args: string[], input?: string) => spawnSync('docker', args, { input, encoding: 'utf8', timeout: 240_000 });
const psql = (user: string, sql: string) => { const r = docker(['exec', '-i', PG, 'psql', '-U', user, '-h', 'localhost', '-d', 'postgres', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'], sql); return `${r.stdout ?? ''}${r.stderr ?? ''}`; };
const pg = (sql: string) => psql('postgres', sql);
const scalar = (sql: string) => (pg(sql).split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '');
const failedSql = (o: string) => /ERROR/.test(o);

// ── JWTs ──────────────────────────────────────────────────────────────────────────────────────────
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: object) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ iss: 'proof', exp: Math.floor(Date.now() / 1000) + 3600, ...claims }); return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`; };
const U = {
  A: 'a0000000-0000-4000-8000-0000000000a1', A2: 'a0000000-0000-4000-8000-0000000000a2', B: 'b0000000-0000-4000-8000-0000000000b1', B2: 'b0000000-0000-4000-8000-0000000000b2',
  V: 'c0000000-0000-4000-8000-0000000000c1', H: 'd0000000-0000-4000-8000-0000000000d1', C: 'd0000000-0000-4000-8000-0000000000d2', M: 'd0000000-0000-4000-8000-0000000000d3',
  S: 'e0000000-0000-4000-8000-0000000000e1', S2: 'e0000000-0000-4000-8000-0000000000e2',
};
type Who = keyof typeof U | 'anon' | 'service';
const ANON = jwt({ role: 'anon' });
const tokenFor = (who: Who) => who === 'anon' ? ANON : who === 'service' ? jwt({ role: 'service_role' }) : jwt({ role: 'authenticated', aud: 'authenticated', sub: U[who] });

// proxy: the hosted platform serves PostgREST under /rest/v1
let proxy: http.Server;
const startProxy = () => new Promise<void>((resolve) => {
  proxy = http.createServer((req, res) => {
    const up = http.request({ host: '127.0.0.1', port: REST_PORT, path: (req.url ?? '').replace(/^\/rest\/v1/, '') || '/', method: req.method, headers: { ...req.headers, host: `127.0.0.1:${REST_PORT}` } }, (r) => { res.writeHead(r.statusCode ?? 500, r.headers); r.pipe(res); });
    up.on('error', () => { res.statusCode = 502; res.end(); });
    req.pipe(up);
  }).listen(PROXY_PORT, '127.0.0.1', resolve);
});
const client = (who: Who) => createClient(`http://127.0.0.1:${PROXY_PORT}`, ANON, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${tokenFor(who)}` } } });

const BIZ_B = 'bb000000-0000-4000-8000-0000000000bb', BIZ_B2 = 'bb000000-0000-4000-8000-0000000000b2', BIZ_V = 'cc000000-0000-4000-8000-0000000000cc';
const HUB_V = 'dd000000-0000-4000-8000-0000000000dd', HUB_O = 'dd000000-0000-4000-8000-0000000000d0', HUB_L = 'dd000000-0000-4000-8000-0000000000ee';
const CAMP_V = 'ca000000-0000-4000-8000-0000000000ca', EV_HUB = 'e1000000-0000-4000-8000-000000000001';
const nid = (k: number) => `f1000000-0000-4000-8000-${String(k).padStart(12, '0')}`;
const PUBLIC_IDS = { legacy: nid(1), hubPub: nid(2), bizPub: nid(3), platPub: nid(4), personPub: nid(5), hubMembers: nid(6), hubCommittee: nid(7) };
const NP = {
  personPending: nid(20), personWithdrawn: nid(21), personResolved: nid(22),
  hubWithdrawn: nid(30), hubResolved: nid(31), hubScheduled: nid(32), hubPending: nid(33), hubHidden: nid(34), hubExpired: nid(35),
  bizWithdrawn: nid(40), bizScheduled: nid(41), bizHidden: nid(42), platPending: nid(50), platResolved: nid(51), platExpired: nid(52),
};
const NP_IDS = Object.values(NP);

const SEED = `
  insert into notices (id, publisher_hub_id, severity, title, body, visibility, published_at, created_at) values
    ('${PUBLIC_IDS.legacy}','${HUB_L}','info','OneShetland is getting ready to launch','Legacy body text','public','2026-10-04 11:20:42+00','2026-10-04 11:20:42+00');
  insert into notices (id, publisher_hub_id, title, visibility) values
    ('${PUBLIC_IDS.hubPub}','${HUB_V}','hub public','public'), ('${PUBLIC_IDS.hubMembers}','${HUB_V}','hub members only','members'), ('${PUBLIC_IDS.hubCommittee}','${HUB_V}','hub committee only','committee');
  insert into notices (id, publisher_business_id, title) values ('${PUBLIC_IDS.bizPub}','${BIZ_B}','biz public');
  insert into notices (id, is_platform_notice, title) values ('${PUBLIC_IDS.platPub}', true, 'platform public');
  insert into notices (id, is_person_notice, publisher_user_id, title, status) values ('${PUBLIC_IDS.personPub}', true, '${U.A}', 'person approved', 'published');
  insert into notices (id, is_person_notice, publisher_user_id, title, status) values
    ('${NP.personPending}', true, '${U.A}', 'person pending', 'pending'), ('${NP.personWithdrawn}', true, '${U.A}', 'person withdrawn', 'withdrawn'), ('${NP.personResolved}', true, '${U.A}', 'person resolved', 'resolved');
  insert into notices (id, publisher_hub_id, title, status, starts_at, is_hidden, expires_at) values
    ('${NP.hubWithdrawn}','${HUB_V}','hub withdrawn','withdrawn',null,false,null), ('${NP.hubResolved}','${HUB_V}','hub resolved','resolved',null,false,null),
    ('${NP.hubScheduled}','${HUB_V}','hub scheduled','published', now()+interval '2 day',false,null), ('${NP.hubPending}','${HUB_V}','hub in review','pending',null,false,null),
    ('${NP.hubHidden}','${HUB_V}','hub hidden','published',null,true,null), ('${NP.hubExpired}','${HUB_V}','hub expired','published',null,false, now()-interval '1 day');
  insert into notices (id, publisher_business_id, title, status, starts_at, is_hidden) values
    ('${NP.bizWithdrawn}','${BIZ_B}','biz withdrawn','withdrawn',null,false), ('${NP.bizScheduled}','${BIZ_B}','biz scheduled','published', now()+interval '2 day',false), ('${NP.bizHidden}','${BIZ_B}','biz hidden','published',null,true);
  insert into notices (id, is_platform_notice, title, status, expires_at) values
    ('${NP.platPending}', true, 'plat pending','pending', null), ('${NP.platResolved}', true, 'plat resolved','resolved', null), ('${NP.platExpired}', true, 'plat expired','published', now()-interval '1 day');`;

const LOG: string[] = [];
const log = (s: string) => { LOG.push(s); };

before(async () => {
  assert.ok(docker(['ps', '--filter', `name=${PG}`, '--format', '{{.Names}}']).stdout.includes(PG), `container ${PG} must be running`);
  // roles + production's auth.uid(); production's default ACL for functions created by postgres in public
  let o = psql('supabase_admin', `
    alter role authenticator with password 'proofpw';
    create or replace function auth.uid() returns uuid language sql stable as $f$
      select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $f$;`);
  assert.ok(!failedSql(o), o);
  const prefix = rd('supabase/tests/_support/attribution-prefix-schema.sql').split('\n').slice(15).join('\n');
  o = pg(`
    drop schema if exists public cascade; create schema public;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated;
    alter default privileges for role postgres in schema public revoke truncate on tables from anon, authenticated;`);
  assert.ok(!failedSql(o), o);
  o = pg(prefix); assert.ok(!failedSql(o), `prefix: ${o.slice(0, 500)}`);
  o = pg(`
    create function public.is_admin() returns boolean language sql stable security definer set search_path to 'public' as $$
      select exists (select 1 from public.profiles where id = auth.uid() and (role = 'admin' or is_platform_owner = true)); $$;
    grant execute on function public.is_admin() to anon, authenticated, service_role;
    grant execute on function public.is_hub_admin(uuid, uuid), public.is_hub_member(uuid, uuid) to anon, authenticated, service_role;
    alter table notices add column lat numeric, add column lng numeric;
    alter table profiles add column display_name text; alter table profiles add column location_area text;
    alter table hubs add column logo_url text, add column brand_color text;
    alter table local_businesses add column logo_url text, add column brand_color text;
    alter table hub_campaigns add column raised_pence int default 0, add column goal_pence int default 0, add column donor_count int default 0, add column ends_at timestamptz, add column status text default 'active';
    alter table notices add constraint notices_campaign_id_fkey foreign key (campaign_id) references hub_campaigns(id) on delete cascade;
    create table regions (id uuid primary key default gen_random_uuid(), slug text unique not null, name text not null, display_order int);
    create table jobs (id uuid primary key default gen_random_uuid(), title text, locality text, location text);
    create table runs (id uuid primary key default gen_random_uuid(), origin_region_id uuid references regions(id), destination_region_id uuid references regions(id));
    create table delivery_requests (id uuid primary key default gen_random_uuid(), destination_region_id uuid references regions(id), destination_address text);
    insert into profiles (id, role, display_name) values ('${U.A}','customer','Ann'), ('${U.A2}','customer','Zed'), ('${U.B}','customer','Bea'), ('${U.B2}','customer','Bo'),
      ('${U.V}','customer','Vic'), ('${U.H}','customer','Hal'), ('${U.C}','customer','Cat'), ('${U.M}','customer','Meg'), ('${U.S}','admin','Staff'), ('${U.S2}','moderator','Mod');
    insert into local_businesses (id, owner_id, name, slug, can_publish_urgent) values ('${BIZ_B}','${U.B}','Bea Bakery','bea',false), ('${BIZ_B2}','${U.B2}','Bo Boats','bo',false), ('${BIZ_V}','${U.V}','Vic Garage','vic',true);
    alter table hubs disable trigger tg_zz_lock_hub_columns;
    insert into hubs (id, owner_id, name, slug, is_verified, payout_enabled) values ('${HUB_V}','${U.H}','Voe Hall','voe',true,true), ('${HUB_O}','${U.S}','Other Hub','other',false,false), ('${HUB_L}','${U.S}','OneShetland','oneshetland',true,false);
    alter table hubs enable trigger tg_zz_lock_hub_columns;
    insert into hub_members (hub_id, user_id, role) values ('${HUB_V}','${U.C}','committee'), ('${HUB_V}','${U.M}','member');
    insert into hub_campaigns (id, hub_id, title) values ('${CAMP_V}','${HUB_V}','Roof fund');
    insert into events (id, title, starts_at, status, organiser_hub_id) values ('${EV_HUB}','Hub night', now()+interval '3 day','published','${HUB_V}');`);
  assert.ok(!failedSql(o), `setup: ${o.slice(0, 600)}`);
  for (const [name, f] of [['attribution', 'supabase/migrations/20261121000000_event_notice_attribution.sql'], ['geo1', 'supabase/migrations/20261127000000_canonical_geography_foundation.sql'],
    ['geo2', 'supabase/migrations/20261127010000_geography_alias_ambiguity.sql'], ['stage2', 'supabase/migrations/20261128000000_notices_structural_readiness.sql']] as const) {
    o = pg(rd(f)); assert.ok(!failedSql(o), `${name}: ${o.slice(0, 600)}`);
  }
  o = pg(SEED); assert.ok(!failedSql(o), `seed: ${o.slice(0, 500)}`);
  // PostgREST
  docker(['rm', '-f', REST]);
  const r = docker(['run', '-d', '--name', REST, '--network', NET, '-p', `127.0.0.1:${REST_PORT}:3000`,
    '-e', `PGRST_DB_URI=postgres://authenticator:proofpw@${PG}:5432/postgres`, '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon',
    '-e', `PGRST_JWT_SECRET=${SECRET}`, '-e', 'PGRST_DB_POOL=4', IMAGE]);
  assert.equal(r.status, 0, r.stderr);
  for (let i = 0; i < 40; i++) { try { const x = await fetch(`http://127.0.0.1:${REST_PORT}/`, { headers: { apikey: ANON } }); if (x.status < 500) break; } catch { /* starting */ } await new Promise((s) => setTimeout(s, 500)); }
  await startProxy();
  log(`PostgREST image: ${IMAGE}`);
});
after(() => { proxy?.close(); docker(['rm', '-f', REST]); console.log('\n' + LOG.join('\n')); });

// ── the eight released-build read shapes, via supabase-js exactly as the clients call them ─────────
type Row = { id: string };
const NOW = () => new Date().toISOString();
const READS: Record<string, (c: ReturnType<typeof client>) => Promise<{ data: Row[] | null; error: { message: string } | null }>> = {
  'app fetchHomeNotices': (c) => c.from('notices').select(`id, severity, title, body, locality, published_at,
               publisher_business_id, publisher_user_id, publisher_hub_id, campaign_id, event_id,
               hub:hubs ( id, name, logo_url, brand_color ),
               business:local_businesses ( name, logo_url, brand_color ),
               campaign:hub_campaigns ( id, raised_pence, goal_pence, donor_count, status ),
               event:events ( id, title, starts_at, venue, cover_url, has_tickets, calendar_approved )`)
    .eq('is_hidden', false).eq('visibility', 'public').or(`expires_at.is.null,expires_at.gt.${NOW()}`)
    .order('is_pinned', { ascending: false }).order('published_at', { ascending: false }).limit(40) as never,
  'app fetchPublicNotices': (c) => c.from('notices').select('*, hub:hubs(id,name,logo_url,slug)').eq('visibility', 'public').eq('is_hidden', false)
    .or(`expires_at.is.null,expires_at.gt.${NOW()}`).order('published_at', { ascending: false }).limit(10) as never,
  'app fetchHubNotices': (c) => c.from('notices').select('*, campaign:hub_campaigns ( id, title, raised_pence, goal_pence, donor_count, ends_at, status )')
    .eq('publisher_hub_id', HUB_V).eq('is_hidden', false).or(`expires_at.is.null,expires_at.gt.${NOW()}`)
    .order('is_pinned', { ascending: false }).order('published_at', { ascending: false }).limit(30) as never,
  'web home notices': (c) => c.from('notices').select(`id, severity, title, body, locality, published_at,
       publisher_business_id, publisher_user_id, publisher_hub_id, campaign_id, event_id,
       hub:hubs ( id, slug, name, logo_url, brand_color ),
       business:local_businesses ( id, slug, name, logo_url, brand_color )`)
    .eq('is_hidden', false).eq('visibility', 'public').or(`expires_at.is.null,expires_at.gt.${NOW()}`)
    .order('is_pinned', { ascending: false }).order('published_at', { ascending: false }).limit(8) as never,
  'web local feed (limit 4 as shipped)': (c) => c.from('notices').select('id, title, body, published_at, severity, hub:hubs(id, name, logo_url, slug)')
    .eq('visibility', 'public').order('published_at', { ascending: false }).limit(4) as never,
  'web local feed (limit 200: leak detector)': (c) => c.from('notices').select('id, title, body, published_at, severity, hub:hubs(id, name, logo_url, slug)')
    .eq('visibility', 'public').order('published_at', { ascending: false }).limit(200) as never,
  'web getHubNotices': (c) => c.from('notices').select('id, publisher_hub_id, title, body, severity, visibility, image_url, is_pinned, expires_at, published_at')
    .eq('publisher_hub_id', HUB_V).order('is_pinned', { ascending: false }).order('published_at', { ascending: false }).limit(20) as never,
  'plain select *': (c) => c.from('notices').select('*').limit(500) as never,
  'broadcast lookup by id': (c) => c.from('notices').select('id, broadcast_at').in('id', [...NP_IDS, ...Object.values(PUBLIC_IDS)]) as never,
};
const ROLES: Who[] = ['anon', 'A2', 'M', 'A', 'H', 'C', 'B', 'S', 'S2'];
async function matrix(label: string) {
  const leaks: Record<string, string[]> = {}; const errors: string[] = []; const seen: Record<string, Record<string, string[]>> = {};
  for (const who of ROLES) {
    seen[who] = {};
    for (const [name, q] of Object.entries(READS)) {
      const { data, error } = await q(client(who));
      if (error) { errors.push(`${who} / ${name}: ${error.message}`); continue; }
      const ids = (data ?? []).map((r) => r.id); seen[who][name] = ids;
      const l = ids.filter((i) => NP_IDS.includes(i)); if (l.length) (leaks[`${who} / ${name}`] ??= []).push(...l);
    }
  }
  log(`[${label}] reads: ${ROLES.length * Object.keys(READS).length}; errors: ${errors.length}; requests that leaked non-public rows: ${Object.keys(leaks).length}`);
  return { leaks, errors, seen };
}

describe('API 1 - the exposure through real PostgREST, Stage 2 state', () => {
  test('1.1 CONTROL: author / hub owner / committee / business owner / staff receive non-public notices over the real API; anon, member and stranger do not', async () => {
    const { leaks, errors } = await matrix('stage2 (before fix)');
    assert.deepEqual(errors, [], 'every read shape must execute without an API error');
    for (const who of ['anon', 'A2', 'M'] as Who[]) assert.deepEqual(Object.keys(leaks).filter((k) => k.startsWith(`${who} /`)), [], `${who} was never exposed`);
    for (const who of ['A', 'H', 'C', 'B', 'S', 'S2'] as Who[]) assert.ok(Object.keys(leaks).some((k) => k.startsWith(`${who} /`)), `${who} is exposed on the Stage 2 state`);
    log(`[stage2] exposed requests: ${Object.keys(leaks).length} (roles: ${[...new Set(Object.keys(leaks).map((k) => k.split(' / ')[0]))].join(', ')})`);
  });
});

describe('API 2 - after 20261128010000', () => {
  before(async () => {
    const o = pg(rd('supabase/migrations/20261128010000_notices_read_protection.sql')); assert.ok(!failedSql(o), o.slice(0, 600));
    pg(`notify pgrst, 'reload schema'`); await new Promise((s) => setTimeout(s, 1500));
  });

  test('2.1 no role receives any non-public notice from any of the eight read shapes', async () => {
    const { leaks, errors, seen } = await matrix('after fix');
    assert.deepEqual(errors, []); assert.deepEqual(leaks, {});
    for (const who of ROLES) for (const [name, ids] of Object.entries(seen[who])) assert.ok(!ids.some((i) => NP_IDS.includes(i)), `${who}/${name}`);
  });

  test('2.2 audiences intact: public notices for everyone; members-only for members / committee / owner; committee-only for committee / owner', async () => {
    for (const who of ROLES) {
      const { data, error } = await client(who).from('notices').select('id');
      assert.equal(error, null); const ids = (data ?? []).map((r: Row) => r.id);
      for (const k of ['legacy', 'hubPub', 'bizPub', 'platPub', 'personPub'] as const) assert.ok(ids.includes(PUBLIC_IDS[k]), `${who} sees ${k}`);
      assert.equal(ids.includes(PUBLIC_IDS.hubMembers), ['M', 'C', 'H'].includes(who), `${who} members-only`);
      assert.equal(ids.includes(PUBLIC_IDS.hubCommittee), ['C', 'H'].includes(who), `${who} committee-only`);
    }
  });

  test('2.3 the live-notice shape: home queries still return the launch notice with correct content and hub attribution', async () => {
    for (const q of ['app fetchHomeNotices', 'web home notices'] as const) {
      const { data } = await READS[q](client('anon')) as { data: Array<Record<string, unknown>> };
      const n = data.find((r) => r.id === PUBLIC_IDS.legacy)!;
      assert.ok(n, q); assert.equal(n.title, 'OneShetland is getting ready to launch'); assert.equal(n.body, 'Legacy body text'); assert.equal(n.severity, 'info');
      assert.equal((n.hub as { name: string }).name, 'OneShetland', 'publisher attribution through the hub embed'); assert.equal(n.publisher_hub_id, HUB_L);
      assert.equal(new Date(n.published_at as string).toISOString(), '2026-10-04T11:20:42.000Z');
      assert.equal(n.publisher_user_id, null);
    }
  });

  test('2.4 legacy publishing over the API with RETURNING: hub, event, fundraiser, members, business, urgent business, platform (staff), spoof refused', async () => {
    const ins = async (who: Who, row: Record<string, unknown>) => client(who).from('notices').insert(row).select('id,status').single();
    for (const [who, row, what] of [
      ['H', { publisher_hub_id: HUB_V, title: 'h', visibility: 'public' }, 'hub notice'],
      ['H', { publisher_hub_id: HUB_V, title: 'e', event_id: EV_HUB }, 'event-generated notice'],
      ['H', { publisher_hub_id: HUB_V, title: 'f', campaign_id: CAMP_V }, 'fundraiser-generated notice'],
      ['C', { publisher_hub_id: HUB_V, title: 'm', visibility: 'members' }, 'committee members-only notice'],
      ['B', { publisher_business_id: BIZ_B, title: 'b' }, 'business notice'],
      ['V', { publisher_business_id: BIZ_V, title: 'u', severity: 'urgent' }, 'approved-business urgent notice'],
      ['S', { is_platform_notice: true, title: 'p', severity: 'urgent' }, 'staff platform notice'],
    ] as Array<[Who, Record<string, unknown>, string]>) {
      const { data, error } = await ins(who, row); assert.equal(error, null, `${what}: ${error?.message}`); assert.equal(data?.status, 'published', what);
    }
    for (const [who, row, what] of [
      ['A2', { publisher_hub_id: HUB_V, title: 'spoof' }, 'hub spoof'], ['A2', { publisher_business_id: BIZ_B, title: 'spoof' }, 'business spoof'],
      ['B', { publisher_business_id: BIZ_B, title: 'x', severity: 'urgent' }, 'unapproved urgent'], ['H', { publisher_hub_id: HUB_V, title: 'x', severity: 'urgent' }, 'hub urgent'],
      ['A2', { is_platform_notice: true, title: 'x' }, 'platform spoof'],
      ['A2', { is_platform_notice: true, title: 'x', source: 'nhs', source_reference: 'r', source_label: 'NHS Shetland', expires_at: new Date(Date.now() + 864e5).toISOString() }, 'official-source spoof'],
      ['anon', { publisher_hub_id: HUB_V, title: 'x' }, 'anonymous insert'],
    ] as Array<[Who, Record<string, unknown>, string]>) {
      const { error } = await ins(who, row); assert.ok(error, `${what} must be refused`);
    }
    // a trusted import by the service role
    const { error } = await client('service').from('notices').insert({ is_platform_notice: true, title: 'Ferry', source: 'nhs_shetland', source_reference: `r-${Date.now()}`, source_label: 'NHS Shetland', source_url: 'https://x', expires_at: new Date(Date.now() + 864e5).toISOString() }).select('id').single();
    assert.equal(error, null);
  });

  test('2.5 shipped delete and edit shapes: owner deletes a public notice (what both clients do); edits that stay public work; direct hide / withdraw is refused; non-public rows are unreachable', async () => {
    const mk = async (title: string) => { const { data, error } = await client('H').from('notices').insert({ publisher_hub_id: HUB_V, title }).select('id').single(); assert.equal(error, null); return (data as Row).id; };
    const d = await mk('to delete');
    const del = await client('H').from('notices').delete().eq('id', d).select('id'); assert.equal(del.error, null); assert.equal(del.data?.length, 1);
    const e = await mk('to edit');
    const ed = await client('H').from('notices').update({ title: 'edited' }).eq('id', e).select('id,title'); assert.equal(ed.error, null); assert.equal(ed.data?.[0].title, 'edited');
    const w = await client('H').from('notices').update({ status: 'withdrawn' }).eq('id', e); assert.ok(w.error, 'direct withdraw refused'); log(`[direct withdraw] ${w.error?.code} ${w.error?.message}`);
    const h = await client('S').from('notices').update({ is_hidden: true }).eq('id', e); assert.ok(h.error, 'direct hide refused (staff too)'); log(`[direct hide] ${h.error?.code} ${h.error?.message}`);
    for (const who of ['A', 'H', 'C', 'B', 'S', 'A2'] as Who[]) {
      const u = await client(who).from('notices').update({ title: 'hijack' }).in('id', NP_IDS).select('id'); assert.equal(u.data?.length ?? 0, 0, `${who} update`);
      const x = await client(who).from('notices').delete().in('id', NP_IDS).select('id'); assert.equal(x.data?.length ?? 0, 0, `${who} delete`);
    }
    assert.equal(scalar(`select count(*) from notices where id in (${NP_IDS.map((i) => `'${i}'`).join(',')})`), String(NP_IDS.length));
  });

  test('2.6 person insert over the API: without select succeeds as pending; with select is refused (documented); never self-published', async () => {
    const id = '9a000000-0000-4000-8000-000000000001';
    const a = await client('A2').from('notices').insert({ id, is_person_notice: true, title: 'x', status: 'published' }); assert.equal(a.error, null);
    assert.equal(scalar(`select status from notices where id='${id}'`), 'pending');
    const b = await client('A2').from('notices').insert({ is_person_notice: true, title: 'y' }).select('id'); assert.ok(b.error, 'RETURNING of a pending row is refused'); log(`[person insert returning] ${b.error?.code} ${b.error?.message}`);
    const m = await client('A2').rpc('manage_notices', { p_scope: 'mine' }); assert.equal(m.error, null); assert.ok((m.data as Row[]).some((r) => r.id === id));
    scalar(`delete from notices where id='${id}'`);
  });
});

describe('API 3 - management RPCs through PostgREST', () => {
  const rpc = (who: Who, fn: string, args?: Record<string, unknown>) => client(who).rpc(fn, args as never);
  const ids = (d: unknown) => ((d as Row[]) ?? []).map((r) => r.id);
  const HUB_NP = [NP.hubWithdrawn, NP.hubResolved, NP.hubScheduled, NP.hubPending, NP.hubHidden, NP.hubExpired];

  test('3.1 authorised: hub owner + committee (hub), business owner (business), author (mine), staff x2 (all / hub / business)', async () => {
    for (const who of ['H', 'C'] as Who[]) { const r = await rpc(who, 'manage_notices', { p_scope: 'hub', p_id: HUB_V }); assert.equal(r.error, null); for (const i of HUB_NP) assert.ok(ids(r.data).includes(i), `${who} ${i}`); }
    const b = await rpc('B', 'manage_notices', { p_scope: 'business', p_id: BIZ_B }); assert.equal(b.error, null); for (const i of [NP.bizWithdrawn, NP.bizScheduled, NP.bizHidden]) assert.ok(ids(b.data).includes(i));
    const m = await rpc('A', 'manage_notices', { p_scope: 'mine' }); for (const i of [NP.personPending, NP.personWithdrawn, NP.personResolved]) assert.ok(ids(m.data).includes(i));
    for (const who of ['S', 'S2'] as Who[]) { const a = await rpc(who, 'manage_notices', { p_scope: 'all' }); assert.equal(a.error, null); for (const i of NP_IDS) assert.ok(ids(a.data).includes(i), `${who} ${i}`); }
    const f = await rpc('H', 'manage_notices', { p_scope: 'hub', p_id: HUB_V, p_status: 'withdrawn' }); assert.deepEqual(ids(f.data), [NP.hubWithdrawn]);
  });

  test('3.2 denied: strangers, members, other publishers, wrong scope; anonymous cannot call at all; nothing leaks in the error', async () => {
    const denied: Array<[Who, Record<string, unknown>, string]> = [
      ['A2', { p_scope: 'hub', p_id: HUB_V }, 'stranger/hub'], ['M', { p_scope: 'hub', p_id: HUB_V }, 'member/hub'], ['B', { p_scope: 'hub', p_id: HUB_V }, 'bizowner/hub'],
      ['H', { p_scope: 'hub', p_id: HUB_O }, 'owner/other hub'], ['A2', { p_scope: 'business', p_id: BIZ_B }, 'stranger/business'], ['B2', { p_scope: 'business', p_id: BIZ_B }, 'other owner/business'],
      ['H', { p_scope: 'business', p_id: BIZ_B }, 'hub owner/business'], ['A', { p_scope: 'all' }, 'author/all'], ['H', { p_scope: 'all' }, 'owner/all'], ['M', { p_scope: 'all' }, 'member/all'],
    ];
    const msgs = new Set<string>();
    for (const [who, args, what] of denied) { const r = await rpc(who, 'manage_notices', args); assert.ok(r.error, what); assert.equal(r.data, null, `${what}: no rows`); assert.equal(r.error!.code, '42501', what); msgs.add(r.error!.message); assert.ok(!NP_IDS.some((i) => JSON.stringify(r.error).includes(i)), `${what}: error leaks an id`); }
    log(`[manage_notices denial messages] ${[...msgs].join(' | ')}`);
    const ownOnly = await rpc('H', 'manage_notices', { p_scope: 'mine' }); assert.deepEqual(ids(ownOnly.data), [], "'mine' never returns hub notices");
    const strangerMine = await rpc('B', 'manage_notices', { p_scope: 'mine' }); assert.ok(!ids(strangerMine.data).some((i) => NP_IDS.includes(i)));
    for (const fn of [['manage_notices', { p_scope: 'all' }], ['manage_set_notice_status', { p_notice: NP.hubWithdrawn, p_status: 'published' }], ['manage_delete_notice', { p_notice: NP.hubWithdrawn }], ['my_pending_person_notice_count', {}]] as Array<[string, Record<string, unknown>]>) {
      const r = await rpc('anon', fn[0], fn[1]); assert.ok(r.error, `anon ${fn[0]}`); log(`[anon ${fn[0]}] ${r.error!.code} ${r.error!.message}`);
    }
  });

  test('3.3 argument handling: bad uuid, unknown scope / status, missing or extra arguments, huge and negative limits, SQL-looking text', async () => {
    const e = async (who: Who, fn: string, args: Record<string, unknown>) => (await rpc(who, fn, args)).error;
    assert.equal((await e('H', 'manage_notices', { p_scope: 'hub', p_id: 'not-a-uuid' }))?.code, '22P02');
    const unk = await e('H', 'manage_notices', { p_scope: "hub'; drop table notices;--" }); assert.equal(unk?.code, '22023'); assert.ok(!unk!.message.includes('drop table'), 'error does not echo input');
    assert.equal((await e('H', 'manage_notices', { p_scope: 'hub', p_id: HUB_V, p_status: 'nonsense' }))?.code, '22023');
    assert.equal((await e('H', 'manage_notices', {}))?.code, 'PGRST202', 'missing required argument'); assert.equal((await e('H', 'manage_notices', { p_scope: 'mine', p_extra: 1 }))?.code, 'PGRST202', 'extra argument');
    const big = await rpc('S', 'manage_notices', { p_scope: 'all', p_limit: 100000 }); assert.equal(big.error, null); assert.ok((big.data as Row[]).length <= 500);
    const neg = await rpc('S', 'manage_notices', { p_scope: 'all', p_limit: -5 }); assert.equal(neg.error, null); assert.equal((neg.data as Row[]).length, 1);
    assert.equal(scalar(`select count(*) from notices`) !== '0', true, 'table intact');
    assert.equal((await e('H', 'manage_set_notice_status', { p_notice: NP.hubWithdrawn, p_status: 'bogus' }))?.code, '22023');
    assert.equal((await e('H', 'manage_set_notice_status', { p_notice: NP.hubWithdrawn }))?.code, 'PGRST202');
    assert.equal((await e('H', 'manage_set_notice_status', { p_notice: 'x', p_status: 'published' }))?.code, '22P02');
  });

  test('3.4 no id-existence oracle: an unknown id, a foreign id and a platform id are indistinguishable to a non-staff caller (set_status and delete)', async () => {
    const unknown = '00000000-0000-4000-8000-0000000000aa';
    for (const fn of ['manage_set_notice_status', 'manage_delete_notice']) {
      const args = (id: string) => fn === 'manage_delete_notice' ? { p_notice: id } : { p_notice: id, p_status: 'withdrawn' };
      const shapes = new Set<string>();
      for (const id of [unknown, NP.bizWithdrawn, NP.platPending, NP.personPending, PUBLIC_IDS.legacy]) {
        const r = await rpc('A2', fn, args(id)); assert.ok(r.error, `${fn} ${id}`);
        shapes.add(JSON.stringify({ c: r.error!.code, m: r.error!.message, d: r.error!.details, h: r.error!.hint }));
      }
      assert.equal(shapes.size, 1, `${fn}: every refusal looks identical -> ${[...shapes].join(' || ')}`);
    }
  });

  test('3.5 status transitions over the API: staff approve, author withdraws, owner republishes/resolves, forbidden moves refused; approved notice becomes public', async () => {
    const st = (who: Who, id: string, s: string) => rpc(who, 'manage_set_notice_status', { p_notice: id, p_status: s });
    assert.ok((await st('A', NP.personPending, 'published')).error, 'author cannot approve');
    assert.ok((await st('A2', NP.personPending, 'published')).error, 'stranger cannot');
    assert.equal((await st('S2', NP.personPending, 'published')).error, null);
    const pub = await client('anon').from('notices').select('id,title').eq('id', NP.personPending); assert.equal(pub.data?.length, 1, 'approved notice is public over the plain API');
    assert.equal((await st('A', NP.personPending, 'withdrawn')).error, null);
    assert.equal((await client('anon').from('notices').select('id').eq('id', NP.personPending)).data?.length, 0);
    assert.ok((await st('A', NP.personWithdrawn, 'published')).error, 'author cannot republish a withdrawn notice');
    assert.equal((await st('H', NP.hubWithdrawn, 'published')).error, null); assert.equal((await st('H', NP.hubWithdrawn, 'resolved')).error, null);
    assert.ok((await st('H', NP.hubPending, 'published')).error, 'controller cannot lift a staff hold'); assert.ok((await st('H', NP.hubResolved, 'pending')).error, 'nor place in review');
    assert.ok((await st('H', NP.platPending, 'published')).error && (await st('B2', NP.bizWithdrawn, 'published')).error, 'nor touch platform or foreign notices');
    assert.equal((await st('S', NP.platPending, 'published')).error, null);
  });

  test('3.6 delete over the API: managers delete their non-public notices; moderators cannot delete; admin can; strangers cannot', async () => {
    const del = (who: Who, id: string) => rpc(who, 'manage_delete_notice', { p_notice: id });
    assert.ok((await del('A2', NP.personResolved)).error); assert.equal((await del('A', NP.personResolved)).error, null);
    assert.equal((await del('H', NP.hubHidden)).error, null); assert.ok((await del('H', NP.bizHidden)).error); assert.equal((await del('B', NP.bizHidden)).error, null);
    assert.ok((await del('S2', NP.platExpired)).error, 'moderator cannot delete'); assert.equal((await del('S', NP.platExpired)).error, null);
  });

  test('3.7 helper functions over the API: anon can read a label only for a public person notice; unknown ids learn nothing; display of a non-public notice is null', async () => {
    const label = async (who: Who, u: string) => (await rpc(who, 'notice_person_label', { p_user: u })).data;
    assert.equal(await label('anon', U.A), 'Ann', 'A has an approved public notice'); assert.equal(await label('anon', U.A2), 'A OneShetland member'); assert.equal(await label('anon', '00000000-0000-4000-8000-0000000000ff'), 'A OneShetland member');
    pg(`update notices set status='pending' where id='${PUBLIC_IDS.personPub}'`);
    assert.equal(await label('anon', U.A), 'A OneShetland member', 'no public notice now'); assert.equal(await label('A', U.A), 'Ann', 'self'); assert.equal(await label('S', U.A), 'Ann', 'staff');
    for (const who of ['anon', 'A', 'S'] as Who[]) assert.equal((await rpc(who, 'notice_publisher_display', { p_notice: PUBLIC_IDS.personPub })).data, null, `${who}: display of non-public`);
    pg(`update notices set status='published' where id='${PUBLIC_IDS.personPub}'`);
    assert.equal(((await rpc('anon', 'notice_publisher_display', { p_notice: PUBLIC_IDS.legacy })).data as { label: string }).label, 'OneShetland');
    assert.equal((await rpc('anon', 'can_edit_notice', { p_notice: PUBLIC_IDS.hubPub })).data, false); assert.equal((await rpc('H', 'can_edit_notice', { p_notice: PUBLIC_IDS.hubPub })).data, true);
    assert.equal((await rpc('H', 'can_edit_notice', { p_notice: '00000000-0000-4000-8000-0000000000aa' })).data, false);
  });

  test('3.8 grants: exactly which roles can execute every Stage 2 / 3A function (as recorded by the catalog)', () => {
    const rows = pg(`select p.proname || ':' || coalesce((select string_agg(r.rolname, ',' order by r.rolname) from pg_roles r where r.rolname in ('anon','authenticated','service_role') and has_function_privilege(r.oid, p.oid, 'execute')), '-') || ':public=' || (has_function_privilege('public', p.oid, 'execute'))::text
      from pg_proc p where pronamespace='public'::regnamespace and proname in ('manage_notices','manage_set_notice_status','manage_delete_notice','my_pending_person_notice_count','can_edit_notice','notice_person_label','notice_publisher_display','tg_notices_attribution_guard','tg_notices_lifecycle','tg_notice_areas_validate') order by 1`).trim().split('\n');
    for (const r of rows) log(`[grant] ${r}`);
    const g = Object.fromEntries(rows.map((r) => { const [n, roles] = r.split(':'); return [n, roles]; }));
    for (const f of ['manage_notices', 'manage_set_notice_status', 'manage_delete_notice', 'my_pending_person_notice_count']) assert.equal(g[f], 'authenticated,service_role', f);
    for (const f of ['can_edit_notice', 'notice_person_label', 'notice_publisher_display']) assert.equal(g[f], 'anon,authenticated,service_role', f);
  });
});

describe('API 4 - Stage 3A.2: the NEW reader helpers through real PostgREST (explicit filters, independent of RLS)', () => {
  const pubMod = loadModule('lib/notice-publisher.ts'); const feed = loadModule('lib/notice-feed.ts', { './notice-publisher': pubMod }) as any;
  const eligibleSql = `status = 'published' and (starts_at is null or starts_at <= now()) and (expires_at is null or expires_at > now())`;

  test('4.1 the SERVICE ROLE bypasses RLS, yet the helper alone returns only published, started, unexpired rows (two or() filters are both honoured)', async () => {
    const q = feed.applyPublicNoticeFilters(client('service').from('notices').select('id').eq('is_hidden', false).eq('visibility', 'public').limit(500));
    const { data, error } = await q; assert.equal(error, null, error?.message);
    const got = (data as Row[]).map((r) => r.id).sort();
    const want = pg(`select id from notices where is_hidden = false and visibility = 'public' and ${eligibleSql} order by id`).trim().split('\n').filter(Boolean).sort();
    assert.deepEqual(got, want, 'exactly the eligible public rows');
    const everything = Number(scalar(`select count(*) from notices where is_hidden = false and visibility = 'public'`));
    assert.ok(everything > got.length, `RLS-free table holds ${everything} public non-hidden rows, helper returned ${got.length}: the filter, not RLS, removed the rest`);
    assert.ok(!got.some((i) => NP_IDS.includes(i) && scalar(`select (${eligibleSql})::text from notices where id='${i}'`) !== 'true'));
  });

  test('4.2 the app reader shapes with the helper return the live-notice attribution over the API (hub embed incl. brand colour, business embed with id)', async () => {
    const home = await feed.applyPublicNoticeFilters(client('anon').from('notices').select(`id, severity, title, body, publisher_business_id, publisher_user_id, publisher_hub_id, campaign_id, event_id,
      ${feed.NOTICE_PUBLISHER_COLUMNS}, hub:hubs ( id, name, logo_url, brand_color ), business:local_businesses ( id, name, logo_url, brand_color ),
      campaign:hub_campaigns ( id, raised_pence, goal_pence, donor_count, status ), event:events ( id, title, starts_at, venue, cover_url, has_tickets, calendar_approved )`)
      .eq('is_hidden', false).eq('visibility', 'public')).order('published_at', { ascending: false }).limit(40);
    assert.equal(home.error, null, home.error?.message);
    const rows = home.data as Row[]; const legacy = rows.find((r) => r.id === PUBLIC_IDS.legacy)!; assert.ok(legacy);
    const a = feed.attributionFor(legacy);
    assert.deepEqual([a.kind, a.label, a.byline, a.destination.type, a.destination.id], ['hub', 'OneShetland', 'Posted by OneShetland', 'hub', HUB_L]);
    const biz = rows.find((r) => r.id === PUBLIC_IDS.bizPub)!; const ab = feed.attributionFor(biz);
    assert.deepEqual([ab.kind, ab.label, ab.destination.type, ab.destination.id], ['business', 'Bea Bakery', 'business', BIZ_B]);
    const plat = feed.attributionFor(rows.find((r) => r.id === PUBLIC_IDS.platPub)!); assert.deepEqual([plat.kind, plat.label, plat.byline], ['platform', 'OneShetland', 'Posted by OneShetland']);
    assert.ok(rows.every((r) => feed.attributionFor(r).label !== 'Member'));
  });

  test('4.3 person names through the real RPC: an approved public notice releases the name, a pending / withdrawn one never does', async () => {
    pg(`update notices set status='published', is_hidden=false, starts_at=null, expires_at=null, visibility='public' where id='${PUBLIC_IDS.personPub}'`);
    const rpcOf = (who: Who) => (fn: string, args: Record<string, unknown>) => client(who).rpc(fn, args as never) as never;
    const lookup = (who: Who, rows: unknown) => feed.loadPersonNames(rpcOf(who), rows, { cache: null });   // no cache: this test flips the notice's state between calls
    const rows = [{ id: PUBLIC_IDS.personPub, publisher_kind: 'person', publisher_user_id: U.A }];
    assert.deepEqual(await lookup('anon', rows), { [PUBLIC_IDS.personPub]: 'Ann' });
    pg(`update notices set status='pending' where id='${PUBLIC_IDS.personPub}'`);
    for (const who of ['anon', 'A2', 'H'] as Who[]) {
      const n = await lookup(who, rows);
      assert.equal(feed.attributionFor(rows[0], n).label, 'A OneShetland member', `${who}: pending notice does not disclose the name`);
    }
    pg(`update notices set status='withdrawn' where id='${PUBLIC_IDS.personPub}'`);
    assert.equal(feed.attributionFor(rows[0], await lookup('anon', rows)).label, 'A OneShetland member');
    pg(`update notices set status='published' where id='${PUBLIC_IDS.personPub}'`);
  });

  test('4.4 members-only and committee-only visibility is unchanged for the hub reader shape (helper adds no visibility filter)', async () => {
    const read = async (who: Who) => (await feed.applyPublicNoticeFilters(client(who).from('notices').select('id').eq('publisher_hub_id', HUB_V).eq('is_hidden', false)).limit(100)).data.map((r: Row) => r.id);
    assert.ok(!(await read('anon')).includes(PUBLIC_IDS.hubMembers)); assert.ok((await read('M')).includes(PUBLIC_IDS.hubMembers)); assert.ok(!(await read('M')).includes(PUBLIC_IDS.hubCommittee));
    assert.ok((await read('C')).includes(PUBLIC_IDS.hubCommittee)); assert.ok((await read('H')).includes(PUBLIC_IDS.hubMembers));
  });
});
