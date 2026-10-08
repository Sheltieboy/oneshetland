/**
 * event-wallet-refund-core.node.test.ts
 *
 * The sequencing and failure handling of refunding a Wallet-funded event order:
 * claw back the organiser's Connect transfer, credit the Wallet once, void the
 * tickets — against a MODEL of the ledger and of Stripe's transfer behaviour
 * (including wallet_reverse_debit's real rules), driven through the exact code
 * that runs in production. The database half is proved against real Postgres in
 * event-wallet-refund.node.test.ts.
 *
 * No Stripe call, no money movement, no database.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isWalletRef, walletTxId, ledgerMatchesOrder, refundWalletEventOrder,
  type LedgerRow, type WalletEventOrder, type WalletRefundDeps, type MerchantOutcome,
} from '../functions/_shared/event-wallet-refund-core.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

const TX = 'c1c10000-0000-4000-8000-0000000000c1';
const ORDER_ID = '91910000-0000-4000-8000-000000000091';
const BUYER = 'd0000000-0000-4000-8000-0000000000d1';
const order = (over: Partial<WalletEventOrder> = {}): WalletEventOrder =>
  ({ id: ORDER_ID, buyer_id: BUYER, total_pence: 196, stripe_payment_intent_id: `wallet_${TX}`, ...over });

/** A model of the ledger row, Stripe's transfer, the customer's balance and the order — faithful to wallet_reverse_debit's rules. */
class World {
  row: LedgerRow | null;
  balance = 304;
  reversals = 0;
  transferReversals = 0;           // times Stripe was actually asked to reverse
  transferAmountReversed = 0;
  orderStatus = 'paid';
  ticketStatus = 'valid';
  failTransfer = false;
  failDebit = false;
  failVoid = false;
  calls: string[] = [];
  gate: Promise<void> = Promise.resolve();   // serialises reverseDebit like the row lock does

  constructor(rowOver: Partial<LedgerRow> | null = {}) {
    this.row = rowOver === null ? null : {
      id: TX, user_id: BUYER, type: 'spend', amount_pence: -196,
      stripe_transfer_id: 'tr_1', transfer_state: 'sent', idempotency_key: `event-tickets:${ORDER_ID}`, ...rowOver,
    };
  }

  deps(): WalletRefundDeps {
    return {
      loadLedgerRow: async () => { this.calls.push('load'); return this.row; },
      reverseTransfer: async () => {
        this.calls.push('reverseTransfer');
        if (this.failTransfer) throw new Error('Stripe refused');
        if (this.transferAmountReversed >= 100) return;          // already fully reversed: idempotent no-op, like the real helper
        this.transferReversals++; this.transferAmountReversed = 100;
      },
      reverseDebit: async (_tx, _reason, merchant: MerchantOutcome) => {
        this.calls.push(`reverseDebit:${merchant}`);
        // Same serialisation the row lock gives: one at a time, the second sees the first's reversal.
        const run = this.gate.then(async () => {
          if (this.failDebit) return { ok: false as const, message: 'db down' };
          if (this.reversals > 0) return { ok: true as const, reversalId: 'rev-1', alreadyReversed: true, balancePence: this.balance };
          this.reversals++; this.balance += 196;
          if (this.row?.transfer_state === 'sent' && merchant === 'clawed_back') this.row = { ...this.row, transfer_state: 'reversed' };
          return { ok: true as const, reversalId: 'rev-1', alreadyReversed: false, balancePence: this.balance };
        });
        this.gate = run.then(() => undefined, () => undefined);
        return run;
      },
      voidTickets: async () => {
        this.calls.push('voidTickets');
        if (this.failVoid) return { ok: false as const, message: 'void failed' };
        if (this.orderStatus === 'refunded') return { ok: true as const, action: 'already_refunded' };
        this.orderStatus = 'refunded'; this.ticketStatus = 'refunded';
        return { ok: true as const, action: 'refunded' };
      },
    };
  }
}
const refund = (w: World, o = order()) => refundWalletEventOrder(w.deps(), o, 'Acceptance Event', 'adminadmin-1234');

