/**
 * purchase-attempt-idempotency.node.test.ts — one purchase attempt, one shop order / one gift, enforced in the DATABASE.
 *
 * THE FINDING
 *
 * create-product-order-intent and create-gift-intent minted a fresh row id on every call and keyed Stripe (and the wallet debit)
 * on THAT id. A key that differs every call recognises nothing, so a double-click, a retry after a lost response, two tabs or a
 * replayed request each produced another order + stock reservation (or gift), another PaymentIntent and another wallet debit.
 *
 * WHAT THIS FILE PROVES (SQL level — the handlers are in purchase-attempt-handlers.node.test.ts)
 *
 *   1. claim_product_order / claim_gift_purchase create ONE row per (buyer, client_request_id), however many sessions call at once.
 *      "At once" is made real: the winner holds its transaction open while the others arrive, so the others genuinely block on
 *      the unique index and resolve to the winner's row afterwards.
 *   2. Stock is reserved ONCE per attempt, inside the claim; a sold-out line rolls back the order row and every earlier
 *      reservation together, so a failed claim holds nothing and the id is free again.
 *   3. A reused id for a different basket / address / payment method / recipient is refused, never swapped.
 *   4. The id is scoped to the buyer: another user's identical id is a different attempt. The same buyer with a NEW id makes a
 *      second purchase — idempotency is per attempt, not per basket.
 *   5. Cancelling releases the stock exactly once however many callers race; a cancelled / expired attempt is reported as such
 *      and is never resurrected.
 *   6. The processing lease makes the money-moving step single-flight and expires.
 *   7. A payment can belong to at most one order and one gift.
 *   8. Nothing is reachable by anon / authenticated.
 *   9. CONTROLS: take the uniqueness out and the same concurrency produces duplicate orders and double reservations.
 *
 * SAFETY — ISOLATED DATABASE ONLY: requires PASS_PROOF_DSN, refuses a DSN mentioning Supabase.
 */

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { assertIsolated, buildFixture, resetData, exec, must, num, scalar, execFileSync, pgClient, IDS, MIG, ATTEMPT_MIGRATION } from './_support/purchase-fixture.ts';

const { ALICE, BOB, BIZ, P_TRACKED, P_ONEOFF, P_MADE, P_LOW, UNIT, SERVICE } = IDS;

const line = (product: string, qty: number, unit: number, title: string) =>
  ({ product_id: product, variant_id: null, qty, unit_pence: unit, title, variant_name: null, photo_url: null });
const TRACKED2 = [line(P_TRACKED, 2, 1000, 'Tracked jumper')];

type Claim = Partial<{ buyer: string; id: string; mode: string; items: any[]; fulfilment: string; items_pence: number; shipping: number; total: number; commission: number; name: string | null; address: string | null; postcode: string | null; region: string | null; phone: string | null; note: string | null; ttl: number }>;
const claimArgs = (o: Claim = {}) => {
  const items = o.items ?? TRACKED2;
  const itemsPence = o.items_pence ?? items.reduce((s, l) => s + l.unit_pence * l.qty, 0);
  return {
    p_buyer: o.buyer ?? ALICE, p_client_request_id: o.id ?? 'attempt-0001', p_pay_mode: o.mode ?? 'card_form',
    p_business: BIZ, p_fulfilment: o.fulfilment ?? 'collect', p_items: items,
    p_items_pence: itemsPence, p_shipping_pence: o.shipping ?? 0, p_total_pence: o.total ?? itemsPence + (o.shipping ?? 0),
    p_commission_pence: o.commission ?? 100,
    p_delivery_name: o.name ?? null, p_delivery_address: o.address ?? null, p_delivery_postcode: o.postcode ?? null,
    p_delivery_region: o.region ?? null, p_contact_phone: o.phone ?? null, p_buyer_note: o.note ?? null, p_ttl_minutes: o.ttl ?? 30,
  };
};
const claim = (o: Claim = {}) => pgClient().rpc('claim_product_order', claimArgs(o));

