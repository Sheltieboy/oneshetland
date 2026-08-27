/**
 * saved-card-outcome.ts — what actually happened to the saved card.
 *
 * Confirming the first subscription invoice against a saved card has four
 * distinct outcomes, and the old code had one branch for all of them:
 *
 *     catch (_e) { /* needs auth / declined → fall through to card form *\/ }
 *
 * A 3DS challenge, a declined card and a Stripe outage all landed there, and
 * the owner was shown an empty card form with no explanation — as though the
 * card they had saved did not exist. That breaks the rule the other paygates
 * settled on: a saved-card failure is an error to show, never a reason to put
 * a card form in front of somebody who did not ask for one.
 *
 * Pure on purpose, so every branch is tested without a network.
 */

export type SavedCardOutcome =
  | { kind: 'activated' }
  /** 3DS or similar: continue on the SAME PaymentIntent. */
  | { kind: 'sca' }
  /** The card said no. Show it; do not open a card form. */
  | { kind: 'declined'; message: string }
  /** Stripe or the network, not the card. Never call this a decline. */
  | { kind: 'infrastructure'; detail: string };

const GENERIC_DECLINE = 'Your saved card was declined.';

/** Stripe's own decline text is written for customers, so prefer it. */
function declineMessage(e: Record<string, unknown>): string {
  const raw = (e.raw ?? e) as Record<string, unknown>;
  const msg = typeof raw.message === 'string' ? raw.message.trim() : '';
  // Never surface anything that reads like configuration or internals.
  if (!msg || /api key|secret|token|no such|invalid request/i.test(msg)) return GENERIC_DECLINE;
  return msg;
}

function isCardError(e: Record<string, unknown>): boolean {
  const raw = (e.raw ?? {}) as Record<string, unknown>;
  return e.type === 'StripeCardError' || raw.type === 'card_error' ||
         typeof raw.decline_code === 'string' || typeof e.decline_code === 'string';
}

/**
 * @param status the PaymentIntent status when confirm returned, or null if it threw
 * @param error  the thrown error, or null
 */
export function classifySavedCardConfirm(
  status: string | null,
  error: unknown | null,
): SavedCardOutcome {
  if (error) {
    const e = (error ?? {}) as Record<string, unknown>;
    if (isCardError(e)) return { kind: 'declined', message: declineMessage(e) };
    // A Stripe outage is not the customer's card refusing.
    return { kind: 'infrastructure', detail: typeof e.message === 'string' ? e.message : 'confirm failed' };
  }

  switch (status) {
    case 'succeeded':
      return { kind: 'activated' };
    case 'requires_action':
    case 'requires_confirmation':
    case 'processing':
      // Still live on the same intent — the card form completes THIS one.
      return { kind: 'sca' };
    case 'requires_payment_method':
      return { kind: 'declined', message: GENERIC_DECLINE };
    default:
      // An unrecognised status is not evidence the card refused, and it is not
      // a reason to silently show a card form either.
      return { kind: 'infrastructure', detail: `unexpected payment status ${status ?? 'unknown'}` };
  }
}
