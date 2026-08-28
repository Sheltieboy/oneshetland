/**
 * fetch-authorisation.ts — what Stripe actually said about the hold.
 *
 * authorise-payment used to read the HTTP status of the PaymentIntent call
 * and nothing else:
 *
 *     const pi = await piRes.json();
 *     if (!piRes.ok) throw …
 *     await supabase.from('delivery_requests')
 *       .update({ payment_intent_id: pi.id, payment_status: 'authorised' })
 *
 * A 200 means Stripe accepted the request, not that a hold exists. A card
 * needing 3DS comes back 200 with status `requires_action`; a card that failed
 * at confirm comes back 200 with `requires_payment_method`. Both were recorded
 * as authorised, and the customer was pushed "Your card will be charged on
 * delivery" while no money was held at all. The driver then drove.
 *
 * Worse here than elsewhere: the confirm is triggered by the DRIVER accepting,
 * so the customer is not at their phone. `requires_action` is not an edge case
 * on this rail — it is the expected answer for any card whose bank asks.
 *
 * `requires_capture` is the only status that means a hold exists. Everything
 * else, including anything unrecognised, fails closed.
 */

export type AuthorisationOutcome =
  /** A genuine hold. The driver may proceed. */
  | { kind: 'authorised' }
  /** The customer must authenticate with their bank. Same PI, customer present. */
  | { kind: 'requires_action' }
  /** No usable payment method — none saved, or the card refused at confirm. */
  | { kind: 'requires_payment_method'; message: string }
  /** Stripe has not finished. Not a hold, not a failure. */
  | { kind: 'processing' }
  /** Stripe says this intent is dead. */
  | { kind: 'canceled' }
  /**
   * Money already taken. Unexpected for a manual-capture intent and NEVER
   * reinterpreted as a pre-authorisation — capture-payment would try to
   * capture it again.
   */
  | { kind: 'succeeded' }
  /** Anything we do not recognise. Fails closed, deliberately. */
  | { kind: 'unknown'; detail: string };

/** The one place a Stripe PaymentIntent status becomes a Fetch decision. */
export function classifyAuthorisation(status: string | null | undefined): AuthorisationOutcome {
  switch (status) {
    case 'requires_capture':        return { kind: 'authorised' };
    case 'requires_action':
    case 'requires_confirmation':   return { kind: 'requires_action' };
    case 'requires_payment_method': return {
      kind: 'requires_payment_method',
      message: 'That card could not be authorised. Nothing has been charged — please add or choose another card.',
    };
    case 'processing':              return { kind: 'processing' };
    case 'canceled':                return { kind: 'canceled' };
    case 'succeeded':               return { kind: 'succeeded' };
    default:                        return { kind: 'unknown', detail: String(status ?? 'missing') };
  }
}

/**
 * The payment_status a Fetch request should carry for that outcome.
 *
 * Only 'authorised' means funded. The rest are distinct so the customer's
 * screen can ask for the right thing and the driver's screen can refuse to
 * release them — which is why 'unpaid' is not made to do all this work.
 */
export function paymentStatusFor(outcome: AuthorisationOutcome): string {
  switch (outcome.kind) {
    case 'authorised':              return 'authorised';
    case 'requires_action':         return 'requires_action';
    case 'requires_payment_method': return 'requires_payment_method';
    case 'processing':              return 'processing';
    case 'canceled':                return 'failed';
    case 'succeeded':               return 'captured';
    case 'unknown':                 return 'processing';
  }
}

/** Is this delivery genuinely funded? The only question the driver's UI may ask. */
export const isFunded = (paymentStatus: string | null | undefined) => paymentStatus === 'authorised';
