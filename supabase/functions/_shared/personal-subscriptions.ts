/**
 * personal-subscriptions.ts — the subscriptions a person's own card pays for.
 *
 * A OneShetland business subscription is usually billed through its OWNER'S
 * PERSONAL Stripe Customer: local-subscription-intent prefers a business card
 * when there is one and otherwise falls back to the owner's, then consolidates
 * local_businesses.stripe_customer_id onto whichever it used. So removing a
 * personal saved card removes the card a subscription renews on, and adding a
 * replacement has to point the subscription at it — Stripe holds
 * `subscription.default_payment_method` separately from the Customer's, and it
 * "takes precedence over default_source ... if neither are set, invoices will
 * use the customer's invoice_settings.default_payment_method".
 *
 * ── Ownership comes from OUR records, not from Stripe ────────────────────
 *
 * The set is resolved from local_businesses — owner, subscription id, and the
 * Customer we recorded as paying — never from "every subscription on this
 * Stripe Customer". A Customer could carry an object this product did not
 * create, and repointing that would be reaching into something we do not own.
 */

const STRIPE = 'https://api.stripe.com/v1';
const headersFor = (key: string) => ({
  Authorization: `Bearer ${key}`,
  'Stripe-Version': '2023-10-16',
});

/** Statuses where a renewal is still ahead, so the payment method matters. */
const LIVE_STATUSES = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'];

export type PersonalSubscription = { businessId: string; subscriptionId: string };

/**
 * Subscriptions this user owns that are billed through THIS Stripe Customer.
 *
 * Both conditions are required. A business with its own Stripe Customer is
 * untouched by the personal card, and must not be repointed at it.
 */
export async function personalSubscriptionsFor(
  // deno-lint-ignore no-explicit-any
  svc: any,
  userId: string,
  customerId: string,
): Promise<PersonalSubscription[]> {
  const { data, error } = await svc
    .from('local_businesses')
    .select('id, stripe_subscription_id')
    .eq('owner_id', userId)
    .eq('stripe_customer_id', customerId)
    .not('stripe_subscription_id', 'is', null);
  if (error) {
    console.error('[personal-subscriptions] lookup failed', error);
    return [];
  }
  return (data ?? [])
    .filter((b: { stripe_subscription_id: string | null }) => !!b.stripe_subscription_id)
    .map((b: { id: string; stripe_subscription_id: string }) => ({
      businessId: b.id, subscriptionId: b.stripe_subscription_id,
    }));
}

export type RepointOutcome = {
  subscriptionId: string;
  /** 'repointed' | 'cleared' | 'skipped' | 'failed' */
  result: 'repointed' | 'cleared' | 'skipped' | 'failed';
  detail?: string;
};

/**
 * Point these subscriptions at `paymentMethodId`, or clear the field with null.
 *
 * Only `default_payment_method` is ever written. Plan, price, status, quantity
 * and billing dates are not touched, and no subscription is created or
 * cancelled here.
 *
 * Each subscription is RETRIEVED first and checked against the Customer we
 * expected, so a stale local row cannot make us write to somebody else's
 * subscription. A subscription that is over is skipped rather than poked.
 */
export async function repointSubscriptions(
  stripeKey: string,
  subs: PersonalSubscription[],
  customerId: string,
  paymentMethodId: string | null,
): Promise<RepointOutcome[]> {
  const out: RepointOutcome[] = [];
  for (const s of subs) {
    try {
      const getRes = await fetch(`${STRIPE}/subscriptions/${s.subscriptionId}`, { headers: headersFor(stripeKey) });
      if (!getRes.ok) { out.push({ subscriptionId: s.subscriptionId, result: 'failed', detail: `retrieve HTTP ${getRes.status}` }); continue; }
      const sub = await getRes.json().catch(() => ({}));

      // Belt for the local row: this must be the Customer we think is paying.
      if (sub?.customer !== customerId) {
        out.push({ subscriptionId: s.subscriptionId, result: 'skipped', detail: 'billed by a different customer' });
        continue;
      }
      if (!LIVE_STATUSES.includes(String(sub?.status))) {
        out.push({ subscriptionId: s.subscriptionId, result: 'skipped', detail: `status ${sub?.status}` });
        continue;
      }
      if ((sub?.default_payment_method ?? null) === paymentMethodId) {
        out.push({ subscriptionId: s.subscriptionId, result: paymentMethodId ? 'repointed' : 'cleared', detail: 'already' });
        continue;
      }

      const upRes = await fetch(`${STRIPE}/subscriptions/${s.subscriptionId}`, {
        method: 'POST',
        headers: { ...headersFor(stripeKey), 'Content-Type': 'application/x-www-form-urlencoded' },
        // The ONLY field written. An empty value is Stripe's convention for
        // unsetting an optional field; whether it clears this one is not
        // documented, so the result is reported rather than assumed — see the
        // note in remove-card about why nothing depends on it.
        body: new URLSearchParams({ default_payment_method: paymentMethodId ?? '' }),
      });
      if (!upRes.ok) {
        const err = await upRes.json().catch(() => ({}));
        out.push({ subscriptionId: s.subscriptionId, result: 'failed', detail: err?.error?.message ?? `HTTP ${upRes.status}` });
        continue;
      }
      out.push({ subscriptionId: s.subscriptionId, result: paymentMethodId ? 'repointed' : 'cleared' });
    } catch (e) {
      out.push({ subscriptionId: s.subscriptionId, result: 'failed', detail: e instanceof Error ? e.message : 'unreachable' });
    }
  }
  return out;
}
