/**
 * wallet-ticket-gift-self-payment.node.test.ts — card-funded wallet value must not be convertible into the buyer's own cash
 * through a wallet TICKET or a wallet GIFT.
 *
 * THE PATH
 *
 *   top up £500 by card
 *   → "buy" a ticket / "gift" an item that belongs to a hub or business YOU control, paying from the wallet
 *   → the wallet route sends the money to the seller's connected account by Connect transfer — an account you own
 *   → charge the card back
 *
 * Refund and dispute recovery (wallet_recover_topup) can only take back what is still IN the wallet. The transfer had already
 * left. wallet-checkout (donations, memberships, passes), the till and product orders all ask "does this payer control the
 * destination account?" before they debit (selfPaymentBlock). create-event-ticket-intent and create-gift-intent did not.
 *
 * WHAT RUNS
 *
 * The REAL create-event-ticket-intent and create-gift-intent handlers, and the real selfPaymentBlock, driven against an in-memory
 * Supabase, a spy standing in for the wallet ledger (debitAndTransfer) and a Stripe that fails the test if it is called. Nothing
 * leaves the process; no wallet, order or transfer exists anywhere. The control strips the guard out of each handler's own
 * source and shows the original cash-out succeeding; the same request against the real handler is refused before anything is
 * reserved, created or debited. (The guard's SQL — who counts as controlling an account — is proved against a real database in
 * wallet-card-cashout.node.test.ts.)
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadModule, REPO_ROOT } from './_support/load-source.ts';

type Row = Record<string, any>;

const EVENT = 'e1000000-0000-4000-8000-0000000000e1';
const TT = 'f1000000-0000-4000-8000-0000000000f1';
const ORDER = 'a0000000-0000-4000-8000-0000000000a0';
const OWNER = '0e000000-0000-4000-8000-0000000000e0';      // controls acct_organiser (via the event's hub and a second hub)
const SIBLING = '0f000000-0000-4000-8000-0000000000f0';     // controls a DIFFERENT hub that points at the SAME account
const BOB = 'b0000000-0000-4000-8000-0000000000b0';         // an ordinary customer
const ACCT = 'acct_organiser';

/** who controls which connected account — the model of what wallet_destination_self_controlled answers (its SQL is tested separately) */
let controls: Record<string, string[]>;
let sc: { account: string | null; isDemo: boolean; price: number };
let calls: { debits: Row[]; reserved: number; released: number; rpc: string[]; inserts: Row[]; updates: Row[]; deletes: string[] };
let stripeCalls: string[];
let guardRpcError: boolean;

const selfPaymentModule = () => loadModule('supabase/functions/_shared/self-payment.ts', { 'https://esm.sh/@supabase/supabase-js@2': {} });

function fakeSupabase() {
  const tables: Record<string, any> = {
    events: { id: EVENT, title: 'Up Helly Aa', starts_at: '2026-12-01T00:00:00Z', venue: 'Lerwick', formatted_address: 'Lerwick', status: 'published', organiser_business_id: null, organiser_hub_id: 'hub1' },
    event_ticket_types: [{ id: TT, name: 'Adult', price_pence: sc.price, per_order_max: 10, is_active: true, event_id: EVENT, sale_starts_at: null, sale_ends_at: null }],
    book_unit_items: { id: 'item1', business_id: 'biz1', name: 'Hamper', price_pence: 2000, stock: 5, is_active: true },
  };
  const chain = (table: string) => {
    const c: any = {}; let isInsert = false; let isDelete = false;
    for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit', 'neq']) c[m] = () => c;
    c.single = async () => (isInsert ? { data: { id: 'gift1' }, error: null } : { data: Array.isArray(tables[table]) ? tables[table][0] : tables[table] ?? null, error: null });
    c.maybeSingle = c.single;
    c.insert = (v: Row) => { calls.inserts.push({ table, v }); isInsert = true; return c; };
    c.update = (v: Row) => { calls.updates.push({ table, v }); return c; };
    c.delete = () => { isDelete = true; calls.deletes.push(table); return c; };
    c.then = (res: any, rej: any) => Promise.resolve({ data: Array.isArray(tables[table]) ? tables[table] : (tables[table] ? [tables[table]] : []), error: null }).then(res, rej);
    return c;
  };
  return {
    from: chain,
    rpc: async (name: string, args: Row) => {
      calls.rpc.push(name);
      switch (name) {
        case 'event_payout_destination':
        case 'business_payout_destination': return { data: [{ account_id: sc.account, is_demo: sc.isDemo }], error: null };
        case 'wallet_destination_self_controlled':
          if (guardRpcError) return { data: null, error: { message: 'boom' } };
          return { data: !!args.p_account && (controls[args.p_account] ?? []).includes(args.p_user), error: null };
        case 'reserve_ticket_basket': calls.reserved++; return { data: { order_id: ORDER, ticket_ids: ['t1'], already: false, status: 'pending' }, error: null };
        case 'release_ticket_order': calls.released++; return { data: true, error: null };
        // the atomic attempt claim + lease (their SQL is proved in purchase-attempt-idempotency.node.test.ts)
        case 'claim_gift_purchase': return { data: { gift_id: 'gift1', replayed: false, status: 'pending_payment', pay_mode: args.p_pay_mode, payment_intent_id: null }, error: null };
        case 'claim_purchase_processing': return { data: true, error: null };
        default: return { data: null, error: null };
      }
    },
  };
}
const createClient = (_u: string, key: string, opts: Row = {}) => key === 'anon-key'
  ? { auth: { getUser: async () => ({ data: { user: { id: String(opts?.global?.headers?.Authorization ?? '').replace('Bearer user-', '') } }, error: null }) } }
  : fakeSupabase();

