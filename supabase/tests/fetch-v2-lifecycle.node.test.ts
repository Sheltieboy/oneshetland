/**
 * fetch-v2-lifecycle.node.test.ts — the Fetch v2 lifecycle server actions (migration 20261130000000), against the real SQL.
 *
 * Every earlier migration (incl. Steps 0–2) is replayed into a private database with regions, live pricing, approved / unverified /
 * suspended / smaller-vehicle drivers, categories and the Fetch v2 audience open. Then Step 3 is applied and every action is
 * driven as the real caller would drive it: CLIENT actions as `authenticated` with a JWT subject, SERVICE actions as
 * `service_role` with the actor the edge function would pass. It proves create, claim (incl. a real two-session race), release,
 * cancellation in all three phases, collection with server-measured waiting time, delivery, cannot-deliver → return → resolution,
 * admin actions, runs, the single state machine, idempotency, the audit trail, response privacy, the requester's long-term history,
 * mutation controls and an exact rollback.
 *
 * Time is moved by back-dating server-written timestamps as the superuser (never through an action), which is how "the driver has
 * been waiting 12 minutes" is simulated without sleeping.
 *
 * SAFETY — ISOLATED DATABASE ONLY (PASS_PROOF_DSN). Fake users; no Stripe; nothing near production.
 * Run: ISOLATED_ONLY=fetch-v2-lifecycle npm run test:isolated
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX_NAME = '20261130000000_fetch_v2_lifecycle.sql';
const FIX = join(REPO_ROOT, 'supabase/migrations', FIX_NAME);
const DOWN = join(REPO_ROOT, 'supabase/rollbacks/20261130000000_fetch_v2_lifecycle.down.sql');

let db: ReplayDb;
const tag = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !tag.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT|^NOTICE/.test(l));
const lastRow = (o: string) => rowsOf(o).pop() ?? '';
const scalar = (sql: string) => lastRow(db.raw(sql));
const ok = (o: string) => assert.doesNotMatch(o, /ERROR/, o);
const fails = (o: string, re: RegExp = /ERROR/) => assert.match(o, re, o);
const denied = (o: string) => /permission denied/i.test(o);

const ids = {
  ADMIN: 'ad000000-0000-4000-8000-0000000000ad',
  REQ: 'a1000000-0000-4000-8000-000000000001',
  REQ2: 'a2000000-0000-4000-8000-000000000002',
  DRV_A: 'da000000-0000-4000-8000-00000000000a',   // van, bulky, verified, payouts on
  DRV_B: 'db000000-0000-4000-8000-00000000000b',   // car, medium, verified, payouts on
  DRV_U: 'dd000000-0000-4000-8000-00000000000d',   // approved but verification expired
  DRV_S: 'dc000000-0000-4000-8000-00000000000c',   // suspended
  DRV_P: 'de000000-0000-4000-8000-00000000000e',   // approved, verified, payouts NOT enabled
  MEMBER: 'e1000000-0000-4000-8000-000000000004',
} as const;
type Id = keyof typeof ids;
type Who = Id | 'anon';
const roleSql = (w: Who) => (w === 'anon' ? 'set local role anon;' : `set local request.jwt.claim.sub = '${ids[w]}'; set local role authenticated;`);
const tryAs = (w: Who, sql: string) => db.raw(`begin; ${roleSql(w)} ${sql}; rollback;`);

/** A CLIENT action, committed. Returns the parsed jsonb, or throws with the raw output (so refusals vs errors are visible). */
const client = (w: Who, call: string) => parseOrRaw(db.raw(`begin; ${roleSql(w)} select ${call}; commit;`));
/** A SERVICE action (as the edge function would make it), committed. */
const svc = (call: string) => parseOrRaw(db.raw(`begin; set local role service_role; select ${call}; commit;`));
/** A SERVICE call returning a plain number (the sweeps). */
const svcN = (call: string) => { const o = db.raw(`begin; set local role service_role; select ${call}; commit;`); assert.doesNotMatch(o, /ERROR/, o); return Number(lastRow(o)); };
type Res = { ok?: boolean; code?: string; already?: boolean; status?: string; request_id?: string; raw?: string; [k: string]: unknown };
function parseOrRaw(o: string): Res {
  const row = lastRow(o);
  if (/ERROR/.test(o) || !row.startsWith('{')) return { raw: o };
  return JSON.parse(row);
}
const errorOf = (r: Res) => r.raw ?? '';

const SECRET = { phone: '07700 900123', pickupLoc: '7 Westerloch, Brae ZE2 9QJ', destAddr: '12 Hillhead, Lerwick ZE1 0EJ',
  pickupName: 'Mrs Isbister at Westerloch', pickupNotes: 'Key under the blue pot', deliveryNotes: 'Gate code 4471' };
const COORD = { BRAE: [60.396, -1.353], LERWICK: [60.155, -1.145], MIDYELL: [60.600, -1.060], BALTASOUND: [60.757, -0.857], SKERRIES: [60.42, -0.75] };
const RG: Record<string, string> = {};

const payload = (o: Record<string, unknown> = {}) => ({
  idempotency_key: `k-${randomUUID()}`, category_slug: 'small-parcel', item_description: 'Box of books', size_class: 'small',
  pickup_region_id: RG['north-mainland'], pickup_area: 'Brae', pickup_name: SECRET.pickupName, pickup_location: SECRET.pickupLoc,
  pickup_notes: SECRET.pickupNotes, pickup_lat: COORD.BRAE[0], pickup_lng: COORD.BRAE[1],
  destination_region_id: RG['lerwick'], destination_area: 'Hillhead', destination_address: SECRET.destAddr,
  delivery_notes: SECRET.deliveryNotes, dest_lat: COORD.LERWICK[0], dest_lng: COORD.LERWICK[1],
  contact_phone: SECRET.phone, scheduling_mode: 'asap', ...o,
});
const lit = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
const create = (o: Record<string, unknown> = {}, who: Id = 'REQ') => svc(`public.fetch_v2_create_request('${ids[who]}', ${lit(payload(o))})`);
const createId = (o: Record<string, unknown> = {}, who: Id = 'REQ') => { const r = create(o, who); assert.equal(r.ok, true, JSON.stringify(r)); return r.request_id as string; };
const claim = (driver: Id, id: string, confirmed = true) => svc(`public.fetch_v2_claim('${ids[driver]}', '${id}', ${confirmed})`);
const photo = (id: string, kind: string) => ok(db.raw(`insert into public.fetch_request_photos (request_id, kind, storage_path, created_by)
  values ('${id}', '${kind}', 'requests/${id}/${kind}/${randomUUID()}.jpg', '${ids.REQ}')`));
/** What Step 5's hold placement leaves behind: an authorised, freshly confirmed Paygate attempt. */
const authorise = (id: string) => ok(db.raw(`
  insert into public.fetch_authorisation_attempts (delivery_request_id, customer_id, status, hold_state, hold_checked_at, stripe_payment_intent_id)
    values ('${id}', (select customer_id from public.delivery_requests where id = '${id}'), 'authorised', 'valid', now(), 'pi_test_${id.slice(0, 8)}')
    on conflict (delivery_request_id) do update set status = 'authorised', hold_state = 'valid', hold_checked_at = now(), stripe_payment_intent_id = excluded.stripe_payment_intent_id;
  update public.delivery_requests set payment_status = 'authorised', payment_intent_id = 'pi_test_${id.slice(0, 8)}' where id = '${id}';`));
