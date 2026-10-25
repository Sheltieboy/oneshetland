/**
 * stripe-customer-exposure.mjs — find Stripe CUSTOMER identifier columns that a client role can reach.
 *
 * A Stripe customer id (cus_…) is a server-side handle: the Edge Functions bind it from the authenticated user or business and hand it to
 * Stripe. No browser or app needs the raw value, and a column that is readable by anon / authenticated leaks it, while one that is writable
 * lets a user choose which customer a later server path will act on. Account (acct_), PaymentIntent, SetupIntent, subscription and transfer
 * ids are NOT customer ids and are examined elsewhere (stripe-account-exposure.mjs) or not at all.
 *
 * Used by: supabase/tests/stripe-customer-exposure.node.test.ts (isolated database), scripts/migration-replay/replay.mjs (the whole schema,
 * built from migrations alone), and — via a read-only adapter — against production after a deploy. Engine: stripe-id-exposure-core.mjs.
 */
import { createGuard } from './stripe-id-exposure-core.mjs';

export const NAME_PATTERN = 'stripe.*customer|customer.*stripe';

/** Reachable-by-design customer-id columns. `requires` is verified against the catalogue every run (see the core for the kinds). */
export const ALLOWED = [
  { relation: 'public.profiles', column: 'stripe_customer_id', access: 'SELECT', requires: ['rls-confined'],
    why: 'The owner\'s own row (policy auth.uid() = id) and admins only; the value is never selected by a client.' },
  { relation: 'public.profiles', column: 'stripe_customer_id', access: 'UPDATE', requires: ['trigger:trg_profiles_lock_sensitive:UPDATE'],
    why: 'tg_profiles_lock_sensitive restores the stored value on every user-JWT update of the owner\'s row.' },
  { relation: 'public.profiles', column: 'stripe_customer_id', access: 'INSERT', requires: ['no-insert-policy'],
    why: 'Profile rows are created by the auth trigger; there is no client INSERT policy, so RLS refuses a client INSERT.' },
  { relation: 'public.local_businesses', column: 'stripe_customer_id', access: 'INSERT', requires: ['trigger:tg_zz_lock_business_columns:INSERT'],
    why: 'tg_lock_business_columns nulls the value on a user INSERT. Not readable (SELECT is not granted).' },
  { relation: 'public.local_businesses', column: 'stripe_customer_id', access: 'UPDATE', requires: ['trigger:tg_zz_lock_business_columns:UPDATE'],
    why: 'tg_lock_business_columns restores the value on a user UPDATE. Not readable (SELECT is not granted).' },
  { relation: 'public.local_businesses', column: 'business_stripe_customer_id', access: 'INSERT', requires: ['trigger:tg_zz_lock_business_columns:INSERT'],
    why: 'tg_lock_business_columns nulls the value on a user INSERT. Not readable (SELECT is not granted).' },
  { relation: 'public.local_businesses', column: 'business_stripe_customer_id', access: 'UPDATE', requires: ['trigger:tg_zz_lock_business_columns:UPDATE'],
    why: 'tg_lock_business_columns restores the value on a user UPDATE. Not readable (SELECT is not granted).' },
];

const guard = createGuard({ namePattern: NAME_PATTERN, allowed: ALLOWED });
export const { ROLES, ACCESS, EXPOSURE_SQL, evaluate } = guard;
