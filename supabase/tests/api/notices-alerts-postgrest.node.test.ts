/**
 * notices-alerts-postgrest.node.test.ts — Notices & Alerts verified through the REAL API layer (PostgREST + supabase-js): who may call what, with production's
 * default function privileges, for both PostgREST versions. Local Docker only (see run-notices-alerts-api.sh); never near production.
 *
 * PROVES at the API: the public reads work for a signed-out visitor (named and array arguments, area semantics); every administrator, publisher and
 * dispatch function is refused to the wrong caller with a permission error; the new tables are unreadable; an administrator-granted publisher can publish an
 * essential alert end to end and it appears for anonymous readers and disappears on revocation; a member can set areas / opt-ins and submit a funeral notice;
 * the service role (and only it) can reach the dispatch machinery, and an official import is refused there; and the READ SHAPES the released apps and the live
 * website use are unchanged and leak nothing non-public — including essential alerts that are resolved and funeral notices that are unapproved.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const rd = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const IMAGE = process.env.POSTGREST_IMAGE ?? 'public.ecr.aws/supabase/postgrest:v14.5';
const PG = 'notices-alerts-pg', REST = 'notices-alerts-rest', NET = 'notices-alerts-proof';
const PORT_BASE = Number(process.env.API_PORT_BASE ?? 54801), REST_PORT = PORT_BASE + 1, PROXY_PORT = PORT_BASE + 2, SECRET = 'a-proof-only-secret-that-is-at-least-32-characters-long';
const docker = (args: string[], input?: string) => spawnSync('docker', args, { input, encoding: 'utf8', timeout: 300_000 });
const psql = (user: string, sql: string) => { const r = docker(['exec', '-i', PG, 'psql', '-U', user, '-h', 'localhost', '-d', 'postgres', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'], sql); return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(); };
const pg = (sql: string) => psql('postgres', sql);
const scalar = (sql: string) => (pg(sql).split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '');
const failedSql = (o: string) => /ERROR/.test(o);

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: object) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ iss: 'proof', exp: Math.floor(Date.now() / 1000) + 3600, ...claims }); return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`; };
const U = { A: 'a0000000-0000-4000-8000-0000000000a1', B: 'b0000000-0000-4000-8000-0000000000b1', H: 'd0000000-0000-4000-8000-0000000000d1', P: 'f0000000-0000-4000-8000-0000000000f1', D: 'f0000000-0000-4000-8000-0000000000f2', S: 'e0000000-0000-4000-8000-0000000000e1', O: 'e0000000-0000-4000-8000-0000000000e2' };
type Who = keyof typeof U | 'anon' | 'service';
const ANON = jwt({ role: 'anon' });
const tokenFor = (who: Who) => who === 'anon' ? ANON : who === 'service' ? jwt({ role: 'service_role' }) : jwt({ role: 'authenticated', aud: 'authenticated', sub: U[who] });
let proxy: http.Server;
const startProxy = () => new Promise<void>((resolve) => {
  proxy = http.createServer((req, res) => {
    const up = http.request({ host: '127.0.0.1', port: REST_PORT, path: (req.url ?? '').replace(/^\/rest\/v1/, '') || '/', method: req.method, headers: { ...req.headers, host: `127.0.0.1:${REST_PORT}` } }, (r) => { res.writeHead(r.statusCode ?? 500, r.headers); r.pipe(res); });
    up.on('error', () => { res.statusCode = 502; res.end(); }); req.pipe(up);
  }).listen(PROXY_PORT, '127.0.0.1', resolve);
});
const client = (who: Who) => createClient(`http://127.0.0.1:${PROXY_PORT}`, ANON, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${tokenFor(who)}` } } });
const rpc = (who: Who, fn: string, args: Record<string, unknown> = {}) => client(who).rpc(fn, args);
const denied = (e: { code?: string; message?: string } | null) => !!e && (/^(42501|PGRST301|PGRST302)$/.test(e.code ?? '') || /permission denied|not authori[sz]ed|Platform administrators only|Staff only/i.test(e.message ?? ''));

const exp = (h: number) => new Date(Date.now() + h * 3600e3).toISOString();
const HUB_V = 'dd000000-0000-4000-8000-0000000000dd';
const LOG: string[] = [];
let COUNCIL = '';

before(async () => {
  assert.ok(docker(['ps', '--filter', `name=${PG}`, '--format', '{{.Names}}']).stdout.includes(PG), `container ${PG} must be running (run-notices-alerts-api.sh starts it)`);
  let o = psql('supabase_admin', `alter role authenticator with password 'proofpw';
    create or replace function auth.uid() returns uuid language sql stable as $f$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $f$;`);
  assert.ok(!failedSql(o), o);
  o = pg(`drop schema if exists public cascade; create schema public; grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated;
    alter default privileges for role postgres in schema public revoke truncate on tables from anon, authenticated;`);
  assert.ok(!failedSql(o), o);
  o = pg(rd('supabase/tests/_support/attribution-prefix-schema.sql').split('\n').slice(15).join('\n')); assert.ok(!failedSql(o), `prefix: ${o.slice(0, 500)}`);
  o = pg(`
    create function public.is_admin() returns boolean language sql stable security definer set search_path to 'public' as $$ select exists (select 1 from public.profiles where id = auth.uid() and (role = 'admin' or is_platform_owner = true)); $$;
    grant execute on function public.is_admin() to anon, authenticated, service_role;
    grant execute on function public.is_hub_admin(uuid, uuid), public.is_hub_member(uuid, uuid) to anon, authenticated, service_role;
    alter table notices add column lat numeric, add column lng numeric; alter table profiles add column display_name text; alter table profiles add column location_area text; alter table profiles add column deleted_at timestamptz; alter table profiles add column is_active boolean not null default true;
    alter table hubs add column logo_url text, add column brand_color text; alter table local_businesses add column logo_url text, add column brand_color text;
    create table regions (id uuid primary key default gen_random_uuid(), slug text unique not null, name text not null, display_order int);
    create table jobs (id uuid primary key default gen_random_uuid(), title text, locality text, location text);
    create table runs (id uuid primary key default gen_random_uuid(), origin_region_id uuid references regions(id), destination_region_id uuid references regions(id));
    create table delivery_requests (id uuid primary key default gen_random_uuid(), destination_region_id uuid references regions(id), destination_address text);
    insert into profiles (id, role, display_name) values ('${U.A}','customer','Ann'), ('${U.B}','customer','Bea'), ('${U.H}','customer','Hal'), ('${U.P}','customer','Pat (Council)'),
      ('${U.D}','customer','Dee (Council)'), ('${U.S}','admin','Staff'), ('${U.O}','moderator','Mod');
    alter table hubs disable trigger tg_zz_lock_hub_columns;
    insert into hubs (id, owner_id, name, slug, is_verified, payout_enabled) values ('${HUB_V}','${U.H}','Voe Hall','voe',true,true);
    alter table hubs enable trigger tg_zz_lock_hub_columns;
    insert into notices (publisher_hub_id, severity, title, body, visibility) values ('${HUB_V}','info','OneShetland is getting ready to launch','Legacy body','public');`);
  assert.ok(!failedSql(o), `setup: ${o.slice(0, 600)}`);
  const migs = ['20261121000000_event_notice_attribution', '20261127000000_canonical_geography_foundation', '20261127010000_geography_alias_ambiguity', '20261128000000_notices_structural_readiness', '20261128010000_notices_read_protection',
    ...readdirSync(join(ROOT, 'supabase/migrations')).filter((f) => /^20261129\d{6}_.*\.sql$/.test(f)).sort().map((f) => f.replace(/\.sql$/, ''))];
  for (const m of migs) { o = pg(rd(`supabase/migrations/${m}.sql`)); assert.ok(!failedSql(o), `${m}: ${o.slice(0, 700)}`); }
  docker(['rm', '-f', REST]);
  const r = docker(['run', '-d', '--name', REST, '--network', NET, '-p', `127.0.0.1:${REST_PORT}:3000`, '-e', `PGRST_DB_URI=postgres://authenticator:proofpw@${PG}:5432/postgres`, '-e', 'PGRST_DB_SCHEMAS=public',
    '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${SECRET}`, '-e', 'PGRST_DB_POOL=4', IMAGE]);
  assert.equal(r.status, 0, r.stderr);
  for (let i = 0; i < 40; i++) { try { const x = await fetch(`http://127.0.0.1:${REST_PORT}/`, { headers: { apikey: ANON } }); if (x.status < 500) break; } catch { /* starting */ } await new Promise((s) => setTimeout(s, 500)); }
  await startProxy(); LOG.push(`PostgREST image: ${IMAGE}`);
});
after(() => { proxy?.close(); docker(['rm', '-f', REST]); console.log('\n' + LOG.join('\n')); });