describe('rail resolution: a Wallet reference is a Wallet refund, a card reference is not', () => {
  test('wallet_<uuid> is recognised and parsed; anything else is not a wallet ref', () => {
    assert.equal(isWalletRef(`wallet_${TX}`), true);
    assert.equal(isWalletRef('pi_3UJMo9CCZSiMQBCg0w1bjgQM'), false);
    assert.equal(isWalletRef(null), false);
    assert.equal(walletTxId(`wallet_${TX}`), TX);
    assert.equal(walletTxId('wallet_not-a-uuid'), null);
    assert.equal(walletTxId('pi_123'), null);
  });

  test('refund-payment sends a wallet reference to the Wallet refund BEFORE it ever asks Stripe for a PaymentIntent', () => {
    const fn = code(read('supabase/functions/refund-payment/index.ts'));
    const walletAt = fn.indexOf('if (isWalletRef(eventOrder.stripe_payment_intent_id))');
    const stripeAt = fn.indexOf('/payment_intents/${payment_intent_id}?expand[]=latest_charge');
    assert.ok(walletAt > 0 && stripeAt > walletAt, 'a wallet order must never reach the card PaymentIntent lookup');
    // ...and the card path (raw PaymentIntent, hub membership, boost) is still there, unchanged.
    assert.match(fn, /form\.set\('reverse_transfer', 'true'\)/);
    assert.match(fn, /form\.set\('refund_application_fee', 'true'\)/);
  });

  test('the Wallet branch uses ONLY the canonical primitives: transfer clawback, wallet_reverse_debit, the shared ticket void — no card refund', () => {
    const fn = code(read('supabase/functions/refund-payment/index.ts'));
    const branch = fn.slice(fn.indexOf('function walletEventRefundDeps'), fn.indexOf('serve(async (req)'));
    assert.match(branch, /wallet_reverse_debit/);
    assert.match(branch, /refund_event_tickets_for_payment/);
    assert.match(branch, /reverseTransfer\(transferId, 'OneShetland: event ticket refunded'\)/);
    assert.doesNotMatch(branch, /\/refunds|reverse_transfer|refund_application_fee/);
  });
});

describe('the ledger entry must be THIS order\'s payment', () => {
  const row = (over: Partial<LedgerRow> = {}): LedgerRow => new World(over).row!;
  test('matches only the right customer, amount, type and order key', () => {
    assert.deepEqual(ledgerMatchesOrder(order(), row()), { ok: true });
    for (const bad of [{ user_id: 'someone-else' }, { amount_pence: -100 }, { type: 'topup' }, { idempotency_key: 'event-tickets:another-order' }, { idempotency_key: null }]) {
      assert.equal(ledgerMatchesOrder(order(), row(bad)).ok, false, JSON.stringify(bad));
    }
  });
});

describe('a Wallet-funded event refund: customer, organiser, ticket, order — each exactly once', () => {
  test('the happy path: transfer clawed back, £1.96 credited once, ticket void, order refunded', async () => {
    const w = new World();
    const r = await refund(w);
    assert.equal(r.ok, true);
    assert.ok(r.ok && r.rail === 'wallet' && r.amount_pence === 196 && r.merchant_reversed && !r.already_reversed);
    assert.equal(w.transferReversals, 1, 'the organiser\'s payout is clawed back once');
    assert.equal(w.balance, 500, 'the customer is restored by exactly £1.96');
    assert.equal(w.reversals, 1, 'exactly one refund ledger entry');
    assert.equal(w.orderStatus, 'refunded');
    assert.equal(w.ticketStatus, 'refunded');
    assert.deepEqual(w.calls, ['load', 'reverseTransfer', 'reverseDebit:clawed_back', 'voidTickets']);
  });

  test('order of operations: organiser clawed back BEFORE the customer is credited BEFORE the tickets void', async () => {
    const w = new World(); await refund(w);
    const i = (s: string) => w.calls.indexOf(s);
    assert.ok(i('reverseTransfer') < i('reverseDebit:clawed_back') && i('reverseDebit:clawed_back') < i('voidTickets'));
  });

  test('a duplicate request is harmless: no second credit, no second clawback, still refunded', async () => {
    const w = new World();
    await refund(w);
    const again = await refund(w);
    assert.ok(again.ok && again.already_reversed);
    assert.equal(w.balance, 500);
    assert.equal(w.reversals, 1);
    assert.equal(w.transferReversals, 1);
    assert.equal(w.row?.transfer_state, 'reversed');
  });

  test('a repeated tap — four requests in the same instant — still credits and claws back once', async () => {
    const w = new World();
    const results = await Promise.all([refund(w), refund(w), refund(w), refund(w)]);
    assert.ok(results.every((r) => r.ok), JSON.stringify(results));
    assert.equal(w.balance, 500);
    assert.equal(w.reversals, 1);
    assert.equal(w.transferReversals, 1);
    assert.equal(results.filter((r) => r.ok && !r.already_reversed).length, 1, 'exactly one request did the work');
  });

  test('an organiser who was never sent anything (no transfer) is not clawed back, and the customer is still credited', async () => {
    const w = new World({ transfer_state: 'none', stripe_transfer_id: null });
    const r = await refund(w);
    assert.ok(r.ok && !r.merchant_reversed);
    assert.equal(w.transferReversals, 0);
    assert.equal(w.balance, 500);
    assert.deepEqual(w.calls, ['load', 'reverseDebit:no_transfer', 'voidTickets']);
  });
});

