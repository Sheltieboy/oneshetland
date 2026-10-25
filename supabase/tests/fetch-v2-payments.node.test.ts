/**
 * fetch-v2-payments.node.test.ts — Fetch v2 Step 5: the payment layer end to end (migration 20261202000000 +
 * supabase/functions/_shared/fetch-v2-payments.ts), against the real SQL and a deterministic in-memory Stripe.
 *
 * The REAL handlers (accept, requester payment, driver actions, admin, runner, webhook hand-off) run against a throwaway database
 * replayed from every migration. Stripe is a fake that behaves like the parts of Stripe Fetch relies on: manual capture, idempotency
 * keys (a repeated key returns the original object), 3DS (requires_action), declines, outages, lost responses, partial capture
 * releasing the rest, capture limits, cancellation, and Stripe's own capture deadline. Nothing leaves the machine.
 *
 * SAFETY — ISOLATED DATABASE ONLY (PASS_PROOF_DSN). Fake users; fake Stripe; no network.
 * Run: ISOLATED_ONLY=fetch-v2-payments npm run test:isolated
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';
import { handleAccept, handleRequesterPayment, handleDriverAction, handleAdmin, runSweeps, handleFetchV2Webhook, isFetchV2Intent,
  type PaymentDeps } from '../functions/_shared/fetch-v2-payments.ts';
import { type PaymentIntent, type StripeGateway, StripeDeclined, StripeRejected, StripeUnavailable } from '../functions/_shared/fetch-v2-stripe.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX_NAME = '20261202000000_fetch_v2_payments.sql';
const FIX = join(REPO_ROOT, 'supabase/migrations', FIX_NAME);
const DOWN = join(REPO_ROOT, 'supabase/rollbacks/20261202000000_fetch_v2_payments.down.sql');

let db: ReplayDb;
const tag = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !tag.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT|^NOTICE/.test(l));
const lastRow = (o: string) => rowsOf(o).pop() ?? '';
const scalar = (sql: string) => lastRow(db.raw(sql));
const ok = (o: string) => assert.doesNotMatch(o, /ERROR/, o);
const fails = (o: string, re: RegExp = /ERROR/) => assert.match(o, re, o);

const ids = {
  ADMIN: 'ad000000-0000-4000-8000-0000000000ad',
  REQ: 'a1000000-0000-4000-8000-000000000001',      // saved card, authorises cleanly
  REQ_SCA: 'a2000000-0000-4000-8000-000000000002',  // saved card that needs 3DS
  REQ_DECLINE: 'a3000000-0000-4000-8000-000000000003',
  REQ_NOCARD: 'a4000000-0000-4000-8000-000000000004',
  REQ_SELF: 'a5000000-0000-4000-8000-000000000005', // controls DRV_C's payout account
  DRV_A: 'da000000-0000-4000-8000-00000000000a',
  DRV_B: 'db000000-0000-4000-8000-00000000000b',
  DRV_C: 'dc000000-0000-4000-8000-00000000000c',
  DRV_NOACCT: 'dd000000-0000-4000-8000-00000000000d', // payouts flagged on, but no Connect account
  DRV_P: 'de000000-0000-4000-8000-00000000000e',      // payouts not enabled
  MEMBER: 'e1000000-0000-4000-8000-000000000004',
} as const;
type Id = keyof typeof ids;
const nameOf = (uuid: string) => (Object.keys(ids) as Id[]).find((k) => ids[k] === uuid)!;
const client = (w: Id, call: string) => lastRow(db.raw(`begin; set local request.jwt.claim.sub = '${ids[w]}'; set local role authenticated; select ${call}; commit;`));
const svcRaw = (call: string) => db.raw(`begin; set local role service_role; select ${call}; commit;`);

// ── a fake Stripe ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
type FakePI = PaymentIntent & { customer: string; destination: string; applicationFee: number; paymentMethod: string | null; key: string; feeCaptured?: number };
class FakeStripe implements StripeGateway {
  intents = new Map<string, FakePI>();
  byKey = new Map<string, string>();
  calls: { op: string; id?: string; key?: string; amount?: number; fee?: number }[] = [];
  behaviour: Record<string, 'ok' | 'sca' | 'decline'> = {};
  down = false;            // next calls throw StripeUnavailable before doing anything
  loseResponses = false;   // calls DO happen at Stripe, then the response is lost
  rejectAccounts = new Set<string>();
  failCapture = false;
  captureBeforeSecs = 7 * 86400;
  private clone = (p: FakePI): PaymentIntent => ({ ...p, metadata: { ...p.metadata } });
  private gate() { if (this.down) throw new StripeUnavailable('network'); }
  async createHold(p: Parameters<StripeGateway['createHold']>[0]) {
    this.calls.push({ op: 'create', key: p.idempotencyKey, amount: p.amount, fee: p.applicationFee });
    this.gate();
    const existing = this.byKey.get(p.idempotencyKey);
    if (existing) return this.clone(this.intents.get(existing)!);
    if (this.rejectAccounts.has(p.destination)) throw new StripeRejected('account_invalid');
    const id = `pi_fake_${++piSeq}`;
    const mode = p.paymentMethod ? (this.behaviour[p.customer] ?? 'ok') : 'nocard';
    const pi: FakePI = { id, amount: p.amount, amount_received: 0, metadata: p.metadata, customer: p.customer, destination: p.destination,
      applicationFee: p.applicationFee, paymentMethod: p.paymentMethod, key: p.idempotencyKey, client_secret: `${id}_secret_fake`,
      status: mode === 'ok' ? 'requires_capture' : mode === 'sca' ? 'requires_action' : 'requires_payment_method',
      amount_capturable: mode === 'ok' ? p.amount : 0,
      capture_before: mode === 'ok' ? Math.floor(Date.now() / 1000) + this.captureBeforeSecs : null };
    this.intents.set(id, pi); this.byKey.set(p.idempotencyKey, id);
    if (mode === 'decline') throw new StripeDeclined('card_declined', this.clone(pi));
    if (this.loseResponses) throw new StripeUnavailable('timeout_after_send');
    return this.clone(pi);
  }
  async retrieve(id: string) { this.calls.push({ op: 'retrieve', id }); this.gate(); return this.clone(this.intents.get(id)!); }
  async cancel(id: string, key: string) {
    this.calls.push({ op: 'cancel', id, key }); this.gate();
    const pi = this.intents.get(id)!;
    if (pi.status === 'succeeded') throw new StripeRejected('payment_intent_unexpected_state');
    pi.status = 'canceled'; pi.amount_capturable = 0;
    if (this.loseResponses) throw new StripeUnavailable('timeout_after_send');
    return this.clone(pi);
  }
  async capture(id: string, amount: number, fee: number, key: string) {
    this.calls.push({ op: 'capture', id, key, amount, fee }); this.gate();
    const done = this.byKey.get(key);
    if (done) return this.clone(this.intents.get(done)!);
    const pi = this.intents.get(id)!;
    if (this.failCapture) throw new StripeDeclined('card_declined', null);
    if (pi.status !== 'requires_capture') throw new StripeRejected('payment_intent_unexpected_state');
    if (amount > pi.amount_capturable) throw new StripeRejected('amount_too_large');
    pi.status = 'succeeded'; pi.amount_received = amount; pi.feeCaptured = fee; pi.amount_capturable = 0;   // the rest is released
    this.byKey.set(key, id);
    if (this.loseResponses) throw new StripeUnavailable('timeout_after_send');
    return this.clone(pi);
  }
  /** The requester finishes 3DS (or a new card) in the browser. */
  complete(id: string) { const pi = this.intents.get(id)!; pi.status = 'requires_capture'; pi.amount_capturable = pi.amount; pi.capture_before = Math.floor(Date.now() / 1000) + this.captureBeforeSecs; }
  /** Stripe cancels an uncaptured authorisation at its deadline. */
  expire(id: string) { const pi = this.intents.get(id)!; pi.status = 'canceled'; pi.amount_capturable = 0; }
  liveFor(requestId: string) { return [...this.intents.values()].filter((p) => p.metadata.fetch_v2_request_id === requestId && !['canceled', 'succeeded'].includes(p.status)); }
  allFor(requestId: string) { return [...this.intents.values()].filter((p) => p.metadata.fetch_v2_request_id === requestId); }
}
let piSeq = 0;
let stripe = new FakeStripe();

