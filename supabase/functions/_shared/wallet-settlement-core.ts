/**
 * wallet-settlement-core.ts — the ONE way a wallet-checkout route spends.
 *
 * wallet-checkout's routes (hub donation, hub membership, pass purchase, shift
 * boost) used to call debitAndTransfer directly, so three of them debited the
 * customer and only THEN asked Stripe to move money to the merchant — with no
 * check that the platform could fund it (the 2 Oct £1.96 event-ticket purchase
 * made while Local Wallet read Critical was the same bug on another rail).
 * Every route now goes through this, which puts the shared liquidity gate in
 * front of the debit:
 *
 *   · the amount asked of the gate is the transfer that will LEAVE Stripe for
 *     the merchant, taken from the same object the transfer is made from — so it
 *     is always the final, resolved amount, and there is no second copy to drift;
 *   · a transfer of nothing (the platform-funded shift boost) needs no gate, and
 *     that is decided here from the arguments, never by the caller;
 *   · a refusal happens BEFORE the debit: no ledger row, no transfer, and — when
 *     this is a fresh attempt — no attempt left behind, so the SAME reference can
 *     be paid once liquidity returns;
 *   · the reservation is held across debit + transfer and released in finally
 *     (that is the gate's job, unchanged, shared with event tickets and gifts).
 *
 * A RESUMED attempt is different and is not described as "nothing was taken":
 * its customer was already debited on an earlier request and only the merchant
 * transfer is still owed. Refusing to retry it now leaves it exactly as it was
 * (unresolved, retry-safe) and says so.
 *
 * No I/O: the gate and the ledger are injected, so the exact code that guards
 * production is what the tests drive.
 */

import type { GateOutcome } from './wallet-liquidity-gate-core.ts';

/** Same wording family as the till / Wallet preflight UX. Only used when nothing was debited. */
export const WALLET_UNAVAILABLE_TITLE = 'Wallet temporarily unavailable';
export const WALLET_UNAVAILABLE_NO_CHARGE = `${WALLET_UNAVAILABLE_TITLE}. No money has been taken. Please use another payment method.`;
export const WALLET_UNAVAILABLE_RESUMING =
  'Your wallet payment is still being completed. Nothing more has been taken — please try again shortly.';

export type Declined = {
  kind: 'declined';
  status: 503;
  body: { error: string; reason: 'liquidity_unavailable'; no_charge: boolean };
};

export interface SettlementDeps {
  /** The shared gate (withWalletLiquidityGate): snapshot → fail closed → atomic reserve → settle → release in finally. */
  gate<T>(transferPence: number, settle: () => Promise<T>): Promise<GateOutcome<T>>;
  /** Remove this attempt's claim, but only if nothing was debited under it. */
  releaseUnstartedAttempt(): Promise<void>;
}

export interface SettlementArgs<P> {
  /** claim_wallet_attempt's outcome for this request: 'claimed' (fresh) or 'resume' (money already moved). */
  attemptOutcome: string;
  /** The transfer that will leave Stripe — or undefined for a platform-funded spend. */
  transfer?: { amountPence: number };
  /** The debit + transfer itself (debitAndTransfer). Only ever called inside the gate. */
  debit(): Promise<P>;
}

export async function settleMerchantWalletPayment<P>(
  deps: SettlementDeps, a: SettlementArgs<P>,
): Promise<Declined | { kind: 'settled'; paid: P }> {
  const transferPence = a.transfer?.amountPence ?? 0;
  const gate = await deps.gate(transferPence, a.debit);
  if (gate.ok) return { kind: 'settled', paid: gate.value };

  // Refused before anything moved.
  if (a.attemptOutcome === 'resume') {
    return {
      kind: 'declined', status: 503,
      body: { error: WALLET_UNAVAILABLE_RESUMING, reason: 'liquidity_unavailable', no_charge: false },
    };
  }
  await deps.releaseUnstartedAttempt();
  return {
    kind: 'declined', status: 503,
    body: { error: WALLET_UNAVAILABLE_NO_CHARGE, reason: 'liquidity_unavailable', no_charge: true },
  };
}
