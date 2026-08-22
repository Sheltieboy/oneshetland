/**
 * stripe-sca.ts — saved-card charges the customer is actually present for.
 *
 * WHAT WAS WRONG
 *
 * Every saved-card flow confirmed its PaymentIntent with `off_session: 'true'`
 * while the customer was standing there, having just tapped Buy. One of the
 * original comments said so plainly: "off_session means no 3DS prompt for small
 * amounts."
 *
 * Two problems with that. It misdeclares the transaction to Stripe and the card
 * networks — the cardholder IS present. And it asks for an SCA exemption, which
 * stands down the one control that could independently stop a stolen-session
 * purchase.
 *
 * It also had a practical cost that test mode hides. Off-session confirmation
 * cannot prompt anybody, so when an issuer demands authentication Stripe returns
 * an `authentication_required` ERROR rather than a resumable `requires_action`.
 * Every flow then reported "Payment did not succeed" and stopped. Under PSD2,
 * live UK/EEA cards challenge far more often than test cards do, so a good share
 * of real first payments would simply have failed with no way forward.
 *
 * WHAT THIS DOES
 *
 * `onSessionConfirm()` builds the params for a customer-present confirmation:
 * confirm now, no off_session, and `use_stripe_sdk` so that when authentication
 * is needed Stripe returns a `use_stripe_sdk` next_action the mobile and web
 * SDKs can complete in place — rather than a redirect needing a return_url.
 *
 * `classifyIntent()` maps the PaymentIntent status onto what the caller should
 * actually do. `requires_action` is NOT a failure; it is the middle of a
 * successful payment.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not decide whether SCA is required — Stripe and the issuer do. A
 * OneShetland flow never asks to skip authentication; it only makes sure the
 * customer can complete it.
 *
 * It is for USER-PRESENT charges only. Genuinely automatic ones — subscription
 * renewals, metered booking billing, anything a cron or webhook drives — must
 * keep `off_session: true`, because there is nobody there to challenge.
 */

/**
 * Confirmation params for a charge the customer is present for.
 *
 * Note what is absent: off_session. That absence is the fix.
 */
export function onSessionConfirm(customerId: string, paymentMethodId: string): Record<string, string> {
  return {
    customer:       customerId,
    payment_method: paymentMethodId,
    confirm:        'true',
    // Ask Stripe for an SDK-completable challenge instead of a redirect, so the
    // same PaymentIntent can be finished inside the app or the page.
    use_stripe_sdk: 'true',
  };
}

export type IntentOutcome =
  | { kind: 'succeeded'; id: string }
  | { kind: 'requires_action'; id: string; clientSecret: string }
  | { kind: 'processing'; id: string }
  | { kind: 'failed'; id: string; status: string };

interface IntentLike {
  id?: string;
  status?: string;
  client_secret?: string;
}

/**
 * What the caller should do about this PaymentIntent.
 *
 * The states that matter, and why each is treated as it is:
 *   succeeded              — money taken; fulfil (through the usual path).
 *   requires_action        — the issuer wants the cardholder to authenticate.
 *                            Hand the client secret back so the SDK can finish
 *                            THIS intent. Do not fulfil, do not create another.
 *   processing             — Stripe has it and has not settled yet. Do not
 *                            fulfil; the webhook will when it resolves.
 *   requires_payment_method— the card was declined. A new payment method is
 *                            needed; this intent is spent.
 *   requires_confirmation  — should not occur when we confirm server-side;
 *                            treated as unfinished rather than as success.
 *   canceled               — over.
 */
export function classifyIntent(pi: IntentLike): IntentOutcome {
  const id = pi?.id ?? '';
  const status = pi?.status ?? 'unknown';

  if (status === 'succeeded') return { kind: 'succeeded', id };
  if (status === 'processing') return { kind: 'processing', id };

  if (status === 'requires_action' || status === 'requires_source_action') {
    const clientSecret = pi?.client_secret ?? '';
    // Without a client secret the customer cannot be asked anything, so this
    // is a dead end rather than a resumable challenge. Say so honestly.
    if (!clientSecret) return { kind: 'failed', id, status };
    return { kind: 'requires_action', id, clientSecret };
  }

  return { kind: 'failed', id, status };
}

/** What a caller is told when the payment could not be completed. */
export function failureMessage(status: string): string {
  switch (status) {
    case 'requires_payment_method':
    case 'requires_source':
      return 'That card was declined. Please try a different card.';
    case 'canceled':
      return 'The payment was cancelled.';
    default:
      return 'The payment could not be completed. Please try again.';
  }
}
