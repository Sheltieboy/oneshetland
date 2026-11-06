/**
 * fetch-v2-data-model.node.test.ts — the Fetch v2 data model (migration 20261215000000), against the real SQL.
 *
 * Every earlier migration is replayed into a private database with realistic pre-existing state (the 17 production regions, the live
 * pricing row, an approved driver pool, a v1 request), then the migration is applied. It proves:
 *   · it is additive: existing rows become v1 and behave as before; production values (65p, £4, ×1.40) are untouched; and the
 *     rollback script returns the catalogue exactly to its pre-migration state, refusing while any v2 data exists;
 *   · the lifecycle is a closed set of states, and a v2 row must have a coherent shape (item, size, bulky dimensions, ferry,
 *     assignment, cancellation request, cannot-deliver, return resolution with fault and override reason);
 *   · clients can never write the v2 fields, the v2-only states, or a v2 row — administrators included;
 *   · privacy: a v2 request (addresses, phone) is readable by its requester, its assigned driver until the address window after it
 *     closes, and administrators — never by an unassigned driver, another member or anon. The same boundary covers waiting events,
 *     history, messages, issues, photos and their storage objects; driver verification files are administrators-only;
 *   · history is append-only (not even a superuser edits or deletes it), messages and reports cannot be rewritten, a verification file
 *     can be deleted while its audit record remains;
 *   · configuration: £8 bulky minimum, flat £2 ferry supplement, agreed timeouts (and a broken setting never shortens a window),
 *     island groups and the P0 ferry islands;
 *   · mutation controls: removing each protection makes the matching check fail.
 *
 * SAFETY — ISOLATED DATABASE ONLY (PASS_PROOF_DSN). Fake users; no Stripe; nothing near production.
 * Run: ISOLATED_ONLY=fetch-v2-data-model npm run test:isolated
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX_NAME = '20261215000000_fetch_v2_data_model.sql';
const FIX = join(REPO_ROOT, 'supabase/migrations', FIX_NAME);
const DOWN = join(REPO_ROOT, 'supabase/rollbacks/20261215000000_fetch_v2_data_model.down.sql');

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
  DRV_A: 'da000000-0000-4000-8000-00000000000a',
  DRV_B: 'db000000-0000-4000-8000-00000000000b',
  MEMBER: 'e1000000-0000-4000-8000-000000000004',
} as const;
type Who = keyof typeof ids | 'anon';
const roleSql = (w: Who) => (w === 'anon' ? 'set local role anon;' : `set local request.jwt.claim.sub = '${ids[w]}'; set local role authenticated;`);
const tryAs = (w: Who, sql: string) => db.raw(`begin; ${roleSql(w)} ${sql}; rollback;`);
const count = (w: Who, table: string, where = 'true') => Number(lastRow(tryAs(w, `select count(*) from ${table} where ${where}`)));

// request ids
const R = {
  V1: '10000000-0000-4000-8000-000000000001',
  OPEN: '20000000-0000-4000-8000-000000000001',
  ACC: '20000000-0000-4000-8000-000000000002',
  CLOSED_OLD: '20000000-0000-4000-8000-000000000003',
  CLOSED_NEW: '20000000-0000-4000-8000-000000000004',
} as const;
const RUN_B = '30000000-0000-4000-8000-000000000001';
const region = (slug: string) => `(select id from public.regions where slug = '${slug}')`;

/** A v2 request written as the server would (superuser = trusted). Overrides replace defaults. */
const v2Insert = (o: Record<string, string> = {}) => {
  const base: Record<string, string> = {
    id: 'gen_random_uuid()', customer_id: `'${ids.REQ}'`, pickup_name: `'Brae Hall'`, pickup_location: `'Brae ZE2 9QJ'`,
    destination_address: `'12 Hillhead, Lerwick ZE1 0EJ'`, contact_phone: `'07700 900123'`, destination_region_id: region('lerwick'),
    pickup_region_id: region('north-mainland'), pickup_area: `'Brae'`, destination_area: `'Lerwick'`, fetch_version: '2',
    item_description: `'Two-seat sofa'`, size_class: `'small'`, pickup_island_group: `'mainland'`, dest_island_group: `'mainland'`,
    ferry_required: 'false', ferry_supplement_pence: '0', status: `'pending'`,
  };
  const row = { ...base, ...o };
  return `insert into public.delivery_requests (${Object.keys(row).join(', ')}) values (${Object.values(row).join(', ')})`;
};
const assigned = (driver: string, extra: Record<string, string> = {}) => ({
  driver_id: `'${driver}'`, claimed_at: 'now()', vehicle_confirmed_at: 'now()', status: `'matched'`, payment_status: `'authorised'`, ...extra,
});

// A fingerprint of everything this migration could touch, for the rollback proof.
const catalogue = () => { const o = db.raw(`select md5(string_agg(x, '|' order by x)) from (
  select 'col:' || c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') as x
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  union all select 'con:' || conrelid::regclass || ':' || conname || ':' || pg_get_constraintdef(oid) from pg_constraint where connamespace = 'public'::regnamespace
  union all select 'pol:' || schemaname || '.' || tablename || ':' || policyname || ':' || permissive || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '') from pg_policies where schemaname in ('public', 'storage')
  union all select 'trg:' || tgrelid::regclass || ':' || tgname from pg_trigger where not tgisinternal and tgrelid::regclass::text not like 'pg_%'
  union all select 'fn:' || p.oid::regprocedure from pg_proc p where p.pronamespace = 'public'::regnamespace
  union all select 'tbl:' || relname || ':' || relrowsecurity || ':' || coalesce(relacl::text, '') from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'
  union all select 'bkt:' || id || ':' || public from storage.buckets
  union all select 'cfg:' || key || '=' || value from public.admin_config
  union all select 'reg:' || slug || ':' || name from public.regions
  union all select 'idx:' || indexrelid::regclass from pg_index i join pg_class c on c.oid = i.indrelid where c.relnamespace = 'public'::regnamespace
) s`); assert.doesNotMatch(o, /ERROR/, o); const v = lastRow(o); assert.match(v, /^[0-9a-f]{32}$/, o); return v; };

