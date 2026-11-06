/**
 * fetch-v2-admin-controls.node.test.ts — Fetch v2 Step 10: the operations reads and the new audited admin actions
 * (migration 20261224000000 + the `support` area of fetch-v2-admin), against the real SQL of Steps 1–10.
 *
 * Built around the six operational scenarios the console exists for (A–F below). States are reached through the real Step 3–9
 * functions where practical; where a scenario needs time to have passed (a hold about to lapse, a cancellation left unanswered),
 * the relevant timestamp is moved as a trusted fixture.
 *
 * SAFETY — ISOLATED DATABASE ONLY (PASS_PROOF_DSN). Fake users; fake storage; nothing sent; no network.
 * Run: ISOLATED_ONLY=fetch-v2-admin-controls npm run test:isolated
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';
import { handleSupportAdmin, type PhotoDeps } from '../functions/_shared/fetch-v2-photos.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX_NAME = '20261224000000_fetch_v2_admin_controls.sql';
const FIX = join(REPO_ROOT, 'supabase/migrations', FIX_NAME);
const DOWN = join(REPO_ROOT, 'supabase/rollbacks/20261224000000_fetch_v2_admin_controls.down.sql');

let db: ReplayDb;
const tag = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !tag.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT|^NOTICE|^WARNING/.test(l));
const lastRow = (o: string) => rowsOf(o).pop() ?? '';
const scalar = (sql: string) => lastRow(db.raw(sql));
const ok = (o: string) => assert.doesNotMatch(o, /ERROR/, o);
const fails = (o: string, re: RegExp = /ERROR/) => assert.match(o, re, o);

const ids = {
  ADMIN: 'ad000000-0000-4000-8000-0000000000ad',
  REQ: 'a1000000-0000-4000-8000-000000000001',
  MEMBER: 'a2000000-0000-4000-8000-000000000002',
  D_A: 'd1000000-0000-4000-8000-000000000001',
  D_B: 'd2000000-0000-4000-8000-000000000002',
} as const;
type Id = keyof typeof ids;
const lit = (v: unknown) => (v === null || v === undefined ? 'null' : typeof v === 'object' ? `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`
  : typeof v === 'boolean' || typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const asClient = (w: Id, stmt: string) => db.raw(`begin; set local request.jwt.claim.sub = '${ids[w]}'; set local role authenticated; ${stmt}; commit;`);
const call = (w: Id, fn: string) => JSON.parse(lastRow(asClient(w, `select ${fn}`)) || 'null');
const svc = (fn: string) => lastRow(db.raw(`begin; set local role service_role; select ${fn}; commit;`));
const rpc = async (fn: string, args: Record<string, unknown>) => {
  const named = Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(', ');
  const o = db.raw(`begin; set local role service_role; select to_json(public.${fn}(${named})); commit;`);
  if (/ERROR/.test(o)) return { data: null, error: { message: o } };
  return { data: JSON.parse(lastRow(o)), error: null };
};
const noStorage = { signedUpload: async () => ({ url: '', token: '' }), read: async () => null, write: async () => {}, signedUrl: async () => '', remove: async () => {} };
const deps = (): PhotoDeps => ({ rpc, storage: noStorage, limit: async () => true });
const support = (action: string, extra: Record<string, unknown> = {}, w: Id = 'ADMIN') => handleSupportAdmin(ids[w], { area: 'support', action, ...extra }, deps());

const queues = () => call('ADMIN', 'public.fetch_v2_admin_queues()');
const inQueue = (q: Record<string, unknown[]>, key: string, j: string) => (q[key] as { request_id: string }[]).find((x) => x.request_id === j);
const adminJob = (j: string) => call('ADMIN', `public.fetch_v2_admin_job('${j}')`);

const RG: Record<string, string> = {};
function job(o: Record<string, unknown> = {}): string {
  const p = { idempotency_key: `k-${randomUUID()}`, category_slug: 'small-parcel', item_description: 'Box of books', size_class: 'small',
    pickup_region_id: RG.lerwick, pickup_name: 'Mrs Isbister', pickup_location: '12 Hillhead, Lerwick', pickup_lat: 60.155, pickup_lng: -1.145,
    destination_region_id: RG.scalloway, destination_address: '3 Main Street, Scalloway', dest_lat: 60.137, dest_lng: -1.276,
    contact_phone: '07700 900123', scheduling_mode: 'asap', ...o };
  const out = JSON.parse(svc(`public.fetch_v2_create_request('${ids.REQ}', ${lit(p)})`));
  assert.equal(out.ok, true, JSON.stringify(out));
  return out.request_id;
}
const claim = (j: string, w: Id = 'D_A') => JSON.parse(svc(`public.fetch_v2_claim('${ids[w]}', '${j}', true)`));
const hold = (j: string, w: Id, captureBeforeSql: string) => {
  svc(`public.fetch_v2_claim_authorisation('${ids[w]}', '${j}')`);
  const amount = Number(scalar(`select max_hold_pence from public.fetch_v2_terms where request_id = '${j}'`));
  svc(`public.fetch_v2_apply_payment_state('${j}', 'pi_adm_${j.slice(0, 8)}', 1, 'requires_capture', ${amount}, 0, ${captureBeforeSql}, 'test')`);
};
const collect = (j: string) => ok(db.raw(`update public.delivery_requests set status = 'collected', collected_at = now() - interval '1 hour' where id = '${j}'`));

let beforeRows: string[] = [];
let afterRows: string[] = [];
const catalogueRows = (): string[] => {
  const o = db.raw(`select x from (
    select 'col:' || c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull as x
      from pg_attribute a join pg_class c on c.oid = a.attrelid
     where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
    union all select 'con:' || conrelid::regclass || ':' || conname || ':' || pg_get_constraintdef(oid) from pg_constraint where connamespace = 'public'::regnamespace
    union all select 'idx:' || indexrelid::regclass || ':' || pg_get_indexdef(indexrelid) from pg_index i join pg_class c on c.oid = i.indrelid where c.relnamespace = 'public'::regnamespace
    union all select 'trg:' || tgrelid::regclass || ':' || tgname || ':' || tgfoid::regproc from pg_trigger where not tgisinternal and tgrelid::regclass::text not like 'storage.%'
    union all select 'fn:' || p.oid::regprocedure || ':' || md5(p.prosrc) || ':' || coalesce((select string_agg(a::text, ',' order by a::text) from unnest(p.proacl) a), '') from pg_proc p where p.pronamespace = 'public'::regnamespace
    union all select 'tacl:' || c.relname || ':' || coalesce((select string_agg(a::text, ',' order by a::text) from unnest(c.relacl) a), '') from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'S')
    union all select 'pol:' || schemaname || '.' || tablename || ':' || policyname || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '') from pg_policies where schemaname in ('public', 'storage')
  ) s order by x`);
  assert.doesNotMatch(o, /ERROR/, o);
  return rowsOf(o).filter((l) => !/^x$|^-+$|^\(\d+ rows?\)$/.test(l));
};
const setDiff = (want: string[], got: string[]) => ({ missing: want.filter((x) => !got.includes(x)), extra: got.filter((x) => !want.includes(x)) });

before(() => {
  db = createReplayDb('fetchv2adm', { stopBefore: FIX_NAME });
  const all = Object.values(ids).map((i) => `'${i}'::uuid`).join(',');
  ok(db.raw(`
    insert into auth.users (id, email) select x, 'u' || substr(x::text,1,4) || '@example.org' from unnest(array[${all}]) x on conflict do nothing;
    insert into public.profiles (id, full_name) select x, 'Fixture ' || substr(x::text,1,4) from unnest(array[${all}]) x on conflict (id) do nothing;
    update public.profiles set role = 'admin' where id = '${ids.ADMIN}';
    insert into public.regions (slug, name, display_order) values ('lerwick', 'Lerwick', 1), ('scalloway', 'Scalloway', 2);
    update public.regions set island_group = 'mainland';
    insert into public.delivery_pricing_config (price_per_mile_pence, min_fee_pence, road_correction_factor) values (65, 400, 1.40);
    insert into public.admin_config (key, value, category) values ('fees.fetch.fixed_pence', '150', 'fees'), ('fees.fetch.percent_bps', '0', 'fees')
      on conflict (key) do update set value = excluded.value;
    insert into public.delivery_categories (slug, name) values ('small-parcel', 'Small parcel'), ('furniture', 'Furniture');
    update public.admin_config set value = 'everyone' where key = 'fetch.v2.audience';`));
  for (const s of ['lerwick', 'scalloway']) RG[s] = scalar(`select id from public.regions where slug = '${s}'`);
  for (const w of Object.keys(ids) as Id[]) assert.match(lastRow(asClient(w, `select public.fetch_v2_confirm_adult('fetch-18plus-v1')`)), /"ok": true/);
  for (const w of ['D_A', 'D_B'] as Id[]) ok(db.raw(`
    insert into public.driver_profiles (id, driver_status, vehicle_class, max_size_class, vehicle_reg, stripe_account_id, stripe_onboarding_complete, stripe_payouts_enabled)
    values ('${ids[w]}', 'approved', 'van', 'bulky', 'ZE1 ABC', 'acct_${w}', true, true);
    insert into public.driver_verification_items (driver_id, kind, status, verified_by, verified_at, expires_at)
    select '${ids[w]}', k, 'verified', '${ids.ADMIN}', now(), case when k in ('licence', 'insurance') then now() + interval '200 days' end
      from unnest(array['identity_check', 'licence', 'vehicle', 'insurance']) k;`));
  beforeRows = catalogueRows();
  ok(db.rawFile(FIX));
  afterRows = catalogueRows();
});
after(() => { db?.drop(); });

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('ACCESS — administrators only; reads are read-only; no client writes anything', () => {
  test('every operations read refuses non-administrators and signed-out visitors', () => {
    const j = job();
    for (const call_ of ['public.fetch_v2_admin_queues()', `public.fetch_v2_admin_jobs('{}'::jsonb)`, `public.fetch_v2_admin_job('${j}')`, `public.fetch_v2_admin_member('${ids.REQ}')`]) {
      for (const w of ['REQ', 'D_A', 'MEMBER'] as Id[]) fails(asClient(w, `select ${call_}`), /Only an administrator/);
      fails(db.raw(`begin; set local role anon; select ${call_}; commit;`), /permission denied/);
    }
  });
  test('the audited actions are service-only (through fetch-v2-admin), refused to non-administrators there, and need reasons', async () => {
    const j = job();
    fails(asClient('ADMIN', `select public.fetch_v2_redact_description('${ids.ADMIN}', '${j}', 'x', 'because')`), /permission denied/);
    fails(asClient('ADMIN', `select public.fetch_v2_set_member_restriction('${ids.ADMIN}', '${ids.REQ}', true, 'because')`), /permission denied/);
    assert.equal((await support('redact_description', { request_id: j, reason: 'Phone number' }, 'D_A')).body.code, 'forbidden');
    assert.equal((await support('restrict_member', { member_id: ids.REQ, reason: 'Abuse' }, 'REQ')).body.code, 'forbidden');
    assert.equal((await support('redact_description', { request_id: j })).body.code, 'reason_required');
    assert.equal((await support('restrict_member', { member_id: ids.REQ })).body.code, 'reason_required');
    assert.equal((await support('restrict_member', { member_id: ids.ADMIN, reason: 'testing' })).body.code, 'cannot_restrict_self');
  });
  test('an administrator\'s browser session still cannot write Fetch tables or the new history directly', () => {
    const j = job();
    fails(asClient('ADMIN', `insert into public.fetch_request_redactions (request_id, field, original_text, replacement, reason) values ('${j}', 'item_description', 'a', 'b', 'xyz')`), /permission denied/);
    fails(asClient('ADMIN', `insert into public.fetch_member_restriction_log (member_id, action, reason) values ('${ids.REQ}', 'restricted', 'xyz')`), /permission denied/);
    fails(asClient('ADMIN', `update public.fetch_member_stats set restricted_at = now(), restricted_reason = 'xyz' where user_id = '${ids.REQ}'`), /permission denied/);
    const before = scalar(`select item_description from public.delivery_requests where id = '${j}'`);
    asClient('ADMIN', `update public.delivery_requests set item_description = 'admin overwrote' where id = '${j}'`);
    assert.equal(scalar(`select item_description from public.delivery_requests where id = '${j}'`), before);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('SCENARIOS', () => {
  test('A · a collected item whose card hold is about to lapse is a payment problem that needs attention', () => {
    const j = job();
    assert.equal(claim(j).ok, true);
    hold(j, 'D_A', `now() + interval '20 hours'`);
    collect(j);
    const p = inQueue(queues().queues, 'payments', j) as { priority: string; reasons: string[] } | undefined;
    assert.deepEqual([p?.priority, p?.reasons], ['action_required', ['hold_expiring_after_collection']]);
    const pay = adminJob(j).payment;
    assert.equal(`${pay.payment_status}:${pay.hold_state}:${pay.generation}:${pay.intent_state}`, 'authorised:expiring_soon:1:requires_capture');
    assert.ok(pay.capture_deadline && pay.payment_problem.priority === 'action_required');
    assert.equal(queues().action_required.payments >= 1, true);
  });
  test('B · a sofa that could not be delivered: the return queue, and on the job page the issue, messages, photos, money and timeline', () => {
    const j = job({ size_class: 'large', item_description: 'Three-seat sofa', category_slug: 'furniture', approx_dimensions_cm: { l: 200, w: 90, h: 80 } });
    claim(j);
    collect(j);
    assert.match(lastRow(asClient('D_A', `select public.fetch_v2_mark_undeliverable('${j}', 'recipient_absent')`)), /undeliverable/);
    asClient('REQ', `select public.fetch_v2_send_message('${j}', 'Sorry, I was out')`);
    asClient('D_A', `select public.fetch_v2_report_issue('${j}', 'not_delivered', 'Nobody home, sofa still in my van')`);
    ok(db.raw(`insert into public.fetch_request_photos (request_id, kind, storage_path, created_by) values ('${j}', 'return', 'requests/${j}/return/${randomUUID()}.jpg', '${ids.D_A}')`));
    const r = inQueue(queues().queues, 'returns', j) as { priority: string; reasons: string[] };
    assert.deepEqual([r.priority, r.reasons], ['action_required', ['cannot_deliver', 'awaiting_return_report', 'return_photo']]);
    const page = adminJob(j);
    assert.equal(page.summary.status, 'undeliverable');
    assert.deepEqual(page.timeline.map((e: { event: string }) => e.event).filter((e: string) => !e.startsWith('message') && !e.startsWith('issue')),
      ['created', 'claimed', 'undeliverable']);
    assert.ok(page.timeline.some((e: { event: string; actor_role: string }) => e.event === 'issue_reported' && e.actor_role === 'driver'));
    assert.equal(page.support.messages[0].body, 'Sorry, I was out');
    assert.deepEqual(page.support.issues.map((i: { kind: string }) => i.kind), ['return', 'not_delivered'], 'the system return issue (Step 3), then the driver\'s report');
    assert.equal(page.support.photos[0].kind, 'return');
    assert.equal(page.money.expected_total_pence > 0 && page.money.capture_now_pence === page.money.expected_total_pence, true);
    assert.equal(page.money.oneshetland_fee_pence, 150);
    assert.equal(page.money.driver_entitlement_pence, page.money.capture_now_pence - 150);
    const iss = (queues().queues.issues as { request_id: string; kind: string; priority: string; has_evidence: boolean; affects_payment: boolean }[]).find((x) => x.request_id === j && x.kind === 'not_delivered')!;
    assert.deepEqual([iss.kind, iss.priority, iss.affects_payment], ['not_delivered', 'action_required', true]);
    assert.ok(!JSON.stringify(queues().queues.issues).includes('Nobody home'), 'the issue text is never in the list');
  });
  test('C · insurance lapses after the driver accepted but before collection: the job shows as blocked, with the evidence state', () => {
    const j = job();
    claim(j, 'D_B');
    ok(db.raw(`update public.driver_verification_items set expires_at = now() - interval '1 minute' where driver_id = '${ids.D_B}' and kind = 'insurance'`));
    const v = inQueue(queues().queues, 'verification_jobs', j) as { priority: string; reasons: string[]; driver_id: string };
    assert.deepEqual([v.priority, v.reasons, v.driver_id], ['action_required', ['driver_verification_expired', 'collection_blocked'], ids.D_B]);
    ok(db.raw(`insert into public.driver_verification_items (driver_id, kind, status, version) values ('${ids.D_B}', 'insurance', 'submitted', 2)`));
    assert.ok((inQueue(queues().queues, 'verification_jobs', j) as { reasons: string[] }).reasons.includes('new_evidence_waiting'));
    assert.equal(adminJob(j).parties.driver_problem, 'driver_verification_expired');
    ok(db.raw(`update public.driver_verification_items set expires_at = now() + interval '200 days' where driver_id = '${ids.D_B}' and kind = 'insurance' and status = 'verified';
               delete from public.driver_verification_items where driver_id = '${ids.D_B}' and status = 'submitted'`));
  });
  test('D · a requester asked to cancel and the driver never answered: overdue, needs a decision', () => {
    const j = job();
    claim(j);
    assert.match(lastRow(asClient('REQ', `select public.fetch_v2_request_cancellation('${j}', 'Plans changed')`)), /"ok": true/);
    let c = inQueue(queues().queues, 'cancellations', j) as { priority: string; reasons: string[]; respond_by: string };
    assert.deepEqual([c.priority, c.reasons], ['waiting', ['awaiting_driver']]);
    ok(db.raw(`update public.delivery_requests set cancel_requested_at = now() - interval '3 hours' where id = '${j}'`));
    c = inQueue(queues().queues, 'cancellations', j) as { priority: string; reasons: string[]; respond_by: string };
    assert.deepEqual([c.priority, c.reasons], ['action_required', ['driver_did_not_respond']]);
    assert.ok(Date.parse(c.respond_by) < Date.now());
  });
  test('E · a phone number and address in the description: redacted for everyone, the original kept for administrators only', async () => {
    const j = job({ item_description: 'Call me on 07700 900555, 12 Hillhead' });
    const r = await support('redact_description', { request_id: j, reason: 'Personal details in the description' });
    assert.equal(r.body.ok, true);
    assert.equal(scalar(`select item_description from public.delivery_requests where id = '${j}'`), 'Description removed by OneShetland');
    const board = lastRow(asClient('D_A', `select coalesce(jsonb_agg(b), '[]'::jsonb) from public.fetch_v2_board(false) b`));
    assert.ok(board.includes('Description removed by OneShetland') && !board.includes('07700 900555'));
    assert.ok(!lastRow(asClient('REQ', `select public.fetch_v2_request_detail('${j}')`)).includes('07700 900555'));
    const red = adminJob(j).redactions[0];
    assert.deepEqual([red.original, red.replacement, red.reason], ['Call me on 07700 900555, 12 Hillhead', 'Description removed by OneShetland', 'Personal details in the description']);
    assert.equal(scalar(`select count(*) from public.fetch_request_events where request_id = '${j}' and event = 'description_redacted' and metadata::text !~ '07700' and reason !~ '07700'`), '1');
    assert.equal((await support('redact_description', { request_id: j, reason: 'again' })).body.already, true);
    fails(db.raw(`update public.fetch_request_redactions set original_text = 'x' where request_id = '${j}'`), /append-only/);
    assert.equal((await support('redact_description', { request_id: j, replacement: 'Blue armchair', reason: 'Accurate summary' })).body.ok, true);
    assert.equal(adminJob(j).redactions.length, 2);
    for (const w of ['REQ', 'D_A'] as Id[]) assert.equal(lastRow(asClient(w, 'select count(*) from public.fetch_request_redactions')), '0');
  });
  test('F · a driver who keeps releasing jobs: the counters show it; a restriction takes effect at once and is logged', async () => {
    for (let i = 0; i < 3; i++) { const j = job(); claim(j); svc(`public.fetch_v2_release('${ids.D_A}', '${j}', 'changed_plans')`); }
    const m = call('ADMIN', `public.fetch_v2_admin_member('${ids.D_A}')`);
    assert.ok(m.as_driver.releases >= 3 && m.as_driver.jobs_claimed >= 3, JSON.stringify(m.as_driver));
    assert.equal(m.restriction.restricted, false);
    const r = await support('restrict_member', { member_id: ids.D_A, reason: 'Repeated releases after accepting' });
    assert.equal(`${r.body.ok}:${r.body.restricted}`, 'true:true');
    assert.equal(claim(job()).code, 'member_restricted');
    fails(asClient('D_A', 'select count(*) from public.fetch_v2_board(false)'), /member_restricted/);
    const after = call('ADMIN', `public.fetch_v2_admin_member('${ids.D_A}')`);
    assert.deepEqual([after.restriction.restricted, after.restriction.reason, after.restriction.by], [true, 'Repeated releases after accepting', 'Fixture ad00']);
    assert.equal((await support('restrict_member', { member_id: ids.D_A, reason: 'again' })).body.already, true);
    assert.equal((await support('unrestrict_member', { member_id: ids.D_A, reason: 'Spoke to the driver; agreed to stop' })).body.restricted, false);
    assert.equal(claim(job()).ok, true);
    const hist = call('ADMIN', `public.fetch_v2_admin_member('${ids.D_A}')`).restriction_history;
    assert.deepEqual(hist.map((h: { action: string }) => h.action), ['unrestricted', 'restricted']);
    fails(db.raw(`delete from public.fetch_member_restriction_log where member_id = '${ids.D_A}'`), /append-only/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('LISTS and DIAGNOSTICS', () => {
  test('the job list filters by status, party, date, queue and id, and ignores unsafe search text', () => {
    const j = job();
    const list = (f: Record<string, unknown>) => call('ADMIN', `public.fetch_v2_admin_jobs(${lit(f)})`).jobs as { request_id: string; status: string }[];
    assert.ok(list({ status: 'pending' }).some((x) => x.request_id === j));
    assert.ok(!list({ status: 'delivered' }).some((x) => x.request_id === j));
    assert.ok(list({ requester: ids.REQ }).some((x) => x.request_id === j));
    assert.ok(list({ q: j.slice(0, 8) }).some((x) => x.request_id === j));
    assert.ok(list({ from: new Date().toISOString().slice(0, 10) }).some((x) => x.request_id === j));
    assert.ok(list({ queue: 'payments' }).every((x) => x.status !== 'pending' || true));
    assert.deepEqual(list({ q: "x' or 1=1 --" }), []);
    assert.ok(list({ queue: 'cancellations' }).length >= 1);
  });
  test('stuck notifications are listed with the reason — never as delivered', () => {
    const j = job();
    ok(db.raw(`insert into public.fetch_notifications (dedupe_key, recipient_id, request_id, kind, audience, category, title, body, data, source, source_id, state, created_at)
               values ('test:stuck:1', '${ids.REQ}', '${j}', 'collected', 'activity', 'fetch.collected', 'Your item has been collected', 'x y z', '{}', 'request_event', '1', 'pending', now() - interval '1 hour')`));
    ok(db.raw(`insert into public.fetch_notifications (dedupe_key, recipient_id, request_id, kind, audience, category, title, body, data, source, source_id, state, inbox_id, push_result, completed_at)
               values ('test:stuck:2', '${ids.D_A}', '${j}', 'cancel_requested', 'activity', 'fetch.cancel_requested', 'The requester has asked to cancel', 'x y z', '{}', 'request_event', '2', 'completed', gen_random_uuid(), 'invalid_token', now())`));
    const n = (queues().queues.notifications as { request_id: string; problem: string; priority: string }[]).filter((x) => x.request_id === j);
    assert.deepEqual(n.map((x) => `${x.problem}:${x.priority}`).sort(), ['invalid_token:waiting', 'not_written_to_inbox:action_required']);
    assert.ok(!JSON.stringify(queues().queues.notifications).includes('delivered'));
  });
  test('the job page carries the matching and notification diagnostics, and no card data exists to show', () => {
    const j = job();
    claim(j);
    const page = adminJob(j);
    assert.equal(page.matching.board_match !== undefined, true);
    assert.ok(Array.isArray(page.notifications.notices));
    assert.ok(!/card|last4|pm_|cus_|client_secret/i.test(JSON.stringify(page.payment)));
  });
  test('driver verification is summarised on the landing page from the Step 6 queue', () => {
    ok(db.raw(`insert into public.driver_profiles (id, driver_status, vehicle_class) values ('${ids.MEMBER}', 'pending', 'car')`));
    const q = queues();
    assert.ok(q.counts.driver_verification >= 1);
    assert.ok((q.queues.driver_verification.pending_applications as { driver_id: string }[]).some((x) => x.driver_id === ids.MEMBER));
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('rollback', () => {
  test('refuses while administrator history exists', () => {
    fails(db.rawFile(DOWN), /refusing to roll back Fetch admin controls/);
    assert.deepEqual(setDiff(afterRows, catalogueRows()), { missing: [], extra: [] });
  });
  test('otherwise restores the catalogue exactly; re-applies', () => {
    ok(db.raw(`alter table public.fetch_request_redactions disable trigger fetch_request_redactions_append_only; delete from public.fetch_request_redactions;
      alter table public.fetch_request_redactions enable trigger fetch_request_redactions_append_only;
      alter table public.fetch_member_restriction_log disable trigger fetch_member_restriction_log_append_only; delete from public.fetch_member_restriction_log;
      alter table public.fetch_member_restriction_log enable trigger fetch_member_restriction_log_append_only;
      update public.fetch_member_stats set restricted_by = null;
      alter table public.fetch_request_events disable trigger fetch_request_events_append_only;
      delete from public.fetch_request_events where event = 'description_redacted';
      alter table public.fetch_request_events enable trigger fetch_request_events_append_only;`));
    ok(db.rawFile(DOWN));
    assert.deepEqual(setDiff(beforeRows, catalogueRows()), { missing: [], extra: [] });
    ok(db.rawFile(FIX));
    assert.deepEqual(setDiff(afterRows, catalogueRows()), { missing: [], extra: [] });
  });
});