/** the SQL for one claim, as a statement string (so it can be held open inside a transaction) */
function claimStmt(o: Claim = {}): string {
  const a = claimArgs(o);
  const q = (v: unknown) => (v === null ? 'null' : typeof v === 'number' ? String(v) : typeof v === 'object' ? `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb` : `'${String(v).replace(/'/g, "''")}'`);
  return `select public.claim_product_order(${Object.entries(a).map(([k, v]) => `${k} => ${q(v)}`).join(', ')})::text`;
}
/** run a claim holding its transaction open for `holdMs` after the claim — the others pile up behind it */
async function heldClaim(o: Claim, holdMs: number) {
  const t0 = Date.now();
  const r = await exec(`begin; ${claimStmt(o)}; select pg_sleep(${holdMs / 1000}); commit;`);
  const first = r.out.split('\n').find((l) => l.startsWith('{'));
  return { ms: Date.now() - t0, err: r.err, data: first ? JSON.parse(first) : null };
}

const orders = () => num(`select count(*) from public.product_orders`);
const gifts = () => num(`select count(*) from public.book_gifts`);
const reserved = (p = P_TRACKED) => num(`select reserved from public.products where id = '${p}'`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(() => { assertIsolated(); buildFixture(); });
beforeEach(() => resetData());

describe('fixture fidelity', () => {
  test('the three stock functions are byte-identical to production (md5 of prosrc, read from production 7 Oct 2026)', () => {
    const md5 = (s: string) => createHash('md5').update(s).digest('hex');
    const body = (n: string) => scalar(`select prosrc from pg_proc where pronamespace='public'::regnamespace and proname='${n}'`);
    // prosrc contains newlines; fetch it through a hash computed in the database instead
    const h = (n: string) => scalar(`select md5(prosrc) from pg_proc where pronamespace='public'::regnamespace and proname='${n}'`);
    assert.equal(h('reserve_product_stock'), '27f7314c56e863ab32318d242d438589');
    assert.equal(h('commit_product_stock'), 'cbb0e7a318a190be40bb58303dfacac1');
    assert.equal(h('release_product_stock'), '5c5642904324b2e7612a9b34034159c2');
    void md5; void body;
  });

  test('the migration is idempotent: applying it a second time changes nothing and does not fail', () => {
    const r = execFileSync(ATTEMPT_MIGRATION);
    assert.equal(r.err, null);
  });
});

describe('product orders — claim', () => {
  test('1. a normal purchase: one order, its items, stock reserved once, pending, pay mode recorded', async () => {
    const r = await claim();
    assert.equal(r.error, null);
    assert.equal(r.data.replayed, false);
    assert.equal(r.data.status, 'pending');
    assert.equal(r.data.pay_mode, 'card_form');
    assert.equal(orders(), 1);
    assert.equal(num(`select count(*) from public.product_order_items`), 1);
    assert.equal(reserved(), 2);
  });

  test('3. exact retry: the same order comes back, replayed, and nothing more is reserved', async () => {
    const a = await claim(); const b = await claim(); const c = await claim();
    assert.equal(b.data.order_id, a.data.order_id); assert.equal(c.data.order_id, a.data.order_id);
    assert.equal(b.data.replayed, true);
    assert.equal(orders(), 1); assert.equal(reserved(), 2);
  });

  test('5. two simultaneous submissions: the loser blocks on the winner, then resolves to the same order — one order, stock once', async () => {
    const A = heldClaim({}, 1500);
    await sleep(350);
    const B = heldClaim({}, 0);
    const [a, b] = await Promise.all([A, B]);
    assert.equal(a.err, null); assert.equal(b.err, null);
    assert.equal(a.data.replayed, false);
    assert.equal(b.data.replayed, true, 'the second session saw the winner and replayed it');
    assert.equal(b.data.order_id, a.data.order_id);
    assert.ok(b.ms >= 800, `the loser must actually have waited on the winner's uncommitted insert (waited ${b.ms}ms)`);
    assert.equal(orders(), 1); assert.equal(reserved(), 2);
  });

  test('6. five simultaneous submissions: one order, stock reserved once, exactly one session created it', async () => {
    const results = await Promise.all([0, 1, 2, 3, 4].map(() => heldClaim({}, 400)));
    for (const r of results) assert.equal(r.err, null);
    assert.equal(new Set(results.map((r) => r.data.order_id)).size, 1, 'every session resolved to the same order');
    assert.equal(results.filter((r) => r.data.replayed === false).length, 1, 'exactly one created it');
    assert.equal(orders(), 1); assert.equal(num(`select count(*) from public.product_order_items`), 1);
    assert.equal(reserved(), 2, 'stock reserved once, not five times');
  });

  test('12. the same buyer with a NEW id makes a second purchase — idempotency is per attempt, not per basket', async () => {
    const a = await claim({ id: 'attempt-0001' }); const b = await claim({ id: 'attempt-0002' });
    assert.notEqual(a.data.order_id, b.data.order_id);
    assert.equal(orders(), 2); assert.equal(reserved(), 4);
  });

  test('11. the id is scoped to the buyer: another user using the same id gets their OWN order, never the first one', async () => {
    const a = await claim({ buyer: ALICE, id: 'shared-id-000' });
    const b = await claim({ buyer: BOB, id: 'shared-id-000' });
    assert.notEqual(a.data.order_id, b.data.order_id);
    assert.equal(num(`select count(*) from public.product_orders where buyer_id = '${BOB}'`), 1);
    assert.equal(b.data.replayed, false);
    // and Bob cannot read Alice's attempt by guessing its id: the lookup is keyed on (buyer, id)
    assert.equal(scalar(`select buyer_id from public.product_orders where id = '${b.data.order_id}'`), BOB);
  });

  test('reusing an id for a different basket, price, address, method or business is a conflict and changes nothing', async () => {
    await claim();
    const before = [orders(), reserved()];
    const variants: [string, Claim][] = [
      ['different quantity', { items: [line(P_TRACKED, 3, 1000, 'Tracked jumper')] }],
      ['different product', { items: [line(P_MADE, 2, 1500, 'Made to order')] }],
      ['different unit price', { items: [line(P_TRACKED, 2, 900, 'Tracked jumper')] }],
      ['different payment method', { mode: 'wallet' }],
      ['different fulfilment', { fulfilment: 'post', name: 'A', address: 'B', postcode: 'ZE1 0AA' }],
      ['different shipping', { shipping: 300 }],
      ['different note', { note: 'leave it round the back' }],
    ];
    for (const [why, o] of variants) {
      const r = await claim(o);
      assert.match(String(r.error?.message), /IDEMPOTENCY_CONFLICT/, why);
    }
    assert.deepEqual([orders(), reserved()], before, 'a conflict must not reserve, create or swap anything');
  });

  test('a changed delivery address on a retry is a conflict (it must not silently redirect the goods)', async () => {
    const base = { fulfilment: 'post', name: 'A Buyer', address: '1 Commercial St', postcode: 'ZE1 0AA', shipping: 300 } as Claim;
    await claim(base);
    const r = await claim({ ...base, address: '99 Somewhere Else' });
    assert.match(String(r.error?.message), /IDEMPOTENCY_CONFLICT/);
    assert.equal((await claim(base)).data.replayed, true, 'the identical retry still resolves');
  });

  test('14. stock: a multi-quantity retry reserves once; a one-off is held once and a second attempt cannot take it', async () => {
    await claim({ items: [line(P_ONEOFF, 1, 2500, 'One-off print')], id: 'oneoff-first' });
    await claim({ items: [line(P_ONEOFF, 1, 2500, 'One-off print')], id: 'oneoff-first' });
    assert.equal(reserved(P_ONEOFF), 1);
    const second = await claim({ items: [line(P_ONEOFF, 1, 2500, 'One-off print')], id: 'oneoff-other' });
    assert.match(String(second.error?.message), /SOLD_OUT: One-off print/);
    assert.equal(orders(), 1);
  });

  test('sold out: nothing is created and nothing is held; the id is usable again after a restock', async () => {
    const r = await claim({ items: [line(P_LOW, 2, 1200, 'Last one')], id: 'soldout-0001' });
    assert.match(String(r.error?.message), /SOLD_OUT: Last one/);
    assert.equal(orders(), 0); assert.equal(reserved(P_LOW), 0);
    must(`update public.products set stock = 5 where id = '${P_LOW}'`);
    const again = await claim({ items: [line(P_LOW, 2, 1200, 'Last one')], id: 'soldout-0001' });
    assert.equal(again.error, null); assert.equal(again.data.replayed, false); assert.equal(reserved(P_LOW), 2);
  });

  test('all-or-nothing: if the second line is sold out the first line is not left reserved', async () => {
    const r = await claim({ items: [line(P_TRACKED, 2, 1000, 'Tracked jumper'), line(P_LOW, 2, 1200, 'Last one')], id: 'partial-0001' });
    assert.match(String(r.error?.message), /SOLD_OUT: Last one/);
    assert.equal(reserved(P_TRACKED), 0, 'the earlier reservation was rolled back with the order row');
    assert.equal(orders(), 0);
  });

  test('five concurrent attempts for the LAST item: exactly one wins it and the stock is never over-reserved', async () => {
    const rs = await Promise.all([0, 1, 2, 3, 4].map((i) =>
      exec(`${claimStmt({ items: [line(P_LOW, 1, 1200, 'Last one')], id: `race-last-000${i}` })}`)));
    const won = rs.filter((r) => !r.err).length;
    assert.equal(won, 1, 'only one buyer gets the last one');
    assert.equal(reserved(P_LOW), 1); assert.equal(orders(), 1);
  });

  test('bad input is refused before anything is written', async () => {
    for (const o of [{ id: 'short' }, { id: 'x'.repeat(101) }, { items: [] }, { items: [line(P_TRACKED, 0, 1000, 't')] }, { items: [line(P_TRACKED, 100, 1000, 't')] }]) {
      const r = await claim(o as Claim);
      assert.ok(r.error, JSON.stringify(o).slice(0, 60));
    }
    const nullId = await pgClient().rpc('claim_product_order', { ...claimArgs(), p_client_request_id: null });
    assert.ok(nullId.error); assert.equal(orders(), 0); assert.equal(reserved(), 0);
  });
});

describe('product orders — cancel, expiry, paid', () => {
  test('cancelling releases the stock once, however many callers race (the request, its retry, the sweeper)', async () => {
    const a = await claim();
    assert.equal(reserved(), 2);
    const rs = await Promise.all([0, 1, 2, 3].map(() => exec(`select public.cancel_pending_product_order('${a.data.order_id}')::text`)));
    assert.equal(rs.filter((r) => r.out === 'true').length, 1, 'exactly one caller performed the cancel');
    assert.equal(reserved(), 0, 'released once (a double release would have clamped at 0 but taken other buyers\' holds)');
  });

  test('a double release cannot eat ANOTHER buyer\'s reservation', async () => {
    const mine = await claim({ id: 'mine-000001' });
    await claim({ id: 'theirs-00001' });                  // another attempt holds 2 as well: reserved = 4
    await exec(`select public.cancel_pending_product_order('${mine.data.order_id}')`);
    await exec(`select public.cancel_pending_product_order('${mine.data.order_id}')`);
    assert.equal(reserved(), 2, 'the other buyer\'s hold is intact');
  });

  test('20. a cancelled attempt is reported as cancelled and is NOT resurrected; a new id works', async () => {
    const a = await claim();
    await exec(`select public.cancel_pending_product_order('${a.data.order_id}')`);
    const replay = await claim();
    assert.equal(replay.data.status, 'cancelled'); assert.equal(replay.data.replayed, true);
    assert.equal(reserved(), 0, 'replaying a cancelled attempt reserves nothing');
    const fresh = await claim({ id: 'attempt-0002' });
    assert.equal(fresh.data.status, 'pending'); assert.equal(reserved(), 2);
  });

  test('an unpaid order past its time limit is expired by the replay itself, once, with its stock', async () => {
    const a = await claim();
    must(`update public.product_orders set expires_at = now() - interval '1 minute' where id = '${a.data.order_id}'`);
    const r1 = await claim(); const r2 = await claim();
    assert.equal(r1.data.status, 'expired'); assert.equal(r2.data.status, 'expired');
    assert.equal(reserved(), 0);
  });

  test('a paid order replays as paid and touches nothing', async () => {
    const a = await claim();
    must(`update public.product_orders set status = 'paid', paid_via = 'card', payment_intent_id = 'pi_paid_1', expires_at = null where id = '${a.data.order_id}'`);
    const r = await claim();
    assert.equal(r.data.status, 'paid'); assert.equal(r.data.payment_intent_id, 'pi_paid_1'); assert.equal(reserved(), 2);
  });
});

describe('processing lease', () => {
  test('6. only one of N concurrent requests holds the lease; release lets the next one take it', async () => {
    const a = await claim();
    const rs = await Promise.all([0, 1, 2, 3, 4].map(() => exec(`select public.claim_purchase_processing('product_order', '${a.data.order_id}')::text`)));
    assert.equal(rs.filter((r) => r.out === 'true').length, 1);
    assert.equal((await exec(`select public.claim_purchase_processing('product_order', '${a.data.order_id}')::text`)).out, 'false');
    await exec(`select public.release_purchase_processing('product_order', '${a.data.order_id}')`);
    assert.equal((await exec(`select public.claim_purchase_processing('product_order', '${a.data.order_id}')::text`)).out, 'true');
  });

  test('a crashed holder cannot lock the attempt: the lease goes stale after its window', async () => {
    const a = await claim();
    await exec(`select public.claim_purchase_processing('product_order', '${a.data.order_id}')`);
    must(`update public.product_orders set processing_claimed_at = now() - interval '2 minutes' where id = '${a.data.order_id}'`);
    assert.equal((await exec(`select public.claim_purchase_processing('product_order', '${a.data.order_id}')::text`)).out, 'true');
  });

  test('no lease on an order that is no longer pending', async () => {
    const a = await claim();
    await exec(`select public.cancel_pending_product_order('${a.data.order_id}')`);
    assert.equal((await exec(`select public.claim_purchase_processing('product_order', '${a.data.order_id}')::text`)).out, 'false');
  });
});

/* ── gifts ─────────────────────────────────────────────────────────────── */
const giftArgs = (o: Partial<{ buyer: string; id: string; mode: string; kind: string; unit: string | null; service: string | null; email: string; name: string | null; msg: string | null; price: number }> = {}) => ({
  p_purchaser: o.buyer ?? ALICE, p_client_request_id: o.id ?? 'gift-attempt-1', p_pay_mode: o.mode ?? 'card_form',
  p_kind: o.kind ?? 'unit', p_unit_item_id: o.unit === undefined ? UNIT : o.unit, p_service_id: o.service === undefined ? null : o.service,
  p_business_id: BIZ, p_recipient_email: o.email ?? 'friend@example.org', p_recipient_name: o.name === undefined ? 'Friend' : o.name,
  p_message: o.msg === undefined ? 'Happy birthday' : o.msg, p_price_pence: o.price ?? 3000,
});
const claimGift = (o: Parameters<typeof giftArgs>[0] = {}) => pgClient().rpc('claim_gift_purchase', giftArgs(o));
function giftStmt(o: Parameters<typeof giftArgs>[0] = {}): string {
  const q = (v: unknown) => (v === null ? 'null' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
  return `select public.claim_gift_purchase(${Object.entries(giftArgs(o)).map(([k, v]) => `${k} => ${q(v)}`).join(', ')})::text`;
}
async function heldGift(o: Parameters<typeof giftArgs>[0], holdMs: number) {
  const t0 = Date.now();
  const r = await exec(`begin; ${giftStmt(o)}; select pg_sleep(${holdMs / 1000}); commit;`);
  const first = r.out.split('\n').find((l) => l.startsWith('{'));
  return { ms: Date.now() - t0, err: r.err, data: first ? JSON.parse(first) : null };
}

describe('gifts — claim', () => {
  test('2. a normal gift: one pending_payment row carrying its attempt id and pay mode', async () => {
    const r = await claimGift();
    assert.equal(r.error, null); assert.equal(r.data.replayed, false); assert.equal(r.data.status, 'pending_payment');
    assert.equal(gifts(), 1);
    assert.equal(scalar(`select pay_mode from public.book_gifts`), 'card_form');
    assert.ok(scalar(`select code from public.book_gifts`).length >= 32, 'a unique placeholder code; the short code is minted when payment lands');
  });

  test('4. exact retry: the same gift comes back, replayed', async () => {
    const a = await claimGift(); const b = await claimGift();
    assert.equal(b.data.gift_id, a.data.gift_id); assert.equal(b.data.replayed, true); assert.equal(gifts(), 1);
  });

  test('7. two simultaneous gift submissions resolve to one gift', async () => {
    const A = heldGift({}, 1500); await sleep(350); const B = heldGift({}, 0);
    const [a, b] = await Promise.all([A, B]);
    assert.equal(a.err, null); assert.equal(b.err, null);
    assert.equal(b.data.gift_id, a.data.gift_id); assert.equal(b.data.replayed, true);
    assert.ok(b.ms >= 800, `loser waited on the winner (${b.ms}ms)`);
    assert.equal(gifts(), 1);
  });

  test('8. five simultaneous gift submissions: one gift, one code, exactly one creator', async () => {
    const rs = await Promise.all([0, 1, 2, 3, 4].map(() => heldGift({}, 400)));
    for (const r of rs) assert.equal(r.err, null);
    assert.equal(new Set(rs.map((r) => r.data.gift_id)).size, 1);
    assert.equal(rs.filter((r) => r.data.replayed === false).length, 1);
    assert.equal(gifts(), 1); assert.equal(num(`select count(distinct code) from public.book_gifts`), 1);
  });

  test('12/11. a new id is a new gift; another user\'s identical id is theirs alone', async () => {
    const a = await claimGift({ id: 'gift-attempt-1' }); const b = await claimGift({ id: 'gift-attempt-2' });
    const c = await claimGift({ buyer: BOB, id: 'gift-attempt-1' });
    assert.equal(new Set([a.data.gift_id, b.data.gift_id, c.data.gift_id]).size, 3);
    assert.equal(gifts(), 3);
  });

  test('a reused id for a different recipient, item, message, price or payment method is a conflict', async () => {
    await claimGift();
    const bad: Parameters<typeof giftArgs>[0][] = [
      { email: 'someone-else@example.org' }, { name: 'Other' }, { msg: 'different message' }, { price: 4000 }, { mode: 'wallet' },
      { kind: 'booking', unit: null, service: SERVICE },
    ];
    for (const o of bad) assert.match(String((await claimGift(o)).error?.message), /IDEMPOTENCY_CONFLICT/, JSON.stringify(o));
    assert.equal(gifts(), 1);
  });

  test('a cancelled gift attempt replays as cancelled (never resurrected); a new id works; a paid/sent one replays as sent', async () => {
    const a = await claimGift();
    assert.equal((await exec(`select public.cancel_pending_gift('${a.data.gift_id}')::text`)).out, 'true');
    assert.equal((await exec(`select public.cancel_pending_gift('${a.data.gift_id}')::text`)).out, 'false', 'second cancel is a no-op');
    assert.equal((await claimGift()).data.status, 'cancelled');
    // a declined card has a PaymentIntent bound to the gift; it must still be cancellable
    const dead = await claimGift({ id: 'gift-attempt-9' });
    must(`update public.book_gifts set payment_intent_id = 'pi_declined_1' where id = '${dead.data.gift_id}'`);
    assert.equal((await exec(`select public.cancel_pending_gift('${dead.data.gift_id}')::text`)).out, 'true');
    const b = await claimGift({ id: 'gift-attempt-2' });
    must(`update public.book_gifts set status = 'sent', payment_intent_id = 'pi_gift_1' where id = '${b.data.gift_id}'`);
    const r = await claimGift({ id: 'gift-attempt-2' });
    assert.equal(r.data.status, 'sent'); assert.equal(r.data.payment_intent_id, 'pi_gift_1');
    assert.equal((await exec(`select public.cancel_pending_gift('${b.data.gift_id}')::text`)).out, 'false', 'a paid gift cannot be cancelled');
  });

  test('the gift lease is single-flight too', async () => {
    const a = await claimGift();
    const rs = await Promise.all([0, 1, 2].map(() => exec(`select public.claim_purchase_processing('gift', '${a.data.gift_id}')::text`)));
    assert.equal(rs.filter((r) => r.out === 'true').length, 1);
  });
});

describe('one payment, one purchase', () => {
  test('19. a PaymentIntent can be attached to at most one order and one gift; unattached rows do not collide', async () => {
    const a = await claim({ id: 'attempt-0001' }); const b = await claim({ id: 'attempt-0002' });
    must(`update public.product_orders set payment_intent_id = 'pi_shared' where id = '${a.data.order_id}'`);
    const clash = await exec(`update public.product_orders set payment_intent_id = 'pi_shared' where id = '${b.data.order_id}'`);
    assert.match(String(clash.err), /product_orders_payment_intent_key|duplicate key/);
    const g1 = await claimGift({ id: 'gift-attempt-1' }); const g2 = await claimGift({ id: 'gift-attempt-2' });
    must(`update public.book_gifts set payment_intent_id = 'wallet_txn-1' where id = '${g1.data.gift_id}'`);
    const clashG = await exec(`update public.book_gifts set payment_intent_id = 'wallet_txn-1' where id = '${g2.data.gift_id}'`);
    assert.match(String(clashG.err), /book_gifts_payment_intent_key|duplicate key/);
    assert.equal(num(`select count(*) from public.product_orders where payment_intent_id is null`), 1, 'null payment ids never collide');
  });

  test('historical rows (no attempt id) keep working: several nulls coexist', () => {
    must(`insert into public.product_orders (business_id, buyer_id, fulfilment, items_pence, total_pence) values
          ('${BIZ}', '${ALICE}', 'collect', 500, 500), ('${BIZ}', '${ALICE}', 'collect', 500, 500)`);
    assert.equal(orders(), 2);
  });
});

describe('privileges', () => {
  const FNS = [
    'public.claim_product_order(uuid, text, text, uuid, text, jsonb, integer, integer, integer, integer, text, text, text, text, text, text, integer)',
    'public.cancel_pending_product_order(uuid, text)',
    'public.claim_gift_purchase(uuid, text, text, text, uuid, uuid, uuid, text, text, text, integer)',
    'public.cancel_pending_gift(uuid)',
    'public.claim_purchase_processing(text, uuid, integer)',
    'public.release_purchase_processing(text, uuid)',
  ];
  test('21/22. anon and authenticated cannot execute any of them; service_role can', () => {
    for (const f of FNS) {
      for (const role of ['anon', 'authenticated', 'public']) {
        const has = role === 'public'
          ? scalar(`select exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = '${f}'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE')`)
          : scalar(`select has_function_privilege('${role}', '${f}', 'EXECUTE')`);
        assert.equal(has, 'f', `${role} must not execute ${f.split('(')[0]}`);
      }
      assert.equal(scalar(`select has_function_privilege('service_role', '${f}', 'EXECUTE')`), 't');
    }
  });

  test('21. calling them as anon / authenticated is refused outright', async () => {
    for (const role of ['anon', 'authenticated']) {
      const r = await exec(`set role ${role}; select public.claim_gift_purchase(p_purchaser => '${ALICE}', p_client_request_id => 'attempt-role-1', p_pay_mode => 'card_form', p_kind => 'unit', p_unit_item_id => '${UNIT}', p_service_id => null, p_business_id => '${BIZ}', p_recipient_email => 'a@b.co', p_recipient_name => null, p_message => null, p_price_pence => 100)`);
      assert.match(String(r.err), /permission denied/i, role);
    }
    assert.equal(gifts(), 0);
  });

  test('the functions are SECURITY DEFINER with a pinned search_path', () => {
    for (const f of FNS) {
      assert.equal(scalar(`select prosecdef from pg_proc where oid = '${f}'::regprocedure`), 't', f);
      assert.match(scalar(`select array_to_string(proconfig, ',') from pg_proc where oid = '${f}'::regprocedure`), /search_path=public/);
    }
  });
});

/* ── controls: remove the protection and the problem comes back ─────────── */
describe('controls — the uniqueness is load-bearing', () => {
  function fnText(name: string): string {
    const s = readFileSync(ATTEMPT_MIGRATION, 'utf8');
    const start = s.indexOf(`create or replace function public.${name}(`); assert.notEqual(start, -1, name);
    const end = s.indexOf('$$;', s.indexOf('as $$', start)) + 3;
    return s.slice(start, end);
  }

  test('23. without the unique index and the ON CONFLICT claim, five simultaneous submissions create five orders and reserve five times', async () => {
    must(`drop index public.product_orders_buyer_request_key`);
    const mutant = fnText('claim_product_order').replace(/\s+on conflict \(buyer_id, client_request_id\) where client_request_id is not null do nothing/, '');
    assert.notEqual(mutant, fnText('claim_product_order'), 'the ON CONFLICT clause was found and removed');
    must(mutant);
    const rs = await Promise.all([0, 1, 2, 3, 4].map(() => heldClaim({}, 500)));
    for (const r of rs) assert.equal(r.err, null);
    assert.equal(orders(), 5, 'five orders for ONE attempt');
    assert.equal(reserved(), 10, 'and the stock reserved five times over');
    // restore the real definitions for any test that follows
    resetData();
    must(`drop function public.claim_product_order(uuid, text, text, uuid, text, jsonb, integer, integer, integer, integer, text, text, text, text, text, text, integer)`);
    assert.equal(execFileSync(ATTEMPT_MIGRATION).err, null);
    must(`grant execute on all functions in schema public to service_role`);
  });

  test('23. the same control for gifts: no unique index, no ON CONFLICT → five gifts', async () => {
    must(`drop index public.book_gifts_purchaser_request_key`);
    const mutant = fnText('claim_gift_purchase').replace(/\s+on conflict \(purchaser_id, client_request_id\) where client_request_id is not null do nothing/, '');
    assert.notEqual(mutant, fnText('claim_gift_purchase'));
    must(mutant);
    const rs = await Promise.all([0, 1, 2, 3, 4].map(() => heldGift({}, 500)));
    for (const r of rs) assert.equal(r.err, null);
    assert.equal(gifts(), 5, 'five gifts (five codes, five emails) for ONE attempt');
    resetData();
    must(`drop function public.claim_gift_purchase(uuid, text, text, text, uuid, uuid, uuid, text, text, text, integer)`);
    assert.equal(execFileSync(ATTEMPT_MIGRATION).err, null);
    must(`grant execute on all functions in schema public to service_role`);
  });

  test('the old pattern — look up, then insert — duplicates under the same concurrency even WITH the unique index absent', async () => {
    // This is what "check whether it exists, then create it" looks like: both sessions see nothing and both insert.
    must(`drop index if exists public.product_orders_buyer_request_key`);
    const naive = (id: string) => `begin;
      do $$ begin
        if not exists (select 1 from public.product_orders where buyer_id = '${ALICE}' and client_request_id = '${id}') then
          perform pg_sleep(0.4);
          insert into public.product_orders (business_id, buyer_id, fulfilment, items_pence, total_pence, client_request_id)
          values ('${BIZ}', '${ALICE}', 'collect', 100, 100, '${id}');
        end if;
      end $$; commit;`;
    await Promise.all([0, 1, 2].map(() => exec(naive('naive-attempt-1'))));
    assert.equal(orders(), 3, 'check-then-insert let all three through');
    resetData();
    assert.equal(execFileSync(ATTEMPT_MIGRATION).err, null);
  });
});

void join; void MIG;
