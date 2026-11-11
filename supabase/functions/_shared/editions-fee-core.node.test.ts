/**
 * editions-fee-core.node.test.ts — pure tests for the Editions FEE MODEL in editions-commerce-core.ts. No database, no network, no secrets.
 * Run ONLY through the safe runner: /Users/darrenfullerton/Claude/safe-test/run-safe.sh <worktree> supabase/functions/_shared/editions-fee-core.node.test.ts
 * (The older editions-commerce-core.node.test.ts is refused by that runner: a string literal in one of its source checks matches the guard's pattern. It is left as it is.)
 * The database arithmetic is proved identical to these functions in the isolated suite editions-fees.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from './editions-commerce-core.ts';

const CFG: C.FeeConfig = { commission_percent: 2, commission_fixed_pence: 0, commission_min_pence: 0, commission_cap_pence: null, stripe_cost_percent: 1.5, stripe_cost_fixed_pence: 20 };
const U1 = '6f1c2b3a-1111-4222-8333-444455556666', U2 = '7f1c2b3a-1111-4222-8333-444455556667';
const ev = (type: string, object: Record<string, unknown>) => ({ id: 'evt_1', type, data: { object } });

describe('fee parts (commission 2%, estimated processing fee 1.5% + 20p; integer pence, round half up)', () => {
  test('the standard prices', () => {
    assert.deepEqual(C.feeParts(1000, CFG), { commission: 20, recovery: 35, fee: 55, recovery_reduced: false });
    assert.deepEqual(C.feeParts(2500, CFG), { commission: 50, recovery: 58, fee: 108, recovery_reduced: false }, '37.5 rounds half UP to 38');
    assert.deepEqual(C.feeParts(10000, CFG), { commission: 200, recovery: 170, fee: 370, recovery_reduced: false });
    assert.deepEqual(C.feeParts(2000, CFG), { commission: 40, recovery: 50, fee: 90, recovery_reduced: false });
  });
  test('odd pence round half up; F is always commission + recovery and never above the charge', () => {
    assert.equal(C.feeParts(1050, CFG).commission, 21); assert.equal(C.feeParts(1025, CFG).commission, 21, '20.5 rounds up'); assert.equal(C.feeParts(1024, CFG).commission, 20);
    assert.equal(C.feeParts(1050, CFG).recovery, 36, '15.75 + 20 = 35.75 -> 16 + 20'); assert.equal(C.pctOf(100, 1.5), 2, '1.5 rounds half up to 2'); assert.equal(C.pctOf(1, 49.99), 0);
    for (let c = 1; c <= 30000; c++) { const f = C.feeParts(c, CFG); assert.equal(f.fee, f.commission + f.recovery); assert.ok(f.fee <= c && f.commission >= 0 && f.recovery >= 0, String(c)); }
  });
  test('F would exceed the charge: the RECOVERY is reduced first and that is recorded', () => {
    const f = C.feeParts(15, CFG); assert.deepEqual(f, { commission: 0, recovery: 15, fee: 15, recovery_reduced: true });
    const g = C.feeParts(25, { ...CFG, commission_fixed_pence: 5 }); assert.equal(g.commission, 6); assert.equal(g.recovery, 19); assert.equal(g.fee, 25); assert.equal(g.recovery_reduced, true);
    assert.deepEqual(C.feeParts(0, CFG), { commission: 0, recovery: 0, fee: 0, recovery_reduced: false });
  });
  test('minimum, cap, fixed; commission never above the charge', () => {
    assert.equal(C.feeParts(1000, { ...CFG, commission_min_pence: 100 }).commission, 100);
    assert.equal(C.feeParts(100000, { ...CFG, commission_cap_pence: 500 }).commission, 500);
    assert.equal(C.feeParts(1000, { ...CFG, commission_fixed_pence: 10 }).commission, 30);
    assert.equal(C.feeParts(50, { ...CFG, commission_min_pence: 100 }).commission, 50);
  });
  test('overrides: a waiver zeroes the COMMISSION only; recovery is waived only by the explicit flag', () => {
    assert.deepEqual(C.feeParts(1000, CFG, { waived: true }), { commission: 0, recovery: 35, fee: 35, recovery_reduced: false });
    assert.deepEqual(C.feeParts(1000, CFG, { waived: true, recovery_waived: true }), { commission: 0, recovery: 0, fee: 0, recovery_reduced: false });
    assert.deepEqual(C.feeParts(1000, CFG, { recovery_waived: true }), { commission: 20, recovery: 0, fee: 20, recovery_reduced: false });
    assert.equal(C.feeParts(10000, CFG, { fee_percent: 1, fee_fixed_pence: 0 }).commission, 100);
  });
  test('a VAT-registered organiser: the fee is computed on the VAT-inclusive charge and the customer still pays exactly that charge', () => {
    // an exclusive-VAT price of 10000 is charged as 12000: the fee is on 12000; nothing is added on top of 12000
    const f = C.feeParts(12000, CFG); assert.equal(f.commission, 240); assert.equal(f.recovery, 200); assert.ok(12000 - f.fee === 11560);
  });
});

describe('subscription percentage conversion (application_fee_percent is percentage-only, two decimals)', () => {
  const STANDARD = [500, 700, 1000, 1500, 2000, 2500, 3000, 5000, 7500, 9000, 10000, 12000, 15000, 20000];
  test('nearest 0.01 reproduces F exactly at the standard prices under the nearest assumption', () => {
    for (const c of STANDARD) { const f = C.feeParts(c, CFG).fee; assert.equal(C.percentErrorPence(f, c, 'nearest'), 0, String(c)); }
    assert.equal(C.feePercent(55, 1000), 5.5); assert.equal(C.feePercent(108, 2500), 4.32); assert.equal(C.feePercent(370, 10000), 3.7); assert.equal(C.feePercent(0, 1000), 0);
  });
  test('the effective percentage rises on small prices: the fixed 20p estimate is a bigger share (intended; shown to the organiser)', () => {
    assert.ok(C.feePercent(C.feeParts(500, CFG).fee, 500) > C.feePercent(C.feeParts(10000, CFG).fee, 10000)); assert.equal(C.feePercent(C.feeParts(500, CFG).fee, 500), 7.6);
  });
  test('error analysis: up to a 200 pound invoice the collected fee is within 1p of F under floor, nearest AND ceiling rounding by Stripe', () => {
    const worst = { floor: 0, nearest: 0, ceil: 0 };
    for (let c = 100; c <= 20000; c++) { const f = C.feeParts(c, CFG).fee; for (const m of ['floor', 'nearest', 'ceil'] as const) worst[m] = Math.max(worst[m], Math.abs(C.percentErrorPence(f, c, m))); }
    assert.deepEqual(worst, { floor: 1, nearest: 1, ceil: 1 }, 'within the +/-1p tolerance for every amount up to 200.00');
  });
  test('above that the percentage granularity (0.005% of the amount) outgrows 1p: the maximum error is quantified, not hidden', () => {
    const firstOver: Record<string, number> = {}; const worst = { floor: 0, nearest: 0, ceil: 0 }; const at1000 = { floor: 0, nearest: 0, ceil: 0 };
    for (let c = 100; c <= 500000; c++) {
      const f = C.feeParts(c, CFG).fee;
      for (const m of ['floor', 'nearest', 'ceil'] as const) { const e = Math.abs(C.percentErrorPence(f, c, m)); worst[m] = Math.max(worst[m], e); if (c === 100000) at1000[m] = e; if (e > 1 && !(m in firstOver)) firstOver[m] = c; }
    }
    assert.deepEqual(firstOver, { floor: 20362, ceil: 20417, nearest: 30323 }, 'first invoice amounts (pence) whose error exceeds 1p');
    assert.deepEqual(worst, { floor: 21, nearest: 21, ceil: 21 }, 'worst case at the 5,000.00 charge ceiling is 21p');
    assert.ok(worst.nearest <= Math.ceil(500000 / 20000) , 'the nearest-percentage part of the error is at most C/20000 pence (rounding to 0.005 percentage points)');
  });
  test('the subscription carries the nearest percentage and nothing else of the fee (no flat amount can be set on a subscription)', () => {
    const p = C.subscriptionParams({ organiser_id: U1, charge_pence: 2500, platform_fee_pence: 108, price_pence: 2500, membership_id: U1, business_id: U2, tier_id: U2, tier_name: 'Friend', interval: 'monthly' }, 'acct_ABC123', 'cus_1', 'prod_ABC123');
    assert.equal(p.application_fee_percent, '4.32'); assert.ok(!('application_fee_amount' in p)); assert.ok(!('on_behalf_of' in p), 'on_behalf_of is not used: it changes nothing about who pays');
    assert.ok(!('application_fee_percent' in C.subscriptionParams({ organiser_id: U1, charge_pence: 2500, platform_fee_pence: 0, price_pence: 2500, membership_id: U1, business_id: U2, tier_id: U2, tier_name: 'Friend', interval: 'monthly' }, 'acct_ABC123', 'cus_1', 'prod_ABC123')));
  });
});

describe('commission refunds (step 2 of a refund)', () => {
  test('cumulative share = round(commission x refunded / charge); the whole commission on a full refund; deltas add up exactly', () => {
    assert.equal(C.commissionRefundedCumulative(40, 800, 2000), 16); assert.equal(C.commissionRefundedCumulative(40, 1500, 2000), 30); assert.equal(C.commissionRefundedCumulative(40, 2000, 2000), 40);
    assert.equal(C.commissionRefundedCumulative(21, 500, 1050), 10, '10.0'); assert.equal(C.commissionRefundedCumulative(5, 1, 3), 2, '1.67 -> 2');
    let ret = 0; for (const cum of [800, 1500, 2000]) { const d = C.commissionRefundDelta(40, cum, 2000, ret); assert.ok(d >= 0); ret += d; }
    assert.equal(ret, 40);
  });
  test('a repeat or a duplicate webhook changes nothing: the delta after the same cumulative is 0', () => {
    assert.equal(C.commissionRefundDelta(40, 800, 2000, 16), 0); assert.equal(C.commissionRefundDelta(40, 800, 2000, 20), 0, 'never negative');
  });
  test('any sequence of partial refunds returns exactly the commission at the end and never more', () => {
    for (let trial = 0; trial < 500; trial++) {
      const charge = 100 + ((trial * 7919) % 20000), comm = C.feeParts(charge, CFG).commission; let cum = 0, ret = 0;
      for (let step = 0; cum < charge; step++) { cum = Math.min(charge, cum + 1 + ((trial * 31 + step * 977) % Math.ceil(charge / 2))); const d = C.commissionRefundDelta(comm, cum, charge, ret); ret += d; assert.ok(ret <= comm); }
      assert.equal(ret, comm, `charge ${charge}`);
    }
  });
  test('variance = estimate minus actual', () => { assert.equal(C.recoveryVariance(170, 215), -45); assert.equal(C.recoveryVariance(170, 150), 20); });
});

describe('provider requests for the new calls', () => {
  test('refund step 1: the customer is refunded with reverse_transfer and the application fee is NOT refunded', () => {
    const r = C.refundParams({ payment_intent: 'pi_1', amount_pence: 800, request_id: U1 });
    assert.deepEqual(r, { payment_intent: 'pi_1', amount: '800', reverse_transfer: 'true', refund_application_fee: 'false', 'metadata[kind]': 'edition_refund', 'metadata[request_id]': U1 });
  });
  test('refund step 2: a partial application-fee refund for the commission share only; the key derives from the request id and the amount', () => {
    const q = C.applicationFeeRefundRequest({ application_fee_id: 'fee_1Abc', amount_pence: 16, request_id: U1 });
    assert.equal(q.method, 'POST'); assert.equal(q.path, '/application_fees/fee_1Abc/refunds'); assert.deepEqual(q.params, { amount: '16', 'metadata[kind]': 'edition_commission_refund', 'metadata[request_id]': U1 });
    assert.equal(q.idempotencyKey, C.applicationFeeRefundRequest({ application_fee_id: 'fee_1Abc', amount_pence: 16, request_id: U1 }).idempotencyKey);
    assert.notEqual(q.idempotencyKey, C.applicationFeeRefundRequest({ application_fee_id: 'fee_1Abc', amount_pence: 17, request_id: U1 }).idempotencyKey);
    for (const bad of ['', 'tr_1', 'fee_1/../x', 'fee_ 1']) assert.throws(() => C.applicationFeeRefundRequest({ application_fee_id: bad, amount_pence: 5, request_id: U1 }), /invalid application fee/);
    assert.throws(() => C.applicationFeeRefundRequest({ application_fee_id: 'fee_1', amount_pence: 0, request_id: U1 }), /more than nothing/);
    assert.throws(() => C.applicationFeeRefundRequest({ application_fee_id: 'fee_1', amount_pence: 1.5, request_id: U1 }), /integer pence/);
  });
  test('lost dispute: a transfer reversal for the disputed amount; the application fee is never refunded by it', () => {
    const q = C.transferReversalRequest({ transfer_id: 'tr_1Abc', amount_pence: 2000, dispute_id: 'dp_1Abc' });
    assert.equal(q.path, '/transfers/tr_1Abc/reversals'); assert.equal(q.params.amount, '2000'); assert.ok(!('refund_application_fee' in q.params)); assert.equal(q.params['metadata[dispute_id]'], 'dp_1Abc');
    assert.equal(q.idempotencyKey, 'ed-disputerev-dp_1Abc-2000');
    for (const bad of ['', 'acct_1', 'tr_1/x']) assert.throws(() => C.transferReversalRequest({ transfer_id: bad, amount_pence: 5, dispute_id: 'dp_1' }), /invalid transfer/);
    assert.throws(() => C.transferReversalRequest({ transfer_id: 'tr_1', amount_pence: 5, dispute_id: 'x_1' }), /invalid dispute/);
  });
  test('charge references (string or expanded), our own metadata found in a provider list, failure classification', () => {
    assert.deepEqual(C.chargeRefs({ application_fee: 'fee_1', transfer: { id: 'tr_1' }, application_fee_amount: 55 }), { application_fee: 'fee_1', transfer: 'tr_1', application_fee_amount: 55 });
    assert.deepEqual(C.chargeRefs({}), { application_fee: null, transfer: null, application_fee_amount: null });
    assert.equal(C.findByMetadata({ data: [{ id: 'trr_1', metadata: { dispute_id: 'dp_9' } }, { id: 'trr_2', metadata: { dispute_id: 'dp_1' } }] }, 'dispute_id', 'dp_1'), 'trr_2');
    assert.equal(C.findByMetadata({ data: [] }, 'dispute_id', 'dp_1'), null); assert.equal(C.findByMetadata(null, 'k', 'v'), null);
    assert.equal(C.classifyProviderFailure({ status: 400, code: 'balance_insufficient', message: 'x' }), 'insufficient');
    assert.equal(C.classifyProviderFailure({ status: 400, message: 'Insufficient funds in Stripe account.' }), 'insufficient');
    assert.equal(C.classifyProviderFailure({ status: 503 }), 'retry'); assert.equal(C.classifyProviderFailure({ status: 429 }), 'retry'); assert.equal(C.classifyProviderFailure({ status: 400, message: 'already reversed' }), 'failed');
  });
});

describe('dispute events', () => {
  const base = { id: 'dp_1', payment_intent: 'pi_p', reason: 'fraudulent', amount: 2000, status: 'needs_response' };
  const call = (type: string, o: Record<string, unknown>) => (C.routeEditionEvent(ev(type, o)) as Extract<C.Routed, { action: 'calls' }>);
  test('created, updated and closed are recorded by dispute id; the payment must be ours; the dispute fee is read from the balance transactions', () => {
    for (const t of ['created', 'updated', 'closed']) { const r = call(`charge.dispute.${t}`, { ...base, balance_transactions: [{ fee: 1500 }, { fee: 0 }] }); assert.equal(r.onlyIfKnownPaymentIntent, 'pi_p'); assert.equal(r.calls[0].fn, 'edition_dispute_event'); assert.equal(r.calls[0].args.p_event, t); assert.equal(r.calls[0].args.p_fee, 1500); }
    assert.equal(call('charge.dispute.closed', { ...base, status: 'lost' }).calls[0].args.p_status, 'lost'); assert.equal(call('charge.dispute.created', base).calls[0].args.p_fee, null);
  });
  test('a duplicate event routes to the same call with the same arguments (the database is idempotent on the dispute id); other dispute events and bad ones are ignored', () => {
    assert.deepEqual(call('charge.dispute.closed', { ...base, status: 'won' }), call('charge.dispute.closed', { ...base, status: 'won' }));
    assert.equal(C.routeEditionEvent(ev('charge.dispute.funds_withdrawn', base)).action, 'ignore'); assert.equal(C.routeEditionEvent(ev('charge.dispute.created', { ...base, payment_intent: undefined })).action, 'ignore');
    assert.equal(C.routeEditionEvent(ev('charge.dispute.created', { ...base, id: undefined })).action, 'ignore');
  });
  test('a participation payment event now carries a slot for the application fee Stripe actually collected', () => {
    const r = call('payment_intent.succeeded', { id: 'pi_p', amount_received: 2000, latest_charge: 'ch_p', metadata: { kind: 'edition_participation', link_id: U2 } });
    assert.ok('p_application_fee' in r.calls[0].args); assert.equal(r.calls[0].args.p_stripe_fee, null);
  });
});

describe('source contracts for the functions that make the calls (they are not deployed)', () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  test('the cron does step 1, then the commission step; it has a disputes action with the insufficient-balance path and no loop; reconcile expands the facts it compares', () => {
    const cron = read('editions-commerce-cron/index.ts');
    for (const t of ["action === 'disputes'", "action === 'commission_refunds'", 'edition_commission_plan_pending', 'edition_commission_refunds_next', 'edition_commission_refund_mark', 'edition_dispute_recoveries_next', 'edition_dispute_recovery_mark', 'transferReversalRequest', 'applicationFeeRefundRequest', 'classifyProviderFailure', 'findByMetadata', "'data.application_fee'", "'data.transfer'", "'data.balance_transaction'", 'transfer_reversed', 'application_fee_refunded', 'stripe_fee'])
      assert.ok(cron.includes(t), t);
    assert.ok(cron.lastIndexOf('refundCommissions()') > cron.indexOf("rpc('edition_refund_request_mark'"), 'step 2 follows step 1');
    assert.doesNotMatch(cron, /refund_application_fee: r\./, 'the refund no longer takes the fee flag from configuration');
  });
  test('the webhook passes the actual application fee, routes disputes by id, and records an amount_mismatch (with the mis-scaled note) for a membership invoice of a different amount', () => {
    const wh = read('editions-stripe-webhook/index.ts');
    assert.match(wh, /args\.p_application_fee = platformFee/); assert.match(wh, /edition_dispute_event/); assert.doesNotMatch(wh, /edition_payment_disputed/); assert.match(wh, /p_kind: 'amount_mismatch'/); assert.match(wh, /mis-scaled/);
  });
  test('no function offers a way to put a fee on the customer: fee_payer is gone from the functions', () => {
    for (const f of ['create-edition-checkout', 'editions-stripe-webhook', 'editions-commerce-cron', 'edition-connect-onboard']) assert.doesNotMatch(read(`${f}/index.ts`), /fee_payer|on_behalf_of/, f);
    assert.doesNotMatch(readFileSync(new URL('./editions-commerce-core.ts', import.meta.url), 'utf8'), /on_behalf_of'\]|\[on_behalf_of\]/, 'the core never sends on_behalf_of');
  });
  test('onboarding parameters are unchanged (card_payments and transfers both requested)', () => {
    const a = C.connectAccountParams({ organiser_id: U1, email: 'o@example.org', name: 'X' }); assert.equal(a['capabilities[card_payments][requested]'], 'true'); assert.equal(a['capabilities[transfers][requested]'], 'true');
  });
});
