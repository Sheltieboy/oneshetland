/**
 * fetch-v2-driver-verification.node.test.ts — Fetch v2 Step 6: driver verification (migration 20261220000000 +
 * supabase/functions/_shared/fetch-v2-verification.ts), against the real SQL.
 *
 * The REAL handlers (become-driver's apply, the driver's own evidence, the admin review and decisions, the sweep, and Step 5's accept)
 * run against a throwaway database replayed from every migration. Document storage is an in-memory store that behaves like the parts of
 * Supabase Storage this relies on: one-use signed uploads to an exact path (never an overwrite), signed links with a lifetime, removal.
 * Storage ROW-LEVEL policies are tested for real, on the replayed storage.objects table. Stripe is a minimal fake (the claim gate only).
 *
 * SAFETY — ISOLATED DATABASE ONLY (PASS_PROOF_DSN). Fake users; fake storage; fake Stripe; no network.
 * Run: ISOLATED_ONLY=fetch-v2-driver-verification npm run test:isolated
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';
import { handleApply, handleDriverVerification, handleVerificationAdmin, runVerificationSweep, sniffType, DRIVER_LINK_SECS,
  REVIEWER_LINK_SECS, type EvidenceStorage, type VerificationDeps } from '../functions/_shared/fetch-v2-verification.ts';
import { handleAccept, type PaymentDeps } from '../functions/_shared/fetch-v2-payments.ts';
import type { PaymentIntent, StripeGateway } from '../functions/_shared/fetch-v2-stripe.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX_NAME = '20261220000000_fetch_v2_driver_verification.sql';
const FIX = join(REPO_ROOT, 'supabase/migrations', FIX_NAME);
const DOWN = join(REPO_ROOT, 'supabase/rollbacks/20261220000000_fetch_v2_driver_verification.down.sql');

let db: ReplayDb;
const tag = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !tag.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT|^NOTICE/.test(l));
const lastRow = (o: string) => rowsOf(o).pop() ?? '';
const scalar = (sql: string) => lastRow(db.raw(sql));
const ok = (o: string) => assert.doesNotMatch(o, /ERROR/, o);
const fails = (o: string, re: RegExp = /ERROR/) => assert.match(o, re, o);

const ids = {
  ADMIN: 'ad000000-0000-4000-8000-0000000000ad',
  ADMIN2: 'ad000000-0000-4000-8000-0000000000ae',
  REQ: 'a1000000-0000-4000-8000-000000000001',
  APPLICANT: 'b1000000-0000-4000-8000-000000000001',
  DRV: 'b2000000-0000-4000-8000-000000000002',        // taken all the way to approved by the real flow
  DRV_B: 'b3000000-0000-4000-8000-000000000003',
  DRV_C: 'b4000000-0000-4000-8000-000000000004',
  DRV_D: 'b5000000-0000-4000-8000-000000000005',
  OTHER: 'c1000000-0000-4000-8000-000000000001',      // an unrelated member
  RESTRICTED: 'c2000000-0000-4000-8000-000000000002',
  NOADULT: 'c3000000-0000-4000-8000-000000000003',
} as const;
type Id = keyof typeof ids;
const client = (w: Id, call: string) => lastRow(db.raw(`begin; set local request.jwt.claim.sub = '${ids[w]}'; set local role authenticated; select ${call}; commit;`));
const asClient = (w: Id, stmt: string) => db.raw(`begin; set local request.jwt.claim.sub = '${ids[w]}'; set local role authenticated; ${stmt}; commit;`);
const asAnon = (stmt: string) => db.raw(`begin; set local role anon; ${stmt}; commit;`);
const lit = (v: unknown) => (v === null || v === undefined ? 'null' : typeof v === 'object' ? `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`
  : typeof v === 'boolean' || typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const SETOF = new Set(['fetch_v2_stale_evidence_uploads', 'fetch_v2_verification_state', 'fetch_v2_claim_authorisation', 'fetch_v2_hold_ready',
  'claim_fetch_capture', 'fetch_v2_payment_work', 'fetch_v2_release_unpaid_due']);
const rpc = async (fn: string, args: Record<string, unknown>) => {
  const named = Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(', ');
  const sql = SETOF.has(fn) ? `coalesce(jsonb_agg(t), '[]'::jsonb) from public.${fn}(${named}) t` : `to_json(public.${fn}(${named}))`;
  const o = db.raw(`begin; set local role service_role; select ${sql}; commit;`);
  if (/ERROR/.test(o)) return { data: null, error: { message: o } };
  return { data: JSON.parse(lastRow(o)), error: null };
};

// ── in-memory document storage ──────────────────────────────────────────────────────────────────────────────────────────────
class FakeStorage implements EvidenceStorage {
  objects = new Map<string, Uint8Array>();
  tokens = new Map<string, string>();
  links: { path: string; ttl: number }[] = [];
  removed: string[] = [];
  async signedUpload(path: string) { const token = randomUUID(); this.tokens.set(token, path); return { url: `https://storage.test/upload/sign/${path}?token=${token}`, token }; }
  /** What the client does with the signed upload: one use, exact path, never an overwrite. */
  clientUpload(token: string, bytes: Uint8Array): 'ok' | 'invalid_token' | 'exists' {
    const path = this.tokens.get(token);
    if (!path) return 'invalid_token';
    if (this.objects.has(path)) return 'exists';
    this.tokens.delete(token);
    this.objects.set(path, bytes);
    return 'ok';
  }
  async inspect(path: string) { const b = this.objects.get(path); return b ? { size: b.length, head: b.slice(0, 16) } : null; }
  async signedUrl(path: string, ttl: number) { this.links.push({ path, ttl }); return `https://storage.test/object/sign/${randomUUID()}?expires_in=${ttl}`; }
  async remove(path: string) { this.objects.delete(path); this.removed.push(path); }
}
const storage = new FakeStorage();
const vdeps = (): VerificationDeps => ({ rpc, storage, limit: async () => true });

const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(64).fill(0x20)]);
const PDF = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const EXE = bytes(0x4d, 0x5a, 0x90, 0x00);

