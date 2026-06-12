-- 064_security_profiles_lock.sql
-- SECURITY FIX (CRITICAL): privilege-escalation hardening on public.profiles.
--
-- The profiles UPDATE policy is `WITH CHECK (auth.uid() = id)` — a user may
-- update their own row, but there is NO guard on the `role` column. Because
-- every admin check in the system is `profiles.role = 'admin'`, any signed-in
-- user could PATCH their own profile to role='admin' (directly via the REST
-- API with their anon key) and gain full platform admin.
--
-- Fix: a BEFORE UPDATE trigger that, for SELF-SERVICE updates (made with a user
-- JWT against your own row), forces security-sensitive columns back to their
-- previous values. This is NON-BREAKING: ordinary profile edits (name, phone,
-- bio, avatar, locality, games handle…) still succeed; only attempts to change
-- the locked columns are silently ignored. Service-role calls (edge functions,
-- admin tooling) have a NULL auth.uid() and are unaffected, as is the signup
-- trigger that legitimately sets the initial role.

create or replace function public.tg_profiles_lock_sensitive()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only constrain a user editing their OWN row via a user JWT.
  -- auth.uid() is NULL for service-role / server contexts → unaffected.
  if auth.uid() is not null and auth.uid() = old.id then
    new.role               := old.role;               -- ← the critical one
    new.email_verified     := old.email_verified;
    new.is_active          := old.is_active;
    new.has_payment_method := old.has_payment_method;
    new.stripe_customer_id := old.stripe_customer_id;
    new.stripe_account_id  := old.stripe_account_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profiles_lock_sensitive on public.profiles;
create trigger trg_profiles_lock_sensitive
  before update on public.profiles
  for each row execute function public.tg_profiles_lock_sensitive();

comment on function public.tg_profiles_lock_sensitive() is
  'Prevents self-service privilege escalation: locks role and other server-managed columns on user-initiated profile updates. Service role bypasses (auth.uid() is null).';
