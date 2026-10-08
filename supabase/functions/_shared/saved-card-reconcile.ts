/**
 * saved-card-reconcile.ts — make profiles.has_payment_method tell the truth.
 *
 * THE INCONSISTENCY
 *
 * A production audit found profiles carrying has_payment_method = true with NO
 * Stripe Customer bound to them (no profiles.stripe_customer_id, no claim
 * registry row): 4 of the 6 flagged profiles. Checkout, which resolves the card
 * canonically (_shared/saved-card-state.ts), correctly said "no saved card" while
 * Account → Payments & banking, which believed the flag, said "card added".
 *
 * WHAT THIS DOES, FOR ONE USER
 *
 *   1. Find the user's BOUND Customer (profile, else the settled claim).
 *   2. If there is none, look for a Customer that PROVABLY belongs to this user:
 *      Stripe's own metadata['supabase_user_id'] — stamped by every Customer this
 *      product has ever created — matching the user's id, exactly one of them,
 *      and not already held by another profile. If found, bind it through the
 *      EXISTING canonical functions (claim_stripe_customer / settle_stripe_customer);
 *      nothing here creates a Customer or invents a claim by hand.
 *   3. Ask Stripe which cards are attached to the bound Customer and set the flag
 *      to match: cards → true, none → false.
 *   4. With no provable Customer, clear the stale flag. Do not create anything.
 *
 * WHAT IT NEVER DOES
 *
 *   - bind by email, or by anything a user can type. Email is not proof of
 *     ownership and is never sent to Stripe here.
 *   - create a Stripe Customer, copy a PaymentMethod, or touch a card.
 *   - change anything when Stripe cannot be asked. An outage is `unknown`, not
 *     "no card", and clearing a flag on an outage would be the same lie in the
 *     other direction.
 *   - return or log a full customer id, a payment-method id, or any card detail.
 *
 * Stripe's customer SEARCH is documented as eventually consistent, so a miss is
 * "no answer", never proof that no Customer exists — which is why a miss only
 * clears a flag that already has nothing behind it. The canonical add-card flow
 * (canonicalStripeCustomer) recovers the same orphan by the same metadata the
 * next time the person adds a card.
 */

import { boundCustomerFor } from './saved-card-state.ts';
import { listAttachedCards } from './saved-card.ts';

const STRIPE = 'https://api.stripe.com/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Recovery =
  | { kind: 'one'; customerId: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; customerIds: string[] }
  | { kind: 'error' };

/**
 * Customers Stripe holds for this user, identified ONLY by the metadata this
 * product stamps on creation. Exactly one match is proof enough to consider
 * binding; zero is "none"; several is "ambiguous" — every one of them provably
 * this user's (the duplicates the claim registry now prevents), but which to bind
 * is decided by reconcileSavedCard from evidence, never by guessing.
 */
export async function findOwnedCustomer(stripeKey: string, userId: string): Promise<Recovery> {
  if (!UUID.test(userId)) return { kind: 'none' };
  try {
    const query = encodeURIComponent(`metadata['supabase_user_id']:'${userId}'`);
    const res = await fetch(`${STRIPE}/customers/search?limit=10&query=${query}`, {
      headers: { Authorization: `Bearer ${stripeKey}`, 'Stripe-Version': '2023-10-16' },
    });
    if (!res.ok) return { kind: 'error' };
    const body = await res.json().catch(() => ({}));
    if (!Array.isArray(body?.data)) return { kind: 'error' };
    // Re-check the proof on what came back rather than trusting the query alone.
    const owned = body.data.filter((c: { id?: unknown; deleted?: unknown; metadata?: { supabase_user_id?: unknown } }) =>
      typeof c?.id === 'string' && c.deleted !== true && c.metadata?.supabase_user_id === userId);
    if (owned.length === 0) return { kind: 'none' };
    if (owned.length > 1) return { kind: 'ambiguous', customerIds: owned.map((c: { id: string }) => c.id) };
    return { kind: 'one', customerId: owned[0].id as string };
  } catch {
    return { kind: 'error' };
  }
}

export type ReconcileAction = 'consistent' | 'flag_set' | 'flag_cleared' | 'recovered' | 'skipped_unknown';

export interface ReconcileOutcome {
  /** First 8 characters of the user id — enough to correlate, never enough to identify. */
  user: string;
  customer: 'bound' | 'recovered' | 'recoverable' | 'none' | 'ambiguous' | 'unknown';
  cards: number | null;
  flag_before: boolean;
  flag_after: boolean;
  action: ReconcileAction;
}

