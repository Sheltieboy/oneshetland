/**
 * fetch-v2-push-gateway.node.test.ts — the production Expo gateway for the Fetch v2 outbox, with a fake fetch and a fake
 * database client. No network. Run: node --test supabase/functions/_shared/fetch-v2-push-gateway.node.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expoPushGateway } from './fetch-v2-push-gateway.ts';
import { pushOne, type PushGateway } from './fetch-v2-notify.ts';

const db = (tokens: string[], legacy: string | null) => {
  const calls: string[] = [];
  const chain = (table: string) => ({
    select: () => ({ eq: () => (table === 'push_tokens' ? Promise.resolve({ data: tokens.map((token) => ({ token })) })
      : { maybeSingle: () => Promise.resolve({ data: { push_token: legacy } }) }) }),
    delete: () => ({ eq: (_c: string, v: string) => { calls.push(`delete ${table} ${v}`); return Promise.resolve({}); } }),
    update: () => ({ eq: () => ({ eq: (_c: string, v: string) => { calls.push(`clear ${table} ${v}`); return Promise.resolve({}); } }) }),
  });
  // deno-lint-ignore no-explicit-any
  return { svc: { from: chain } as any, calls };
};
const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
const msg = { title: 't', body: 'b', data: { route: '/fetch/jobs/x' }, categoryId: 'fetch.collected' };

test('tokens: push_tokens plus the legacy profile token, Expo tokens only, de-duplicated', async () => {
  const { svc } = db(['ExponentPushToken[a]', 'not-a-token', 'ExponentPushToken[a]'], 'ExponentPushToken[b]');
  assert.deepEqual((await expoPushGateway(svc).tokens('u')).sort(), ['ExponentPushToken[a]', 'ExponentPushToken[b]']);
});
test('an Expo ticket is "accepted"; the body carries title, text, data and the category, nothing else', async () => {
  let sent: Record<string, unknown> = {};
  const f = (async (_u: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return new Response(JSON.stringify({ data: { status: 'ok', id: 'x' } })); }) as typeof fetch;
  assert.deepEqual(await expoPushGateway(db([], null).svc, f).send('ExponentPushToken[a]', msg), { ok: true });
  assert.deepEqual(Object.keys(sent).sort(), ['_category', 'body', 'categoryId', 'data', 'sound', 'title', 'to']);
});
test('errors are classified: dead device, retryable, push not configured (e.g. Android), rejected', async () => {
  const g = (s: number, b: unknown) => expoPushGateway(db([], null).svc, reply(s, b));
  const t = 'ExponentPushToken[a]';
  assert.equal(((await g(200, { data: { status: 'error', details: { error: 'DeviceNotRegistered' } } }).send(t, msg)) as { reason: string }).reason, 'device_not_registered');
  assert.equal(((await g(200, { data: { status: 'error', details: { error: 'MessageRateExceeded' } } }).send(t, msg)) as { reason: string }).reason, 'retryable');
  assert.equal(((await g(503, {}).send(t, msg)) as { reason: string }).reason, 'retryable');
  assert.equal(((await g(200, { data: { status: 'error', details: { error: 'InvalidCredentials' } } }).send(t, msg)) as { reason: string }).reason, 'unavailable');
  assert.equal(((await g(200, { data: { status: 'error', details: { error: 'MessageTooBig' } } }).send(t, msg)) as { reason: string }).reason, 'rejected');
  const thrown = expoPushGateway(db([], null).svc, (async () => { throw new Error('ECONNRESET'); }) as typeof fetch);
  assert.equal(((await thrown.send(t, msg)) as { reason: string }).reason, 'retryable');
});
test('pruning removes a dead token from both stores', async () => {
  const { svc, calls } = db([], null);
  await expoPushGateway(svc).prune('u', 'ExponentPushToken[dead]');
  assert.deepEqual(calls, ['delete push_tokens ExponentPushToken[dead]', 'clear profiles ExponentPushToken[dead]']);
});
test('outcome across several devices: any accepted wins; otherwise the most actionable reason', async () => {
  const gw = (modes: string[]): PushGateway => ({
    tokens: async () => modes.map((_, i) => `t${i}`),
    send: async (tok) => { const m = modes[Number(tok.slice(1))]; return m === 'ok' ? { ok: true } : { ok: false, reason: m as never, error: m }; },
    prune: async () => {},
  });
  const n = { notification_id: 1, recipient_id: 'u', category: 'fetch.collected', title: 't', body: 'b', data: {} };
  assert.equal((await pushOne(gw(['device_not_registered', 'ok']), n)).result, 'accepted');
  assert.equal((await pushOne(gw(['device_not_registered', 'retryable']), n)).result, 'provider_error_retryable');
  assert.equal((await pushOne(gw(['device_not_registered', 'device_not_registered']), n)).result, 'invalid_token');
  assert.equal((await pushOne(gw(['unavailable']), n)).result, 'push_unavailable');
  assert.equal((await pushOne(gw(['rejected', 'unavailable']), n)).result, 'provider_error');
  assert.equal((await pushOne(gw([]), n)).result, 'no_token');
});