function installGlobals() {
  (globalThis as any).Deno = { env: { get: (k: string) => ({ SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_ANON_KEY: 'anon-key', SUPABASE_SERVICE_ROLE_KEY: 'svc-key', STRIPE_SECRET_KEY: 'sk_test_fake' } as Record<string, string>)[k] } };
  (globalThis as any).fetch = async (url: string, init: any = {}) => {
    stripeCalls.push(`${init.method ?? 'GET'} ${url}`);
    if (/payment_intents$/.test(url)) return { ok: true, status: 200, json: async () => ({ id: 'pi_card', client_secret: 'pi_card_secret', status: 'requires_payment_method' }) };
    throw new Error(`unexpected network call ${url}`);
  };
}

/** the wallet ledger, as a spy: records every debit and every transfer it is asked to make */
const walletLedgerStub = () => ({
  debitAndTransfer: async (_svc: any, args: Row) => { calls.debits.push(args); return { ok: true, balancePence: 0, transactionId: 'tx-1', transferId: args.transfer ? 'tr_1' : null, alreadyApplied: false }; },
  selfPaymentBlock: selfPaymentModule().selfPaymentBlock,
});

/** removes the self-payment guard from a handler's own source: the handler as it was */
const withoutGuard = (src: string) => src.replace(/\n\s*\/\/ ── You cannot pay yourself[\s\S]*?\n    \}\n(?=\n)/, '\n');

let handler: (r: Request) => Promise<Response>;
function loadTickets(strip = false) {
  loadModule('supabase/functions/create-event-ticket-intent/index.ts', {
    'https://deno.land/std@0.168.0/http/server.ts': { serve: (h: any) => { handler = h; } },
    'https://esm.sh/@supabase/supabase-js@2': { createClient },
    '../_shared/ticket-receipt.ts': { sendTicketReceipt: async () => {} },
    '../_shared/ticket-quantities.ts': loadModule('supabase/functions/_shared/ticket-quantities.ts', {}),
    '../_shared/wallet-ledger.ts': walletLedgerStub(),
    '../_shared/wallet-liquidity-gate.ts': { withWalletLiquidityGate: async (_s: any, _p: number, run: () => Promise<any>) => ({ ok: true, value: await run() }) },
    '../_shared/safe-error.ts': { safeError: () => 'internal error' },
    '../_shared/rate-limit.ts': { enforcePaymentStart: async () => ({ ok: true }) },
    '../_shared/stripe-sca.ts': loadModule('supabase/functions/_shared/stripe-sca.ts', {}),
    '../_shared/saved-card-state.ts': { resolveSavedCard: async () => ({ kind: 'none' }), boundCustomerFor: async () => null },
    '../_shared/stripe-errors.ts': { stripeError: (e: any) => e, checkoutFailure: () => null },
  }, strip ? withoutGuard : undefined);
}
function loadGifts(strip = false) {
  loadModule('supabase/functions/create-gift-intent/index.ts', {
    '../_shared/purchase-attempt.ts': loadModule('supabase/functions/_shared/purchase-attempt.ts', {}),
    'https://deno.land/std@0.168.0/http/server.ts': { serve: (h: any) => { handler = h; } },
    'https://esm.sh/@supabase/supabase-js@2': { createClient },
    '../_shared/commission.ts': { calculateCommission: (pence: number) => ({ fee_pence: Math.floor(pence * 0.05) }) },
    '../_shared/commission-config.ts': { getCommissionConfig: async () => ({}) },
    '../_shared/wallet-ledger.ts': walletLedgerStub(),
    '../_shared/wallet-liquidity-gate.ts': { withWalletLiquidityGate: async (_s: any, _p: number, run: () => Promise<any>) => ({ ok: true, value: await run() }) },
    '../_shared/safe-error.ts': { safeError: () => 'internal error' },
    '../_shared/rate-limit.ts': { enforcePaymentStart: async () => ({ ok: true }) },
    '../_shared/stripe-sca.ts': loadModule('supabase/functions/_shared/stripe-sca.ts', {}),
    '../_shared/saved-card.ts': { chargeableCardFor: async () => null },
  }, strip ? withoutGuard : undefined);
}
const post = (fn: string, as: string, body: Row) => handler(new Request(`https://fake.supabase.co/functions/v1/${fn}`, { method: 'POST', headers: { Authorization: `Bearer user-${as}` }, body: JSON.stringify(body) }));
let n = 0;
const buyTicket = (as: string, over: Row = {}) => post('create-event-ticket-intent', as, { event_id: EVENT, line_items: [{ ticket_type_id: TT, quantity: 1 }], pay_with_wallet: true, client_request_id: `req-${++n}-abcdefgh`, ...over });
const buyGift = (as: string, over: Row = {}) => post('create-gift-intent', as, { client_request_id: `req-${++n}-abcdefgh`, kind: 'unit', unit_item_id: 'item1', recipient_email: 'friend@example.org', recipient_name: 'Friend', pay_with_wallet: true, ...over });
const transfers = () => calls.debits.filter((d) => d.transfer);

