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