const S: Record<string, string> = {};

before(() => {
  db = createReplayDb('fetchv2model', { stopBefore: FIX_NAME });
  const all = Object.values(ids).map((i) => `'${i}'::uuid`).join(',');
  const slugs = ['lerwick', 'scalloway', 'central-mainland', 'south-mainland', 'west-mainland', 'north-mainland', 'northmavine', 'bressay', 'burra',
    'trondra', 'muckle-roe', 'whalsay', 'yell', 'unst', 'fetlar', 'out-skerries', 'fair-isle'];
  const seed = db.raw(`
    insert into auth.users (id, email) select x, 'u' || substr(x::text,1,4) || '@example.org' from unnest(array[${all}]) x on conflict do nothing;
    insert into public.profiles (id, full_name) select x, 'Fixture ' || substr(x::text,1,4) from unnest(array[${all}]) x on conflict (id) do nothing;
    update public.profiles set role = 'admin' where id = '${ids.ADMIN}';
    insert into public.regions (slug, name, display_order) select s, initcap(replace(s, '-', ' ')), o from unnest(array[${slugs.map((s) => `'${s}'`).join(',')}]) with ordinality t(s, o);
    insert into public.delivery_pricing_config (price_per_mile_pence, min_fee_pence, road_correction_factor) values (65, 400, 1.40);
    insert into public.driver_profiles (id, driver_status, vehicle_type, stripe_onboarding_complete, stripe_payouts_enabled)
      values ('${ids.DRV_A}', 'approved', 'Van', true, true), ('${ids.DRV_B}', 'approved', 'Car', true, true);
    insert into public.runs (id, driver_id, departure_start, departure_end) values ('${RUN_B}', '${ids.DRV_B}', now(), now() + interval '3 hours');
    insert into public.delivery_requests (id, customer_id, pickup_name, pickup_location, destination_address, contact_phone, destination_region_id)
      values ('${R.V1}', '${ids.REQ2}', 'Co-op', 'Lerwick', '1 Old Street, Lerwick', '07700 900999', ${region('lerwick')});
    grant select, insert, update, delete on storage.objects to authenticated;`);
  ok(seed);
  S.before = catalogue();
  S.v1Before = scalar(`select md5(row(r.*)::text) from (select id, customer_id, pickup_name, pickup_location, destination_address, contact_phone, status, payment_status from public.delivery_requests where id = '${R.V1}') r`);
  S.apply = db.rawFile(FIX);
  ok(S.apply);
  S.after = catalogue();

  ok(db.raw(`
    ${v2Insert({ id: `'${R.OPEN}'` })};
    ${v2Insert({ id: `'${R.ACC}'`, ...assigned(ids.DRV_A) })};
    ${v2Insert({ id: `'${R.CLOSED_OLD}'`, ...assigned(ids.DRV_A, { status: `'delivered'`, payment_status: `'captured'`, collected_at: `now() - interval '40 days'`, delivered_at: `now() - interval '31 days'` }) })};
    ${v2Insert({ id: `'${R.CLOSED_NEW}'`, ...assigned(ids.DRV_A, { status: `'delivered'`, payment_status: `'captured'`, collected_at: `now() - interval '11 days'`, delivered_at: `now() - interval '10 days'` }) })};`));
});
after(() => { db?.drop(); });

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('0 · additive migration and configuration', () => {
  test('applies cleanly over the full canonical history, and re-applying is harmless', () => {
    assert.notEqual(S.after, S.before);
    const again = db.rawFile(FIX);
    ok(again);
    assert.equal(catalogue(), S.after, 're-apply changes nothing');
  });
  test('existing requests become v1 and are otherwise untouched', () => {
    assert.equal(scalar(`select fetch_version || ':' || coalesce(size_class, '-') || ':' || ferry_required from public.delivery_requests where id = '${R.V1}'`), '1:-:false');
    assert.equal(scalar(`select md5(row(r.*)::text) from (select id, customer_id, pickup_name, pickup_location, destination_address, contact_phone, status, payment_status from public.delivery_requests where id = '${R.V1}') r`), S.v1Before);
  });
  test('production pricing is unchanged; bulky £8 and flat £2 ferry supplement added; the obsolete 95p default is gone', () => {
    assert.equal(scalar(`select price_per_mile_pence || ':' || min_fee_pence || ':' || road_correction_factor || ':' || bulky_min_fee_pence || ':' || ferry_supplement_pence from public.delivery_pricing_config`), '65:400:1.40:800:200');
    assert.equal(scalar(`select column_default from information_schema.columns where table_name = 'delivery_pricing_config' and column_name = 'price_per_mile_pence'`), '65');
    assert.match(db.raw(`update public.delivery_pricing_config set ferry_supplement_pence = -1`), /delivery_pricing_config_v2_sane/);
  });
  test('the ferry supplement is one amount per job: there is no per-crossing or per-route charge anywhere in the model', () => {
    assert.equal(scalar(`select count(*) from information_schema.columns where table_schema = 'public' and column_name ~ '(crossing|route).*(pence|fare)|fare'`), '0');
  });
  test('timeouts and P0 ferry islands are configured with the agreed defaults', () => {
    assert.equal(scalar(`select string_agg(key || '=' || value, ',' order by key) from public.admin_config where key like 'fetch.timeouts.%' or key like 'fetch.ferry.%'`),
      'fetch.ferry.supported_island_groups=mainland,bressay,whalsay,yell,unst,fetlar,fetch.timeouts.address_access_secs=2592000,fetch.timeouts.cancel_request_secs=7200,fetch.timeouts.issue_window_secs=259200,fetch.timeouts.payment_needed_secs=7200');
  });
  test('a broken or missing timeout setting falls back to the default — never zero', () => {
    for (const v of ['0', '-5', 'soon', '', '99999999999']) {
      assert.equal(scalar(`begin; update public.admin_config set value = '${v}' where key = 'fetch.timeouts.address_access_secs'; select public.fetch_v2_timeout_secs('address_access_secs'); rollback;`), '2592000', v);
    }
    assert.equal(scalar(`begin; update public.admin_config set value = '600' where key = 'fetch.timeouts.payment_needed_secs'; select public.fetch_v2_timeout_secs('payment_needed_secs'); rollback;`), '600');
    fails(db.raw(`select public.fetch_v2_timeout_secs('nonsense')`), /unknown Fetch timeout/);
  });
  test('every production region is on an island; Burra, Trondra and Muckle Roe are bridged to the Mainland', () => {
    assert.equal(scalar(`select count(*) from public.regions where island_group is null`), '0');
    assert.equal(scalar(`select string_agg(slug, ',' order by slug) from public.regions where island_group <> 'mainland'`), 'bressay,fair-isle,fetlar,out-skerries,unst,whalsay,yell');
    assert.equal(scalar(`select string_agg(island_group, ',' order by slug) from public.regions where slug in ('burra','trondra','muckle-roe')`), 'mainland,mainland,mainland');
  });
  test('verification requirements are seeded as data: four kinds per motor vehicle, identity only without one', () => {
    assert.equal(scalar(`select count(*) from public.driver_verification_requirements`), '22');
    assert.equal(scalar(`select string_agg(evidence_kind || ':' || needs_expiry, ',' order by evidence_kind) from public.driver_verification_requirements where vehicle_class = 'van'`),
      'identity_check:false,insurance:true,licence:true,vehicle:false');
    assert.equal(scalar(`select string_agg(evidence_kind, ',') from public.driver_verification_requirements where vehicle_class = 'bicycle'`), 'identity_check');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('1 · the lifecycle and the shape of a v2 request', () => {
  const tryV2 = (o: Record<string, string>) => db.raw(`begin; ${v2Insert(o)}; rollback;`);

  test('a well-formed v2 request in each state is accepted', () => {
    ok(tryV2({}));
    ok(tryV2(assigned(ids.DRV_A)));
    ok(tryV2(assigned(ids.DRV_A, { status: `'collected'`, collected_at: 'now()' })));
    ok(tryV2(assigned(ids.DRV_A, { status: `'undeliverable'`, collected_at: 'now()', undeliverable_at: 'now()', undeliverable_reason: `'recipient_absent'` })));
    ok(tryV2({ status: `'cancelled'`, cancelled_at: 'now()' }));
    ok(tryV2({ status: `'expired'` }));
  });
  test('only the agreed states exist', () => {
    for (const s of ['lost', 'disputed', 'completed', 'in_transit', 'accepted', 'open', '']) fails(tryV2({ status: `'${s}'` }), /delivery_requests_status_check/);
  });
  test('undeliverable and returned are v2-only states', () => {
    fails(db.raw(`begin; update public.delivery_requests set status = 'undeliverable' where id = '${R.V1}'; rollback;`), /delivery_requests_v2_only_states/);
  });
  test('item description and size are required; size is one of four; handling flags are a fixed set', () => {
    fails(tryV2({ item_description: 'null' }), /v2_shape/);
    fails(tryV2({ item_description: `'ab'` }), /v2_values/);
    fails(tryV2({ size_class: 'null' }), /v2_shape/);
    fails(tryV2({ size_class: `'huge'` }), /v2_values|v2_shape/);
    fails(tryV2({ handling_flags: `'{radioactive}'` }), /v2_values/);
    ok(tryV2({ handling_flags: `'{heavy_two_person,fragile}'` }));
  });
  test('large and bulky items must carry sane dimensions', () => {
    fails(tryV2({ size_class: `'bulky'` }), /v2_shape/);
    fails(tryV2({ size_class: `'large'` }), /v2_shape/);
    ok(tryV2({ size_class: `'bulky'`, approx_dimensions_cm: `'{"l":190,"w":85,"h":80}'` }));
    for (const d of ['{"l":190,"w":85}', '{"l":0,"w":85,"h":80}', '{"l":"190","w":85,"h":80}', '{"l":5000,"w":85,"h":80}', '[190,85,80]'])
      fails(tryV2({ size_class: `'bulky'`, approx_dimensions_cm: `'${d}'` }), /v2_values|v2_shape/);
  });
  test('ferry: required exactly when island groups differ; a supplement with its basis only then', () => {
    const yell = { dest_island_group: `'yell'`, destination_region_id: region('yell') };
    ok(tryV2({ ...yell, ferry_required: 'true', ferry_supplement_pence: '200', ferry_pricing_basis: `'flat_per_job_v1'` }));
    fails(tryV2({ ...yell }), /v2_shape/);                                                   // crossing not flagged
    fails(tryV2({ ...yell, ferry_required: 'true' }), /v2_shape/);                           // no supplement
    fails(tryV2({ ...yell, ferry_required: 'true', ferry_supplement_pence: '200' }), /v2_shape/);  // no basis recorded
    fails(tryV2({ ferry_required: 'true', ferry_supplement_pence: '200', ferry_pricing_basis: `'flat_per_job_v1'` }), /v2_shape/); // no crossing
    fails(tryV2({ ferry_supplement_pence: '200' }), /v2_shape/);                              // supplement without a crossing
    fails(tryV2({ ...yell, ferry_required: 'true', ferry_supplement_pence: '200', ferry_pricing_basis: `'per_crossing'` }), /v2_values/);
    // Mainland → Unst is two crossings and still ONE supplement: the row has a single amount, no crossing count.
    ok(tryV2({ dest_island_group: `'unst'`, destination_region_id: region('unst'), ferry_required: 'true', ferry_supplement_pence: '200', ferry_pricing_basis: `'flat_per_job_v1'` }));
  });
  test('an assignment exists from acceptance onwards (with the vehicle confirmation), never before', () => {
    fails(tryV2({ status: `'matched'` }), /v2_shape/);
    fails(tryV2(assigned(ids.DRV_A, { vehicle_confirmed_at: 'null' })), /v2_shape/);
    fails(tryV2({ driver_id: `'${ids.DRV_A}'` }), /v2_shape/);
    fails(tryV2(assigned(ids.DRV_A, { status: `'collected'` })), /v2_shape/);              // collected without collected_at
  });
  test('a cancellation request only sits on an accepted, uncollected job', () => {
    ok(tryV2(assigned(ids.DRV_A, { cancel_requested_at: 'now()', cancel_request_reason: `'No longer needed'` })));
    fails(tryV2(assigned(ids.DRV_A, { status: `'collected'`, collected_at: 'now()', cancel_requested_at: 'now()' })), /v2_shape/);
  });
  test('cannot deliver needs a reason from a fixed list', () => {
    const und = assigned(ids.DRV_A, { status: `'undeliverable'`, collected_at: 'now()', undeliverable_at: 'now()' });
    fails(tryV2(und), /v2_shape/);
    fails(tryV2({ ...und, undeliverable_reason: `'felt like it'` }), /v2_values/);
  });
  test('a return is resolved with an outcome, a fault, a resolver and a capture amount; "undetermined" needs an override reason', () => {
    const ret = assigned(ids.DRV_A, {
      status: `'returned'`, payment_status: `'captured'`, collected_at: 'now()', undeliverable_at: 'now()', undeliverable_reason: `'recipient_absent'`,
      returned_at: 'now()', return_outcome: `'returned_to_sender'`, fault_party: `'not_driver'`, resolved_by: `'${ids.ADMIN}'`, resolved_at: 'now()',
      return_road_miles: '10.50', return_fee_pence: '956', resolution_capture_pence: '1866',
    });
    ok(tryV2(ret));
    fails(tryV2({ ...ret, fault_party: 'null' }), /v2_shape/);
    fails(tryV2({ ...ret, return_outcome: 'null' }), /v2_shape/);
    fails(tryV2({ ...ret, resolved_by: 'null' }), /v2_shape/);
    fails(tryV2({ ...ret, resolution_capture_pence: 'null' }), /v2_shape/);
    fails(tryV2({ ...ret, fault_party: `'undetermined'` }), /v2_shape/);
    ok(tryV2({ ...ret, fault_party: `'undetermined'`, resolution_override_reason: `'Both accounts conflict; split at base fee'` }));
    fails(tryV2({ ...ret, return_fee_pence: '-1' }), /v2_values/);
    fails(tryV2({ ...ret, fault_party: `'requester'` }), /v2_values/);
  });
  test('one idempotency key per requester', () => {
    fails(db.raw(`begin; ${v2Insert({ idempotency_key: `'key-aaaaaaaa'` })}; ${v2Insert({ idempotency_key: `'key-aaaaaaaa'` })}; rollback;`), /customer_idempotency_uidx/);
    ok(db.raw(`begin; ${v2Insert({ idempotency_key: `'key-aaaaaaaa'` })}; ${v2Insert({ idempotency_key: `'key-aaaaaaaa'`, customer_id: `'${ids.REQ2}'` })}; rollback;`));
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('2 · clients never write v2 fields, v2 states or v2 rows', () => {
  test('a client insert cannot create a v2 request or set any v2 field — they are reset to defaults', () => {
    const o = tryAs('REQ', `insert into public.delivery_requests (customer_id, pickup_name, pickup_location, destination_address, fetch_version, size_class,
        ferry_supplement_pence, driver_id, return_fee_pence, resolution_capture_pence)
      values ('${ids.REQ}', 'x', 'y', 'z', 2, 'bulky', 99999, '${ids.DRV_A}', 5000, 5000)
      returning fetch_version || ':' || coalesce(size_class,'-') || ':' || ferry_supplement_pence || ':' || coalesce(driver_id::text,'-') || ':' || coalesce(return_fee_pence::text,'-')`);
    assert.equal(lastRow(o), '1:-:0:-:-');
  });
  test('a client cannot set the v2-only states', () => {
    fails(tryAs('REQ', `insert into public.delivery_requests (customer_id, pickup_name, pickup_location, destination_address, status) values ('${ids.REQ}', 'x', 'y', 'z', 'returned')`), /only be set by Fetch/);
  });
  test('the v1 direct-write accept path stays closed (the safety fix 20261212 removed the driver read + accept policies): an approved driver can neither see nor change a v1 pending request, and the v1 row is untouched', () => {
    const o = db.raw(`begin; ${roleSql('DRV_B')} update public.delivery_requests set status = 'matched', run_id = '${RUN_B}', driver_id = '${ids.DRV_B}', return_fee_pence = 1, fetch_version = 2
       where id = '${R.V1}'; reset role;
       select status || ':' || coalesce(run_id::text, '-') || ':' || coalesce(driver_id::text, '-') || ':' || coalesce(return_fee_pence::text, '-') || ':' || fetch_version from public.delivery_requests where id = '${R.V1}'; rollback;`);
    assert.equal(lastRow(o), 'pending:-:-:-:1');
  });
  test('nobody updates or deletes a v2 row from a client — requester, assigned driver or administrator', () => {
    for (const w of ['REQ', 'DRV_A', 'ADMIN'] as Who[]) {
      const u = tryAs(w, `update public.delivery_requests set ready_for_collection = true where id = '${R.ACC}' returning id`);
      assert.ok(/only be changed through Fetch/.test(u) || lastRow(u) === '', `${w} update: ${u}`);
      const d = tryAs(w, `delete from public.delivery_requests where id = '${R.ACC}' returning id`);
      assert.equal(lastRow(d), '', `${w} delete`);
    }
    assert.equal(scalar(`select count(*) from public.delivery_requests where id = '${R.ACC}' and ready_for_collection = false`), '1');
  });
  test('the server-maintained driver columns cannot be self-set; the driver\'s own vehicle declaration can', () => {
    const o = tryAs('DRV_A', `update public.driver_profiles set vehicle_class = 'van', max_size_class = 'bulky', can_two_person_lift = true,
        release_count = 0, fault_return_count = 0, decided_at = now(), decision_reason = 'self', verification_ok_until = now() + interval '10 years'
      where id = '${ids.DRV_A}' returning vehicle_class || ':' || max_size_class || ':' || can_two_person_lift || ':' || coalesce(decision_reason, '-') || ':' || coalesce(verification_ok_until::text, '-')`);
    assert.equal(lastRow(o), 'van:bulky:true:-:-');
    fails(db.raw(`begin; update public.driver_profiles set vehicle_class = 'bicycle', max_size_class = 'large' where id = '${ids.DRV_B}'; rollback;`), /v2_vehicle_check/);
  });
  test('no client role has write privileges on any new table', () => {
    for (const t of ['fetch_request_events', 'fetch_messages', 'fetch_issues', 'fetch_request_photos', 'fetch_member_stats',
      'driver_verification_requirements', 'driver_verification_items', 'driver_verification_files']) {
      for (const role of ['anon', 'authenticated']) {
        assert.equal(scalar(`select has_table_privilege('${role}', 'public.${t}', 'insert') or has_table_privilege('${role}', 'public.${t}', 'update') or has_table_privilege('${role}', 'public.${t}', 'delete')`), 'f', `${role} ${t}`);
      }
    }
    fails(tryAs('REQ', `insert into public.fetch_messages (request_id, sender_id, sender_role, body) values ('${R.ACC}', '${ids.REQ}', 'requester', 'hi')`), /permission denied/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('3 · privacy of a v2 request', () => {
  const sees = (w: Who, id: string) => count(w, 'public.delivery_requests', `id = '${id}'`) === 1;

  test('before acceptance: the requester and administrators only — no driver, member or anon sees it, even though it is pending', () => {
    assert.ok(sees('REQ', R.OPEN));
    assert.ok(sees('ADMIN', R.OPEN));
    for (const w of ['DRV_A', 'DRV_B', 'MEMBER', 'REQ2', 'anon'] as Who[]) assert.ok(!sees(w, R.OPEN), w);
  });
  test('after acceptance: the assigned driver sees the exact addresses and phone; the unrelated driver sees nothing', () => {
    assert.equal(lastRow(tryAs('DRV_A', `select destination_address || ' / ' || contact_phone from public.delivery_requests where id = '${R.ACC}'`)), '12 Hillhead, Lerwick ZE1 0EJ / 07700 900123');
    assert.ok(!sees('DRV_B', R.ACC));
    assert.ok(!sees('MEMBER', R.ACC));
  });
  test('after closing: the driver keeps access for the address window (30 days), then loses it; the requester keeps theirs', () => {
    assert.ok(sees('DRV_A', R.CLOSED_NEW));
    assert.ok(!sees('DRV_A', R.CLOSED_OLD));
    assert.ok(sees('REQ', R.CLOSED_OLD));
  });
  test('the window is configurable, and a broken value cannot open or close it unexpectedly', () => {
    assert.equal(lastRow(db.raw(`begin; update public.admin_config set value = '86400' where key = 'fetch.timeouts.address_access_secs';
      ${roleSql('DRV_A')} select count(*) from public.delivery_requests where id = '${R.CLOSED_NEW}'; rollback;`)), '0');
    assert.equal(lastRow(db.raw(`begin; update public.admin_config set value = 'forever' where key = 'fetch.timeouts.address_access_secs';
      ${roleSql('DRV_A')} select count(*) from public.delivery_requests where id in ('${R.CLOSED_NEW}', '${R.CLOSED_OLD}'); rollback;`)), '1');
  });
  test('no approved driver reads another customer\'s v1 pending request (closed by the safety fix 20261212; this step must not reopen it)', () => {
    assert.ok(!sees('DRV_B', R.V1));
    assert.ok(!sees('MEMBER', R.V1));
  });
  test('waiting events on a v2 request: no client writes; parties read; v1 unchanged', () => {
    fails(tryAs('DRV_A', `insert into public.waiting_events (request_id, driver_id) values ('${R.ACC}', '${ids.DRV_A}')`), /row-level security/);
    ok(db.raw(`insert into public.waiting_events (request_id, driver_id) values ('${R.ACC}', '${ids.DRV_A}')`));
    assert.equal(count('DRV_A', 'public.waiting_events', `request_id = '${R.ACC}'`), 1);
    assert.equal(count('REQ', 'public.waiting_events', `request_id = '${R.ACC}'`), 1);
    assert.equal(count('DRV_B', 'public.waiting_events', `request_id = '${R.ACC}'`), 0);
    ok(tryAs('DRV_B', `insert into public.waiting_events (request_id, driver_id) values ('${R.V1}', '${ids.DRV_B}')`));
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('4 · history, messages and issues', () => {
  before(() => {
    ok(db.raw(`
      insert into public.fetch_request_events (request_id, actor_id, actor_role, event, from_status, to_status, metadata)
        values ('${R.ACC}', '${ids.DRV_A}', 'driver', 'accepted', 'pending', 'matched', '{"vehicle_confirmed": true}');
      insert into public.fetch_messages (request_id, sender_id, sender_role, body) values
        ('${R.ACC}', '${ids.REQ}', 'requester', 'Side door, please'),
        ('${R.ACC}', '${ids.DRV_A}', 'driver', 'No problem');
      insert into public.fetch_issues (request_id, reporter_id, reporter_role, kind, detail) values
        ('${R.ACC}', '${ids.REQ}', 'requester', 'damaged', 'Leg scuffed');`));
  });
  test('an event records who, what, when, which job and the state change', () => {
    assert.equal(scalar(`select actor_role || ':' || event || ':' || from_status || '>' || to_status || ':' || (actor_id = '${ids.DRV_A}') || ':' || (created_at is not null) from public.fetch_request_events where request_id = '${R.ACC}'`),
      'driver:accepted:pending>matched:true:true');
    fails(db.raw(`insert into public.fetch_request_events (request_id, actor_role, event) values ('${R.ACC}', 'driver', 'x_y')`), /check/);   // a person must be named
  });
  test('history is append-only — not even a superuser edits or deletes it', () => {
    fails(db.raw(`update public.fetch_request_events set event = 'rewritten'`), /append-only/);
    fails(db.raw(`delete from public.fetch_request_events`), /append-only/);
  });
  test('…but deleting the request itself (account deletion) still cascades', () => {
    ok(db.raw(`begin; delete from public.delivery_requests where id = '${R.ACC}'; select count(*) from public.fetch_request_events where request_id = '${R.ACC}'; rollback;`));
    assert.equal(lastRow(db.raw(`begin; delete from public.profiles where id = '${ids.REQ}'; select count(*) from public.fetch_request_events; rollback;`)), '0');
  });
  test('events, messages: the parties and administrators read them; the unrelated driver, other members and anon do not', () => {
    for (const t of ['fetch_request_events', 'fetch_messages']) {
      for (const w of ['REQ', 'DRV_A', 'ADMIN'] as Who[]) assert.ok(count(w, `public.${t}`, `request_id = '${R.ACC}'`) > 0, `${w} ${t}`);
      for (const w of ['DRV_B', 'MEMBER', 'REQ2'] as Who[]) assert.equal(count(w, `public.${t}`, `request_id = '${R.ACC}'`), 0, `${w} ${t}`);
      assert.match(tryAs('anon', `select count(*) from public.${t}`), /permission denied/);
    }
  });
  test('a message cannot be edited; a hidden message disappears for the parties but stays visible to administrators', () => {
    fails(db.raw(`update public.fetch_messages set body = 'edited' where body = 'No problem'`), /cannot be edited/);
    fails(db.raw(`update public.fetch_messages set hidden_at = now() where body = 'No problem'`), /check/);   // hiding needs a reason
    ok(db.raw(`update public.fetch_messages set hidden_at = now(), hidden_by = '${ids.ADMIN}', hidden_reason = 'Personal data' where body = 'No problem'`));
    assert.equal(count('REQ', 'public.fetch_messages', `request_id = '${R.ACC}'`), 1);
    assert.equal(count('ADMIN', 'public.fetch_messages', `request_id = '${R.ACC}'`), 2);
  });
  test('an issue is visible to its reporter and administrators, not to the other party', () => {
    assert.equal(count('REQ', 'public.fetch_issues'), 1);
    assert.equal(count('ADMIN', 'public.fetch_issues'), 1);
    assert.equal(count('DRV_A', 'public.fetch_issues'), 0);
    assert.equal(count('DRV_B', 'public.fetch_issues'), 0);
  });
  test('a report cannot be rewritten; resolving needs a resolution; resolved stays resolved', () => {
    fails(db.raw(`update public.fetch_issues set detail = 'nothing happened'`), /cannot be rewritten/);
    fails(db.raw(`update public.fetch_issues set status = 'resolved'`), /check/);
    ok(db.raw(`update public.fetch_issues set status = 'resolved', resolution = 'Refunded £5', resolved_by = '${ids.ADMIN}', resolved_at = now()`));
    fails(db.raw(`update public.fetch_issues set status = 'open', resolution = null, resolved_at = null`), /stays resolved|check/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('5 · photos and private storage', () => {
  const ITEM = `requests/${R.ACC}/item/11111111-1111-4111-8111-111111111111.jpg`;
  const DELIV = `requests/${R.ACC}/delivery/22222222-2222-4222-8222-222222222222.jpg`;
  const VFILE = `drivers/${ids.DRV_A}/33333333-3333-4333-8333-333333333333/44444444-4444-4444-8444-444444444444.pdf`;
  before(() => {
    ok(db.raw(`
      insert into public.fetch_request_photos (request_id, kind, storage_path, created_by) values
        ('${R.ACC}', 'item', '${ITEM}', '${ids.REQ}'), ('${R.ACC}', 'delivery', '${DELIV}', '${ids.DRV_A}');
      insert into storage.objects (bucket_id, name) values ('fetch-photos', '${ITEM}'), ('fetch-photos', '${DELIV}'),
        ('fetch-driver-verification', '${VFILE}');
      insert into public.driver_verification_items (id, driver_id, kind, details) values
        ('33333333-3333-4333-8333-333333333333', '${ids.DRV_A}', 'licence', '{"expires":"2030-01-01"}'),
        ('55555555-5555-4555-8555-555555555555', '${ids.DRV_B}', 'insurance', '{}');
      insert into public.driver_verification_files (item_id, storage_path, mime_type, size_bytes) values
        ('33333333-3333-4333-8333-333333333333', '${VFILE}', 'application/pdf', 12345);`));
  });
  test('the buckets are private', () => {
    assert.equal(scalar(`select string_agg(id || ':' || public, ',' order by id) from storage.buckets where id like 'fetch-%'`), 'fetch-driver-verification:false,fetch-photos:false');
  });
  test('a photo path must belong to its request and kind', () => {
    fails(db.raw(`insert into public.fetch_request_photos (request_id, kind, storage_path) values ('${R.OPEN}', 'item', '${ITEM.replace('11111111', '99999999')}')`), /check/);
    fails(db.raw(`insert into public.fetch_request_photos (request_id, kind, storage_path) values ('${R.ACC}', 'delivery', 'requests/${R.ACC}/item/66666666-6666-4666-8666-666666666666.jpg')`), /check/);
    fails(db.raw(`update public.fetch_request_photos set storage_path = 'requests/${R.ACC}/item/77777777-7777-4777-8777-777777777777.jpg' where storage_path = '${ITEM}'`), /cannot be rewritten/);
  });
  test('photo records and objects: the parties and administrators only', () => {
    for (const w of ['REQ', 'DRV_A', 'ADMIN'] as Who[]) {
      assert.equal(count(w, 'public.fetch_request_photos', `request_id = '${R.ACC}'`), 2, w);
      assert.equal(count(w, 'storage.objects', `bucket_id = 'fetch-photos'`), 2, w);
    }
    for (const w of ['DRV_B', 'MEMBER', 'REQ2'] as Who[]) {
      assert.equal(count(w, 'public.fetch_request_photos'), 0, w);
      assert.equal(count(w, 'storage.objects', `bucket_id = 'fetch-photos'`), 0, w);
    }
  });
  test('clients cannot upload, overwrite or delete Fetch objects directly; administrators can delete', () => {
    fails(tryAs('REQ', `insert into storage.objects (bucket_id, name) values ('fetch-photos', 'requests/${R.ACC}/item/88888888-8888-4888-8888-888888888888.jpg')`), /row-level security/);
    assert.equal(lastRow(tryAs('REQ', `update storage.objects set name = name || 'x' where bucket_id = 'fetch-photos' returning name`)), '');
    assert.equal(lastRow(tryAs('DRV_A', `delete from storage.objects where bucket_id = 'fetch-photos' returning name`)), '');
    assert.equal(lastRow(tryAs('ADMIN', `delete from storage.objects where bucket_id = 'fetch-photos' and name = '${DELIV}' returning name`)), DELIV);
  });
  test('a removed photo disappears for the parties', () => {
    assert.equal(lastRow(db.raw(`begin; update public.fetch_request_photos set removed_at = now(), removed_by = '${ids.ADMIN}', removed_reason = 'Shows a house number' where storage_path = '${ITEM}';
      ${roleSql('REQ')} select count(*) from storage.objects where bucket_id = 'fetch-photos'; rollback;`)), '1');
  });
  test('verification: a driver sees their own records only; the FILES are administrators-only — not even the owner reads them back', () => {
    assert.equal(count('DRV_A', 'public.driver_verification_items'), 1);
    assert.equal(count('DRV_B', 'public.driver_verification_items'), 1);
    assert.equal(count('MEMBER', 'public.driver_verification_items'), 0);
    assert.equal(count('ADMIN', 'public.driver_verification_items'), 2);
    for (const w of ['DRV_A', 'DRV_B', 'MEMBER'] as Who[]) {
      assert.equal(count(w, 'public.driver_verification_files'), 0, w);
      assert.equal(count(w, 'storage.objects', `bucket_id = 'fetch-driver-verification'`), 0, w);
    }
    assert.equal(count('ADMIN', 'public.driver_verification_files'), 1);
    assert.equal(count('ADMIN', 'storage.objects', `bucket_id = 'fetch-driver-verification'`), 1);
    assert.match(tryAs('anon', 'select count(*) from public.driver_verification_items'), /permission denied/);
  });
  test('deleting a verification file keeps the audit record and stamps that the evidence was deleted', () => {
    const o = db.raw(`begin; delete from public.driver_verification_files where item_id = '33333333-3333-4333-8333-333333333333';
      select kind || ':' || status || ':' || (file_deleted_at is not null) from public.driver_verification_items where id = '33333333-3333-4333-8333-333333333333'; rollback;`);
    assert.equal(lastRow(o), 'licence:submitted:true');
  });
  test('requirements: active ones are public (so applicants can see what is needed); inactive ones only to administrators', () => {
    assert.equal(count('anon', 'public.driver_verification_requirements'), 22);
    const o = db.raw(`begin; update public.driver_verification_requirements set active = false where vehicle_class = 'van' and evidence_kind = 'insurance';
      ${roleSql('MEMBER')} select count(*) from public.driver_verification_requirements; rollback;`);
    assert.equal(lastRow(o), '21');
  });
  test('member behaviour counters are administrators-only', () => {
    ok(db.raw(`insert into public.fetch_member_stats (user_id, cancel_requests_after_accept) values ('${ids.REQ}', 2)`));
    assert.equal(count('REQ', 'public.fetch_member_stats'), 0);
    assert.equal(count('ADMIN', 'public.fetch_member_stats'), 1);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('6 · mutation controls (each protection is load-bearing)', () => {
  test('without the restrictive read policy, an unassigned approved driver would read the open v2 request', () => {
    assert.equal(lastRow(db.raw(`begin; create policy "Approved drivers can read all pending requests" on public.delivery_requests for select using (status = 'pending' and exists (select 1 from public.driver_profiles dp where dp.id = auth.uid() and dp.driver_status = 'approved')); drop policy "Fetch v2 requests: parties only" on public.delivery_requests;
      ${roleSql('DRV_B')} select count(*) from public.delivery_requests where id = '${R.OPEN}'; rollback;`)), '1');
  });
  test('without the server-managed trigger, a client could write v2 money fields on a v1 row', () => {
    assert.equal(lastRow(db.raw(`begin; create policy "Approved drivers can read all pending requests" on public.delivery_requests for select using (status = 'pending' and exists (select 1 from public.driver_profiles dp where dp.id = auth.uid() and dp.driver_status = 'approved')); grant update on public.delivery_requests to authenticated; create policy "Drivers must have bank connected to accept requests" on public.delivery_requests for update using (true); drop trigger delivery_requests_v2_server_managed on public.delivery_requests;
      ${roleSql('DRV_B')} update public.delivery_requests set return_fee_pence = 9999 where id = '${R.V1}'; reset role;
      select return_fee_pence from public.delivery_requests where id = '${R.V1}'; rollback;`)), '9999');
  });
  test('the three layers together (read policy, update policy, trigger) are what stop the v1 policies rewriting an open v2 request', () => {
    assert.equal(lastRow(db.raw(`begin; create policy "Approved drivers can read all pending requests" on public.delivery_requests for select using (status = 'pending' and exists (select 1 from public.driver_profiles dp where dp.id = auth.uid() and dp.driver_status = 'approved')); grant update on public.delivery_requests to authenticated; create policy "Drivers must have bank connected to accept requests" on public.delivery_requests for update using (true); drop trigger delivery_requests_v2_server_managed on public.delivery_requests;
      drop policy "Fetch v2 requests: server writes only (update)" on public.delivery_requests;
      drop policy "Fetch v2 requests: parties only" on public.delivery_requests;
      ${roleSql('DRV_B')} update public.delivery_requests set ready_for_collection = true where id = '${R.OPEN}'; reset role;
      select ready_for_collection from public.delivery_requests where id = '${R.OPEN}'; rollback;`)), 't');
    // …and with them in place the same write changes nothing.
    assert.equal(lastRow(db.raw(`begin; ${roleSql('DRV_B')} update public.delivery_requests set ready_for_collection = true where id = '${R.OPEN}'; reset role;
      select ready_for_collection from public.delivery_requests where id = '${R.OPEN}'; rollback;`)), 'f');
  });
  test('without the assigned-driver read policy, the assigned driver could not see their own job (the grant is needed, and is narrow)', () => {
    assert.equal(lastRow(db.raw(`begin; drop policy "Fetch v2 requests: assigned driver reads" on public.delivery_requests;
      ${roleSql('DRV_A')} select count(*) from public.delivery_requests where id = '${R.ACC}'; rollback;`)), '0');
  });
  test('without the append-only trigger, history could be rewritten', () => {
    assert.equal(lastRow(db.raw(`begin; drop trigger fetch_request_events_append_only on public.fetch_request_events;
      update public.fetch_request_events set event = 'rewritten' returning event; rollback;`)), 'rewritten');
  });
  test('with a broad file policy, a driver could read their own verification document back', () => {
    assert.equal(lastRow(db.raw(`begin; create policy leak on public.driver_verification_files for select to authenticated using (true);
      ${roleSql('DRV_A')} select count(*) from public.driver_verification_files; rollback;`)), '1');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('7 · rollback', () => {
  test('refuses while any Fetch v2 data exists, changing nothing', () => {
    fails(db.rawFile(DOWN), /refusing to roll back/);
    assert.equal(catalogue(), S.after);
  });
  test('with the v2 data removed, it returns the catalogue exactly to its pre-migration state; the migration then re-applies', () => {
    ok(db.raw(`
      delete from storage.objects where bucket_id in ('fetch-photos', 'fetch-driver-verification');
      delete from public.driver_verification_items; delete from public.fetch_member_stats;
      delete from public.delivery_requests where fetch_version = 2;`));
    const down = db.rawFile(DOWN);
    ok(down);
    assert.equal(catalogue(), S.before);
    ok(db.rawFile(FIX));
    assert.equal(catalogue(), S.after);
  });
});
