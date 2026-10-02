/**
 * wallet-event-reconcile-core.node.test.ts
 *
 * A Wallet-funded event ticket refund was economically perfect (customer credited,
 * merchant transfer reversed, booking fee returned) but could never be marked
 * reconciled: reconciliation hung off a card PaymentIntent and a Wallet order has
 * none, so it read "unverified" forever. This proves the Wallet verdict:
 *
 *   · the exact live order (bc622739…) derives `reconciled` with both gaps at £0
 *   · a refunded order whose Wallet credit is missing is needs_repair
 *   · a merchant who still holds the transfer is needs_repair
 *   · partial / mismatched / duplicated / foreign amounts are needs_review
 *   · it never invents a PaymentIntent, never moves money, never trusts an
 *     unreadable Stripe, and is idempotent
 *   · the card engine is untouched
 *
 * Pure: the ledger, Stripe and storage are in-memory. No database, no network,
 * no service key.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessWalletEventOrder, reconcileWalletEventOrder,
  type WalletEventFacts, type WalletFactsSource, type WalletReconStore, type WalletReconState,
} from '../functions/_shared/wallet-event-reconcile-core.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO, '..', 'oneshetland-web');
const read = (root: string, p: string) => readFileSync(join(root, p), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

const ORDER = 'bc622739-8cd8-4e3c-8d34-88ce96269581';
const BUYER = 'eb599396-6e9c-4c49-ae67-cb60fbc02bac';
const SPEND = '8423a6e9-708d-4482-834e-7ba56609d88b';
const CREDIT = 'df33f618-4207-4f07-b8d7-7083cfd4db4c';

/** The live order as it really is: £1.96 spend, one +£1.96 credit, £1.00 transfer fully reversed once. */
function live(over: Partial<WalletEventFacts> = {}): WalletEventFacts {
  return {
    order: { id: ORDER, buyer_id: BUYER, status: 'refunded', total_pence: 196, platform_fee_pence: 96, refunded_at: '2026-10-02T14:14:02.541Z' },
    spend: {
      id: SPEND, user_id: BUYER, type: 'spend', amount_pence: -196,
      stripe_transfer_id: 'tr_1UM67oCCZSiMQBCgsYcV27nt', transfer_state: 'reversed', idempotency_key: `event-tickets:${ORDER}`,
    },
    reversals: [{ id: CREDIT, user_id: BUYER, type: 'refund', amount_pence: 196 }],
    transfer: { id: 'tr_1UM67oCCZSiMQBCgsYcV27nt', amount: 100, amount_reversed: 100, reversal_count: 1 },
    ...over,
  };
}
const gaps = (a: ReturnType<typeof assessWalletEventOrder>) =>
  'transfer_gap' in a ? { t: a.transfer_gap, w: a.wallet_gap } : null;

describe('the live order, exactly as it is', () => {
  test('reconciles: customer credited in full, transfer fully reversed once, both gaps £0', () => {
    const a = assessWalletEventOrder(live());
    assert.equal(a.state, 'reconciled');
    assert.deepEqual(gaps(a), { t: 0, w: 0 });
    if ('credited' in a) assert.deepEqual([a.debited, a.credited, a.reversal_count], [196, 196, 1]);
  });

  test('the 96p booking fee needs no leg of its own: it comes back because the whole spend is credited', () => {
    const a = assessWalletEventOrder(live());
    assert.match((a as { reason: string }).reason, /booking fee returned with the credit/);
  });
});

