-- ============================================================================
-- Privilege escalation: any signed-in user could make themselves an admin.
--
-- "Users can update their own profile" is a row-level policy — it permits an
-- update to your own row, every column of it. tg_profiles_lock_sensitive exists
-- precisely to claw back the columns that must not be self-served, and it does
-- lock `role`. But admin is defined in TWO places:
--
--   is_admin()  ->  role = 'admin' OR is_platform_owner = true
--
-- and only the first half was locked. `update profiles set is_platform_owner =
-- true where id = auth.uid()` therefore succeeded, and is_admin() then returned
-- true for that user — unlocking RLS on 8 tables (including "Admins can read all
-- profiles", i.e. every user's personal details) and 11 RPCs, among them the
-- platform-wide revenue analytics.
--
-- Two definitions of the same privilege, one guard covering one of them. The
-- same seam that produced today's other defects.
--
-- The three stripe_* status flags go the same way. stripe_account_id was locked
-- but the flags saying that account is LIVE were not, even though they are only
-- ever written by create-connect-account and the stripe webhook from Stripe's
-- own answer. Both run on the service role, where auth.uid() is null and this
-- trigger does not apply, so nothing legitimate loses a write.
--
-- Same shape as the original: silently restore the old value rather than raise,
-- so an app sending a whole profile row back still succeeds and simply cannot
-- move these fields.
-- ============================================================================

create or replace function public.tg_profiles_lock_sensitive() returns trigger
    language plpgsql security definer
    set search_path to 'public'
    as $$
begin
  -- Only constrain a user editing their OWN row via a user JWT.
  -- auth.uid() is NULL for service-role / server contexts → unaffected.
  if auth.uid() is not null and auth.uid() = old.id then
    new.role                       := old.role;
    new.is_platform_owner          := old.is_platform_owner;   -- the other half of is_admin()
    new.email_verified             := old.email_verified;
    new.is_active                  := old.is_active;
    new.has_payment_method         := old.has_payment_method;
    new.stripe_customer_id         := old.stripe_customer_id;
    new.stripe_account_id          := old.stripe_account_id;
    new.stripe_onboarding_complete := old.stripe_onboarding_complete;
    new.stripe_payouts_enabled     := old.stripe_payouts_enabled;
    new.stripe_charges_enabled     := old.stripe_charges_enabled;
  end if;
  return new;
end;
$$;

comment on function public.tg_profiles_lock_sensitive() is
  'Prevents self-service privilege escalation: locks role, is_platform_owner and the other server-managed columns on user-initiated profile updates. Service role bypasses (auth.uid() is null).';

-- Anyone who already set the flag on themselves loses it. Written as a targeted
-- update rather than a blanket reset so a genuine platform owner set from the
-- dashboard or SQL — where role is also 'admin' — is left alone.
update public.profiles
   set is_platform_owner = false
 where is_platform_owner = true
   and role <> 'admin';
