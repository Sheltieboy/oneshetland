#!/usr/bin/env node
// Sends every request body the Editions payment code builds to stripe-mock, Stripe's own API mock, which validates each request against Stripe's real OpenAPI spec.
// stripe-mock returns fixture responses (it does not echo values), so success here means Stripe's SPEC accepts the request, nothing more.
// It proves the REQUEST SHAPES are ones Stripe accepts. It does NOT prove behaviour against real Stripe (no real account, no card, no webhooks from Stripe).
//   docker run -d --rm --name editions-stripe-mock -p 127.0.0.1:12111:12111 stripe/stripe-mock:latest && node scripts/editions-stripe-mock-check.mjs
import { orderIntentParams, participationIntentParams, subscriptionParams, productParams, connectAccountParams, refundParams, formBody, idempotencyKey, subscriptionCancelRequest } from '../supabase/functions/_shared/editions-commerce-core.ts';
const BASE = process.env.STRIPE_MOCK ?? 'http://127.0.0.1:12111/v1';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const post = async (path, params, key) => { const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { authorization: 'Bearer sk_test_123', 'content-type': 'application/x-www-form-urlencoded', ...(key ? { 'idempotency-key': key } : {}) }, body: formBody(params) }); return { status: r.status, body: await r.json() }; };
const U = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

console.log('control: the mock really validates (these must be refused)');
let r = await post('/payment_intents', { amount: '2000', currency: 'gbp', not_a_real_param: 'x' }); ok(r.status === 400, `an unknown parameter is refused (${r.status})`);
r = await post('/payment_intents', { amount: 'twenty', currency: 'gbp' }); ok(r.status === 400, `a non-numeric amount is refused (${r.status})`);
r = await post('/payment_intents', { currency: 'gbp' }); ok(r.status === 400, `a missing amount is refused (${r.status})`);

console.log('package order (platform keeps it all: no transfer, no application fee)');
const op = orderIntentParams({ order_id: U(1), organiser_id: U(2), amount_pence: 12500, edition_id: U(3), buyer_id: U(4) });
r = await post('/payment_intents', op, idempotencyKey('order', U(1), 'a1')); ok(r.status === 200, `package order payment intent accepted by Stripe's spec (${r.status})`);
ok(!('transfer_data[destination]' in op) && !('application_fee_amount' in op), 'no transfer and no application fee are sent for a package order');

console.log('participation (destination charge to the organiser with the platform fee)');
const pp = participationIntentParams({ organiser_id: U(2), charge_pence: 3000, platform_fee_pence: 150, price_pence: 3000, link_id: U(5), business_id: U(6), edition_id: U(3) }, 'acct_1Abc23Def', U(4), null);
r = await post('/payment_intents', pp); ok(r.status === 200 && pp.amount === '3000' && pp.application_fee_amount === '150' && pp['transfer_data[destination]'] === 'acct_1Abc23Def', `destination charge accepted: 30.00, fee 1.50, to the connected account (${r.status})`);
const free = participationIntentParams({ organiser_id: U(2), charge_pence: 3000, platform_fee_pence: 0, price_pence: 3000, link_id: U(5), business_id: U(6), edition_id: U(3) }, 'acct_1Abc23Def', U(4), 'cus_123');
r = await post('/payment_intents', free); ok(r.status === 200 && !('application_fee_amount' in free) && free.customer === 'cus_123', `no fee line when the fee is zero; a saved customer is attached (${r.status})`);

console.log('membership (a subscription whose invoices are destination charges)');
const cu = await post('/customers', { email: 'owner@example.test', 'metadata[kind]': 'edition_customer' }); ok(cu.status === 200, `customer created (${cu.status})`);
const prod = await post('/products', productParams({ membership_id: U(7), organiser_id: U(2), tier_id: U(8), tier_name: 'Spotlight' }), idempotencyKey('product', U(7), 'm')); ok(prod.status === 200, `product accepted (${prod.status})`);
for (const interval of ['monthly', 'annual']) {
  const sp = subscriptionParams({ organiser_id: U(2), charge_pence: interval === 'monthly' ? 900 : 9000, platform_fee_pence: interval === 'monthly' ? 45 : 450, price_pence: 9000, membership_id: U(7), business_id: U(6), tier_id: U(8), tier_name: 'Spotlight', interval }, 'acct_1Abc23Def', cu.body.id, prod.body.id);
  r = await post('/subscriptions', sp, idempotencyKey('membership', U(7), interval)); ok(r.status === 200, `${interval} subscription accepted with an inline price on a real product (${r.status}) ${r.status === 200 ? '' : JSON.stringify(r.body).slice(0, 200)}`);
  ok(Number(sp.application_fee_percent) === 5, `fee expressed as ${sp.application_fee_percent}% of the charge, rounded down`);
}

console.log('Connect onboarding and refunds');
r = await post('/accounts', connectAccountParams({ organiser_id: U(2), email: 'owner@example.test', name: 'Demo Organiser' })); ok(r.status === 200, `Express account accepted (${r.status})`);
const pi = await post('/payment_intents', { ...op }); 
r = await post('/refunds', refundParams({ payment_intent: pi.body.id, amount_pence: 3000, refund_application_fee: true, request_id: U(9) })); ok(r.status === 200, `refund request accepted: reverse transfer and the fee refunded (${r.status})`);

console.log('paying a past-due membership through its existing subscription (R12)');
{ const g = await fetch(`${BASE}/subscriptions/sub_123?expand[]=latest_invoice.payment_intent`, { headers: { authorization: 'Bearer sk_test_123' } }); ok(g.status === 200, `retrieving the existing subscription with its open invoice is accepted by Stripe's spec (${g.status})`); }
console.log('ending a card membership at the provider (R10)');
const send = async (method, path, params) => { const r = await fetch(`${BASE}${path}`, { method, headers: { authorization: 'Bearer sk_test_123', 'content-type': 'application/x-www-form-urlencoded', 'stripe-version': '2023-10-16' }, body: formBody(params) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const stop = subscriptionCancelRequest('at_period_end', 'sub_123'); r = await send(stop.method, stop.path, stop.params); ok(r.status === 200, `stop-renewal request accepted by Stripe's spec (${r.status})`);
const end = subscriptionCancelRequest('now', 'sub_123'); r = await send(end.method, end.path, end.params); ok(r.status === 200, `end-now request accepted by Stripe's spec (${r.status})`);
r = await send('POST', '/subscriptions/sub_123', { cancel_at_period_end: 'maybe' }); ok(r.status === 400, `control: a malformed cancel is refused (${r.status})`);

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
