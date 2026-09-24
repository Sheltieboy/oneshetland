import { supabase } from './supabase';

/**
 * saved-card-state.ts — what the signed-in user's saved card really is.
 *
 * Asks the `saved-card-state` function, which resolves the card from Stripe
 * through the canonical customer/payment-method helper. It is NOT the same as
 * `profile.has_payment_method`: that flag says a card was added once, and was
 * true for accounts with no Stripe Customer at all.
 *
 * Only brand and last4 arrive here. `unknown` means Stripe could not be asked
 * and is not the same as `none`.
 */

export type SavedCardState =
  | { state: 'card'; brand: string | null; last4: string | null }
  | { state: 'none' }
  | { state: 'unknown' };

export async function fetchSavedCardState(): Promise<SavedCardState> {
  try {
    const { data, error } = await supabase.functions.invoke('saved-card-state');
    if (error || !data) return { state: 'unknown' };
    if (data.state === 'card') {
      return {
        state: 'card',
        brand: typeof data.brand === 'string' ? data.brand : null,
        last4: typeof data.last4 === 'string' ? data.last4 : null,
      };
    }
    if (data.state === 'none') return { state: 'none' };
    return { state: 'unknown' };
  } catch {
    return { state: 'unknown' };
  }
}