beforeEach(() => {
  controls = { [ACCT]: [OWNER] };
  sc = { account: ACCT, isDemo: false, price: 1000 };
  calls = { debits: [], reserved: 0, released: 0, rpc: [], inserts: [], updates: [], deletes: [] };
  stripeCalls = []; guardRpcError = false; n = 0;
  installGlobals();
});

describe('wallet TICKETS — the cash-out, and its closure', () => {
  test('LEGITIMATE: an ordinary customer buys a ticket from the wallet — reserved, debited once, organiser paid the face value, tickets valid', async () => {
    loadTickets();
    const res = await buyTicket(BOB);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.wallet, true);
    assert.equal(calls.reserved, 1);
    assert.equal(calls.debits.length, 1);
    assert.equal(transfers().length, 1);
    assert.equal(transfers()[0].transfer.destination, ACCT);
    assert.equal(calls.debits[0].idempotencyKey, `event-tickets:${ORDER}`);
    assert.ok(calls.updates.some((u) => u.table === 'event_ticket_orders' && u.v.status === 'paid' && u.v.stripe_payment_intent_id === 'wallet_tx-1'),
      'the order is paid with the wallet reference, never a card payment id');
    assert.ok(calls.updates.some((u) => u.table === 'event_tickets' && u.v.status === 'valid'));
    assert.deepEqual(stripeCalls, [], 'a wallet purchase never touches Stripe from here');
  });

  test('CONTROL (the audit finding): with the guard removed, the organiser buys their own event from a card-funded wallet and the money is transferred to their own account', async () => {
    loadTickets(true);
    const res = await buyTicket(OWNER);
    assert.equal(res.status, 200);
    assert.equal(transfers().length, 1);
    assert.equal(transfers()[0].transfer.destination, ACCT, 'a Connect transfer to an account the buyer controls');
    assert.ok(transfers()[0].transfer.amountPence > 0);
  });

  test('FIXED: the same purchase is refused — 403 self_payment, and NOTHING was reserved, debited, transferred or created', async () => {
    loadTickets();
    const res = await buyTicket(OWNER);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.reason, 'self_payment');
    assert.match(body.error, /can't use your OneShetland wallet to pay a business or hub you control/);
    assert.doesNotMatch(JSON.stringify(body), /stripe|fraud|chargeback|acct_/i, 'the refusal names no provider, no suspicion, no account id');
    assert.equal(calls.reserved, 0, 'no seats were held');
    assert.equal(calls.debits.length, 0);
    assert.equal(calls.inserts.length + calls.updates.length, 0, 'no order or ticket row was written');
  });

  test('the account is what is asked, not the event: a buyer who controls a DIFFERENT hub on the SAME connected account is refused too', async () => {
    controls = { [ACCT]: [OWNER, SIBLING] };
    loadTickets();
    const res = await buyTicket(SIBLING);
    assert.equal(res.status, 403);
    assert.equal(calls.debits.length, 0);
  });

  test('a customer who controls some OTHER account is not over-blocked', async () => {
    controls = { [ACCT]: [OWNER], acct_other: [BOB] };
    loadTickets();
    assert.equal((await buyTicket(BOB)).status, 200);
  });

  test('the guard runs BEFORE the basket is reserved (call order), so a refusal costs nothing and the reference stays usable', async () => {
    loadTickets();
    await buyTicket(OWNER);
    assert.ok(calls.rpc.includes('wallet_destination_self_controlled'));
    assert.ok(!calls.rpc.includes('reserve_ticket_basket'));
    loadTickets();
    calls.rpc.length = 0;
    await buyTicket(BOB);
    assert.ok(calls.rpc.indexOf('wallet_destination_self_controlled') < calls.rpc.indexOf('reserve_ticket_basket'));
  });

  test('a FREE order carries no transfer, so it is not asked and still works', async () => {
    sc = { account: ACCT, isDemo: false, price: 0 };
    loadTickets();
    const res = await buyTicket(OWNER);
    assert.equal(res.status, 200);
    assert.equal(transfers().length, 0);
    assert.ok(!calls.rpc.includes('wallet_destination_self_controlled'));
  });

  test('a demo organiser (no connected account) is not asked, and moves no transfer', async () => {
    sc = { account: null, isDemo: true, price: 1000 };
    loadTickets();
    const demo = await buyTicket(OWNER);
    assert.equal(demo.status, 200);
    assert.equal(transfers().length, 0, 'no transfer for a demo organiser');
    assert.ok(!calls.rpc.includes('wallet_destination_self_controlled'));
  });

  test('the CARD path is guarded too (own wording, same rule, same place) — see card-self-payment.node.test.ts', async () => {
    loadTickets();
    const res = await buyTicket(OWNER, { pay_with_wallet: false });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.reason, 'self_payment');
    assert.match(body.error, /can't pay a business, hub or driver whose payout account you control/, 'a card buyer is not told about a wallet');
    assert.equal(calls.debits.length, 0);
    assert.equal(calls.reserved, 0);
    assert.deepEqual(stripeCalls, [], 'no PaymentIntent was created');
    loadTickets();
    const fine = await buyTicket(BOB, { pay_with_wallet: false });
    assert.equal(fine.status, 200);
    assert.ok(stripeCalls.some((c) => c.startsWith('POST') && /payment_intents/.test(c)), 'an unrelated card buyer still gets a payment intent');
  });

  test('if the guard cannot answer, the purchase fails closed — nothing is debited', async () => {
    guardRpcError = true;
    loadTickets();
    const res = await buyTicket(BOB);
    assert.equal(res.status, 500);
    assert.equal(calls.debits.length, 0);
    assert.equal(calls.reserved, 0);
  });

  test('the client cannot choose the destination: a body that names an account, wallet or refund target changes nothing', async () => {
    loadTickets();
    const res = await buyTicket(OWNER, { stripe_account_id: 'acct_someone_else', destination: 'acct_someone_else', account_id: 'acct_someone_else', wallet_user_id: BOB });
    assert.equal(res.status, 403, 'the destination is resolved from the event, so naming another account does not dodge the guard');
    const ok = await buyTicket(BOB, { stripe_account_id: 'acct_evil', destination: 'acct_evil' });
    assert.equal(ok.status, 200);
    assert.equal(transfers()[0].transfer.destination, ACCT);
    assert.equal(calls.debits[0].userId, BOB, 'the debited wallet is the caller’s, from the token');
  });
});

