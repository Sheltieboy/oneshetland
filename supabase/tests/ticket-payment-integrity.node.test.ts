/**
 * ticket-payment-integrity.node.test.ts — a ticket order is paid, or refunded, only by ITS OWN payment.
 *
 * WHAT WAS WRONG
 *
 * refund-payment took the payment id for a ticket order from the order ROW and refunded it with reverse_transfer. The row was
 * not evidence: any signed-in user could insert one (migration 20261116000000 closes that). So the refund path now proves,
 * from what OUR checkout stamped on the PaymentIntent when it created it, that the payment belongs to the order — and the two
 * paths that mark an order paid (confirm-event-tickets, and the Stripe webhook's fulfilEventTickets) prove the same before
 * they settle anything.
 *
 * WHAT RUNS
 *
 * The REAL handlers — refund-payment/index.ts, confirm-event-tickets/index.ts and _shared/fulfilment.ts — are loaded as
 * source and driven with fakes: an in-memory Supabase and a scripted Stripe. Nothing leaves the process: any request to a host
 * other than api.stripe.com fails the test, and the Stripe it talks to is a fake, so no charge, refund or transfer can occur.
 *
 * The CONTROL removes the new check from the refund handler's own source and shows the forged order then reaches the Stripe
 * refund call — the original attack path, executed against a mock.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadModule, readRepo } from './_support/load-source.ts';

type Row = Record<string, any>;

const ORDER = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_ORDER = 'aaaaaaaa-0000-4000-8000-000000000002';
const EVENT = 'bbbbbbbb-0000-4000-8000-000000000001';
const OTHER_EVENT = 'bbbbbbbb-0000-4000-8000-000000000002';
const BUYER = 'cccccccc-0000-4000-8000-000000000001';
const OTHER_BUYER = 'cccccccc-0000-4000-8000-000000000002';
const ORGANISER = 'dddddddd-0000-4000-8000-000000000001';
const STRANGER = 'dddddddd-0000-4000-8000-000000000002';
const ADMIN = 'dddddddd-0000-4000-8000-000000000003';

const binding = () => loadModule('supabase/functions/_shared/ticket-payment-binding.ts', {});
const { paymentBelongsToTicketOrder, refundableOnTicketPayment } = binding() as {
  paymentBelongsToTicketOrder: (o: Row, p: Row) => { ok: boolean; reason?: string };
  refundableOnTicketPayment: (a: unknown, b: unknown) => number;
};

const goodOrder = (over: Row = {}) => ({ id: ORDER, event_id: EVENT, buyer_id: BUYER, status: 'paid', total_pence: 196, platform_fee_pence: 96,
  stripe_payment_intent_id: 'pi_ok', refunded_at: null, tickets_count: 1, ...over });
const goodPi = (over: Row = {}, metaOver: Row = {}) => ({
  id: 'pi_ok', status: 'succeeded', amount: 196, currency: 'gbp',
  metadata: { type: 'event_tickets', order_id: ORDER, event_id: EVENT, buyer_id: BUYER, ...metaOver },
  transfer_data: { destination: 'acct_organiser' },
  latest_charge: { id: 'ch_ok', refunded: false, amount_refunded: 0, transfer: 'tr_ok' },
  ...over,
});

/* ── the pure verifier ─────────────────────────────────────────────────────── */

