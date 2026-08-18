/**
 * tier-price.ts — the one place that maps (tier, period) to a Stripe Price.
 *
 * Three functions used to carry their own copy of this ternary
 * (local-subscription-intent, local-subscription-change,
 * local-subscription-checkout). Adding the annual Premium price would have meant
 * changing the same logic in three places and hoping — which is exactly the
 * failure mode the tier collapse was undertaken to remove. See
 * oneshetland-web/docs/tier-model.md.
 *
 * Annual is Premium-only: there is no annual Pro. Asking for
 * { tier: 'pro', period: 'annual' } gets monthly Pro rather than an error,
 * because a caller nudging an unsupported combination should get the sensible
 * plan, not a 500.
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getConfig } from './admin-config.ts';

export type Tier = 'pro' | 'premium';
export type BillingPeriod = 'monthly' | 'annual';

export interface ResolvedTierPrice {
  priceId:   string | null;
  configKey: string;
  /** True only when the ANNUAL premium price was actually selected. */
  annual:    boolean;
}

export async function resolveTierPrice(
  svc: SupabaseClient,
  tier: Tier,
  period: BillingPeriod = 'monthly',
): Promise<ResolvedTierPrice> {
  const annual = tier === 'premium' && period === 'annual';

  const configKey = annual
    ? 'stripe.price.local_premium_annual'
    : tier === 'premium'
      ? 'stripe.price.local_premium'
      : 'stripe.price.local_pro';

  const envFallback = annual
    ? Deno.env.get('STRIPE_PRICE_LOCAL_PREMIUM_ANNUAL')
    : tier === 'premium'
      ? Deno.env.get('STRIPE_PRICE_LOCAL_PREMIUM')
      : Deno.env.get('STRIPE_PRICE_LOCAL_PRO');

  const priceId = await getConfig(svc, configKey, envFallback ?? null);
  return { priceId, configKey, annual };
}

/** Consistent, actionable error when a Price hasn't been configured yet. */
export function missingPriceError(tier: Tier, configKey: string, annual: boolean): string {
  return `Stripe price ID for ${tier}${annual ? ' (annual)' : ''} is not configured. ` +
         `Set ${configKey} in Admin → Config.`;
}

/**
 * The metered bookings Price, if configured.
 *
 * Pro carries this as a SECOND subscription item alongside the £12 tier price;
 * Premium must not have it, because bookings are included there. Without the
 * item on the subscription there is nothing for meter-bookings to report usage
 * against — it looks for the item, doesn't find it, and skips in silence. That
 * is how metered bookings shipped inert: the meter, the cap and the counting
 * were all correct, and no subscription ever carried the thing being metered.
 */
export async function resolveBookingMeterPrice(svc: SupabaseClient): Promise<string | null> {
  return await getConfig(svc, 'stripe.price.booking_meter', Deno.env.get('STRIPE_PRICE_BOOKING_METER') ?? null);
}

/** Which prices a subscription on this tier should carry. */
export async function subscriptionPricesFor(
  svc: SupabaseClient,
  tier: Tier,
  period: BillingPeriod = 'monthly',
): Promise<{ tierPrice: string | null; meterPrice: string | null; configKey: string; annual: boolean }> {
  const { priceId, configKey, annual } = await resolveTierPrice(svc, tier, period);
  // Metered bookings are a Pro-only mechanism.
  const meterPrice = tier === 'pro' ? await resolveBookingMeterPrice(svc) : null;
  return { tierPrice: priceId, meterPrice, configKey, annual };
}

/**
 * What each plan is SUPPOSED to cost, in pence.
 *
 * Mirrors TIER_PRICE_PENCE in lib/listing-tiers.ts, which is what the site
 * quotes. Kept here so the two can be compared — see assertPriceMatches.
 */
const EXPECTED_PENCE: Record<string, number> = {
  'pro:monthly':     1200,
  'premium:monthly': 2900,
  'premium:annual':  29000,
};

/**
 * Refuse to subscribe somebody to a Price that isn't the price we quoted.
 *
 * The prices shown on the site are constants in the code; the price actually
 * charged is whatever Stripe Price the config points at. Nothing connected the
 * two, so when the config keys were set to the old Price IDs the site advertised
 * £29 a month and Stripe charged £49.99 — and everything "worked".
 *
 * Test mode made that a nuisance. Live it is quoting one number and taking
 * another, which is the sort of thing that ends in a chargeback and a bad
 * reputation in a place where everyone knows everyone.
 *
 * Returns null when fine, or a message to refuse with. Deliberately fails
 * CLOSED: if we cannot read the Price we do not sell.
 */
export async function assertPriceMatches(
  priceId: string,
  tier: Tier,
  period: BillingPeriod,
  stripeKey: string,
): Promise<string | null> {
  const expected = EXPECTED_PENCE[`${tier}:${period}`];
  if (expected == null) return null; // nothing to check against

  try {
    const res = await fetch(`https://api.stripe.com/v1/prices/${priceId}`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
    });
    const price = await res.json();
    if (!res.ok) {
      return `Could not verify the ${tier} price with Stripe: ${price.error?.message ?? res.status}.`;
    }
    if (price.unit_amount !== expected) {
      const shown = (n: number) => `£${(n / 100).toFixed(2)}`;
      console.error(
        `[tier-price] MISMATCH: ${tier}/${period} is configured as ${priceId} at ` +
        `${price.unit_amount}p, but the site quotes ${expected}p. Refusing to charge.`,
      );
      return `This plan is misconfigured — we quote ${shown(expected)} but the payment would be ` +
             `${shown(price.unit_amount ?? 0)}. Nothing has been charged. Please contact us.`;
    }
    return null;
  } catch (e) {
    console.error('[tier-price] price verification failed:', e);
    return 'Could not verify the plan price just now. Nothing has been charged — please try again.';
  }
}