describe('what each failure looks like', () => {
  const state = (f: WalletEventFacts) => assessWalletEventOrder(f).state;

  test('a refunded order with NO Wallet credit is needs_repair, with the customer still owed £1.96', () => {
    const a = assessWalletEventOrder(live({ reversals: [] }));
    assert.equal(a.state, 'needs_repair');
    assert.deepEqual(gaps(a), { t: 0, w: 196 });
  });

  test('the merchant still holding the transfer is needs_repair, with the gap named', () => {
    const a = assessWalletEventOrder(live({ transfer: { id: 't', amount: 100, amount_reversed: 0, reversal_count: 0 } }));
    assert.equal(a.state, 'needs_repair');
    assert.deepEqual(gaps(a), { t: 100, w: 0 });
  });

  test('a transfer only PARTLY reversed is needs_review — a person decides, not a retry', () => {
    const a = assessWalletEventOrder(live({ transfer: { id: 't', amount: 100, amount_reversed: 40, reversal_count: 1 } }));
    assert.equal(a.state, 'needs_review');
    assert.deepEqual(gaps(a), { t: 60, w: 0 });
  });

  test('a PARTIAL credit (£1.00 of £1.96) is needs_review', () => {
    const a = assessWalletEventOrder(live({ reversals: [{ id: 'x', user_id: BUYER, type: 'refund', amount_pence: 100 }] }));
    assert.equal(a.state, 'needs_review');
    assert.deepEqual(gaps(a), { t: 0, w: 96 });
  });

  test('a DUPLICATE credit row is needs_review — the double refund the ledger exists to prevent', () => {
    const a = assessWalletEventOrder(live({ reversals: [
      { id: 'a', user_id: BUYER, type: 'refund', amount_pence: 196 },
      { id: 'b', user_id: BUYER, type: 'refund', amount_pence: 196 },
    ] }));
    assert.equal(a.state, 'needs_review');
    assert.deepEqual(gaps(a), { t: 0, w: -196 });
  });

  test('a credit larger than the spend is needs_review', () => {
    assert.equal(state(live({ reversals: [{ id: 'a', user_id: BUYER, type: 'refund', amount_pence: 300 }] })), 'needs_review');
  });

  test('two credits that happen to add up are STILL needs_review: exactly one is the rule', () => {
    assert.equal(state(live({ reversals: [
      { id: 'a', user_id: BUYER, type: 'refund', amount_pence: 100 },
      { id: 'b', user_id: BUYER, type: 'refund', amount_pence: 96 },
    ] })), 'needs_review');
  });

  test('a credit to somebody else is needs_review, however well the amounts balance', () => {
    assert.equal(state(live({ reversals: [{ id: 'a', user_id: 'someone-else', type: 'refund', amount_pence: 196 }] })), 'needs_review');
  });

  test('a ledger row that reverses the spend but is not a refund is needs_review', () => {
    assert.equal(state(live({ reversals: [{ id: 'a', user_id: BUYER, type: 'adjustment', amount_pence: 196 }] })), 'needs_review');
  });

  test('a transfer that is not the ticket face value (£1.00) is needs_review', () => {
    assert.equal(state(live({ transfer: { id: 't', amount: 150, amount_reversed: 150, reversal_count: 1 } })), 'needs_review');
  });

  test('a transfer reversed in several parts is needs_review, even if it adds up', () => {
    assert.equal(state(live({ transfer: { id: 't', amount: 100, amount_reversed: 100, reversal_count: 2 } })), 'needs_review');
  });

  test('a missing or foreign ledger spend is needs_review — the order\'s reference alone is not trusted', () => {
    assert.equal(state(live({ spend: null, reversals: [], transfer: null })), 'needs_review');
    const s = live().spend!;
    assert.equal(state(live({ spend: { ...s, user_id: 'someone-else' } })), 'needs_review');
    assert.equal(state(live({ spend: { ...s, amount_pence: -100 } })), 'needs_review');
    assert.equal(state(live({ spend: { ...s, idempotency_key: 'event-tickets:other-order' } })), 'needs_review');
  });

  test('a spend with no transfer (the merchant was never paid) needs no clawback and reconciles on the credit alone', () => {
    const s = live().spend!;
    const a = assessWalletEventOrder(live({ spend: { ...s, stripe_transfer_id: null, transfer_state: 'none' }, transfer: null }));
    assert.equal(a.state, 'reconciled');
    assert.deepEqual(gaps(a), { t: 0, w: 0 });
  });

  test('an order that is not refunded, or is free, is not judged at all', () => {
    assert.equal(state(live({ order: { ...live().order, status: 'paid' } })), 'not_refunded');
    assert.equal(state(live({ order: { ...live().order, total_pence: 0, platform_fee_pence: 0 } })), 'not_applicable');
  });
});

/* ── orchestration ─────────────────────────────────────────────────────────── */

class MemStore implements WalletReconStore {
  rows = new Map<string, { state: string; first_flagged_at: string | null; saves: number; payment_intent_id: null }>();
  events: { order: string; kind: string; actor: string }[] = [];
  saved: Parameters<WalletReconStore['save']>[0][] = [];
  async load(id: string) { const r = this.rows.get(id); return r ? { state: r.state, first_flagged_at: r.first_flagged_at } : null; }
  async save(r: Parameters<WalletReconStore['save']>[0]) {
    const prev = this.rows.get(r.order_id);
    this.rows.set(r.order_id, {
      state: r.state, saves: (prev?.saves ?? 0) + 1, payment_intent_id: null,
      first_flagged_at: prev?.first_flagged_at ?? (r.state === 'reconciled' ? null : 'now'),
    });
    this.saved.push(r);
  }
  async event(order: string, kind: 'detected' | 'verified' | 'review', actor: string) { this.events.push({ order, kind, actor }); }
}
const source = (f: WalletEventFacts | null | Error): WalletFactsSource => ({
  async loadFacts() { if (f instanceof Error) throw f; return f; },
});