describe('paymentBelongsToTicketOrder — what must agree', () => {
  const order = { id: ORDER, event_id: EVENT, buyer_id: BUYER, total_pence: 196 };
  test('the genuine payment is accepted', () => assert.deepEqual(paymentBelongsToTicketOrder(order, goodPi()), { ok: true }));
  for (const [name, pi, why] of [
    ['a payment for something else (a wallet top-up)', goodPi({}, { type: 'local_wallet_topup' }), /not created for event tickets/],
    ['a payment with no metadata at all', goodPi({ metadata: null }), /not created for event tickets/],
    ['a payment for a different order', goodPi({}, { order_id: OTHER_ORDER }), /different order/],
    ['a payment for a different event', goodPi({}, { event_id: OTHER_EVENT }), /different event/],
    ['a payment by a different buyer', goodPi({}, { buyer_id: OTHER_BUYER }), /different buyer/],
    ['a payment of a different amount', goodPi({ amount: 197 }), /amount/],
    ['a payment of a smaller amount', goodPi({ amount: 100 }), /amount/],
    ['an amount that is not a whole number', goodPi({ amount: 196.5 }), /amount/],
    ['an amount sent as text', goodPi({ amount: '196' }), /amount/],
    ['a payment in another currency', goodPi({ currency: 'eur' }), /currency/],
    ['a payment with no currency', goodPi({ currency: undefined }), /currency/],
  ] as [string, Row, RegExp][]) {
    test(`refused: ${name}`, () => {
      const r = paymentBelongsToTicketOrder(order, pi);
      assert.equal(r.ok, false);
      assert.match(String(r.reason), why);
    });
  }
  test('currency case does not matter (Stripe lower-cases it; a stray capital must not break a real refund)', () =>
    assert.equal(paymentBelongsToTicketOrder(order, goodPi({ currency: 'GBP' })).ok, true));
});

describe('refundableOnTicketPayment', () => {
  test('whole amount when nothing was refunded; the remainder when part was; never negative; junk is zero', () => {
    assert.equal(refundableOnTicketPayment(196, 0), 196);
    assert.equal(refundableOnTicketPayment(196, undefined), 196);
    assert.equal(refundableOnTicketPayment(196, 100), 96);
    assert.equal(refundableOnTicketPayment(196, 196), 0);
    assert.equal(refundableOnTicketPayment(196, 500), 0);
    assert.equal(refundableOnTicketPayment(0, 0), 0);
    assert.equal(refundableOnTicketPayment('196', 0), 0);
    assert.equal(refundableOnTicketPayment(196.5, 0), 0);
  });
});

/* ── fakes: an in-memory Supabase and a scripted Stripe ────────────────────── */

interface Scenario {
  caller: string;
  tables: Record<string, Row | null>;
  rpc: Record<string, any>;
  pis: Record<string, Row>;
  claim?: Row[];
}
let sc: Scenario;
let calls: { rpc: { name: string; args: any }[]; updates: { table: string; v: any }[]; inserts: { table: string; v: any }[] };
let stripe: { url: string; method: string; headers: any; body?: string }[];
let walletRefunds: any[];

function fakeSvc() {
  const chain = (table: string) => {
    const c: any = {};
    for (const m of ['select', 'eq', 'in', 'is', 'neq', 'order', 'limit', 'gte', 'lte', 'not']) c[m] = () => c;
    const row = () => sc.tables[table] ?? null;
    c.maybeSingle = async () => ({ data: row(), error: null });
    c.single = async () => ({ data: row(), error: row() ? null : { message: 'not found' } });
    c.update = (v: any) => { calls.updates.push({ table, v }); return c; };
    c.insert = async (v: any) => { calls.inserts.push({ table, v }); return { error: null }; };
    c.then = (res: any, rej: any) => Promise.resolve({ data: sc.claim ?? [{ id: 'claimed' }], error: null }).then(res, rej);
    return c;
  };
  return { from: chain, rpc: async (name: string, args: any) => { calls.rpc.push({ name, args }); return { data: sc.rpc[name] ?? null, error: null }; } };
}
const createClient = (_url: string, key: string) =>
  key === 'anon-key' ? { auth: { getUser: async () => ({ data: { user: { id: sc.caller } }, error: null }) } } : fakeSvc();

