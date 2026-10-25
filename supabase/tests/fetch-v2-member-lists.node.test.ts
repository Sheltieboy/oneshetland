/**
 * fetch-v2-member-lists.node.test.ts — Fetch v2 Step 11: the member lists (migration 20261208000000). Isolated database only.
 * Each list is the signed-in member's own, behind the flag, and carries no address, phone or notes.
 * Run: ISOLATED_ONLY=fetch-v2-member-lists npm run test:isolated
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX_NAME = '20261208000000_fetch_v2_member_lists.sql';
let db: ReplayDb;
const tag = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !tag.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT|^NOTICE|^WARNING/.test(l));
const lastRow = (o: string) => rowsOf(o).pop() ?? '';
const scalar = (sql: string) => lastRow(db.raw(sql));
const ok = (o: string) => assert.doesNotMatch(o, /ERROR/, o);
const ids = { ADMIN: 'ad000000-0000-4000-8000-0000000000ad', REQ: 'a1000000-0000-4000-8000-000000000001', OTHER: 'a2000000-0000-4000-8000-000000000002',
  D_A: 'd1000000-0000-4000-8000-000000000001', D_B: 'd2000000-0000-4000-8000-000000000002' } as const;
type Id = keyof typeof ids;
const asClient = (w: Id, stmt: string) => db.raw(`begin; set local request.jwt.claim.sub = '${ids[w]}'; set local role authenticated; ${stmt}; commit;`);
const call = (w: Id, fn: string) => JSON.parse(lastRow(asClient(w, `select ${fn}`)) || 'null');
const svc = (fn: string) => lastRow(db.raw(`begin; set local role service_role; select ${fn}; commit;`));
const RG: Record<string, string> = {};
const job = () => JSON.parse(svc(`public.fetch_v2_create_request('${ids.REQ}', '${JSON.stringify({ idempotency_key: `k-${randomUUID()}`, category_slug: 'small-parcel',
  item_description: 'Box of books', size_class: 'small', pickup_region_id: RG.lerwick, pickup_name: 'Mrs Isbister', pickup_location: '12 Hillhead, Lerwick',
  pickup_lat: 60.155, pickup_lng: -1.145, destination_region_id: RG.scalloway, destination_address: '3 Main Street, Scalloway', dest_lat: 60.137, dest_lng: -1.276,
  contact_phone: '07700 900123', scheduling_mode: 'asap', pickup_notes: 'Key under the pot' })}'::jsonb)`)).request_id as string;

before(() => {
  db = createReplayDb('fetchv2lists', { stopBefore: FIX_NAME });
  const all = Object.values(ids).map((i) => `'${i}'::uuid`).join(',');
  ok(db.raw(`
    insert into auth.users (id, email) select x, 'u' || substr(x::text,1,4) || '@example.org' from unnest(array[${all}]) x on conflict do nothing;
    insert into public.profiles (id, full_name) select x, 'Fixture ' || substr(x::text,1,4) from unnest(array[${all}]) x on conflict (id) do nothing;
    update public.profiles set role = 'admin' where id = '${ids.ADMIN}';
    insert into public.regions (slug, name, display_order) values ('lerwick', 'Lerwick', 1), ('scalloway', 'Scalloway', 2);
    update public.regions set island_group = 'mainland';
    insert into public.delivery_pricing_config (price_per_mile_pence, min_fee_pence, road_correction_factor) values (65, 400, 1.40);
    insert into public.admin_config (key, value, category) values ('fees.fetch.fixed_pence', '150', 'fees'), ('fees.fetch.percent_bps', '0', 'fees') on conflict (key) do update set value = excluded.value;
    insert into public.delivery_categories (slug, name) values ('small-parcel', 'Small parcel');
    update public.admin_config set value = 'everyone' where key = 'fetch.v2.audience';`));
  for (const s of ['lerwick', 'scalloway']) RG[s] = scalar(`select id from public.regions where slug = '${s}'`);
  for (const w of Object.keys(ids) as Id[]) assert.match(lastRow(asClient(w, `select public.fetch_v2_confirm_adult('fetch-18plus-v1')`)), /"ok": true/);
  for (const w of ['D_A', 'D_B'] as Id[]) ok(db.raw(`
    insert into public.driver_profiles (id, driver_status, vehicle_class, max_size_class, vehicle_reg, stripe_account_id, stripe_onboarding_complete, stripe_payouts_enabled)
    values ('${ids[w]}', 'approved', 'van', 'bulky', 'ZE1 ABC', 'acct_${w}', true, true);
    insert into public.driver_verification_items (driver_id, kind, status, verified_by, verified_at, expires_at)
    select '${ids[w]}', k, 'verified', '${ids.ADMIN}', now(), case when k in ('licence', 'insurance') then now() + interval '200 days' end
      from unnest(array['identity_check', 'licence', 'vehicle', 'insurance']) k;`));
  ok(db.rawFile(join(REPO_ROOT, 'supabase/migrations', FIX_NAME)));
});
after(() => { db?.drop(); });

test('my requests: only mine, a safe summary (no address, phone or notes)', () => {
  const j = job();
  const mine = call('REQ', 'public.fetch_v2_my_requests()');
  assert.ok(mine.some((x: { id: string }) => x.id === j));
  assert.equal(mine[0].route, 'Lerwick → Scalloway');
  for (const s of ['Hillhead', 'Main Street', '07700', 'Isbister', 'Key under']) assert.ok(!JSON.stringify(mine).includes(s), s);
  assert.deepEqual(call('OTHER', 'public.fetch_v2_my_requests()'), []);
});
test('my jobs: only jobs I hold now (a released one leaves my list), with my pay, no addresses', () => {
  const j = job(), k = job();
  svc(`public.fetch_v2_claim('${ids.D_A}', '${j}', true)`);
  svc(`public.fetch_v2_claim('${ids.D_A}', '${k}', true)`);
  svc(`public.fetch_v2_release('${ids.D_A}', '${k}', 'changed_plans')`);
  const jobs = call('D_A', 'public.fetch_v2_my_jobs()');
  assert.deepEqual(jobs.map((x: { id: string }) => x.id), [j]);
  assert.ok(jobs[0].driver_pay_pence > 0 && jobs[0].live === true);
  // My pay line by line adds up to the total, and nothing of the requester's money (fee, total, hold) is in it.
  const p = jobs[0].pay;
  assert.equal(p.delivery_pence + p.ferry_pence + (p.waiting_pence ?? 0) + (p.return_pence ?? 0), jobs[0].driver_pay_pence);
  assert.ok(!/total_fee|service_fee|max_authorisation|hold/.test(JSON.stringify(jobs)));
  assert.ok(!JSON.stringify(jobs).match(/Hillhead|Main Street|07700/));
  assert.deepEqual(call('D_B', 'public.fetch_v2_my_jobs()'), []);
});
test('my journeys: only mine, open first', () => {
  const s = new Date(Date.now() + 86400_000).toISOString(), e = new Date(Date.now() + 90000_000).toISOString();
  assert.match(lastRow(asClient('D_A', `select public.fetch_v2_create_run('${RG.lerwick}', '${RG.scalloway}', '${s}', '${e}', '{}'::text[], null)`)), /"ok": true/);
  const runs = call('D_A', 'public.fetch_v2_my_runs()');
  assert.equal(`${runs[0].origin} → ${runs[0].destination}:${runs[0].status}`, 'Lerwick → Scalloway:open');
  assert.deepEqual(call('D_B', 'public.fetch_v2_my_runs()'), []);
});
test('areas: drivers only, existing regions only, at most 20; never by direct write any more than before', () => {
  assert.deepEqual(call('D_A', `public.fetch_v2_set_my_areas(array['${RG.lerwick}']::uuid[])`).areas, [RG.lerwick]);
  assert.equal(scalar(`select areas::text from public.driver_profiles where id = '${ids.D_A}'`), `{${RG.lerwick}}`);
  assert.equal(call('D_A', `public.fetch_v2_set_my_areas(array['${randomUUID()}']::uuid[])`).code, 'invalid_request');
  assert.equal(call('REQ', `public.fetch_v2_set_my_areas(array['${RG.lerwick}']::uuid[])`).code, 'driver_not_applied');
});
test('signed out: nothing; Fetch off: refused', () => {
  assert.match(db.raw(`begin; set local role anon; select public.fetch_v2_my_requests(); commit;`), /permission denied/);
  ok(db.raw(`update public.admin_config set value = 'off' where key = 'fetch.v2.audience'`));
  assert.match(asClient('REQ', 'select public.fetch_v2_my_requests()'), /ERROR/);
  ok(db.raw(`update public.admin_config set value = 'everyone' where key = 'fetch.v2.audience'`));
});
test('rollback removes exactly the four functions; re-applies', () => {
  ok(db.rawFile(join(REPO_ROOT, 'supabase/rollbacks/20261208000000_fetch_v2_member_lists.down.sql')));
  assert.equal(scalar(`select count(*) from pg_proc where proname in ('fetch_v2_my_requests', 'fetch_v2_my_jobs', 'fetch_v2_my_runs', 'fetch_v2_set_my_areas')`), '0');
  ok(db.rawFile(join(REPO_ROOT, 'supabase/migrations', FIX_NAME)));
  assert.equal(scalar(`select count(*) from pg_proc where proname in ('fetch_v2_my_requests', 'fetch_v2_my_jobs', 'fetch_v2_my_runs', 'fetch_v2_set_my_areas')`), '4');
});
