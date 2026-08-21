/**
 * What a caller is allowed to be told when an unexpected exception reaches the
 * top of a money-path function.
 *
 * These catch blocks used to return `err.message` straight to the client. On
 * these paths the exception is almost always Stripe's or Postgres's, and
 * several of them deliberately re-throw the provider's own text —
 *
 *     throw new Error(j.error?.message ?? `Stripe transfer failed (HTTP ...)`)
 *
 * — so the message handed to whoever made the request could carry provider
 * internals: account and object ids, constraint and column names, key
 * prefixes, internal decline reasons. None of that helps a caller act, and
 * some of it helps an attacker map the system.
 *
 * The real error is still written to the function log, where an operator can
 * read it. The caller gets one fixed sentence.
 *
 * This is for the catch-all only. Deliberate validation failures — a bad
 * amount, an unaffordable basket, a ticket already redeemed — return their own
 * message and their own status well before here, and are untouched.
 */
export const SAFE_ERROR_MESSAGE = 'Something went wrong. Please try again.';

export function safeError(scope: string, err: unknown): string {
  console.error(`[${scope}]`, err);
  return SAFE_ERROR_MESSAGE;
}
