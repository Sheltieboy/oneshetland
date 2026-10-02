/**
 * wallet-event-reconcile-core.ts — did a refunded WALLET-funded event ticket
 * order put everything back, and can we prove it?
 *
 * Why this exists. refund-reconcile-core.ts answers that question for a card
 * payment from Stripe's charge: the customer refund, the merchant transfer
 * reversal and the application-fee refund all hang off a PaymentIntent. A
 * Wallet-funded order has none of those. Its payment reference is the synthetic
 * `wallet_<ledger id>`, there is no charge and no application fee, and the
 * money moved like this:
 *
 *   customer Wallet  -£1.96   one `spend` ledger row, key `event-tickets:<order>`
 *   merchant         +£1.00   a Connect transfer of the face value (pooled platform funds)
 *   OneShetland      keeps £0.96 — the fee never leaves the platform balance
 *
 * so the truth is in two places, and this derives the verdict from both:
 *
 *   OUR LEDGER    the spend, and every ledger row that reverses it
 *   STRIPE        the one transfer to the merchant, and how much of it came back
 *
 * Nothing here invents a PaymentIntent, and nothing here moves money: it only
 * reads facts and returns a verdict. A Wallet refund is completed by running the
 * refund again (the Wallet refund is idempotent end to end); this flags, it never
 * repairs.
 *
 * The two gaps it reports:
 *   transfer_gap   merchant money still outstanding (transfer not fully reversed)
 *   wallet_gap     customer money still outstanding (credited less than was spent)
 * both must be 0 for 'reconciled'. A booking fee has no gap of its own: it was
 * never paid out, so it is returned exactly when the customer is credited the
 * whole spend.
 *
 * No I/O: ledger and Stripe facts are injected, so the same code that runs in
 * production is what the tests drive.
 */

import { ledgerMatchesOrder, type LedgerRow } from './event-wallet-refund-core.ts';

export type WalletReconState = 'reconciled' | 'needs_repair' | 'needs_review';

export interface WalletEventFacts {
  order: {
    id: string;
    buyer_id: string;
    status: string;
    total_pence: number;
    platform_fee_pence: number;
    refunded_at: string | null;
  };
  /** The ledger spend named by the order's wallet_<id> reference, or null if it does not exist. */
  spend: LedgerRow | null;
  /** Every ledger row whose reverses_transaction_id is the spend. */
  reversals: { id: string; user_id: string; type: string; amount_pence: number }[];
  /**
   * The Stripe transfer behind the spend, or null when the ledger records no
   * transfer (the merchant was never paid, so nothing is owed back).
   */
  transfer: { id: string; amount: number; amount_reversed: number; reversal_count: number } | null;
}

export type WalletAssessment =
  | { state: 'not_applicable' | 'not_refunded'; reason: string }
  | {
      state: WalletReconState;
      transfer_gap: number;
      wallet_gap: number;
      debited: number;
      credited: number;
      reversal_count: number;
      reason: string;
    };

const review = (reason: string, f: WalletEventFacts, extra: Partial<{ debited: number; credited: number; reversal_count: number; transfer_gap: number; wallet_gap: number }> = {}): WalletAssessment => ({
  state: 'needs_review',
  transfer_gap: extra.transfer_gap ?? 0,
  wallet_gap: extra.wallet_gap ?? 0,
  debited: extra.debited ?? (f.spend ? Math.abs(f.spend.amount_pence) : 0),
  credited: extra.credited ?? 0,
  reversal_count: extra.reversal_count ?? f.reversals.length,
  reason,
});

