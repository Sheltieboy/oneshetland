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
 * Two short, shared, per-business, in-memory guards around actually launching
 * a payout onboarding link — the merchant-facing counterpart to
 * supabase/functions/_shared/rate-limit.ts's own server-side ceiling on
 * local-business-onboard / create-connect-account, found when several
 * onboarding entry points were opened in quick succession and the raw
 * "Too many requests" the server returns reached the merchant unexplained.
 *
 *  · LAUNCH GUARD (5s) — an anti-double-tap guard across screens. Starts
 *    when any launch begins, whether it succeeds or not, and only stops
 *    immediate repeat taps / cross-surface hammering. It is NOT a claim that
 *    the server is limiting anyone.
 *  · RATE-LIMIT BACKOFF — starts only after a genuine 429 from the server.
 *    The server's own window for Connect/onboarding-link creation is an hour
 *    (rate_limit_policies: stripe_account, 6 per 3600s) and its Retry-After is
 *    the seconds left in that window — anything from 1s to an hour, so
 *    retrying after only a few seconds would just earn another 429. The
 *    server-provided Retry-After is used when the invocation layer exposes it
 *    (see lib/retry-after.ts); otherwise a fixed fallback.
 *
 * Both are in memory only, cleared on reload — nothing persisted, no table.
 * Every launcher shares the same two maps, keyed by businessId: the
 * contextual guard below (event/product/pass/Wallet, via
 * startOrResumePayoutSetup) AND the explicit "use my own business bank"
 * Plan & payouts control, which does not route through
 * startOrResumePayoutSetup at all — hopping between them for the same
 * business is one burst, not a fresh allowance each time.
 */
const PAYOUT_ONBOARDING_LAUNCH_GUARD_MS = 5_000;
const PAYOUT_ONBOARDING_BACKOFF_FALLBACK_MS = 60_000;
const PAYOUT_ONBOARDING_BACKOFF_MAX_MS = 3_600_000;
const payoutOnboardingLaunchGuardUntil = new Map<string, number>();
const payoutOnboardingBackoffUntil = new Map<string, number>();

/** True while the short launch guard OR a real-429 backoff is active. */
export function isPayoutOnboardingCoolingDown(businessId: string): boolean {
  const now = Date.now();
  const guard = payoutOnboardingLaunchGuardUntil.get(businessId);
  const backoff = payoutOnboardingBackoffUntil.get(businessId);
  return (guard !== undefined && now < guard) || (backoff !== undefined && now < backoff);
}

/** True only while a backoff started by a real 429 is active. */
export function isPayoutOnboardingBackedOff(businessId: string): boolean {
  const backoff = payoutOnboardingBackoffUntil.get(businessId);
  return backoff !== undefined && Date.now() < backoff;
}

function rateLimitedCooldownError(): Error {
  // Reuses the exact wording enforceRateLimit() returns, so
  // classifyPayoutOnboardingError treats a client-side block and a genuine
  // server 429 identically — one signal, one code path. Never shown: every
  // catch block turns it into the friendly message.
  return Object.assign(new Error('Too many requests'), { status: 429 });
}

function startPayoutOnboardingBackoff(businessId: string, retryAfterSecs: number | undefined): void {
  const ms = retryAfterSecs !== undefined && retryAfterSecs > 0
    ? retryAfterSecs * 1000
    : PAYOUT_ONBOARDING_BACKOFF_FALLBACK_MS;
  payoutOnboardingBackoffUntil.set(businessId, Date.now() + Math.min(ms, PAYOUT_ONBOARDING_BACKOFF_MAX_MS));
}

/**
 * Wraps one payout-onboarding launch call (creating/resuming an onboarding
 * link): refuses without ever reaching the network while either guard is
 * active, otherwise starts the short launch guard and makes the one real
 * call. If that call comes back genuinely rate-limited, the longer backoff
 * starts — a synthetic refusal from this function never does, so the
 * backoff cannot extend itself.
 */
