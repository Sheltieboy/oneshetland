import { supabase } from '@/lib/supabase';
import type { AlertOptions } from '@/components/BrandedAlert';
import { colors } from '@/constants/theme';

/**
 * payout-readiness.ts — the one paid-activation gate, everywhere a
 * capability is about to go live and take a customer's money.
 *
 * Same shape as lib/commercial-terms.ts: a pure server check, plus a
 * standard prompt shown when it fails. Configuring, drafting and pricing a
 * capability never call this — only the moment it would become customer-
 * purchasable does. Free-only capabilities never call this either: a
 * feature is only ever gated when it can actually take money.
 *
 * The check itself is business_payout_ready(p_business) — the same RPC
 * every server payment path (event tickets, products, passes, gifts,
 * Wallet) and the merchant-facing status displays already ask. Nothing here
 * reconstructs stripe_account_id / payout_enabled / use_business_payout
 * locally; a client guard that did would be exactly how the dashboard's own
 * payout status drifted from the real rule.
 *
 * This is UX only. The server-side functions this gate protects already
 * refuse to move money with no valid payout route regardless of whether a
 * client ever calls this — see Phase 1 of this work. A bypassed or stale
 * client guard cannot make an unpayable business payable.
 */

/** Can OneShetland currently route money to this business? Fails closed: an
 *  unreadable answer is "not ready", never a guess that it is. */
export async function requirePayoutReadyForPaidActivation(businessId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('business_payout_ready', { p_business: businessId });
  return !error && data === true;
}

/**
 * The one prompt shown at every paid-activation point, so the wording
 * cannot drift screen to screen. Only "how do I actually reach Connect
 * Stripe from here" differs by caller — supplied as onConnectStripe rather
 * than duplicated, since each screen's route back to the existing Connect
 * Stripe action differs (the dashboard already has it inline; everywhere
 * else deep-links to the dashboard's own Money tab).
 */
export function payoutNotReadyPrompt(onConnectStripe: () => void): AlertOptions {
  return {
    title: 'Connect Stripe to take payments',
    message: 'You can finish setting this up now, but connect Stripe before making it available to customers.',
    icon: 'university',
    accent: colors.jobs,
    actions: [
      { label: 'Keep as draft', style: 'cancel' },
      { label: 'Connect Stripe', style: 'primary', onPress: onConnectStripe },
    ],
  };
}