describe('who may call what, through the API', () => {
  test('1 the public reads work signed out, with named and array arguments, and return only public rows (nothing yet)', async () => {
    for (const [fn, args] of [['get_essential_alerts', {}], ['get_essential_alerts', { p_area_ids: ['voe'] }], ['get_public_notices', { p_level: 'all', p_limit: 5 }], ['get_funeral_notices', {}], ['get_public_notices', { p_area_ids: [] }]] as const) {
      const { data, error } = await rpc('anon', fn, args as never); assert.equal(error, null, `${fn}: ${error?.message}`); assert.ok(Array.isArray(data), fn);
    }
    assert.equal(((await rpc('anon', 'get_public_notices', { p_level: 'community' })).data as unknown[]).length, 1, 'the legacy hub notice');
    assert.equal(((await rpc('anon', 'get_essential_alerts')).data as unknown[]).length, 0);
  });
  test('2 administrator, publisher, member and dispatch functions are refused to the wrong caller (anonymous, member, hub owner, moderator, delegate)', async () => {
    const adminFns = ['admin_list_official_publishers', 'admin_notice_audit', 'admin_import_status'];
    for (const who of ['anon', 'A', 'H', 'O', 'P'] as const) for (const fn of adminFns) { const { error } = await rpc(who, fn); assert.ok(denied(error), `${who} ${fn}: ${error?.message}`); }
    for (const fn of ['notice_dispatch_recipients', 'notice_claim_dispatch', 'notice_dispatchable', 'can_dispatch_notice', 'notice_record_delivery', 'import_start_run', 'funeral_dispatch_recipients', 'can_dispatch_funeral']) {
      for (const who of ['anon', 'A', 'S'] as const) { const { error } = await rpc(who, fn, {}); assert.ok(error, `${who} ${fn} must not be callable`); assert.ok(denied(error) || /Could not find the function|PGRST202/.test(`${error.code} ${error.message}`), `${who} ${fn}: ${error?.code} ${error?.message}`); }
    }
    for (const t of ['official_publishers', 'official_publisher_members', 'essential_alert_grants', 'notice_audit_log', 'notice_deliveries', 'notice_dispatches', 'member_areas', 'notice_notification_prefs', 'funeral_notices', 'funeral_change_requests', 'notice_import_sources']) {
      const { error } = await client('anon').from(t).select('*').limit(1); assert.ok(denied(error), `anon ${t}: ${error?.message}`);
    }
    assert.ok(denied((await client('S').from('official_publishers').select('*').limit(1)).error), 'even an administrator reads the tables only through the functions');
    assert.ok(denied((await rpc('anon', 'set_my_notice_areas', { p_areas: ['voe'] })).error));
    assert.ok((await rpc('A', 'official_publish_notice', { p_publisher: '00000000-0000-4000-8000-000000000000', p_title: 'Hello there', p_body: 'x'.repeat(30), p_category: 'other', p_area_ids: ['shetland_wide'], p_expires_at: new Date(Date.now() + 86400e3).toISOString() })).error);
  });
});

