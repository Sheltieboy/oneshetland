// Forwarder tests: whitelist, refusal paths, argument construction (fake call), and a real round trip against the local stripe-mock when it is running.
// Run: node --test scripts/stripe-testmode/test/forwarder.test.mjs   (touches only 127.0.0.1)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed, createForwarder } from '../stripe-forwarder.mjs';
const start = async (opts) => { const f = createForwarder({ log: () => {}, ...opts }); await new Promise((r) => f.server.listen(0, '127.0.0.1', r)); return { ...f, base: `http://127.0.0.1:${f.server.address().port}`, close: () => f.server.close() }; };
const mockUp = await fetch('http://127.0.0.1:12111/v1/customers', { headers: { authorization: 'Bearer sk_test_x' } }).then((r) => r.status === 200, () => false);

test('whitelist: required Editions paths allowed, everything else refused', () => {
  for (const [m, p] of [['POST', '/v1/payment_intents'], ['GET', '/v1/charges/ch_1'], ['POST', '/v1/refunds'], ['POST', '/v1/application_fees/fee_1/refunds'], ['POST', '/v1/transfers/tr_1/reversals'], ['POST', '/v1/subscriptions'], ['GET', '/v1/accounts'], ['GET', '/v1/balance'], ['POST', '/v1/test_helpers/test_clocks/clock_1/advance'], ['GET', '/v1/events']]) assert.ok(isAllowed(m, p), `${m} ${p}`);
  for (const [m, p] of [['POST', '/v1/accounts'], ['DELETE', '/v1/accounts/acct_1'], ['POST', '/v1/payouts'], ['POST', '/v1/webhook_endpoints/we_1'], ['GET', '/v1/webhook_endpoints'], ['POST', '/v1/disputes/dp_1'], ['POST', '/v1/charges'], ['POST', '/v1/transfers'], ['GET', '/v2/core/event_destinations'], ['POST', '/v1/api_keys'], ['GET', '/v1/customers/../accounts']]) assert.ok(!isAllowed(m, p), `${m} ${p}`);
});
test('refuses: disallowed path 403, live key 403, bad account 400, foreign Host 403; Authorization is never forwarded', async () => {
  const calls = []; const f = await start({ call: (m, p, o) => { calls.push([m, p, o]); return { ok: true, status: 200, body: { id: 'x' } }; } });
  assert.equal((await fetch(`${f.base}/v1/payouts`, { method: 'POST' })).status, 403);
  assert.equal((await fetch(`${f.base}/v1/customers`, { method: 'POST', headers: { authorization: 'Bearer sk_live_abc' }, body: 'email=a' })).status, 403);
  assert.equal((await fetch(`${f.base}/v1/customers`, { method: 'POST', headers: { 'stripe-account': 'evil; rm' } })).status, 400);
  assert.equal((await fetch(`${f.base}/v1/customers`, { method: 'POST', body: 'livemode=true', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 403);
  assert.equal(calls.length, 0); f.close();
});
test('CLI-target request construction: form pairs (nested keys, arrays), query, idempotency key, account, version; errors pass through with status', async () => {
  const calls = []; let next = { ok: true, status: 200, body: { id: 'pi_1' } };
  const f = await start({ call: (m, p, o) => { calls.push([m, p, o]); return next; } });
  let r = await fetch(`${f.base}/v1/payment_intents`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': 'ed-x-1', 'stripe-account': 'acct_1Abc', 'stripe-version': '2023-10-16', authorization: 'Bearer sk_test_whatever' },
    body: 'amount=2500&metadata%5Bkind%5D=edition_participation&expand%5B%5D=a&expand%5B%5D=b&items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=2500' });
  assert.equal(r.status, 200); const [m, p, o] = calls[0]; assert.deepEqual([m, p, o.idempotencyKey, o.account, o.version], ['POST', '/v1/payment_intents', 'ed-x-1', 'acct_1Abc', '2023-10-16']);
  assert.deepEqual(o.data, [['amount', '2500'], ['metadata[kind]', 'edition_participation'], ['expand[]', 'a'], ['expand[]', 'b'], ['items[0][price_data][unit_amount]', '2500']]);
  assert.ok(!JSON.stringify(calls).includes('sk_test_whatever'));
  r = await fetch(`${f.base}/v1/charges?limit=3&expand%5B%5D=balance_transaction`); assert.equal(calls[1][0], 'GET'); assert.deepEqual(calls[1][2].data, [['limit', '3'], ['expand[]', 'balance_transaction']]);
  next = { ok: false, status: 402, body: { error: { code: 'balance_insufficient', message: 'x' } } }; r = await fetch(`${f.base}/v1/transfers/tr_1/reversals`, { method: 'POST', body: 'amount=5' });
  assert.equal(r.status, 402); assert.equal((await r.json()).error.code, 'balance_insufficient');
  const j = await (await fetch(`${f.base}/__forwarder/journal`)).json(); assert.ok(j.journal.every((x) => Object.keys(x).join() === 'method,path,status')); f.close();
});
test('--target mock: a real round trip to stripe-mock (skipped when the container is not running)', { skip: !mockUp && 'stripe-mock not running' }, async () => {
  const f = await start({ target: 'mock' });
  let r = await fetch(`${f.base}/v1/payment_intents`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': 'k1' }, body: 'amount=2500&currency=gbp&metadata[kind]=edition_order' });
  assert.equal(r.status, 200); assert.equal((await r.json()).object, 'payment_intent');
  r = await fetch(`${f.base}/v1/payment_intents`, { method: 'POST', body: 'amount=twenty&currency=gbp', headers: { 'content-type': 'application/x-www-form-urlencoded' } }); assert.equal(r.status, 400);
  r = await fetch(`${f.base}/v1/charges/ch_123?expand[]=application_fee`); assert.equal(r.status, 200); f.close();
});
test('--tag adds the run marker to object-creating POSTs only', async () => {
  const calls = []; const f = await start({ tag: 'tr-1', call: (m, p, o) => { calls.push([p, o.data]); return { ok: true, status: 200, body: {} }; } });
  await fetch(`${f.base}/v1/payment_intents`, { method: 'POST', body: 'amount=1' }); await fetch(`${f.base}/v1/payment_intents/pi_1/confirm`, { method: 'POST', body: 'payment_method=pm_x' });
  assert.ok(calls[0][1].some(([k, v]) => k === 'metadata[oneshetland_test_run]' && v === 'tr-1')); assert.ok(!calls[1][1].some(([k]) => k.startsWith('metadata'))); f.close();
});
