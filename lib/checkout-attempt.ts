/**
 * checkout-attempt.ts — one id per logical ticket checkout.
 *
 * WHY THIS EXISTS
 * Retrying a ticket checkout used to create a second order and a second
 * capacity reservation: nothing tied two requests together as the same attempt.
 * The server now keys on (buyer_id, client_request_id), so a retry resolves to
 * the order the first call created and reserves nothing.
 *
 * WHERE IT MUST BE CALLED FROM
 * The checkout SCREEN, once, when the buyer starts a purchase — and NOT from
 * inside the API function. Minting a fresh id per HTTP attempt would give every
 * retry a new key and silently remove the whole protection, which is exactly
 * the failure this is meant to prevent. The mirror of this file lives in
 * oneshetland-web/lib/checkout-attempt.ts.
 *
 * A NOTE ON THE RANDOM SOURCE
 * This app has no crypto polyfill: expo-crypto is not installed and nothing
 * provides crypto.getRandomValues (see the same admission in lib/analytics.ts).
 * So the detection chain below usually lands on the Math.random branch on
 * device, and it is worth being clear about why that is acceptable *here* and
 * would not be elsewhere.
 *
 * This id is not a secret and grants nothing. The uniqueness index is
 * (buyer_id, client_request_id) and buyer_id comes from the verified JWT, so
 * guessing somebody else's id reaches nothing of theirs — the only property
 * required is that one buyer's own checkouts do not collide with each other,
 * across a handful of purchases. 122 bits from a weak PRNG is far beyond that.
 *
 * If a stronger source is wanted, installing expo-crypto and using
 * Crypto.randomUUID() is the one-line change; the detection chain will pick it
 * up automatically because it prefers crypto.randomUUID when present.
 */

type MaybeCrypto = {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView>(a: T) => T;
};

const HEX = '0123456789abcdef';

/** Format 16 random bytes as an RFC 4122 v4 UUID. */
function uuidFromBytes(b: Uint8Array): string {
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  let out = '';
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) out += '-';
    out += HEX[b[i] >> 4] + HEX[b[i] & 0x0f];
  }
  return out;
}

/**
 * A new checkout attempt id. Call once per purchase the buyer starts — never
 * once per network request.
 */
export function newCheckoutAttemptId(): string {
  const c: MaybeCrypto | undefined =
    typeof globalThis !== 'undefined' ? (globalThis as { crypto?: MaybeCrypto }).crypto : undefined;

  if (typeof c?.randomUUID === 'function') return c.randomUUID();

  if (typeof c?.getRandomValues === 'function') {
    return uuidFromBytes(c.getRandomValues(new Uint8Array(16)));
  }

  // No crypto on this runtime — see the note above for why this is sound for a
  // buyer-scoped idempotency key, and unsuitable for anything secret.
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = (Math.random() * 256) | 0;
  return uuidFromBytes(b);
}
