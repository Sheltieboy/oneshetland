/**
 * stripe-errors.ts — turning a Stripe refusal into something a buyer can act on.
 *
 * WHAT WAS WRONG
 *
 * When Stripe refused a checkout, createPaymentIntent threw with Stripe's own
 * text, the function's catch-all replaced it with the fixed safe sentence, and
 * the buyer read "Something went wrong. Please try again." for every possible
 * cause — a declined card, an organiser who cannot receive money, an amount
 * Stripe will not process. All identical, none actionable, and nothing in the
 * response to tell support which had happened.
 *
 * Step 14 was right that raw provider text must not reach a caller: it carries
 * account and object ids, constraint names and internal decline reasons. The
 * mistake was treating "do not forward the provider's words" as "say nothing".
 *
 * WHAT THIS DOES
 *
 * Carries the Stripe error CODE — a documented, stable identifier like
 * `card_declined`, never an id, key or account reference — and maps it to a
 * sentence written by us. The caller gets our wording plus a `reason` slug from
 * our own small vocabulary, which the clients map to their own copy. Stripe's
 * message itself is logged, never returned.
 */

/** Thrown by a Stripe call so the handler can tell a refusal from a bug. */
export class StripeCallError extends Error {
  constructor(
    public readonly code: string,
    public readonly declineCode: string | null,
    public readonly httpStatus: number,
    providerMessage: string,
  ) {
    super(providerMessage);
    this.name = 'StripeCallError';
  }
}

/** Builds a StripeCallError from a non-2xx Stripe response body. */
export function stripeError(status: number, body: unknown): StripeCallError {
  const e = (body as { error?: { code?: string; decline_code?: string; type?: string; message?: string } })?.error ?? {};
  return new StripeCallError(
    e.code ?? e.type ?? `http_${status}`,
    e.decline_code ?? null,
    status,
    e.message ?? `Stripe returned ${status}`,
  );
}

/** Our own vocabulary — deliberately small, and nothing to do with Stripe's. */
export type CheckoutReason =
  | 'card_declined' | 'card_expired' | 'insufficient_funds'
  | 'authentication_required' | 'organiser_payout' | 'amount_invalid'
  | 'payment_failed';

const MESSAGES: Record<CheckoutReason, string> = {
  card_declined:           'Your card was declined. Please try a different card.',
  card_expired:            'That card has expired. Please add a different card.',
  insufficient_funds:      'Your card was declined — insufficient funds.',
  authentication_required: 'Your bank needs to confirm this payment. Please try again.',
  organiser_payout:        'This organiser isn’t able to receive payments yet, so tickets can’t be sold right now.',
  amount_invalid:          'That amount can’t be processed. Please try a different quantity.',
  payment_failed:          'The payment couldn’t be completed. Please try again.',
};

function classify(code: string, declineCode: string | null): CheckoutReason {
  if (declineCode === 'insufficient_funds') return 'insufficient_funds';
  if (declineCode === 'expired_card' || code === 'expired_card') return 'card_expired';
  switch (code) {
    case 'card_declined':                       return 'card_declined';
    case 'authentication_required':             return 'authentication_required';
    case 'amount_too_small':
    case 'amount_too_large':
    case 'parameter_invalid_integer':           return 'amount_invalid';
    // The platform cannot route money to this organiser's connected account.
    case 'account_invalid':
    case 'transfers_not_allowed':
    case 'insufficient_capabilities_for_transfer':
    case 'capability_not_requested':
    case 'account_capabilities_insufficient':   return 'organiser_payout';
    default:                                    return 'payment_failed';
  }
}

/**
 * The safe response for a Stripe refusal, or null when this was not one — in
 * which case the caller's generic catch-all is the right answer, because an
 * unexpected exception is a bug and its text is not for a buyer.
 */
export function checkoutFailure(
  scope: string,
  err: unknown,
): { status: number; body: { error: string; reason: CheckoutReason; code: string } } | null {
  if (!(err instanceof StripeCallError)) return null;
  const reason = classify(err.code, err.declineCode);
  // Stripe's own words stay here, where an operator can read them.
  console.error(`[${scope}] stripe refused: code=${err.code} decline=${err.declineCode ?? '-'} http=${err.httpStatus} :: ${err.message}`);
  // The CODE goes back too. It is a documented Stripe identifier such as
  // `card_declined` — never an id, key, account reference or provider sentence —
  // and without it every support conversation starts from zero.
  return { status: 402, body: { error: MESSAGES[reason], reason, code: err.code } };
}
