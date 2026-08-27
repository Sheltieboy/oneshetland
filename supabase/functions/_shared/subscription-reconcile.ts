/**
 * subscription-reconcile.ts — what Stripe says the subscription IS.
 *
 * Used to settle an equal-timestamp conflict between two webhook snapshots,
 * where the events themselves cannot say which came last.
 *
 * WHY 404 IS NOT A CANCELLATION
 *
 * This once translated 404 / resource_missing into status 'canceled', on the
 * reasoning that a subscription Stripe no longer knows can only be gone. That
 * reasoning was wrong: Stripe RETAINS canceled Subscription objects and serves
 * them from this endpoint, so a genuine cancellation returns 200 with
 * status='canceled'. A 404 therefore means something else entirely — the wrong
 * account or mode, a Connect-scoped object read without its account context, a
 * key rotated to a different environment, or an id we should not be asking
 * about at all.
 *
 * Every one of those is a reason to stop, not a reason to revoke a paying
 * customer's plan. So there is no translation: anything that is not a clean
 * 200 throws, the handler returns non-2xx, and Stripe retries. An event we
 * could not settle is never acknowledged as settled.
 */

export type ReconciledSubscription = {
  status:            string;
  priceId:           string | null;
  periodEndIso:      string | null;
  cancelAtPeriodEnd: boolean;
  customer:          string | null;
};

/** Thrown for every outcome that is not an authoritative subscription. */
export class ReconcileFailed extends Error {
  // Declared, not parameter properties: Node's strip-only type removal — which
  // is how the suite runs these files — cannot compile those.
  readonly subId: string;
  readonly detail: string;
  constructor(subId: string, detail: string) {
    // Deliberately terse: this reaches logs, never a customer.
    super(`could not reconcile subscription ${subId}: ${detail}`);
    this.name = 'ReconcileFailed';
    this.subId = subId;
    this.detail = detail;
  }
}

/**
 * Turns a Stripe response into authoritative state, or throws.
 *
 * Pure on purpose — the whole point is that every failure path can be tested
 * without a network, because the failure paths are the ones that decide whether
 * somebody keeps the plan they are paying for.
 */
export function parseReconciledSubscription(
  ok: boolean,
  httpStatus: number,
  body: unknown,
  subId: string,
): ReconciledSubscription {
  const b = (body ?? {}) as Record<string, unknown>;

  if (!ok) {
    const err = (b.error ?? {}) as Record<string, unknown>;
    // No special case for 404. A missing object is an unexplained answer, not
    // evidence of cancellation.
    throw new ReconcileFailed(subId, String(err.message ?? err.code ?? httpStatus));
  }

  const status = typeof b.status === 'string' ? b.status : '';
  if (!status) {
    // A 200 that carries no status is not an answer either.
    throw new ReconcileFailed(subId, 'Stripe returned no subscription status');
  }

  const items = ((b.items as { data?: unknown[] } | undefined)?.data ?? []) as Array<{
    price?: { id?: string }; current_period_end?: number;
  }>;
  const endSec =
    items.find((i) => typeof i.current_period_end === 'number')?.current_period_end ??
    (typeof b.current_period_end === 'number' ? b.current_period_end : undefined);

  return {
    status,
    priceId:           items[0]?.price?.id ?? null,
    periodEndIso:      typeof endSec === 'number' ? new Date(endSec * 1000).toISOString() : null,
    cancelAtPeriodEnd: Boolean(b.cancel_at_period_end),
    customer:          typeof b.customer === 'string' ? b.customer : null,
  };
}