describe('wallet GIFTS — the same closure', () => {
  test('LEGITIMATE: an ordinary customer gifts from the wallet — debited once, the seller paid price less commission, gift tagged with the wallet reference', async () => {
    loadGifts();
    const res = await buyGift(BOB);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).charged, true);
    assert.equal(calls.debits.length, 1);
    assert.equal(calls.debits[0].spendPence, 2000);
    assert.equal(transfers()[0].transfer.destination, ACCT);
    assert.equal(transfers()[0].transfer.amountPence, 2000 - 100);
    assert.equal(calls.debits[0].idempotencyKey, 'gift:gift1');
    assert.ok(calls.updates.some((u) => u.table === 'book_gifts' && u.v.payment_intent_id === 'wallet_tx-1'));
    assert.deepEqual(stripeCalls, []);
  });

  test('CONTROL (the audit finding): with the guard removed, a business owner "gifts" their own item from a card-funded wallet and the price is transferred to their own account', async () => {
    loadGifts(true);
    const res = await buyGift(OWNER);
    assert.equal(res.status, 200);
    assert.equal(transfers().length, 1);
    assert.equal(transfers()[0].transfer.destination, ACCT);
  });

  test('FIXED: refused with 403 self_payment before the gift row exists and before any debit', async () => {
    loadGifts();
    const res = await buyGift(OWNER);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).reason, 'self_payment');
    assert.equal(calls.debits.length, 0);
    assert.equal(calls.inserts.filter((i) => i.table === 'book_gifts').length, 0, 'no gift row was created, so there is nothing to clean up');
    assert.ok(!calls.rpc.includes('claim_gift_purchase'), 'and no attempt was even claimed');
    assert.deepEqual(calls.deletes, []);
  });

  test('a sibling hub/business on the same connected account is refused too', async () => {
    controls = { [ACCT]: [OWNER, SIBLING] };
    loadGifts();
    assert.equal((await buyGift(SIBLING)).status, 403);
  });

  test('an unrelated payer is not over-blocked, and a CARD gift to your own account is refused with the card wording', async () => {
    loadGifts();
    assert.equal((await buyGift(BOB)).status, 200);
    loadGifts();
    const own = await buyGift(OWNER, { pay_with_wallet: false });
    assert.equal(own.status, 403);
    assert.match((await own.json()).error, /can't pay a business, hub or driver whose payout account you control/);
    assert.equal(calls.debits.length, 1, 'only the earlier legitimate wallet gift debited anything');
  });

  test('a demo business (no connected account) is not asked, and moves no transfer', async () => {
    sc = { account: null, isDemo: true, price: 1000 };
    loadGifts();
    const res = await buyGift(OWNER);
    assert.equal(res.status, 200);
    assert.equal(transfers().length, 0);
  });

  test('fails closed if the guard cannot answer: no gift row, no debit', async () => {
    guardRpcError = true;
    loadGifts();
    const res = await buyGift(BOB);
    assert.equal(res.status, 500);
    assert.equal(calls.debits.length, 0);
  });
});

