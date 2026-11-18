/** Pure tests for editions-commerce-core.ts. Run: node --test supabase/functions/_shared/editions-commerce-core.node.test.ts (no database, no network, no secrets). */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as C from './editions-commerce-core.ts';

const U1 = '6f1c2b3a-1111-4222-8333-444455556666', U2 = '7f1c2b3a-1111-4222-8333-444455556667', U3 = '8f1c2b3a-1111-4222-8333-444455556668';
const ev = (type: string, object: Record<string, unknown>) => ({ id: 'evt_1', type, data: { object } });

describe('guard (what the shared webhook must leave alone)', () => {
  test('recognises the marker on the object, on a subscription invoice, and on an invoice line; nothing else', () => {
    assert.equal(C.editionKind({ metadata: { kind: 'edition_order' } }), 'edition_order');
    assert.equal(C.editionKind({ subscription_details: { metadata: { kind: 'edition_membership' } } }), 'edition_membership');
    assert.equal(C.editionKind({ lines: { data: [{ metadata: { kind: 'edition_membership' } }] } }), 'edition_membership');
    for (const o of [{}, null, undefined, { metadata: {} }, { metadata: { kind: 'local_subscription' } }, { metadata: { kind: 'edition_bogus' } }, { metadata: { kind: ['edition_order'] } }, { metadata: { business_id: 'b' } }]) assert.equal(C.editionKind(o), null);
    assert.equal(C.isEditionObject('customer.subscription.updated', { metadata: { kind: 'edition_membership' } }), true);
    assert.equal(C.isEditionObject('customer.subscription.updated', { metadata: { business_id: 'x', tier: 'pro' } }), false, 'a Business plan subscription is never an Edition object');
  });
  test('the shared webhook source carries the guard, before it claims or handles anything', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../stripe-webhook/index.ts', import.meta.url), 'utf8');
    assert.match(src, /isEditionObject/);
    assert.ok(src.indexOf('isEditionObject(') < src.indexOf("rpc('claim_stripe_event'"), 'guard runs before the event is claimed');
    assert.ok(src.indexOf('isEditionObject(') < src.indexOf('switch (eventType)'), 'guard runs before any handler');
  });
});

describe('signature', () => {
  const body = JSON.stringify(ev('payment_intent.succeeded', { id: 'pi_1' })), secret = 'whsec_test', now = 1_800_000_000;
  test('accepts a correct signature; rejects wrong secret, tampered body, old timestamp, missing parts, empty secret', async () => {
    const h = await C.signForTest(body, secret, now);
    assert.deepEqual(await C.verifyStripeSignature(body, h, secret, now), JSON.parse(body));
    await assert.rejects(C.verifyStripeSignature(body, h, 'whsec_other', now), /mismatch/);
    await assert.rejects(C.verifyStripeSignature(body + ' ', h, secret, now), /mismatch/);
    await assert.rejects(C.verifyStripeSignature(body, h, secret, now + 301), /window/);
    await assert.rejects(C.verifyStripeSignature(body, 'garbage', secret, now), /malformed/);
    await assert.rejects(C.verifyStripeSignature(body, h, '', now), /no signing secret/);
    const two = `${h},v1=${'0'.repeat(64)}`;
    assert.ok(await C.verifyStripeSignature(body, two, secret, now), 'any valid v1 is enough (key rotation)');
  });
});