/** What Step 5's capture leaves behind. */
const captured = (id: string) => ok(db.raw(`update public.delivery_requests set payment_status = 'captured' where id = '${id}'`));
const row = (id: string, cols: string) => scalar(`select ${cols} from public.delivery_requests where id = '${id}'`);
const events = (id: string) => scalar(`select string_agg(actor_role || ':' || event || ':' || coalesce(from_status, '-') || '>' || coalesce(to_status, '-'), ' | ' order by id) from public.fetch_request_events where request_id = '${id}'`);
const matched = (o: Record<string, unknown> = {}, driver: Id = 'DRV_A') => { const id = createId(o); assert.equal(claim(driver, id).ok, true); return id; };
const collected = (o: Record<string, unknown> = {}) => { const id = matched(o); authorise(id); assert.equal(client('DRV_A', `public.fetch_v2_mark_collected('${id}')`).ok, true); return id; };
const setAudience = (v: string) => ok(db.raw(`update public.admin_config set value = '${v}' where key = 'fetch.v2.audience'`));

let beforeRows: string[] = [];
let afterRows: string[] = [];
const catalogueRows = (): string[] => {
  const o = db.raw(`select x from (
    select 'col:' || c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) as x from pg_attribute a join pg_class c on c.oid = a.attrelid
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
    union all select 'con:' || conrelid::regclass || ':' || conname || ':' || pg_get_constraintdef(oid) from pg_constraint where connamespace = 'public'::regnamespace
    union all select 'pol:' || tablename || ':' || policyname || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '') from pg_policies where schemaname in ('public', 'storage')
    union all select 'fn:' || p.oid::regprocedure || ':' || md5(p.prosrc) || ':' || coalesce((select string_agg(a::text, ',' order by a::text) from unnest(p.proacl) a), '') from pg_proc p where p.pronamespace = 'public'::regnamespace
    union all select 'tbl:' || relname || ':' || coalesce((select string_agg(a::text, ',' order by a::text) from unnest(relacl) a), '') from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'
  ) s order by x`);
  assert.doesNotMatch(o, /ERROR/, o);
  return rowsOf(o).filter((l) => !/^x$|^-+$|^\(\d+ rows?\)$/.test(l));
};
const setDiff = (want: string[], got: string[]) => ({ missing: want.filter((x) => !got.includes(x)), extra: got.filter((x) => !want.includes(x)) });

