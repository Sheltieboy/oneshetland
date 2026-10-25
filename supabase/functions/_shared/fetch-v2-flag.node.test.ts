/**
 * fetch-v2-flag.node.test.ts — the edge-function side of the Fetch v2 flag fails closed.
 *
 * The database decides (fetch-v2-flag.node.test.ts in supabase/tests proves the SQL); this proves the TypeScript wrapper turns
 * anything other than a literal `true` into a 403 and never lets a database error through as "allowed".
 *
 * A stub service client only. No database, no network.
 * Run (only this file):  node --test supabase/functions/_shared/fetch-v2-flag.node.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchV2Enabled, fetchV2Gate, FETCH_V2_UNAVAILABLE } from './fetch-v2-flag.ts';

const USER = '0d38887b-8e0f-4aa6-b5c3-3a41abb38fd6';

const svcReturning = (result: unknown, calls: unknown[] = []) => ({
  rpc: (name: string, args: unknown) => { calls.push({ name, args }); return Promise.resolve(result); },
});

describe('fetchV2Enabled', () => {
  test('asks fetch_v2_enabled_for for exactly the given user', async () => {
    const calls: unknown[] = [];
    await fetchV2Enabled(svcReturning({ data: true, error: null }, calls), USER);
    assert.deepEqual(calls, [{ name: 'fetch_v2_enabled_for', args: { p_user: USER } }]);
  });
  test('true only for a literal true', async () => {
    assert.equal(await fetchV2Enabled(svcReturning({ data: true, error: null }), USER), true);
    for (const data of [false, null, undefined, 'true', 1, {}]) {
      assert.equal(await fetchV2Enabled(svcReturning({ data, error: null }), USER), false, `data=${JSON.stringify(data)}`);
    }
  });
  test('a database error is a refusal, even if data claims true', async () => {
    assert.equal(await fetchV2Enabled(svcReturning({ data: true, error: { message: 'boom' } }), USER), false);
  });
  test('a thrown client is a refusal', async () => {
    const svc = { rpc: () => { throw new Error('network'); } };
    assert.equal(await fetchV2Enabled(svc, USER), false);
    const rejecting = { rpc: () => Promise.reject(new Error('network')) };
    assert.equal(await fetchV2Enabled(rejecting, USER), false);
  });
  test('a signed-out caller is still asked (null), so "everyone" can be honoured by the database', async () => {
    const calls: unknown[] = [];
    await fetchV2Enabled(svcReturning({ data: false, error: null }, calls), null);
    assert.deepEqual(calls, [{ name: 'fetch_v2_enabled_for', args: { p_user: null } }]);
  });
});

describe('fetchV2Gate', () => {
  test('ok when enabled', async () => {
    assert.deepEqual(await fetchV2Gate(svcReturning({ data: true, error: null }), { userId: USER }), { ok: true });
  });
  test('403 with the fixed message when not', async () => {
    assert.deepEqual(await fetchV2Gate(svcReturning({ data: false, error: null }), { userId: USER }),
      { ok: false, status: 403, error: FETCH_V2_UNAVAILABLE });
  });
});
