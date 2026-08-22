/**
 * checkout-errors.ts — what a buyer is told when a checkout fails.
 *
 * Mirrors oneshetland-web/lib/checkout-errors.ts so the same backend failure
 * reads the same on both clients. The backend's own safe messages are already
 * written for a buyer and are shown as-is; this only rephrases the few that are
 * not, and keeps unknown internal failures generic.
 */

const GENERIC = 'Something went wrong. Please try again.';

const REPHRASE: Record<string, string> = {
  // Should be unreachable now the card path sends a reference — but no buyer
  // should ever be shown implementation vocabulary if it resurfaces.
  'Invalid checkout reference':
    'We couldn’t start this checkout. Please close this ticket window and try again.',
};

export function describeCheckoutError(err: unknown): string {
  const msg = err instanceof Error ? err.message : '';
  if (!msg) return GENERIC;
  return REPHRASE[msg] ?? msg;
}