describe('event routing', () => {
  test('non-Edition and unmarked objects are ignored', () => {
    assert.equal(C.routeEditionEvent(ev('payment_intent.succeeded', { id: 'pi_1', amount_received: 500, metadata: {} })).action, 'ignore');
    assert.equal(C.routeEditionEvent(ev('customer.subscription.updated', { id: 'sub', metadata: { business_id: 'x' } })).action, 'ignore');
    assert.equal(C.routeEditionEvent({ type: 'x' }).action, 'ignore');
  });
  test('package payment -> fulfil with the amount the provider actually received', () => {
    const r = C.routeEditionEvent(ev('payment_intent.succeeded', { id: 'pi_o', amount_received: 2500, metadata: { kind: 'edition_order', order_id: U1 } }));
    assert.deepEqual(r, { action: 'calls', calls: [{ fn: 'edition_fulfil_order', args: { p_order: U1, p_payment_intent: 'pi_o', p_amount: 2500 } }] });
  });
  test('participation payment -> participation success (charge id carried for the fee lookup); failure -> failed', () => {
    const r = C.routeEditionEvent(ev('payment_intent.succeeded', { id: 'pi_p', amount_received: 2000, latest_charge: 'ch_p', metadata: { kind: 'edition_participation', link_id: U2 } })) as Extract<C.Routed, { action: 'calls' }>;
    assert.equal(r.calls[0].fn, 'edition_participation_payment_succeeded'); assert.equal(r.calls[0].args.p_charge_pence, 2000); assert.deepEqual(r.needsChargeDetail, { chargeId: 'ch_p' });
    assert.equal((C.routeEditionEvent(ev('payment_intent.payment_failed', { id: 'pi_p', metadata: { kind: 'edition_participation', link_id: U2 } })) as Extract<C.Routed, { action: 'calls' }>).calls[0].fn, 'edition_participation_payment_failed');
    assert.equal((C.routeEditionEvent(ev('payment_intent.payment_failed', { id: 'pi_o', metadata: { kind: 'edition_order', order_id: U1 } })) as Extract<C.Routed, { action: 'calls' }>).calls[0].fn, 'edition_order_failed');
  });
  test('membership invoice -> payment recorded for the period; failure -> past due; subscription events -> status', () => {
    const inv = { id: 'in_1', amount_paid: 1000, subscription: 'sub_1', payment_intent: 'pi_i', charge: 'ch_i', subscription_details: { metadata: { kind: 'edition_membership', membership_id: U3 } }, lines: { data: [{ period: { start: 1_800_000_000, end: 1_802_592_000 } }] } };
    const r = C.routeEditionEvent(ev('invoice.payment_succeeded', inv)) as Extract<C.Routed, { action: 'calls' }>;
    assert.equal(r.calls[0].fn, 'edition_membership_payment_succeeded'); assert.equal(r.calls[0].args.p_invoice, 'in_1'); assert.equal(r.calls[0].args.p_period_end, new Date(1_802_592_000 * 1000).toISOString());
    assert.equal((C.routeEditionEvent(ev('invoice.paid', inv)) as Extract<C.Routed, { action: 'calls' }>).calls[0].fn, 'edition_membership_payment_succeeded');
    assert.equal((C.routeEditionEvent(ev('invoice.payment_failed', { ...inv, attempt_count: 2 })) as Extract<C.Routed, { action: 'calls' }>).calls[0].args.p_attempt_count, 2);
    const s = C.routeEditionEvent(ev('customer.subscription.updated', { id: 'sub_1', status: 'active', cancel_at_period_end: true, metadata: { kind: 'edition_membership', membership_id: U3 }, items: { data: [{ current_period_end: 1_802_592_000 }] } })) as Extract<C.Routed, { action: 'calls' }>;
    assert.deepEqual(s.calls[0].args, { p_membership: U3, p_status: 'active', p_cancel_at_period_end: true, p_period_end: new Date(1_802_592_000 * 1000).toISOString() });
    assert.equal((C.routeEditionEvent(ev('customer.subscription.deleted', { id: 'sub_1', metadata: { kind: 'edition_membership', membership_id: U3 } })) as Extract<C.Routed, { action: 'calls' }>).calls[0].args.p_status, 'canceled');
  });
  test('refunds use the CUMULATIVE amount; orders route to the order, everything else by payment intent; disputes only if the payment is ours', () => {
    assert.deepEqual((C.routeEditionEvent(ev('charge.refunded', { payment_intent: 'pi_o', amount_refunded: 500, metadata: { kind: 'edition_order', order_id: U1 } })) as Extract<C.Routed, { action: 'calls' }>).calls[0], { fn: 'edition_refund_order', args: { p_order: U1, p_refunded_total: 500 } });
    assert.deepEqual((C.routeEditionEvent(ev('charge.refunded', { payment_intent: 'pi_p', amount_refunded: 2000, metadata: { kind: 'edition_participation', link_id: U2 } })) as Extract<C.Routed, { action: 'calls' }>).calls[0], { fn: 'edition_payment_refunded', args: { p_payment_intent: 'pi_p', p_refunded_total: 2000 } });
    const d = C.routeEditionEvent(ev('charge.dispute.created', { id: 'dp_1', payment_intent: 'pi_p', reason: 'fraudulent', amount: 2000, status: 'needs_response', balance_transactions: [{ fee: 1500 }] })) as Extract<C.Routed, { action: 'calls' }>;
    assert.equal(d.onlyIfKnownPaymentIntent, 'pi_p'); assert.equal(d.calls[0].fn, 'edition_dispute_event');
    assert.deepEqual(d.calls[0].args, { p_payment_intent: 'pi_p', p_dispute: 'dp_1', p_event: 'created', p_status: 'needs_response', p_amount: 2000, p_fee: 1500, p_reason: 'fraudulent' });
    assert.equal(C.routeEditionEvent(ev('charge.dispute.created', { id: 'dp_1', reason: 'x' })).action, 'ignore');
  });
  test('Connect account status -> payout account sync, only for Edition organiser accounts', () => {
    const r = C.routeEditionEvent(ev('account.updated', { id: 'acct_1', details_submitted: true, charges_enabled: true, payouts_enabled: false, requirements: { currently_due: ['external_account'] }, metadata: { kind: 'edition_organiser', organiser_id: U1 } })) as Extract<C.Routed, { action: 'calls' }>;
    assert.deepEqual(r.calls[0].args, { p_org: U1, p_account: 'acct_1', p_details: true, p_charges: true, p_payouts: false, p_requirements: ['external_account'] });
    assert.equal(C.routeEditionEvent(ev('account.updated', { id: 'acct_2', metadata: { kind: 'edition_organiser', organiser_id: 'not-a-uuid' } })).action, 'ignore');
    assert.equal(C.routeEditionEvent(ev('account.updated', { id: 'acct_driver', metadata: { supabase_user_id: U1 } })).action, 'ignore', 'a driver payout account is not ours');
  });
  test('malformed metadata or amounts are ignored, never guessed', () => {
    for (const bad of [{ id: 'pi', amount_received: 12.5, metadata: { kind: 'edition_order', order_id: U1 } }, { id: 'pi', amount_received: 100, metadata: { kind: 'edition_order', order_id: 'nope' } }, { amount_received: 100, metadata: { kind: 'edition_order', order_id: U1 } }]) {
      assert.equal(C.routeEditionEvent(ev('payment_intent.succeeded', bad)).action, 'ignore');
    }
    assert.equal(C.routeEditionEvent(ev('payment_intent.succeeded', { id: 'pi', amount_received: 100, metadata: { kind: 'edition_membership' } })).action, 'ignore');
  });
});