const apply = (w: Id, body: Record<string, unknown>) => handleApply(ids[w], body, vdeps());
const drv = (w: Id, action: string, extra: Record<string, unknown> = {}) => handleDriverVerification(ids[w], { action, ...extra }, vdeps());
const adm = (action: string, extra: Record<string, unknown> = {}, who: Id = 'ADMIN') => handleVerificationAdmin(ids[who], { area: 'drivers', action, ...extra }, vdeps());
async function submit(w: Id, kind: string, mime = 'application/pdf', file = PDF): Promise<string> {
  const b = await drv(w, 'begin_upload', { kind, mime_type: mime, size_bytes: file.length });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(storage.clientUpload(String(b.body.upload_token), file), 'ok');
  const s = await drv(w, 'submit', { upload_id: b.body.upload_id });
  assert.equal(`${s.status}:${s.body.status}`, '200:submitted', JSON.stringify(s.body));
  return String(s.body.item_id);
}
const inDays = (d: number) => new Date(Date.now() + d * 86400_000).toISOString().slice(0, 10);
const approve = (item: string, expires_on?: string) => adm('review', { item_id: item, outcome: 'approve', ...(expires_on ? { expires_on } : {}) });
/** The whole real flow: apply → evidence → review → decision. Returns the item ids. */
async function makeApproved(w: Id, o: { vehicle_class?: string; max_size_class?: string; licence?: number; insurance?: number } = {}) {
  assert.equal((await apply(w, { vehicle_class: o.vehicle_class ?? 'van', max_size_class: o.max_size_class ?? 'bulky', vehicle_reg: 'ZE12 ABC' })).body.driver_status, 'pending');
  const it: Record<string, string> = {};
  for (const k of ['identity_check', 'licence', 'vehicle', 'insurance']) it[k] = await submit(w, k);
  assert.equal((await approve(it.identity_check)).body.status, 'verified');
  assert.equal((await approve(it.licence, inDays(o.licence ?? 900))).body.status, 'verified');
  assert.equal((await approve(it.vehicle)).body.status, 'verified');
  const last = await approve(it.insurance, inDays(o.insurance ?? 200));
  assert.equal(last.body.evidence_complete, true, JSON.stringify(last.body));
  const d = await adm('decide', { driver_id: ids[w], decision: 'approve', reason: 'Documents checked' });
  assert.equal(d.body.driver_status, 'approved', JSON.stringify(d.body));
  ok(db.raw(`update public.driver_profiles set stripe_account_id = 'acct_${w}', stripe_payouts_enabled = true where id = '${ids[w]}'`));
  return it;
}
const problem = (w: Id) => scalar(`select coalesce(public.fetch_v2_driver_problem('${ids[w]}'), 'none')`);
const okUntil = (w: Id) => scalar(`select coalesce(verification_ok_until::text, 'null') from public.driver_profiles where id = '${ids[w]}'`);
const events = (w: Id) => scalar(`select string_agg(event, ',' order by id) from public.driver_verification_events where driver_id = '${ids[w]}'`);
const status = (w: Id) => scalar(`select driver_status from public.driver_profiles where id = '${ids[w]}'`);

// ── jobs (for the claim, collection and active-job rules) ───────────────────────────────────────────────────────────────────
const RG: Record<string, string> = {};
function newJob(size = 'small'): string {
  const p = { idempotency_key: `k-${randomUUID()}`, category_slug: 'small-parcel', item_description: 'Box of books', size_class: size,
    pickup_region_id: RG['north-mainland'], pickup_name: 'Mrs Isbister', pickup_location: '7 Westerloch, Brae', pickup_lat: 60.396, pickup_lng: -1.353,
    destination_region_id: RG.lerwick, destination_address: '12 Hillhead, Lerwick', dest_lat: 60.155, dest_lng: -1.145,
    contact_phone: '07700 900123', scheduling_mode: 'asap', ...(size === 'bulky' ? { approx_dimensions_cm: { l: 200, w: 90, h: 80 } } : {}) };
  const o = db.raw(`begin; set local role service_role; select public.fetch_v2_create_request('${ids.REQ}', ${lit(p)}); commit;`);
  const out = JSON.parse(lastRow(o));
  assert.equal(out.ok, true, o);
  return out.request_id;
}
const claim = (w: Id, id: string) => JSON.parse(lastRow(db.raw(`begin; set local role service_role; select public.fetch_v2_claim('${ids[w]}', '${id}', true); commit;`)));
const job = (id: string, cols: string) => scalar(`select ${cols} from public.delivery_requests where id = '${id}'`);

// A minimal Stripe for Step 5's accept (only reached when every eligibility check passes).
class MiniStripe implements StripeGateway {
  n = 0; created = 0;
  private pi = (o: Partial<PaymentIntent>): PaymentIntent => ({ id: `pi_v_${++this.n}`, status: 'requires_capture', amount: 0, amount_capturable: 0,
    amount_received: 0, client_secret: null, capture_before: Math.floor(Date.now() / 1000) + 7 * 86400, metadata: {}, ...o });
  async createHold(p: Parameters<StripeGateway['createHold']>[0]) { this.created++; return this.pi({ amount: p.amount, amount_capturable: p.amount, metadata: p.metadata }); }
  async retrieve(id: string) { return this.pi({ id }); }
  async cancel(id: string) { return this.pi({ id, status: 'canceled' }); }
  async capture(id: string) { return this.pi({ id, status: 'succeeded' }); }
}
const stripe = new MiniStripe();
const pdeps = (): PaymentDeps => ({ rpc, stripe, limit: async () => true, isAdmin: async (u) => u === ids.ADMIN,
  customerCard: async () => ({ customerId: 'cus_REQ', paymentMethodId: 'pm_REQ' }),
  driverAccount: async (d) => ({ accountId: scalar(`select stripe_account_id from public.driver_profiles where id = '${d}'`) || null,
    payoutsEnabled: scalar(`select stripe_payouts_enabled from public.driver_profiles where id = '${d}'`) === 't' }) });
const accept = (w: Id, id: string) => handleAccept(ids[w], { request_id: id, vehicle_confirmed: true }, pdeps());

