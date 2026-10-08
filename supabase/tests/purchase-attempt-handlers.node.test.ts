/**
 * purchase-attempt-handlers.node.test.ts — the REAL create-product-order-intent, create-gift-intent, confirm-gift and webhook
 * fulfilment, run against a REAL (isolated) database, with a Stripe that behaves like Stripe.
 *
 * THE FINDING
 * Shop orders and gifts minted a fresh row id on every call and keyed Stripe and the wallet on that id, so nothing tied two
 * requests for one purchase together. A double-click, a retried request, two tabs or a replayed call each made another order
 * (and stock reservation, or gift), another PaymentIntent and — by wallet — another debit.
 *
 * WHAT RUNS
 * The handlers' own source, loaded with their imports stubbed. Their Supabase calls go to the isolated Postgres through psql
 * (supabase/tests/_support/purchase-fixture.ts): every call is its own backend, so Promise.all over the handlers is genuinely
 * concurrent. Stripe is a simulator that stores the first answer for each Idempotency-Key (errors included), answers a concurrent
 * repeat of an in-flight key with 409 idempotency_key_in_use, and can lose a response after creating the object. The wallet
 * ledger is a stub with the real contract (one debit per key, a repeat reports alreadyApplied). The wallet SQL itself is proved
 * in wallet-concurrency.node.test.ts.
 *
 * COUNTED, for every scenario: database purchase rows, Stripe PaymentIntents actually created, stock reserved/committed, wallet
 * debits and transfers, gift codes, emails and pushes.
 *
 * CONTROLS: strip the Stripe idempotency key, the database uniqueness, or confirm-gift's atomic claim from the code under test
 * and the same scenario produces the duplicates this change exists to prevent.
 *
 * SAFETY — ISOLATED DATABASE ONLY: requires PASS_PROOF_DSN, refuses a DSN mentioning Supabase. No network, no real Stripe.
 */

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadModule } from './_support/load-source.ts';
import { assertIsolated, buildFixture, resetData, must, num, scalar, exec, execFileSync, pgClient, IDS, ATTEMPT_MIGRATION, type PgClient } from './_support/purchase-fixture.ts';