export function assessWalletEventOrder(f: WalletEventFacts): WalletAssessment {
  const { order, spend } = f;
  if (order.status !== 'refunded') return { state: 'not_refunded', reason: 'the order is not refunded' };
  if (!(order.total_pence > 0)) return { state: 'not_applicable', reason: 'a free order has no money to reconcile' };

  if (!spend) return review('the wallet payment behind this order is not in the ledger', f, { debited: 0 });
  const match = ledgerMatchesOrder(
    { id: order.id, buyer_id: order.buyer_id, total_pence: order.total_pence, stripe_payment_intent_id: '' },
    spend,
  );
  if (!match.ok) return review(`the ledger spend does not belong to this order: ${match.reason}`, f);

  const debited = Math.abs(spend.amount_pence);
  const credits = f.reversals.filter((r) => r.type === 'refund');
  const stray = f.reversals.filter((r) => r.type !== 'refund');
  if (stray.length > 0) return review('a ledger row reverses the spend but is not a refund', f, { debited });
  if (credits.some((r) => r.user_id !== order.buyer_id)) {
    return review('a refund credit went to a different customer than the one who paid', f, { debited });
  }
  const credited = credits.reduce((n, r) => n + r.amount_pence, 0);
  const reversal_count = credits.length;
  const wallet_gap = debited - credited;

  // ── the merchant leg ──
  let transfer_gap = 0;
  if (f.transfer) {
    const face = order.total_pence - order.platform_fee_pence;
    if (f.transfer.amount !== face) {
      return review(`the transfer is ${f.transfer.amount}p but the ticket face value is ${face}p`, f, { debited, credited, reversal_count, wallet_gap });
    }
    transfer_gap = Math.max(0, f.transfer.amount - f.transfer.amount_reversed);
    if (f.transfer.reversal_count > 1) {
      return review(`the transfer was reversed in ${f.transfer.reversal_count} parts`, f, { debited, credited, reversal_count, wallet_gap, transfer_gap });
    }
  }

  // ── the customer leg ──
  if (credited > debited || reversal_count > 1) {
    return review(`the customer was credited ${credited}p across ${reversal_count} refund row(s) against a ${debited}p spend`, f, { debited, credited, reversal_count, wallet_gap, transfer_gap });
  }
  if (credited > 0 && credited < debited) {
    return review(`the customer was credited ${credited}p of a ${debited}p spend`, f, { debited, credited, reversal_count, wallet_gap, transfer_gap });
  }
  if (credited === 0) {
    return {
      state: 'needs_repair', transfer_gap, wallet_gap, debited, credited, reversal_count,
      reason: `the order is refunded but the customer has not been credited the ${debited}p they paid`,
    };
  }

  // credited === debited, exactly one refund row
  if (transfer_gap > 0) {
    const partly = f.transfer !== null && f.transfer.amount_reversed > 0;
    return {
      state: partly ? 'needs_review' : 'needs_repair', transfer_gap, wallet_gap: 0, debited, credited, reversal_count,
      reason: partly
        ? `the merchant transfer is only partly reversed — ${transfer_gap}p is still with the merchant`
        : `the customer was refunded but the merchant still holds the ${transfer_gap}p transfer`,
    };
  }
  return {
    state: 'reconciled', transfer_gap: 0, wallet_gap: 0, debited, credited, reversal_count,
    reason: 'customer credited in full, merchant transfer fully reversed, booking fee returned with the credit',
  };
}

/* ── Orchestration, with the ledger, Stripe and storage injected ──────────── */

export interface WalletReconStore {
  /** The recorded row for this order, if any. */
  load(orderId: string): Promise<{ state: string; first_flagged_at: string | null } | null>;
  /** Upsert one row per order. Must preserve first_flagged_at once set. */
  save(row: {
    order_id: string;
    state: WalletReconState;
    facts: WalletEventFacts;
    assessment: Extract<WalletAssessment, { transfer_gap: number }>;
  }): Promise<void>;
  event(orderId: string, kind: 'detected' | 'verified' | 'review', actor: string, detail: Record<string, unknown>): Promise<void>;
}

export interface WalletFactsSource {
  /** Reads the ledger and Stripe (GET only). Null if the order does not exist. Throws if Stripe cannot be read. */
  loadFacts(orderId: string): Promise<WalletEventFacts | null>;
}

export interface WalletReconcileResult {
  order_id: string;
  state: WalletReconState | 'not_applicable' | 'not_refunded' | 'unverified' | 'error';
  transfer_gap: number;
  wallet_gap: number;
  note: string;
}

/**
 * Re-derive the verdict from live facts and record it. Safe to run any number
 * of times: it recomputes from the sources every time, keeps one row per order,
 * and writes an audit event only when the verdict CHANGES, so a sweep that
 * re-confirms the same state every half hour leaves no noise.
 *
 * If the facts cannot be read it records nothing and says so — an unreadable
 * Stripe must never turn into a clean bill of health, nor erase a flag.
 */
export async function reconcileWalletEventOrder(
  source: WalletFactsSource, store: WalletReconStore, orderId: string, actor: string,
): Promise<WalletReconcileResult> {
  let facts: WalletEventFacts | null;
  try {
    facts = await source.loadFacts(orderId);
  } catch (e) {
    return { order_id: orderId, state: 'error', transfer_gap: 0, wallet_gap: 0, note: `could not read the facts: ${msg(e)}` };
  }
  if (!facts) return { order_id: orderId, state: 'error', transfer_gap: 0, wallet_gap: 0, note: 'order not found' };

  const a = assessWalletEventOrder(facts);
  if (a.state === 'not_applicable' || a.state === 'not_refunded') {
    return { order_id: orderId, state: a.state, transfer_gap: 0, wallet_gap: 0, note: a.reason };
  }

  const prior = await store.load(orderId);
  await store.save({ order_id: orderId, state: a.state, facts, assessment: a });

  if (!prior || prior.state !== a.state) {
    if (a.state === 'reconciled') await store.event(orderId, 'verified', actor, { transfer_gap: 0, wallet_gap: 0 });
    else if (a.state === 'needs_review') await store.event(orderId, 'review', actor, { transfer_gap: a.transfer_gap, wallet_gap: a.wallet_gap, reason: a.reason });
    else await store.event(orderId, 'detected', actor, { transfer_gap: a.transfer_gap, wallet_gap: a.wallet_gap, reason: a.reason });
  }
  return { order_id: orderId, state: a.state, transfer_gap: a.transfer_gap, wallet_gap: a.wallet_gap, note: a.reason };
}

function msg(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}
