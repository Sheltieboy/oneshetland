// Pure unit tests (no network, no processes): CLI argument construction, the forwarder whitelist, endpoint classification and restoration diffing, and the fee arithmetic the scenarios compare against.
// Run through the safe runner: /Users/darrenfullerton/Claude/safe-test/run-safe.sh <worktree> scripts/stripe-testmode/test/pure.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripe, assertTestMode, PRODUCTION_HOST } from '../lib/stripe-cli.mjs';
import { isAllowed } from '../stripe-forwarder.mjs';
import { classify, diffEndpoint, hostOf } from '../webhook-guard.mjs';
import { feeParts, feePercent, stripePercentFee, commissionRefundedCumulative } from '../../../supabase/functions/_shared/editions-commerce-core.ts';

test('CLI argument construction (dry run): test mode, project default, --confirm on writes only, idempotency and account flags, nested keys', () => {
  const r = stripe('POST', '/v1/payment_intents', { data: [['amount', '2500'], ['metadata[k]', 'v'], ['expand[]', 'a']], idempotencyKey: 'k1', account: 'acct_1Abc', version: '2023-10-16', dryRun: true });
  assert.deepEqual(r.argv, ['stripe', 'post', '/v1/payment_intents', '-d', 'amount=2500', '-d', 'metadata[k]=v', '-d', 'expand[]=a', '-i', 'k1', '--stripe-account', 'acct_1Abc', '--stripe-version', '2023-10-16', '--confirm', '--project-name', 'default']);
  const g = stripe('GET', '/v1/charges', { query: [['limit', '3']], dryRun: true }); assert.ok(!g.argv.includes('--confirm') && g.argv.includes('--project-name') && !g.argv.includes('-i'));
  for (const a of [r.argv, g.argv]) assert.ok(!a.includes('--live') && !a.includes('--api-key'));
});
test('refuses bad methods, bad paths and live-looking arguments', () => {
  assert.throws(() => stripe('PUT', '/v1/x', { dryRun: true })); assert.throws(() => stripe('GET', 'v1/x', { dryRun: true })); assert.throws(() => stripe('GET', '/v1/x y', { dryRun: true }));
  assert.throws(() => stripe('GET', '/v1/x', { account: '--live', dryRun: true }), /forbidden/);
});
test('livemode true anywhere in a response is refused', () => { assert.throws(() => assertTestMode({ data: [{ a: { livemode: true } }] }), /livemode/); assertTestMode({ livemode: false, data: [] }); });
test('forwarder whitelist', () => { assert.ok(isAllowed('POST', '/v1/transfers/tr_1/reversals')); assert.ok(!isAllowed('POST', '/v1/payouts')); assert.ok(!isAllowed('DELETE', '/v1/accounts/acct_1')); assert.ok(!isAllowed('POST', '/v1/webhook_endpoints/we_1')); });
test('classification: the production host is never allowed; allow entries by id, host and url; restoration diff names every difference', () => {
  const prod = { id: 'we_1', url: `https://${PRODUCTION_HOST}/functions/v1/x` };
  assert.equal(classify(prod, [`we_1`, `host:${PRODUCTION_HOST}`]), 'PRODUCTION'); assert.equal(classify({ id: 'we_2', url: 'http://127.0.0.1:1/h' }, ['host:127.0.0.1:1']), 'ALLOWED'); assert.equal(classify({ id: 'we_3', url: 'https://example.org' }, []), 'OTHER');
  assert.equal(hostOf('http://127.0.0.1:54/x'), '127.0.0.1:54');
  const o = { status: 'enabled', url: 'u', enabled_events: ['a', 'b'], api_version: 'v', description: 'd', metadata: { x: '1', y: '2' }, connect: false };
  assert.deepEqual(diffEndpoint(o, { ...o, enabled_events: ['b', 'a'], metadata: { y: '2', x: '1' } }), []);
  assert.equal(diffEndpoint(o, { ...o, status: 'disabled', url: 'z', connect: true }).length, 3);
});
test('the arithmetic the scenarios compare against (2% commission + 1.5% + 20p recovery; exact percentage for subscriptions)', () => {
  const CFG = { commission_percent: 2, commission_fixed_pence: 0, commission_min_pence: 0, commission_cap_pence: null, stripe_cost_percent: 1.5, stripe_cost_fixed_pence: 20 };
  assert.deepEqual(feeParts(10000, CFG), { commission: 200, recovery: 170, fee: 370, recovery_reduced: false }); assert.equal(feeParts(2500, CFG).fee, 108);
  assert.equal(feePercent(895, 25000), 3.58); assert.equal(stripePercentFee(25000, 3.58, 'floor'), 895); assert.equal(commissionRefundedCumulative(200, 3000, 10000), 60); assert.equal(commissionRefundedCumulative(200, 10000, 10000), 200);
});
