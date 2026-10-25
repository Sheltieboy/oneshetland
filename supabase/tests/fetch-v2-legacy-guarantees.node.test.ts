/**
 * fetch-v2-legacy-guarantees.node.test.ts — Fetch v2 Step 13: the guarantees the seven retired v1 production suites carried, proved
 * against Fetch v2 in a throwaway database instead of production.
 *
 * Retired (git history keeps them): fetch-price-authority, fetch-price-lock, fetch-authorisation-truth, fetch-authorisation-idempotency,
 * fetch-hold-expiry, fetch-capture-recovery, fetch-first-card. They probed the v1 rail (authorise-payment, capture-payment, client
 * pricing, direct delivery_requests writes) on the live database with throwaway rows. Most of what still matters is already proved
 * by the Step 3–5 isolated suites (see the disposition table in docs/FETCH_V2_IMPLEMENTATION.md, Step 13). This suite proves the rest:
 * real many-connection races (the v1 suites' "twenty at once"), the full Stripe-status truth table, money columns closed to members,
 * deterministic Stripe keys, never-backwards payment state, and the first-card dead end.
 *
 * Each test name starts with the legacy suite whose guarantee it carries.
 *
 * SAFETY — ISOLATED DATABASE ONLY (PASS_PROOF_DSN). Fake users, fake Stripe, no network.
 * Run: ISOLATED_ONLY=fetch-v2-legacy-guarantees npm run test:isolated
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { handleAccept, handleDriverAction } from '../functions/_shared/fetch-v2-payments.ts';
import { createFetchWorld, ids, lastRow, ok, rowsOf, type Id, type World } from './_support/fetch-v2-world.ts';

let w: World;
before(() => { w = createFetchWorld('fetchv2legacy'); });
after(() => { w?.drop(); });

type J = Record<string, unknown>;
const row = (id: string, cols: string) => w.scalar(`select ${cols} from public.delivery_requests where id = '${id}'`);
const attempt = (id: string, cols: string) => w.scalar(`select ${cols} from public.fetch_authorisation_attempts where delivery_request_id = '${id}'`);
const accept = (d: Id, id: string) => handleAccept(ids[d], { request_id: id, vehicle_confirmed: true }, w.payDeps());
const claimOnly = (d: Id, id: string) => JSON.parse(w.svc(`public.fetch_v2_claim('${ids[d]}', '${id}', true)`)) as J;
const denied = (o: string) => /ERROR|UPDATE 0|INSERT 0 0|DELETE 0/.test(o);
const bgSql = (sql: string) => w.db.bg(`begin; set local role service_role; ${sql}; commit;`);

describe('the races, with real concurrent database connections', () => {
  test('fetch-authorisation-idempotency · twenty simultaneous hold claims for one job: exactly one may create a PaymentIntent', async () => {
    const id = w.job('REQ', 'lerwick', 'scalloway');
    assert.equal(claimOnly('D_CAR', id).ok, true);
    const outs = await Promise.all(Array.from({ length: 20 }, () =>
      bgSql(`select outcome from public.fetch_v2_claim_authorisation('${ids.D_CAR}', '${id}')`)));
    const outcomes = outs.map((o) => rowsOf(o.stdout).pop());
    assert.equal(outcomes.filter((o) => o === 'claimed').length, 1, outcomes.join(','));
    assert.ok(outcomes.every((o) => ['claimed', 'in_flight', 'resume'].includes(String(o))), outcomes.join(','));
    assert.equal(w.scalar(`select count(*) from public.fetch_authorisation_attempts where delivery_request_id = '${id}'`), '1');
  });
  test('fetch-authorisation-idempotency · twenty drivers claiming one job at once: one assignment, the rest an ordinary already_taken', async () => {
    const id = w.job('REQ', 'lerwick', 'scalloway');
    const drivers: Id[] = ['D_CAR', 'D_B', 'D_VAN', 'D_EXP'];
    const outs = await Promise.all(Array.from({ length: 20 }, (_, i) => bgSql(`select public.fetch_v2_claim('${ids[drivers[i % 4]]}', '${id}', true)`)));
    const res = outs.map((o) => JSON.parse(rowsOf(o.stdout).pop() ?? '{}') as J);
    const fresh = res.filter((r) => r.ok === true && r.already !== true);
    assert.equal(fresh.length, 1, `exactly one fresh assignment: ${JSON.stringify(res.map((r) => r.ok === true ? (r.already ? 'already' : 'won') : r.code))}`);
    assert.ok(res.every((r) => r.ok === true || r.code === 'already_taken'), JSON.stringify(res.filter((r) => r.ok !== true && r.code !== 'already_taken')));
    assert.equal(w.scalar(`select count(distinct driver_id) from public.delivery_requests where id = '${id}'`), '1');
    assert.equal(w.scalar(`select count(*) from public.fetch_request_events where request_id = '${id}' and event = 'claimed'`), '1');
  });
  test('fetch-capture-recovery · twenty simultaneous capture claims: exactly one caller may reach Stripe', async () => {
    const id = w.job('REQ', 'lerwick', 'scalloway');
    assert.equal((await accept('D_CAR', id)).body.payment, 'authorised');
    const amount = Number(w.scalar(`select total_pence from public.fetch_v2_terms where request_id = '${id}'`));
    const outs = await Promise.all(Array.from({ length: 20 }, () =>
      bgSql(`select outcome from public.claim_fetch_capture('${id}', '${ids.D_CAR}', ${amount})`)));
    const outcomes = outs.map((o) => rowsOf(o.stdout).pop());
    assert.equal(outcomes.filter((o) => o === 'claimed').length, 1, outcomes.join(','));
    assert.ok(outcomes.every((o) => o === 'claimed' || o === 'in_flight'), outcomes.join(','));
    assert.equal(lastRow(w.db.raw(`select outcome from public.claim_fetch_capture('${id}', '${ids.D_B}', ${amount})`)), 'wrong_driver');
  });
});

describe('what counts as money held', () => {
  test('fetch-authorisation-truth · only requires_capture is a hold — every other Stripe status is not "authorised"', () => {
    const want: Record<string, string> = { requires_capture: 'authorised', requires_action: 'requires_action', requires_payment_method: 'requires_payment_method',
      processing: 'processing', canceled: 'expired', failed: 'failed' };
    for (const [state, pay] of Object.entries(want)) {
      const id = w.job('REQ', 'lerwick', 'scalloway');
      claimOnly('D_CAR', id);
      w.svc(`public.fetch_v2_claim_authorisation('${ids.D_CAR}', '${id}')`);
      const r = JSON.parse(w.svc(`public.fetch_v2_apply_payment_state('${id}', 'pi_truth_${state}_${id.slice(0, 6)}', 1, '${state}', 1000, 0, now() + interval '7 days', 'test')`));
      assert.equal(`${state}→${r.payment_status}`, `${state}→${pay}`);
      assert.equal(row(id, 'payment_status') === 'authorised', state === 'requires_capture', state);
    }
    const id = w.job('REQ', 'lerwick', 'scalloway');
    claimOnly('D_CAR', id); w.svc(`public.fetch_v2_claim_authorisation('${ids.D_CAR}', '${id}')`);
    assert.equal(JSON.parse(w.svc(`public.fetch_v2_apply_payment_state('${id}', 'pi_x', 1, 'mystery_status', 1, 0, null, 'test')`)).code, 'invalid_request', 'an unknown status fails closed');
  });
  test('fetch-authorisation-truth · without a confirmed hold the driver is not released: collection refused for every non-hold state', () => {
    for (const state of ['requires_action', 'requires_payment_method', 'processing']) {
      const id = w.job('REQ', 'lerwick', 'scalloway');
      claimOnly('D_CAR', id); w.svc(`public.fetch_v2_claim_authorisation('${ids.D_CAR}', '${id}')`);
      w.svc(`public.fetch_v2_apply_payment_state('${id}', 'pi_gate_${state}_${id.slice(0, 6)}', 1, '${state}', 0, 0, null, 'test')`);
      assert.equal(w.call<J>('D_CAR', `public.fetch_v2_mark_collected('${id}')`).code, 'payment_not_ready', state);
    }
  });
  test('fetch-hold-expiry · a captured payment is never walked backwards by a later cancellation or expiry', () => {
    const id = w.job('REQ', 'lerwick', 'scalloway');
    claimOnly('D_CAR', id); w.svc(`public.fetch_v2_claim_authorisation('${ids.D_CAR}', '${id}')`);
    const pi = `pi_back_${id.slice(0, 6)}`;
    w.svc(`public.fetch_v2_apply_payment_state('${id}', '${pi}', 1, 'requires_capture', 2000, 0, now() + interval '7 days', 'test')`);
    w.svc(`public.fetch_v2_apply_payment_state('${id}', '${pi}', 1, 'succeeded', 0, 1500, null, 'test')`);
    const late = JSON.parse(w.svc(`public.fetch_v2_apply_payment_state('${id}', '${pi}', 1, 'canceled', 0, 0, null, 'webhook')`));
    assert.equal(late.ignored, 'already_captured');
    assert.equal(row(id, 'payment_status'), 'captured');
  });
  test('fetch-hold-expiry · Stripe\'s deadline, not ours: a hold inside the expiry margin cannot be collected', () => {
    const id = w.job('REQ', 'lerwick', 'scalloway');
    claimOnly('D_CAR', id); w.svc(`public.fetch_v2_claim_authorisation('${ids.D_CAR}', '${id}')`);
    const amount = Number(w.scalar(`select max_hold_pence from public.fetch_v2_terms where request_id = '${id}'`));
    w.svc(`public.fetch_v2_apply_payment_state('${id}', 'pi_soon_${id.slice(0, 6)}', 1, 'requires_capture', ${amount}, 0, now() + interval '2 hours', 'test')`);
    assert.equal(attempt(id, 'hold_state'), 'expiring_soon');
    const r = w.call<J>('D_CAR', `public.fetch_v2_mark_collected('${id}')`);
    assert.equal(r.status === 'collected', false, JSON.stringify(r));
  });
});

describe('who decides the price', () => {
  test('fetch-price-authority · a member cannot write price, money, terms, waiting, payment or status on a Fetch v2 job', () => {
    const id = w.job('REQ', 'lerwick', 'scalloway');
    const total = row(id, 'total_fee_pence');
    for (const set of ['base_fee_pence = 1', 'total_fee_pence = 1', 'service_fee_pence = 0', 'waiting_fee_pence = 600', 'ferry_supplement_pence = 0',
      `payment_status = 'authorised'`, `status = 'delivered'`, `driver_id = '${ids.D_CAR}'`]) {
      assert.ok(denied(w.asClient('REQ', `update public.delivery_requests set ${set} where id = '${id}'`)), `requester: ${set}`);
    }
    assert.ok(denied(w.asClient('REQ', `update public.fetch_v2_terms set total_pence = 1 where request_id = '${id}'`)));
    assert.ok(denied(w.asClient('REQ', `insert into public.delivery_requests (customer_id, fetch_version, status, base_fee_pence) values ('${ids.REQ}', 2, 'pending', 1)`)));
    assert.ok(denied(w.asClient('REQ', `update public.fetch_authorisation_attempts set amount_pence = 1 where delivery_request_id = '${id}'`)));
    assert.equal(row(id, 'total_fee_pence'), total, 'the server price survives every attempt');
  });
  test('fetch-price-lock · a price rise mid-delivery cannot enlarge the held charge: capture uses the frozen terms', async () => {
    const id = w.job('REQ', 'lerwick', 'scalloway');
    const frozen = Number(w.scalar(`select total_pence from public.fetch_v2_terms where request_id = '${id}'`));
    await accept('D_CAR', id);
    ok(w.db.raw(`update public.delivery_pricing_config set price_per_mile_pence = 500; update public.admin_config set value = '900' where key = 'fees.fetch.fixed_pence'`));
    try {
      assert.equal(w.call<J>('D_CAR', `public.fetch_v2_mark_collected('${id}')`).status, 'collected');
      const d = await handleDriverAction(ids.D_CAR, { request_id: id, action: 'deliver', left_in_safe_place: false }, w.payDeps());
      assert.equal(d.body.status, 'delivered', JSON.stringify(d.body));
      const pi = w.stripe.allFor(id)[0];
      assert.deepEqual([pi.amount_received, (pi as unknown as { feeCaptured: number }).feeCaptured], [frozen, 150]);
    } finally {
      ok(w.db.raw(`update public.delivery_pricing_config set price_per_mile_pence = 65; update public.admin_config set value = '150' where key = 'fees.fetch.fixed_pence'`));
    }
  });
});

describe('keys that survive a lost response', () => {
  test('fetch-authorisation-idempotency / fetch-capture-recovery · the Stripe keys are derived from the job and the intent only', async () => {
    const id = w.job('REQ', 'lerwick', 'scalloway');
    await accept('D_CAR', id);
    await accept('D_CAR', id);
    w.call('D_CAR', `public.fetch_v2_mark_collected('${id}')`);
    await handleDriverAction(ids.D_CAR, { request_id: id, action: 'deliver', left_in_safe_place: false }, w.payDeps());
    await handleDriverAction(ids.D_CAR, { request_id: id, action: 'deliver', left_in_safe_place: false }, w.payDeps());
    const pi = w.stripe.allFor(id);
    assert.equal(pi.length, 1, 'one intent across retries');
    const creates = w.stripe.calls.filter((c) => c.op === 'create' && c.key?.includes(id));
    assert.ok(creates.every((c) => c.key === `fetch-auth-${id}`), JSON.stringify(creates));
    const caps = w.stripe.calls.filter((c) => c.op === 'capture' && c.id === pi[0].id);
    assert.ok(caps.length >= 1 && caps.every((c) => c.key === `fetch-v2-capture-${pi[0].id}`), JSON.stringify(caps));
    assert.equal(pi[0].amount_received > 0 && caps.length, 1, 'a repeated deliver does not reach Stripe again');
  });
});

describe('a first-time customer is not a dead end', () => {
  test('fetch-first-card · a requester with no Stripe Customer: the accept is refused in words and the job goes straight back to the board', async () => {
    const id = w.job('REQ_NOCUS', 'lerwick', 'scalloway');
    const r = await accept('D_CAR', id);
    assert.equal(r.body.code, 'requester_has_no_payment_profile', JSON.stringify(r.body));
    assert.equal(row(id, `status || ':' || coalesce(driver_id::text, '-')`), 'pending:-', 'never stranded as a matched job with no way to pay');
    assert.equal(w.stripe.allFor(id).length, 0, 'no orphan PaymentIntent');
  });
});
