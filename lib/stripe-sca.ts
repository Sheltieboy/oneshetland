/**
 * stripe-sca.ts — finishing a payment the issuer wants authenticated.
 *
 * The backend confirms saved-card PaymentIntents server-side. When the issuer
 * demands Strong Customer Authentication, Stripe answers `requires_action`
 * rather than `succeeded`, and the payment is paused mid-flight — not failed.
 *
 * This completes THAT SAME PaymentIntent. It never starts a second one, so a
 * challenge cannot turn into two authorisations on the customer's card.
 *
 * Stripe's own name for this shape is "finalizing payments on the server":
 * confirm on the server, hand the client secret to the client, let the SDK run
 * the challenge, and let the webhook fulfil when the intent finally succeeds.
 *
 * Why the module-level handleNextAction and not the useStripe() hook: this is
 * called from the API layer rather than from a screen, so every purchase path
 * gets the behaviour without each screen having to remember to add it.
 */

import { handleNextAction } from '@stripe/stripe-react-native';

/** The shape every saved-card endpoint now returns. */
export interface PaymentStart {
  charged?: boolean;
  status?: 'succeeded' | 'requires_action' | 'processing' | 'failed';
  clientSecret?: string;
  payment_intent_id?: string;
  error?: string;
}

export type Settled =
  | { outcome: 'succeeded' }
  | { outcome: 'pending' }          // Stripe has it; the webhook will fulfil
  | { outcome: 'cancelled' }        // the customer dismissed the challenge
  | { outcome: 'failed'; message: string };

const RETURN_URL = 'oneshetland-fetch://payment-return';

/**
 * Resolves a saved-card start into a final outcome, running the SCA challenge
 * if the issuer asked for one.
 *
 * Only ever called for the saved-card path. The PaymentSheet path already
 * handles authentication itself as part of collecting the card.
 */
export async function settleSavedCardPayment(start: PaymentStart): Promise<Settled> {
  if (start?.charged || start?.status === 'succeeded') return { outcome: 'succeeded' };

  if (start?.status === 'processing') return { outcome: 'pending' };

  if (start?.status === 'requires_action') {
    if (!start.clientSecret) {
      // Nothing to challenge with. Better to say so than to look like a decline.
      return { outcome: 'failed', message: 'Your bank asked to confirm this payment, but the confirmation could not be started. Please try again.' };
    }
    const { error, paymentIntent } = await handleNextAction(start.clientSecret, RETURN_URL);
    if (error) {
      // Canceled is the customer dismissing the bank's challenge — not an error
      // to shout about, and definitely not a completed purchase.
      if (error.code === 'Canceled') return { outcome: 'cancelled' };
      return { outcome: 'failed', message: error.message ?? 'Your bank could not confirm this payment.' };
    }
    if (paymentIntent?.status === 'Succeeded') return { outcome: 'succeeded' };
    if (paymentIntent?.status === 'Processing') return { outcome: 'pending' };
    return { outcome: 'failed', message: 'Your bank did not confirm this payment.' };
  }

  if (start?.status === 'failed') {
    return { outcome: 'failed', message: start.error ?? 'The payment could not be completed.' };
  }

  // No recognised status and not charged: the caller's own clientSecret /
  // PaymentSheet branch handles it, exactly as before this file existed.
  return { outcome: 'pending' };
}