describe('recording the verdict', () => {
  test('the live order, rechecked, is recorded reconciled with both gaps 0 and a verified event', async () => {
    const store = new MemStore();
    const r = await reconcileWalletEventOrder(source(live()), store, ORDER, 'sweep');
    assert.deepEqual([r.state, r.transfer_gap, r.wallet_gap], ['reconciled', 0, 0]);
    assert.equal(store.rows.get(ORDER)!.state, 'reconciled');
    assert.deepEqual(store.events, [{ order: ORDER, kind: 'verified', actor: 'sweep' }]);
  });

  test('it records the Wallet evidence, and NO PaymentIntent', async () => {
    const store = new MemStore();
    await reconcileWalletEventOrder(source(live()), store, ORDER, 'sweep');
    const s = store.saved[0];
    assert.equal(s.assessment.debited, 196);
    assert.equal(s.assessment.credited, 196);
    assert.equal(s.facts.transfer!.amount_reversed, 100);
    assert.equal(s.facts.order.id, ORDER);
    assert.equal(store.rows.get(ORDER)!.payment_intent_id, null);
  });

  test('re-running is idempotent: one row, a fresh check each time, and no audit noise', async () => {
    const store = new MemStore();
    for (let i = 0; i < 4; i++) await reconcileWalletEventOrder(source(live()), store, ORDER, 'sweep');
    assert.equal(store.rows.size, 1);
    assert.equal(store.rows.get(ORDER)!.saves, 4, 'last_checked_at must refresh on every check');
    assert.equal(store.events.length, 1, 'only the first verdict is an event');
  });

  test('a problem is flagged, the flag survives re-checks, and a CHANGE of verdict is one new event', async () => {
    const store = new MemStore();
    await reconcileWalletEventOrder(source(live({ reversals: [] })), store, ORDER, 'sweep');
    await reconcileWalletEventOrder(source(live({ reversals: [] })), store, ORDER, 'sweep');
    assert.equal(store.rows.get(ORDER)!.state, 'needs_repair');
    assert.equal(store.rows.get(ORDER)!.first_flagged_at, 'now');
    assert.deepEqual(store.events.map((e) => e.kind), ['detected']);
    await reconcileWalletEventOrder(source(live()), store, ORDER, 'sweep');
    assert.equal(store.rows.get(ORDER)!.state, 'reconciled');
    assert.deepEqual(store.events.map((e) => e.kind), ['detected', 'verified']);
    assert.equal(store.rows.get(ORDER)!.first_flagged_at, 'now', 'when it was first flagged is history and is kept');
  });

  test('a partial or duplicated credit is recorded as a review event, never as clean', async () => {
    const store = new MemStore();
    await reconcileWalletEventOrder(source(live({ reversals: [{ id: 'x', user_id: BUYER, type: 'refund', amount_pence: 100 }] })), store, ORDER, 'sweep');
    assert.equal(store.rows.get(ORDER)!.state, 'needs_review');
    assert.deepEqual(store.events.map((e) => e.kind), ['review']);
  });

  test('an unreadable Stripe records NOTHING — it can neither bless an order nor erase a flag', async () => {
    const store = new MemStore();
    await reconcileWalletEventOrder(source(live({ reversals: [] })), store, ORDER, 'sweep');
    const r = await reconcileWalletEventOrder(source(new Error('Stripe GET /transfers/tr_x failed: 500')), store, ORDER, 'sweep');
    assert.equal(r.state, 'error');
    assert.equal(store.rows.get(ORDER)!.state, 'needs_repair', 'the earlier flag stands');
    assert.equal(store.rows.get(ORDER)!.saves, 1);
  });

  test('an unknown order, a paid order and a free order record nothing', async () => {
    const store = new MemStore();
    assert.equal((await reconcileWalletEventOrder(source(null), store, ORDER, 'x')).state, 'error');
    assert.equal((await reconcileWalletEventOrder(source(live({ order: { ...live().order, status: 'paid' } })), store, ORDER, 'x')).state, 'not_refunded');
    assert.equal((await reconcileWalletEventOrder(source(live({ order: { ...live().order, total_pence: 0 } })), store, ORDER, 'x')).state, 'not_applicable');
    assert.equal(store.rows.size, 0);
  });

  test('only the five known states can ever be recorded', async () => {
    const seen = new Set<WalletReconState>();
    for (const f of [live(), live({ reversals: [] }), live({ reversals: [{ id: 'x', user_id: BUYER, type: 'refund', amount_pence: 1 }] })]) {
      const store = new MemStore();
      await reconcileWalletEventOrder(source(f), store, ORDER, 'x');
      seen.add(store.rows.get(ORDER)!.state as WalletReconState);
    }
    assert.deepEqual([...seen].sort(), ['needs_repair', 'needs_review', 'reconciled']);
  });
});

