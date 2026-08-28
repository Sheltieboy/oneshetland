/**
 * fetch-hold.ts — is the money still there?
 *
 * Fixes 2–4 made WRITING `payment_status = 'authorised'` honest. Nothing made
 * READING it honest afterwards. A card authorisation is not permanent: Stripe
 * releases an uncaptured one after a few days and the PaymentIntent goes to
 * `canceled`. Our row went on saying authorised, the driver's screen went on
 * offering "Mark as collected", and capture-payment discovered the truth on
 * the doorstep with the bag already handed over.
 *
 * ── Where the deadline actually lives ────────────────────────────────────
 *
 * Not on the PaymentIntent. Stripe puts it on the CHARGE, at
 * `payment_method_details.card.capture_before`, so the intent has to be
 * retrieved with `expand[]=latest_charge` to see it. It is a Unix timestamp.
 *
 * It is NOT a constant and is not computed here. Stripe's own windows differ
 * by brand and by whether the network judged the transaction customer- or
 * merchant-initiated (Visa MIT is 4 days 18 hours; most others 7 days), and a
 * Fetch hold is confirmed by the DRIVER accepting, with the customer nowhere
 * near their phone — precisely the shape that gets classified as
 * merchant-initiated. Hard-coding seven days would be wrong by two days for
 * one card brand and silently right for the rest, which is the worst kind of
 * wrong. When Stripe gives no deadline, none is invented: the status
 * reconciliation below is the authority either way.
 */

import { classifyAuthorisation, paymentStatusFor } from './fetch-authorisation.ts';

export type HoldState =
  /** requires_capture, and the deadline (if any) is comfortably ahead. */
  | 'valid'
  /** Still capturable, but the deadline is close enough to act on. */
  | 'expiring_soon'
  /** The hold is gone — released, lapsed or cancelled. No money is held. */
  | 'expired'
  /** The customer has something to do: authenticate, or supply a card. */
  | 'customer_action_required'
  /** We could not determine the truth. NOT a hold, and never treated as one. */
  | 'unresolved'
  /** Already captured. Nothing left that can expire. */
  | 'captured';

/** How close to the deadline counts as "act now". Twelve hours. */
export const EXPIRING_SOON_MS = 12 * 60 * 60 * 1000;

export type HoldReading = {
  state: HoldState;
  /** What delivery_requests.payment_status should say. */
  paymentStatus: string;
  /** Operator detail. Never shown to a customer verbatim. */
  detail: string;
  /** Stripe's capture deadline as an ISO string, or null when it gave none. */
  expiresAt: string | null;
  status?: string;
  amountCapturable?: number;
  amountReceived?: number;
  cancellationReason?: string | null;
};

/** Is this reading good enough to let a driver take possession? */
export const holdIsFulfillable = (r: HoldReading) =>
  r.state === 'valid' || r.state === 'expiring_soon' || r.state === 'captured';

/**
 * The Stripe deadline, dug out of the expanded charge. Null if absent — which
 * is a real answer, not a reason to substitute a number of our own.
 */
// deno-lint-ignore no-explicit-any
export function captureDeadline(pi: any): number | null {
  const charge = pi?.latest_charge;
  // A bare id means the caller forgot expand[]=latest_charge. Not a deadline.
  if (!charge || typeof charge !== 'object') return null;
  const before = charge?.payment_method_details?.card?.capture_before;
  return typeof before === 'number' && before > 0 ? before * 1000 : null;
}

/**
 * One PaymentIntent, one verdict.
 *
 * `requires_capture` is not by itself enough. If Stripe's own deadline has
 * already passed we say expired even though the status has not caught up yet:
 * the funds are released at the network long before the object is tidied, and
 * being early here costs a re-authorisation while being late costs a delivery
 * nobody can charge for.
 */
export function classifyHold(pi: Record<string, unknown>, nowMs: number): HoldReading {
  const outcome = classifyAuthorisation(pi?.status as string | undefined);
  const deadline = captureDeadline(pi);
  const expiresAt = deadline ? new Date(deadline).toISOString() : null;
  const reason = (pi?.cancellation_reason as string | null) ?? null;
  const base = {
    expiresAt,
    status: pi?.status as string | undefined,
    amountCapturable: typeof pi?.amount_capturable === 'number' ? pi.amount_capturable as number : undefined,
    amountReceived:   typeof pi?.amount_received   === 'number' ? pi.amount_received   as number : undefined,
    cancellationReason: reason,
  };

  switch (outcome.kind) {
    case 'authorised': {
      if (deadline !== null && deadline <= nowMs) {
        return { ...base, state: 'expired', paymentStatus: 'expired',
                 detail: 'the capture deadline has passed' };
      }
      if (deadline !== null && deadline - nowMs <= EXPIRING_SOON_MS) {
        return { ...base, state: 'expiring_soon', paymentStatus: 'authorised',
                 detail: `expires ${expiresAt}` };
      }
      return { ...base, state: 'valid', paymentStatus: 'authorised',
               detail: expiresAt ? `expires ${expiresAt}` : 'no deadline reported by Stripe' };
    }
    case 'succeeded':
      return { ...base, state: 'captured', paymentStatus: 'captured', detail: 'already captured' };
    case 'canceled':
      // Lapsed ('expired' / 'automatic'), or released by somebody. Either way
      // no money is held; the reason is kept so operations can tell them apart.
      return { ...base, state: 'expired', paymentStatus: 'expired',
               detail: `canceled: ${reason ?? 'no reason given'}` };
    case 'requires_action':
    case 'requires_payment_method':
      return { ...base, state: 'customer_action_required', paymentStatus: paymentStatusFor(outcome),
               detail: outcome.kind };
    case 'processing':
    case 'unknown':
    default:
      return { ...base, state: 'unresolved', paymentStatus: paymentStatusFor(outcome),
               detail: `unresolved: ${pi?.status ?? 'missing'}` };
  }
}

/**
 * Retrieve the intent and classify it. Never throws — an unreachable Stripe is
 * a state, and that state is 'unresolved', which releases nobody.
 */
export async function readHold(
  stripeKey: string,
  paymentIntentId: string,
  nowMs: number = Date.now(),
): Promise<HoldReading> {
  try {
    const res = await fetch(
      // The deadline is on the charge, so the charge has to come back with it.
      `https://api.stripe.com/v1/payment_intents/${paymentIntentId}?expand[]=latest_charge`,
      { headers: { 'Authorization': `Bearer ${stripeKey}`, 'Stripe-Version': '2023-10-16' } },
    );
    const pi = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { state: 'unresolved', paymentStatus: 'processing', expiresAt: null,
               detail: `could not read the intent: ${pi?.error?.message ?? `HTTP ${res.status}`}` };
    }
    return classifyHold(pi, nowMs);
  } catch (e) {
    return { state: 'unresolved', paymentStatus: 'processing', expiresAt: null,
             detail: e instanceof Error ? e.message : 'Stripe unreachable' };
  }
}

/** What the driver is told. Never "proceed", and never a raw Stripe string. */
export function driverMessage(state: HoldState): string {
  switch (state) {
    case 'valid':
    case 'expiring_soon':
    case 'captured':
      return '';
    case 'expired':
      return 'Customer payment authorisation has expired. Wait for the customer to re-authorise before collecting.';
    case 'customer_action_required':
      return 'The customer still has to confirm their payment. Please don’t collect until this clears.';
    case 'unresolved':
      return 'We could not confirm the customer’s payment hold just now. Please don’t collect — try again in a moment.';
  }
}
