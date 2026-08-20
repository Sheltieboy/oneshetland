/**
 * wallet-pay.ts — the single, shared wallet-payment execution path.
 *
 * Both entry points use it so the money logic (fee, cashback, atomic debit,
 * Stripe transfer, refund-on-failure, receipts) lives in ONE place and can't
 * drift between them:
 *   • local-wallet-pay        — customer enters the business's till code
 *   • wallet-charge-approve   — customer approves a business's scan-to-charge
 *
 * Validation that is specific to each entry (code lookup / request lookup) stays
 * in the caller; this helper takes an already-resolved business + amount.
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { calculateCommission } from './commission.ts';
import { debitAndTransfer } from './wallet-ledger.ts';
import { getCommissionConfig } from './commission-config.ts';
import { sendUserPush } from './send-push.ts';

export interface PayBusiness {
  id: string;
  name: string;
  owner_id: string;
  accepts_wallet: boolean;
  cashback_percent: number | null;
  stripe_account_id: string | null;
  payout_enabled: boolean;
}

export type WalletPayResult =
  | { ok: true; balance_pence: number; cashback_pence: number; transfer_id: string | null; transactionId: string | null; alreadyApplied: boolean }
  // `reason` and `transactionId` are surfaced because the caller has to tell an
  // unresolved transfer (keep the attempt, resume it) apart from a rejection
  // (terminal, already reversed) — and needs the transaction to point at.
  // 'ineligible' is a pre-flight refusal — nothing was attempted, no wallet
  // transaction exists, and the attempt is terminally failed rather than
  // resumable.
  | { ok: false; status: number; error: string; reason: 'ineligible' | 'insufficient' | 'rejected' | 'unresolved'; transactionId?: string };

/**
 * Debit the customer's wallet and pay the business, atomically and idempotently.
 * Returns a discriminated result the caller maps to an HTTP status. Never throws
 * for an expected business condition (insufficient funds, not onboarded, …) —
 * only a genuine infrastructure error propagates.
 */
export async function executeWalletPayment(
  svc: SupabaseClient,
  args: { userId: string; business: PayBusiness; amountPence: number; idempotencyKey?: string; label?: string },
): Promise<WalletPayResult> {
  const { userId, business, amountPence } = args;

  if (business.owner_id === userId) return { ok: false, status: 403, error: "Can't pay yourself", reason: 'ineligible' };
  if (!business.accepts_wallet) return { ok: false, status: 400, error: "This business doesn't accept wallet payments yet", reason: 'ineligible' };
  if (!business.stripe_account_id || !business.payout_enabled) {
    return { ok: false, status: 400, error: "Business hasn't finished Stripe onboarding", reason: 'ineligible' };
  }

  // Cashback is BUSINESS-FUNDED — comes out of the merchant's transfer.
  const cashbackPence = Math.floor(amountPence * (business.cashback_percent ?? 0) / 100);
  const walletCfg = await getCommissionConfig(svc, 'wallet');
  const platformFee = calculateCommission(amountPence, walletCfg, 'wallet').fee_pence;
  const transferAmount = amountPence - platformFee - cashbackPence;
  if (transferAmount < 1) {
    return { ok: false, status: 400, error: "This payment can't be processed — the business's cashback rate and platform fee together exceed the payment amount.", reason: 'ineligible' };
  }

  // ── Debit, transfer, settle ────────────────────────────────────────────
  //
  // This used to be three separate steps: an RPC that committed the balance, a
  // Stripe call, then an unchecked ledger insert whose result nobody looked at.
  // If that insert failed the customer was down with no record of why — which is
  // exactly what production's £233.45 of unaccounted wallet movement looks like.
  //
  // Now the debit and its accounting entry are one transaction, the transfer is
  // keyed on that transaction's id, and the row records where the transfer got
  // to. Cashback is written as its own positive entry by the same call.
  const result = await debitAndTransfer(svc, {
    userId,
    spendPence:       amountPence,
    cashbackPence,
    businessId:       business.id,
    description:      args.label ?? `Payment at ${business.name}`,
    idempotencyKey:   args.idempotencyKey ?? null,
    platformFeePence: platformFee,
    transfer: {
      destination: business.stripe_account_id!,
      amountPence: transferAmount,
      description: `OneShetland Marketplace payment from ${userId.slice(0, 8)} (£${(platformFee / 100).toFixed(2)} platform fee${cashbackPence > 0 ? ` + £${(cashbackPence / 100).toFixed(2)} cashback to customer` : ''})`,
      metadata: {
        user_id:                    userId,
        business_id:                business.id,
        application_fee_label:      'OneShetland platform fee',
        application_fee_pence:      String(platformFee),
        cashback_to_customer_pence: String(cashbackPence),
      },
    },
  });

  if (!result.ok) {
    return { ok: false, status: result.status, error: result.error, reason: result.reason, transactionId: result.transactionId };
  }

  const newBalance = result.balancePence;
  const transferId = result.transferId;

  // Receipts (best-effort): customer paid, owner received.
  try {
    const paid = `£${(amountPence / 100).toFixed(2)}`;
    const cashbackNote = cashbackPence > 0 ? ` You earned £${(cashbackPence / 100).toFixed(2)} cashback.` : '';
    await sendUserPush(svc, {
      userId, module: 'wallet', categoryId: 'wallet.payment',
      title: 'Payment sent',
      body: `You paid ${paid} at ${business.name}.${cashbackNote}`,
      data: { screen: 'local-wallet' },
    });
    if (business.owner_id) {
      await sendUserPush(svc, {
        userId: business.owner_id, module: 'business', categoryId: 'business.payment_received',
        title: 'Payment received 💷',
        body: `A customer paid ${paid} at ${business.name}.`,
        data: { screen: 'local-business-dashboard' },
      });
    }
  } catch (e) { console.error('[wallet-pay] notify failed', e); }

  return {
    ok: true, balance_pence: newBalance, cashback_pence: cashbackPence, transfer_id: transferId,
    transactionId: result.transactionId, alreadyApplied: result.alreadyApplied,
  };
}
