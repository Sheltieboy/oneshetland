/**
 * wallet-liquidity-gate.node.test.ts
 *
 * On 2 Oct 2026 a £1.96 Wallet event-ticket purchase sent a REAL £1.00 Connect
 * transfer to the organiser while Local Wallet liquidity read Critical (Stripe
 * available £4.93 against a £100 reserve). The canonical Wallet payment path
 * (executeWalletPayment) asks "can the platform actually settle this?" before
 * debiting anyone; event tickets, gifts and the wallet-checkout routes call
 * debitAndTransfer directly and never asked.
 *
 * ANSWER: that purchase should NOT have been allowed. Any path that debits the
 * Wallet and creates a Connect transfer pays the merchant out of the SAME pooled
 * Stripe balance, so it must be held to the SAME rule.
 *
 * This proves:
 *   1. the shared gate (the exact code that guards production) — Critical blocks,
 *      nothing is debited when blocked, concurrent spends cannot oversubscribe
 *      the headroom, unreadable balance fails closed, healthy liquidity allows
 *   2. event tickets and gifts now go through it, BEFORE any debit
 *   3. a STRUCTURAL audit of every Wallet-funded rail, so a future rail cannot
 *      create merchant settlement without the gate unnoticed — and the three
 *      wallet-checkout routes that still bypass it are named, not hidden
 *
 * No Stripe, no database, no money.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runWithLiquidityGate, LIQUIDITY_DECLINED_MESSAGE,
  type GateDeps, type GateSnapshot, type GateReservation,
} from '../functions/_shared/wallet-liquidity-gate-core.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FN_DIR = join(REPO_ROOT, 'supabase/functions');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

/** A model of the Stripe pool and of wallet_liquidity_reserve's atomic check-and-claim. */
class Pool implements GateDeps {
  held = 0;
  snapshotCalls = 0; reserveCalls = 0; released: (string | null)[] = [];
  private n = 0;
  status: GateSnapshot['status']; available: number; reserveFloor: number;
  constructor(status: GateSnapshot['status'], available: number, reserveFloor: number) {
    this.status = status; this.available = available; this.reserveFloor = reserveFloor;
  }
  async snapshot(): Promise<GateSnapshot> {
    this.snapshotCalls++;
    return { status: this.status, available_pence: this.available, reserve_pence: this.reserveFloor, error: this.status === 'unknown' ? 'stripe unreachable' : undefined };
  }
  async reserve(amount: number, available: number, floor: number): Promise<GateReservation> {
    this.reserveCalls++;
    // atomic: no await between the check and the claim, exactly like the lock-serialised RPC
    const headroom = available - floor - this.held;
    if (headroom < amount) return { ok: false, heldPence: this.held };
    this.held += amount; const id = `res-${++this.n}`; (this.amounts as Record<string, number>)[id] = amount;
    return { ok: true, reservationId: id };
  }
  amounts: Record<string, number> = {};
  async release(id: string | null) { this.released.push(id); if (id) this.held -= this.amounts[id] ?? 0; }
}

/** A stand-in for debitAndTransfer: counts debits so "no debit when blocked" is measurable. */
const wallet = () => { const w = { debits: 0 }; return { w, settle: async () => { w.debits++; return 'paid'; } }; };