const { ALICE, BOB, BIZ, P_TRACKED, P_ONEOFF, P_LOW, UNIT, SERVICE } = IDS;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ── Stripe, as Stripe behaves ─────────────────────────────────────────── */
class StripeSim {
  created: Record<string, any>[] = [];
  posts: { key: string | null; body: string }[] = [];
  gets: string[] = [];
  private byKey = new Map<string, { body: string; status: number; json: any }>();
  private inFlight = new Set<string>();
  override = new Map<string, string>();       // pi id → status the sim reports on retrieve
  delayMs = 0;
  declineConfirm = false;
  loseResponseOnce = false;                   // create the object, then drop the connection
  failBeforeCreateOnce = false;               // the request never reaches Stripe
  inUse409 = 0;                               // how many concurrent repeats were told "in use"
  private n = 0;
  register(pi: Record<string, any>) { this.created.push(pi); }
  async handle(url: string, init: any = {}): Promise<any> {
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    const res = (status: number, json: any) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
    if (method === 'POST' && /\/v1\/payment_intents$/.test(url)) {
      const key = headers['Idempotency-Key'] ?? null;
      const body = String(init.body ?? '');
      this.posts.push({ key, body });
      if (this.failBeforeCreateOnce) { this.failBeforeCreateOnce = false; throw new TypeError('fetch failed'); }
      if (key) {
        if (this.inFlight.has(key)) { this.inUse409++; return res(409, { error: { type: 'idempotency_error', code: 'idempotency_key_in_use', message: 'in use' } }); }
        const prev = this.byKey.get(key);
        if (prev) {
          if (prev.body !== body) return res(400, { error: { type: 'idempotency_error', message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.' } });
          return res(prev.status, prev.json);
        }
        this.inFlight.add(key);
      }
      if (this.delayMs) await sleep(this.delayMs);
      const p = new URLSearchParams(body);
      const confirm = p.get('confirm') === 'true';
      let status = 200; let json: any;
      if (confirm && this.declineConfirm) {
        status = 402; json = { error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' } };
      } else {
        const id = `pi_sim_${++this.n}`;
        const metadata: Record<string, string> = {};
        for (const [k, v] of p) { const m = k.match(/^metadata\[(.+)\]$/); if (m) metadata[m[1]] = v; }
        json = { id, client_secret: `${id}_secret`, status: confirm ? 'succeeded' : 'requires_payment_method', amount: Number(p.get('amount')), metadata };
        this.created.push(json);
      }
      if (key) { this.byKey.set(key, { body, status, json }); this.inFlight.delete(key); }
      if (this.loseResponseOnce && status === 200) { this.loseResponseOnce = false; throw new TypeError('connection reset'); }
      return res(status, json);
    }
    const g = url.match(/\/v1\/payment_intents\/([^/?]+)$/);
    if (method === 'GET' && g) {
      this.gets.push(g[1]);
      const pi = this.created.find((c) => c.id === g[1]);
      if (!pi) return res(404, { error: { message: 'No such payment_intent' } });
      return res(200, { ...pi, status: this.override.get(pi.id) ?? pi.status });
    }
    if (/notify-drivers/.test(url)) return res(200, {});
    throw new Error(`unexpected network call ${method} ${url}`);
  }
}

/* ── the world the handlers run in ─────────────────────────────────────── */
let sim: StripeSim;
let db: PgClient;
let handler: ((r: Request) => Promise<Response>) | null;
let savedCardOnFile = false;
let effects: { pushes: any[]; emails: any[]; debits: Map<string, number>; transfers: Set<string>; walletFail: boolean; loyalty: number };
let walletDelay = 0;

const sca = loadModule('supabase/functions/_shared/stripe-sca.ts');
const attemptSrc = (strip?: (s: string) => string) => loadModule('supabase/functions/_shared/purchase-attempt.ts', {}, strip);

function installGlobals() {
  (globalThis as any).Deno = { env: { get: (k: string) => ({ SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_ANON_KEY: 'anon-key', SUPABASE_SERVICE_ROLE_KEY: 'svc-key', STRIPE_SECRET_KEY: 'sk_test_sim' } as Record<string, string>)[k] } };
  (globalThis as any).fetch = (url: string, init?: any) => sim.handle(url, init);
}
const createClient = (_u: string, key: string, opts: Record<string, any> = {}) => key === 'anon-key'
  ? { auth: { getUser: async () => ({ data: { user: { id: String(opts?.global?.headers?.Authorization ?? '').replace('Bearer user-', '') } }, error: null }) } }
  : db;

/** the wallet ledger's contract: one debit per idempotency key; a repeat reports alreadyApplied and takes nothing */
async function ledger(key: string, amount: number) {
  const repeat = effects.debits.has(key);
  if (!repeat) effects.debits.set(key, amount);
  if (walletDelay) await sleep(walletDelay);
  return { repeat, transactionId: `00000000-0000-4000-8000-${String(effects.debits.size).padStart(12, '0')}` };
}

function commonStubs(extra: Record<string, unknown> = {}, purchase = attemptSrc()) {
  return {
    'https://deno.land/std@0.168.0/http/server.ts': { serve: (fn: any) => { handler = fn; } },
    'https://esm.sh/@supabase/supabase-js@2': { createClient },
    '../_shared/commission.ts': { calculateCommission: (amt: number) => ({ fee_pence: Math.round(amt * 0.05) }) },
    '../_shared/commission-config.ts': { getCommissionConfig: async () => ({}) },
    '../_shared/self-payment.ts': { selfPaymentBlock: async () => null },
    '../_shared/send-push.ts': { sendUserPush: async (_s: unknown, p: unknown) => { effects.pushes.push(p); }, sendUserPushBulk: async () => {} },
    '../_shared/send-email.ts': { sendEmail: async (_s: unknown, e: any) => { effects.emails.push(e); return { ok: true, skipped: false }; } },
    '../_shared/safe-error.ts': { safeError: (_n: string, e: any) => String(e?.message ?? e) },
    '../_shared/rate-limit.ts': { enforcePaymentStart: async () => ({ ok: true }) },
    '../_shared/stripe-sca.ts': sca,
    '../_shared/saved-card.ts': { chargeableCardFor: async () => (savedCardOnFile ? 'pm_saved' : null) },
    '../_shared/purchase-attempt.ts': purchase,
    ...extra,
  };
}

const loadProduct = (opts: { strip?: (s: string) => string; purchase?: Record<string, any> } = {}) => {
  handler = null;
  loadModule('supabase/functions/create-product-order-intent/index.ts', commonStubs({
    '../_shared/wallet-pay.ts': {
      executeWalletPayment: async (_s: unknown, a: any) => {
        if (effects.walletFail) return { ok: false, status: 402, error: 'Not enough in your wallet' };
        const l = await ledger(a.idempotencyKey, a.amountPence);
        return { ok: true, balance_pence: 5000, cashback_pence: 0, transfer_id: 'tr_1', transactionId: l.transactionId, alreadyApplied: l.repeat };
      },
    },
    '../_shared/fulfilment.ts': { spawnFetchRequest: async () => {} },
  }, opts.purchase ?? attemptSrc()), opts.strip);
  return handler!;
};
const loadGift = (opts: { purchase?: Record<string, any> } = {}) => {
  handler = null;
  loadModule('supabase/functions/create-gift-intent/index.ts', commonStubs({
    '../_shared/wallet-ledger.ts': {
      selfPaymentBlock: async () => null,
      debitAndTransfer: async (_s: unknown, a: any) => {
        if (effects.walletFail) return { ok: false, reason: 'insufficient', status: 402, error: 'Not enough' };
        const l = await ledger(a.idempotencyKey, a.spendPence);
        if (a.transfer && !l.repeat) effects.transfers.add(a.idempotencyKey);
        return { ok: true, balancePence: 5000, transactionId: l.transactionId, alreadyApplied: l.repeat };
      },
    },
    '../_shared/wallet-liquidity-gate.ts': { withWalletLiquidityGate: async (_s: unknown, _n: number, fn: () => Promise<any>) => ({ ok: true, value: await fn() }) },
  }, opts.purchase ?? attemptSrc()));
  return handler!;
};
const loadConfirmGift = (strip?: (s: string) => string) => {
  handler = null;
  loadModule('supabase/functions/confirm-gift/index.ts', commonStubs(), strip);
  return handler!;
};
const loadFulfilment = () => loadModule('supabase/functions/_shared/fulfilment.ts', {
  'https://esm.sh/@supabase/supabase-js@2': {},
  './send-push.ts': { sendUserPush: async (_s: unknown, p: unknown) => { effects.pushes.push(p); }, sendUserPushBulk: async () => {} },
  './ticket-receipt.ts': { sendTicketReceipt: async () => {} },
  './send-email.ts': { sendEmail: async (_s: unknown, e: any) => { effects.emails.push(e); return { ok: true, skipped: false }; } },
  './ticket-payment-binding.ts': { paymentBelongsToTicketOrder: () => true },
});

const call = async (h: (r: Request) => Promise<Response>, as: string, body: Record<string, any>) => {
  const r = await h(new Request('https://fake.supabase.co/functions/v1/x', { method: 'POST', headers: { Authorization: `Bearer user-${as}` }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() as Record<string, any> };
};

const basket = (id: string, extra: Record<string, any> = {}) => ({
  client_request_id: id, business_id: BIZ, items: [{ product_id: P_TRACKED, qty: 2 }], fulfilment: 'collect', pay_with: 'card', ...extra,
});
const gift = (id: string, extra: Record<string, any> = {}) => ({
  client_request_id: id, kind: 'unit', unit_item_id: UNIT, recipient_email: 'Friend@Example.org', recipient_name: 'Friend', message: 'Happy birthday', ...extra,
});

const orders = () => num(`select count(*) from public.product_orders`);
const gifts = () => num(`select count(*) from public.book_gifts`);
const reserved = (p = P_TRACKED) => num(`select reserved from public.products where id = '${p}'`);
const stockOf = (p = P_TRACKED) => num(`select stock from public.products where id = '${p}'`);
const orderStatus = (id: string) => scalar(`select status from public.product_orders where id = '${id}'`);
const piCount = () => sim.created.length;

before(() => { assertIsolated(); buildFixture(); });
beforeEach(() => {
  resetData();
  must(`truncate public.business_shipping`);
  sim = new StripeSim(); db = pgClient(); handler = null; savedCardOnFile = false; walletDelay = 0;
  effects = { pushes: [], emails: [], debits: new Map(), transfers: new Set(), walletFail: false, loyalty: 0 };
  installGlobals();
});
after(() => { delete (globalThis as any).Deno; });

/* ═══════════════════════════ PRODUCT ORDERS ═══════════════════════════ */
describe('product orders', () => {
  test('1. a normal card purchase: one order, one PaymentIntent keyed on the ORDER ROW, stock reserved, PI bound to the order', async () => {
    const h = loadProduct();
    const r = await call(h, ALICE, basket('shop-attempt-001'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.clientSecret && r.body.order_id);
    assert.equal(orders(), 1); assert.equal(piCount(), 1); assert.equal(reserved(), 2);
    assert.equal(scalar(`select payment_intent_id from public.product_orders`), sim.created[0].id);
    assert.equal(sim.posts[0].key, `product-order-${r.body.order_id}`);
    assert.equal(sim.created[0].metadata.order_id, r.body.order_id);
  });

  test('missing or malformed client_request_id: 400, and nothing is created, reserved or charged', async () => {
    const h = loadProduct();
    for (const bad of [undefined, '', '   ', 'short', 'x'.repeat(101), 12345, null]) {
      const r = await call(h, ALICE, { ...basket('x'), client_request_id: bad });
      assert.equal(r.status, 400, String(bad)); assert.equal(r.body.code, 'attempt_id_required');
    }
    assert.equal(orders(), 0); assert.equal(piCount(), 0); assert.equal(reserved(), 0);
  });

  test('3. exact retry (sequential): the same order and the same payment come back; nothing more is made or reserved', async () => {
    const h = loadProduct();
    const a = await call(h, ALICE, basket('shop-attempt-001'));
    const b = await call(h, ALICE, basket('shop-attempt-001'));
    const c = await call(h, ALICE, basket('shop-attempt-001'));
    assert.equal(b.body.order_id, a.body.order_id); assert.equal(c.body.order_id, a.body.order_id);
    assert.equal(b.body.clientSecret, a.body.clientSecret, 'the retry resumes the SAME PaymentIntent');
    assert.equal(orders(), 1); assert.equal(piCount(), 1); assert.equal(reserved(), 2);
    assert.equal(sim.posts.length, 1, 'Stripe was asked to create a PaymentIntent exactly once');
  });

  for (const n of [2, 5]) {
    test(`${n === 2 ? 5 : 6}. ${n} simultaneous submissions: one order, ONE PaymentIntent, stock reserved once`, async () => {
      sim.delayMs = 250;                                  // keep the first request mid-flight while the others arrive
      const h = loadProduct();
      const rs = await Promise.all(Array.from({ length: n }, () => call(h, ALICE, basket('shop-attempt-001'))));
      assert.equal(orders(), 1, 'one order'); assert.equal(piCount(), 1, 'one PaymentIntent'); assert.equal(reserved(), 2, 'stock once');
      const ok = rs.filter((r) => r.status === 200);
      assert.ok(ok.length >= 1, 'at least one request got the payment');
      for (const r of rs.filter((x) => x.status !== 200)) { assert.equal(r.status, 409); assert.equal(r.body.code, 'in_progress'); }
      if (n === 5) assert.ok(rs.some((r) => r.status === 409), 'the requests really overlapped: at least one was told the payment is already in progress');
      assert.equal(new Set(ok.map((r) => r.body.order_id)).size, 1, 'every success is the same order');
      assert.equal(new Set(ok.map((r) => r.body.clientSecret)).size, 1, 'and the same payment');
      assert.equal(num(`select count(*) from public.product_orders where processing_claimed_at is not null`), 0, 'the lease is released');
    });
  }

  test('9. retry after the HTTP response was lost: Stripe created the object, the client never saw it; the retry gets THE SAME one', async () => {
    const h = loadProduct();
    sim.loseResponseOnce = true;
    const first = await call(h, ALICE, basket('shop-attempt-001'));
    assert.equal(first.status, 500, 'the first call failed from the client\'s point of view');
    assert.equal(piCount(), 1, 'but Stripe did create the PaymentIntent');
    assert.equal(scalar(`select coalesce(payment_intent_id, '(none)') from public.product_orders`), '(none)', 'and our order was never told');
    const retry = await call(h, ALICE, basket('shop-attempt-001'));
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(piCount(), 1, 'still one PaymentIntent: the deterministic key made Stripe return the original');
    assert.equal(retry.body.clientSecret, sim.created[0].client_secret);
    assert.equal(sim.posts.length, 2); assert.equal(sim.posts[0].key, sim.posts[1].key);
    assert.equal(orders(), 1); assert.equal(reserved(), 2);
    assert.equal(scalar(`select payment_intent_id from public.product_orders`), sim.created[0].id, 'now bound');
  });

  test('10. the order row exists but Stripe was never reached (network failure before creation): the retry creates it once', async () => {
    const h = loadProduct();
    sim.failBeforeCreateOnce = true;
    assert.equal((await call(h, ALICE, basket('shop-attempt-001'))).status, 500);
    assert.equal(orders(), 1); assert.equal(piCount(), 0); assert.equal(reserved(), 2, 'the hold stands for the retry');
    const retry = await call(h, ALICE, basket('shop-attempt-001'));
    assert.equal(retry.status, 200); assert.equal(piCount(), 1); assert.equal(orders(), 1); assert.equal(reserved(), 2);
  });

  test('11. another user cannot use, resume or see the first user\'s attempt: the same id is a separate purchase', async () => {
    const h = loadProduct();
    const a = await call(h, ALICE, basket('shared-attempt-id'));
    const b = await call(h, BOB, basket('shared-attempt-id'));
    assert.notEqual(b.body.order_id, a.body.order_id);
    assert.notEqual(b.body.clientSecret, a.body.clientSecret, 'Bob never receives Alice\'s client secret');
    assert.equal(scalar(`select buyer_id from public.product_orders where id = '${b.body.order_id}'`), BOB);
    assert.equal(orders(), 2); assert.equal(piCount(), 2);
    assert.notEqual(sim.posts[0].key, sim.posts[1].key, 'different Stripe keys');
  });

  test('12. the same user with a NEW id deliberately makes a second purchase', async () => {
    const h = loadProduct();
    const a = await call(h, ALICE, basket('shop-attempt-001')); const b = await call(h, ALICE, basket('shop-attempt-002'));
    assert.notEqual(b.body.order_id, a.body.order_id);
    assert.equal(orders(), 2); assert.equal(piCount(), 2); assert.equal(reserved(), 4);
  });

  test('13. the client cannot choose the Stripe idempotency key: whatever it sends, Stripe is asked with product-order-<order id>', async () => {
    const h = loadProduct();
    const r = await call(h, ALICE, basket('shop-attempt-001', { idempotency_key: 'attacker-key', stripe_idempotency_key: 'attacker-key', 'Idempotency-Key': 'attacker-key', payment_intent_id: 'pi_victim' }));
    assert.equal(r.status, 200);
    assert.equal(sim.posts.length, 1);
    assert.equal(sim.posts[0].key, `product-order-${r.body.order_id}`);
    assert.ok(!sim.posts[0].key!.includes('shop-attempt-001'), 'the client\'s attempt id is not even part of the key');
    assert.ok(!sim.posts[0].key!.includes('attacker'));
  });

  test('a reused id for a DIFFERENT basket is refused (409) and creates nothing; the original attempt still resumes', async () => {
    const h = loadProduct();
    const a = await call(h, ALICE, basket('shop-attempt-001'));
    const other = await call(h, ALICE, basket('shop-attempt-001', { items: [{ product_id: P_TRACKED, qty: 3 }] }));
    assert.equal(other.status, 409); assert.equal(other.body.code, 'idempotency_conflict');
    const wallet = await call(h, ALICE, basket('shop-attempt-001', { pay_with: 'wallet' }));
    assert.equal(wallet.status, 409);
    assert.equal(orders(), 1); assert.equal(piCount(), 1); assert.equal(reserved(), 2);
    assert.equal((await call(h, ALICE, basket('shop-attempt-001'))).body.order_id, a.body.order_id);
  });

  test('14. stock: a one-off is reserved once for the attempt and a different attempt cannot take it; sold-out creates nothing', async () => {
    const h = loadProduct();
    const one = { items: [{ product_id: P_ONEOFF, qty: 1 }] };
    const a = await call(h, ALICE, basket('oneoff-attempt-1', one));
    await call(h, ALICE, basket('oneoff-attempt-1', one));
    assert.equal(reserved(P_ONEOFF), 1);
    const rival = await call(h, BOB, basket('oneoff-attempt-2', one));
    assert.equal(rival.status, 409); assert.equal(rival.body.code, 'sold_out');
    assert.equal(orders(), 1); assert.equal(piCount(), 1); assert.ok(a.body.order_id);
  });

  test('15. wallet: five simultaneous submissions debit ONCE, settle ONCE, commit stock ONCE, notify ONCE', async () => {
    walletDelay = 200;
    const h = loadProduct();
    const rs = await Promise.all([0, 1, 2, 3, 4].map(() => call(h, ALICE, basket('wallet-attempt-1', { pay_with: 'wallet' }))));
    assert.equal(orders(), 1);
    assert.equal(effects.debits.size, 1, 'one wallet debit');
    const orderId = scalar(`select id from public.product_orders`);
    assert.deepEqual([...effects.debits.keys()], [`product-order-${orderId}`], 'keyed on the order row — now the same for every repeat');
    assert.equal(orderStatus(orderId), 'paid'); assert.equal(scalar(`select paid_via from public.product_orders`), 'wallet');
    assert.equal(reserved(), 0, 'reservation consumed'); assert.equal(stockOf(), 8, 'stock committed once (10 − 2), not five times');
    assert.equal(effects.pushes.length, 1, 'the shop is told once');
    for (const r of rs) { assert.ok(r.status === 200 || (r.status === 409 && r.body.code === 'in_progress'), JSON.stringify(r)); }
    assert.ok(rs.some((r) => r.status === 200 && r.body.charged === true));
    assert.equal(piCount(), 0, 'no Stripe object for a wallet order');
    assert.ok(rs.some((r) => r.status === 409), 'the requests really overlapped');
  });

  test('wallet replay after the order is paid: reports it paid, takes nothing, commits nothing', async () => {
    const h = loadProduct();
    await call(h, ALICE, basket('wallet-attempt-1', { pay_with: 'wallet' }));
    const again = await call(h, ALICE, basket('wallet-attempt-1', { pay_with: 'wallet' }));
    assert.equal(again.status, 200); assert.equal(again.body.charged, true); assert.equal(again.body.replayed, true);
    assert.equal(effects.debits.size, 1); assert.equal(stockOf(), 8); assert.equal(effects.pushes.length, 1);
  });

  test('wallet failure (insufficient funds) cancels the attempt and returns the stock exactly once; a NEW id then works', async () => {
    const h = loadProduct();
    effects.walletFail = true;
    const r = await call(h, ALICE, basket('wallet-attempt-1', { pay_with: 'wallet' }));
    assert.equal(r.status, 402); assert.equal(reserved(), 0);
    assert.equal(scalar(`select status from public.product_orders`), 'cancelled');
    const replay = await call(h, ALICE, basket('wallet-attempt-1', { pay_with: 'wallet' }));
    assert.equal(replay.status, 409); assert.equal(replay.body.code, 'checkout_expired');
    effects.walletFail = false;
    const fresh = await call(h, ALICE, basket('wallet-attempt-2', { pay_with: 'wallet' }));
    assert.equal(fresh.status, 200); assert.equal(fresh.body.charged, true);
  });

  test('saved card: five simultaneous submissions charge ONCE', async () => {
    savedCardOnFile = true; sim.delayMs = 250;
    const h = loadProduct();
    const rs = await Promise.all([0, 1, 2, 3, 4].map(() => call(h, ALICE, basket('saved-attempt-1', { use_saved_card: true }))));
    assert.equal(piCount(), 1, 'one charge'); assert.equal(orders(), 1); assert.equal(reserved(), 2);
    assert.ok(sim.posts.every((p) => p.body.includes('confirm=true')));
    for (const r of rs) assert.ok((r.status === 200 && r.body.charged === true) || (r.status === 409 && r.body.code === 'in_progress'), JSON.stringify(r));
    assert.ok(rs.some((r) => r.status === 200));
  });

  test('20. a declined saved card ends the attempt: stock goes back ONCE, the id is not resurrectable, a new id works', async () => {
    savedCardOnFile = true; sim.declineConfirm = true;
    const h = loadProduct();
    const r = await call(h, ALICE, basket('saved-attempt-1', { use_saved_card: true }));
    assert.equal(r.status, 402); assert.equal(r.body.status, 'failed');
    assert.equal(reserved(), 0, 'released'); assert.equal(scalar(`select status from public.product_orders`), 'cancelled');
    const replay = await call(h, ALICE, basket('saved-attempt-1', { use_saved_card: true }));
    assert.equal(replay.status, 409); assert.equal(replay.body.code, 'checkout_expired');
    assert.equal(reserved(), 0, 'the replay reserved nothing');
    sim.declineConfirm = false;
    const fresh = await call(h, ALICE, basket('saved-attempt-2', { use_saved_card: true }));
    assert.equal(fresh.status, 200); assert.equal(fresh.body.charged, true);
  });

  test('20. an abandoned unpaid order does not lock the buyer out: it expires and its stock is released; a new attempt proceeds', async () => {
    const h = loadProduct();
    const a = await call(h, ALICE, basket('shop-attempt-001'));
    assert.equal(reserved(), 2);
    must(`update public.product_orders set expires_at = now() - interval '1 minute'`);
    const replay = await call(h, ALICE, basket('shop-attempt-001'));
    assert.equal(replay.status, 409); assert.equal(replay.body.code, 'checkout_expired');
    assert.equal(orderStatus(a.body.order_id), 'expired'); assert.equal(reserved(), 0);
    const fresh = await call(h, ALICE, basket('shop-attempt-002'));
    assert.equal(fresh.status, 200); assert.equal(reserved(), 2);
  });

  test('a card-form payment Stripe has since cancelled ends the attempt rather than being resumed', async () => {
    const h = loadProduct();
    const a = await call(h, ALICE, basket('shop-attempt-001'));
    sim.override.set(sim.created[0].id, 'canceled');
    const replay = await call(h, ALICE, basket('shop-attempt-001'));
    assert.equal(replay.status, 402); assert.equal(orderStatus(a.body.order_id), 'cancelled'); assert.equal(reserved(), 0);
  });

  test('a payment that succeeded while the buyer was away is reported as paid on the retry, not charged again', async () => {
    const h = loadProduct();
    await call(h, ALICE, basket('shop-attempt-001'));
    sim.override.set(sim.created[0].id, 'succeeded');
    const replay = await call(h, ALICE, basket('shop-attempt-001'));
    assert.equal(replay.status, 200); assert.equal(replay.body.charged, true);
    assert.equal(piCount(), 1); assert.equal(sim.posts.length, 1);
  });

  test('anon gains nothing: an unauthenticated request is refused before anything is touched', async () => {
    const h = loadProduct();
    const r = await h(new Request('https://fake.supabase.co/functions/v1/x', { method: 'POST', body: JSON.stringify(basket('shop-attempt-001')) }));
    assert.equal(r.status, 401); assert.equal(orders(), 0); assert.equal(piCount(), 0);
  });
});

/* ═══════════════════════════ WEBHOOK / CONFIRMATION ═══════════════════════════ */
describe('webhook replay and one-payment-one-purchase', () => {
  test('18. fulfilProductOrder: the same payment delivered five times at once flips the order ONCE, commits stock ONCE, notifies ONCE', async () => {
    const h = loadProduct();
    const a = await call(h, ALICE, basket('shop-attempt-001'));
    const pi = sim.created[0];
    const f = loadFulfilment();
    const rs = await Promise.all([0, 1, 2, 3, 4].map(() => f.fulfilProductOrder(db, { id: pi.id, amount: 2000, metadata: pi.metadata })));
    assert.equal(rs.filter((r: any) => r.granted).length, 1, 'exactly one delivery performed the grant');
    assert.equal(orderStatus(a.body.order_id), 'paid');
    assert.equal(stockOf(), 8); assert.equal(reserved(), 0); assert.equal(effects.pushes.length, 1);
  });

  test('19. one Stripe payment cannot satisfy two purchases: applying order A\'s payment to order B is refused by the database', async () => {
    const h = loadProduct();
    const a = await call(h, ALICE, basket('shop-attempt-001')); const b = await call(h, ALICE, basket('shop-attempt-002'));
    const f = loadFulfilment();
    const piA = sim.created[0];
    await f.fulfilProductOrder(db, { id: piA.id, amount: 2000, metadata: piA.metadata });
    // a (mis-routed or replayed) event claiming A's payment for order B
    const crossed = await f.fulfilProductOrder(db, { id: piA.id, amount: 2000, metadata: { ...piA.metadata, order_id: b.body.order_id } });
    assert.equal(crossed.granted, false);
    assert.equal(orderStatus(b.body.order_id), 'pending', 'order B was NOT marked paid by order A\'s payment');
    assert.equal(orderStatus(a.body.order_id), 'paid');
    assert.equal(stockOf(), 8, 'only A\'s stock was committed');
  });

  test('17/18. gifts: fulfilGift five times at once sends ONE email and mints ONE code', async () => {
    const h = loadGift();
    const g = await call(h, ALICE, gift('gift-attempt-001'));
    const pi = sim.created[0];
    const f = loadFulfilment();
    const rs = await Promise.all([0, 1, 2, 3, 4].map(() => f.fulfilGift(db, { id: pi.id, amount: 3000, metadata: pi.metadata })));
    assert.equal(rs.filter((r: any) => r.granted).length, 1);
    assert.equal(effects.emails.length, 1, 'one email');
    assert.equal(scalar(`select status from public.book_gifts where id = '${g.body.gift_id}'`), 'sent');
    assert.ok(effects.emails[0].variables.code === scalar(`select code from public.book_gifts where id = '${g.body.gift_id}'`), 'the emailed code is the stored code');
  });

  test('17. confirm-gift: five simultaneous confirms (the web client auto-retries) plus the webhook deliver ONE gift, ONE code, ONE email', async () => {
    const gh = loadGift();
    const g = await call(gh, ALICE, gift('gift-attempt-001'));
    const pi = sim.created[0];
    sim.override.set(pi.id, 'succeeded');
    const ch = loadConfirmGift();
    const f = loadFulfilment();
    const confirms = [0, 1, 2, 3, 4].map(() => call(ch, ALICE, { gift_id: g.body.gift_id, payment_intent_id: pi.id }));
    const hook = f.fulfilGift(db, { id: pi.id, amount: 3000, metadata: pi.metadata });
    const rs = await Promise.all([...confirms, hook]);
    assert.equal(effects.emails.length, 1, `exactly one email, got ${effects.emails.length}`);
    const stored = scalar(`select code from public.book_gifts where id = '${g.body.gift_id}'`);
    assert.equal(effects.emails[0].variables.code, stored, 'and the code that was emailed is the one that works');
    for (const r of rs.slice(0, 5) as any[]) { assert.equal(r.status, 200); assert.equal(r.body.code, stored, 'every confirm reports the SAME code'); }
    assert.equal(gifts(), 1);
  });

  test('CONTROL: without confirm-gift\'s atomic claim, the same race sends several emails and overwrites the code', async () => {
    const gh = loadGift();
    const g = await call(gh, ALICE, gift('gift-attempt-001'));
    const pi = sim.created[0]; sim.override.set(pi.id, 'succeeded');
    const ch = loadConfirmGift((s) => { const out = s.replace(".not('status', 'in', '(sent,claimed,used)')\n      .select('id');", ".select('id');"); assert.notEqual(out, s, 'the claim guard was found and removed'); return out; });
    await Promise.all([0, 1, 2, 3, 4].map(() => call(ch, ALICE, { gift_id: g.body.gift_id, payment_intent_id: pi.id })));
    assert.ok(effects.emails.length > 1, `without the guard several emails go out (saw ${effects.emails.length})`);
    const codes = new Set(effects.emails.map((e) => e.variables.code));
    assert.ok(codes.size > 1, 'and they carry DIFFERENT codes: the recipient is left with dead links');
  });
});

/* ═══════════════════════════ GIFTS ═══════════════════════════ */
describe('gifts', () => {
  test('2. a normal gift: one pending gift, one PaymentIntent keyed on the GIFT ROW, bound to it', async () => {
    const h = loadGift();
    const r = await call(h, ALICE, gift('gift-attempt-001'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.clientSecret && r.body.gift_id);
    assert.equal(gifts(), 1); assert.equal(piCount(), 1);
    assert.equal(sim.posts[0].key, `gift-${r.body.gift_id}`, 'the PaymentSheet route now has a key too — it had none');
    assert.equal(scalar(`select payment_intent_id from public.book_gifts`), sim.created[0].id);
    assert.equal(scalar(`select recipient_email from public.book_gifts`), 'friend@example.org');
  });

  test('missing client_request_id: 400, nothing created', async () => {
    const h = loadGift();
    for (const bad of [undefined, '', 'short', 'x'.repeat(101)]) assert.equal((await call(h, ALICE, { ...gift('x'), client_request_id: bad })).status, 400);
    assert.equal(gifts(), 0); assert.equal(piCount(), 0);
  });

  test('4. exact retry returns the same gift and the same payment', async () => {
    const h = loadGift();
    const a = await call(h, ALICE, gift('gift-attempt-001')); const b = await call(h, ALICE, gift('gift-attempt-001'));
    assert.equal(b.body.gift_id, a.body.gift_id); assert.equal(b.body.clientSecret, a.body.clientSecret);
    assert.equal(gifts(), 1); assert.equal(piCount(), 1); assert.equal(sim.posts.length, 1);
  });

  for (const n of [2, 5]) {
    test(`${n === 2 ? 7 : 8}. ${n} simultaneous gift submissions: one gift, one code, ONE PaymentIntent`, async () => {
      sim.delayMs = 250;
      const h = loadGift();
      const rs = await Promise.all(Array.from({ length: n }, () => call(h, ALICE, gift('gift-attempt-001'))));
      assert.equal(gifts(), 1); assert.equal(piCount(), 1); assert.equal(num(`select count(distinct code) from public.book_gifts`), 1);
      for (const r of rs.filter((x) => x.status !== 200)) { assert.equal(r.status, 409); assert.equal(r.body.code, 'in_progress'); }
      const ok = rs.filter((r) => r.status === 200);
      assert.ok(ok.length >= 1); assert.equal(new Set(ok.map((r) => r.body.gift_id)).size, 1);
      if (n === 5) assert.ok(rs.some((r) => r.status === 409), 'the requests really overlapped');
      assert.equal(effects.emails.length, 0, 'nothing is emailed until the payment lands');
    });
  }

  test('9/10. retry after the response was lost (Stripe created it): the retry gets the SAME PaymentIntent', async () => {
    const h = loadGift();
    sim.loseResponseOnce = true;
    assert.equal((await call(h, ALICE, gift('gift-attempt-001'))).status, 500);
    assert.equal(piCount(), 1);
    const retry = await call(h, ALICE, gift('gift-attempt-001'));
    assert.equal(retry.status, 200); assert.equal(piCount(), 1); assert.equal(gifts(), 1);
    assert.equal(retry.body.clientSecret, sim.created[0].client_secret);
  });

  test('11. another user cannot reuse or see the first user\'s gift attempt', async () => {
    const h = loadGift();
    const a = await call(h, ALICE, gift('shared-gift-id-1')); const b = await call(h, BOB, gift('shared-gift-id-1'));
    assert.notEqual(b.body.gift_id, a.body.gift_id); assert.notEqual(b.body.clientSecret, a.body.clientSecret);
    assert.equal(gifts(), 2); assert.equal(piCount(), 2);
  });

  test('12. the same user with a new id sends a second gift', async () => {
    const h = loadGift();
    const a = await call(h, ALICE, gift('gift-attempt-001')); const b = await call(h, ALICE, gift('gift-attempt-002'));
    assert.notEqual(a.body.gift_id, b.body.gift_id); assert.equal(gifts(), 2); assert.equal(piCount(), 2);
  });

  test('13. the client cannot choose the Stripe key', async () => {
    const h = loadGift();
    const r = await call(h, ALICE, gift('gift-attempt-001', { idempotency_key: 'attacker', payment_intent_id: 'pi_victim' }));
    assert.equal(sim.posts[0].key, `gift-${r.body.gift_id}`);
    assert.ok(!sim.posts[0].key!.includes('attacker') && !sim.posts[0].key!.includes('gift-attempt-001'));
  });

  test('a reused id for a different recipient, message or payment method is refused and changes nothing', async () => {
    const h = loadGift();
    await call(h, ALICE, gift('gift-attempt-001'));
    for (const o of [{ recipient_email: 'thief@example.org' }, { message: 'something else' }, { pay_with_wallet: true }]) {
      const r = await call(h, ALICE, gift('gift-attempt-001', o));
      assert.equal(r.status, 409, JSON.stringify(o)); assert.equal(r.body.code, 'idempotency_conflict');
    }
    assert.equal(gifts(), 1); assert.equal(piCount(), 1);
  });

  test('wallet: five simultaneous submissions debit ONCE and make ONE transfer (keyed on the gift row)', async () => {
    walletDelay = 200;
    const h = loadGift();
    const rs = await Promise.all([0, 1, 2, 3, 4].map(() => call(h, ALICE, gift('gift-wallet-1', { pay_with_wallet: true }))));
    assert.equal(gifts(), 1);
    const giftId = scalar(`select id from public.book_gifts`);
    assert.deepEqual([...effects.debits.keys()], [`gift:${giftId}`]);
    assert.equal(effects.transfers.size, 1, 'one Connect transfer');
    assert.match(scalar(`select payment_intent_id from public.book_gifts`), /^wallet_/);
    for (const r of rs) assert.ok((r.status === 200 && r.body.charged === true) || (r.status === 409 && r.body.code === 'in_progress'), JSON.stringify(r));
    assert.equal(piCount(), 0);
    // and a later retry just reports it paid
    const again = await call(h, ALICE, gift('gift-wallet-1', { pay_with_wallet: true }));
    assert.equal(again.status, 200); assert.equal(effects.debits.size, 1);
  });

  test('wallet failure cancels (never deletes) the attempt; the id is spent; a new id works', async () => {
    const h = loadGift();
    effects.walletFail = true;
    assert.equal((await call(h, ALICE, gift('gift-wallet-1', { pay_with_wallet: true }))).status, 402);
    assert.equal(scalar(`select status from public.book_gifts`), 'cancelled');
    assert.equal(gifts(), 1, 'the row is still there: a concurrent repeat cannot find it vanished');
    const replay = await call(h, ALICE, gift('gift-wallet-1', { pay_with_wallet: true }));
    assert.equal(replay.status, 409); assert.equal(replay.body.code, 'checkout_expired');
    effects.walletFail = false;
    assert.equal((await call(h, ALICE, gift('gift-wallet-2', { pay_with_wallet: true }))).status, 200);
  });

  test('saved card: simultaneous submissions charge ONCE; a decline ends the attempt and a new id works', async () => {
    savedCardOnFile = true; sim.delayMs = 250;
    const h = loadGift();
    await Promise.all([0, 1, 2].map(() => call(h, ALICE, gift('gift-saved-1', { use_saved_card: true }))));
    assert.equal(piCount(), 1); assert.equal(gifts(), 1);
    sim.declineConfirm = true;
    const declined = await call(h, ALICE, gift('gift-saved-2', { use_saved_card: true }));
    assert.equal(declined.status, 402);
    assert.equal(scalar(`select status from public.book_gifts where client_request_id = 'gift-saved-2'`), 'cancelled');
    assert.equal((await call(h, ALICE, gift('gift-saved-2', { use_saved_card: true }))).body.code, 'checkout_expired');
    sim.declineConfirm = false;
    assert.equal((await call(h, ALICE, gift('gift-saved-3', { use_saved_card: true }))).status, 200);
  });

  test('"use my saved card" with none on file falls back to the card form, and a retry resumes THAT form payment (not a decline)', async () => {
    savedCardOnFile = false;
    const h = loadGift();
    const a = await call(h, ALICE, gift('gift-form-fallback', { use_saved_card: true }));
    assert.ok(a.body.clientSecret);
    const b = await call(h, ALICE, gift('gift-form-fallback', { use_saved_card: true }));
    assert.equal(b.status, 200); assert.equal(b.body.clientSecret, a.body.clientSecret);
    assert.equal(scalar(`select status from public.book_gifts`), 'pending_payment'); assert.equal(piCount(), 1);
  });
});

/* ═══════════════════════════ CONTROLS ═══════════════════════════ */
describe('controls — each protection is load-bearing', () => {
  test('24. WITHOUT the Stripe idempotency key, the lost-response retry creates a SECOND PaymentIntent (a double charge in waiting)', async () => {
    const mutated = attemptSrc((s) => { const out = s.replace("'Idempotency-Key': idempotencyKey", ''); assert.notEqual(out, s, 'the key header was found and removed'); return out; });
    const h = loadProduct({ purchase: mutated });
    sim.loseResponseOnce = true;
    await call(h, ALICE, basket('shop-attempt-001'));
    const retry = await call(h, ALICE, basket('shop-attempt-001'));
    assert.equal(retry.status, 200);
    assert.equal(piCount(), 2, 'two PaymentIntents for one purchase attempt');
    assert.equal(orders(), 1, '(the database claim still holds — it is the Stripe key that is missing)');
  });

  test('24. the same control for gifts', async () => {
    const mutated = attemptSrc((s) => s.replace("'Idempotency-Key': idempotencyKey", ''));
    const h = loadGift({ purchase: mutated });
    sim.loseResponseOnce = true;
    await call(h, ALICE, gift('gift-attempt-001'));
    await call(h, ALICE, gift('gift-attempt-001'));
    assert.equal(piCount(), 2);
  });

  test('23. WITHOUT the database uniqueness, five simultaneous submissions make five orders, reserve five times and create five PaymentIntents', async () => {
    const migration = readFileSync(ATTEMPT_MIGRATION, 'utf8');
    const start = migration.indexOf('create or replace function public.claim_product_order(');
    const fnText = migration.slice(start, migration.indexOf('$$;', migration.indexOf('as $$', start)) + 3);
    const mutant = fnText.replace(/\s+on conflict \(buyer_id, client_request_id\) where client_request_id is not null do nothing/, '');
    assert.notEqual(mutant, fnText);
    must(`drop index public.product_orders_buyer_request_key`); must(mutant);
    try {
      sim.delayMs = 250;
      const h = loadProduct();
      // distinct processing leases would normally serialise the money step per order; with five orders there are five leases
      await Promise.all([0, 1, 2, 3, 4].map(() => call(h, ALICE, basket('shop-attempt-001'))));
      assert.ok(orders() > 1, `duplicate orders for one attempt (saw ${orders()})`);
      assert.ok(reserved() > 2, `stock reserved more than once (saw ${reserved()})`);
      assert.ok(piCount() > 1, `more than one PaymentIntent (saw ${piCount()})`);
    } finally {
      resetData();
      must(`drop function public.claim_product_order(uuid, text, text, uuid, text, jsonb, integer, integer, integer, integer, text, text, text, text, text, text, integer)`);
      assert.equal(execFileSync(ATTEMPT_MIGRATION).err, null);
      must(`grant execute on all functions in schema public to service_role`);
    }
  });
});
