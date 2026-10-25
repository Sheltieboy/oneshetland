/**
 * fetch-v2-stripe.node.test.ts — the Fetch v2 Stripe gateway and the webhook scope test, with a fake fetch. No network.
 * Run: node --test supabase/functions/_shared/fetch-v2-stripe.node.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { stripeGateway, toIntent, StripeDeclined, StripeRejected, StripeUnavailable, type FetchLike } from './fetch-v2-stripe.ts';
import { isFetchV2Intent } from './fetch-v2-payments.ts';

const SECRET = 'sk_test_DO_NOT_LEAK';
type Seen = { url: string; method: string; headers: Record<string, string>; body?: string };
const fake = (status: number, body: unknown, seen: Seen[] = []): FetchLike => async (url, init) => { seen.push({ url, ...init }); return { ok: status < 400, status, json: async () => body }; };
const intent = { id: 'pi_1', status: 'requires_capture', amount: 2770, amount_capturable: 2770, amount_received: 0, client_secret: 'pi_1_secret_x',
  metadata: { fetch_v2_request_id: '20000000-0000-4000-8000-000000000001' },
  latest_charge: { id: 'ch_1', payment_method_details: { card: { capture_before: 1800000000 } } } };

describe('createHold', () => {
  test('a manual-capture destination charge: frozen amount, driver account, service fee as the application fee, idempotent, deadline expanded', async () => {
    const seen: Seen[] = [];
    await stripeGateway(SECRET, fake(200, intent, seen)).createHold({ amount: 2770, customer: 'cus_1', paymentMethod: 'pm_1', destination: 'acct_D',
      applicationFee: 150, metadata: { fetch_v2_request_id: 'r', fetch_v2_generation: '2' }, description: 'd', idempotencyKey: 'fetch-auth-r-g2' });
    const p = new URLSearchParams(seen[0].body);
    assert.equal(seen[0].url, 'https://api.stripe.com/v1/payment_intents');
    assert.deepEqual([p.get('amount'), p.get('currency'), p.get('capture_method'), p.get('transfer_data[destination]'), p.get('application_fee_amount'),
      p.get('payment_method'), p.get('confirm'), p.get('expand[0]'), p.get('metadata[fetch_v2_generation]'), p.get('automatic_payment_methods[allow_redirects]')],
      ['2770', 'gbp', 'manual', 'acct_D', '150', 'pm_1', 'true', 'latest_charge', '2', 'never']);
    assert.equal(seen[0].headers['Idempotency-Key'], 'fetch-auth-r-g2');
    assert.equal(p.get('metadata[request_id]'), null, 'never the v1 key, so v1 webhook branches cannot touch it');
  });
  test('without a card the intent is created unconfirmed (the requester completes it)', async () => {
    const seen: Seen[] = [];
    await stripeGateway(SECRET, fake(200, intent, seen)).createHold({ amount: 1, customer: 'c', paymentMethod: null, destination: 'a', applicationFee: 0, metadata: {}, description: 'd', idempotencyKey: 'k' });
    const p = new URLSearchParams(seen[0].body);
    assert.equal(`${p.get('payment_method')}:${p.get('confirm')}`, 'null:null');
  });
});

describe('capture, cancel, retrieve', () => {
  test('capture takes an explicit amount and application fee with a key; cancel has a key; retrieve expands the charge', async () => {
    const seen: Seen[] = [];
    const g = stripeGateway(SECRET, fake(200, intent, seen));
    await g.capture('pi_1', 1260, 150, 'fetch-v2-capture-pi_1');
    await g.cancel('pi_1', 'fetch-v2-void-pi_1');
    await g.retrieve('pi_1');
    assert.match(seen[0].url, /\/pi_1\/capture$/);
    assert.deepEqual([new URLSearchParams(seen[0].body).get('amount_to_capture'), new URLSearchParams(seen[0].body).get('application_fee_amount')], ['1260', '150']);
    assert.equal(seen[0].headers['Idempotency-Key'], 'fetch-v2-capture-pi_1');
    assert.equal(seen[1].headers['Idempotency-Key'], 'fetch-v2-void-pi_1');
    assert.match(seen[2].url, /\/pi_1\?expand%5B0%5D=latest_charge$/);
  });
  test('Stripe\'s own capture deadline is read from the charge — never guessed', () => {
    assert.equal(toIntent(intent).capture_before, 1800000000);
    assert.equal(toIntent({ ...intent, latest_charge: 'ch_1' }).capture_before, null);
  });
});

describe('errors are typed and never carry the key', () => {
  const g = (status: number, body: unknown) => stripeGateway(SECRET, fake(status, body));
  test('card_error → StripeDeclined, with the intent Stripe left behind', async () => {
    await assert.rejects(g(402, { error: { type: 'card_error', code: 'authentication_required', payment_intent: { ...intent, status: 'requires_payment_method' } } }).retrieve('pi_1'),
      (e: unknown) => e instanceof StripeDeclined && e.code === 'authentication_required' && e.intent?.status === 'requires_payment_method');
  });
  test('5xx, 429 and network failure → StripeUnavailable (retry with the same key)', async () => {
    for (const s of [500, 503, 429]) await assert.rejects(g(s, {}).retrieve('pi_1'), StripeUnavailable);
    await assert.rejects(stripeGateway(SECRET, async () => { throw new Error(`ECONNRESET ${SECRET}`); }).retrieve('pi_1'), (e: unknown) => e instanceof StripeUnavailable && !String((e as Error).message).includes(SECRET));
    await assert.rejects(stripeGateway('', fake(200, intent)).retrieve('pi_1'), /not_configured/);
  });
  test('other 4xx → StripeRejected', async () => {
    await assert.rejects(g(400, { error: { type: 'invalid_request_error', code: 'amount_too_large', message: `bad ${SECRET}` } }).capture('pi_1', 1, 0, 'k'),
      (e: unknown) => e instanceof StripeRejected && e.code === 'amount_too_large' && !String((e as Error).message).includes(SECRET));
  });
});

describe('webhook scope', () => {
  test('only a PaymentIntent carrying a Fetch v2 job id is a Fetch v2 event', () => {
    assert.equal(isFetchV2Intent('payment_intent.succeeded', { object: 'payment_intent', metadata: { fetch_v2_request_id: '20000000-0000-4000-8000-000000000001' } }), true);
    for (const [t, o] of [
      ['payment_intent.succeeded', { object: 'payment_intent', metadata: { request_id: '20000000-0000-4000-8000-000000000001' } }],   // v1 Fetch
      ['payment_intent.succeeded', { object: 'payment_intent', metadata: { boost_id: 'b' } }],
      ['payment_intent.succeeded', { object: 'payment_intent', metadata: { fetch_v2_request_id: 'not-a-uuid' } }],
      ['charge.refunded', { object: 'charge', metadata: { fetch_v2_request_id: '20000000-0000-4000-8000-000000000001' } }],
    ] as [string, Record<string, unknown>][]) assert.equal(isFetchV2Intent(t, o), false, JSON.stringify(o));
  });
});