const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
function installGlobals() {
  (globalThis as any).Deno = { env: { get: (k: string) => ({ SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_ANON_KEY: 'anon-key', SUPABASE_SERVICE_ROLE_KEY: 'svc-key', STRIPE_SECRET_KEY: 'sk_test_fake' } as Record<string, string>)[k] } };
  (globalThis as any).fetch = async (url: string, init: any = {}) => {
    assert.match(url, /^https:\/\/api\.stripe\.com\/v1\//, `a request left for ${url} — only the fake Stripe may be called`);
    stripe.push({ url, method: init.method ?? 'GET', headers: init.headers, body: init.body });
    const m = url.match(/\/payment_intents\/([^?]+)/);
    if (m) return sc.pis[m[1]] ? reply(200, sc.pis[m[1]]) : reply(404, { error: { message: 'No such payment_intent' } });
    if (url.endsWith('/refunds')) {
      const f = new URLSearchParams(init.body);
      const pi = sc.pis[f.get('payment_intent')!];
      return reply(200, { id: 're_fake', amount: Number(f.get('amount') ?? pi?.amount ?? 0) });
    }
    throw new Error(`unscripted Stripe call: ${init.method ?? 'GET'} ${url}`);
  };
}

beforeEach(() => {
  calls = { rpc: [], updates: [], inserts: [] }; stripe = []; walletRefunds = [];
  sc = {
    caller: ORGANISER,
    tables: { event_ticket_orders: goodOrder(), profiles: { role: 'customer', is_platform_owner: false }, hub_membership_purchases: null, local_boost_purchases: null, events: { title: 'Up Helly Aa', starts_at: '2026-12-01T00:00:00Z' } },
    rpc: { can_refund_event_orders: true, refund_event_tickets_for_payment: { action: 'refunded' } },
    pis: { pi_ok: goodPi() },
  };
  installGlobals();
});

/* ── refund-payment, the real handler ──────────────────────────────────────── */

function refundHandler(transform?: (s: string) => string) {
  let handler!: (r: Request) => Promise<Response>;
  loadModule('supabase/functions/refund-payment/index.ts', {
    'https://deno.land/std@0.168.0/http/server.ts': { serve: (h: any) => { handler = h; } },
    'https://esm.sh/@supabase/supabase-js@2': { createClient },
    '../_shared/safe-error.ts': { safeError: () => 'internal error' },
    '../_shared/refund-reconcile.ts': { reconcileCharge: async () => ({ state: 'ok', note: '' }), reconcileWalletOrder: async () => ({ state: 'ok', note: '' }) },
    '../_shared/event-wallet-refund-core.ts': {
      isWalletRef: (r: unknown) => String(r).startsWith('wallet_'),
      refundWalletEventOrder: async (...a: any[]) => { walletRefunds.push(a); return { ok: true, amount_pence: 196, merchant_reversed: true, already_reversed: false, tickets_action: 'refunded' }; },
    },
    '../_shared/refund-notice.ts': { notifyRefund: async () => {} },
    '../_shared/ticket-payment-binding.ts': binding(),
  }, transform);
  return handler;
}
const ask = (h: (r: Request) => Promise<Response>, body: Row) =>
  h(new Request('https://fake.supabase.co/functions/v1/refund-payment', { method: 'POST', headers: { Authorization: 'Bearer t' }, body: JSON.stringify(body) }));
const refundPosts = () => stripe.filter((s) => s.method === 'POST' && s.url.endsWith('/refunds'));

describe('refund-payment — a ticket order refunds only its own payment', () => {
  test('CONTROL (the original attack): with the binding check removed, a forged order reaches the Stripe REFUND call for a payment that is not its own', async () => {
    const stripped = (s: string) => {
      const a = s.indexOf('// ── A ticket order may refund ITS OWN payment');
      const b = s.indexOf('// Partial-amount validation.');
      assert.ok(a > 0 && b > a, 'the binding block moved — update this control');
      return s.slice(0, a) + 'const ticketRefundAmount: number | null = null;\n    ' + s.slice(b);
    };
    // a forged "paid" row naming somebody's wallet top-up payment, caller = organiser of the event the forger created
    sc.tables.event_ticket_orders = goodOrder({ stripe_payment_intent_id: 'pi_topup' });
    sc.pis.pi_topup = goodPi({ id: 'pi_topup', transfer_data: undefined, latest_charge: { id: 'ch_t', refunded: false, amount_refunded: 0, transfer: null }, amount: 5000 }, { type: 'local_wallet_topup', order_id: undefined, event_id: undefined, buyer_id: 'someone-else' });
    const res = await ask(refundHandler(stripped), { event_order_id: ORDER });
    assert.equal(res.status, 200, 'the unprotected handler should have gone ahead');
    assert.equal(refundPosts().length, 1, 'the forged order reached the Stripe refund call');
    assert.match(refundPosts()[0].body!, /payment_intent=pi_topup/);
  });

  test('the FIXED handler refuses that same forged order and issues no refund', async () => {
    sc.tables.event_ticket_orders = goodOrder({ stripe_payment_intent_id: 'pi_topup' });
    sc.pis.pi_topup = goodPi({ id: 'pi_topup', amount: 5000 }, { type: 'local_wallet_topup', order_id: undefined, event_id: undefined, buyer_id: 'someone-else' });
    const res = await ask(refundHandler(), { event_order_id: ORDER });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /does not belong to this ticket order/);
    assert.equal(refundPosts().length, 0, 'a refund was issued for a payment that is not this order’s');
    assert.equal(calls.rpc.filter((r) => r.name === 'refund_event_tickets_for_payment').length, 0, 'tickets were voided');
  });

  test('a genuine card order is refunded in full, with the transfer and the fee reversed, once, and its tickets voided', async () => {
    const res = await ask(refundHandler(), { event_order_id: ORDER });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.amount_pence, 196);
    assert.equal(body.reversed_transfer, true);
    assert.equal(refundPosts().length, 1);
    const f = new URLSearchParams(refundPosts()[0].body!);
    assert.equal(f.get('payment_intent'), 'pi_ok');
    assert.equal(f.get('reverse_transfer'), 'true');
    assert.equal(f.get('refund_application_fee'), 'true');
    assert.equal(f.get('metadata[event_order_id]'), ORDER);
    assert.equal(f.get('amount'), null, 'a full refund sets no amount');
    assert.equal(refundPosts()[0].headers['Idempotency-Key'], 'refund:pi_ok:full');
    assert.equal(calls.rpc.filter((r) => r.name === 'refund_event_tickets_for_payment').length, 1);
  });

  for (const [name, pi] of [
    ['the payment belongs to a different order', goodPi({}, { order_id: OTHER_ORDER })],
    ['the payment is for a different event', goodPi({}, { event_id: OTHER_EVENT })],
    ['the payment was made by a different buyer', goodPi({}, { buyer_id: OTHER_BUYER })],
    ['the payment is not an event-ticket payment', goodPi({}, { type: 'hub_donation' })],
    ['the amount differs from the order total', goodPi({ amount: 5000 })],
    ['the currency differs', goodPi({ currency: 'usd' })],
  ] as [string, Row][]) {
    test(`refused, nothing refunded: ${name}`, async () => {
      sc.pis.pi_ok = pi;
      const res = await ask(refundHandler(), { event_order_id: ORDER });
      assert.equal(res.status, 409);
      assert.equal(refundPosts().length, 0);
      assert.equal(calls.rpc.filter((r) => r.name === 'refund_event_tickets_for_payment').length, 0);
    });
  }

  test('a payment that does not exist at Stripe is refused (nothing refunded)', async () => {
    delete sc.pis.pi_ok;
    const res = await ask(refundHandler(), { event_order_id: ORDER });
    assert.equal(res.status, 502);
    assert.equal(refundPosts().length, 0);
  });

  test('a payment that has not succeeded is refused', async () => {
    sc.pis.pi_ok = goodPi({ status: 'requires_payment_method' });
    const res = await ask(refundHandler(), { event_order_id: ORDER });
    assert.equal(res.status, 400);
    assert.equal(refundPosts().length, 0);
  });

  test('16 — the refund can never exceed what is left: a part already refunded elsewhere is subtracted, and only the rest is refunded', async () => {
    sc.pis.pi_ok = goodPi({ latest_charge: { id: 'ch_ok', refunded: false, amount_refunded: 100, transfer: 'tr_ok' } });
    const res = await ask(refundHandler(), { event_order_id: ORDER });
    assert.equal(res.status, 200);
    const f = new URLSearchParams(refundPosts()[0].body!);
    assert.equal(f.get('amount'), '96');
    assert.equal(refundPosts()[0].headers['Idempotency-Key'], 'refund:pi_ok:96');
  });

  test('already fully refunded at Stripe (flag or amount) → refused, nothing sent', async () => {
    sc.pis.pi_ok = goodPi({ latest_charge: { id: 'ch_ok', refunded: true, amount_refunded: 196, transfer: 'tr_ok' } });
    assert.equal((await ask(refundHandler(), { event_order_id: ORDER })).status, 400);
    sc.pis.pi_ok = goodPi({ latest_charge: { id: 'ch_ok', refunded: false, amount_refunded: 196, transfer: 'tr_ok' } });
    assert.equal((await ask(refundHandler(), { event_order_id: ORDER })).status, 400);
    assert.equal(refundPosts().length, 0);
  });

  test('17 — a duplicate request uses the SAME idempotency key, so Stripe returns the first refund rather than making a second', async () => {
    await ask(refundHandler(), { event_order_id: ORDER });
    await ask(refundHandler(), { event_order_id: ORDER });
    assert.equal(refundPosts().length, 2);
    assert.equal(refundPosts()[0].headers['Idempotency-Key'], refundPosts()[1].headers['Idempotency-Key']);
  });

  test('an order the database already says is refunded is refused before Stripe is touched', async () => {
    sc.tables.event_ticket_orders = goodOrder({ status: 'refunded', refunded_at: '2026-10-01T00:00:00Z' });
    const res = await ask(refundHandler(), { event_order_id: ORDER });
    assert.equal(res.status, 400);
    assert.equal(stripe.length, 0);
  });

  test('an order that is not paid (pending / cancelled), has no payment id, or is free, is refused before Stripe is touched', async () => {
    for (const over of [{ status: 'pending' }, { status: 'cancelled' }, { stripe_payment_intent_id: null }, { total_pence: 0 }]) {
      sc.tables.event_ticket_orders = goodOrder(over);
      assert.equal((await ask(refundHandler(), { event_order_id: ORDER })).status, 400, JSON.stringify(over));
    }
    assert.equal(stripe.length, 0);
  });

  test('18 — a stranger (not the organiser, not an administrator) cannot refund it: 403, and Stripe is never contacted', async () => {
    sc.caller = STRANGER; sc.rpc.can_refund_event_orders = false;
    const res = await ask(refundHandler(), { event_order_id: ORDER });
    assert.equal(res.status, 403);
    assert.equal(stripe.length, 0);
  });

  test('19 — an administrator may refund (can_refund_event_orders allows admins), through the same checks', async () => {
    sc.caller = ADMIN; sc.tables.profiles = { role: 'admin', is_platform_owner: false };
    const res = await ask(refundHandler(), { event_order_id: ORDER });
    assert.equal(res.status, 200);
    assert.equal(refundPosts().length, 1);
    // …and an administrator is held to the binding too: a forged order is refused for them as well
    sc.pis.pi_ok = goodPi({}, { order_id: OTHER_ORDER }); stripe.length = 0;
    assert.equal((await ask(refundHandler(), { event_order_id: ORDER })).status, 409);
    assert.equal(refundPosts().length, 0);
  });

  test('a caller cannot choose the amount of a ticket-order refund, nor send a payment id with it', async () => {
    assert.equal((await ask(refundHandler(), { event_order_id: ORDER, amount_pence: 1 })).status, 400);
    sc.pis.pi_attacker = goodPi({ id: 'pi_attacker', amount: 9999 });
    const res = await ask(refundHandler(), { event_order_id: ORDER, payment_intent_id: 'pi_attacker' });
    assert.equal(res.status, 200);
    assert.match(refundPosts()[0].body!, /payment_intent=pi_ok/, 'the order’s own payment is refunded, whatever the caller named');
  });

  test('a wallet-paid order goes down the wallet rail (ledger-verified), never Stripe', async () => {
    sc.tables.event_ticket_orders = goodOrder({ stripe_payment_intent_id: 'wallet_8423a6e9-708d-4482-834e-7ba56609d88b' });
    const res = await ask(refundHandler(), { event_order_id: ORDER });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).rail, 'wallet');
    assert.equal(walletRefunds.length, 1);
    assert.equal(stripe.length, 0);
  });

  test('the admin payment-id refund of a NON-ticket payment (a delivery, say) still works, and a non-admin still cannot', async () => {
    sc.caller = ADMIN; sc.tables.profiles = { role: 'admin', is_platform_owner: false };
    sc.pis.pi_delivery = goodPi({ id: 'pi_delivery', amount: 800, transfer_data: undefined }, { type: 'fetch', order_id: undefined });
    assert.equal((await ask(refundHandler(), { payment_intent_id: 'pi_delivery' })).status, 200);
    assert.equal(refundPosts().length, 1);
    sc.caller = STRANGER; sc.tables.profiles = { role: 'customer', is_platform_owner: false }; stripe.length = 0;
    assert.equal((await ask(refundHandler(), { payment_intent_id: 'pi_delivery' })).status, 403);
    assert.equal(refundPosts().length, 0);
  });
});