/** Binds a provably-owned Customer through the canonical functions. */
// deno-lint-ignore no-explicit-any
async function bindRecovered(supabase: any, userId: string, customerId: string): Promise<boolean> {
  // Held by somebody else? Then it is not provably this user's, whatever the metadata says.
  const { data: other } = await supabase
    .from('profiles').select('id').eq('stripe_customer_id', customerId).neq('id', userId).limit(1);
  if (Array.isArray(other) && other.length > 0) return false;

  const { data: claimRows, error } = await supabase.rpc('claim_stripe_customer', { p_user: userId });
  if (error) return false;
  const claim = (Array.isArray(claimRows) ? claimRows[0] : claimRows) as
    { outcome?: string; stripe_customer_id?: string | null } | null;

  // An existing binding always wins: bound to this same Customer is success, to any other is not ours to override.
  if (claim?.outcome === 'bound') return claim.stripe_customer_id === customerId;
  // Somebody else is mid-creation. Racing them is how a second Customer is made.
  if (claim?.outcome !== 'claimed') return false;

  const { error: settleErr } = await supabase.rpc('settle_stripe_customer', { p_user: userId, p_customer: customerId });
  if (settleErr) {
    await supabase.rpc('settle_stripe_customer', { p_user: userId, p_error: 'reconcile could not bind a recovered customer' });
    return false;
  }
  return true;
}

export async function reconcileSavedCard(opts: {
  // deno-lint-ignore no-explicit-any
  supabase: any;
  stripeKey: string;
  userId: string;
  dryRun?: boolean;
}): Promise<ReconcileOutcome> {
  const { supabase, stripeKey, userId, dryRun = false } = opts;
  const user = userId.slice(0, 8);

  const { data: prof } = await supabase
    .from('profiles').select('has_payment_method').eq('id', userId).maybeSingle();
  const flagBefore = prof?.has_payment_method === true;

  let customerId = await boundCustomerFor(supabase, userId);
  let customer: ReconcileOutcome['customer'] = customerId ? 'bound' : 'none';

  if (!customerId) {
    const found = await findOwnedCustomer(stripeKey, userId);
    if (found.kind === 'error') {
      return { user, customer: 'unknown', cards: null, flag_before: flagBefore, flag_after: flagBefore, action: 'skipped_unknown' };
    }
    let chosen: string | null = found.kind === 'one' ? found.customerId : null;
    if (found.kind === 'ambiguous') {
      customer = 'ambiguous';
      // All of these are provably this user's. Bind one ONLY if exactly one of them holds
      // a usable card — that is evidence, not a guess. Zero or several with cards stays
      // unbound (and unclaimed) for a person to decide.
      const withCards: string[] = [];
      for (const id of found.customerIds) {
        const attachedHere = await listAttachedCards(stripeKey, id);
        if (attachedHere === null) {
          return { user, customer: 'unknown', cards: null, flag_before: flagBefore, flag_after: flagBefore, action: 'skipped_unknown' };
        }
        if (attachedHere.length > 0) withCards.push(id);
      }
      if (withCards.length === 1) chosen = withCards[0];
    }
    if (chosen) {
      if (dryRun) {
        const cards = await listAttachedCards(stripeKey, chosen);
        return {
          user, customer: 'recoverable', cards: cards?.length ?? null,
          flag_before: flagBefore, flag_after: cards ? cards.length > 0 : flagBefore,
          action: 'recovered',
        };
      }
      if (await bindRecovered(supabase, userId, chosen)) {
        customerId = chosen;
        customer = 'recovered';
      }
    }
  }

  // Nothing provable is bound: the flag has nothing behind it. Clear it; create nothing.
  if (!customerId) {
    if (flagBefore && !dryRun) await supabase.from('profiles').update({ has_payment_method: false }).eq('id', userId);
    return {
      user, customer, cards: null, flag_before: flagBefore, flag_after: false,
      action: flagBefore ? 'flag_cleared' : 'consistent',
    };
  }

  const attached = await listAttachedCards(stripeKey, customerId);
  if (attached === null) {
    return { user, customer, cards: null, flag_before: flagBefore, flag_after: flagBefore, action: 'skipped_unknown' };
  }
  const desired = attached.length > 0;
  if (desired !== flagBefore && !dryRun) {
    await supabase.from('profiles').update({ has_payment_method: desired }).eq('id', userId);
  }
  const action: ReconcileAction =
    customer === 'recovered' ? 'recovered'
    : desired === flagBefore ? 'consistent'
    : desired ? 'flag_set' : 'flag_cleared';
  return { user, customer, cards: attached.length, flag_before: flagBefore, flag_after: desired, action };
}

/**
 * Every profile whose card state could be wrong: anything flagged, and anything
 * with a bound Customer (a card added or removed outside the app leaves those
 * drifting the other way).
 */
// deno-lint-ignore no-explicit-any
export async function reconcileCandidates(supabase: any, limit = 500): Promise<string[]> {
  const { data } = await supabase
    .from('profiles').select('id')
    .or('has_payment_method.eq.true,stripe_customer_id.not.is.null')
    .limit(limit);
  return (Array.isArray(data) ? data : [])
    .map((r: { id?: unknown }) => r.id)
    .filter((id: unknown): id is string => typeof id === 'string');
}