describe('no wallet route that pays a connected account can skip the guard', () => {
  const FUNCS = join(REPO_ROOT, 'supabase', 'functions');
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const files = readdirSync(FUNCS).filter((d) => existsSync(join(FUNCS, d, 'index.ts'))).map((d) => [d, strip(readFileSync(join(FUNCS, d, 'index.ts'), 'utf8'))] as const);

  test('every route that calls debitAndTransfer directly also calls selfPaymentBlock, and does so BEFORE the debit', () => {
    const bad: string[] = [];
    for (const [d, code] of files) {
      const debit = code.search(/\bdebitAndTransfer\(/);
      if (debit === -1) continue;
      const guard = code.search(/\bselfPaymentBlock\(/);
      if (guard === -1 || guard > debit) bad.push(d);
    }
    assert.deepEqual(bad, [], `wallet routes that transfer to a seller without asking who controls the account: ${bad.join(', ')}`);
  });

  test('the shared executor used by the till, scan-to-charge and product orders asks it before its own debit', () => {
    const code = strip(readFileSync(join(FUNCS, '_shared', 'wallet-pay.ts'), 'utf8'));
    assert.ok(code.search(/\bselfPaymentBlock\(/) !== -1 && code.search(/\bselfPaymentBlock\(/) < code.search(/\bdebitAndTransfer\(/));
  });

  test('routes that settle through settleMerchantWalletPayment or executeWalletPayment are guarded in the route or the shared executor', () => {
    const bad: string[] = [];
    for (const [d, code] of files) {
      if (/\bsettleMerchantWalletPayment\(/.test(code) && !/\bselfPaymentBlock\(/.test(code)) bad.push(d);
    }
    assert.deepEqual(bad, [], bad.join(', '));
  });

  test('the guard has ONE definition: both ticket and gift routes import the existing one, not a copy', () => {
    for (const d of ['create-event-ticket-intent', 'create-gift-intent']) {
      const src = readFileSync(join(FUNCS, d, 'index.ts'), 'utf8');
      assert.match(src, /import \{ debitAndTransfer, selfPaymentBlock \} from '\.\.\/_shared\/wallet-ledger\.ts';/, d);
      assert.doesNotMatch(src, /async function selfPaymentBlock|wallet_destination_self_controlled/, `${d} re-implements the guard`);
    }
  });
});