/* ── confirm-event-tickets: marking an order paid on the buyer's say-so ─────── */

function confirmHandler() {
  let handler!: (r: Request) => Promise<Response>;
  loadModule('supabase/functions/confirm-event-tickets/index.ts', {
    'https://deno.land/std@0.168.0/http/server.ts': { serve: (h: any) => { handler = h; } },
    'https://esm.sh/@supabase/supabase-js@2': { createClient },
    '../_shared/send-push.ts': { sendUserPush: async () => {} },
    '../_shared/ticket-receipt.ts': { sendTicketReceipt: async () => {} },
    '../_shared/safe-error.ts': { safeError: () => 'internal error' },
    '../_shared/ticket-payment-binding.ts': binding(),
  });
  return handler;
}
const confirm = (body: Row = { order_id: ORDER, payment_intent_id: 'pi_ok' }) =>
  confirmHandler()(new Request('https://fake.supabase.co/functions/v1/confirm-event-tickets', { method: 'POST', headers: { Authorization: 'Bearer t' }, body: JSON.stringify(body) }));
const markedPaid = () => calls.updates.filter((u) => u.table === 'event_ticket_orders' && u.v.status === 'paid');

describe('confirm-event-tickets — an order is marked paid only by its own, matching payment', () => {
  beforeEach(() => { sc.caller = BUYER; sc.tables.event_ticket_orders = goodOrder({ status: 'pending' }); });

  test('8, 20 — the genuine payment marks the order paid and its tickets valid', async () => {
    const res = await confirm();
    assert.equal(res.status, 200);
    assert.equal(markedPaid().length, 1);
    assert.ok(calls.updates.some((u) => u.table === 'event_tickets' && u.v.status === 'valid'));
  });
  for (const [name, pi] of [
    ['9  — a payment that belongs to a different order', goodPi({}, { order_id: OTHER_ORDER })],
    ['10 — a payment of the wrong amount (a cheap 50p payment)', goodPi({ amount: 50 })],
    ['11 — a payment in the wrong currency', goodPi({ currency: 'eur' })],
    ['a payment for something other than tickets, carrying this order id', goodPi({}, { type: 'product_order' })],
    ['a payment for a different event', goodPi({}, { event_id: OTHER_EVENT })],
    ['a payment made by somebody else', goodPi({}, { buyer_id: OTHER_BUYER })],
  ] as [string, Row][]) {
    test(`refused, order stays unpaid: ${name}`, async () => {
      sc.pis.pi_ok = pi;
      const res = await confirm();
      assert.equal(res.status, 403);
      assert.equal(markedPaid().length, 0);
    });
  }
  test('12 — a payment id other than the one the order was created with is refused', async () => {
    sc.pis.pi_other = goodPi({ id: 'pi_other' });
    const res = await confirm({ order_id: ORDER, payment_intent_id: 'pi_other' });
    assert.equal(res.status, 400);
    assert.equal(markedPaid().length, 0);
  });
  test('a payment that has not succeeded does not settle the order', async () => {
    sc.pis.pi_ok = goodPi({ status: 'processing' });
    assert.equal((await confirm()).status, 402);
    assert.equal(markedPaid().length, 0);
  });
  test('only the buyer can confirm their order', async () => {
    sc.caller = STRANGER;
    assert.equal((await confirm()).status, 403);
    assert.equal(markedPaid().length, 0);
  });
  test('13 — confirming an order that is already paid changes nothing', async () => {
    sc.tables.event_ticket_orders = goodOrder({ status: 'paid' });
    assert.equal((await confirm()).status, 200);
    assert.equal(markedPaid().length, 0);
    assert.equal(stripe.length, 0);
  });
});

