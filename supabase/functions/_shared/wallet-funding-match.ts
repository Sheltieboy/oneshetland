/**
 * wallet-funding-match.ts — pure rules for recognising a push bank transfer
 * when it lands at Stripe. No imports, no I/O, so it is directly testable.
 *
 * A bank credit to the Payments balance is NOT "the balance went up": card
 * revenue also raises the balance. A funding session is therefore matched only
 * against Stripe objects that can represent a funding credit — Topup objects,
 * and balance transactions of type topup/adjustment — and only when the
 * amount is EXACTLY the amount the operator said they were sending, the
 * currency is GBP, the object was created no earlier than the session, and
 * no other session has already claimed it. Charges, fees, refunds, transfers
 * and the like are never candidates.
 */

export type FundingSessionStatus =
  'awaiting_funds' | 'pending_at_stripe' | 'available' | 'expired' | 'cancelled' | 'failed';

export const OPEN_SESSION_STATUSES: FundingSessionStatus[] = ['awaiting_funds', 'pending_at_stripe'];

/** Tolerance for clock difference between Stripe and our database. */
export const CLOCK_SLACK_SECONDS = 120;

export interface FundingCandidate {
  ref: string;
  kind: 'topup' | 'balance_transaction';
  amount_pence: number;
  currency: string;
  created_unix: number;
  state: 'pending' | 'available' | 'failed';
  /** When Stripe says the funds become transferable (unix seconds), if known. */
  available_on_unix?: number | null;
}

export interface MatchableSession {
  status: FundingSessionStatus;
  requested_amount_pence: number;
  created_at: string;
  matched_ref?: string | null;
}

/**
 * Stripe Topup object -> candidate. Anything unrecognised is not a candidate.
 *
 * A Topup's status 'succeeded' means Stripe HAS RECEIVED the money — NOT that
 * it is available. Observed live: a succeeded Topup whose balance transaction
 * was still 'pending' for ~5 days (available_on in the future), with the
 * amount sitting in Stripe's PENDING balance. Availability therefore comes
 * only from the Topup's own balance transaction: 'available' only when that
 * balance transaction's status is 'available'. With no balance transaction to
 * prove it, a succeeded Topup is conservatively 'pending'.
 */
export function candidateFromTopup(
  t: Record<string, unknown>, balanceTxn?: Record<string, unknown> | null,
): FundingCandidate | null {
  if (typeof t?.id !== 'string' || typeof t.amount !== 'number' || typeof t.created !== 'number') return null;
  const status = t.status;
  const state = status === 'succeeded' ? (balanceTxn?.status === 'available' ? 'available' : 'pending')
    : status === 'pending' ? 'pending'
    : status === 'failed' || status === 'canceled' || status === 'reversed' ? 'failed'
    : null;
  if (!state) return null;
  const availableOn = typeof balanceTxn?.available_on === 'number' ? balanceTxn.available_on
    : typeof t.expected_availability_date === 'number' ? t.expected_availability_date
    : null;
  return {
    ref: t.id, kind: 'topup', amount_pence: t.amount,
    currency: String(t.currency ?? '').toLowerCase(), created_unix: t.created, state,
    available_on_unix: availableOn,
  };
}

const FUNDING_BALANCE_TXN_TYPES = new Set(['topup', 'adjustment']);

/**
 * Balance transaction -> candidate. Only positive topup/adjustment entries
 * qualify; charge, payment, stripe_fee, refund, transfer, etc. return null,
 * which is what stops ordinary revenue reconciling a funding transfer.
 */
export function candidateFromBalanceTransaction(bt: Record<string, unknown>): FundingCandidate | null {
  if (typeof bt?.id !== 'string' || typeof bt.amount !== 'number' || typeof bt.created !== 'number') return null;
  if (typeof bt.type !== 'string' || !FUNDING_BALANCE_TXN_TYPES.has(bt.type)) return null;
  if (bt.amount <= 0) return null;
  return {
    ref: bt.id, kind: 'balance_transaction', amount_pence: bt.amount,
    currency: String(bt.currency ?? '').toLowerCase(), created_unix: bt.created,
    state: bt.status === 'available' ? 'available' : 'pending',
    available_on_unix: typeof bt.available_on === 'number' ? bt.available_on : null,
  };
}

export function isEligibleCandidate(
  session: MatchableSession, c: FundingCandidate, claimedByOthers: ReadonlySet<string>,
): boolean {
  if (c.currency !== 'gbp') return false;
  if (c.amount_pence !== session.requested_amount_pence) return false;
  if (claimedByOthers.has(c.ref)) return false;
  const sessionUnix = Math.floor(new Date(session.created_at).getTime() / 1000);
  return c.created_unix >= sessionUnix - CLOCK_SLACK_SECONDS;
}

/**
 * Pick the one candidate for this session, or null. A session that already
 * matched keeps its match; otherwise Topup objects beat raw balance
 * transactions, then the earliest wins.
 */
export function pickFundingMatch(
  session: MatchableSession, candidates: FundingCandidate[], claimedByOthers: ReadonlySet<string>,
): FundingCandidate | null {
  if (session.matched_ref) {
    const own = candidates.find((c) => c.ref === session.matched_ref);
    if (own) return own;
  }
  const eligible = candidates.filter((c) => isEligibleCandidate(session, c, claimedByOthers));
  if (eligible.length === 0) return null;
  eligible.sort((a, b) =>
    (a.kind === b.kind ? 0 : a.kind === 'topup' ? -1 : 1) || a.created_unix - b.created_unix);
  return eligible[0];
}

export interface SessionTransition {
  status: FundingSessionStatus;
  note: string | null;
}

/** What an OPEN session should become, given its match (if any). null = unchanged. */
export function nextSessionState(
  session: MatchableSession, match: FundingCandidate | null, now: Date, expiryHours: number,
): SessionTransition | null {
  if (match) {
    const status: FundingSessionStatus =
      match.state === 'available' ? 'available'
      : match.state === 'pending' ? 'pending_at_stripe'
      : 'failed';
    const note = status === 'failed' ? 'Stripe reported the incoming funding as failed, cancelled or reversed.' : null;
    return status === session.status ? null : { status, note };
  }
  if (session.status === 'awaiting_funds') {
    const ageMs = now.getTime() - new Date(session.created_at).getTime();
    if (ageMs > expiryHours * 3_600_000) {
      return {
        status: 'expired',
        note: `No Stripe credit of exactly the expected amount was found within ${expiryHours} hours. Unresolved — check the transfer with the bank.`,
      };
    }
  }
  return null;
}