describe('provider parameters', () => {
  const prep = { organiser_id: U1, charge_pence: 2000, platform_fee_pence: 100, price_pence: 2000, link_id: U2, business_id: U3, edition_id: U1 };
  test('package intent: no transfer, no application fee; integer pence only', () => {
    const p = C.orderIntentParams({ order_id: U1, organiser_id: U2, amount_pence: 2500, edition_id: U3, buyer_id: U1 });
    assert.equal(p.amount, '2500'); assert.equal(p['metadata[kind]'], 'edition_order'); assert.equal(p.currency, 'gbp');
    assert.ok(!('transfer_data[destination]' in p) && !('application_fee_amount' in p));
    assert.throws(() => C.orderIntentParams({ order_id: U1, organiser_id: U2, amount_pence: 25.5, edition_id: U3, buyer_id: U1 }), /integer pence/);
    assert.throws(() => C.orderIntentParams({ order_id: U1, organiser_id: U2, amount_pence: -1, edition_id: U3, buyer_id: U1 }), /integer pence/);
  });
  test('participation intent: destination charge to the organiser with the fee as application fee, marker and ids, customer optional', () => {
    const p = C.participationIntentParams(prep, 'acct_ABC123', U3, 'cus_1');
    assert.equal(p.amount, '2000'); assert.equal(p['transfer_data[destination]'], 'acct_ABC123'); assert.equal(p.application_fee_amount, '100'); assert.equal(p['metadata[kind]'], 'edition_participation'); assert.equal(p['metadata[link_id]'], U2); assert.equal(p.customer, 'cus_1');
    assert.ok(!('application_fee_amount' in C.participationIntentParams({ ...prep, platform_fee_pence: 0 }, 'acct_ABC123', U3, null)), 'a zero fee sends no fee field');
    assert.throws(() => C.participationIntentParams({ ...prep, platform_fee_pence: 3000 }, 'acct_ABC123', U3, null), /exceeds the charge/);
    for (const bad of ['', 'acct_', 'cus_1', 'acct_x y', 'acct_x&transfer_data[destination]=acct_evil']) assert.throws(() => C.participationIntentParams(prep, bad, U3, null), /invalid connected account/, bad);
  });
  test('subscription: inline price from the database amount, percent fee rounded to the nearest 0.01, destination and marker on the subscription', () => {
    const p = C.subscriptionParams({ ...prep, membership_id: U2, tier_id: U3, tier_name: 'Full member', interval: 'annual', charge_pence: 10000, platform_fee_pence: 370 }, 'acct_ABC123', 'cus_9', 'prod_ABC123');
    assert.equal(p['items[0][price_data][product]'], 'prod_ABC123'); assert.ok(!Object.keys(p).some((k) => k.includes('product_data')), 'Stripe rejects product_data inside a subscription price'); assert.equal(p['items[0][price_data][unit_amount]'], '10000'); assert.equal(p['items[0][price_data][recurring][interval]'], 'year'); assert.equal(p.application_fee_percent, '3.7', '370 of 10000 is exactly 3.7%'); assert.equal(p['transfer_data[destination]'], 'acct_ABC123');
    assert.equal(p['metadata[kind]'], 'edition_membership'); assert.equal(p['metadata[membership_id]'], U2); assert.equal(p.payment_behavior, 'default_incomplete');
    assert.equal(C.feePercent(35, 700), 5); assert.equal(C.feePercent(24, 700), 3.43, 'rounded to the NEAREST 0.01 (3.4286)'); assert.equal(C.feePercent(0, 700), 0); assert.equal(C.feePercent(9999, 100), 100, 'capped at 100');
    assert.throws(() => C.subscriptionParams({ ...prep, membership_id: U2, tier_id: U3, tier_name: 'x', interval: 'weekly' as never }, 'acct_ABC123', 'cus_9', 'prod_ABC123'), /invalid interval/);
    assert.throws(() => C.subscriptionParams({ ...prep, membership_id: U2, tier_id: U3, tier_name: 'x', interval: 'annual' }, 'acct_ABC123', 'cus_9', 'price_x'), /invalid product/);
    const pr = C.productParams({ membership_id: U2, organiser_id: U1, tier_id: U3, tier_name: 'Full member' }); assert.equal(pr.name, 'Full member membership'); assert.equal(pr['metadata[kind]'], 'edition_membership_product');
  });
  test('connect account and refund parameters', () => {
    const a = C.connectAccountParams({ organiser_id: U1, email: 'o@example.org', name: 'Folk Festival Committee' });
    assert.equal(a.type, 'express'); assert.equal(a.country, 'GB'); assert.equal(a['metadata[kind]'], 'edition_organiser'); assert.equal(a['capabilities[transfers][requested]'], 'true');
    const r = C.refundParams({ payment_intent: 'pi_1', amount_pence: 800, request_id: U2 });
    assert.equal(r.reverse_transfer, 'true'); assert.equal(r.refund_application_fee, 'false', 'the platform keeps F; only the commission share goes back, in step 2'); assert.equal(r.amount, '800');
    assert.throws(() => C.refundParams({ payment_intent: 'pi_1', amount_pence: 0.5, request_id: U2 }), /integer pence/);
  });
  test('idempotency keys are stable per attempt and bounded; form bodies are encoded', () => {
    assert.equal(C.idempotencyKey('participation', U2, 'attempt-1'), C.idempotencyKey('participation', U2, 'attempt-1'));
    assert.notEqual(C.idempotencyKey('participation', U2, 'attempt-1'), C.idempotencyKey('participation', U2, 'attempt-2'));
    assert.ok(C.idempotencyKey('x', 'y'.repeat(400), 'z').length <= 255);
    assert.equal(C.formBody({ a: 'b c', 'm[k]': 'v&w' }), 'a=b+c&m%5Bk%5D=v%26w');
  });
});

