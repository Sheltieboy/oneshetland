/**
 * stripe-usage.ts — deciding what a Stripe billing response actually told us.
 *
 * The distinction this exists to make is between "Stripe said no" and "we do
 * not know what Stripe did". Collapsing them is how a billing system either
 * double-charges or quietly loses money:
 *
 *   treat ambiguous as failure  → retry as a new event → charged twice
 *   treat ambiguous as success  → never retried        → never charged
 *
 * So there are three settlements, not two, and the ambiguous one is its own
 * outcome rather than a guess in either direction.
 *
 * Pure on purpose: no fetch, no Deno, no Response. The cases that matter are
 * transport failures and 5xx, which are precisely the ones that cannot be
 * produced against the real Stripe API on demand — so they have to be testable
 * without it.
 */

export type Settlement = 'reported' | 'failed' | 'unresolved';

export interface StripeOutcome {
  settlement: Settlement;
  error?: string;
}

/**
 * `status` is the HTTP status, or null when the request never produced one —
 * a timeout or a transport error, where the request may well have arrived.
 */
export function classifyStripeResponse(status: number | null, errorCode?: string): StripeOutcome {
  // No response at all. Stripe may have received and applied it.
  if (status === null) return { settlement: 'unresolved', error: errorCode ?? 'network' };

  if (status >= 200 && status < 300) return { settlement: 'reported' };

  // Another request with the same idempotency key is still in flight. Stripe
  // has not told us how that one ends, so neither can we.
  if (status === 409) return { settlement: 'unresolved', error: 'idempotency_conflict' };

  // Stripe's own side. Its docs note results are saved "only after the
  // execution of an endpoint begins", so a 5xx may have begun executing.
  if (status === 429 || status >= 500) return { settlement: 'unresolved', error: errorCode ?? `http_${status}` };

  // Any other 4xx is a definite refusal: bad price, missing subscription item,
  // malformed request. Nothing was billed, so the booking can be retried as the
  // same logical event once the cause is fixed.
  return { settlement: 'failed', error: errorCode ?? `http_${status}` };
}

/**
 * The Stripe request for one booking, on whichever billing generation the Price
 * turns out to be.
 *
 * Quantity is always 1 because the unit is one booking. That is what makes the
 * payload incapable of drifting between attempts — the flaw in the previous
 * design, where a retry could carry a different total under an identifier
 * Stripe had already seen, and be silently dropped.
 *
 * `attemptId` is used twice on the meter path: as the event `identifier`, which
 * Stripe enforces as unique for at least 24 hours, and as the Idempotency-Key,
 * which every Stripe POST accepts. On the legacy path only the header exists,
 * which is exactly why that path was unprotected before.
 */
export function buildUsageRequest(args: {
  attemptId: string;
  meterEventName: string | null;
  subscriptionItemId: string | null;
  stripeCustomerId: string | null;
}): { path: string; params: Record<string, string>; idempotencyKey: string } {
  const { attemptId, meterEventName, subscriptionItemId, stripeCustomerId } = args;

  if (meterEventName) {
    if (!stripeCustomerId) throw new Error('meter events need a customer id');
    return {
      path: 'billing/meter_events',
      params: {
        event_name: meterEventName,
        'payload[stripe_customer_id]': stripeCustomerId,
        'payload[value]': '1',
        identifier: attemptId,
      },
      idempotencyKey: attemptId,
    };
  }

  if (!subscriptionItemId) throw new Error('legacy usage records need a subscription item');
  return {
    path: `subscription_items/${subscriptionItemId}/usage_records`,
    params: { quantity: '1', action: 'increment' },
    idempotencyKey: attemptId,
  };
}