// ── wiring ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SETOF = new Set(['fetch_v2_claim_authorisation', 'fetch_v2_release_unpaid_due', 'fetch_v2_payment_work', 'fetch_v2_hold_ready', 'claim_fetch_capture']);
const lit = (v: unknown) => (v === null || v === undefined ? 'null' : typeof v === 'object' ? `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`
  : typeof v === 'boolean' || typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const ACCOUNTS: Record<string, { accountId: string | null; payoutsEnabled: boolean }> = {
  DRV_A: { accountId: 'acct_A', payoutsEnabled: true }, DRV_B: { accountId: 'acct_B', payoutsEnabled: true }, DRV_C: { accountId: 'acct_C', payoutsEnabled: true },
  DRV_NOACCT: { accountId: null, payoutsEnabled: true }, DRV_P: { accountId: 'acct_P', payoutsEnabled: false },
};
const deps = (): PaymentDeps => ({
  rpc: async (fn, args) => {
    const named = Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(', ');
    const sql = SETOF.has(fn) ? `coalesce(jsonb_agg(t), '[]'::jsonb) from public.${fn}(${named}) t` : `to_json(public.${fn}(${named}))`;
    const o = db.raw(`begin; set local role service_role; select ${sql}; commit;`);
    if (/ERROR/.test(o)) return { data: null, error: { message: o } };
    return { data: JSON.parse(lastRow(o)), error: null };
  },
  stripe,
  customerCard: async (userId) => {
    const who = nameOf(userId);
    return { customerId: `cus_${who}`, paymentMethodId: who === 'REQ_NOCARD' ? null : `pm_${who}` };
  },
  driverAccount: async (driverId) => ACCOUNTS[nameOf(driverId)] ?? { accountId: null, payoutsEnabled: false },
  isAdmin: async (userId) => userId === ids.ADMIN,
  limit: async () => true,
});
const accept = (driver: Id, id: string, extra: Record<string, unknown> = {}) => handleAccept(ids[driver], { request_id: id, vehicle_confirmed: true, ...extra }, deps());
const driverAct = (driver: Id, id: string, action: string, extra: Record<string, unknown> = {}) => handleDriverAction(ids[driver], { request_id: id, action, ...extra }, deps());
const admin = (id: string, action: string, extra: Record<string, unknown> = {}) => handleAdmin(ids.ADMIN, { request_id: id, action, ...extra }, deps());
const requesterPay = (who: Id, id: string, action: string) => handleRequesterPayment(ids[who], { request_id: id, action }, deps());
const collect = (driver: Id, id: string) => client(driver, `public.fetch_v2_mark_collected('${id}')`);
const row = (id: string, cols: string) => scalar(`select ${cols} from public.delivery_requests where id = '${id}'`);
const attempt = (id: string, cols: string) => scalar(`select ${cols} from public.fetch_authorisation_attempts where delivery_request_id = '${id}'`);
const terms = (id: string, col: string) => Number(scalar(`select ${col} from public.fetch_v2_terms where request_id = '${id}'`));
const events = (id: string) => scalar(`select string_agg(event, ',' order by id) from public.fetch_request_events where request_id = '${id}'`);

const RG: Record<string, string> = {};
const C = { BRAE: [60.396, -1.353], LERWICK: [60.155, -1.145], MIDYELL: [60.600, -1.060] } as const;
function newJob(who: Id = 'REQ', o: Record<string, unknown> = {}): string {
  const p = { idempotency_key: `k-${randomUUID()}`, category_slug: 'small-parcel', item_description: 'Box of books', size_class: 'small',
    pickup_region_id: RG['north-mainland'], pickup_name: 'Mrs Isbister', pickup_location: '7 Westerloch, Brae', pickup_lat: C.BRAE[0], pickup_lng: C.BRAE[1],
    destination_region_id: RG['lerwick'], destination_address: '12 Hillhead, Lerwick', dest_lat: C.LERWICK[0], dest_lng: C.LERWICK[1],
    contact_phone: '07700 900123', scheduling_mode: 'asap', ...o };
  const out = JSON.parse(lastRow(svcRaw(`public.fetch_v2_create_request('${ids[who]}', ${lit(p)})`)));
  assert.equal(out.ok, true, JSON.stringify(out));
  return out.request_id;
}
const piOf = (id: string) => attempt(id, 'stripe_payment_intent_id');

let beforeRows: string[] = [];
let afterRows: string[] = [];
const catalogueRows = (): string[] => {
  const o = db.raw(`select x from (
    select 'col:' || c.relname || '.' || a.attname as x from pg_attribute a join pg_class c on c.oid = a.attrelid
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
    union all select 'con:' || conrelid::regclass || ':' || conname || ':' || pg_get_constraintdef(oid) from pg_constraint where connamespace = 'public'::regnamespace
    union all select 'fn:' || p.oid::regprocedure || ':' || md5(p.prosrc) || ':' || coalesce((select string_agg(a::text, ',' order by a::text) from unnest(p.proacl) a), '') from pg_proc p where p.pronamespace = 'public'::regnamespace
    union all select 'rl:' || action from public.rate_limit_policies
    union all select 'cfg:' || key || '=' || value from public.admin_config where key like 'fetch.%' and key <> 'fetch.v2.audience'
  ) s order by x`);
  assert.doesNotMatch(o, /ERROR/, o);
  return rowsOf(o).filter((l) => !/^x$|^-+$|^\(\d+ rows?\)$/.test(l));
};
const setDiff = (want: string[], got: string[]) => ({ missing: want.filter((x) => !got.includes(x)), extra: got.filter((x) => !want.includes(x)) });

before(() => {
  db = createReplayDb('fetchv2pay', { stopBefore: FIX_NAME });
  const all = Object.values(ids).map((i) => `'${i}'::uuid`).join(',');
  const slugs = ['lerwick', 'scalloway', 'north-mainland', 'yell', 'unst', 'bressay'];
  ok(db.raw(`
    insert into auth.users (id, email) select x, 'u' || substr(x::text,1,4) || '@example.org' from unnest(array[${all}]) x on conflict do nothing;
    insert into public.profiles (id, full_name) select x, 'Fixture ' || substr(x::text,1,4) from unnest(array[${all}]) x on conflict (id) do nothing;
    update public.profiles set role = 'admin' where id = '${ids.ADMIN}';
    update public.profiles set stripe_account_id = 'acct_C' where id = '${ids.REQ_SELF}';
    insert into public.regions (slug, name, display_order) select s, initcap(replace(s, '-', ' ')), o from unnest(array[${slugs.map((s) => `'${s}'`).join(',')}]) with ordinality t(s, o);
    update public.regions set island_group = case when slug in ('yell','unst','bressay') then slug else 'mainland' end;
    insert into public.delivery_pricing_config (price_per_mile_pence, min_fee_pence, road_correction_factor) values (65, 400, 1.40);
    insert into public.admin_config (key, value, category) values ('fees.fetch.fixed_pence', '150', 'fees'), ('fees.fetch.percent_bps', '0', 'fees')
      on conflict (key) do update set value = excluded.value;
    insert into public.delivery_categories (slug, name) values ('small-parcel', 'Small parcel');
    insert into public.driver_profiles (id, driver_status, vehicle_class, max_size_class, stripe_account_id, stripe_onboarding_complete, stripe_payouts_enabled, verification_ok_until)
      select x, 'approved', 'van', 'bulky', a, true, p, now() + interval '1 year' from (values
        ('${ids.DRV_A}'::uuid, 'acct_A', true), ('${ids.DRV_B}'::uuid, 'acct_B', true), ('${ids.DRV_C}'::uuid, 'acct_C', true),
        ('${ids.DRV_NOACCT}'::uuid, null, true), ('${ids.DRV_P}'::uuid, 'acct_P', false)) v(x, a, p);`));
  for (const s of slugs) RG[s] = scalar(`select id from public.regions where slug = '${s}'`);
  beforeRows = catalogueRows();
  ok(db.rawFile(FIX));
  afterRows = catalogueRows();
  ok(db.raw(`update public.admin_config set value = 'everyone' where key = 'fetch.v2.audience'`));
  for (const w of Object.keys(ids) as Id[]) if (w !== 'MEMBER') assert.match(client(w, `public.fetch_v2_confirm_adult('fetch-18plus-v1')`), /"ok": true/);
});
after(() => { db?.drop(); });
beforeEach(() => {
  stripe = new FakeStripe();
  stripe.behaviour = { cus_REQ_SCA: 'sca', cus_REQ_DECLINE: 'decline' };
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('1 · AUTHORISE (accept + hold)', () => {
  test('a valid accept places one manual-capture hold: frozen max amount, the driver\'s account, the service fee as application fee', async () => {
    const id = newJob();
    const r = await accept('DRV_A', id);
    assert.equal(`${r.status}:${r.body.payment}:${r.body.can_collect}`, '200:authorised:true', JSON.stringify(r.body));
    const pis = stripe.allFor(id);
    assert.equal(pis.length, 1);
    const pi = pis[0];
    assert.deepEqual([pi.amount, pi.destination, pi.applicationFee, pi.key, pi.metadata.fetch_v2_generation, pi.paymentMethod],
      [terms(id, 'max_hold_pence'), 'acct_A', 150, `fetch-auth-${id}`, '1', 'pm_REQ']);
    assert.equal(row(id, 'payment_status'), 'authorised');
    assert.equal(attempt(id, `status || ':' || hold_state || ':' || amount_capturable_pence`), `authorised:valid:${terms(id, 'max_hold_pence')}`);
    assert.equal(attempt(id, `abs(extract(epoch from authorisation_expires_at) - ${pi.capture_before}) < 1`), 't', 'Stripe\'s own deadline is stored');
    assert.match(events(id), /claimed,payment_authorised/);
  });
  test('clients cannot set any money: amount, destination, intent and generation in the body are ignored', async () => {
    const id = newJob();
    await accept('DRV_A', id, { amount: 1, destination: 'acct_EVIL', application_fee: 0, payment_intent_id: 'pi_evil', generation: 9, idempotency_key: 'x' });
    const pi = stripe.allFor(id)[0];
    assert.deepEqual([pi.amount, pi.destination, pi.applicationFee, pi.key], [terms(id, 'max_hold_pence'), 'acct_A', 150, `fetch-auth-${id}`]);
  });
  test('3DS needed: the claim is kept, the job cannot be collected, the requester gets a client secret and completes it', async () => {
    const id = newJob('REQ_SCA');
    const r = await accept('DRV_A', id);
    assert.equal(`${r.body.payment}:${r.body.can_collect}`, 'requester_action_required:false');
    assert.equal(row(id, `payment_status || ':' || status`), 'requires_action:matched');
    assert.match(collect('DRV_A', id), /payment_not_ready/);
    assert.equal((await accept('DRV_B', id)).body.code, 'already_taken', 'the first driver keeps the job while the requester completes payment');
    assert.equal((await requesterPay('MEMBER', id, 'complete')).body.code, 'not_found', 'nobody else gets the secret');
    const c = await requesterPay('REQ_SCA', id, 'complete');
    assert.equal(`${c.body.payment}:${typeof c.body.client_secret}`, 'requires_action:string');
    stripe.complete(piOf(id));
    const done = await requesterPay('REQ_SCA', id, 'refresh');
    assert.equal(`${done.body.payment}:${done.body.client_secret}`, 'authorised:undefined');
    assert.match(collect('DRV_A', id), /"status": "collected"/);
  });
  test('a declined card: requester action required, never "authorised"; no saved card at all: the same', async () => {
    const d = newJob('REQ_DECLINE');
    assert.equal((await accept('DRV_A', d)).body.payment_reason, 'card_declined');
    assert.equal(row(d, 'payment_status'), 'requires_payment_method');
    const n = newJob('REQ_NOCARD');
    assert.equal((await accept('DRV_A', n)).body.payment, 'requester_action_required');
    assert.equal(stripe.allFor(n)[0].paymentMethod, null);
  });
  test('Stripe unavailable: payment pending; the retry uses the SAME key — one intent, never two', async () => {
    const id = newJob();
    stripe.down = true;
    assert.equal((await accept('DRV_A', id)).body.payment, 'pending');
    assert.equal(attempt(id, 'status'), 'unresolved');
    stripe.down = false;
    assert.equal((await accept('DRV_A', id)).body.payment, 'authorised');
    assert.equal(stripe.allFor(id).length, 1);
    assert.deepEqual(stripe.calls.filter((c) => c.op === 'create').map((c) => c.key), [`fetch-auth-${id}`, `fetch-auth-${id}`]);
  });
  test('a lost response (Stripe made the hold, we never heard): the retry gets the same intent back', async () => {
    const id = newJob();
    stripe.loseResponses = true;
    assert.equal((await accept('DRV_A', id)).body.payment, 'pending');
    stripe.loseResponses = false;
    assert.equal((await accept('DRV_A', id)).body.payment, 'authorised');
    assert.equal(stripe.allFor(id).length, 1);
  });
  test('the second driver gets an ordinary already_taken and no hold is attempted for them', async () => {
    const id = newJob();
    await accept('DRV_A', id);
    const r = await accept('DRV_B', id);
    assert.equal(`${r.status}:${r.body.code}`, '409:already_taken');
    assert.equal(stripe.allFor(id).length, 1);
  });
  test('a refused Connect account: no hold, the job goes back to the board, NOT counted against the driver', async () => {
    const id = newJob();
    stripe.rejectAccounts.add('acct_A');
    const before = scalar(`select release_count from public.driver_profiles where id = '${ids.DRV_A}'`);
    const r = await accept('DRV_A', id);
    assert.equal(`${r.status}:${r.body.code}`, '502:payment_could_not_start');
    assert.equal(row(id, `status || ':' || coalesce(driver_id::text, '-')`), 'pending:-');
    assert.equal(scalar(`select release_count from public.driver_profiles where id = '${ids.DRV_A}'`), before);
  });
  test('payouts not enabled, or no Connect account: refused before any claim', async () => {
    const id = newJob();
    assert.equal((await accept('DRV_P', id)).body.code, 'driver_payouts_not_enabled');
    assert.equal((await accept('DRV_NOACCT', id)).body.code, 'driver_payouts_not_enabled');
    assert.equal(row(id, 'status'), 'pending');
    assert.equal(stripe.calls.length, 0);
  });
  test('a requester cannot pay a payout account they control (self-payment guard)', async () => {
    const id = newJob('REQ_SELF');
    assert.equal((await accept('DRV_C', id)).body.code, 'self_payment');
    assert.equal(row(id, 'status'), 'pending');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('2 · COLLECTION GATE', () => {
  test('a live, sufficient, long-enough, recently confirmed hold allows collection', async () => {
    const id = newJob(); await accept('DRV_A', id);
    assert.match(collect('DRV_A', id), /"status": "collected"/);
  });
  test('a hold that expires too soon blocks collection (Stripe\'s deadline, not seven days)', async () => {
    stripe.captureBeforeSecs = 20 * 3600;
    const id = newJob(); await accept('DRV_A', id);
    assert.equal(attempt(id, 'hold_state'), 'expiring_soon');
    assert.match(collect('DRV_A', id), /"reason": "hold_expiring"/);
  });
  test('an expired hold blocks collection', async () => {
    const id = newJob(); await accept('DRV_A', id);
    stripe.expire(piOf(id));
    await handleFetchV2Webhook('payment_intent.canceled', { id: piOf(id), object: 'payment_intent', metadata: { fetch_v2_request_id: id } }, deps());
    assert.equal(row(id, 'payment_status'), 'expired');
    assert.match(collect('DRV_A', id), /payment_not_ready/);
  });
  test('an insufficient hold blocks collection', async () => {
    const id = newJob(); await accept('DRV_A', id);
    stripe.intents.get(piOf(id))!.amount_capturable = 100;
    assert.equal((await driverAct('DRV_A', id, 'refresh_hold')).body.reason, 'insufficient_hold');
    assert.match(collect('DRV_A', id), /"reason": "insufficient_hold"/);
  });
  test('a stale confirmation blocks collection until the driver refreshes the hold from Stripe', async () => {
    const id = newJob(); await accept('DRV_A', id);
    ok(db.raw(`update public.fetch_authorisation_attempts set hold_checked_at = now() - interval '3 hours' where delivery_request_id = '${id}'`));
    assert.match(collect('DRV_A', id), /"reason": "stale"/);
    assert.equal((await driverAct('DRV_A', id, 'refresh_hold')).body.can_collect, true);
    assert.match(collect('DRV_A', id), /"status": "collected"/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('3 · DELIVERY CAPTURE', () => {
  const delivered = async (o: Record<string, unknown> = {}, wait = 0) => {
    const id = newJob('REQ', o); await accept('DRV_A', id);
    if (wait) {
      client('REQ', `public.fetch_v2_confirm_ready('${id}')`);
      client('DRV_A', `public.fetch_v2_mark_arrived('${id}')`);
      ok(db.raw(`update public.waiting_events set arrived_at = now() - interval '${wait} minutes' where request_id = '${id}'`));
    }
    assert.match(collect('DRV_A', id), /collected/);
    return id;
  };
  test('normal delivery: capture only the expected total (partial capture; the rest of the hold is released), then delivered', async () => {
    const id = await delivered();
    const r = await driverAct('DRV_A', id, 'deliver');
    assert.equal(`${r.status}:${r.body.status}`, '200:delivered', JSON.stringify(r.body));
    const pi = stripe.intents.get(piOf(id))!;
    assert.deepEqual([pi.amount_received, pi.feeCaptured, pi.amount_capturable], [terms(id, 'total_pence'), 150, 0]);
    assert.ok(pi.amount_received < pi.amount, 'less than the hold');
    assert.equal(stripe.calls.filter((c) => c.op === 'capture')[0].key, `fetch-v2-capture-${pi.id}`);
    assert.equal(row(id, `status || ':' || payment_status`), 'delivered:captured');
    const ev = events(id);
    assert.ok(ev.indexOf('payment_captured') < ev.indexOf('delivered'), ev);
  });
  test('with waiting time: total + the measured waiting fee; no extra service fee', async () => {
    const id = await delivered({}, 12);
    await driverAct('DRV_A', id, 'deliver');
    const pi = stripe.intents.get(piOf(id))!;
    assert.deepEqual([pi.amount_received, pi.feeCaptured], [terms(id, 'total_pence') + 150, 150]);
  });
  test('a ferry job: the £2 goes in the capture and to the driver; the fee stays £1.50', async () => {
    const id = await delivered({ destination_region_id: RG.yell, dest_lat: C.MIDYELL[0], dest_lng: C.MIDYELL[1] });
    await driverAct('DRV_A', id, 'deliver');
    const pi = stripe.intents.get(piOf(id))!;
    assert.equal(pi.amount_received, terms(id, 'delivery_fee_pence') + 200 + 150);
    assert.equal(pi.amount_received - pi.feeCaptured!, terms(id, 'delivery_fee_pence') + 200, 'driver receives delivery + ferry');
  });
  test('a repeated deliver is safe: one capture, already delivered', async () => {
    const id = await delivered();
    await driverAct('DRV_A', id, 'deliver');
    const again = await driverAct('DRV_A', id, 'deliver');
    assert.equal(again.body.already, true);
    assert.equal(stripe.calls.filter((c) => c.op === 'capture').length, 1);
  });
  test('a lost capture response: the retry returns the original capture, never a second one', async () => {
    const id = await delivered();
    stripe.loseResponses = true;
    assert.equal((await driverAct('DRV_A', id, 'deliver')).body.code, 'capture_pending');
    assert.equal(row(id, 'status'), 'collected', 'not delivered until the capture is known');
    stripe.loseResponses = false;
    assert.equal((await driverAct('DRV_A', id, 'deliver')).body.status, 'delivered');
    assert.equal(stripe.intents.get(piOf(id))!.amount_received, terms(id, 'total_pence'));
  });
  test('a failed capture: the job stays collected, a payment issue opens, nothing is marked delivered', async () => {
    const id = await delivered();
    stripe.failCapture = true;
    assert.equal((await driverAct('DRV_A', id, 'deliver')).body.code, 'capture_failed');
    assert.equal(row(id, 'status'), 'collected');
    assert.equal(scalar(`select count(*) from public.fetch_issues where request_id = '${id}' and kind = 'payment' and status = 'open'`), '1');
    stripe.failCapture = false;
    assert.equal((await admin(id, 'retry_capture')).body.payment, 'captured');
    assert.equal((await driverAct('DRV_A', id, 'deliver')).body.status, 'delivered');
    assert.equal(stripe.calls.filter((c) => c.op === 'capture' && stripe.byKey.get(c.key!)).length >= 1, true);
  });
  test('delivery checks that do not involve money run BEFORE the capture', async () => {
    const id = await delivered();
    assert.equal((await driverAct('DRV_A', id, 'deliver', { left_in_safe_place: true })).body.code, 'safe_place_not_allowed');
    assert.equal(stripe.calls.filter((c) => c.op === 'capture').length, 0);
  });
  test('only the assigned driver can deliver', async () => {
    const id = await delivered();
    assert.equal((await driverAct('DRV_B', id, 'deliver')).body.code, 'not_found');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('4 · CANCEL / RELEASE / TIMEOUT', () => {
  test('driver release: void, terminal, archived; the next driver\'s hold is generation 2 with a new key and their own account', async () => {
    const id = newJob(); await accept('DRV_A', id);
    const first = piOf(id);
    const r = await driverAct('DRV_A', id, 'release', { reason: 'changed_plans' });
    assert.equal(`${r.body.status}:${r.body.hold}`, 'pending:retired');
    assert.equal(stripe.intents.get(first)!.status, 'canceled');
    assert.equal(stripe.calls.find((c) => c.op === 'cancel')!.key, `fetch-v2-void-${first}`);
    assert.equal(scalar(`select generation || ':' || status from public.fetch_authorisation_generations where delivery_request_id = '${id}'`), '1:terminal');
    await accept('DRV_B', id);
    const second = stripe.intents.get(piOf(id))!;
    assert.deepEqual([second.key, second.destination, second.metadata.fetch_v2_generation], [`fetch-auth-${id}-g2`, 'acct_B', '2']);
    assert.equal(stripe.liveFor(id).length, 1, 'never two live holds');
  });
  test('requester asks to cancel, driver agrees: void and retire; nothing captured', async () => {
    const id = newJob(); await accept('DRV_A', id);
    client('REQ', `public.fetch_v2_request_cancellation('${id}', 'No longer needed')`);
    const r = await driverAct('DRV_A', id, 'agree_cancellation');
    assert.equal(`${r.body.status}:${r.body.hold}`, 'cancelled:retired');
    assert.equal(stripe.calls.filter((c) => c.op === 'capture').length, 0);
    assert.equal(stripe.liveFor(id).length, 0);
  });
  test('a void Stripe cannot confirm leaves the job on the board and the runner finishes it', async () => {
    const id = newJob(); await accept('DRV_A', id);
    stripe.down = true;
    const r = await driverAct('DRV_A', id, 'release', { reason: 'changed_plans' });
    assert.equal(`${r.body.status}:${r.body.hold}`, 'pending:pending');
    stripe.down = false;
    const s = await runSweeps(deps());
    assert.ok(s.voided >= 1 && s.retired >= 1, JSON.stringify(s));
    assert.equal(stripe.liveFor(id).length, 0);
    assert.equal(scalar(`select count(*) from public.fetch_authorisation_attempts where delivery_request_id = '${id}'`), '0');
  });
  test('payment timeout: a hold the requester never completed is voided after 2 hours and the job returns to the board; repeat-safe', async () => {
    const id = newJob('REQ_SCA'); await accept('DRV_A', id);
    ok(db.raw(`update public.delivery_requests set claimed_at = now() - interval '3 hours' where id = '${id}';
      update public.fetch_authorisation_attempts set created_at = now() - interval '3 hours' where delivery_request_id = '${id}';`));
    const s = await runSweeps(deps());
    assert.ok(s.unpaid_released >= 1, JSON.stringify(s));
    assert.equal(row(id, `status || ':' || coalesce(driver_id::text, '-')`), 'pending:-');
    assert.equal(stripe.liveFor(id).length, 0);
    const again = await runSweeps(deps());
    assert.equal(again.unpaid_released, 0);
    assert.equal((await accept('DRV_B', id)).body.payment, 'requester_action_required', 'a new driver gets a new generation');
    assert.equal(stripe.intents.get(piOf(id))!.key, `fetch-auth-${id}-g2`);
  });
  test('admin cancel and return-to-board void the hold, audited', async () => {
    const a = newJob(); await accept('DRV_A', a);
    assert.equal((await admin(a, 'cancel', { reason: 'Prohibited item reported' })).body.hold, 'retired');
    const b = newJob(); await accept('DRV_A', b);
    assert.equal((await admin(b, 'return_to_board', { reason: 'Driver unreachable' })).body.status, 'pending');
    assert.equal(stripe.liveFor(a).length + stripe.liveFor(b).length, 0);
    assert.match(events(a), /admin_cancelled/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('5 · HOLD EXPIRY and REPLACEMENT', () => {
  test('before collection: a dying hold is rotated — old voided and archived, generation 2 placed, never two live', async () => {
    stripe.captureBeforeSecs = 30 * 3600;           // inside the 48h margin
    const id = newJob(); await accept('DRV_A', id);
    const old = piOf(id);
    stripe.captureBeforeSecs = 7 * 86400;
    const s = await runSweeps(deps());
    assert.ok(s.rotated >= 1, JSON.stringify(s));
    assert.equal(stripe.intents.get(old)!.status, 'canceled');
    const now = stripe.intents.get(piOf(id))!;
    assert.deepEqual([now.key, now.metadata.fetch_v2_generation, now.destination], [`fetch-auth-${id}-g2`, '2', 'acct_A']);
    assert.equal(stripe.liveFor(id).length, 1);
    assert.equal(row(id, `status || ':' || payment_status`), 'matched:authorised');
    assert.match(events(id), /authorisation_rotated/);
  });
  test('an already-expired hold before collection is replaced the same way', async () => {
    const id = newJob(); await accept('DRV_A', id);
    stripe.expire(piOf(id));
    await handleFetchV2Webhook('payment_intent.canceled', { id: piOf(id), object: 'payment_intent', metadata: { fetch_v2_request_id: id } }, deps());
    await runSweeps(deps());
    assert.equal(row(id, 'payment_status'), 'authorised');
    assert.equal(stripe.liveFor(id).length, 1);
  });
  test('a replacement that needs the requester: shown as action required, collection blocked', async () => {
    stripe.captureBeforeSecs = 30 * 3600;
    const id = newJob(); await accept('DRV_A', id);
    stripe.behaviour.cus_REQ = 'sca';
    await runSweeps(deps());
    assert.equal(row(id, 'payment_status'), 'requires_action');
    assert.match(collect('DRV_A', id), /payment_not_ready/);
  });
  test('after collection a dying hold is escalated once to a person — never replaced, never doubled', async () => {
    const id = newJob(); await accept('DRV_A', id);
    collect('DRV_A', id);
    ok(db.raw(`update public.fetch_authorisation_attempts set authorisation_expires_at = now() + interval '10 hours' where delivery_request_id = '${id}'`));
    const s = await runSweeps(deps());
    assert.ok(s.escalated >= 1);
    await runSweeps(deps());
    assert.equal(scalar(`select count(*) from public.fetch_issues where request_id = '${id}' and kind = 'payment'`), '1');
    assert.equal(stripe.allFor(id).length, 1);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('6 · RETURNS', () => {
  const undeliverable = async () => {
    const id = newJob(); await accept('DRV_A', id);
    collect('DRV_A', id);
    client('DRV_A', `public.fetch_v2_mark_undeliverable('${id}', 'recipient_absent')`);
    return id;
  };
  test('not the driver\'s fault: capture total + return mileage at 65p; still one £1.50 fee', async () => {
    const id = await undeliverable();
    const r = await admin(id, 'resolve_return', { outcome: 'returned_to_sender', fault: 'not_driver' });
    assert.equal(r.body.payment, 'captured', JSON.stringify(r.body));
    const pi = stripe.intents.get(piOf(id))!;
    assert.deepEqual([pi.amount_received, pi.feeCaptured], [terms(id, 'total_pence') + Number(row(id, 'return_fee_pence')), 150]);
  });
  test('the driver\'s fault: nothing captured, the hold is voided', async () => {
    const id = await undeliverable();
    const r = await admin(id, 'resolve_return', { outcome: 'returned_to_sender', fault: 'driver' });
    assert.equal(`${r.body.capture_pence}:${r.body.hold}`, '0:voided');
    assert.equal(stripe.intents.get(piOf(id) || stripe.allFor(id)[0].id)!.status, 'canceled');
  });
  test('an admin override needs a reason, stays inside the hold, and a smaller capture carries a smaller fee', async () => {
    const id = await undeliverable();
    assert.equal((await admin(id, 'resolve_return', { outcome: 'returned_to_sender', fault: 'undetermined', override_capture_pence: 100 })).body.code, 'override_reason_required');
    assert.equal((await admin(id, 'resolve_return', { outcome: 'returned_to_sender', fault: 'undetermined', override_capture_pence: '100', reason: 'x' })).body.code, 'invalid_request');
    const r = await admin(id, 'resolve_return', { outcome: 'returned_to_sender', fault: 'undetermined', override_capture_pence: 100, reason: 'Accounts conflict; token amount' });
    assert.equal(r.body.capture_pence, 100);
    const pi = stripe.intents.get(piOf(id))!;
    assert.deepEqual([pi.amount_received, pi.feeCaptured], [100, 100]);
  });
  test('owed more than Stripe can capture: no capture attempted, a payment issue escalated', async () => {
    const id = await undeliverable();
    stripe.intents.get(piOf(id))!.amount_capturable = 50;
    const r = await admin(id, 'resolve_return', { outcome: 'returned_to_sender', fault: 'not_driver' });
    assert.equal(r.body.code, 'capture_exceeds_hold');
    assert.equal(stripe.calls.filter((c) => c.op === 'capture').length, 0);
    assert.equal(scalar(`select count(*) from public.fetch_issues where request_id = '${id}' and kind = 'payment' and status = 'open'`), '1');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('7 · WEBHOOK reconciliation', () => {
  const ev = (type: string, id: string, pi: string, extra: Record<string, unknown> = {}) =>
    handleFetchV2Webhook(type, { id: pi, object: 'payment_intent', metadata: { fetch_v2_request_id: id }, ...extra }, deps());
  test('a requester finishing 3DS in a closed tab still ends up authorised (amount_capturable_updated)', async () => {
    const id = newJob('REQ_SCA'); await accept('DRV_A', id);
    stripe.complete(piOf(id));
    const r = await ev('payment_intent.amount_capturable_updated', id, piOf(id));
    assert.equal(`${r.changed}:${r.payment_status}`, 'true:authorised');
  });
  test('replay is silent: the same event again changes nothing and logs nothing', async () => {
    const id = newJob(); await accept('DRV_A', id);
    const before = events(id);
    const r = await ev('payment_intent.amount_capturable_updated', id, piOf(id));
    assert.equal(r.changed, false);
    assert.equal(events(id), before);
  });
  test('capture and failure events are reconciled from Stripe\'s current state', async () => {
    const id = newJob('REQ_DECLINE'); await accept('DRV_A', id);
    assert.equal((await ev('payment_intent.payment_failed', id, stripe.allFor(id)[0].id)).payment_status, 'requires_payment_method');
    const ok2 = newJob(); await accept('DRV_A', ok2); collect('DRV_A', ok2);
    await stripe.capture(piOf(ok2), terms(ok2, 'total_pence'), 150, 'external-test');
    assert.equal((await ev('payment_intent.succeeded', ok2, piOf(ok2))).payment_status, 'captured');
  });
  test('out of order: a stale "capturable" snapshot after cancellation cannot revive the hold', async () => {
    const id = newJob(); await accept('DRV_A', id);
    const pi = piOf(id);
    stripe.expire(pi);
    await ev('payment_intent.canceled', id, pi);
    stripe.down = true;   // force the handler to fall back to the (stale) event snapshot
    const r = await ev('payment_intent.amount_capturable_updated', id, pi, { status: 'requires_capture', amount_capturable: 999 });
    stripe.down = false;
    assert.equal(r.ignored, 'already_terminal');
    assert.equal(row(id, 'payment_status'), 'expired');
  });
  test('scoped: a retired generation\'s intent, an unknown job and a v1 intent change nothing', async () => {
    const id = newJob(); await accept('DRV_A', id);
    const old = piOf(id);
    await driverAct('DRV_A', id, 'release', { reason: 'changed_plans' });
    await accept('DRV_B', id);
    assert.equal((await ev('payment_intent.canceled', id, old)).ignored, 'retired_generation');
    assert.equal(row(id, 'payment_status'), 'authorised');
    assert.equal((await handleFetchV2Webhook('payment_intent.succeeded', { id: old, object: 'payment_intent', metadata: { fetch_v2_request_id: randomUUID() } }, deps())).ignored, 'not_fetch_v2');
    assert.equal(isFetchV2Intent('payment_intent.succeeded', { object: 'payment_intent', metadata: { request_id: id } }), false);
  });
  test('the production webhook hands Fetch v2 intents over before any v1 branch, and v2 intents never carry the v1 key', () => {
    const src = readFileSync(join(REPO_ROOT, 'supabase/functions/stripe-webhook/index.ts'), 'utf8');
    const handOff = src.indexOf('if (isFetchV2Intent(eventType, eventData))');
    assert.ok(handOff > 0 && handOff < src.indexOf("case 'payment_intent.amount_capturable_updated'"));
    assert.match(src.slice(handOff, handOff + 400), /\} else\s+switch \(eventType\)/);
    const pay = readFileSync(join(REPO_ROOT, 'supabase/functions/_shared/fetch-v2-payments.ts'), 'utf8');
    assert.doesNotMatch(pay, /metadata:\s*\{[^}]*\brequest_id:/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('8 · PRIVACY and SECURITY of responses', () => {
  test('no response carries a Connect account, a Stripe customer, a key or provider text; only the requester ever sees a client secret', async () => {
    const outs: unknown[] = [];
    const id = newJob('REQ_SCA');
    outs.push((await accept('DRV_A', id)).body);
    outs.push((await driverAct('DRV_A', id, 'refresh_hold')).body);
    stripe.rejectAccounts.add('acct_B');
    outs.push((await accept('DRV_B', newJob())).body);
    const text = JSON.stringify(outs);
    for (const s of ['acct_', 'cus_', 'sk_', 'pm_', 'secret', 'account_invalid', 'pi_fake']) assert.ok(!text.includes(s), `leaked ${s}: ${text}`);
  });
  test('administrator actions are refused to anyone else; a void needs a reason and never touches an item in transit', async () => {
    const id = newJob(); await accept('DRV_A', id);
    assert.equal((await handleAdmin(ids.DRV_A, { request_id: id, action: 'cancel', reason: 'x' }, deps())).body.code, 'forbidden');
    assert.equal((await admin(id, 'void_hold')).body.code, 'reason_required');
    collect('DRV_A', id);
    assert.equal((await admin(id, 'void_hold', { reason: 'Stuck' })).body.code, 'item_in_transit');
  });
  test('the payment state functions are service-only', () => {
    for (const fn of ['fetch_v2_apply_payment_state(uuid, text, integer, text, integer, integer, timestamptz, text)', 'fetch_v2_payment_context(uuid)',
      'fetch_v2_payment_work()', 'fetch_v2_capture_amount(uuid)', 'fetch_v2_rotate_authorisation(uuid, text)'])
      assert.equal(scalar(`select has_function_privilege('authenticated', 'public.${fn}', 'execute')`), 'f', fn);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('9 · rollback', () => {
  test('refuses while Stripe state is recorded', () => {
    fails(db.rawFile(DOWN), /refusing to roll back the payment layer/);
    assert.deepEqual(setDiff(afterRows, catalogueRows()), { missing: [], extra: [] });
  });
  test('otherwise restores the catalogue exactly; the migration re-applies', () => {
    ok(db.raw(`delete from public.delivery_requests where fetch_version = 2`));
    ok(db.rawFile(DOWN));
    assert.deepEqual(setDiff(beforeRows, catalogueRows()), { missing: [], extra: [] });
    ok(db.rawFile(FIX));
    assert.deepEqual(setDiff(afterRows, catalogueRows()), { missing: [], extra: [] });
  });
});