describe('payment safeguards (R9)', () => {
  const q = { charge_pence: 1200, platform_fee_pence: 100, vat_pence: 0 };
  test('charge key ignores the client attempt token, so a second submit is the same Stripe request', () => {
    assert.equal(C.chargeKey('participation', U2, q, 'acct_1234ABCD'), C.chargeKey('participation', U2, q, 'acct_1234ABCD'));
    assert.ok(!C.chargeKey('participation', U2, q, 'acct_1234ABCD').includes('attempt'));
  });
  test('charge key changes when the quote or destination changes', () => {
    const base = C.chargeKey('membership', U2, q, 'acct_1234ABCD');
    assert.notEqual(base, C.chargeKey('membership', U2, { ...q, charge_pence: 1300 }, 'acct_1234ABCD'));
    assert.notEqual(base, C.chargeKey('membership', U2, q, 'acct_9999ZZZZ'));
    assert.notEqual(base, C.chargeKey('participation', U2, q, 'acct_1234ABCD'));
  });
  test('each signing secret is bound to its own event kind', () => {
    assert.equal(C.expectedSecretKind(JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' })), 'platform');
    assert.equal(C.expectedSecretKind(JSON.stringify({ id: 'evt_2', type: 'account.updated', account: 'acct_123' })), 'connect');
    assert.equal(C.expectedSecretKind(JSON.stringify({ id: 'evt_3', account: 'not-an-account' })), 'platform');
    assert.equal(C.expectedSecretKind('not json'), null);
    assert.equal(C.expectedSecretKind(JSON.stringify({ type: 'x' })), null);
  });
  test('the functions use them: no client attempt in charge keys, no secret loop', async () => {
    const fs = await import('node:fs'); const r = (p: string) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
    const co = r('create-edition-checkout/index.ts'); assert.doesNotMatch(co, /idempotencyKey\('(participation|membership|order)'/); assert.match(co, /chargeKey\('participation'/); assert.match(co, /chargeKey\('membership'/);
    const wh = r('editions-stripe-webhook/index.ts'); assert.match(wh, /expectedSecretKind\(body\)/); assert.doesNotMatch(wh, /for \(const secret of secrets\)/);
  });
});

describe('Stripe lifecycle (R10)', () => {
  test('cancel requests: stop-renewal and end-now shapes; bad ids refused', () => {
    assert.deepEqual(C.subscriptionCancelRequest('at_period_end', 'sub_123'), { method: 'POST', path: '/subscriptions/sub_123', params: { cancel_at_period_end: 'true' } });
    assert.deepEqual(C.subscriptionCancelRequest('now', 'sub_123'), { method: 'DELETE', path: '/subscriptions/sub_123', params: { invoice_now: 'false', prorate: 'false' } });
    for (const bad of ['', 'cus_1', 'sub_1/../x', 'sub_ 1']) assert.throws(() => C.subscriptionCancelRequest('now', bad), /invalid subscription id/, bad);
  });
  test('a refund of a subscription charge (no marker on the charge) is routed by its payment intent, only if the ledger knows it', () => {
    const r = C.routeEditionEvent({ id: 'evt_1', type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: 'pi_sub', amount_refunded: 700, metadata: {} } } }) as any;
    assert.equal(r.action, 'calls'); assert.equal(r.onlyIfKnownPaymentIntent, 'pi_sub');
    assert.deepEqual(r.calls, [{ fn: 'edition_payment_refunded', args: { p_payment_intent: 'pi_sub', p_refunded_total: 700 } }]);
    assert.equal((C.routeEditionEvent({ id: 'evt_2', type: 'charge.refunded', data: { object: { id: 'ch_2', amount_refunded: 700, metadata: {} } } }) as any).action, 'ignore', 'no payment intent: ignored');
    assert.equal((C.routeEditionEvent({ id: 'evt_3', type: 'charge.refunded', data: { object: { id: 'ch_3', payment_intent: 'pi_x', amount_refunded: 1.5 } } }) as any).action, 'ignore', 'non-integer amount: ignored');
  });
  test('marked one-off refunds still route by their own marker (unchanged)', () => {
    const r = C.routeEditionEvent({ id: 'evt_4', type: 'charge.refunded', data: { object: { id: 'ch_4', payment_intent: 'pi_o', amount_refunded: 1000, metadata: { kind: 'edition_order', order_id: U1 } } } }) as any;
    assert.equal(r.calls[0].fn, 'edition_refund_order');
  });
  test('the cron cancels subscriptions and reconciles invoice charges', async () => {
    const fs = await import('node:fs'); const src = fs.readFileSync(new URL('../editions-commerce-cron/index.ts', import.meta.url), 'utf8');
    assert.match(src, /action === 'cancels'/); assert.match(src, /edition_stripe_cancels_next/); assert.match(src, /edition_stripe_cancel_mark/); assert.match(src, /subscriptionCancelRequest/);
    assert.match(src, /\(marked \|\| c\.invoice\)/); assert.match(src, /No such subscription/);
  });
});

describe('edge function contracts (source checks; the functions are not deployed)', () => {
  const read = async (p: string) => (await import('node:fs')).readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  test('checkout never reads an amount from the request body; prices come only from database prepare results', async () => {
    const src = await read('create-edition-checkout/index.ts');
    const body = src.match(/const \{([^}]*)\} = await req\.json/)?.[1] ?? '';
    assert.ok(!/amount|price|fee|charge/i.test(body), `body destructures ${body}`);
    assert.match(src, /edition_participation_pay_prepare/); assert.match(src, /edition_membership_pay_prepare/); assert.match(src, /enforcePaymentStart/); assert.match(src, /Idempotency-Key/);
    assert.ok(!/stripe_customer_id|local_businesses|hub_members|subscription_tier/.test(src), 'no Business or Hub billing state');
  });
  test('the Editions webhook verifies the signature before anything else and ignores non-Edition events without touching the database', async () => {
    const src = await read('editions-stripe-webhook/index.ts');
    assert.ok(src.indexOf('await verifyStripeSignature(') < src.indexOf("rpc('edition_webhook_begin'"));
    assert.ok(src.indexOf("routed.action === 'ignore'") < src.indexOf("rpc('edition_webhook_begin'"));
    assert.match(src, /EDITIONS_STRIPE_WEBHOOK_SECRET/); assert.ok(!src.includes("'STRIPE_WEBHOOK_SECRET'") && !src.includes("'STRIPE_CONNECT_WEBHOOK_SECRET'"), 'does not reuse the shared secrets');
  });
  test('connect onboarding is owner-only, https return urls on our domain only, and uses its own account kind and table', async () => {
    const src = await read('edition-connect-onboard/index.ts');
    assert.match(src, /role !== 'owner'/); assert.match(src, /oneshetland\\\.com/); assert.match(src, /edition_payout_account_sync/); assert.ok(!/driver_profiles|profiles\b.*stripe/.test(src));
  });
  test('the cron needs the service-role bearer and never auto-corrects the ledger', async () => {
    const src = await read('editions-commerce-cron/index.ts');
    assert.match(src, /SUPABASE_SERVICE_ROLE_KEY/); assert.match(src, /Unauthorised/); assert.ok(!/edition_payments.*update|from\('edition_payments'\)/.test(src));
  });
});

describe('R12 existing subscriptions and provider failures', () => {
  const sub = (status: string, pi?: Record<string, unknown>) => ({ id: 'sub_1', status, latest_invoice: { payment_intent: pi } });
  test('a past-due subscription with an open invoice is paid through that invoice', () => {
    for (const st of ['past_due', 'unpaid', 'incomplete']) for (const pis of ['requires_payment_method', 'requires_action', 'requires_confirmation'])
      assert.deepEqual(C.existingSubscriptionDecision(sub(st, { status: pis, client_secret: 'pi_secret_1' })), { action: 'pay', clientSecret: 'pi_secret_1' }, `${st}/${pis}`);
  });
  test('an up-to-date subscription takes nothing; everything else takes nothing and asks the member to wait or contact support (never a second subscription)', () => {
    assert.deepEqual(C.existingSubscriptionDecision(sub('active')), { action: 'settled' });
    assert.deepEqual(C.existingSubscriptionDecision(sub('trialing')), { action: 'settled' });
    for (const x of [sub('canceled'), sub('incomplete_expired'), sub('past_due'), sub('past_due', { status: 'processing', client_secret: 'x' }), sub('past_due', { status: 'succeeded', client_secret: 'x' }), sub('past_due', { status: 'requires_payment_method' }), null, undefined, 'nonsense', {}])
      assert.deepEqual(C.existingSubscriptionDecision(x), { action: 'unavailable' });
  });
  test('only temporary provider failures are retried', () => {
    for (const st of [0, 409, 429, 500, 502, 503]) assert.equal(C.isRetryableProviderStatus(st), true, String(st));
    for (const st of [400, 401, 402, 403, 404]) assert.equal(C.isRetryableProviderStatus(st), false, String(st));
  });
  test('the functions use them: the checkout never creates a second subscription for a membership that has one; the cron retries, then escalates, refunds and ends strays', async () => {
    const fs = await import('node:fs'); const r = (p: string) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
    const co = r('create-edition-checkout/index.ts');
    assert.match(co, /prep\.existing_subscription/); assert.match(co, /existingSubscriptionDecision\(existing\)/);
    assert.ok(co.indexOf('existingSubscriptionDecision') < co.indexOf("post('/subscriptions'"), 'the existing subscription is consulted BEFORE any new one is created');
    const cron = r('editions-commerce-cron/index.ts');
    for (const t of ['isRetryableProviderStatus', "'retry'", 'charge_already_refunded', 'edition_stripe_stray_next', 'edition_stripe_stray_mark']) assert.ok(cron.includes(t), t);
  });
});

describe('R12 provider events and secrets', () => {
  test('a disconnected Stripe account stops collection: routed by the connected account id only', () => {
    const r = C.routeEditionEvent({ id: 'evt_d', type: 'account.application.deauthorized', account: 'acct_1Abc23Def', data: { object: { id: 'ca_1', object: 'application', name: 'OneShetland' } } });
    assert.deepEqual(r, { action: 'calls', calls: [{ fn: 'edition_payout_account_disconnected', args: { p_account: 'acct_1Abc23Def' } }] });
    for (const account of [undefined, '', 'not-an-account', 'acct_bad id']) assert.equal(C.routeEditionEvent({ id: 'evt_d', type: 'account.application.deauthorized', account, data: { object: {} } }).action, 'ignore', String(account));
  });
  test('the cron secret is compared in constant time: equal strings match; any difference, prefix or length change does not', () => {
    assert.equal(C.safeEqual('sk_secret_value', 'sk_secret_value'), true);
    for (const x of ['sk_secret_valuE', 'sk_secret_valu', 'sk_secret_value ', '', 'Sk_secret_value']) assert.equal(C.safeEqual('sk_secret_value', x), false, x);
    assert.equal(C.safeEqual('', ''), true);
    assert.equal(C.safeEqual('héllo', 'héllo'), true); assert.equal(C.safeEqual('héllo', 'hello'), false);
  });
  test('both crons use it, and neither compares the bearer with ===', async () => {
    const fs = await import('node:fs');
    for (const f of ['editions-commerce-cron', 'editions-email-cron']) { const src = fs.readFileSync(new URL(`../${f}/index.ts`, import.meta.url), 'utf8'); assert.match(src, /safeEqual\(bearer/, f); assert.doesNotMatch(src, /bearer\s*!==/, f); }
  });
});

describe('PACKAGE flow (editions-complete)', () => {
  const read = async (p: string) => (await import('node:fs')).readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const ok = { order: { buyer_id: 'u1', status: 'pending' }, userId: 'u1', canAdmin: true, editionApproved: true, commerceOn: true };
  test('checkout decision: an owner OR admin who created the order may pay; others, unapproved Editions and switched-off payments may not', () => {
    assert.deepEqual(C.orderCheckoutDecision(ok), { ok: true });
    assert.deepEqual(C.orderCheckoutDecision({ ...ok, order: { buyer_id: 'u1', status: 'failed' } }), { ok: true }, 'a failed card can be retried');
    assert.equal((C.orderCheckoutDecision({ ...ok, order: null }) as { status: number }).status, 404);
    assert.equal((C.orderCheckoutDecision({ ...ok, userId: 'u2' }) as { status: number }).status, 404, 'someone else\'s order looks like no order');
    for (const status of ['paid', 'cancelled', 'refunded', 'partially_refunded']) assert.equal((C.orderCheckoutDecision({ ...ok, order: { buyer_id: 'u1', status } }) as { status: number }).status, 404, status);
    assert.equal((C.orderCheckoutDecision({ ...ok, canAdmin: false }) as { status: number }).status, 403);
    assert.equal((C.orderCheckoutDecision({ ...ok, editionApproved: false }) as { status: number }).status, 409);
    assert.equal((C.orderCheckoutDecision({ ...ok, commerceOn: false }) as { status: number }).status, 409);
  });
  test('the checkout does not assume the owner-only role or read the owner-only order policy as the user, and never inserts orders itself', async () => {
    const src = await read('create-edition-checkout/index.ts');
    assert.ok(!/asUser\.from\('edition_orders'\)/.test(src), 'order is read with the service role');
    assert.match(src, /edition_org_can/); assert.match(src, /p_min: 'admin'/); assert.ok(!/p_min: 'owner'/.test(src));
    assert.match(src, /orderCheckoutDecision/); assert.ok(!/\.insert\(|\.rpc\(.edition_create_order/.test(src), 'orders are created only by edition_create_order in the database (called by the web action), never here');
    assert.ok(!/body.*amount|req\.json[^;]*amount/.test(src));
  });
  test('order charge reconciliation: matching charges are silent; missing, wrong-amount and refund drift are raised; unpaid charges are skipped', () => {
    const ch = { payment_intent: 'pi_1', amount: 5000, refunded: 0, paid: true };
    const ord = { organiser_id: 'o1', amount_pence: 5000, refunded_pence: 0, status: 'paid' };
    assert.deepEqual(C.reconcileOrderCharge(ch, ord), []);
    assert.deepEqual(C.reconcileOrderCharge({ ...ch, paid: false }, null), []);
    assert.equal(C.reconcileOrderCharge(ch, null)[0].kind, 'missing_in_ledger');
    assert.equal(C.reconcileOrderCharge(ch, { ...ord, status: 'pending' })[0].kind, 'missing_in_ledger');
    assert.equal(C.reconcileOrderCharge({ ...ch, amount: 4000 }, ord)[0].kind, 'amount_mismatch');
    assert.equal(C.reconcileOrderCharge({ ...ch, refunded: 5000 }, ord)[0].kind, 'refund_mismatch');
    assert.deepEqual(C.reconcileOrderCharge({ ...ch, refunded: 5000 }, { ...ord, status: 'refunded', refunded_pence: 5000 }), []);
  });
  test('webhook: a dispute or unmarked refund on a package order reaches the order table; the cron checks order charges separately', async () => {
    const w = await read('editions-stripe-webhook/index.ts');
    assert.match(w, /from\('edition_orders'\)/); assert.match(w, /edition_refund_order/); assert.match(w, /p_kind: 'dispute'/);
    const c = await read('editions-commerce-cron/index.ts');
    assert.match(c, /reconcileOrderCharge/); assert.match(c, /'edition_order'/);
  });
  test('a dispute is routed by payment intent and never changes an entitlement by itself', () => {
    const r = C.routeEditionEvent(ev('charge.dispute.created', { id: 'dp_9', payment_intent: 'pi_9', reason: 'fraudulent' })) as { calls: { fn: string }[]; onlyIfKnownPaymentIntent: string };
    assert.equal(r.onlyIfKnownPaymentIntent, 'pi_9'); assert.deepEqual(r.calls.map((x) => x.fn), ['edition_dispute_event']);
  });
});

test('webhook: a second, different payment for an already-paid package order is raised as a duplicate for the administrator', async () => {
  const w = (await import('node:fs')).readFileSync(new URL('../editions-stripe-webhook/index.ts', import.meta.url), 'utf8');
  assert.match(w, /already_fulfilled/); assert.match(w, /duplicate_payment_for_order/); assert.match(w, /stripe_payment_intent_id !== call\.args\.p_payment_intent/);
});

describe('package order refunds', () => {
  test('a package refund is a plain refund: no transfer reversal, no application fee, integer positive pence, traceable ids', () => {
    const p = C.orderRefundParams({ payment_intent: 'pi_1', amount_pence: 2500, request_id: U1, order_id: U2 });
    assert.deepEqual(p, { payment_intent: 'pi_1', amount: '2500', reason: 'requested_by_customer', 'metadata[kind]': 'edition_order_refund', 'metadata[request_id]': U1, 'metadata[order_id]': U2 });
    assert.ok(!('reverse_transfer' in p) && !('refund_application_fee' in p));
    assert.throws(() => C.orderRefundParams({ payment_intent: 'pi_1', amount_pence: 0, request_id: U1, order_id: U2 })); assert.throws(() => C.orderRefundParams({ payment_intent: 'pi_1', amount_pence: 10.5, request_id: U1, order_id: U2 }));
  });
  test('the cron picks the order refund for order requests, keeps one idempotency key per request, and retries only temporary failures', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../editions-commerce-cron/index.ts', import.meta.url), 'utf8');
    assert.match(src, /r\.order_id \? orderRefundParams/); assert.match(src, /idempotencyKey\('refund', r\.request_id, '1'\)/); assert.match(src, /isRetryableProviderStatus/);
  });
});
