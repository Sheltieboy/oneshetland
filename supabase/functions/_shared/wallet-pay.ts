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
import { debitAndTransfer, selfPaymentBlock } from './wallet-ledger.ts';
import { getWalletCommissionConfig } from './commission-config.ts';
import { getWalletLiquiditySnapshot, reserveWalletLiquidity, releaseWalletLiquidity } from './wallet-liquidity.ts';
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
  // 'blocked' is a wallet under refund or chargeback recovery — the debit
  // primitive refuses before anything is claimed.
  // 'liquidity_unavailable' is its own reason, deliberately distinct from
  // 'ineligible': the liquidity preflight is an intentional OPERATIONAL
  // refusal (we can see we may not be able to settle this transfer, or we
  // cannot even check) — nothing about the customer or the business is
  // wrong, unlike every other 'ineligible' cause above it. A caller must
  // never collapse this into a generic "payment failed" — see
  // wallet-charge-approve's dedicated wallet_charge_requests status and
  // the till/approval UIs' dedicated neutral treatment.
  | { ok: false; status: number; error: string; reason: 'ineligible' | 'insufficient' | 'blocked' | 'rejected' | 'unresolved' | 'liquidity_unavailable'; transactionId?: string };

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

  // Where does this business's money actually go? The same rule products and
  // event tickets already use: the business's own Connect account when it
  // has one, otherwise the owner's central account. Resolved once, here, and
  // used for both the self-payment check below and the transfer destination
  // further down, so neither can disagree with the other about which
  // account is actually being paid. This replaces a direct read of
  // business.stripe_account_id/payout_enabled, which had no such fallback
  // and wrongly refused a business that only sells through its owner's
  // central account — payable everywhere else on the platform (products,
  // event tickets), refused only here.
  const { data: payoutRows, error: payoutErr } = await svc.rpc('business_payout_destination', { p_business: business.id });
  if (payoutErr) {
    return { ok: false, status: 503, error: 'Could not check this business’s payment setup. Please try again.', reason: 'ineligible' };
  }
  const payout = Array.isArray(payoutRows) ? payoutRows[0] : payoutRows;
  const sellerAccountId: string | null = payout?.account_id ?? null;

  // The same question the wallet-checkout routes ask, and a broader one than
  // the line above: a connected account can be attached to more than one
  // resource, so owning THIS business is not the only way to end up with the
  // money. One definition, asked of the resolved destination account.
  const selfPay = await selfPaymentBlock(svc, userId, sellerAccountId);
  if (selfPay) return { ok: false, status: 403, error: selfPay.body.error, reason: 'ineligible' };
  if (!business.accepts_wallet) return { ok: false, status: 400, error: "This business doesn't accept wallet payments yet", reason: 'ineligible' };
  if (!sellerAccountId) {
    return { ok: false, status: 400, error: "Business hasn't finished Stripe onboarding", reason: 'ineligible' };
  }

  // Taking Wallet payments is Pro, and the stored flag above is not proof of
  // that: it is deliberately left as the owner configured it when a plan
  // lapses, so it can outlive the entitlement. Asked here, in the one executor
  // both routes converge on — the tap and the scan-to-charge — and before
  // anything financial: no debit, no cashback, no transfer.
  //
  // Read from the server predicate rather than re-derived, so this cannot drift
  // from what the activation guard and the customer-facing surfaces use. An
  // unreadable answer fails closed; money must not move on a maybe.
  //
  // Same shape of message as the flag-off branch above. A customer does not
  // need to know why a shop cannot take Wallet today.
  const { data: mayTakeWallet, error: tierErr } = await svc.rpc('business_meets_tier', {
    p_business_id: business.id,
    p_required_tier: 'pro',
  });
  if (tierErr || mayTakeWallet !== true) {
    return { ok: false, status: 400, error: "This business isn't currently accepting Wallet payments", reason: 'ineligible' };
  }

  // Cashback is BUSINESS-FUNDED — comes out of the merchant's transfer.
  const cashbackPence = Math.floor(amountPence * (business.cashback_percent ?? 0) / 100);
  // Tier-aware and resolved server-side, inside getWalletCommissionConfig
  // itself, from the business's own current record — never from anything
  // the caller passed in.
  const walletCfg = await getWalletCommissionConfig(svc, business.id);
  const platformFee = calculateCommission(amountPence, walletCfg, 'wallet').fee_pence;
  const transferAmount = amountPence - platformFee - cashbackPence;
  if (transferAmount < 1) {
    return { ok: false, status: 400, error: "This payment can't be processed — the business's cashback rate and platform fee together exceed the payment amount.", reason: 'ineligible' };
  }

  // ── Liquidity preflight — BEFORE the customer is ever debited ────────────
  //
  // A real £5.00 Premium payment was correctly debited, then Stripe refused
  // the £4.95 merchant transfer for insufficient platform funds. The
  // automatic reversal caught it safely, but the customer should never have
  // been debited for a transfer we could already see we might not be able to
  // settle. This asks first.
  //
  // Disabled (wallet.liquidity.enabled = false) is an explicit, safe
  // fallback: it skips straight to the original behaviour below — debit,
  // attempt the transfer, rely on the existing automatic reversal if Stripe
  // refuses it. Nothing about disabling this makes anything unsafe; it only
  // removes the early check.
  //
  // An unreadable Stripe balance (status 'unknown') fails CLOSED — we decline
  // the spend rather than guess. The whole point of this gate is "do we know
  // we can settle this?", and "we don't know" is not an answer to proceed on.
  let reservationId: string | null = null;
  const liquidity = await getWalletLiquiditySnapshot(svc);
  if (liquidity.status === 'unknown') {
    console.error(`[wallet-liquidity] preflight could not read Stripe balance for a ${transferAmount}p transfer — declining, not guessing: ${liquidity.error}`);
    return {
      ok: false, status: 503, reason: 'liquidity_unavailable',
      error: 'Wallet payments are temporarily unavailable. Please use another payment method.',
    };
  }
  if (liquidity.status !== 'disabled') {
    const reservation = await reserveWalletLiquidity(svc, transferAmount, liquidity.available_pence, liquidity.reserve_pence);
    if (!reservation.ok) {
      console.warn(
        `[wallet-liquidity] preflight declined for business ${business.id}: needs ${transferAmount}p, ` +
        `available ${liquidity.available_pence}p, reserve ${liquidity.reserve_pence}p, already held ${reservation.heldPence}p`,
      );
      return {
        ok: false, status: 503, reason: 'liquidity_unavailable',
        error: 'Wallet payments are temporarily unavailable. Please use another payment method.',
      };
    }
    reservationId = reservation.reservationId;
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
  //
  // The liquidity reservation above is held only across THIS call — once
  // Stripe has told us the outcome (or we've given up trying to find out),
  // the next balance read reflects the truth and the reservation has done its
  // job. Released in finally so an unexpected throw cannot leak it.
  let result: Awaited<ReturnType<typeof debitAndTransfer>>;
  try {
    result = await debitAndTransfer(svc, {
      userId,
      spendPence:       amountPence,
      cashbackPence,
      businessId:       business.id,
      description:      args.label ?? `Payment at ${business.name}`,
      idempotencyKey:   args.idempotencyKey ?? null,
      platformFeePence: platformFee,
      transfer: {
        destination: sellerAccountId!,
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
  } finally {
    await releaseWalletLiquidity(svc, reservationId);
  }

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
