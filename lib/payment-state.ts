/**
 * payment-state.ts — the one answer to "has this person got a card, and can
 * they be paid?"
 *
 * The same derivation the website uses (oneshetland-web/lib/payment-state.ts),
 * for the same reason it exists there: the account summary and the Payments
 * page had drifted apart and told the same user two different things. Mobile
 * gets one helper rather than repeating the rule per screen.
 *
 * WHY BOTH TABLES
 *
 * A Connect account can sit on profiles OR on driver_profiles, because the
 * Fetch driver onboarding historically wrote it there. Reading only profiles
 * tells a driver who connected in the app that they are not connected.
 * create-connect-account resolves the same pair in the same order, so the
 * button and the status always agree about which account is in play.
 *
 * WHAT THIS RETURNS
 *
 * Booleans only. No cus_…, acct_… or pm_… reaches a screen — the account UI
 * has no use for an identifier and Step 8 keeps them off the client.
 */

import { supabase } from '@/lib/supabase';

export type PaymentState = {
  /** A card is saved with Stripe and can be charged. */
  card_on_file: boolean;
  /** Stripe will pay this person out. */
  payouts_connected: boolean;
  /** An account exists but Stripe has not finished verifying it. */
  payouts_pending: boolean;
};

export const NO_PAYMENT_STATE: PaymentState = {
  card_on_file: false,
  payouts_connected: false,
  payouts_pending: false,
};

/** Resolves a user's effective card and payout state. */
export async function fetchPaymentState(userId: string): Promise<PaymentState> {
  const [{ data: prof }, { data: drv }] = await Promise.all([
    supabase.from('profiles')
      .select('has_payment_method, stripe_account_id, stripe_onboarding_complete, stripe_payouts_enabled')
      .eq('id', userId).maybeSingle(),
    supabase.from('driver_profiles')
      .select('stripe_account_id, stripe_onboarding_complete, stripe_payouts_enabled')
      .eq('id', userId).maybeSingle(),
  ]);

  const hasAccount = !!(prof?.stripe_account_id || drv?.stripe_account_id);
  const onboarded  = !!(prof?.stripe_onboarding_complete || drv?.stripe_onboarding_complete);
  const connected  = !!(prof?.stripe_payouts_enabled || drv?.stripe_payouts_enabled);

  return {
    card_on_file:      !!prof?.has_payment_method,
    payouts_connected: connected,
    payouts_pending:   hasAccount && !onboarded,
  };
}

/**
 * Starts or resumes central payout onboarding.
 *
 * create-connect-account resolves an EXISTING account (profiles, then
 * driver_profiles) before it creates anything, so tapping twice cannot make a
 * second Connect account, and this never touches a business's own account —
 * that is a separate destination chosen per business by use_business_payout.
 *
 * Returns a Stripe onboarding URL, or null when payouts are already live.
 */
export async function startPayoutOnboarding(): Promise<{ url: string | null; alreadyComplete: boolean }> {
  const { data, error } = await supabase.functions.invoke('create-connect-account');
  if (error) {
    let msg = error.message ?? 'Could not open Stripe.';
    try {
      const body = await (error as { context?: { json?: () => Promise<{ error?: string }> } }).context?.json?.();
      if (body?.error) msg = body.error;
    } catch { /* keep the generic message */ }
    throw new Error(msg);
  }
  const res = data as { url?: string; already_complete?: boolean } | null;
  if (res?.already_complete) return { url: null, alreadyComplete: true };
  if (!res?.url) throw new Error('Stripe did not return an onboarding link.');
  return { url: res.url, alreadyComplete: false };
}
