/**
 * event-wallet-refund-core.ts — refunding an event ticket order that was paid
 * from the customer's OneShetland Wallet.
 *
 * A Wallet-funded ticket is NOT a card payment. There is no PaymentIntent, no
 * charge and no application fee: the order's payment reference is the synthetic
 * `wallet_<ledger transaction id>`. The money moved like this:
 *
 *   customer Wallet  -£1.96   (one `spend` ledger row, key `event-tickets:<order>`)
 *   merchant         +£1.00   (a Connect transfer of the face value, from pooled Stripe funds)
 *   OneShetland      keeps £0.96 booking fee (it simply never leaves the platform balance)
 *
 * so the correct refund is the Wallet one, reusing the canonical primitives the
 * Wallet membership refund already uses — NOT a card refund forced onto it:
 *
 *   1. claw back the merchant's Connect transfer (idempotent: a transfer already
 *      fully reversed counts as done)
 *   2. wallet_reverse_debit — restores the WHOLE spend to the Wallet exactly
 *      once, as a single reversal row linked to the original; the booking fee
 *      comes back with it because the platform never paid it out
 *   3. void the order's tickets with the same idempotent function the webhook
 *      uses
 *
 * Order matters and every step is safe to repeat: if the transfer is reversed but
 * the credit fails, a retry skips the reversal and credits; if the credit lands
 * but the tickets do not void, a retry sees the reversal already recorded and
 * only voids. Nothing is ever credited twice or clawed back twice.
 *
 * No imports and no I/O: dependencies are injected so the code that moves money
 * is the code the tests drive.
 */

export const WALLET_REF_PREFIX = 'wallet_';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isWalletRef = (ref: string | null | undefined): boolean =>
  typeof ref === 'string' && ref.startsWith(WALLET_REF_PREFIX);

/** The ledger transaction id inside `wallet_<uuid>`, or null if the reference is malformed. */
export function walletTxId(ref: string | null | undefined): string | null {
  if (!isWalletRef(ref)) return null;
  const id = (ref as string).slice(WALLET_REF_PREFIX.length);
  return UUID.test(id) ? id.toLowerCase() : null;
}

export interface LedgerRow {
  id: string;
  user_id: string;
  type: string;
  amount_pence: number;
  stripe_transfer_id: string | null;
  transfer_state: string | null;
  idempotency_key: string | null;
}

export interface WalletEventOrder {
  id: string;
  buyer_id: string;
  total_pence: number;
  stripe_payment_intent_id: string;
}

/**
 * The ledger row must be THIS order's payment, proven from our own rows — the
 * reference on the order alone is not trusted. Same spend, same customer, same
 * amount, and the idempotency key the checkout wrote for this order.
 */
export function ledgerMatchesOrder(order: WalletEventOrder, row: LedgerRow): { ok: true } | { ok: false; reason: string } {
  if (row.type !== 'spend') return { ok: false, reason: 'the ledger entry is not a spend' };
  if (row.user_id !== order.buyer_id) return { ok: false, reason: 'the ledger entry belongs to a different customer' };
  if (row.amount_pence !== -order.total_pence) return { ok: false, reason: 'the ledger amount does not match the order total' };
  if (row.idempotency_key !== `event-tickets:${order.id}`) return { ok: false, reason: 'the ledger entry was not written for this order' };
  return { ok: true };
}

export type MerchantOutcome = 'clawed_back' | 'no_transfer';

export interface WalletRefundDeps {
  loadLedgerRow(txId: string): Promise<LedgerRow | null>;
  /** Idempotent: reads the transfer first and treats one already fully reversed as done. Throws if Stripe refuses. */
  reverseTransfer(transferId: string): Promise<void>;
  reverseDebit(txId: string, reason: string, merchant: MerchantOutcome):
    Promise<{ ok: true; reversalId: string; alreadyReversed: boolean; balancePence: number } | { ok: false; message: string }>;
  voidTickets(ref: string): Promise<{ ok: true; action: string } | { ok: false; message: string }>;
}

export type WalletRefundResult =
  | {
      ok: true; rail: 'wallet'; amount_pence: number; merchant_reversed: boolean;
      already_reversed: boolean; reversal_id: string; tickets_action: string;
    }
  | { ok: false; status: number; error: string; stage?: string; retry_safe?: boolean };

export async function refundWalletEventOrder(
  deps: WalletRefundDeps, order: WalletEventOrder, label: string, actorId: string,
): Promise<WalletRefundResult> {
  const txId = walletTxId(order.stripe_payment_intent_id);
  if (!txId) return { ok: false, status: 400, error: 'This wallet payment has no ledger reference to reverse.' };

  const row = await deps.loadLedgerRow(txId);
  if (!row) return { ok: false, status: 409, error: 'The wallet payment behind this order could not be found, so nothing was refunded.' };

  const match = ledgerMatchesOrder(order, row);
  if (!match.ok) {
    return { ok: false, status: 409, error: `This order cannot be refunded automatically: ${match.reason}. Nothing was changed.` };
  }

  // Where did the merchant's money get to? Only a transfer that is actually
  // there is clawed back; one that never happened is not.
  if (row.transfer_state === 'unresolved' || row.transfer_state === 'pending') {
    return {
      ok: false, status: 409,
      error: 'The payment to the organiser has not finished settling, so it cannot be refunded yet. Nothing was changed — settle it at Stripe first.',
    };
  }
  if (row.transfer_state === 'sent' && !row.stripe_transfer_id) {
    return {
      ok: false, status: 409,
      error: 'The ledger says the organiser was paid but holds no transfer reference, so it cannot be refunded automatically. Nothing was changed.',
    };
  }
  const needsClawback = row.transfer_state === 'sent' && !!row.stripe_transfer_id;
  const merchant: MerchantOutcome = row.transfer_state === 'sent' || row.transfer_state === 'reversed' ? 'clawed_back' : 'no_transfer';

  let merchantReversed = row.transfer_state === 'reversed';
  if (needsClawback) {
    try {
      await deps.reverseTransfer(row.stripe_transfer_id as string);
      merchantReversed = true;
    } catch {
      return {
        ok: false, status: 502, stage: 'nothing_changed', retry_safe: true,
        error: 'Could not reverse the organiser payout, so nothing was refunded. Please try again.',
      };
    }
  }

  const rev = await deps.reverseDebit(txId, `Refund · event tickets · ${label} · by ${actorId.slice(0, 8)}`, merchant);
  if (!rev.ok) {
    return merchantReversed && needsClawback
      ? {
          ok: false, status: 500, stage: 'merchant_reversed_wallet_pending', retry_safe: true,
          error: 'The organiser payout was reversed, but the money has not reached the Wallet yet. Nothing has been taken twice — press Refund again to finish it.',
        }
      : { ok: false, status: 500, retry_safe: true, error: 'The refund could not be recorded in the Wallet. Nothing was changed — please try again.' };
  }

  const voided = await deps.voidTickets(order.stripe_payment_intent_id);
  if (!voided.ok) {
    return {
      ok: false, status: 500, stage: 'wallet_credited_tickets_pending', retry_safe: true,
      error: 'The money is back in the Wallet, but the tickets have not been voided yet. Press Refund again to finish it — nothing will be paid twice.',
    };
  }

  return {
    ok: true, rail: 'wallet', amount_pence: order.total_pence, merchant_reversed: merchantReversed,
    already_reversed: rev.alreadyReversed, reversal_id: rev.reversalId, tickets_action: voided.action,
  };
}