describe('end to end: entitlement, an essential alert, revocation', () => {
  test('3 an administrator creates and verifies the organisation, adds a publisher and a delegate, and grants the entitlement — all through the API', async () => {
    let r = await rpc('S', 'admin_upsert_official_publisher', { p_slug: 'council-demo', p_name: 'Council (demo)', p_kind: 'council' }); assert.equal(r.error, null, r.error?.message); COUNCIL = r.data as string;
    assert.equal((await rpc('S', 'admin_verify_official_publisher', { p_publisher: COUNCIL, p_note: 'Verified by call-back to the published number' })).error, null);
    assert.equal((await rpc('S', 'admin_set_official_publisher_member', { p_publisher: COUNCIL, p_user: U.P, p_role: 'publisher' })).error, null);
    assert.equal((await rpc('S', 'admin_set_official_publisher_member', { p_publisher: COUNCIL, p_user: U.D, p_role: 'delegate' })).error, null);
    r = await rpc('S', 'admin_grant_essential_alert', { p_publisher: COUNCIL, p_reason: 'Approved first publisher' }); assert.equal(r.error, null, r.error?.message);
    assert.equal(((await rpc('P', 'my_official_publishers')).data as { can_essential: boolean }[])[0].can_essential, true);
    assert.equal(((await rpc('D', 'my_official_publishers')).data as { can_essential: boolean }[])[0].can_essential, false);
    assert.equal(((await rpc('A', 'my_official_publishers')).data as unknown[]).length, 0);
  });
  const essential = (extra: Record<string, unknown> = {}) => ({ p_publisher: COUNCIL, p_title: 'A970 closed at Voe junction', p_body: 'The A970 is closed at the Voe junction following a landslip. Use the Delting route.', p_category: 'travel_transport',
    p_area_ids: ['voe', 'brae'], p_expires_at: exp(48), p_action_text: 'Use the Delting route and allow extra time.', p_is_essential: true, p_review_at: exp(12), ...extra });
  let ALERT = '';
  test('4 the publisher issues an Essential Alert; anonymous readers see it (area-filtered correctly); the delegate and an outsider cannot issue one', async () => {
    const r = await rpc('P', 'official_publish_notice', essential()); assert.equal(r.error, null, r.error?.message); ALERT = r.data as string;
    const all = (await rpc('anon', 'get_essential_alerts')).data as { id: string; publisher: { byline: string } }[];
    assert.deepEqual(all.map((a) => a.id), [ALERT]); assert.equal(all[0].publisher.byline, 'Issued by Council (demo)');
    assert.equal(((await rpc('anon', 'get_essential_alerts', { p_area_ids: ['voe'] })).data as unknown[]).length, 1);
    assert.equal(((await rpc('anon', 'get_essential_alerts', { p_area_ids: ['lerwick'] })).data as unknown[]).length, 0);
    assert.equal(((await rpc('anon', 'get_essential_alerts', { p_area_ids: [] })).data as unknown[]).length, 0);
    assert.match((await rpc('D', 'official_publish_notice', essential({ p_title: 'Delegate essential try' }))).error?.message ?? '', /cannot issue Essential Alerts/);
    assert.ok((await rpc('A', 'official_publish_notice', essential({ p_title: 'Outsider essential try' }))).error);
    const direct = await client('H').from('notices').insert({ publisher_hub_id: HUB_V, title: 'Fake essential', body: 'long enough body for a constraint', is_essential: true });
    assert.ok(direct.error, 'a client can never write is_essential directly');
  });
  test('5 an old client read of the notices table sees the alert exactly as an urgent platform notice, with no new field it must understand; resolving removes it everywhere', async () => {
    const old = await client('anon').from('notices').select('id, severity, title, body, publisher_hub_id, publisher_business_id, hub:hubs(id, name, logo_url, brand_color)').eq('is_hidden', false).eq('visibility', 'public').order('published_at', { ascending: false });
    assert.equal(old.error, null, old.error?.message);
    const row = (old.data as { id: string; severity: string }[]).find((r) => r.id === ALERT)!; assert.equal(row.severity, 'urgent');
    assert.equal((await rpc('P', 'official_set_notice_status', { p_notice: ALERT, p_status: 'resolved' })).error, null);
    assert.equal(((await rpc('anon', 'get_essential_alerts')).data as unknown[]).length, 0);
    assert.equal(((await client('anon').from('notices').select('id').eq('id', ALERT)).data as unknown[]).length, 0, 'a resolved alert is not readable from the table by a released build');
  });
  test('6 revoking the entitlement demotes a live alert to an ordinary official notice (still readable), and the publisher can no longer issue one', async () => {
    const live = (await rpc('P', 'official_publish_notice', essential({ p_title: 'Second alert for revocation' }))).data as string;
    const n = await rpc('S', 'admin_revoke_essential_alert', { p_publisher: COUNCIL, p_reason: 'Contact left the Council' }); assert.equal(n.error, null); assert.ok((n.data as number) >= 1);
    assert.equal(((await rpc('anon', 'get_essential_alerts')).data as unknown[]).length, 0);
    const l2 = (await rpc('anon', 'get_public_notices', { p_level: 'official' })).data as { id: string; level: number }[];
    assert.equal(l2.find((x) => x.id === live)?.level, 2);
    assert.match((await rpc('P', 'official_publish_notice', essential({ p_title: 'Third alert refused' }))).error?.message ?? '', /cannot issue Essential Alerts/);
  });
});

