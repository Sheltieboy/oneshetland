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

/**
 * One attempt id per DISTINCT purchase, remembered across taps, retries and a cancelled-then-resumed payment sheet.
 *
 * `idFor(fingerprint)` returns the same id for as long as the fingerprint (everything that makes this THIS purchase: the items,
 * the recipient, the address, how it is paid) is unchanged, and a new id the moment it changes. So tapping Pay twice, retrying
 * after a timeout, or dismissing the card sheet and trying again all reuse the id and resolve to the same order or gift on the
 * server, while changing what is being bought is a different purchase and gets its own.
 *
 * `spend()` forgets the id. Call it when the server has given a DEFINITIVE answer for this attempt — it succeeded, was declined,
 * expired or was refused — because that attempt is over and the next tap is a new purchase. Do NOT call it for a network failure
 * or a 5xx: the attempt may well be alive on the server, and retrying with the same id is exactly how it is resumed.
 *
 * ⚠️ Mirrored in oneshetland-web/lib/checkout-attempt.ts — change both together.
 */
export interface AttemptHolder { idFor(fingerprint: string): string; spend(): void }
export function createAttemptHolder(): AttemptHolder {
  let current: { fingerprint: string; id: string } | null = null;
  return {
    idFor(fingerprint: string) {
      if (!current || current.fingerprint !== fingerprint) current = { fingerprint, id: newCheckoutAttemptId() };
      return current.id;
    },
    spend() { current = null; },
  };
}

/**
 * Did the server end this attempt? True for a 4xx — declined, expired, conflicting, refused — except "in_progress", which means
 * ANOTHER request for the same attempt is mid-payment and this one should simply be tried again with the same id.
 * A network failure or 5xx is not final: the attempt may be alive.
 */
export function isFinalRefusal(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  const code = (e as { code?: unknown } | null)?.code;
  return typeof status === 'number' && status >= 400 && status < 500 && code !== 'in_progress';
}