describe('wiring: where it runs, and what it is allowed to do', () => {
  const core = code(read(REPO, 'supabase/functions/_shared/wallet-event-reconcile-core.ts'));
  const adapter = code(read(REPO, 'supabase/functions/_shared/refund-reconcile.ts'));
  const walletAdapter = adapter.slice(adapter.indexOf('export const WALLET_RAIL'));

  test('the Wallet reconciliation cannot move money: no Stripe write and no ledger write anywhere in it', () => {
    assert.doesNotMatch(core, /fetch\(|stripePost|\.rpc\(|wallet_reverse_debit|reverseTransfer/);
    assert.doesNotMatch(walletAdapter, /stripePost|wallet_reverse_debit|\.rpc\(|local_wallet_transactions'\)\s*\.(insert|update|upsert|delete)/);
    assert.match(walletAdapter, /stripeGet\(`\/transfers\//);
  });

  test('it never invents a PaymentIntent: the row is written with payment_intent_id null', () => {
    assert.match(walletAdapter, /payment_intent_id: null/);
    assert.doesNotMatch(walletAdapter, /^\s+payment_intent_id: (?!null)/m);
  });

  test('one verdict row per order, keyed on the order, in the Wallet rail', () => {
    assert.match(walletAdapter, /walletReconKey = \(orderId: string\) => `wallet:order:\$\{orderId\}`/);
    assert.match(walletAdapter, /WALLET_RAIL = 'event_ticket_wallet'/);
  });

  test('a refund through OneShetland reconciles the Wallet order straight away, without ever failing the refund', () => {
    const rp = code(read(REPO, 'supabase/functions/refund-payment/index.ts'));
    const i = rp.indexOf('refundWalletEventOrder(');
    const branch = rp.slice(i, rp.indexOf('if (!payment_intent_id', i));
    assert.match(branch, /reconcileWalletOrder\(svc, eventOrder\.id,/);
    assert.match(branch, /try \{[\s\S]*reconcileWalletOrder[\s\S]*\} catch/);
    assert.ok(branch.indexOf('reconcileWalletOrder') > branch.indexOf('if (!out.ok)'), 'only after the refund succeeded');
  });

  test('the sweep re-checks Wallet orders flag-only, and does not feed their keys to the card engine', () => {
    const sw = code(read(REPO, 'supabase/functions/refund-reconcile-sweep/index.ts'));
    assert.match(sw, /listWalletOrdersToCheck\(/);
    assert.match(sw, /reconcileWalletOrder\(svc, id, 'sweep'\)/);
    assert.match(sw, /\.neq\('rail', WALLET_RAIL\)/);
    assert.doesNotMatch(sw, /allowRepair: true|force: true/);
  });

  test('admin scan includes Wallet orders; admin repair still accepts only a card charge (ch_…)', () => {
    const rc = code(read(REPO, 'supabase/functions/refund-reconcile/index.ts'));
    assert.match(rc, /reconcileWalletOrder\(svc, id,/);
    assert.match(rc, /\^ch_\[A-Za-z0-9\]\+\$/);
  });

  test('the view finds a Wallet verdict by order id, keeps the card join, and adds only a column', () => {
    const sql = code(read(REPO, 'supabase/migrations/20261030000100_wallet_event_reconciliation.sql'));
    assert.match(sql, /r\.payment_intent_id = o\.stripe_payment_intent_id\s+or \(r\.rail = 'event_ticket_wallet' and r\.order_id = o\.id\)/);
    assert.match(sql, /r\.wallet_gap_pence\s+from public\.event_ticket_orders o/);
    assert.match(sql, /revoke all on public\.event_refund_reconciliation from public, anon, authenticated/);
    assert.doesNotMatch(sql, /alter table[^;]*(drop|alter column)/i, 'no card column is altered');
  });

  test('the card engine is untouched: its core is byte-for-byte what it was and does not know the Wallet rail', () => {
    const coreCard = read(REPO, 'supabase/functions/_shared/refund-reconcile-core.ts');
    assert.doesNotMatch(coreCard, /wallet/i);
    assert.match(coreCard, /rail !== 'event_ticket'/);
  });

  test('the Admin panel shows Wallet rows, and offers Repair only for a card charge', () => {
    const panel = code(read(WEB, 'components/admin/RefundReconciliationPanel.tsx'));
    assert.match(panel, /const WALLET_RAIL = "event_ticket_wallet"/);
    assert.match(panel, /wallet \? \(\s*<p className="mt-2 text-xs text-ink-muted">/);
    const walletBranch = panel.slice(panel.indexOf('wallet ? ('), panel.indexOf('Repair…'));
    assert.match(walletBranch, /Refund again|Refund again on the order|pressing Refund again/);
  });
});