describe('members, funeral notices, and the service-role path', () => {
  test('7 a member sets areas and opt-ins (default off, areas alone change nothing) and reads them back', async () => {
    assert.deepEqual((await rpc('A', 'set_my_notice_areas', { p_areas: ['voe', 'brae'] })).data, ['brae', 'voe']);
    assert.equal(((await rpc('A', 'my_notice_prefs')).data as { essential_alerts: boolean }).essential_alerts, false);
    assert.equal(((await rpc('A', 'set_my_notice_prefs', { p_essential: true })).data as { essential_alerts: boolean }).essential_alerts, true);
    assert.match((await rpc('A', 'set_my_notice_areas', { p_areas: ['shetland_wide'] })).error?.message ?? '', /real Shetland areas/);
    assert.deepEqual((await client('B').from('member_areas').select('area_id')).data, [], 'another member sees none of A\'s areas');
  });
  test('8 funeral: a member submits; it is not public; staff verify and approve; only then does the public function show it, without any private field', async () => {
    const sub = await rpc('A', 'submit_funeral_notice', { p: { full_name: 'Test Demoson', submitter_name: 'Jo Demoson', submitter_phone: '01595 000000', family_authorised: true, announcement: 'Peacefully at home.', area_id: 'voe', service_public: true, service_kind: 'funeral', service_venue: 'Voe Kirk (demo)' } });
    assert.equal(sub.error, null, sub.error?.message); const id = sub.data as string;
    assert.equal(((await rpc('anon', 'get_funeral_notices')).data as unknown[]).length, 0);
    assert.ok(denied((await rpc('A', 'admin_funeral_review', { p_id: id, p_action: 'approve', p_note: 'x', p_verification_method: 'phone_callback' })).error));
    assert.match((await rpc('O', 'admin_funeral_review', { p_id: id, p_action: 'approve' })).error?.message ?? '', /Record how/);
    assert.equal((await rpc('O', 'admin_funeral_review', { p_id: id, p_action: 'approve', p_note: 'Called back and confirmed', p_verification_method: 'phone_callback' })).error, null);
    const shown = (await rpc('anon', 'get_funeral_notices')).data as Record<string, unknown>[];
    assert.equal(shown.length, 1); assert.equal(shown[0].full_name, 'Test Demoson');
    assert.ok(!JSON.stringify(shown).match(/submitter|01595|phone|verification/i));
    assert.equal(((await client('anon').from('notices').select('id,title').ilike('title', '%Demoson%')).data as unknown[]).length, 0, 'never in the notices table a released build reads');
  });
  test('9 the dispatch machinery is reachable by the service role only, and refuses an official import through the API', async () => {
    const ordinary = (await rpc('P', 'official_publish_notice', { p_publisher: COUNCIL, p_title: 'Routine service notice', p_body: 'A routine service announcement for everyone.', p_category: 'public_services', p_area_ids: ['shetland_wide'], p_expires_at: exp(240) })).data as string;
    const reason = await rpc('service', 'notice_dispatchable', { p_notice: ordinary, p_kind: 'official' }); assert.equal(reason.error, null); assert.equal(reason.data, null, 'an ordinary official notice is announceable to the official audience');
    pg(`insert into notices (id, is_platform_notice, source, source_reference, source_label, source_url, expires_at, title, body) values ('f9000000-0000-4000-8000-000000000001', true,'sic','1','Council','https://www.shetland.gov.uk/a', now()+interval '3 day','Imported','Imported summary text.')`);
    for (const k of ['essential', 'official', 'community', 'hub']) assert.match(String((await rpc('service', 'notice_dispatchable', { p_notice: 'f9000000-0000-4000-8000-000000000001', p_kind: k })).data), /never announced/, k);
    assert.match((await rpc('service', 'notice_claim_dispatch', { p_notice: 'f9000000-0000-4000-8000-000000000001', p_kind: 'official' })).error?.message ?? '', /never announced/);
  });
  test('9b the single-notice read, the organisation list and the funeral edit read behave through the API', async () => {
    const live = (await rpc('anon', 'get_public_notices', { p_level: 'community', p_limit: 1 })).data as { id: string }[];
    assert.equal(((await rpc('anon', 'get_public_notice', { p_id: live[0].id })).data as unknown[]).length, 1);
    assert.equal(((await rpc('anon', 'get_public_notice', { p_id: '00000000-0000-4000-8000-000000000000' })).data as unknown[]).length, 0);
    const own = await rpc('P', 'my_official_notices', { p_publisher: COUNCIL }); assert.equal(own.error, null, own.error?.message); assert.ok((own.data as unknown[]).length >= 1);
    for (const who of ['anon', 'A', 'H'] as const) assert.ok((await rpc(who, 'my_official_notices', { p_publisher: COUNCIL })).error, who);
    const mine = (await rpc('A', 'my_funeral_submissions')).data as { id: string }[]; assert.ok(mine.length >= 1);
    assert.ok((await rpc('A', 'my_funeral_submission', { p_id: mine[0].id })).data);
    assert.equal((await rpc('H', 'my_funeral_submission', { p_id: mine[0].id })).data, null, 'only the submitter');
  });
  test('10 the released-build and live-website read shapes are unchanged and leak nothing non-public (pending person, withdrawn, unapproved funeral, resolved alert, members-only)', async () => {
    pg(`insert into notices (is_person_notice, publisher_user_id, title, body, status) values (true,'${U.A}','NEVER pending person','b','pending');
        insert into notices (publisher_hub_id, title, body, status) values ('${HUB_V}','NEVER withdrawn','b','withdrawn');
        insert into notices (publisher_hub_id, title, body, visibility) values ('${HUB_V}','NEVER members only','b','members');`);
    const shapes = [
      () => client('anon').from('notices').select('id, severity, title, body, publisher_hub_id, hub:hubs(id, name, logo_url, brand_color), business:local_businesses(name, logo_url)').eq('is_hidden', false).eq('visibility', 'public').order('is_pinned', { ascending: false }).order('published_at', { ascending: false }).limit(20),
      () => client('anon').from('notices').select('id, title, body, published_at, severity, hub:hubs(id, name, logo_url, slug)').eq('visibility', 'public').order('published_at', { ascending: false }).limit(4),
      () => client('anon').from('notices').select('id, publisher_hub_id, title, body, severity, visibility, image_url, is_pinned, expires_at, published_at').eq('publisher_hub_id', HUB_V).order('published_at', { ascending: false }),
      () => client('A').from('notices').select('*').order('published_at', { ascending: false }),
    ];
    for (const [i, s] of shapes.entries()) { const { data, error } = await s(); assert.equal(error, null, `shape ${i}: ${error?.message}`); assert.ok(!(data as { title: string }[]).some((r) => /NEVER/.test(r.title)), `shape ${i} leaked a non-public notice`); }
    assert.equal(((await rpc('anon', 'get_public_notices', { p_level: 'all', p_limit: 50 })).data as { title: string }[]).filter((r) => /NEVER|Demoson/.test(r.title)).length, 0);
    LOG.push('reads: released-build shapes unchanged; 0 non-public rows in any read');
  });
});
