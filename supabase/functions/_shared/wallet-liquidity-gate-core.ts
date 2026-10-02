/**
 * wallet-liquidity-gate-core.ts — the question every Wallet-funded MERCHANT
 * settlement must ask before the customer is debited: "can the platform
 * actually settle this transfer from Stripe funds right now?"
 *
 * Why it exists as its own function. executeWalletPayment (tap-to-pay,
 * scan-to-charge, shop orders) asks this question inline. Event tickets, gifts
 * and the wallet-checkout routes call debitAndTransfer DIRECTLY, so they never
 * asked it: on 2 Oct 2026 a £1.96 Wallet event-ticket purchase sent a real £1.00
 * transfer to the organiser while Local Wallet liquidity read Critical
 * (available £4.93 against a £100 reserve). Any path that debits the Wallet
 * and creates a Connect transfer consumes the SAME pooled Stripe balance, so it
 * must be held to the SAME rule. This is that rule in one place.
 *
 * The rule (identical to executeWalletPayment's, deliberately):
 *   · no external transfer → nothing leaves Stripe → no gate needed
 *   · balance unreadable   → decline (fail CLOSED); "we don't know" is not a yes
 *   · liquidity disabled   → the explicit, documented fallback: proceed without a reservation
 *   · otherwise            → atomically reserve headroom ABOVE the reserve floor; decline if there isn't
 *   · the reservation is held across the settlement only, and released in finally
 *
 * A decline happens BEFORE `settle` runs, so the customer is never debited.
 *
 * No imports, no I/O: dependencies are injected, so the exact code that guards
 * production is what the tests drive.
 */

export const LIQUIDITY_DECLINED_MESSAGE =
  'Wallet payments are temporarily unavailable. Please use another payment method.';

export interface GateSnapshot {
  status: 'healthy' | 'low' | 'critical' | 'disabled' | 'unknown';
  available_pence: number;
  reserve_pence: number;
  error?: string;
}

export type GateReservation =
  | { ok: true; reservationId: string | null }
  | { ok: false; heldPence: number };

export interface GateDeps {
  snapshot(): Promise<GateSnapshot>;
  /** Atomic check-and-claim against headroom above the reserve (wallet_liquidity_reserve). */
  reserve(transferPence: number, availablePence: number, reservePence: number): Promise<GateReservation>;
  release(reservationId: string | null): Promise<void>;
  log?(level: 'warn' | 'error', message: string): void;
}

export type GateOutcome<T> =
  | { ok: true; value: T; gated: boolean }
  | { ok: false; status: 503; reason: 'liquidity_unavailable'; error: string };

const DECLINED = {
  ok: false as const, status: 503 as const, reason: 'liquidity_unavailable' as const,
  error: LIQUIDITY_DECLINED_MESSAGE,
};

/**
 * Run `settle` (debit the Wallet + create the merchant transfer) only if the
 * platform can fund `transferPence`. `transferPence` is the amount that will
 * LEAVE Stripe for the merchant — not the customer's total.
 */
export async function runWithLiquidityGate<T>(
  deps: GateDeps, transferPence: number, settle: () => Promise<T>,
): Promise<GateOutcome<T>> {
  if (!(transferPence > 0)) return { ok: true, value: await settle(), gated: false };

  const snap = await deps.snapshot();
  if (snap.status === 'unknown') {
    deps.log?.('error', `[wallet-liquidity] gate could not read Stripe balance for a ${transferPence}p transfer — declining, not guessing: ${snap.error}`);
    return DECLINED;
  }

  let reservationId: string | null = null;
  if (snap.status !== 'disabled') {
    const r = await deps.reserve(transferPence, snap.available_pence, snap.reserve_pence);
    if (!r.ok) {
      deps.log?.('warn',
        `[wallet-liquidity] gate declined: needs ${transferPence}p, available ${snap.available_pence}p, ` +
        `reserve ${snap.reserve_pence}p, already held ${r.heldPence}p`);
      return DECLINED;
    }
    reservationId = r.reservationId;
  }

  try {
    return { ok: true, value: await settle(), gated: true };
  } finally {
    await deps.release(reservationId);
  }
}
