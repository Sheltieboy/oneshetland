/**
 * entitlement.ts — what this business's plan allows today, on the owner side.
 *
 * One reader for the one deployed predicate. business_meets_tier is the same
 * function the triggers and read policies use, so the owner's screen and the
 * server cannot disagree about whether something may go live.
 *
 * The stored subscription_tier is NOT entitlement. A row saying 'premium' with
 * an expiry last March is entitled to nothing, and a plain string comparison
 * cannot tell the difference — which is how mobile ended up refusing Bookings
 * to the Pro customers who were paying for it.
 */

import { supabase } from '@/lib/supabase';

export type Effective = { pro: boolean; premium: boolean };

/** Nothing is entitled until the server says so. */
export const NO_ENTITLEMENT: Effective = { pro: false, premium: false };

/**
 * Fails closed: an unreadable answer counts as not entitled, so a paid action
 * is never offered on a guess. It must never be used to hide setup, history,
 * billing or a withdrawal — being unsure about a plan is no reason to lock
 * somebody out of their own drafts, their own records, or the plans page.
 */
export async function fetchEffectiveTier(businessId: string): Promise<Effective> {
  const [pro, premium] = await Promise.all([
    supabase.rpc('business_meets_tier', { p_business_id: businessId, p_required_tier: 'pro' }),
    supabase.rpc('business_meets_tier', { p_business_id: businessId, p_required_tier: 'premium' }),
  ]);
  return {
    pro: !pro.error && pro.data === true,
    premium: !premium.error && premium.data === true,
  };
}