// ── catalogue (exact rollback) ──────────────────────────────────────────────────────────────────────────────────────────────
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
    union all select 'rl:' || action || ':' || window_seconds || ':' || max_count from public.rate_limit_policies
    union all select 'cfg:' || key || '=' || value from public.admin_config where key like 'fetch.%' and key <> 'fetch.v2.audience'
  ) s order by x`);
  assert.doesNotMatch(o, /ERROR/, o);
  return rowsOf(o).filter((l) => !/^x$|^-+$|^\(\d+ rows?\)$/.test(l));
};
const setDiff = (want: string[], got: string[]) => ({ missing: want.filter((x) => !got.includes(x)), extra: got.filter((x) => !want.includes(x)) });

before(() => {
  db = createReplayDb('fetchv2ver', { stopBefore: FIX_NAME });
  const all = Object.values(ids).map((i) => `'${i}'::uuid`).join(',');
  const slugs = ['lerwick', 'scalloway', 'north-mainland', 'yell', 'unst', 'bressay'];
  ok(db.raw(`
    insert into auth.users (id, email) select x, 'u' || substr(x::text,1,4) || '@example.org' from unnest(array[${all}]) x on conflict do nothing;
    insert into public.profiles (id, full_name) select x, 'Fixture ' || substr(x::text,1,4) from unnest(array[${all}]) x on conflict (id) do nothing;
    update public.profiles set role = 'admin' where id in ('${ids.ADMIN}', '${ids.ADMIN2}');
    insert into public.regions (slug, name, display_order) select s, initcap(replace(s, '-', ' ')), o from unnest(array[${slugs.map((s) => `'${s}'`).join(',')}]) with ordinality t(s, o);
    update public.regions set island_group = case when slug in ('yell','unst','bressay') then slug else 'mainland' end;
    insert into public.delivery_pricing_config (price_per_mile_pence, min_fee_pence, road_correction_factor) values (65, 400, 1.40);
    insert into public.admin_config (key, value, category) values ('fees.fetch.fixed_pence', '150', 'fees'), ('fees.fetch.percent_bps', '0', 'fees')
      on conflict (key) do update set value = excluded.value;
    insert into public.delivery_categories (slug, name) values ('small-parcel', 'Small parcel');
    -- as on Supabase: client roles hold table privileges on storage.objects and row-level security decides
    grant select, insert, update, delete on storage.objects to anon, authenticated;`));
  for (const s of slugs) RG[s] = scalar(`select id from public.regions where slug = '${s}'`);
  ok(db.raw(`update public.admin_config set value = 'everyone' where key = 'fetch.v2.audience'`));
  for (const w of Object.keys(ids) as Id[]) if (w !== 'NOADULT') assert.match(client(w, `public.fetch_v2_confirm_adult('fetch-18plus-v1')`), /"ok": true/);
  ok(db.raw(`update public.fetch_member_stats set restricted_at = now(), restricted_reason = 'Test restriction' where user_id = '${ids.RESTRICTED}'`));
  beforeRows = catalogueRows();
  ok(db.rawFile(FIX));
  afterRows = catalogueRows();
});
after(() => { db?.drop(); });

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('1 · APPLICATION — only ever pending', () => {
  test('an ordinary member applies: pending, recorded, nothing approved', async () => {
    const r = await apply('APPLICANT', { vehicle_class: 'car', max_size_class: 'medium', vehicle_reg: 'ze 12 abc', statement: 'I drive daily' });
    assert.equal(`${r.status}:${r.body.driver_status}`, '200:pending', JSON.stringify(r.body));
    assert.equal(scalar(`select driver_status || ':' || vehicle_class || ':' || vehicle_reg || ':' || coalesce(verification_ok_until::text, 'null')
      from public.driver_profiles where id = '${ids.APPLICANT}'`), 'pending:car:ZE 12 ABC:null');
    assert.match(events('APPLICANT'), /vehicle_changed,application_submitted/);
    assert.equal(problem('APPLICANT'), 'driver_not_approved');
  });
  test('a modified payload cannot approve: status, verification, decision and review fields are ignored', async () => {
    const r = await apply('DRV_D', { vehicle_class: 'car', vehicle_reg: 'AB1', driver_status: 'approved', verification_ok_until: '2099-01-01',
      decided_by: ids.ADMIN, decision_reason: 'ok', approved: true, verified: true, status: 'verified' });
    assert.equal(r.body.driver_status, 'pending');
    assert.equal(scalar(`select driver_status || ':' || coalesce(verification_ok_until::text, 'null') || ':' || coalesce(decided_by::text, 'null')
      from public.driver_profiles where id = '${ids.DRV_D}'`), 'pending:null:null');
  });
  test('the original apply form (vehicle type + registration, no class) still works and still only reaches pending', async () => {
    const r = await apply('DRV_C', { vehicle_type: 'Ford Transit', vehicle_reg: 'ab12 cde', statement: 'hi' });
    assert.equal(r.body.driver_status, 'pending');
    assert.equal(scalar(`select vehicle_reg || ':' || coalesce(vehicle_class, 'none') from public.driver_profiles where id = '${ids.DRV_C}'`), 'AB12 CDE:none');
    assert.equal((await apply('OTHER', { vehicle_type: 'Car' })).body.error, 'Vehicle type and registration are required.');
  });
  test('a direct RPC cannot approve: every decision and service function is closed to clients', () => {
    for (const call of [`public.fetch_v2_decide_driver('${ids.APPLICANT}', '${ids.APPLICANT}', 'approve', 'x')`,
      `public.fetch_v2_apply_driver('${ids.APPLICANT}', '{}'::jsonb)`, `public.fetch_v2_sync_verification('${ids.APPLICANT}', null, 'system')`,
      `public.fetch_v2_review_evidence('${ids.APPLICANT}', gen_random_uuid(), 'approve', null, null)`, `public.fetch_v2_verification_sweep()`,
      `public.fetch_v2_set_requirement('${ids.APPLICANT}', '{}'::jsonb)`])
      fails(asClient('APPLICANT', `select ${call}`), /permission denied/);
    assert.equal(status('APPLICANT'), 'pending');
  });
  test('a direct table write cannot approve — the applicant\'s or an administrator\'s browser session alike', () => {
    fails(asClient('APPLICANT', `update public.driver_profiles set driver_status = 'approved' where id = '${ids.APPLICANT}'`), /audited actions/);
    fails(asClient('APPLICANT', `update public.driver_profiles set verification_ok_until = '2099-01-01' where id = '${ids.APPLICANT}'`), /audited actions/);
    fails(asClient('APPLICANT', `update public.driver_profiles set max_size_class = 'bulky' where id = '${ids.APPLICANT}'`), /audited actions/);
    fails(asClient('ADMIN', `update public.driver_profiles set driver_status = 'approved' where id = '${ids.APPLICANT}'`), /audited actions/);
    // a member creating their own row with approval in it gets an ordinary not-applied row
    ok(asClient('OTHER', `insert into public.driver_profiles (id, driver_status, vehicle_class, max_size_class, verification_ok_until)
      values ('${ids.OTHER}', 'approved', 'van', 'bulky', '2099-01-01')`));
    assert.equal(scalar(`select driver_status || ':' || coalesce(vehicle_class, '-') || ':' || coalesce(verification_ok_until::text, '-')
      from public.driver_profiles where id = '${ids.OTHER}'`), 'not_applied:-:-');
    // the driver can still edit their own unrelated fields
    ok(asClient('APPLICANT', `update public.driver_profiles set notes = 'updated' where id = '${ids.APPLICANT}'`));
    assert.equal(status('APPLICANT'), 'pending');
  });
  test('restricted, not-18+-confirmed and Fetch-disabled members cannot apply', async () => {
    assert.equal((await apply('RESTRICTED', { vehicle_class: 'car', vehicle_reg: 'AB1' })).body.code, 'member_restricted');
    assert.equal((await apply('NOADULT', { vehicle_class: 'car', vehicle_reg: 'AB1' })).body.code, 'age_confirmation_required');
    ok(db.raw(`update public.admin_config set value = 'admins' where key = 'fetch.v2.audience'`));
    assert.equal((await apply('OTHER', { vehicle_class: 'car', vehicle_reg: 'AB1' })).body.code, 'fetch_unavailable');
    ok(db.raw(`update public.admin_config set value = 'everyone' where key = 'fetch.v2.audience'`));
    assert.equal(scalar(`select count(*) from public.driver_profiles where id in ('${ids.RESTRICTED}', '${ids.NOADULT}')`), '0');
  });
  test('vehicle rules: a registration for motor vehicles, small items only without one', async () => {
    assert.equal((await apply('OTHER', { vehicle_class: 'van', max_size_class: 'bulky' })).body.code, 'registration_required');
    assert.equal((await apply('OTHER', { vehicle_class: 'bicycle', max_size_class: 'medium' })).body.code, 'size_exceeds_vehicle');
    assert.equal((await apply('OTHER', { vehicle_class: 'hovercraft', vehicle_reg: 'X1' })).body.code, 'invalid_vehicle');
    assert.equal(status('OTHER'), 'not_applied', 'a refused vehicle leaves the application unchanged');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('2 · UPLOAD', () => {
  test('a driver hands in their own evidence: server path, signed one-use upload, real type checked, submitted (never reviewed)', async () => {
    const b = await drv('APPLICANT', 'begin_upload', { kind: 'licence', mime_type: 'image/jpeg', size_bytes: JPEG.length, path: '../../x', status: 'verified' });
    assert.equal(b.status, 200);
    const path = scalar(`select storage_path from public.driver_verification_uploads where id = '${b.body.upload_id}'`);
    assert.match(path, new RegExp(`^drivers/${ids.APPLICANT}/[0-9a-f-]{36}/[0-9a-f-]{36}\\.jpg$`));
    assert.ok(!('storage_path' in b.body));
    assert.equal(storage.clientUpload(String(b.body.upload_token), JPEG), 'ok');
    assert.equal(storage.clientUpload(String(b.body.upload_token), PDF), 'invalid_token', 'one use');
    const s = await drv('APPLICANT', 'submit', { upload_id: b.body.upload_id, status: 'verified', expires_on: '2099-01-01' });
    assert.equal(`${s.body.status}:${s.body.version}`, 'submitted:1');
    assert.equal(scalar(`select status || ':' || coalesce(expires_at::text, 'null') || ':' || coalesce(verified_by::text, 'null')
      from public.driver_verification_items where id = '${s.body.item_id}'`), 'submitted:null:null');
    assert.equal((await drv('APPLICANT', 'submit', { upload_id: b.body.upload_id })).body.already, true, 'a repeat is harmless');
    assert.match(events('APPLICANT'), /evidence_submitted/);
  });
  test('another member cannot use, submit or discard someone else\'s upload; a member who has not applied cannot upload', async () => {
    const b = await drv('APPLICANT', 'begin_upload', { kind: 'vehicle', mime_type: 'application/pdf', size_bytes: PDF.length });
    storage.clientUpload(String(b.body.upload_token), PDF);
    assert.equal((await drv('OTHER', 'submit', { upload_id: b.body.upload_id })).body.code, 'not_found');
    assert.equal((await drv('OTHER', 'discard_upload', { upload_id: b.body.upload_id })).body.code, 'not_found');
    assert.equal((await drv('OTHER', 'begin_upload', { kind: 'licence', mime_type: 'application/pdf', size_bytes: 10 })).body.code, 'driver_not_applied');
    assert.equal((await drv('APPLICANT', 'submit', { upload_id: b.body.upload_id })).body.status, 'submitted');
  });
  test('only configured evidence kinds for the driver\'s vehicle', async () => {
    for (const kind of ['passport', '../../etc', 'licence\'; drop table x;--', 'LICENCE'])
      assert.equal((await drv('APPLICANT', 'begin_upload', { kind, mime_type: 'application/pdf', size_bytes: 10 })).body.code, 'evidence_kind_not_required', kind);
  });
  test('only PDF / JPEG / PNG / WEBP / HEIC, checked by the file\'s real bytes, not the declared type', async () => {
    for (const mime of ['application/x-msdownload', 'text/html', 'image/svg+xml', 'application/zip'])
      assert.equal((await drv('APPLICANT', 'begin_upload', { kind: 'insurance', mime_type: mime, size_bytes: 10 })).body.code, 'file_type_not_allowed', mime);
    const b = await drv('APPLICANT', 'begin_upload', { kind: 'insurance', mime_type: 'application/pdf', size_bytes: EXE.length });
    storage.clientUpload(String(b.body.upload_token), EXE);
    const path = scalar(`select storage_path from public.driver_verification_uploads where id = '${b.body.upload_id}'`);
    const s = await drv('APPLICANT', 'submit', { upload_id: b.body.upload_id });
    assert.equal(`${s.status}:${s.body.code}`, '415:file_type_mismatch');
    assert.ok(!storage.objects.has(path), 'the object is removed');
    assert.equal(scalar(`select count(*) from public.driver_verification_uploads where id = '${b.body.upload_id}'`), '0');
    assert.deepEqual([sniffType(PDF), sniffType(JPEG), sniffType(PNG), sniffType(EXE)], ['application/pdf', 'image/jpeg', 'image/png', null]);
  });
  test('oversized: refused when declared, and when the stored file turns out larger', async () => {
    assert.equal((await drv('APPLICANT', 'begin_upload', { kind: 'insurance', mime_type: 'application/pdf', size_bytes: 11 * 1024 * 1024 })).body.code, 'file_too_large');
    const b = await drv('APPLICANT', 'begin_upload', { kind: 'insurance', mime_type: 'application/pdf', size_bytes: 100 });
    const big = new Uint8Array(10 * 1024 * 1024 + 1); big.set(PDF.slice(0, 8));
    storage.clientUpload(String(b.body.upload_token), big);
    assert.equal((await drv('APPLICANT', 'submit', { upload_id: b.body.upload_id })).body.code, 'file_too_large');
  });
  test('no path traversal and no overwrite: paths are the server\'s, unique, and checked by the database', async () => {
    fails(db.raw(`insert into public.driver_verification_uploads (driver_id, item_id, kind, storage_path, mime_type, size_bytes, expires_at)
      values ('${ids.APPLICANT}', gen_random_uuid(), 'licence', 'drivers/${ids.DRV}/../x.pdf', 'application/pdf', 1, now())`), /check constraint/);
    fails(db.raw(`insert into public.driver_verification_files (item_id, storage_path, mime_type, size_bytes)
      select id, 'drivers/${ids.APPLICANT}/' || id || '/../../${ids.DRV}/x.pdf', 'application/pdf', 1 from public.driver_verification_items where driver_id = '${ids.APPLICANT}' limit 1`), /check constraint/);
    const b = await drv('APPLICANT', 'begin_upload', { kind: 'identity_check', mime_type: 'image/png', size_bytes: PNG.length });
    const path = scalar(`select storage_path from public.driver_verification_uploads where id = '${b.body.upload_id}'`);
    storage.objects.set(path, PDF);    // something already there
    assert.equal(storage.clientUpload(String(b.body.upload_token), PNG), 'exists', 'a signed upload never overwrites');
    storage.objects.delete(path);
    // no client can write the bucket at all
    fails(asClient('APPLICANT', `insert into storage.objects (bucket_id, name, owner) values ('fetch-driver-verification', '${path}', '${ids.APPLICANT}')`), /row-level security|permission denied/);
    fails(asClient('ADMIN', `insert into storage.objects (bucket_id, name, owner) values ('fetch-driver-verification', 'drivers/x/y/z.pdf', '${ids.ADMIN}')`), /row-level security|permission denied/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('3 · READ ACCESS', () => {
  let item = '';
  before(() => {
    item = scalar(`select id from public.driver_verification_items where driver_id = '${ids.APPLICANT}' and kind = 'licence'`);
    ok(db.raw(`insert into storage.objects (bucket_id, name, owner) select 'fetch-driver-verification', storage_path, '${ids.APPLICANT}'
      from public.driver_verification_files f join public.driver_verification_items i on i.id = f.item_id where i.driver_id = '${ids.APPLICANT}'`));
  });
  test('the driver sees their own status — no storage paths, no reviewer identities', () => {
    const me = JSON.parse(client('APPLICANT', 'public.fetch_v2_my_verification()'));
    assert.equal(me.driver_status, 'pending');
    const lic = me.requirements.find((r: { kind: string }) => r.kind === 'licence');
    assert.equal(`${lic.required}:${lic.needs_expiry}:${lic.current.status}`, 'true:true:submitted');
    const text = JSON.stringify(me);
    assert.ok(!text.includes('drivers/') && !text.includes(ids.ADMIN) && !/verified_by|storage_path/.test(text), text);
  });
  test('a driver reads none of the raw tables or the bucket — not even their own rows', () => {
    for (const t of ['driver_verification_items', 'driver_verification_files', 'driver_verification_events'])
      assert.equal(lastRow(asClient('APPLICANT', `select count(*) from public.${t}`)), '0', t);
    fails(asClient('APPLICANT', 'select count(*) from public.driver_verification_uploads'), /permission denied/);
    assert.equal(lastRow(asClient('APPLICANT', `select count(*) from storage.objects where bucket_id = 'fetch-driver-verification'`)), '0');
  });
  test('the driver can get a short-lived link to their own document; nobody else can through the driver route', async () => {
    const own = await drv('APPLICANT', 'view_own', { item_id: item });
    assert.equal(`${own.status}:${own.body.expires_in}`, `200:${DRIVER_LINK_SECS}`);
    assert.ok(!String(own.body.url).includes('drivers/'));
    assert.equal((await drv('OTHER', 'view_own', { item_id: item })).body.code, 'not_found');
    assert.equal((await drv('DRV_D', 'view_own', { item_id: item })).body.code, 'not_found');
  });
  test('signed out: nothing', () => {
    fails(asAnon('select public.fetch_v2_my_verification()'), /permission denied/);
    for (const t of ['driver_verification_items', 'driver_verification_files', 'driver_verification_events', 'driver_verification_uploads'])
      fails(asAnon(`select count(*) from public.${t}`), /permission denied/);
    assert.equal(lastRow(asAnon(`select count(*) from storage.objects where bucket_id = 'fetch-driver-verification'`)), '0');
    assert.equal(scalar(`select public from storage.buckets where id = 'fetch-driver-verification'`), 'f');
  });
  test('an unrelated member: nothing', () => {
    for (const t of ['driver_verification_items', 'driver_verification_files', 'driver_verification_events'])
      assert.equal(lastRow(asClient('OTHER', `select count(*) from public.${t}`)), '0', t);
  });
  test('a reviewer sees the records and gets a 2-minute link (audited); a reviewer cannot browse the bucket directly', async () => {
    assert.notEqual(lastRow(asClient('ADMIN', 'select count(*) from public.driver_verification_items')), '0');
    const v = await adm('view_evidence', { item_id: item });
    assert.equal(`${v.status}:${v.body.expires_in}`, `200:${REVIEWER_LINK_SECS}`);
    assert.equal(storage.links.at(-1)!.ttl, REVIEWER_LINK_SECS);
    assert.match(events('APPLICANT'), /evidence_viewed/);
    assert.equal(lastRow(asClient('ADMIN', `select count(*) from storage.objects where bucket_id = 'fetch-driver-verification'`)), '0');
    ok(asClient('ADMIN', `delete from storage.objects where bucket_id = 'fetch-driver-verification'`));   // RLS: matches nothing
    assert.notEqual(scalar(`select count(*) from storage.objects where bucket_id = 'fetch-driver-verification'`), '0');
    assert.equal((await adm('view_evidence', { item_id: item }, 'OTHER')).body.code, 'forbidden');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('4 · REVIEW', () => {
  test('approve needs the document\'s expiry where the requirement has one, and it must be in the future', async () => {
    const lic = scalar(`select id from public.driver_verification_items where driver_id = '${ids.APPLICANT}' and kind = 'licence'`);
    assert.equal((await approve(lic)).body.code, 'expiry_required');
    assert.equal((await approve(lic, '2001-01-01')).body.code, 'expiry_out_of_range');
    const r = await approve(lic, inDays(400));
    assert.equal(r.body.status, 'verified');
    assert.equal(scalar(`select verified_by || ':' || ((expires_at at time zone 'Europe/London')::date = '${inDays(400)}') from public.driver_verification_items where id = '${lic}'`), `${ids.ADMIN}:true`);
    assert.equal(scalar(`select actor_id || ':' || (detail ->> 'version') from public.driver_verification_events where item_id = '${lic}' and event = 'evidence_approved'`), `${ids.ADMIN}:1`);
  });
  test('reject needs a reason; it is recorded with the reviewer, and the driver is told (outbox)', async () => {
    const veh = scalar(`select id from public.driver_verification_items where driver_id = '${ids.APPLICANT}' and kind = 'vehicle' and status = 'submitted'`);
    assert.equal((await adm('review', { item_id: veh, outcome: 'reject' })).body.code, 'reason_required');
    assert.equal((await adm('review', { item_id: veh, outcome: 'reject', reason: 'Registration not visible' })).body.status, 'rejected');
    assert.equal(scalar(`select notify_kind || ':' || reason from public.driver_verification_events where item_id = '${veh}' and event = 'evidence_rejected'`),
      'evidence_rejected:Registration not visible');
    const me = JSON.parse(client('APPLICANT', 'public.fetch_v2_my_verification()'));
    assert.equal(me.requirements.find((r: { kind: string }) => r.kind === 'vehicle').current.note, 'Registration not visible');
  });
  test('ordinary members cannot review; nobody reviews their own evidence', async () => {
    const id = await submit('APPLICANT', 'vehicle');
    assert.equal((await adm('review', { item_id: id, outcome: 'approve' }, 'DRV_D')).body.code, 'forbidden');
    await apply('ADMIN2', { vehicle_class: 'car', vehicle_reg: 'AD1' });
    const own = await submit('ADMIN2', 'identity_check');
    assert.equal((await adm('review', { item_id: own, outcome: 'approve' }, 'ADMIN2')).body.code, 'cannot_review_own');
    assert.equal((await adm('decide', { driver_id: ids.ADMIN2, decision: 'approve' }, 'ADMIN2')).body.code, 'cannot_review_own');
  });
  test('history is never rewritten: a rejected resubmission leaves the earlier approval standing, a later approval supersedes it', async () => {
    const v1 = scalar(`select id from public.driver_verification_items where driver_id = '${ids.APPLICANT}' and kind = 'licence' and status = 'verified'`);
    const v2 = await submit('APPLICANT', 'licence', 'image/png', PNG);
    assert.equal(scalar(`select status from public.driver_verification_items where id = '${v1}'`), 'verified', 'a renewal waiting for review does not unverify');
    await adm('review', { item_id: v2, outcome: 'reject', reason: 'Blurred' });
    const v3 = await submit('APPLICANT', 'licence');
    await approve(v3, inDays(800));
    assert.equal(scalar(`select string_agg(version || '=' || status, ',' order by version) from public.driver_verification_items
      where driver_id = '${ids.APPLICANT}' and kind = 'licence'`), '1=superseded,2=superseded,3=verified');
    assert.equal(scalar(`select count(*) from public.driver_verification_events where driver_id = '${ids.APPLICANT}' and event in ('evidence_approved', 'evidence_rejected')
      and detail ->> 'kind' = 'licence'`), '3');
    assert.equal(scalar(`select verified_by is not null and verified_at is not null from public.driver_verification_items where id = '${v1}'`), 't',
      'the superseded approval keeps who and when');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('5 · DECISION and verification_ok_until', () => {
  test('approval is refused until every required piece is verified, and says what is missing', async () => {
    const r = await adm('decide', { driver_id: ids.APPLICANT, decision: 'approve' });
    assert.equal(r.body.code, 'evidence_incomplete');
    assert.deepEqual(r.body.missing, ['identity_check', 'insurance', 'vehicle']);
    assert.equal(status('APPLICANT'), 'pending');
  });
  test('the full real flow approves a driver; verification_ok_until = the earliest required expiry', async () => {
    await makeApproved('DRV', { licence: 900, insurance: 200 });
    assert.equal(scalar(`select (verification_ok_until at time zone 'Europe/London')::date = '${inDays(200)}' from public.driver_profiles where id = '${ids.DRV}'`), 't', okUntil('DRV'));
    assert.equal(problem('DRV'), 'none');
    assert.match(events('DRV'), /driver_approved,verification_valid/);
    assert.equal(scalar(`select notify_kind from public.driver_verification_events where driver_id = '${ids.DRV}' and event = 'driver_approved'`), 'driver_approved');
  });
  test('replacing evidence recalculates: a renewed insurance moves the date', async () => {
    const ins = await submit('DRV', 'insurance');
    assert.equal(scalar(`select (verification_ok_until at time zone 'Europe/London')::date = '${inDays(200)}' from public.driver_profiles where id = '${ids.DRV}'`), 't', 'unchanged while waiting');
    await approve(ins, inDays(600));
    assert.equal(scalar(`select (verification_ok_until at time zone 'Europe/London')::date = '${inDays(600)}' from public.driver_profiles where id = '${ids.DRV}'`), 't', okUntil('DRV'));
  });
  test('optional evidence never blocks: missing, or expired', async () => {
    const r = await adm('set_requirement', { vehicle_class: 'van', evidence_kind: 'goods_in_transit', required: false, needs_expiry: true,
      guidance_text: 'Optional: goods-in-transit cover, if you have it.' });
    assert.equal(r.body.drivers_affected, 0);
    assert.equal(problem('DRV'), 'none');
    const git = await submit('DRV', 'goods_in_transit');
    await approve(git, inDays(5));
    ok(db.raw(`update public.driver_verification_items set expires_at = now() - interval '1 day' where id = '${git}'`));
    assert.equal(problem('DRV'), 'none');
  });
  test('a newly REQUIRED kind lapses existing drivers at once (requirements are data)', async () => {
    const r = await adm('set_requirement', { vehicle_class: 'van', evidence_kind: 'goods_in_transit', required: true, reason: 'Broker advice (test)' });
    assert.equal(r.body.drivers_affected, 1);
    assert.equal(problem('DRV'), 'driver_verification_expired', 'its only evidence has expired');
    assert.equal(okUntil('DRV'), 'null');
    assert.equal((await adm('set_requirement', { vehicle_class: 'van', evidence_kind: 'goods_in_transit', required: false })).body.drivers_affected, 1);
    assert.equal(problem('DRV'), 'none');
    assert.equal(scalar(`select count(*) from public.driver_verification_events where event = 'requirement_changed'`), '3');
    assert.equal((await adm('set_requirement', { vehicle_class: 'van', evidence_kind: 'x_y', guidance_text: 'abc' }, 'DRV_D')).body.code, 'forbidden');
  });
  test('reject, suspend and reinstate need reasons; a suspended driver cannot re-apply their way back', async () => {
    await apply('DRV_B', { vehicle_class: 'car', vehicle_reg: 'B1' });
    assert.equal((await adm('decide', { driver_id: ids.DRV_B, decision: 'reject' })).body.code, 'reason_required');
    assert.equal((await adm('decide', { driver_id: ids.DRV_B, decision: 'reject', reason: 'Not enough evidence' })).body.driver_status, 'rejected');
    assert.equal((await apply('DRV_B', { vehicle_class: 'car', vehicle_reg: 'B1' })).body.driver_status, 'pending', 'a rejected applicant may apply again');
    assert.match(events('DRV_B'), /driver_rejected.*application_resubmitted/);

    assert.equal((await adm('decide', { driver_id: ids.DRV, decision: 'suspend', reason: 'Complaint under review' })).body.driver_status, 'suspended');
    assert.equal(problem('DRV'), 'driver_suspended');
    assert.equal(okUntil('DRV'), 'null');
    const back = await apply('DRV', { vehicle_class: 'van', vehicle_reg: 'ZE12 ABC' });
    assert.equal(`${back.status}:${back.body.code}:${typeof back.body.error}`, '403:driver_suspended:string');
    assert.equal(status('DRV'), 'suspended');
    assert.equal((await adm('decide', { driver_id: ids.DRV, decision: 'reinstate' })).body.code, 'reason_required');
    assert.equal((await adm('decide', { driver_id: ids.DRV, decision: 'reinstate', reason: 'Resolved' })).body.driver_status, 'approved');
    assert.equal(problem('DRV'), 'none');
    assert.match(events('DRV'), /driver_suspended,verification_lapsed.*driver_reinstated,verification_valid/);
  });
  test('an approved driver re-applying changes nothing', async () => {
    const r = await apply('DRV', { vehicle_class: 'bicycle', vehicle_reg: 'X' });
    assert.equal(`${r.body.driver_status}:${r.body.already}`, 'approved:true');
    assert.equal(scalar(`select vehicle_class from public.driver_profiles where id = '${ids.DRV}'`), 'van');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('6 · VEHICLE', () => {
  test('a material vehicle change re-verifies the per-vehicle evidence and blocks new jobs until reviewed', async () => {
    await makeApproved('DRV_C', { vehicle_class: 'car', max_size_class: 'medium' });
    const r = await drv('DRV_C', 'set_vehicle', { vehicle_class: 'van', max_size_class: 'bulky', vehicle_reg: 'NEW 1' });
    assert.equal(r.body.re_verification_required, true);
    assert.equal(scalar(`select string_agg(kind || '=' || status, ',' order by kind) from public.driver_verification_items
      where driver_id = '${ids.DRV_C}' and status <> 'superseded'`), 'identity_check=verified,licence=verified');
    assert.equal(problem('DRV_C'), 'driver_verification_incomplete');
    assert.equal(scalar(`select notify_kind from public.driver_verification_events where driver_id = '${ids.DRV_C}' and event = 'vehicle_changed' order by id desc limit 1`),
      'replacement_required');
    await approve(await submit('DRV_C', 'vehicle'));
    await approve(await submit('DRV_C', 'insurance'), inDays(300));
    assert.equal(problem('DRV_C'), 'none');
  });
  test('a smaller size class needs no re-verification', async () => {
    const r = await drv('DRV_C', 'set_vehicle', { vehicle_class: 'van', max_size_class: 'large', vehicle_reg: 'NEW 1' });
    assert.equal(r.body.re_verification_required, false);
    assert.equal(problem('DRV_C'), 'none');
  });
  test('bulky stays capacity-gated at claim', () => {
    const id = newJob('bulky');
    assert.equal(claim('DRV_C', id).code, 'too_large_for_vehicle');
    // a verified bulky-capable van passes capacity; what stops it is Step 3's separate bulky-photo rule
    assert.equal(claim('DRV', id).code, 'item_photo_required');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('7 · CLAIM GATE (Step 5 accept)', () => {
  test('refuses a driver who is not approved, incomplete, expired or suspended — before any card hold', async () => {
    const before = stripe.created;
    assert.equal((await accept('APPLICANT', newJob())).body.code, 'driver_not_approved');
    await adm('decide', { driver_id: ids.DRV_C, decision: 'suspend', reason: 'Testing suspension' });
    assert.equal((await accept('DRV_C', newJob())).body.code, 'driver_suspended');
    await adm('decide', { driver_id: ids.DRV_C, decision: 'reinstate', reason: 'Testing done' });
    ok(db.raw(`update public.driver_verification_items set expires_at = now() - interval '1 minute'
      where driver_id = '${ids.DRV_C}' and kind = 'insurance' and status = 'verified'`));
    const r = await accept('DRV_C', newJob());
    assert.equal(`${r.status}:${r.body.code}`, '403:driver_verification_expired', 'live, even before the sweep runs');
    assert.equal(stripe.created, before);
  });
  test('a verified, approved driver with payouts succeeds', async () => {
    const r = await accept('DRV', newJob());
    assert.equal(`${r.status}:${r.body.payment}`, '200:authorised', JSON.stringify(r.body));
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('8 · EXPIRY SWEEP and ACTIVE JOBS', () => {
  let matched = '';
  let collected = '';
  before(async () => {
    await makeApproved('DRV_B', { vehicle_class: 'car', max_size_class: 'medium', insurance: 20 });
    matched = newJob(); assert.equal(claim('DRV_B', matched).ok, true);
    collected = newJob(); assert.equal(claim('DRV_B', collected).ok, true);
    ok(db.raw(`update public.delivery_requests set status = 'collected', collected_at = now() where id = '${collected}'`));
  });
  test('the sweep reminds once about evidence expiring within 30 days', async () => {
    const s = await runVerificationSweep(vdeps());
    assert.ok(s.expiring >= 1, JSON.stringify(s));
    const again = await runVerificationSweep(vdeps());
    assert.equal(again.expiring, 0);
    assert.equal(scalar(`select count(*) from public.driver_verification_events where driver_id = '${ids.DRV_B}' and event = 'evidence_expiring'`), '1');
  });
  test('insurance expires: the evidence is marked expired (its review kept), the driver lapses, a person is told about each live job', async () => {
    ok(db.raw(`update public.driver_verification_items set expires_at = now() - interval '1 minute' where driver_id = '${ids.DRV_B}' and kind = 'insurance' and status = 'verified'`));
    const s = await runVerificationSweep(vdeps());
    assert.ok(s.expired >= 1 && s.issues_opened >= 2, JSON.stringify(s));
    assert.equal(scalar(`select status || ':' || (verified_by is not null) from public.driver_verification_items where driver_id = '${ids.DRV_B}' and kind = 'insurance' and status = 'expired'`), 'expired:true');
    assert.equal(okUntil('DRV_B'), 'null');
    assert.equal(problem('DRV_B'), 'driver_verification_expired');
    assert.equal(scalar(`select count(*) from public.fetch_issues where kind = 'driver_verification' and status = 'open' and request_id in ('${matched}', '${collected}')`), '2');
    assert.match(events('DRV_B'), /evidence_expired,verification_lapsed/);
    assert.equal(scalar(`select notify_kind from public.driver_verification_events where driver_id = '${ids.DRV_B}' and event = 'evidence_expired'`), 'evidence_expired');
  });
  test('repeat-safe: a second and third run change nothing and touch no job', async () => {
    const snap = () => scalar(`select (select count(*) from public.driver_verification_events) || ':' || (select count(*) from public.fetch_issues) || ':' ||
      (select string_agg(status || coalesce(driver_id::text, '-'), ',' order by id) from public.delivery_requests)`);
    const s0 = snap();
    for (let i = 0; i < 2; i++) assert.deepEqual(await runVerificationSweep(vdeps()), { expired: 0, expiring: 0, drivers_synced: 0, issues_opened: 0, uploads_removed: 0, errors: 0 });
    assert.equal(snap(), s0);
  });
  test('a COLLECTED job is not stranded: the driver keeps the details and can finish or return it', () => {
    assert.equal(job(collected, `status || ':' || driver_id`), `collected:${ids.DRV_B}`);
    const detail = JSON.parse(client('DRV_B', `public.fetch_v2_request_detail('${collected}')`));
    assert.equal(detail.destination_address ?? detail.request?.destination_address, '12 Hillhead, Lerwick', JSON.stringify(detail));
    const pre = JSON.parse(lastRow(db.raw(`begin; set local role service_role; select public.fetch_v2_delivery_precheck('${ids.DRV_B}', '${collected}', false); commit;`)));
    assert.equal(pre.ok, true, JSON.stringify(pre));
    assert.match(client('DRV_B', `public.fetch_v2_mark_undeliverable('${collected}', 'recipient_absent')`), /"status": "undeliverable"/);
  });
  test('a job NOT yet collected: collection is refused, the job stays with the driver (not silently returned), a person is told', () => {
    const r = JSON.parse(client('DRV_B', `public.fetch_v2_mark_collected('${matched}')`));
    assert.equal(r.code, 'driver_verification_expired');
    assert.equal(job(matched, `status || ':' || driver_id`), `matched:${ids.DRV_B}`);
    assert.equal(scalar(`select count(*) from public.fetch_issues where request_id = '${matched}' and kind = 'driver_verification' and status = 'open'`), '1', 'still one');
  });
  test('the lapsed driver cannot claim anything new', () => {
    assert.equal(claim('DRV_B', newJob()).code, 'driver_verification_expired');
  });
  test('admin resolution, either way: renew and approve (collection then depends only on payment), or return the job to the board', async () => {
    const q = await adm('queue');
    assert.ok((q.body.lapsed_with_live_jobs as string[]).includes(ids.DRV_B));
    await approve(await submit('DRV_B', 'insurance'), inDays(365));
    assert.equal(problem('DRV_B'), 'none');
    const r = JSON.parse(client('DRV_B', `public.fetch_v2_mark_collected('${matched}')`));
    assert.equal(r.code, 'payment_not_ready', 'the verification gate is passed; only the (absent) hold stops it');
    const other = newJob(); assert.equal(claim('DRV_B', other).ok, true);
    ok(db.raw(`update public.driver_verification_items set expires_at = now() - interval '1 minute' where driver_id = '${ids.DRV_B}' and kind = 'insurance' and status = 'verified'`));
    const back = JSON.parse(lastRow(db.raw(`begin; set local role service_role; select public.fetch_v2_release('${ids.ADMIN}', '${other}', 'Driver verification lapsed'); commit;`)));
    assert.equal(back.status, 'pending', JSON.stringify(back));
    assert.match(scalar(`select string_agg(event, ',') from public.fetch_request_events where request_id = '${other}'`), /returned_to_board/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('9 · RETENTION, AUDIT and UPLOAD CLEAN-UP', () => {
  test('deleting a document removes the file first, then records it; the record, its review and the history stay', async () => {
    const item = scalar(`select id from public.driver_verification_items where driver_id = '${ids.DRV}' and kind = 'licence' and status = 'verified'`);
    const path = scalar(`select storage_path from public.driver_verification_files where item_id = '${item}'`);
    storage.objects.set(path, PDF);
    assert.equal((await adm('delete_file', { item_id: item })).body.code, 'reason_required');
    assert.equal((await adm('delete_file', { item_id: item, reason: 'Retention test' }, 'DRV_D')).body.code, 'forbidden');
    const r = await adm('delete_file', { item_id: item, reason: 'Driver asked for deletion (test)' });
    assert.equal(r.body.ok, true);
    assert.ok(!storage.objects.has(path));
    assert.equal(scalar(`select status || ':' || (file_deleted_at is not null) || ':' || (file_deleted_by = '${ids.ADMIN}') || ':' || (verified_by is not null)
      from public.driver_verification_items where id = '${item}'`), 'verified:true:true:true');
    assert.equal((await adm('delete_file', { item_id: item, reason: 'again' })).body.already, true);
    assert.equal((await adm('view_evidence', { item_id: item })).body.code, 'file_deleted');
    assert.equal(problem('DRV'), 'none', 'a reviewed document stays reviewed after its file is deleted');
  });
  test('the history is append-only and never holds document content', () => {
    fails(db.raw(`update public.driver_verification_events set reason = 'x' where driver_id = '${ids.DRV}'`), /append-only/);
    fails(db.raw(`delete from public.driver_verification_events where driver_id = '${ids.DRV}'`), /append-only/);
    ok(db.raw(`update public.driver_verification_events set notified_at = now() where id = (select min(id) from public.driver_verification_events where notify_kind is not null)`));
    fails(db.raw(`update public.driver_verification_events set notified_at = now() + interval '1 day' where id = (select min(id) from public.driver_verification_events where notify_kind is not null)`), /append-only/);
    assert.equal(scalar(`select count(*) from public.driver_verification_events where detail::text ~ 'drivers/|storage|%PDF|ZE12'`), '0');
  });
  test('an abandoned upload is removed from storage, then forgotten', async () => {
    const b = await drv('APPLICANT', 'begin_upload', { kind: 'vehicle', mime_type: 'application/pdf', size_bytes: PDF.length });
    storage.clientUpload(String(b.body.upload_token), PDF);
    const path = scalar(`select storage_path from public.driver_verification_uploads where id = '${b.body.upload_id}'`);
    ok(db.raw(`update public.driver_verification_uploads set expires_at = now() - interval '1 minute' where id = '${b.body.upload_id}'`));
    assert.equal((await drv('APPLICANT', 'submit', { upload_id: b.body.upload_id })).body.code, 'upload_expired');
    const s = await runVerificationSweep(vdeps());
    assert.ok(s.uploads_removed >= 1, JSON.stringify(s));
    assert.ok(!storage.objects.has(path));
    assert.equal(scalar(`select count(*) from public.driver_verification_uploads where id = '${b.body.upload_id}'`), '0');
  });
  test('the reviewer\'s record of a driver: items (all versions), history, live jobs — paths never included', async () => {
    const r = await adm('driver_record', { driver_id: ids.DRV_B });
    assert.equal(r.body.ok, true);
    assert.ok((r.body.items as unknown[]).length >= 5 && (r.body.history as unknown[]).length > 5);
    assert.ok(!JSON.stringify(r.body).includes('drivers/'));
    assert.equal((await adm('driver_record', { driver_id: ids.DRV_B }, 'OTHER')).body.code, 'forbidden');
  });
  test('the production wiring keeps the bucket private and the links short', () => {
    const src = readFileSync(join(REPO_ROOT, 'supabase/functions/_shared/fetch-v2-verification-deps.ts'), 'utf8');
    assert.match(src, /createSignedUploadUrl\(path\)/);
    assert.doesNotMatch(src, /getPublicUrl|upsert:\s*true/);
    const become = readFileSync(join(REPO_ROOT, 'supabase/functions/become-driver/index.ts'), 'utf8');
    assert.doesNotMatch(become, /from\('driver_profiles'\)|driver_status:\s*nextStatus|'approved'/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('10 · rollback', () => {
  test('refuses while Step 6 records exist', () => {
    fails(db.rawFile(DOWN), /refusing to roll back driver verification/);
    assert.deepEqual(setDiff(afterRows, catalogueRows()), { missing: [], extra: [] });
  });
  test('otherwise restores the catalogue exactly (policies, grants, triggers, indexes included) — no privilege widened; re-applies', () => {
    ok(db.raw(`alter table public.driver_verification_events disable trigger driver_verification_events_append_only;
      delete from public.driver_verification_events; alter table public.driver_verification_events enable trigger driver_verification_events_append_only;
      delete from public.driver_verification_uploads; delete from public.driver_verification_items;
      delete from public.fetch_issues where kind = 'driver_verification';
      delete from public.driver_verification_requirements where evidence_kind = 'goods_in_transit';`));
    ok(db.rawFile(DOWN));
    assert.deepEqual(setDiff(beforeRows, catalogueRows()), { missing: [], extra: [] });
    ok(db.rawFile(FIX));
    const now = catalogueRows();
    assert.deepEqual(setDiff(afterRows, now), { missing: [], extra: [] }, now.filter((r) => r.includes('size_rank')).join('\n') + '\n' + db.raw("select oid::regprocedure, proacl from pg_proc where proname = 'fetch_v2_size_rank'"));
  });
});