export async function guardPayoutOnboardingLaunch<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  if (isPayoutOnboardingCoolingDown(businessId)) throw rateLimitedCooldownError();
  payoutOnboardingLaunchGuardUntil.set(businessId, Date.now() + PAYOUT_ONBOARDING_LAUNCH_GUARD_MS);
  try {
    return await fn();
  } catch (e) {
    if (classifyPayoutOnboardingError(e) === 'rate_limited') {
      startPayoutOnboardingBackoff(businessId, (e as { retryAfterSecs?: number } | null | undefined)?.retryAfterSecs);
    }
    throw e;
  }
}

export type PayoutOnboardingErrorKind = 'rate_limited' | 'ordinary';

/**
 * Distinguishes a rate-limited onboarding-launch failure — whether from this
 * module's own cooldown above or from enforceRateLimit()'s real 429 — from
 * an ordinary onboarding failure, so every catch block can show the right
 * message without re-deriving this itself.
 */
export function classifyPayoutOnboardingError(err: unknown): PayoutOnboardingErrorKind {
  const status = (err as { status?: number } | null | undefined)?.status;
  if (status === 429) return 'rate_limited';
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (/too many requests/i.test(message)) return 'rate_limited';
  return 'ordinary';
}

/**
 * The one place every payout-onboarding catch block turns a thrown error
 * into what the merchant sees. A rate-limited response never shows its raw
 * "Too many requests" text or any other raw Stripe/edge-function wording —
 * the account's own state (Verification in progress, etc.) is untouched by
 * this, since nothing here writes to the business at all.
 */
export function payoutOnboardingErrorAlert(err: unknown): AlertOptions {
  if (classifyPayoutOnboardingError(err) === 'rate_limited') {
    return {
      title: 'Stripe setup is temporarily busy',
      message: 'Please wait a moment, then try again. Your existing payout setup, if any, has not been changed.',
      icon: 'university',
      accent: colors.jobs,
      actions: [{ label: 'OK', style: 'primary' }],
    };
  }
  return {
    title: 'Stripe onboarding failed',
    message: err instanceof Error ? err.message : 'Try again later',
    icon: 'university',
    accent: colors.error,
    actions: [{ label: 'OK', style: 'primary' }],
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
  // stale payout_ready read on a list row) is merely out of date. Also never
  // enters cooldown for an already-ready business — there is nothing to
  // launch, so nothing to throttle.
  if (await requirePayoutReadyForPaidActivation(businessId)) return { ready: true };

  const priv = await fetchBusinessPrivate(businessId);
  const usesOwnAccount = priv.use_business_payout === true;

  let url: string | null;
  if (usesOwnAccount) {
    ({ url } = await guardPayoutOnboardingLaunch(businessId, () => createBusinessOnboardingLink(businessId)));
  } else {
    const central = await guardPayoutOnboardingLaunch(businessId, () => startPayoutOnboarding());
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

/**
 * launchPayoutSetupFromPrompt — startOrResumePayoutSetup, called from an
 * AlertAction. BrandedAlert always dismisses an alert before firing its
 * onPress (see handleAction), so by the time onConnectStripe runs here,
 * there is no longer a button on screen to show "Opening Stripe…" on — the
 * merchant needs feedback wherever their attention now is instead. This
 * shows a second, loading-only alert (BrandedAlert's opt-in `loading` mode)
 * immediately, before startOrResumePayoutSetup's own first await, and
 * replaces it with either nothing (hide, on success) or a plain error alert
 * (on failure) once it settles.
 *
 * The loading alert is itself modal and non-dismissible, so a second tap at
 * a payoutNotReadyPrompt elsewhere on the same screen cannot reach it while
 * this is in flight — duplicate launches are prevented by the same modal
 * that gives the feedback, not a separate flag.
 */
export async function launchPayoutSetupFromPrompt(
  businessId: string,
  ui: { alert: (o: AlertOptions) => void; hide: () => void },
): Promise<void> {
  ui.alert({
    title: 'Opening Stripe…',
    message: 'Connecting your Stripe account.',
    icon: 'university',
    accent: colors.jobs,
    loading: true,
    dismissible: false,
  });
  try {
    await startOrResumePayoutSetup(businessId);
    ui.hide();
  } catch (e) {
    ui.alert(payoutOnboardingErrorAlert(e));
  }
}