describe('the gate: Critical liquidity blocks a Wallet merchant payment BEFORE the customer is debited', () => {
  test('the real 2 Oct situation — available £4.93, reserve £100, a £1.00 transfer — is refused and nobody is debited', async () => {
    const pool = new Pool('critical', 493, 10_000); const { w, settle } = wallet();
    const r = await runWithLiquidityGate(pool, 100, settle);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.status === 503 && r.reason === 'liquidity_unavailable' && r.error === LIQUIDITY_DECLINED_MESSAGE);
    assert.equal(w.debits, 0, 'the customer must not be debited when the gate refuses');
    assert.equal(pool.held, 0, 'a refusal holds nothing');
  });

  test('Low status with real headroom above the reserve is allowed; headroom is measured above the floor, not above zero', async () => {
    const pool = new Pool('low', 10_150, 10_000); const { w, settle } = wallet();
    assert.equal((await runWithLiquidityGate(pool, 100, settle)).ok, true);
    assert.equal(w.debits, 1);
  });

  test('exactly the available headroom is allowed; one penny more is refused', async () => {
    let p = new Pool('healthy', 10_100, 10_000); let s = wallet();
    assert.equal((await runWithLiquidityGate(p, 100, s.settle)).ok, true);
    p = new Pool('healthy', 10_099, 10_000); s = wallet();
    assert.equal((await runWithLiquidityGate(p, 100, s.settle)).ok, false);
    assert.equal(s.w.debits, 0);
  });

  test('healthy liquidity allows the purchase, and the reservation is released afterwards', async () => {
    const pool = new Pool('healthy', 20_000, 10_000); const { w, settle } = wallet();
    const r = await runWithLiquidityGate(pool, 100, settle);
    assert.ok(r.ok && r.value === 'paid' && r.gated);
    assert.equal(w.debits, 1);
    assert.equal(pool.held, 0, 'the reservation does not leak');
    assert.deepEqual(pool.released, ['res-1']);
  });

  test('an unreadable Stripe balance FAILS CLOSED: refused, no reservation attempted, no debit', async () => {
    const pool = new Pool('unknown', 0, 0); const { w, settle } = wallet();
    const r = await runWithLiquidityGate(pool, 100, settle);
    assert.ok(!r.ok && r.reason === 'liquidity_unavailable');
    assert.equal(pool.reserveCalls, 0);
    assert.equal(w.debits, 0);
  });

  test('liquidity protection explicitly disabled in Admin Config is the documented fallback: proceeds without a reservation', async () => {
    const pool = new Pool('disabled', 0, 10_000); const { w, settle } = wallet();
    assert.equal((await runWithLiquidityGate(pool, 100, settle)).ok, true);
    assert.equal(pool.reserveCalls, 0); assert.equal(w.debits, 1);
  });

  test('a purchase with NO external transfer (platform-funded) consumes no pooled funds, so the gate does not apply or even read Stripe', async () => {
    const pool = new Pool('critical', 0, 10_000); const { w, settle } = wallet();
    const r = await runWithLiquidityGate(pool, 0, settle);
    assert.ok(r.ok && !r.gated);
    assert.equal(pool.snapshotCalls, 0); assert.equal(w.debits, 1);
  });

  test('the reservation is released even if the settlement throws', async () => {
    const pool = new Pool('healthy', 20_000, 10_000);
    await assert.rejects(runWithLiquidityGate(pool, 100, async () => { throw new Error('boom'); }), /boom/);
    assert.equal(pool.held, 0);
  });
});

describe('the gate: concurrent spends cannot oversubscribe the headroom', () => {
  test('headroom for ONE £100 transfer, two simultaneous buyers: exactly one settles, the other is refused undebited', async () => {
    const pool = new Pool('healthy', 10_150, 10_000);
    let debits = 0;
    const slowSettle = async () => { debits++; await new Promise((r) => setTimeout(r, 25)); return 'paid'; };
    const [a, b] = await Promise.all([runWithLiquidityGate(pool, 100, slowSettle), runWithLiquidityGate(pool, 100, slowSettle)]);
    assert.equal([a, b].filter((x) => x.ok).length, 1);
    assert.equal(debits, 1, 'only the winner debits');
    assert.equal(pool.held, 0);
  });

  test('five simultaneous buyers over a headroom of three: exactly three settle', async () => {
    const pool = new Pool('healthy', 10_300, 10_000);
    let debits = 0;
    const settle = async () => { debits++; await new Promise((r) => setTimeout(r, 20)); return 'paid'; };
    const rs = await Promise.all(Array.from({ length: 5 }, () => runWithLiquidityGate(pool, 100, settle)));
    assert.equal(rs.filter((x) => x.ok).length, 3);
    assert.equal(debits, 3);
  });
});

