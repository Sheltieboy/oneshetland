/**
 * checkout-attempt.ts — one id per logical ticket checkout.
 *
 * WHY THIS EXISTS
 * Retrying a ticket checkout used to create a second order and a second
 * capacity reservation: nothing tied two requests together as the same attempt.
 * The server keys on (buyer_id, client_request_id), so a retry resolves to the
 * order the first call created and reserves nothing.
 *
 * WHERE IT MUST BE CALLED FROM
 * The checkout SCREEN, once, when the buyer starts a purchase — and NOT from
 * inside the API function. Minting a fresh id per HTTP attempt would give every
 * retry a new key and silently remove the whole protection, which is exactly
 * the failure this is meant to prevent. The mirror of this file lives in
 * oneshetland-web/lib/checkout-attempt.ts.
 *
 * THE RANDOM SOURCE
 * expo-crypto's randomUUID() — a v4 UUID from the platform CSPRNG (SecRandom on
 * iOS, SecureRandom on Android). The first version of this file fell back to
 * Math.random when no crypto provider was installed, with a note arguing that
 * was tolerable because the id is buyer-scoped and grants nothing. The argument
 * held, but a predictable identifier in a payment path is not worth carrying
 * into launch on the strength of an argument, so expo-crypto was added.
 *
 * There is deliberately no weak fallback. If secure randomness cannot
 * initialise, this throws and the buyer sees a checkout that refused to start —
 * which is recoverable. Silently minting a guessable attempt id would not be.
 *
 * Unrelated non-security identifiers elsewhere (lib/analytics.ts's anon id) are
 * left alone; they are documented as non-sensitive and are not in a money path.
 */

import * as Crypto from 'expo-crypto';

/**
 * A new checkout attempt id. Call once per purchase the buyer starts — never
 * once per network request.
 *
 * @throws if the platform cannot provide cryptographically secure randomness.
 */
export function newCheckoutAttemptId(): string {
  // Prefer the runtime's own Web Crypto when a build provides it; fall through
  // to expo-crypto otherwise. Both are CSPRNG-backed — this is not a strength
  // ladder, just two names for the same guarantee.
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID();

  const id = Crypto.randomUUID();
  if (typeof id !== 'string' || id.length < 32) {
    throw new Error('Could not start a secure checkout. Please restart the app and try again.');
  }
  return id;
}