before(() => {
  db = createReplayDb('fetchv2life', { stopBefore: FIX_NAME });
  const all = Object.values(ids).map((i) => `'${i}'::uuid`).join(',');
  const slugs = ['lerwick', 'scalloway', 'central-mainland', 'south-mainland', 'west-mainland', 'north-mainland', 'northmavine', 'bressay', 'burra',
    'trondra', 'muckle-roe', 'whalsay', 'yell', 'unst', 'fetlar', 'out-skerries', 'fair-isle'];
  ok(db.raw(`
    insert into auth.users (id, email) select x, 'u' || substr(x::text,1,4) || '@example.org' from unnest(array[${all}]) x on conflict do nothing;
    insert into public.profiles (id, full_name) select x, 'Fixture ' || substr(x::text,1,4) from unnest(array[${all}]) x on conflict (id) do nothing;
    update public.profiles set role = 'admin' where id = '${ids.ADMIN}';
    insert into public.regions (slug, name, display_order) select s, initcap(replace(s, '-', ' ')), o from unnest(array[${slugs.map((s) => `'${s}'`).join(',')}]) with ordinality t(s, o);
    update public.regions set island_group = case when slug in ('bressay','whalsay','yell','unst','fetlar') then slug when slug = 'out-skerries' then 'out_skerries' when slug = 'fair-isle' then 'fair_isle' else 'mainland' end;
    insert into public.delivery_pricing_config (price_per_mile_pence, min_fee_pence, road_correction_factor) values (65, 400, 1.40);
    insert into public.admin_config (key, value, category) values ('fees.fetch.fixed_pence', '150', 'fees'), ('fees.fetch.percent_bps', '0', 'fees')
      on conflict (key) do update set value = excluded.value;
    insert into public.delivery_categories (slug, name) values ('small-parcel', 'Small parcel'), ('other', 'Other'), ('pharmacy', 'Pharmacy'),
      ('takeaway', 'Takeaway'), ('shop-collection', 'Shop collection');
    insert into public.driver_profiles (id, driver_status, vehicle_class, max_size_class, stripe_onboarding_complete, stripe_payouts_enabled, verification_ok_until) values
      ('${ids.DRV_A}', 'approved', 'van', 'bulky', true, true, now() + interval '1 year'),
      ('${ids.DRV_B}', 'approved', 'car', 'medium', true, true, now() + interval '1 year'),
      ('${ids.DRV_U}', 'approved', 'car', 'large', true, true, now() - interval '1 day'),
      ('${ids.DRV_S}', 'suspended', 'car', 'large', true, true, now() + interval '1 year'),
      ('${ids.DRV_P}', 'approved', 'car', 'large', true, false, now() + interval '1 year');`));
  for (const s of slugs) RG[s] = scalar(`select id from public.regions where slug = '${s}'`);
  beforeRows = catalogueRows();
  ok(db.rawFile(FIX));
  afterRows = catalogueRows();
  setAudience('everyone');
});
after(() => { db?.drop(); });

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('0 · the state machine', () => {
  test('exactly the agreed transitions are allowed, and nothing else', () => {
    const got = scalar(`select string_agg(f || '>' || t || ':' || r, ',' order by f, t, r) from
      unnest(array['pending','matched','collected','delivered','undeliverable','returned','cancelled','expired']) f,
      unnest(array['pending','matched','collected','delivered','undeliverable','returned','cancelled','expired']) t,
      unnest(array['requester','driver','admin','system']) r
      where public.fetch_v2_transition_allowed(f, t, r)`);
    assert.equal(got, [
      'collected>delivered:driver', 'collected>undeliverable:driver',
      'matched>cancelled:admin', 'matched>cancelled:driver', 'matched>collected:driver',
      'matched>pending:admin', 'matched>pending:driver', 'matched>pending:system',
      'pending>cancelled:admin', 'pending>cancelled:requester', 'pending>expired:system', 'pending>matched:driver',
      'undeliverable>delivered:driver', 'undeliverable>returned:admin',
    ].join(','));
  });
  test('no terminal state leads anywhere', () => {
    assert.equal(scalar(`select count(*) from unnest(array['delivered','returned','cancelled','expired']) f, unnest(array['pending','matched','collected','delivered','undeliverable','returned','cancelled','expired']) t,
      unnest(array['requester','driver','admin','system']) r where public.fetch_v2_transition_allowed(f, t, r)`), '0');
  });
  test('prohibited moves are refused by the actions themselves', () => {
    const open = createId();
    assert.equal(client('DRV_A', `public.fetch_v2_mark_collected('${open}')`).raw ? 'notfound' : '', 'notfound');      // not their job
    assert.ok(/Fetch request not found/.test(errorOf(client('REQ', `public.fetch_v2_mark_collected('${open}')`))));      // requester cannot collect
    const m = matched();
    authorise(m); assert.equal(client('DRV_A', `public.fetch_v2_mark_collected('${m}')`).ok, true);
    captured(m); assert.equal(svc(`public.fetch_v2_complete_delivery('${ids.DRV_A}', '${m}', false)`).status, 'delivered');
    assert.equal(client('DRV_A', `public.fetch_v2_mark_collected('${m}')`).code, 'invalid_transition');                  // delivered → collected
    const c = createId(); client('REQ', `public.fetch_v2_cancel_open('${c}')`);
    assert.equal(claim('DRV_A', c).code, 'not_claimable');                                                                 // cancelled → matched
    const p = createId();
    assert.equal(svc(`public.fetch_v2_complete_delivery('${ids.DRV_A}', '${p}', false)`).raw ? 'notfound' : 'x', 'notfound'); // pending → delivered (not theirs)
    const m2 = matched();
    assert.equal(svc(`public.fetch_v2_complete_delivery('${ids.DRV_A}', '${m2}', false)`).code, 'invalid_transition');   // matched → delivered
    assert.equal(client('DRV_A', `public.fetch_v2_mark_undeliverable('${m2}', 'recipient_absent')`).code, 'invalid_transition'); // matched → undeliverable
    assert.equal(svc(`public.fetch_v2_resolve_return('${ids.ADMIN}', '${m2}', 'returned_to_sender', 'not_driver')`).code, 'invalid_transition');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('1 · CREATE', () => {
  test('creates a priced, pending v2 job with a server-measured distance and an event; the response carries no private field', () => {
    const r = create();
    assert.equal(`${r.ok}:${r.status}:${r.already}`, 'true:pending:false');
    const q = r.quote as Record<string, number>;
    const expected = Number(scalar(`select greatest(400, round(public.fetch_v2_straight_miles(${COORD.BRAE[0]}, ${COORD.BRAE[1]}, ${COORD.LERWICK[0]}, ${COORD.LERWICK[1]}) * 1.40 * 65))`));
    assert.equal(q.delivery_fee_pence, expected);
    assert.equal(`${q.ferry_supplement_pence}:${q.service_fee_pence}:${q.total_pence}`, `0:150:${expected + 150}`);
    assert.equal(row(r.request_id!, `fetch_version || ':' || status || ':' || payment_status || ':' || base_fee_pence || ':' || total_fee_pence`), `2:pending:unpaid:${expected}:${expected + 150}`);
    assert.equal(events(r.request_id!), 'requester:created:->pending');
    const out = JSON.stringify(r);
    for (const s of Object.values(SECRET)) assert.ok(!out.includes(s), s);
  });
  test('an idempotency key is required, and a repeat returns the same job', () => {
    assert.equal(svc(`public.fetch_v2_create_request('${ids.REQ}', ${lit({ ...payload(), idempotency_key: undefined })})`).code, 'idempotency_key_required');
    const p = payload();
    const a = svc(`public.fetch_v2_create_request('${ids.REQ}', ${lit(p)})`);
    const b = svc(`public.fetch_v2_create_request('${ids.REQ}', ${lit(p)})`);
    assert.equal(`${a.already}:${b.already}:${a.request_id === b.request_id}`, 'false:true:true');
    assert.equal(scalar(`select count(*) from public.delivery_requests where idempotency_key = '${p.idempotency_key}'`), '1');
  });
  test('a double-submit arriving at the same moment still creates one job', async () => {
    const p = payload();
    const call = `begin; set local role service_role; select public.fetch_v2_create_request('${ids.REQ}', ${lit(p)}); select pg_sleep(0.8); commit;`;
    const [x, y] = await Promise.all([db.bg(call), new Promise<{ stdout: string; stderr: string }>((res) => setTimeout(() => db.bg(call).then(res), 150))]);
    assert.equal(`${x.stderr}${y.stderr}`.includes('ERROR'), false, `${x.stderr}${y.stderr}`);
    assert.equal(scalar(`select count(*) from public.delivery_requests where idempotency_key = '${p.idempotency_key}'`), '1');
  });
  test('clients cannot create (the service creates on their behalf after geocoding)', () => {
    assert.ok(denied(tryAs('REQ', `select public.fetch_v2_create_request('${ids.REQ}', ${lit(payload())})`)));
  });
  test('refused for unknown actors, outside the audience, and for restricted members', () => {
    assert.match(errorOf(svc(`public.fetch_v2_create_request('99999999-9999-4999-8999-999999999999', ${lit(payload())})`)), /needs a signed-in member/);
    setAudience('admins');
    assert.match(errorOf(create()), /Fetch is not available/);
    setAudience('everyone');
    ok(db.raw(`insert into public.fetch_member_stats (user_id, restricted_at, restricted_reason) values ('${ids.REQ2}', now(), 'Repeated abuse')
      on conflict (user_id) do update set restricted_at = now(), restricted_reason = 'Repeated abuse'`));
    assert.equal(create({}, 'REQ2').code, 'member_restricted');
    ok(db.raw(`update public.fetch_member_stats set restricted_at = null, restricted_reason = null where user_id = '${ids.REQ2}'`));
  });
  test('malformed items are refused as answers, not database errors', () => {
    for (const [o, code] of [
      [{ item_description: 'ab' }, 'invalid_request'], [{ size_class: 'huge' }, 'invalid_request'], [{ size_class: 'bulky' }, 'invalid_request'],
      [{ size_class: 'large', approx_dimensions_cm: { l: 100, w: 50 } }, 'invalid_request'], [{ handling_flags: ['radioactive'] }, 'invalid_request'],
      [{ pickup_region_id: 'not-a-uuid' }, 'invalid_request'], [{ category_slug: 'weapons' }, 'invalid_request'],
      [{ scheduling_mode: 'by', needed_by: 'tomorrow-ish' }, 'invalid_request'], [{ scheduling_mode: 'by', needed_by: new Date(Date.now() + 30 * 864e5).toISOString() }, 'invalid_request'],
      [{ pickup_lat: null }, 'location_unresolved'], [{ dest_lat: 51.5, dest_lng: -0.12 }, 'location_unresolved'],
      [{ category_slug: 'pharmacy' }, 'liability_required'], [{ destination_address: '   ' }, 'invalid_request'],
    ] as [Record<string, unknown>, string][]) {
      const r = create(o);
      assert.equal(r.code, code, `${JSON.stringify(o)} → ${JSON.stringify(r)}`);
    }
    assert.equal(create({ category_slug: 'pharmacy', liability_acknowledged: true }).ok, true);
  });
  test('bulky: dimensions required and an £8 minimum (normal £4); same mileage formula', () => {
    const near = { dest_lat: COORD.BRAE[0], dest_lng: COORD.BRAE[1], destination_region_id: RG['north-mainland'] };
    const small = create(near).quote as Record<string, number>;
    const bulky = create({ ...near, size_class: 'bulky', approx_dimensions_cm: { l: 190, w: 85, h: 80 }, handling_flags: ['heavy_two_person'] });
    assert.equal(`${small.delivery_fee_pence}:${small.min_fee_applied_pence}`, '400:400');
    assert.equal(`${(bulky.quote as Record<string, number>).delivery_fee_pence}:${(bulky.quote as Record<string, number>).min_fee_applied_pence}:${bulky.needs_item_photo}`, '800:800:true');
  });
  test('ferry is derived by the server: one flat £2 per job, Yell and Unst alike; unsupported isles refused; client claims ignored', () => {
    const yell = create({ destination_region_id: RG['yell'], dest_lat: COORD.MIDYELL[0], dest_lng: COORD.MIDYELL[1], ferry_required: false, ferry_supplement_pence: 0 });
    const unst = create({ destination_region_id: RG['unst'], dest_lat: COORD.BALTASOUND[0], dest_lng: COORD.BALTASOUND[1] });
    assert.equal(row(yell.request_id!, `ferry_required || ':' || ferry_supplement_pence || ':' || ferry_pricing_basis`), 'true:200:flat_per_job_v1');
    assert.equal(row(unst.request_id!, `ferry_supplement_pence`), '200');
    assert.equal(create({ destination_region_id: RG['out-skerries'], dest_lat: COORD.SKERRIES[0], dest_lng: COORD.SKERRIES[1] }).code, 'area_not_supported');
  });
  test('no client pricing or state control: price, status, driver and money fields in the payload are ignored', () => {
    const r = create({ base_fee_pence: 1, total_fee_pence: 1, status: 'matched', driver_id: ids.DRV_A, return_max_pence: 0, payment_status: 'captured', fetch_version: 1 });
    assert.equal(row(r.request_id!, `status || ':' || coalesce(driver_id::text, '-') || ':' || payment_status || ':' || fetch_version || ':' || (base_fee_pence > 1)`), 'pending:-:unpaid:2:true');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('2 · CLAIM', () => {
  test('a verified driver with room claims: assignment and timestamps are the server\'s; the response asks for the hold', () => {
    const id = createId();
    const r = claim('DRV_A', id);
    assert.equal(`${r.ok}:${r.status}`, 'true:matched');
    const pay = r.payment as Record<string, unknown>;
    assert.equal(pay.action, 'authorise');
    assert.equal(pay.amount_pence, Number(row(id, `total_fee_pence + 600 + return_max_pence`)));
    assert.equal(row(id, `(driver_id = '${ids.DRV_A}') || ':' || (claimed_at is not null) || ':' || (vehicle_confirmed_at is not null)`), 'true:true:true');
    assert.match(events(id), /driver:claimed:pending>matched/);
    assert.equal(claim('DRV_A', id).already, true);
  });
  test('eligibility: unapproved, suspended, unverified and unpaid drivers are refused', () => {
    const id = createId();
    assert.equal(claim('MEMBER', id).code, 'driver_not_approved');
    assert.equal(claim('DRV_S', id).code, 'driver_not_approved');
    assert.equal(claim('DRV_U', id).code, 'driver_verification_expired');
    assert.equal(claim('DRV_P', id).code, 'driver_payouts_not_enabled');
  });
  test('vehicle confirmation and capacity are required; bulky needs an item photo first', () => {
    const big = createId({ size_class: 'large', approx_dimensions_cm: { l: 120, w: 60, h: 60 } });
    assert.equal(claim('DRV_A', big, false).code, 'vehicle_confirmation_required');
    assert.equal(claim('DRV_B', big).code, 'too_large_for_vehicle');
    const bulky = createId({ size_class: 'bulky', approx_dimensions_cm: { l: 190, w: 85, h: 80 } });
    assert.equal(claim('DRV_A', bulky).code, 'item_photo_required');
    photo(bulky, 'item');
    assert.equal(claim('DRV_A', bulky).ok, true);
  });
  test('a driver cannot claim their own request; a taken job answers "already_taken"', () => {
    const own = createId({}, 'DRV_B');
    assert.equal(claim('DRV_B', own).code, 'own_request');
    const id = createId();
    claim('DRV_A', id);
    assert.equal(claim('DRV_B', id).code, 'already_taken');
  });
  test('an expired job cannot be claimed', () => {
    const id = createId();
    ok(db.raw(`update public.delivery_requests set expires_at = now() - interval '1 minute' where id = '${id}'`));
    assert.equal(claim('DRV_A', id).code, 'not_claimable');
  });
  test('RACE: two drivers claiming at the same moment — exactly one wins, the other gets an ordinary already_taken', async () => {
    const id = createId();
    const a = `begin; set local role service_role; select public.fetch_v2_claim('${ids.DRV_A}', '${id}', true); select pg_sleep(1.2); commit;`;
    const b = `begin; set local role service_role; select public.fetch_v2_claim('${ids.DRV_B}', '${id}', true); commit;`;
    const pa = db.bg(a);
    await new Promise((r) => setTimeout(r, 250));
    const pb = db.bg(b);
    const [ra, rb] = await Promise.all([pa, pb]);
    assert.equal(`${ra.stderr}${rb.stderr}`.includes('ERROR'), false, `${ra.stderr}${rb.stderr}`);
    const ja = JSON.parse(ra.stdout.split('\n').find((l) => l.startsWith('{'))!);
    const jb = JSON.parse(rb.stdout.split('\n').find((l) => l.startsWith('{'))!);
    assert.equal(`${ja.ok}:${jb.ok}:${jb.code}`, 'true:false:already_taken');
    assert.equal(row(id, `driver_id = '${ids.DRV_A}'`), 't');
    assert.equal(scalar(`select count(*) from public.fetch_request_events where request_id = '${id}' and event = 'claimed'`), '1');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('3 · RELEASE', () => {
  test('a driver releases before collection: back on the board, counted, expiry extended, hold to be voided', () => {
    const id = matched();
    authorise(id);
    ok(db.raw(`update public.delivery_requests set expires_at = now() + interval '10 minutes' where id = '${id}'`));
    const before = Number(scalar(`select release_count from public.driver_profiles where id = '${ids.DRV_A}'`));
    const r = svc(`public.fetch_v2_release('${ids.DRV_A}', '${id}', 'changed_plans', 'Car broke down')`);
    assert.equal(`${r.status}:${(r.payment as Record<string, string>).action}:${(r.payment as Record<string, string>).payment_intent_id}`, `pending:void:pi_test_${id.slice(0, 8)}`);
    assert.equal(row(id, `coalesce(driver_id::text, '-') || ':' || payment_status || ':' || (expires_at > now() + interval '1 hour')`), '-:unpaid:true');
    assert.equal(Number(scalar(`select release_count from public.driver_profiles where id = '${ids.DRV_A}'`)), before + 1);
    assert.match(events(id), /driver:released:matched>pending/);
    assert.equal(svc(`public.fetch_v2_release('${ids.DRV_A}', '${id}', 'changed_plans')`).already, true);
    assert.equal(claim('DRV_B', id).ok, true, 'the next driver can take it');
  });
  test('"not as described" and "prohibited item" releases are recorded but not counted against the driver', () => {
    const id = matched();
    const before = scalar(`select release_count from public.driver_profiles where id = '${ids.DRV_A}'`);
    svc(`public.fetch_v2_release('${ids.DRV_A}', '${id}', 'not_as_described')`);
    assert.equal(scalar(`select release_count from public.driver_profiles where id = '${ids.DRV_A}'`), before);
  });
  test('a reason is required; another driver cannot release; nobody releases after collection', () => {
    const id = matched();
    assert.equal(svc(`public.fetch_v2_release('${ids.DRV_A}', '${id}', 'felt like it')`).code, 'reason_required');
    assert.match(errorOf(svc(`public.fetch_v2_release('${ids.DRV_B}', '${id}', 'changed_plans')`)), /Fetch request not found/);
    const c = collected();
    assert.equal(svc(`public.fetch_v2_release('${ids.DRV_A}', '${c}', 'changed_plans')`).code, 'already_collected');
  });
  test('releasing a job the requester has asked to cancel ends it instead of re-listing it', () => {
    const id = matched();
    client('REQ', `public.fetch_v2_request_cancellation('${id}', 'No longer needed')`);
    assert.equal(svc(`public.fetch_v2_release('${ids.DRV_A}', '${id}', 'changed_plans')`).status, 'cancelled');
  });
  test('the released driver\'s waiting record does not follow the job to the next driver', () => {
    const id = matched();
    client('DRV_A', `public.fetch_v2_mark_arrived('${id}')`);
    svc(`public.fetch_v2_release('${ids.DRV_A}', '${id}', 'changed_plans')`);
    assert.equal(scalar(`select count(*) from public.waiting_events where request_id = '${id}'`), '0');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('4 · CANCELLATION', () => {
  test('before acceptance the requester cancels outright (idempotent, counted)', () => {
    const id = createId();
    assert.equal(client('REQ', `public.fetch_v2_cancel_open('${id}', 'Found it myself')`).status, 'cancelled');
    assert.equal(client('REQ', `public.fetch_v2_cancel_open('${id}')`).already, true);
    assert.match(events(id), /requester:cancelled:pending>cancelled/);
    assert.ok(/Fetch request not found/.test(errorOf(client('REQ2', `public.fetch_v2_cancel_open('${createId()}')`))));
  });
  test('after acceptance it is a REQUEST: the job is untouched, the driver must answer, collection is blocked', () => {
    const id = matched(); authorise(id);
    assert.equal(client('REQ', `public.fetch_v2_cancel_open('${id}')`).code, 'use_cancellation_request');
    const r = client('REQ', `public.fetch_v2_request_cancellation('${id}', 'Plans changed')`);
    assert.equal(`${r.status}:${r.already}:${typeof r.driver_response_due}`, 'matched:false:string');
    assert.equal(client('REQ', `public.fetch_v2_request_cancellation('${id}')`).already, true);
    assert.equal(client('DRV_A', `public.fetch_v2_mark_collected('${id}')`).code, 'cancellation_pending');
    assert.equal(row(id, `status || ':' || (driver_id is not null)`), 'matched:true');
    assert.equal(Number(scalar(`select cancel_requests_after_accept from public.fetch_member_stats where user_id = '${ids.REQ}'`)) >= 1, true);
  });
  test('the driver agrees: cancelled, hold to be voided (idempotent)', () => {
    const id = matched(); authorise(id);
    client('REQ', `public.fetch_v2_request_cancellation('${id}')`);
    const r = svc(`public.fetch_v2_agree_cancellation('${ids.DRV_A}', '${id}')`);
    assert.equal(`${r.status}:${(r.payment as Record<string, string>).action}`, 'cancelled:void');
    assert.equal(svc(`public.fetch_v2_agree_cancellation('${ids.DRV_A}', '${id}')`).already, true);
    assert.match(events(id), /driver:cancellation_agreed:matched>cancelled/);
  });
  test('the driver declines: an admin decides — keep (job continues) or cancel', () => {
    const keep = matched(); authorise(keep);
    client('REQ', `public.fetch_v2_request_cancellation('${keep}')`);
    assert.equal(client('DRV_A', `public.fetch_v2_decline_cancellation('${keep}', 'Already at the door')`).awaiting, 'admin');
    assert.equal(client('DRV_A', `public.fetch_v2_decline_cancellation('${keep}')`).already, true);
    assert.equal(scalar(`select count(*) from public.fetch_issues where request_id = '${keep}' and kind = 'cancellation' and status = 'open'`), '1');
    assert.equal(svc(`public.fetch_v2_resolve_cancellation('${ids.ADMIN}', '${keep}', 'keep', 'x')`).code, 'reason_required');
    assert.equal(svc(`public.fetch_v2_resolve_cancellation('${ids.ADMIN}', '${keep}', 'keep', 'Driver was already there')`).status, 'matched');
    assert.equal(svc(`public.fetch_v2_resolve_cancellation('${ids.ADMIN}', '${keep}', 'keep', 'Driver was already there')`).already, true);
    assert.equal(scalar(`select count(*) from public.fetch_issues where request_id = '${keep}' and status = 'resolved'`), '1');
    assert.equal(client('DRV_A', `public.fetch_v2_mark_collected('${keep}')`).status, 'collected');

    const cancel = matched(); authorise(cancel);
    client('REQ', `public.fetch_v2_request_cancellation('${cancel}')`);
    client('DRV_A', `public.fetch_v2_decline_cancellation('${cancel}')`);
    const r = svc(`public.fetch_v2_resolve_cancellation('${ids.ADMIN}', '${cancel}', 'cancel', 'Requester circumstances changed')`);
    assert.equal(`${r.status}:${(r.payment as Record<string, string>).action}`, 'cancelled:void');
    assert.match(events(cancel), /admin:cancellation_resolved:matched>cancelled/);
  });
  test('no answer in 2 hours: escalated to an admin once (never decided automatically)', () => {
    const id = matched();
    client('REQ', `public.fetch_v2_request_cancellation('${id}')`);
    assert.equal(svcN(`public.fetch_v2_escalate_cancel_requests()`), 0);
    ok(db.raw(`update public.delivery_requests set cancel_requested_at = now() - interval '3 hours' where id = '${id}'`));
    assert.ok(svcN(`public.fetch_v2_escalate_cancel_requests()`) >= 1);
    assert.equal(svcN(`public.fetch_v2_escalate_cancel_requests()`), 0, 'idempotent');
    assert.equal(row(id, 'status'), 'matched');
    assert.match(events(id), /system:cancellation_escalated:matched>matched/);
  });
  test('after collection there is no cancellation of either kind', () => {
    const id = collected();
    assert.equal(client('REQ', `public.fetch_v2_request_cancellation('${id}')`).code, 'cannot_cancel_after_collection');
    assert.equal(client('REQ', `public.fetch_v2_cancel_open('${id}')`).code, 'cannot_cancel_after_collection');
    assert.equal(svc(`public.fetch_v2_admin_cancel('${ids.ADMIN}', '${id}', 'Please cancel')`).code, 'use_return_resolution');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('5 · COLLECTION and WAITING TIME', () => {
  test('only the assigned driver collects, and only with a fulfillable hold', () => {
    const id = matched();
    assert.equal(client('DRV_A', `public.fetch_v2_mark_collected('${id}')`).code, 'payment_not_ready');
    authorise(id);
    assert.ok(/not found/.test(errorOf(client('DRV_B', `public.fetch_v2_mark_collected('${id}')`))));
    assert.ok(/not found/.test(errorOf(client('REQ', `public.fetch_v2_mark_collected('${id}')`))));
    ok(db.raw(`update public.fetch_authorisation_attempts set hold_checked_at = now() - interval '3 hours' where delivery_request_id = '${id}'`));
    assert.equal(client('DRV_A', `public.fetch_v2_mark_collected('${id}')`).code, 'payment_not_ready', 'a stale hold is not enough');
    authorise(id);
    const r = client('DRV_A', `public.fetch_v2_mark_collected('${id}')`);
    assert.equal(`${r.status}:${r.already}`, 'collected:false');
    assert.equal(client('DRV_A', `public.fetch_v2_mark_collected('${id}')`).already, true);
    assert.equal(scalar(`select count(*) from public.fetch_request_events where request_id = '${id}' and event = 'collected'`), '1');
  });
  const waitCase = (minutes: number, ready: boolean) => {
    const id = matched(); authorise(id);
    if (ready) client('REQ', `public.fetch_v2_confirm_ready('${id}')`);
    client('DRV_A', `public.fetch_v2_mark_arrived('${id}')`);
    ok(db.raw(`update public.waiting_events set arrived_at = now() - interval '${minutes} minutes' where request_id = '${id}'`));
    return { id, fee: client('DRV_A', `public.fetch_v2_mark_collected('${id}')`).waiting_fee_pence };
  };
  test('legitimate waiting: 12 minutes after "ready" bills one period (5 free + £1.50 per 5)', () => {
    assert.equal(waitCase(12, true).fee, 150);
  });
  test('inside the free period: nothing', () => {
    assert.equal(waitCase(4, true).fee, 0);
  });
  test('capped at £6 however long', () => {
    assert.equal(waitCase(90, true).fee, 600);
  });
  test('no waiting fee unless the requester said the item was ready', () => {
    assert.equal(waitCase(30, false).fee, 0);
  });
  test('arriving again never restarts or extends the clock; collecting again never changes the fee', () => {
    const id = matched(); authorise(id);
    client('REQ', `public.fetch_v2_confirm_ready('${id}')`);
    const first = client('DRV_A', `public.fetch_v2_mark_arrived('${id}')`).arrived_at;
    ok(db.raw(`update public.waiting_events set arrived_at = now() - interval '12 minutes' where request_id = '${id}'`));
    const again = client('DRV_A', `public.fetch_v2_mark_arrived('${id}')`);
    assert.equal(again.already, true);
    assert.notEqual(again.arrived_at, first);
    assert.equal(scalar(`select count(*) from public.waiting_events where request_id = '${id}'`), '1');
    assert.equal(client('DRV_A', `public.fetch_v2_mark_collected('${id}')`).waiting_fee_pence, 150);
    ok(db.raw(`update public.waiting_events set arrived_at = now() - interval '2 hours' where request_id = '${id}'`));
    assert.equal(client('DRV_A', `public.fetch_v2_mark_collected('${id}')`).waiting_fee_pence, 150);
    assert.equal(row(id, 'waiting_fee_pence'), '150');
  });
  test('a client cannot manufacture waiting: no direct writes, and the fee is never taken from input', () => {
    const id = matched();
    assert.ok(denied(tryAs('DRV_A', `insert into public.waiting_events (request_id, driver_id, arrived_at) values ('${id}', '${ids.DRV_A}', now() - interval '3 hours')`)));
    assert.ok(denied(tryAs('DRV_A', `update public.delivery_requests set waiting_fee_pence = 600 where id = '${id}'`)));
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('6 · DELIVERY', () => {
  test('recorded only after capture, by the assigned driver; idempotent', () => {
    const id = collected();
    assert.equal(svc(`public.fetch_v2_complete_delivery('${ids.DRV_A}', '${id}', false)`).code, 'payment_not_captured');
    captured(id);
    assert.match(errorOf(svc(`public.fetch_v2_complete_delivery('${ids.DRV_B}', '${id}', false)`)), /not found/);
    const r = svc(`public.fetch_v2_complete_delivery('${ids.DRV_A}', '${id}', false)`);
    assert.equal(`${r.status}:${r.already}`, 'delivered:false');
    assert.equal(row(id, `delivered_at is not null`), 't');
    assert.equal(svc(`public.fetch_v2_complete_delivery('${ids.DRV_A}', '${id}', false)`).already, true);
    assert.ok(denied(tryAs('DRV_A', `select public.fetch_v2_complete_delivery('${ids.DRV_A}', '${id}', false)`)), 'clients cannot record delivery');
  });
  test('a safe-place delivery needs permission and a delivery photo', () => {
    const no = collected(); captured(no);
    assert.equal(svc(`public.fetch_v2_complete_delivery('${ids.DRV_A}', '${no}', true)`).code, 'safe_place_not_allowed');
    const yes = collected({ safe_place_allowed: true, safe_place_note: 'Porch' }); captured(yes);
    assert.equal(svc(`public.fetch_v2_complete_delivery('${ids.DRV_A}', '${yes}', true)`).code, 'delivery_photo_required');
    photo(yes, 'delivery');
    assert.equal(svc(`public.fetch_v2_complete_delivery('${ids.DRV_A}', '${yes}', true)`).status, 'delivered');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('7 · CANNOT DELIVER → RETURN → RESOLUTION', () => {
  test('cannot-deliver needs a structured reason, opens an issue and starts the return flow', () => {
    const id = collected();
    assert.equal(client('DRV_A', `public.fetch_v2_mark_undeliverable('${id}', 'meh')`).code, 'reason_required');
    assert.equal(client('DRV_A', `public.fetch_v2_mark_undeliverable('${id}', 'recipient_absent', 'Nobody home')`).status, 'undeliverable');
    assert.equal(client('DRV_A', `public.fetch_v2_mark_undeliverable('${id}', 'recipient_absent')`).already, true);
    assert.equal(scalar(`select count(*) from public.fetch_issues where request_id = '${id}' and kind = 'return' and status = 'open'`), '1');
    assert.equal(client('DRV_A', `public.fetch_v2_report_return('${id}')`).code, 'return_photo_required');
    photo(id, 'return');
    assert.equal(client('DRV_A', `public.fetch_v2_report_return('${id}', 'Back with sender')`).awaiting, 'admin');
    assert.equal(client('DRV_A', `public.fetch_v2_report_return('${id}')`).already, true);
  });
  test('a later delivery retry is allowed', () => {
    const id = collected();
    client('DRV_A', `public.fetch_v2_mark_undeliverable('${id}', 'recipient_absent')`);
    captured(id);
    assert.equal(svc(`public.fetch_v2_complete_delivery('${ids.DRV_A}', '${id}', false)`).status, 'delivered');
    assert.match(events(id), /driver:delivered:undeliverable>delivered/);
  });
  const undeliverable = () => { const id = collected(); client('DRV_A', `public.fetch_v2_mark_undeliverable('${id}', 'recipient_absent')`); return id; };
  test('not the driver\'s fault: delivery + waiting + return mileage at 65p; NO second service fee and NO second ferry supplement', () => {
    const id = undeliverable();
    const r = svc(`public.fetch_v2_resolve_return('${ids.ADMIN}', '${id}', 'returned_to_sender', 'not_driver')`);
    const fee = Number(row(id, 'return_fee_pence'));
    const expectedFee = Number(scalar(`select least(round(round(public.fetch_v2_straight_miles(dest_lat, dest_lng, pickup_lat, pickup_lng) * 1.40, 2) * 65), return_max_pence) from public.delivery_requests where id = '${id}'`));
    assert.equal(fee, expectedFee);
    assert.equal(r.capture_pence, Number(row(id, `total_fee_pence + waiting_fee_pence`)) + fee);
    assert.equal(`${r.status}:${(r.payment as Record<string, string>).action}`, 'returned:capture');
    assert.equal(row(id, `fault_party || ':' || return_outcome || ':' || (resolved_by = '${ids.ADMIN}')`), 'not_driver:returned_to_sender:true');
    assert.equal(scalar(`select count(*) from public.fetch_issues where request_id = '${id}' and status = 'open'`), '0');
    assert.equal(svc(`public.fetch_v2_resolve_return('${ids.ADMIN}', '${id}', 'returned_to_sender', 'driver')`).already, true, 'a repeat changes nothing');
    assert.equal(row(id, 'fault_party'), 'not_driver');
  });
  test('the driver\'s fault: nothing captured, hold voided, counted against the driver', () => {
    const id = undeliverable();
    const before = Number(scalar(`select fault_return_count from public.driver_profiles where id = '${ids.DRV_A}'`));
    const r = svc(`public.fetch_v2_resolve_return('${ids.ADMIN}', '${id}', 'returned_to_sender', 'driver')`);
    assert.equal(`${r.capture_pence}:${(r.payment as Record<string, string>).action}`, '0:void');
    assert.equal(Number(scalar(`select fault_return_count from public.driver_profiles where id = '${ids.DRV_A}'`)), before + 1);
  });
  test('undetermined fault and any override need a reason; overrides stay within the hold', () => {
    const id = undeliverable();
    assert.equal(svc(`public.fetch_v2_resolve_return('${ids.ADMIN}', '${id}', 'returned_to_sender', 'undetermined')`).code, 'override_reason_required');
    assert.equal(svc(`public.fetch_v2_resolve_return('${ids.ADMIN}', '${id}', 'returned_to_sender', 'undetermined', null, 'Accounts conflict')`).code, 'override_required');
    assert.equal(svc(`public.fetch_v2_resolve_return('${ids.ADMIN}', '${id}', 'returned_to_sender', 'not_driver', 500)`).code, 'override_reason_required');
    assert.equal(svc(`public.fetch_v2_resolve_return('${ids.ADMIN}', '${id}', 'returned_to_sender', 'undetermined', 999999, 'Too much')`).code, 'override_out_of_range');
    const r = svc(`public.fetch_v2_resolve_return('${ids.ADMIN}', '${id}', 'returned_to_sender', 'undetermined', 500, 'Split: base fee only')`);
    assert.equal(r.capture_pence, 500);
    assert.equal(row(id, 'resolution_override_reason'), 'Split: base fee only');
    assert.match(scalar(`select metadata::text from public.fetch_request_events where request_id = '${id}' and event = 'return_resolved'`), /"override": true/);
  });
  test('retained or disposed: no return trip, no return fee', () => {
    const id = undeliverable();
    svc(`public.fetch_v2_resolve_return('${ids.ADMIN}', '${id}', 'retained_for_collection', 'not_driver')`);
    assert.equal(row(id, `return_fee_pence || ':' || return_road_miles`), '0:0.00');
  });
  test('only administrators resolve, and never from a client', () => {
    const id = undeliverable();
    assert.match(errorOf(svc(`public.fetch_v2_resolve_return('${ids.MEMBER}', '${id}', 'returned_to_sender', 'not_driver')`)), /Only an administrator/);
    assert.ok(denied(tryAs('ADMIN', `select public.fetch_v2_resolve_return('${ids.ADMIN}', '${id}', 'returned_to_sender', 'not_driver')`)));
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('8 · ADMIN actions and timed sweeps', () => {
  test('admin cancel (open or accepted), audited; reason required; members cannot', () => {
    const open = createId();
    assert.equal(svc(`public.fetch_v2_admin_cancel('${ids.ADMIN}', '${open}', 'x')`).code, 'reason_required');
    assert.match(errorOf(svc(`public.fetch_v2_admin_cancel('${ids.MEMBER}', '${open}', 'Abusive request')`)), /Only an administrator/);
    assert.equal(svc(`public.fetch_v2_admin_cancel('${ids.ADMIN}', '${open}', 'Abusive request')`).status, 'cancelled');
    assert.equal(svc(`public.fetch_v2_admin_cancel('${ids.ADMIN}', '${open}', 'Abusive request')`).already, true);
    const m = matched(); authorise(m);
    const r = svc(`public.fetch_v2_admin_cancel('${ids.ADMIN}', '${m}', 'Prohibited item reported')`);
    assert.equal(`${r.status}:${(r.payment as Record<string, string>).action}`, 'cancelled:void');
    assert.match(events(m), /admin:admin_cancelled:matched>cancelled/);
  });
  test('admin return-to-board (with reason), not counted against the driver', () => {
    const id = matched();
    const before = scalar(`select release_count from public.driver_profiles where id = '${ids.DRV_A}'`);
    assert.equal(svc(`public.fetch_v2_release('${ids.ADMIN}', '${id}', 'no')`).code, 'reason_required');
    assert.equal(svc(`public.fetch_v2_release('${ids.ADMIN}', '${id}', 'Driver unreachable')`).status, 'pending');
    assert.equal(scalar(`select release_count from public.driver_profiles where id = '${ids.DRV_A}'`), before);
    assert.match(events(id), /admin:returned_to_board:matched>pending/);
  });
  test('expiry sweep: overdue open jobs expire, once', () => {
    const id = createId();
    ok(db.raw(`update public.delivery_requests set expires_at = now() - interval '1 minute' where id = '${id}'`));
    assert.ok(svcN(`public.fetch_v2_expire_due()`) >= 1);
    assert.equal(row(id, 'status'), 'expired');
    assert.match(events(id), /system:expired:pending>expired/);
  });
  test('payment-timeout sweep: an accepted job whose payment never completed returns to the board after 2 hours', () => {
    const id = matched();
    assert.equal(scalar(`set role service_role; select count(*) from public.fetch_v2_release_unpaid_due() where request_id = '${id}'`), '0');
    ok(db.raw(`update public.delivery_requests set claimed_at = now() - interval '3 hours' where id = '${id}'`));
    assert.equal(scalar(`set role service_role; select count(*) from public.fetch_v2_release_unpaid_due() where request_id = '${id}'`), '1');
    assert.equal(row(id, `status || ':' || coalesce(driver_id::text, '-')`), 'pending:-');
    assert.match(events(id), /system:payment_timeout:matched>pending/);
  });
  test('admins cannot write the tables directly (Step 2 still holds)', () => {
    assert.ok(denied(tryAs('ADMIN', `update public.delivery_requests set status = 'cancelled'`)));
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('9 · EXTEND and READY', () => {
  test('the requester may extend an open job twice, by a day each time', () => {
    const id = createId();
    const a = client('REQ', `public.fetch_v2_extend('${id}')`);
    const b = client('REQ', `public.fetch_v2_extend('${id}')`);
    assert.ok(new Date(b.expires_at as string) > new Date(a.expires_at as string));
    assert.equal(client('REQ', `public.fetch_v2_extend('${id}')`).code, 'extension_limit');
    assert.ok(/not found/.test(errorOf(client('REQ2', `public.fetch_v2_extend('${id}')`))));
    assert.equal(client('REQ', `public.fetch_v2_extend('${matched()}')`).code, 'invalid_state');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('10 · RUNS', () => {
  const t = (h: number) => `'${new Date(Date.now() + h * 3600e3).toISOString()}'::timestamptz`;
  const createRun = (w: Who, o: Partial<Record<'from' | 'to' | 'start' | 'end' | 'cats' | 'size' | 'notes', string>> = {}) => client(w,
    `public.fetch_v2_create_run('${o.from ?? RG['lerwick']}', '${o.to ?? RG['yell']}', ${o.start ?? t(24)}, ${o.end ?? t(27)}, ${o.cats ?? `'{small-parcel}'`}, ${o.size ?? 'null'}, ${o.notes ?? `'Leaving from my house at 5 Voe Road'`})`);
  test('an approved driver creates a run; the public sees it without anything identifying', () => {
    const r = createRun('DRV_A');
    assert.equal(r.ok, true);
    assert.equal(scalar(`select ferry_crossing || ':' || max_size_class from public.runs where id = '${r.run_id}'`), 'true:bulky');
    const pub = tryAs('anon', `select coalesce(json_agg(x), '[]') from public.fetch_public_runs() x where x.run_key = '${r.run_key}'`);
    assert.match(pub, /Lerwick/);
    for (const s of [ids.DRV_A, r.run_id as string, 'Voe Road']) assert.ok(!pub.includes(s), s);
  });
  test('validation: window, regions, categories, size, eligibility', () => {
    assert.equal(createRun('DRV_A', { end: t(40) }).code, 'invalid_request');
    assert.equal(createRun('DRV_A', { start: t(-5), end: t(-3) }).code, 'invalid_request');
    assert.equal(createRun('DRV_A', { to: RG['fair-isle'] }).code, 'area_not_supported');
    assert.equal(createRun('DRV_A', { cats: `'{weapons}'` }).code, 'invalid_request');
    assert.equal(createRun('DRV_B', { size: `'bulky'` }).code, 'too_large_for_vehicle');
    assert.equal(createRun('DRV_U').code, 'driver_verification_expired');
    assert.equal(createRun('MEMBER').code, 'driver_not_approved');
    assert.ok(denied(tryAs('anon', `select public.fetch_v2_create_run('${RG['lerwick']}', '${RG['yell']}', now(), now(), '{}', null, null)`)));
  });
  test('only the owner cancels, idempotently', () => {
    const r = createRun('DRV_A');
    assert.ok(/Run not found/.test(errorOf(client('DRV_B', `public.fetch_v2_cancel_run('${r.run_id}')`))));
    assert.equal(client('DRV_A', `public.fetch_v2_cancel_run('${r.run_id}')`).status, 'cancelled');
    assert.equal(client('DRV_A', `public.fetch_v2_cancel_run('${r.run_id}')`).already, true);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('11 · AUDIT and PRIVACY of every response', () => {
  test('a full journey leaves the expected immutable trail, with no private data in it', () => {
    const responses: Res[] = [];
    const r0 = create(); responses.push(r0); const id = r0.request_id!;
    responses.push(claim('DRV_A', id)); authorise(id);
    responses.push(client('REQ', `public.fetch_v2_confirm_ready('${id}')`));
    responses.push(client('DRV_A', `public.fetch_v2_mark_arrived('${id}')`));
    responses.push(client('DRV_A', `public.fetch_v2_mark_collected('${id}')`)); captured(id);
    responses.push(svc(`public.fetch_v2_complete_delivery('${ids.DRV_A}', '${id}', false)`));
    assert.equal(events(id), 'requester:created:->pending | driver:claimed:pending>matched | requester:ready_confirmed:matched>matched | driver:arrived:matched>matched | driver:collected:matched>collected | driver:delivered:collected>delivered');
    assert.equal(scalar(`select count(*) from public.fetch_request_events where request_id = '${id}' and actor_id is null and actor_role <> 'system'`), '0');
    const trail = scalar(`select string_agg(coalesce(reason, '') || metadata::text, ' ') from public.fetch_request_events where request_id = '${id}'`);
    const out = JSON.stringify(responses) + trail;
    for (const s of Object.values(SECRET)) assert.ok(!out.includes(s), `leaked ${s}`);
    fails(db.raw(`update public.fetch_request_events set event = 'rewritten' where request_id = '${id}'`), /append-only/);
  });
  test('refusals do not reveal whether someone else\'s job exists', () => {
    const id = matched();
    const theirs = errorOf(client('MEMBER', `public.fetch_v2_mark_collected('${id}')`));
    const none = errorOf(client('MEMBER', `public.fetch_v2_mark_collected('99999999-9999-4999-8999-999999999999')`));
    assert.match(theirs, /Fetch request not found/); assert.match(none, /Fetch request not found/);
  });
  test('every interactive action enforces the Fetch v2 flag', () => {
    const id = matched();
    setAudience('off');
    for (const call of [`public.fetch_v2_mark_collected('${id}')`, `public.fetch_v2_extend('${id}')`, `public.fetch_v2_cancel_open('${id}')`])
      assert.match(errorOf(client('DRV_A', call)), /Fetch is not available/, call);
    assert.match(errorOf(claim('DRV_B', createIdUnsafe())), /Fetch is not available/);
    setAudience('everyone');
  });
});
// creating needs the flag too, so for the flag test create first with it on
let preId = '';
const createIdUnsafe = () => preId;
before(() => { setAudience('everyone'); preId = createId(); });

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('12 · requester long-term history (plan point 21)', () => {
  test('the requester keeps the job; addresses, notes and phone go after the 30-day history window', () => {
    const recent = collected(); captured(recent); svc(`public.fetch_v2_complete_delivery('${ids.DRV_A}', '${recent}', false)`);
    const old = collected(); captured(old); svc(`public.fetch_v2_complete_delivery('${ids.DRV_A}', '${old}', false)`);
    ok(db.raw(`update public.delivery_requests set delivered_at = now() - interval '40 days' where id = '${old}'`));
    const dRecent = JSON.parse(lastRow(db.raw(`begin; ${roleSql('REQ')} select public.fetch_v2_request_detail('${recent}'); rollback;`)));
    const dOld = JSON.parse(lastRow(db.raw(`begin; ${roleSql('REQ')} select public.fetch_v2_request_detail('${old}'); rollback;`)));
    assert.equal(dRecent.request.destination_address, SECRET.destAddr);
    assert.equal(`${dOld.request.status}:${dOld.request.item_description}:${dOld.request.operational_details_visible}`, 'delivered:Box of books:false');
    const out = JSON.stringify(dOld);
    for (const s of Object.values(SECRET)) assert.ok(!out.includes(s), `old history leaked ${s}`);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('13 · mutation controls', () => {
  test('the state machine is load-bearing: it is what refuses "matched → delivered"; widen it and that refusal disappears', () => {
    const id = matched(); captured(id);
    const call = `set local role service_role; select public.fetch_v2_complete_delivery('${ids.DRV_A}', '${id}', false)`;
    assert.match(lastRow(db.raw(`begin; ${call}; rollback;`)), /invalid_transition/);
    const o = db.raw(`begin; create or replace function public.fetch_v2_transition_allowed(p_from text, p_to text, p_role text) returns boolean
      language sql immutable as $f$ select true $f$; ${call}; rollback;`);
    assert.doesNotMatch(o, /invalid_transition/, o);   // only the Step 1 data constraint (collected_at required) is left to object
  });
  test('the service-only grant is load-bearing: exposed to clients, a member could claim as any driver', () => {
    const id = createId();
    const o = db.raw(`begin; grant execute on function public.fetch_v2_claim(uuid, uuid, boolean) to authenticated;
      ${roleSql('MEMBER')} select public.fetch_v2_claim('${ids.DRV_B}', '${id}', true); rollback;`);
    assert.match(lastRow(o), /"ok": true/);
  });
  test('the hold check is load-bearing: without it a driver could collect with no money held', () => {
    const id = matched();
    const o = db.raw(`begin; create or replace function public.fetch_hold_is_fulfillable(p_request uuid) returns table (ok boolean, reason text, detail text)
      language sql stable as $f$ select true, 'valid'::text, null::text $f$;
      ${roleSql('DRV_A')} select public.fetch_v2_mark_collected('${id}'); rollback;`);
    assert.match(lastRow(o), /"status": "collected"/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('14 · rollback', () => {
  test('refuses while a member restriction is recorded', () => {
    ok(db.raw(`insert into public.fetch_member_stats (user_id, restricted_at, restricted_reason) values ('${ids.MEMBER}', now(), 'Testing rollback guard')
      on conflict (user_id) do update set restricted_at = now(), restricted_reason = 'Testing rollback guard'`));
    fails(db.rawFile(DOWN), /refusing to roll back the lifecycle actions/);
    assert.deepEqual(setDiff(afterRows, catalogueRows()), { missing: [], extra: [] });
  });
  test('otherwise restores the catalogue exactly (jobs and history are kept); the migration re-applies', () => {
    ok(db.raw(`update public.fetch_member_stats set restricted_at = null, restricted_reason = null`));
    const jobs = scalar(`select count(*) from public.delivery_requests`);
    ok(db.rawFile(DOWN));
    assert.deepEqual(setDiff(beforeRows, catalogueRows()), { missing: [], extra: [] });
    assert.equal(scalar(`select count(*) from public.delivery_requests`), jobs);
    ok(db.rawFile(FIX));
    assert.deepEqual(setDiff(afterRows, catalogueRows()), { missing: [], extra: [] });
  });
});
