/*
 * Copied from oneshetland-web. The two repos deploy separately, so this is a
 * deliberate duplicate rather than a shared package — and supabase/tests pins
 * the two copies byte-for-byte, the same way lib/listing-tiers.ts already is.
 * Re-deriving these rules on mobile instead of copying them is exactly how
 * Bookings came to be advertised as Premium.
 *
 * Edit the web copy first, then mirror it here, or the pin fails.
 */
/**
 * business-next-action.ts — the one thing worth doing next.
 *
 * Deterministic, ordered, first match wins, one result. No score, no model, no
 * upgrade advertising. An owner should never be sold a plan by a surface whose
 * job is to tell them what to do.
 *
 * The most important rule is the first one: if real work is waiting — an order,
 * a booking, a job lead, an application — there is no "next". Suggesting they
 * write a description while four customers wait would be insulting, and showing
 * "4 orders waiting" in two places at once teaches people to ignore both.
 * DashboardTop already owns that layer, so this defers to it rather than
 * forming a second, subtly different opinion about what counts as attention.
 */

import { beFound, BE_FOUND_COPY, type BeFoundGap, type BeFoundInput } from './be-found';
import { availabilityIsFresh } from '@/constants/trades';

export type NextAction = {
  /** Stable key, so a later phase can measure which suggestions get taken. */
  key: BeFoundGap;
  title: string;
  body: string;
  href: string;
};

/** Just enough of DashboardData to answer "is somebody waiting on this business?". */
export type AttentionInput = {
  orders: { length: number };
  bookings: { length: number };
  leads: { length: number };
  needs: { jobApplications: number };
  isTrade: boolean;
  tradeAvailability: string | null;
  tradeAvailabilitySetAt: string | null;
};

/**
 * The single definition of "somebody is waiting". Includes lapsed trade
 * availability: that business has silently stopped receiving work, which is the
 * costliest stale setting on the platform and is already surfaced as a warning.
 */
export function hasOperationalAttention(d: AttentionInput): boolean {
  if (d.orders.length > 0 || d.bookings.length > 0 || d.leads.length > 0) return true;
  if (d.needs.jobApplications > 0) return true;
  if (d.isTrade && !!d.tradeAvailability && !availabilityIsFresh(d.tradeAvailabilitySetAt)) return true;
  return false;
}

/**
 * Phase 1 covers Be Found only.
 *
 * Rule 0  something is waiting            -> nothing, the owner has real work
 * Rule 2  a missing essential             -> contact, then map pin
 * Rule 3  a missing improvement           -> description, then image, then hours
 *
 * Rule 1 of the specification — "a live commercial capability has no payout
 * route" — is deliberately absent. Payout readiness has two legitimate paths on
 * local_businesses (payout_enabled, and the use_business_payout /
 * business_stripe_payouts_enabled pair) and only the first is loaded here.
 * Judging readiness on half the evidence would tell a business that has already
 * set payouts up to go and set them up. It is left to the phase that can read
 * both.
 */
export function nextAction(
  attention: AttentionInput,
  business: BeFoundInput,
  base: string,
): NextAction | null {
  if (hasOperationalAttention(attention)) return null;

  const found = beFound(business);
  const gap: BeFoundGap | undefined = found.missingEssential[0] ?? found.missingImprovements[0];
  if (!gap) return null;                       // GOOD — the listing is finished

  return { key: gap, ...BE_FOUND_COPY[gap], href: `${base}/profile` };
}
