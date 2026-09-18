import * as WebBrowser from 'expo-web-browser';
import { supabase } from '@/lib/supabase';
import { fetchBusinessPrivate, createBusinessOnboardingLink } from '@/lib/local-api';
import { startPayoutOnboarding } from '@/lib/payment-state';
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

/**
 * The one prompt shown immediately after a paid/mixed event publish attempt
 * was silently downgraded to a draft — distinct from payoutNotReadyPrompt
 * above, which fires BEFORE anything is saved (a product/pass/Wallet
 * toggle that never took effect). Here the save already succeeded; what
 * failed is specifically going live. Naming that explicitly — "saved",
 * "isn't live yet", "settings have been saved" — is the whole point: a
 * merchant who only sees a generic error after a successful save
 * reasonably assumes something was lost.
 */
export function eventSavedAsDraftPrompt(onConnectStripe: () => void): AlertOptions {
  return {
    title: 'Event saved as draft',
    message: "Your event isn't live yet. Connect Stripe before you can publish paid tickets. Your event and ticket settings have been saved.",
    icon: 'university',
    accent: colors.jobs,
    actions: [
      { label: 'Not now', style: 'cancel' },
      { label: 'Connect Stripe', style: 'primary', onPress: onConnectStripe },
    ],
  };
}

/**
 * The one contextual "Connect Stripe" action, for every paid-activation
 * guard above. Every caller used to hand the prompt's onConnectStripe a
 * router.push to the dashboard's Money tab — one extra screen, and one extra
 * decision, to reach a control OneShetland already knew the exact answer
 * for. This opens the correct onboarding flow directly instead.
 *
 * "Correct" is business_payout_ready's own rule, not a new one: a business
 * uses its own Connect account only once it has been explicitly given one
 * (use_business_payout, from fetchBusinessPrivate — never reconstructed from
 * raw Stripe columns), otherwise it inherits its owner's central account —
 * see _business_payout_resolve. Both onboarding calls are the existing,
 * unchanged mechanisms (createBusinessOnboardingLink / startPayoutOnboarding
 * — see lib/local-api.ts and lib/payment-state.ts), and each already resumes
 * an existing Stripe account rather than creating a second one.
 *
 * No returnContext parameter: WebBrowser.openBrowserAsync is a modal sheet,
 * not a redirect away from the caller's screen, so awaiting it already
 * returns the merchant to exactly the screen they tapped Connect Stripe
 * from — a stronger guarantee than passing one back in would give.
 */
export async function startOrResumePayoutSetup(businessId: string): Promise<{ ready: boolean }> {
  // Fresh canonical check first — never start onboarding a business that is
  // already payable, whether it always was or the caller's own state (e.g. a
  // stale payout_ready read on a list row) is merely out of date.
  if (await requirePayoutReadyForPaidActivation(businessId)) return { ready: true };

  const priv = await fetchBusinessPrivate(businessId);
  const usesOwnAccount = priv.use_business_payout === true;

  let url: string | null;
  if (usesOwnAccount) {
    ({ url } = await createBusinessOnboardingLink(businessId));
  } else {
    const central = await startPayoutOnboarding();
    if (central.alreadyComplete) return { ready: await requirePayoutReadyForPaidActivation(businessId) };
    url = central.url;
  }
  if (!url) throw new Error('No onboarding link was returned.');

  await WebBrowser.openBrowserAsync(url, {
    presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
    dismissButtonStyle: 'close',
  });

  // Onboarding can take a few minutes server-side even once the sheet is
  // dismissed; this is the freshest answer available at the moment the
  // merchant returns, and the caller's own reload still runs on top of it.
  return { ready: await requirePayoutReadyForPaidActivation(businessId) };
}
