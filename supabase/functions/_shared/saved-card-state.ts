/**
 * saved-card-state.ts — does this user actually have a usable saved card?
 *
 * ONE answer, from Stripe, for every checkout that wants to know.
 *
 * WHY THE FLAG CANNOT BE THE ANSWER
 *
 * profiles.has_payment_method is a preference-shaped hint that says a card was
 * added at some point. It is not evidence that one can be charged now. The
 * production audit that led here found 4 of the 6 profiles carrying the flag
 * with NO Stripe Customer bound at all — so the paid-event checkout, which only
 * tries a saved card when a Customer exists, skipped it and silently opened a
 * bare card form for a buyer who believed their card was saved.
 *
 * WHAT THIS DOES
 *
 *   1. Finds the user's BOUND Customer — profiles.stripe_customer_id, and if
 *      that is empty, the durable claim registry's settled row. Read-only: it
 *      never claims, never creates a Customer, never writes, and never searches
 *      Stripe by email. A Customer that only Stripe knows about is recovered by
 *      the canonical add-card flow (canonicalStripeCustomer), not guessed at here.
 *   2. Asks Stripe which cards are attached, applies the one selection rule
 *      (pickDefaultCard), and returns the chosen card's id for the server plus
 *      its brand and last4 for display.
 *
 * Three honest answers, never a guess:
 *   card     — a card that can be charged, with safe display metadata
 *   none     — proven: no Customer, or a Customer with no card attached
 *   unknown  — Stripe could not be asked. NOT the same as none.
 *
 * The payment-method id and Customer id are for the server only. Callers that
 * answer a browser must return brand and last4 and nothing else.
 */

import { listAttachedCardsDetailed, customerDefaultCard, pickDefaultCard } from './saved-card.ts';

export type SavedCardResolution =
  | { kind: 'card'; customerId: string; paymentMethodId: string; brand: string | null; last4: string | null }
  | { kind: 'none'; reason: 'no_customer' | 'no_card'; customerId: string | null }
  | { kind: 'unknown'; customerId: string | null };

/**
 * The Customer bound to this user, or null. Database reads only.
 */
// deno-lint-ignore no-explicit-any
export async function boundCustomerFor(supabase: any, userId: string): Promise<string | null> {
  const { data: prof } = await supabase
    .from('profiles').select('stripe_customer_id').eq('id', userId).maybeSingle();
  if (typeof prof?.stripe_customer_id === 'string' && prof.stripe_customer_id) return prof.stripe_customer_id;

  // The registry holds the id from the moment Stripe returned it. A settled row
  // is the same Customer even if the profile write never landed.
  const { data: claim } = await supabase
    .from('stripe_customer_claims').select('stripe_customer_id, status').eq('user_id', userId).maybeSingle();
  if (claim?.status === 'bound' && typeof claim.stripe_customer_id === 'string' && claim.stripe_customer_id) {
    return claim.stripe_customer_id;
  }
  return null;
}

export async function resolveSavedCard(opts: {
  // deno-lint-ignore no-explicit-any
  supabase: any;
  stripeKey: string;
  userId: string;
}): Promise<SavedCardResolution> {
  const customerId = await boundCustomerFor(opts.supabase, opts.userId);
  if (!customerId) return { kind: 'none', reason: 'no_customer', customerId: null };

  const attached = await listAttachedCardsDetailed(opts.stripeKey, customerId);
  if (attached === null) return { kind: 'unknown', customerId };
  if (attached.length === 0) return { kind: 'none', reason: 'no_card', customerId };

  const stored = await customerDefaultCard(opts.stripeKey, customerId);
  const chosen = pickDefaultCard(attached, stored);
  if (!chosen) return { kind: 'none', reason: 'no_card', customerId };

  return {
    kind: 'card',
    customerId,
    paymentMethodId: chosen.id,
    brand: chosen.brand ?? null,
    last4: chosen.last4 ?? null,
  };
}