/* ── the webhook's fulfiller ───────────────────────────────────────────────── */

function fulfil() {
  return loadModule('supabase/functions/_shared/fulfilment.ts', {
    'https://esm.sh/@supabase/supabase-js@2': { SupabaseClient: class {} },
    './send-push.ts': { sendUserPush: async () => {}, sendUserPushBulk: async () => {} },
    './ticket-receipt.ts': { sendTicketReceipt: async () => {} },
    './send-email.ts': { sendEmail: async () => ({ ok: true }) },
    './ticket-payment-binding.ts': binding(),
  }).fulfilEventTickets as (svc: any, pi: Row) => Promise<{ granted: boolean; note: string }>;
}
const webhookPi = (over: Row = {}, meta: Row = {}) => ({ id: 'pi_ok', amount: 196, currency: 'gbp', status: 'succeeded',
  metadata: { type: 'event_tickets', order_id: ORDER, event_id: EVENT, buyer_id: BUYER, ...meta }, ...over });

describe('the Stripe webhook’s ticket fulfiller — same rules, same order of proof', () => {
  beforeEach(() => { sc.tables.event_ticket_orders = goodOrder({ status: 'pending' }); });

  test('8 — a genuine, matching payment settles the order and validates its tickets', async () => {
    const r = await fulfil()(fakeSvc(), webhookPi());
    assert.equal(r.granted, true);
    assert.equal(markedPaid().length, 1);
    assert.ok(calls.updates.some((u) => u.table === 'event_tickets' && u.v.status === 'valid'));
  });
  for (const [name, pi] of [
    ['9  — metadata names a different order', webhookPi({}, { order_id: OTHER_ORDER })],
    ['9b — the payment id is not the one stored on the order', webhookPi({ id: 'pi_someone_elses' })],
    ['10 — the amount differs from the order total', webhookPi({ amount: 1 })],
    ['11 — the currency differs', webhookPi({ currency: 'usd' })],
    ['11b — no currency supplied', webhookPi({ currency: undefined })],
    ['a different event', webhookPi({}, { event_id: OTHER_EVENT })],
  ] as [string, Row][]) {
    test(`not marked paid: ${name}`, async () => {
      // for 9 the metadata order id differs, so the fulfiller looks up THAT order — give it the same pending row to prove the binding, not the lookup, stops it
      const r = await fulfil()(fakeSvc(), pi);
      assert.equal(r.granted, false);
      assert.equal(markedPaid().length, 0);
    });
  }
  test('a genuine payment that cannot be matched to its order leaves a record for follow-up (money moved, nothing settled)', async () => {
    await fulfil()(fakeSvc(), webhookPi({ amount: 1 }));
    const rec = calls.inserts.find((i) => i.table === 'failed_fulfilments');
    assert.ok(rec, 'no failed_fulfilments row was written');
    assert.equal(rec!.v.purpose, 'event_tickets_payment_mismatch');
  });
  test('13 — a duplicate delivery of an already-paid order changes nothing', async () => {
    sc.tables.event_ticket_orders = goodOrder({ status: 'paid' });
    const r = await fulfil()(fakeSvc(), webhookPi());
    assert.equal(r.granted, false);
    assert.match(r.note, /already/);
    assert.equal(markedPaid().length, 0);
  });
  test('the webhook passes the PaymentIntent’s currency through to the fulfiller', () => {
    const w = readRepo('supabase/functions/stripe-webhook/index.ts');
    assert.match(w, /currency: eventData\.currency as string \| undefined,/);
  });
});

/* ── nothing else in the checkout lost its guard ──────────────────────────── */

describe('the checkout still builds payments the verifier will accept', () => {
  test('create-event-ticket-intent stamps type, event_id, order_id and buyer_id, and charges the order total in gbp', () => {
    const s = readRepo('supabase/functions/create-event-ticket-intent/index.ts');
    for (const k of ["'metadata[type]':         'event_tickets'", "'metadata[event_id]':     event_id", "'metadata[order_id]':     order.id", "'metadata[buyer_id]':     user.id"]) assert.ok(s.includes(k), k);
    assert.match(s, /amount:\s+String\(chargeTotalPence\)/);
    assert.match(s, /currency:\s+'gbp'/);
    assert.match(s, /p_total_pence:\s+chargeTotalPence/, 'the order total and the charge must be the same number');
  });
});