describe('failures are safe to retry and never half-pay anyone', () => {
  test('Stripe refuses the clawback → NOTHING changes: no credit, no void, retry is safe', async () => {
    const w = new World(); w.failTransfer = true;
    const r = await refund(w);
    assert.ok(!r.ok && r.status === 502 && r.stage === 'nothing_changed' && r.retry_safe);
    assert.equal(w.balance, 304); assert.equal(w.reversals, 0); assert.equal(w.orderStatus, 'paid');
    assert.ok(!w.calls.includes('reverseDebit:clawed_back'), 'the customer must not be credited while the organiser still holds the money');
    // ...and the retry, once Stripe recovers, completes it.
    w.failTransfer = false;
    assert.ok((await refund(w)).ok);
    assert.equal(w.balance, 500); assert.equal(w.orderStatus, 'refunded');
  });

  test('clawback succeeds but the credit fails → reported honestly; the retry credits once WITHOUT clawing back again', async () => {
    const w = new World(); w.failDebit = true;
    const r = await refund(w);
    assert.ok(!r.ok && r.stage === 'merchant_reversed_wallet_pending' && r.retry_safe);
    assert.equal(w.transferReversals, 1); assert.equal(w.balance, 304);
    w.failDebit = false;
    const retry = await refund(w);
    assert.ok(retry.ok);
    assert.equal(w.balance, 500); assert.equal(w.reversals, 1);
    assert.equal(w.transferReversals, 1, 'the organiser is not clawed back a second time');
  });

  test('credit lands but the ticket void fails → the order is NOT left looking paid on retry; retry only voids', async () => {
    const w = new World(); w.failVoid = true;
    const r = await refund(w);
    assert.ok(!r.ok && r.stage === 'wallet_credited_tickets_pending' && r.retry_safe);
    assert.equal(w.balance, 500); assert.equal(w.orderStatus, 'paid');
    w.failVoid = false;
    const retry = await refund(w);
    assert.ok(retry.ok && retry.already_reversed);
    assert.equal(w.balance, 500, 'no second credit');
    assert.equal(w.orderStatus, 'refunded'); assert.equal(w.ticketStatus, 'refunded');
  });

  test('an unresolved or still-pending organiser transfer is refused with nothing touched', async () => {
    for (const state of ['unresolved', 'pending']) {
      const w = new World({ transfer_state: state });
      const r = await refund(w);
      assert.ok(!r.ok && r.status === 409, state);
      assert.deepEqual(w.calls, ['load']);
      assert.equal(w.balance, 304);
    }
  });

  test('a ledger entry marked sent but with no transfer reference is refused, not guessed at', async () => {
    const w = new World({ transfer_state: 'sent', stripe_transfer_id: null });
    const r = await refund(w);
    assert.ok(!r.ok && r.status === 409);
    assert.deepEqual(w.calls, ['load']);
  });

  test('a ledger row that is not this order\'s payment is refused before any money moves', async () => {
    for (const bad of [{ user_id: 'someone-else' }, { amount_pence: -100 }, { idempotency_key: 'event-tickets:other' }, { type: 'topup' }]) {
      const w = new World(bad);
      const r = await refund(w);
      assert.ok(!r.ok && r.status === 409, JSON.stringify(bad));
      assert.deepEqual(w.calls, ['load']);
      assert.equal(w.balance, 304); assert.equal(w.transferReversals, 0);
    }
  });

  test('a missing ledger row or a malformed reference refuses cleanly', async () => {
    const missing = new World(null);
    const a = await refund(missing);
    assert.ok(!a.ok && a.status === 409);
    const b = await refund(new World(), order({ stripe_payment_intent_id: 'wallet_garbage' }));
    assert.ok(!b.ok && b.status === 400);
  });
});

describe('who may reach it, and how the screen sees it (wiring)', () => {
  const fn = code(read('supabase/functions/refund-payment/index.ts'));

  test('the Wallet branch sits behind the same server-side authority as the card path, and a full refund only', () => {
    const authAt = fn.indexOf("svc.rpc('can_refund_event_orders'");
    const walletAt = fn.indexOf('if (isWalletRef(eventOrder.stripe_payment_intent_id))');
    const fullOnlyAt = fn.indexOf('A ticket order is refunded in full.');
    const alreadyAt = fn.indexOf('This order has already been refunded.');
    assert.ok(authAt > 0 && authAt < fullOnlyAt && fullOnlyAt < alreadyAt && alreadyAt < walletAt,
      'authority, then full-only, then already-refunded, then the Wallet refund');
  });

  test('an unauthorised caller gets the same refusal for a Wallet order as for a card order, and learns nothing', () => {
    assert.match(fn, /if \(!eventOrder \|\| !ownsThisEvent\) \{/);
  });

  test('the ledger is read with the service role and bound to the order, never to anything the client sent', () => {
    const deps = fn.slice(fn.indexOf('function walletEventRefundDeps'), fn.indexOf('serve(async (req)'));
    assert.match(deps, /\.from\('local_wallet_transactions'\)/);
    assert.doesNotMatch(deps, /body\./);
  });
});
