/**
 * stripe-account-exposure.mjs — find Stripe CONNECTED ACCOUNT identifier columns (acct_…) that a client role can reach.
 *
 * A connected-account id is not a Stripe secret, but it is the destination of real money (destination charges, transfers, event payouts) and a
 * user's payout identity. It is therefore written only by the server (create-connect-account, the Stripe webhook, service role) and must not be
 * readable by other users or settable by the account holder: a client-written value would redirect money, and a world-readable one discloses
 * who is paid where. A client may keep reading ITS OWN id only where the apps legitimately do (profiles, driver_profiles).
 *
 * Customer ids (cus_…) have their own guard (stripe-customer-exposure.mjs); PaymentIntent / SetupIntent / subscription / transfer ids are not
 * examined here. Engine: stripe-id-exposure-core.mjs.
 */
import { createGuard } from './stripe-id-exposure-core.mjs';

export const NAME_PATTERN = 'stripe.*account|account.*stripe';

/** Reachable-by-design account-id columns. `requires` is verified against the catalogue every run (see the core for the kinds). */
export const ALLOWED = [
  { relation: 'public.profiles', column: 'stripe_account_id', access: 'SELECT', requires: ['rls-own-row'],
    why: 'Only the owner\'s own row (auth.uid() = id) and admins can see it; the apps read their own id to know whether payouts are set up.' },
  { relation: 'public.profiles', column: 'stripe_account_id', access: 'UPDATE', requires: ['trigger:trg_profiles_lock_sensitive:UPDATE'],
    why: 'tg_profiles_lock_sensitive restores the stored value on every user-JWT update of the owner\'s row; only create-connect-account / the webhook write it.' },
  { relation: 'public.profiles', column: 'stripe_account_id', access: 'INSERT', requires: ['no-insert-policy'],
    why: 'Profile rows are created by the auth trigger; there is no client INSERT policy, so RLS refuses a client INSERT.' },
  { relation: 'public.driver_profiles', column: 'stripe_account_id', access: 'SELECT', requires: ['rls-own-row'],
    why: 'Own row (auth.uid() = id) and admins only; build 147 and the web read the driver\'s OWN id (driver dashboard uses select *).' },
  { relation: 'public.driver_profiles', column: 'stripe_account_id', access: 'INSERT', requires: ['trigger:tg_zz_lock_driver_columns:INSERT'],
    why: 'tg_lock_driver_columns nulls the value on a client INSERT; the Fetch charge path trusts this column, so it is server-written only.' },
  { relation: 'public.driver_profiles', column: 'stripe_account_id', access: 'UPDATE', requires: ['trigger:tg_zz_lock_driver_columns:UPDATE'],
    why: 'tg_lock_driver_columns restores the stored value on a client UPDATE; only service role / admins can change it.' },
  { relation: 'public.hubs', column: 'stripe_account_id', access: 'INSERT', requires: ['trigger:tg_zz_lock_hub_columns:INSERT'],
    why: 'tg_lock_hub_columns nulls the value on a client INSERT. Not readable (SELECT is not granted).' },
  { relation: 'public.hubs', column: 'stripe_account_id', access: 'UPDATE', requires: ['trigger:tg_zz_lock_hub_columns:UPDATE'],
    why: 'tg_lock_hub_columns restores the value on a client UPDATE. Not readable (SELECT is not granted).' },
  { relation: 'public.local_businesses', column: 'stripe_account_id', access: 'INSERT', requires: ['trigger:tg_zz_lock_business_columns:INSERT'],
    why: 'tg_lock_business_columns nulls the value on a client INSERT. Not readable (SELECT is not granted).' },
  { relation: 'public.local_businesses', column: 'stripe_account_id', access: 'UPDATE', requires: ['trigger:tg_zz_lock_business_columns:UPDATE'],
    why: 'tg_lock_business_columns restores the value on a client UPDATE. Not readable (SELECT is not granted).' },
  { relation: 'public.local_businesses', column: 'business_stripe_account_id', access: 'INSERT', requires: ['trigger:tg_zz_lock_business_columns:INSERT'],
    why: 'tg_lock_business_columns nulls the value on a client INSERT. Not readable (SELECT is not granted).' },
  { relation: 'public.local_businesses', column: 'business_stripe_account_id', access: 'UPDATE', requires: ['trigger:tg_zz_lock_business_columns:UPDATE'],
    why: 'tg_lock_business_columns restores the value on a client UPDATE. Not readable (SELECT is not granted).' },
];

const guard = createGuard({ namePattern: NAME_PATTERN, allowed: ALLOWED });
export const { ROLES, ACCESS, EXPOSURE_SQL, evaluate } = guard;
export const makeEvaluate = (allowList) => (query) => guard.evaluate(query, allowList);
