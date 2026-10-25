/**
 * fetch-v2-access-boundary.node.test.ts — Fetch v2 access and privacy boundary (migration 20261129000000), against the real SQL.
 *
 * Every earlier migration (including Steps 0 and 1) is replayed into a private database with realistic state — regions, approved,
 * suspended and unrelated drivers, open/past runs with notes, a v1 request and v2 jobs at every stage of their privacy windows —
 * then Step 2 is applied. It proves, per audience:
 *   PUBLIC       sees only fetch_public_runs(): broad regions, date, part of day, size, categories; no driver, ids, notes, times,
 *                registrations; nothing at all from the raw tables; and only when the Fetch v2 audience admits them
 *   UNASSIGNED   an approved driver sees the matching board (region/village, item, size, timing, pay) and nothing private; raw table
 *                and detail calls give nothing
 *   ASSIGNED     gets operational detail through the detail call: addresses for 72h after close, history for 30 days, the phone only
 *                if shared and only while the job is live; never the raw row
 *   REQUESTER    gets their own job through the detail call; cannot write anything directly
 *   OTHER        member: nothing
 *   ADMIN        reads everything, writes nothing directly
 *   WAITING      no client can create or change a waiting event, so no client can manufacture a waiting fee
 * plus: exactly the intended v1 policies and grants are retired and nothing else in OneShetland changes; v1 behaviours that stop
 * are pinned; mutation controls show each protection is load-bearing; the rollback restores the catalogue exactly.
 *
 * SAFETY — ISOLATED DATABASE ONLY (PASS_PROOF_DSN). Fake users; no Stripe; nothing near production.
 * Run: ISOLATED_ONLY=fetch-v2-access-boundary npm run test:isolated
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX_NAME = '20261129000000_fetch_v2_access_boundary.sql';
const FIX = join(REPO_ROOT, 'supabase/migrations', FIX_NAME);
const DOWN = join(REPO_ROOT, 'supabase/rollbacks/20261129000000_fetch_v2_access_boundary.down.sql');

let db: ReplayDb;
const tag = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !tag.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT|^NOTICE/.test(l));
const lastRow = (o: string) => rowsOf(o).pop() ?? '';
const scalar = (sql: string) => lastRow(db.raw(sql));
const ok = (o: string) => assert.doesNotMatch(o, /ERROR/, o);
const fails = (o: string, re: RegExp = /ERROR/) => assert.match(o, re, o);

const ids = {
  ADMIN: 'ad000000-0000-4000-8000-0000000000ad',
  REQ: 'a1000000-0000-4000-8000-000000000001',
  REQ2: 'a2000000-0000-4000-8000-000000000002',
  DRV_A: 'da000000-0000-4000-8000-00000000000a',   // assigned to the accepted/closed jobs
  DRV_B: 'db000000-0000-4000-8000-00000000000b',   // approved, unrelated
  DRV_S: 'dc000000-0000-4000-8000-00000000000c',   // suspended
  MEMBER: 'e1000000-0000-4000-8000-000000000004',
} as const;
type Who = keyof typeof ids | 'anon';
const roleSql = (w: Who) => (w === 'anon' ? 'set local role anon;' : `set local request.jwt.claim.sub = '${ids[w]}'; set local role authenticated;`);
const tryAs = (w: Who, sql: string) => db.raw(`begin; ${roleSql(w)} ${sql}; rollback;`);
const count = (w: Who, table: string, where = 'true') => Number(lastRow(tryAs(w, `select count(*) from ${table} where ${where}`)));
const denied = (o: string) => /permission denied/i.test(o);
const setAudience = (v: string) => ok(db.raw(`update public.admin_config set value = '${v}' where key = 'fetch.v2.audience'`));

const R = {
  V1: '10000000-0000-4000-8000-000000000001',
  OPEN: '20000000-0000-4000-8000-000000000001',
  ACC: '20000000-0000-4000-8000-000000000002',
  ACC_SHARED: '20000000-0000-4000-8000-000000000003',
  CLOSED_2D: '20000000-0000-4000-8000-000000000004',
  CLOSED_10D: '20000000-0000-4000-8000-000000000005',
  CLOSED_40D: '20000000-0000-4000-8000-000000000006',
} as const;
const RUN = { OPEN: '30000000-0000-4000-8000-000000000001', PAST: '30000000-0000-4000-8000-000000000002', SUSP: '30000000-0000-4000-8000-000000000003' };
const PHOTO = { MATCH: '40000000-0000-4000-8000-000000000001', PRIVATE: '40000000-0000-4000-8000-000000000002' };

// Fixture strings that must never leak to the wrong audience.
const SECRET = {
  pickupName: 'Mrs Isbister at Westerloch', pickupLocation: '7 Westerloch, Brae ZE2 9QJ', pickupNotes: 'Key under the blue pot',
  destAddress: '12 Hillhead, Lerwick ZE1 0EJ', deliveryNotes: 'Gate code 4471', phone: '07700 900123', safePlace: 'Behind the peat stack',
  runNote: 'Leaving from my house at 5 Voe Road', vehicleReg: 'SN71 ABC',
};
const region = (slug: string) => `(select id from public.regions where slug = '${slug}')`;
const v2Insert = (o: Record<string, string> = {}) => {
  const base: Record<string, string> = {
    id: 'gen_random_uuid()', customer_id: `'${ids.REQ}'`, pickup_name: `'${SECRET.pickupName}'`, pickup_location: `'${SECRET.pickupLocation}'`,
    pickup_notes: `'${SECRET.pickupNotes}'`, destination_address: `'${SECRET.destAddress}'`, delivery_notes: `'${SECRET.deliveryNotes}'`,
    contact_phone: `'${SECRET.phone}'`, safe_place_allowed: 'true', safe_place_note: `'${SECRET.safePlace}'`,
    destination_region_id: region('lerwick'), destination_area: `'Hillhead'`, pickup_region_id: region('north-mainland'), pickup_area: `'Brae'`,
    fetch_version: '2', item_description: `'Two-seat sofa, grey'`, size_class: `'bulky'`, approx_dimensions_cm: `'{"l":190,"w":85,"h":80}'`,
    handling_flags: `'{heavy_two_person}'`, pickup_island_group: `'mainland'`, dest_island_group: `'mainland'`,
    ferry_required: 'false', ferry_supplement_pence: '0', base_fee_pence: '910', category_slug: `'other'`, status: `'pending'`,
  };
  const row = { ...base, ...o };
  return `insert into public.delivery_requests (${Object.keys(row).join(', ')}) values (${Object.values(row).join(', ')})`;
};
const assigned = (extra: Record<string, string> = {}) => ({
  driver_id: `'${ids.DRV_A}'`, claimed_at: 'now()', vehicle_confirmed_at: 'now()', status: `'matched'`, payment_status: `'authorised'`, ...extra,
});
const closed = (days: number) => assigned({ status: `'delivered'`, payment_status: `'captured'`, collected_at: `now() - interval '${days + 1} days'`, delivered_at: `now() - interval '${days} days'` });

const catalogueRows = (where = 'true'): string[] => {
  const o = db.raw(`select x from (
    select 'col:' || c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') as x, c.relname as t
      from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
    union all select 'con:' || conrelid::regclass || ':' || conname || ':' || pg_get_constraintdef(oid), conrelid::regclass::text from pg_constraint where connamespace = 'public'::regnamespace
    union all select 'pol:' || schemaname || '.' || tablename || ':' || policyname || ':' || permissive || ':' || roles::text || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), tablename::text from pg_policies where schemaname in ('public', 'storage')
    union all select 'trg:' || tgrelid::regclass || ':' || tgname, tgrelid::regclass::text from pg_trigger where not tgisinternal and tgrelid::regclass::text not like 'pg_%'
    union all select 'fn:' || p.oid::regprocedure || ':' || md5(p.prosrc) || ':' || coalesce((select string_agg(a::text, ',' order by a::text) from unnest(p.proacl) a), ''), '' from pg_proc p where p.pronamespace = 'public'::regnamespace
    union all select 'tbl:' || relname || ':' || relrowsecurity || ':' || coalesce((select string_agg(a::text, ',' order by a::text) from unnest(relacl) a), ''), relname::text from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'v')
    union all select 'cfg:' || key || '=' || value, 'admin_config' from public.admin_config where key <> 'fetch.v2.audience'
  ) s where ${where} order by x`);
  assert.doesNotMatch(o, /ERROR/, o);
  return rowsOf(o).filter((l) => !/^x$|^-+$|^\(\d+ rows?\)$/.test(l));
};
const catalogue = (where = 'true') => { const r = catalogueRows(where); assert.ok(r.length > 100, 'catalogue unexpectedly small'); return r.join('\n'); };
// Everything outside the Fetch tables and functions this step is allowed to touch.
const OUTSIDE_FETCH = `t not in ('delivery_requests', 'waiting_events', 'runs', 'fetch_request_photos', 'admin_config') and x not like 'fn:fetch_%' and x not like 'fn:fetch_public_runs%'`;

const S: Record<string, string> = {};
let beforeRows: string[] = [];
let beforeOutsideRows: string[] = [];
const setDiff = (want: string[], got: string[]) => ({ missing: want.filter((x) => !got.includes(x)), extra: got.filter((x) => !want.includes(x)) });

before(() => {
  db = createReplayDb('fetchv2access', { stopBefore: FIX_NAME });
  const all = Object.values(ids).map((i) => `'${i}'::uuid`).join(',');
  const slugs = ['lerwick', 'scalloway', 'central-mainland', 'south-mainland', 'west-mainland', 'north-mainland', 'northmavine', 'bressay', 'burra',
    'trondra', 'muckle-roe', 'whalsay', 'yell', 'unst', 'fetlar', 'out-skerries', 'fair-isle'];
  ok(db.raw(`
    insert into auth.users (id, email) select x, 'u' || substr(x::text,1,4) || '@example.org' from unnest(array[${all}]) x on conflict do nothing;
    insert into public.profiles (id, full_name) select x, 'Fixture ' || substr(x::text,1,4) from unnest(array[${all}]) x on conflict (id) do nothing;
    update public.profiles set full_name = 'Ann Tulloch' where id = '${ids.DRV_A}';
    update public.profiles set full_name = 'Morag Isbister' where id = '${ids.REQ}';
    update public.profiles set role = 'admin' where id = '${ids.ADMIN}';
    insert into public.regions (slug, name, display_order) select s, initcap(replace(s, '-', ' ')), o from unnest(array[${slugs.map((s) => `'${s}'`).join(',')}]) with ordinality t(s, o);
    update public.regions set island_group = case when slug in ('bressay','whalsay','yell','unst','fetlar') then slug when slug = 'out-skerries' then 'out_skerries' when slug = 'fair-isle' then 'fair_isle' else 'mainland' end;
    insert into public.delivery_pricing_config (price_per_mile_pence, min_fee_pence, road_correction_factor) values (65, 400, 1.40);
    insert into public.driver_profiles (id, driver_status, vehicle_type, vehicle_reg, vehicle_class, max_size_class, stripe_onboarding_complete, stripe_payouts_enabled) values
      ('${ids.DRV_A}', 'approved', 'Van', '${SECRET.vehicleReg}', 'van', 'bulky', true, true),
      ('${ids.DRV_B}', 'approved', 'Car', 'SN12 XYZ', 'car', 'large', true, true),
      ('${ids.DRV_S}', 'suspended', 'Car', 'SN13 XYZ', 'car', 'large', true, true);
    insert into public.runs (id, driver_id, origin_region_id, destination_region_id, departure_start, departure_end, categories_accepted, notes, max_size_class, status) values
      ('${RUN.OPEN}', '${ids.DRV_B}', ${region('lerwick')}, ${region('yell')}, date_trunc('day', now() + interval '2 days') + interval '14 hours', date_trunc('day', now() + interval '2 days') + interval '17 hours', '{small-parcel}', '${SECRET.runNote}', 'large', 'open'),
      ('${RUN.PAST}', '${ids.DRV_B}', ${region('lerwick')}, ${region('scalloway')}, now() - interval '2 days', now() - interval '1 day', '{}', null, null, 'open'),
      ('${RUN.SUSP}', '${ids.DRV_S}', ${region('lerwick')}, ${region('unst')}, now() + interval '1 day', now() + interval '1 day 3 hours', '{}', null, null, 'open');
    insert into public.delivery_requests (id, customer_id, pickup_name, pickup_location, destination_address, contact_phone, destination_region_id)
      values ('${R.V1}', '${ids.REQ2}', 'Co-op', 'Lerwick', '1 Old Street, Lerwick', '07700 900999', ${region('lerwick')});
    ${v2Insert({ id: `'${R.OPEN}'` })};
    ${v2Insert({ id: `'${R.ACC}'`, ...assigned() })};
    ${v2Insert({ id: `'${R.ACC_SHARED}'`, share_phone_with_driver: 'true', ...assigned() })};
    ${v2Insert({ id: `'${R.CLOSED_2D}'`, share_phone_with_driver: 'true', ...closed(2) })};
    ${v2Insert({ id: `'${R.CLOSED_10D}'`, ...closed(10) })};
    ${v2Insert({ id: `'${R.CLOSED_40D}'`, ...closed(40) })};
    insert into public.fetch_request_photos (id, request_id, kind, storage_path, created_by) values
      ('${PHOTO.MATCH}', '${R.OPEN}', 'item', 'requests/${R.OPEN}/item/11111111-1111-4111-8111-111111111111.jpg', '${ids.REQ}'),
      ('${PHOTO.PRIVATE}', '${R.OPEN}', 'item', 'requests/${R.OPEN}/item/22222222-2222-4222-8222-222222222222.jpg', '${ids.REQ}');
    insert into public.fetch_messages (request_id, sender_id, sender_role, body) values
      ('${R.CLOSED_2D}', '${ids.REQ}', 'requester', 'It is the house with the red door'),
      ('${R.CLOSED_10D}', '${ids.REQ}', 'requester', 'Thanks!'), ('${R.CLOSED_40D}', '${ids.REQ}', 'requester', 'Old thanks');
    insert into public.fetch_request_photos (request_id, kind, storage_path, created_by) values
      ('${R.CLOSED_2D}', 'delivery', 'requests/${R.CLOSED_2D}/delivery/55555555-5555-4555-8555-555555555555.jpg', '${ids.DRV_A}'),
      ('${R.CLOSED_10D}', 'delivery', 'requests/${R.CLOSED_10D}/delivery/66666666-6666-4666-8666-666666666666.jpg', '${ids.DRV_A}'),
      ('${R.CLOSED_40D}', 'delivery', 'requests/${R.CLOSED_40D}/delivery/77777777-7777-4777-8777-777777777777.jpg', '${ids.DRV_A}');
    insert into storage.objects (bucket_id, name) values
      ('fetch-photos', 'requests/${R.CLOSED_10D}/delivery/66666666-6666-4666-8666-666666666666.jpg'),
      ('fetch-photos', 'requests/${R.CLOSED_40D}/delivery/77777777-7777-4777-8777-777777777777.jpg');
    insert into public.fetch_issues (request_id, reporter_id, reporter_role, kind, detail)
      values ('${R.CLOSED_40D}', '${ids.REQ}', 'requester', 'damaged', 'Reported late; still being investigated');
    insert into public.fetch_request_events (request_id, actor_id, actor_role, event, from_status, to_status)
      values ('${R.CLOSED_10D}', '${ids.DRV_A}', 'driver', 'delivered', 'collected', 'delivered');
    grant select, insert, update, delete on storage.objects to authenticated;`));
  S.before = catalogue();
  beforeRows = catalogueRows();
  beforeOutsideRows = catalogueRows(OUTSIDE_FETCH);
  S.apply = db.rawFile(FIX);
  ok(S.apply);
  S.after = catalogue();
  ok(db.raw(`update public.fetch_request_photos set matching_visible = true where id = '${PHOTO.MATCH}'`));
  setAudience('everyone');
});
after(() => { db?.drop(); });

const detail = (w: Who, id: string) => tryAs(w, `select public.fetch_v2_request_detail('${id}')`);
const detailJson = (w: Who, id: string) => { const o = detail(w, id); ok(o); return JSON.parse(lastRow(o)); };

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('0 · migration, windows and what was retired', () => {
  test('applies over the full history incl. Steps 0–1 (with v2 data already present); re-applying changes nothing', () => {
    assert.notEqual(S.after, S.before);
    ok(db.rawFile(FIX));
    assert.equal(catalogue(), S.after);
  });
  test('nothing outside the Fetch tables and functions changed', () => {
    assert.deepEqual(setDiff(beforeOutsideRows, catalogueRows(OUTSIDE_FETCH)), { missing: [], extra: [] });
  });
  test('the single 30-day window became two: participant history 30 days, exact addresses 72 hours', () => {
    assert.equal(scalar(`select string_agg(key || '=' || value, ',' order by key) from public.admin_config where key like 'fetch.timeouts.%'`),
      'fetch.timeouts.cancel_request_secs=7200,fetch.timeouts.exact_address_secs=259200,fetch.timeouts.issue_window_secs=259200,fetch.timeouts.participant_history_secs=2592000,fetch.timeouts.payment_needed_secs=7200');
    assert.equal(scalar(`select public.fetch_v2_timeout_secs('exact_address_secs') || ':' || public.fetch_v2_timeout_secs('participant_history_secs')`), '259200:2592000');
    fails(db.raw(`select public.fetch_v2_timeout_secs('address_access_secs')`), /unknown Fetch timeout/);
  });
  test('exactly the v1 policies were retired, and the kept ones remain', () => {
    const pols = (t: string) => scalar(`select string_agg(policyname || '/' || permissive || '/' || cmd, ',' order by policyname) from pg_policies where schemaname='public' and tablename='${t}'`);
    assert.equal(pols('delivery_requests'), [
      'Admins read all requests/PERMISSIVE/SELECT',
      'Customers can read their own requests/PERMISSIVE/SELECT',
      'Fetch v2 requests: administrators only (direct reads)/RESTRICTIVE/SELECT',
      'Fetch v2 requests: server writes only (delete)/RESTRICTIVE/DELETE',
      'Fetch v2 requests: server writes only (insert)/RESTRICTIVE/INSERT',
      'Fetch v2 requests: server writes only (update)/RESTRICTIVE/UPDATE',
    ].join(','));
    assert.equal(pols('runs'), 'Admins can read all runs/PERMISSIVE/SELECT,Drivers can read their own runs/PERMISSIVE/SELECT');
    assert.equal(pols('waiting_events'), [
      'Admins read all waiting events/PERMISSIVE/SELECT',
      'Customers can view waiting events for their requests/PERMISSIVE/SELECT',
      'Drivers can read their own waiting events/PERMISSIVE/SELECT',
      'Fetch v2 waiting events: parties read/RESTRICTIVE/SELECT',
      'Fetch v2 waiting events: server writes only (delete)/RESTRICTIVE/DELETE',
      'Fetch v2 waiting events: server writes only (insert)/RESTRICTIVE/INSERT',
      'Fetch v2 waiting events: server writes only (update)/RESTRICTIVE/UPDATE',
    ].join(','));
  });
  test('grants: anon has nothing on the three tables; authenticated may only SELECT; the service role keeps everything', () => {
    for (const t of ['delivery_requests', 'runs', 'waiting_events']) {
      assert.equal(scalar(`select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where table_name = '${t}' and grantee = 'anon'`), '', t);
      assert.equal(scalar(`select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where table_name = '${t}' and grantee = 'authenticated'`), 'SELECT', t);
      assert.equal(scalar(`select count(*) from information_schema.role_table_grants where table_name = '${t}' and grantee = 'service_role'`), '7', t);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('1 · PUBLIC — signed-out visitors', () => {
  const runsAs = (w: Who) => tryAs(w, `select coalesce(json_agg(r), '[]') from public.fetch_public_runs() r`);
  test('cannot touch the raw tables at all', () => {
    for (const t of ['delivery_requests', 'runs', 'waiting_events']) assert.ok(denied(tryAs('anon', `select count(*) from public.${t}`)), t);
  });
  test('see open, upcoming journeys of approved drivers only — not past runs, not a suspended driver\'s', () => {
    const rows = JSON.parse(lastRow(runsAs('anon')));
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.deepEqual(Object.keys(r).sort(), ['categories', 'crosses_water', 'departure_date', 'destination_island_group', 'destination_region',
      'max_size_class', 'origin_island_group', 'origin_region', 'part_of_day', 'run_key'].sort());
    assert.equal(`${r.origin_region}→${r.destination_region}:${r.part_of_day}:${r.max_size_class}:${r.crosses_water}`, 'Lerwick→Yell:afternoon:large:true');
  });
  test('nothing identifies the driver or the run: no ids, notes, registration, name or exact times', () => {
    const out = lastRow(runsAs('anon'));
    for (const s of [ids.DRV_B, RUN.OPEN, SECRET.runNote, 'SN12', 'Fixture', 'T14:', ':00:00']) assert.ok(!out.includes(s), `leaked ${s}`);
    assert.equal(scalar(`select count(*) from public.runs where md5(id::text) = '${JSON.parse(out)[0].run_key}' or id::text = '${JSON.parse(out)[0].run_key}'`), '0');
  });
  test('honours the Fetch v2 audience: hidden from anon until everyone; admitted testers see it earlier', () => {
    setAudience('testers');
    assert.equal(lastRow(runsAs('anon')), '[]');
    assert.equal(lastRow(runsAs('MEMBER')), '[]');
    assert.equal(JSON.parse(lastRow(runsAs('ADMIN'))).length, 1);
    setAudience('off');
    assert.equal(lastRow(runsAs('ADMIN')), '[]');
    setAudience('everyone');
  });
  test('cannot use the board or the detail call', () => {
    assert.ok(denied(tryAs('anon', 'select * from public.fetch_v2_board()')));
    assert.ok(denied(tryAs('anon', `select public.fetch_v2_request_detail('${R.OPEN}')`)));
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('2 · UNASSIGNED DRIVER — the matching board and nothing more', () => {
  const board = (w: Who) => tryAs(w, `select coalesce(json_agg(b), '[]') from public.fetch_v2_board() b`);
  test('the board lists open v2 jobs with only matching-safe fields', () => {
    const rows = JSON.parse(lastRow(board('DRV_B')));
    assert.deepEqual(rows.map((r: { request_id: string }) => r.request_id), [R.OPEN]);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['approx_dimensions_cm', 'category_slug', 'created_at', 'dest_island_group', 'destination_area',
      'destination_region', 'driver_pay_pence', 'expires_at', 'ferry_required', 'flexible_until', 'handling_flags', 'item_description',
      'matching_photo_ids', 'needed_by', 'pickup_area', 'pickup_island_group', 'pickup_region', 'request_id', 'scheduling_mode', 'size_class'].sort());
    assert.equal(`${rows[0].pickup_region}/${rows[0].pickup_area}→${rows[0].destination_region}/${rows[0].destination_area}:${rows[0].driver_pay_pence}`,
      'North Mainland/Brae→Lerwick/Hillhead:910');
  });
  test('no address, phone, notes, pickup name, safe-place note or requester identity anywhere in the board', () => {
    const out = lastRow(board('DRV_B'));
    for (const s of [SECRET.pickupName, SECRET.pickupLocation, SECRET.pickupNotes, SECRET.destAddress, SECRET.deliveryNotes, SECRET.phone,
      SECRET.safePlace, ids.REQ, 'Morag', 'Isbister']) assert.ok(!out.includes(s), `leaked ${s}`);
  });
  test('only a photo the requester marked for matching is listed', () => {
    assert.deepEqual(JSON.parse(lastRow(board('DRV_B')))[0].matching_photo_ids, [PHOTO.MATCH]);
    fails(db.raw(`update public.fetch_request_photos set matching_visible = true where kind <> 'item' or false; insert into public.fetch_request_photos (request_id, kind, storage_path, matching_visible)
      values ('${R.ACC}', 'delivery', 'requests/${R.ACC}/delivery/33333333-3333-4333-8333-333333333333.jpg', true)`), /matching_item_only/);
  });
  test('raw table and detail call give an unassigned driver nothing', () => {
    assert.equal(count('DRV_B', 'public.delivery_requests', `fetch_version = 2`), 0);
    for (const id of [R.OPEN, R.ACC]) fails(detail('DRV_B', id), /Fetch request not found/);
  });
  test('only approved drivers may browse; members and suspended drivers are refused; so is anyone while Fetch v2 is off', () => {
    fails(board('MEMBER'), /Only approved Fetch drivers/);
    fails(board('DRV_S'), /Only approved Fetch drivers/);
    setAudience('off');
    fails(board('DRV_B'), /Fetch is not available/);
    setAudience('everyone');
  });
  test('a driver never sees their own request on the board', () => {
    const o = db.raw(`begin; update public.delivery_requests set customer_id = '${ids.DRV_B}' where id = '${R.OPEN}';
      ${roleSql('DRV_B')} select count(*) from public.fetch_v2_board(); rollback;`);
    assert.equal(lastRow(o), '0');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('3 · ASSIGNED DRIVER — operational detail through the detail call, within the windows', () => {
  test('never the raw row', () => {
    assert.equal(count('DRV_A', 'public.delivery_requests'), 0);
  });
  test('live job, phone NOT shared: addresses and instructions yes, phone no (the key is absent, not empty)', () => {
    const d = detailJson('DRV_A', R.ACC);
    assert.equal(d.viewer, 'driver');
    assert.equal(`${d.request.pickup_location} | ${d.request.destination_address} | ${d.request.pickup_notes} | ${d.request.delivery_notes} | ${d.request.safe_place_note}`,
      `${SECRET.pickupLocation} | ${SECRET.destAddress} | ${SECRET.pickupNotes} | ${SECRET.deliveryNotes} | ${SECRET.safePlace}`);
    assert.ok(!('contact_phone' in d.request));
    assert.ok(!JSON.stringify(d).includes(SECRET.phone));
    assert.equal(d.phone_shared, false);
    assert.equal(d.request.requester_first_name, 'Morag');
  });
  test('live job, phone shared: the phone is included', () => {
    const d = detailJson('DRV_A', R.ACC_SHARED);
    assert.equal(d.request.contact_phone, SECRET.phone);
    assert.equal(d.phone_shared, true);
  });
  test('closed 2 days ago (shared): addresses still visible, phone gone', () => {
    const d = detailJson('DRV_A', R.CLOSED_2D);
    assert.equal(d.addresses_visible, true);
    assert.equal(d.request.destination_address, SECRET.destAddress);
    assert.ok(!JSON.stringify(d).includes(SECRET.phone));
  });
  test('closed 10 days ago: the job history remains, every address, note and instruction is gone', () => {
    const d = detailJson('DRV_A', R.CLOSED_10D);
    assert.equal(d.addresses_visible, false);
    assert.equal(`${d.request.status}:${d.request.item_description}:${d.request.destination_area}`, 'delivered:Two-seat sofa, grey:Hillhead');
    const out = JSON.stringify(d);
    for (const s of [SECRET.pickupName, SECRET.pickupLocation, SECRET.pickupNotes, SECRET.destAddress, SECRET.deliveryNotes, SECRET.safePlace, SECRET.phone])
      assert.ok(!out.includes(s), `leaked ${s}`);
  });
  test('messages and evidence photos stay with the participants for the 30-day history window — longer than addresses', () => {
    for (const t of ['fetch_messages', 'fetch_request_photos']) {
      assert.equal(count('DRV_A', `public.${t}`, `request_id = '${R.CLOSED_2D}'`), 1, `${t} 2d`);
      assert.equal(count('DRV_A', `public.${t}`, `request_id = '${R.CLOSED_10D}'`), 1, `${t} 10d`);
      assert.equal(count('DRV_A', `public.${t}`, `request_id = '${R.CLOSED_40D}'`), 0, `${t} 40d`);
    }
    assert.equal(count('DRV_A', 'storage.objects', `name like 'requests/${R.CLOSED_10D}/%'`), 1);
    assert.equal(count('DRV_A', 'public.fetch_request_events', `request_id = '${R.CLOSED_10D}'`), 1);
    // …while the same 10-day-old job no longer shows the driver its addresses
    assert.equal(detailJson('DRV_A', R.CLOSED_10D).addresses_visible, false);
  });
  test('participant visibility is not admin retention: an unresolved issue holds the evidence for administrators after the window', () => {
    assert.equal(count('DRV_A', 'storage.objects', `name like 'requests/${R.CLOSED_40D}/%'`), 0);
    assert.equal(count('ADMIN', 'public.fetch_messages', `request_id = '${R.CLOSED_40D}'`), 1);
    assert.equal(count('ADMIN', 'public.fetch_request_photos', `request_id = '${R.CLOSED_40D}'`), 1);
    assert.equal(count('ADMIN', 'storage.objects', `name like 'requests/${R.CLOSED_40D}/%'`), 1);
    assert.equal(scalar(`set role service_role; select public.fetch_v2_evidence_held('${R.CLOSED_40D}') || ':' || public.fetch_v2_evidence_held('${R.CLOSED_10D}')`), 'true:false');
    assert.equal(scalar(`begin; update public.fetch_issues set status = 'resolved', resolution = 'Refunded', resolved_at = now(); set local role service_role; select public.fetch_v2_evidence_held('${R.CLOSED_40D}'); rollback;`), 'f');
    for (const w of ['DRV_A', 'REQ', 'ADMIN', 'anon'] as Who[]) assert.ok(denied(tryAs(w, `select public.fetch_v2_evidence_held('${R.CLOSED_40D}')`)), w);
  });
  test('closed 40 days ago: nothing — not the job, not its messages', () => {
    fails(detail('DRV_A', R.CLOSED_40D), /Fetch request not found/);
    assert.equal(count('DRV_A', 'public.fetch_messages', `request_id = '${R.CLOSED_40D}'`), 0);
  });
  test('the windows are configurable', () => {
    const o = db.raw(`begin; update public.admin_config set value = '86400' where key = 'fetch.timeouts.exact_address_secs';
      ${roleSql('DRV_A')} select (public.fetch_v2_request_detail('${R.CLOSED_2D}') ->> 'addresses_visible'); rollback;`);
    assert.equal(lastRow(o), 'false');
  });
  test('never sees the requester\'s account id, payment ids, coordinates or the admin override reason', () => {
    const out = JSON.stringify(detailJson('DRV_A', R.ACC));
    for (const k of ['customer_id', 'payment_intent_id', 'pickup_lat', 'dest_lat', 'resolution_override_reason', 'resolved_by']) assert.ok(!out.includes(`"${k}"`), k);
    assert.ok(!out.includes(ids.REQ));
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('4 · REQUESTER, OTHER MEMBER, ADMIN', () => {
  test('the requester gets their whole job (incl. their own phone and notes) and the driver\'s first name — through the call, not the table', () => {
    const d = detailJson('REQ', R.ACC);
    assert.equal(d.viewer, 'requester');
    assert.equal(`${d.request.contact_phone} | ${d.request.delivery_notes}`, `${SECRET.phone} | ${SECRET.deliveryNotes}`);
    assert.deepEqual(d.request.driver, { first_name: 'Ann', vehicle_class: 'van' });
    const out = JSON.stringify(d);
    for (const k of ['driver_id', 'customer_id', 'resolution_override_reason', 'resolved_by']) assert.ok(!out.includes(`"${k}"`), k);
    assert.ok(!out.includes(ids.DRV_A) && !out.includes(SECRET.vehicleReg));
    assert.equal(count('REQ', 'public.delivery_requests', 'fetch_version = 2'), 0);
  });
  test('the requester can still read their own v1 history directly', () => {
    assert.equal(count('REQ2', 'public.delivery_requests', `id = '${R.V1}'`), 1);
  });
  test('another member gets nothing, with the same answer as for a job that does not exist', () => {
    fails(detail('MEMBER', R.ACC), /Fetch request not found/);
    fails(detail('MEMBER', '99999999-9999-4999-8999-999999999999'), /Fetch request not found/);
    assert.equal(count('MEMBER', 'public.delivery_requests'), 0);
  });
  test('admin reads everything (table and call) and writes nothing directly', () => {
    assert.equal(count('ADMIN', 'public.delivery_requests'), 7);
    assert.equal(detailJson('ADMIN', R.ACC).request.contact_phone, SECRET.phone);
    for (const t of ['delivery_requests', 'runs', 'waiting_events'])
      assert.ok(denied(tryAs('ADMIN', `update public.${t} set updated_at = now()`)) || denied(tryAs('ADMIN', `delete from public.${t}`)), t);
    assert.ok(denied(tryAs('ADMIN', `update public.delivery_requests set status = 'cancelled' where id = '${R.V1}'`)));
  });
  test('the detail call is refused while Fetch v2 is off for the caller', () => {
    setAudience('admins');
    fails(detail('REQ', R.ACC), /Fetch is not available/);
    ok(detail('ADMIN', R.ACC));
    setAudience('everyone');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('5 · no client writes anywhere; v1 behaviours that stop', () => {
  test('nobody can insert, update or delete requests, runs or waiting events from a client', () => {
    for (const w of ['REQ', 'REQ2', 'DRV_A', 'DRV_B', 'MEMBER', 'ADMIN', 'anon'] as Who[]) {
      assert.ok(denied(tryAs(w, `insert into public.delivery_requests (customer_id, pickup_name, pickup_location, destination_address) values ('${ids.REQ}', 'x', 'y', 'z')`)), `${w} insert request`);
      assert.ok(denied(tryAs(w, `update public.delivery_requests set ready_for_collection = true`)), `${w} update request`);
      assert.ok(denied(tryAs(w, `insert into public.runs (driver_id, departure_start, departure_end) values ('${ids.DRV_B}', now(), now())`)), `${w} insert run`);
      assert.ok(denied(tryAs(w, `update public.runs set notes = 'x'`)), `${w} update run`);
    }
  });
  test('WAITING TIME: no client can create or alter a waiting event, on a v1 or a v2 job', () => {
    for (const w of ['DRV_A', 'DRV_B', 'REQ', 'ADMIN', 'anon'] as Who[]) {
      for (const id of [R.V1, R.ACC]) {
        assert.ok(denied(tryAs(w, `insert into public.waiting_events (request_id, driver_id, arrived_at) values ('${id}', '${ids.DRV_A}', now() - interval '3 hours')`)), `${w} ${id}`);
      }
      assert.ok(denied(tryAs(w, `update public.waiting_events set arrived_at = now() - interval '3 hours'`)), w);
    }
  });
  test('v1 behaviours that stop: an approved driver no longer reads other people\'s pending v1 requests; run drivers no longer read through runs', () => {
    assert.equal(count('DRV_B', 'public.delivery_requests', `id = '${R.V1}'`), 0);
    const o = db.raw(`begin; update public.delivery_requests set run_id = '${RUN.OPEN}', status = 'matched' where id = '${R.V1}';
      ${roleSql('DRV_B')} select count(*) from public.delivery_requests where id = '${R.V1}'; rollback;`);
    assert.equal(lastRow(o), '0');
  });
  test('a driver still reads their own runs (raw), and admins all runs', () => {
    assert.equal(count('DRV_B', 'public.runs'), 2);
    assert.equal(count('ADMIN', 'public.runs'), 3);
    assert.equal(count('MEMBER', 'public.runs'), 0);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('6 · mutation controls (each protection is load-bearing)', () => {
  test('reopening raw SELECT for the assigned driver would hand them the phone they were not given', () => {
    const o = db.raw(`begin; drop policy "Fetch v2 requests: administrators only (direct reads)" on public.delivery_requests;
      create policy leak on public.delivery_requests for select to authenticated using (driver_id = auth.uid());
      ${roleSql('DRV_A')} select contact_phone from public.delivery_requests where id = '${R.ACC}'; rollback;`);
    assert.equal(lastRow(o), SECRET.phone);
  });
  test('without the share check, the phone would reach the driver on an unshared job', () => {
    const o = db.raw(`begin; update public.delivery_requests set share_phone_with_driver = true where id = '${R.ACC}';
      ${roleSql('DRV_A')} select public.fetch_v2_request_detail('${R.ACC}') -> 'request' ->> 'contact_phone'; rollback;`);
    assert.equal(lastRow(o), SECRET.phone);
  });
  test('restoring the old public runs policy and grant would expose the driver and their notes to anyone', () => {
    const o = db.raw(`begin; grant select on public.runs to anon; create policy "Open runs are publicly readable" on public.runs for select using (status = 'open');
      set local role anon; select driver_id || ' / ' || notes from public.runs where id = '${RUN.OPEN}'; rollback;`);
    assert.equal(lastRow(o), `${ids.DRV_B} / ${SECRET.runNote}`);
  });
  test('restoring the legacy driver read + accept policies and grant would let a driver change a job directly', () => {
    const o = db.raw(`begin; grant update on public.delivery_requests to authenticated;
      create policy "Approved drivers can read all pending requests" on public.delivery_requests for select
        using (status = 'pending' and exists (select 1 from public.driver_profiles dp where dp.id = auth.uid() and dp.driver_status = 'approved'));
      create policy "Drivers must have bank connected to accept requests" on public.delivery_requests for update using (true);
      ${roleSql('DRV_B')} update public.delivery_requests set ready_for_collection = true where id = '${R.V1}'; reset role;
      select ready_for_collection from public.delivery_requests where id = '${R.V1}'; rollback;`);
    assert.equal(lastRow(o), 't');
  });
  test('reopening waiting-event inserts would let a driver manufacture three hours of waiting', () => {
    const o = db.raw(`begin; grant insert on public.waiting_events to authenticated;
      create policy "Drivers can insert their own waiting events" on public.waiting_events for insert with check (auth.uid() = driver_id);
      ${roleSql('DRV_B')} insert into public.waiting_events (request_id, driver_id, arrived_at) values ('${R.V1}', '${ids.DRV_B}', now() - interval '3 hours'); reset role;
      select count(*) from public.waiting_events where driver_id = '${ids.DRV_B}'; rollback;`);
    assert.equal(lastRow(o), '1');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('7 · rollback', () => {
  test('refuses while a photo is marked for matching, changing nothing', () => {
    fails(db.rawFile(DOWN), /refusing to roll back the access boundary/);
    assert.equal(catalogue(), S.after);
  });
  test('otherwise restores the catalogue exactly; the migration then re-applies', () => {
    ok(db.raw(`update public.fetch_request_photos set matching_visible = false`));
    ok(db.rawFile(DOWN));
    assert.deepEqual(setDiff(beforeRows, catalogueRows()), { missing: [], extra: [] });
    assert.equal(catalogue(), S.before);
    ok(db.rawFile(FIX));
    assert.equal(catalogue(), S.after);
  });
});
