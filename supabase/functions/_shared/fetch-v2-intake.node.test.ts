/**
 * fetch-v2-intake.node.test.ts — the pieces of the Fetch v2 quote/create boundary that need no database: the server geocoder, the
 * read-only card check and the way a quote is explained. (The handlers themselves run against real SQL in
 * supabase/tests/fetch-v2-pricing-terms.node.test.ts.)
 *
 * A fake fetch and fake Stripe lookups only. No network. Run: node --test supabase/functions/_shared/fetch-v2-intake.node.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { googleGeocoder, GeocodeUnavailable, type FetchLike } from './fetch-v2-geocode.ts';
import { makeCardCheck, shapeQuote } from './fetch-v2-intake.ts';

const KEY = 'AIza-SERVER-KEY-DO-NOT-LEAK';
const fake = (status: number, body: unknown, seen: string[] = []): FetchLike => async (u) => { seen.push(u); return { ok: status < 400, status, json: async () => body }; };
const ok = (lat: number, lng: number) => ({ status: 'OK', results: [{ geometry: { location: { lat, lng } } }] });

describe('googleGeocoder', () => {
  test('resolves a place_id the client picked — as a reference, by the server', async () => {
    const seen: string[] = [];
    assert.deepEqual(await googleGeocoder(KEY, fake(200, ok(60.6, -1.06), seen))({ place_id: 'ChIJabcdefghij' }), { lat: 60.6, lng: -1.06 });
    const u = new URL(seen[0]);
    assert.equal(u.searchParams.get('place_id'), 'ChIJabcdefghij');
    assert.equal(u.searchParams.get('key'), KEY);
  });
  test('free text is restricted to Great Britain', async () => {
    const seen: string[] = [];
    await googleGeocoder(KEY, fake(200, ok(60.1, -1.1), seen))({ address: '12 Hillhead, Lerwick' });
    assert.equal(new URL(seen[0]).searchParams.get('components'), 'country:GB');
  });
  test('"cannot place this" is null (the caller says location_unresolved); a malformed answer is null too', async () => {
    for (const body of [{ status: 'ZERO_RESULTS', results: [] }, { status: 'NOT_FOUND' }, { status: 'INVALID_REQUEST' },
      { status: 'OK', results: [] }, { status: 'OK', results: [{ geometry: { location: { lat: 'x', lng: 1 } } }] }])
      assert.equal(await googleGeocoder(KEY, fake(200, body))({ address: 'Nowhere' }), null, JSON.stringify(body));
  });
  test('"cannot ask" throws GeocodeUnavailable — and the key is never in the error', async () => {
    const cases: [FetchLike, string][] = [
      [fake(200, { status: 'OVER_QUERY_LIMIT', error_message: `quota for ${KEY}` }), 'over_query_limit'],
      [fake(200, { status: 'REQUEST_DENIED', error_message: `The provided API key ${KEY} is invalid` }), 'request_denied'],
      [fake(500, {}), 'http_500'],
      [async () => { throw new Error(`socket hang up ${KEY}`); }, 'network'],
    ];
    for (const [f, reason] of cases) {
      await assert.rejects(googleGeocoder(KEY, f)({ address: 'Lerwick' }), (e: unknown) => {
        assert.ok(e instanceof GeocodeUnavailable); assert.equal(e.reason, reason);
        assert.ok(!String(e.message).includes(KEY)); return true;
      });
    }
    await assert.rejects(googleGeocoder('', fake(200, ok(1, 1)))({ address: 'Lerwick' }), /not_configured/);
  });
});

describe('makeCardCheck (read-only)', () => {
  const check = (customer: string | null | Error, card: string | null | Error) => makeCardCheck({
    customerIdFor: async () => { if (customer instanceof Error) throw customer; return customer; },
    chargeableCard: async () => { if (card instanceof Error) throw card; return card; },
  })('user');
  test('no Stripe Customer yet, or no chargeable card: payment_method_required', async () => {
    assert.equal(await check(null, null), 'payment_method_required');
    assert.equal(await check('cus_1', null), 'payment_method_required');
  });
  test('a chargeable card: eligible', async () => assert.equal(await check('cus_1', 'pm_1'), 'eligible'));
  test('Stripe or the profile cannot be asked: card_check_failed — never "no card", never the error text', async () => {
    assert.equal(await check('cus_1', new Error('sk_live_SECRET Stripe payment_methods list failed')), 'card_check_failed');
    assert.equal(await check(new Error('profile lookup failed'), 'pm_1'), 'card_check_failed');
  });
});

describe('shapeQuote', () => {
  const t = { delivery_fee_pence: 910, ferry_supplement_pence: 200, service_fee_pence: 150, total_pence: 1260, waiting_max_pence: 600,
    return_max_pence: 910, max_hold_pence: 2770, ferry_required: true, min_fee_applied_pence: null, size_class: 'small', road_miles: 14, pricing_version: 'fetch_v2_p0' };
  test('separates the driver payment, the ferry supplement and the service fee; the expected total is not the hold', () => {
    const q = shapeQuote(t);
    assert.deepEqual([q.driver_delivery_pence, q.ferry_supplement_pence, q.service_fee_pence, q.expected_total_pence, q.max_authorisation_pence],
      [910, 200, 150, 1260, 2770]);
    assert.deepEqual(q.authorisation_breakdown, { expected_total_pence: 1260, waiting_max_pence: 600, return_max_pence: 910 });
  });
  test('the explanation says what will be charged, what is only held, and why', () => {
    const e = shapeQuote(t).explanation;
    assert.match(e, /You'll pay £12\.60 if the delivery goes as planned/);
    assert.match(e, /temporarily held for up to £27\.70/);
    assert.match(e, /up to £6\.00 if the driver has to wait/);
    assert.match(e, /up to £9\.10 only if the item has to be brought back/);
    assert.match(e, /only charged for what actually happens/);
  });
  test('accepts the frozen-terms row shape too (wait_max_pence)', () => {
    const { waiting_max_pence: _w, ...rest } = t;
    assert.equal(shapeQuote({ ...rest, wait_max_pence: 600 }).authorisation_breakdown.waiting_max_pence, 600);
  });
});