describe('event tickets and gifts now pass through the gate, BEFORE any debit', () => {
  const ev = code(read('supabase/functions/create-event-ticket-intent/index.ts'));
  const gift = code(read('supabase/functions/create-gift-intent/index.ts'));

  test('event tickets: the debit exists only inside the gated closure; there is no direct awaited debit', () => {
    assert.doesNotMatch(ev, /await debitAndTransfer\(/);
    assert.match(ev, /const settleWallet = \(\) => debitAndTransfer\(supabase, \{/);
    assert.match(ev, /withWalletLiquidityGate\(supabase, stripeAccountId \? totalPence : 0, settleWallet\)/);
  });

  test('event tickets: the gate is asked for what actually LEAVES Stripe (the face value), not the customer\'s total', () => {
    const call = ev.slice(ev.indexOf('withWalletLiquidityGate(supabase'), ev.indexOf('withWalletLiquidityGate(supabase') + 120);
    assert.match(call, /totalPence/);
    assert.doesNotMatch(call, /chargeTotalPence/);
    assert.match(ev, /amountPence: totalPence,/, 'the transfer amount and the gated amount are the same figure');
  });

  test('event tickets: a refusal releases the held seats and returns 503 BEFORE the order is marked paid or tickets validated', () => {
    const gateAt = ev.indexOf('const gate = await withWalletLiquidityGate');
    const declineAt = ev.indexOf('if (!gate.ok) {', gateAt);
    const paidAt = ev.indexOf("update({ status: 'paid', paid_at: now, stripe_payment_intent_id: walletRef })");
    assert.ok(gateAt > 0 && declineAt > gateAt && paidAt > declineAt);
    const decline = ev.slice(declineAt, declineAt + 300);
    assert.match(decline, /await releaseHeldSeats\(\)/);
    assert.match(decline, /status: gate\.status/);
    assert.match(decline, /reason: gate\.reason/);
  });

  test('gifts: same gate, on the amount that reaches the business, with the half-created gift removed on refusal', () => {
    assert.doesNotMatch(gift, /await debitAndTransfer\(/);
    assert.match(gift, /withWalletLiquidityGate\(supabase, giftHasAccount \? pricePence! - giftPlatformFee : 0, settleWallet\)/);
    const declineAt = gift.indexOf('if (!gate.ok) {');
    assert.match(gift.slice(declineAt, declineAt + 250), /from\('book_gifts'\)\.delete\(\)/);
  });

  test('the wiring uses the real liquidity snapshot and the real atomic reservation, and always releases', () => {
    const w = code(read('supabase/functions/_shared/wallet-liquidity-gate.ts'));
    assert.match(w, /getWalletLiquiditySnapshot\(svc\)/);
    assert.match(w, /reserveWalletLiquidity\(svc, amount, available, reserve\)/);
    assert.match(w, /releaseWalletLiquidity\(svc, id\)/);
  });
});

describe('AUDIT: every Wallet-funded rail that creates merchant settlement is gated — or named as not yet', () => {
  type Call = { file: string; settlement: boolean; direct: boolean };
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const full = join(dir, n);
    if (statSync(full).isDirectory()) return files(full);
    return /\.ts$/.test(n) && !/\.test\./.test(n) ? [full] : [];
  });

  /** The balanced argument text of a call starting at `at` (the index of its "(" ). */
  const args = (s: string, at: number): string => {
    let d = 0;
    for (let i = at; i < s.length; i++) {
      if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (d === 0) return s.slice(at, i + 1); }
    }
    return s.slice(at);
  };

  const calls: Call[] = files(FN_DIR).flatMap((f) => {
    const s = code(readFileSync(f, 'utf8'));
    if (f.endsWith('_shared/wallet-ledger.ts')) return [];     // the primitive itself
    return [...s.matchAll(/debitAndTransfer\(/g)].map((m) => {
      const before = s.slice(Math.max(0, m.index! - 18), m.index!);
      const open = m.index! + 'debitAndTransfer'.length;
      return {
        file: f.replace(FN_DIR + '/', ''),
        settlement: /\btransfer\s*:/.test(args(s, open)),
        direct: /await\s*$/.test(before),
      };
    });
  });

  test('the audit actually finds the rails (guards against the scan silently matching nothing)', () => {
    const names = new Set(calls.map((c) => c.file));
    for (const f of ['_shared/wallet-pay.ts', 'create-event-ticket-intent/index.ts', 'create-gift-intent/index.ts', 'wallet-checkout/index.ts']) {
      assert.ok(names.has(f), `${f} not found by the audit`);
    }
  });

  test('executeWalletPayment (tap-to-pay, scan-to-charge, shop orders) asks the same question inline, before it debits', () => {
    const wp = code(read('supabase/functions/_shared/wallet-pay.ts'));
    assert.ok(wp.indexOf('getWalletLiquiditySnapshot(svc)') > 0);
    assert.ok(wp.indexOf('reserveWalletLiquidity(svc,') > wp.indexOf('getWalletLiquiditySnapshot(svc)'));
    assert.ok(wp.indexOf('await debitAndTransfer(svc,') > wp.indexOf('reserveWalletLiquidity(svc,'));
    // every route into it:
    for (const f of ['local-wallet-pay', 'wallet-charge-approve', 'create-product-order-intent']) {
      assert.match(code(read(`supabase/functions/${f}/index.ts`)), /executeWalletPayment\(/, f);
    }
  });

  test('every settlement-creating debit OUTSIDE executeWalletPayment is gated by the shared gate', () => {
    const ungated = calls.filter((c) => c.settlement && c.direct && c.file !== '_shared/wallet-pay.ts');
    const byFile: Record<string, number> = {};
    for (const u of ungated) byFile[u.file] = (byFile[u.file] ?? 0) + 1;
    // Named, not hidden. These three wallet-checkout routes (hub donation, hub membership, pass purchase)
    // still debit and transfer without the gate; the file currently carries uncommitted work of its own,
    // so it is reported rather than edited here. When it is gated this must become {} — and it will fail
    // until the exemption is removed.
    assert.deepEqual(byFile, { 'wallet-checkout/index.ts': 3 },
      'a Wallet rail creates merchant settlement without the liquidity gate (or an exemption went stale)');
  });

  test('gated callers never ALSO call the debit directly (the closure is the only way in)', () => {
    for (const f of ['create-event-ticket-intent/index.ts', 'create-gift-intent/index.ts']) {
      assert.ok(calls.filter((c) => c.file === f).every((c) => !c.direct), f);
      assert.ok(calls.filter((c) => c.file === f).some((c) => c.settlement), `${f} lost its merchant transfer`);
    }
  });

  test('the platform-funded shift boost has no merchant transfer, so it does not consume pooled funds', () => {
    const wc = code(read('supabase/functions/wallet-checkout/index.ts'));
    const shift = wc.slice(wc.indexOf('async function shiftBoost'), wc.indexOf('async function reverseTransfer'));
    const call = shift.slice(shift.indexOf('debitAndTransfer('));
    assert.doesNotMatch(args(call, call.indexOf('(')), /\btransfer\s*:/);
  });

  test('only the ledger primitive (and one unused helper) can create a Stripe transfer — a new file that does fails here', () => {
    const makers = files(FN_DIR)
      .filter((f) => /api\.stripe\.com\/v1\/transfers['`"]/.test(code(readFileSync(f, 'utf8'))))
      .map((f) => f.replace(FN_DIR + '/', ''))
      .sort();
    assert.deepEqual(makers, ['_shared/wallet-ledger.ts', 'wallet-checkout/index.ts']);
    // the wallet-checkout one is a local helper that nothing calls
    const wc = code(read('supabase/functions/wallet-checkout/index.ts'));
    assert.equal((wc.match(/stripeTransfer\(/g) ?? []).length, 1, 'stripeTransfer in wallet-checkout is declared but unused');
  });

  test('Wallet paths that debit WITHOUT debitAndTransfer do not exist at the edge-function layer (no side door around the primitives)', () => {
    const offenders = files(FN_DIR)
      .filter((f) => !f.endsWith('_shared/wallet-ledger.ts'))
      .filter((f) => /wallet_debit_with_ledger|walletDebit\(|rpc\('wallet_debit'/.test(code(readFileSync(f, 'utf8'))))
      .map((f) => f.replace(FN_DIR + '/', ''));
    assert.deepEqual(offenders, []);
  });

  test('the cron-secret / admin-only liquidity functions are untouched by this (monitor, snapshot, fund)', () => {
    for (const f of ['wallet-liquidity-monitor', 'wallet-liquidity-snapshot', 'wallet-liquidity-fund']) {
      assert.ok(existsSync(join(FN_DIR, f, 'index.ts')), f);
    }
  });
});
