-- Shift profile trust and payment fields are server/admin controlled.
--
-- shift_worker_profiles: anon and authenticated held table-level SELECT / INSERT / UPDATE, the policy "worker profile visible to all"
-- (USING true) lets every row through, and nothing restricted the sensitive columns. So anyone could READ every worker's Stripe connected-account
-- id, and a worker could WRITE their own stripe_account_id, the two Stripe flags and their ratings. The policy "worker manages own profile"
-- also allowed `auth.uid() = id OR auth.uid() = user_id`, so a worker could re-point id (or user_id) at another user. The table is unused by the
-- apps (they use worker_profiles) and empty in production, so nothing leaked — but it must be safe before anything uses it.
--
-- shift_employer_profiles: is_verified, rating_avg and rating_count were client-writable, so an employer could mark themselves "Verified" (the
-- badge on shift cards) or give themselves a rating. Build 147 and the web both send `is_verified: false` on every profile save, so the column
-- cannot simply be revoked; a guard trigger makes the values server-controlled instead (and, as a side effect, a verified employer who edits
-- their profile keeps the badge).
--
-- Mechanism, matching the rest of the project:
--   · column-level privileges for the worker table (same pattern as 20261122000000): table-level SELECT / INSERT / UPDATE are withdrawn from
--     anon + authenticated and every column EXCEPT the protected five is granted back;
--   · BEFORE INSERT/UPDATE guard triggers that let tg_is_trusted_writer() writers (service role, definer functions, migrations, platform admins)
--     through and reset / preserve the protected values for everyone else;
--   · the worker policy now requires BOTH id and user_id to be the caller, and the guard keeps them from moving on UPDATE.
-- driver_profiles, profiles, local_businesses, payout routing and every Edge Function are untouched.

begin;

-- ── shift_worker_profiles: privileges ────────────────────────────────────────────────────────────────────────────────────
revoke select, insert, update on table public.shift_worker_profiles from anon, authenticated;

grant select (id, user_id, tagline, skills, is_open_to_work, open_to_categories, min_hourly_pay, bio, experience_summary,
              hourly_rate_min, hourly_rate_max, qualifications, created_at, updated_at)
  on public.shift_worker_profiles to anon, authenticated;
grant insert (id, user_id, tagline, skills, is_open_to_work, open_to_categories, min_hourly_pay, bio, experience_summary,
              hourly_rate_min, hourly_rate_max, qualifications, created_at, updated_at)
  on public.shift_worker_profiles to anon, authenticated;
grant update (id, user_id, tagline, skills, is_open_to_work, open_to_categories, min_hourly_pay, bio, experience_summary,
              hourly_rate_min, hourly_rate_max, qualifications, created_at, updated_at)
  on public.shift_worker_profiles to anon, authenticated;

comment on column public.shift_worker_profiles.stripe_account_id is
  'Server-side Stripe connected-account id. No client privilege (anon / authenticated): revoked 20261123000000, guarded by tg_zz_lock_shift_worker_columns.';

-- ── shift_worker_profiles: identity ──────────────────────────────────────────────────────────────────────────────────────
-- id and user_id are aliases of one identity (shift_worker_profiles_sync_ids fills whichever is missing). An ordinary caller may only create or
-- touch a row whose id AND user_id are their own.
drop policy if exists "worker manages own profile" on public.shift_worker_profiles;
create policy "worker manages own profile" on public.shift_worker_profiles
  using (auth.uid() = id and auth.uid() = user_id)
  with check (auth.uid() = id and auth.uid() = user_id);

-- ── guard triggers ────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.tg_lock_shift_worker_columns()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  -- service role, SECURITY DEFINER functions, migrations, direct sessions and platform admins pass untouched
  if public.tg_is_trusted_writer() then return new; end if;

  if tg_op = 'INSERT' then
    -- the schema defaults, whatever the client sent
    new.stripe_account_id          := null;
    new.stripe_onboarding_complete := false;
    new.stripe_payouts_enabled     := false;
    new.rating_avg                 := 0;
    new.rating_count               := 0;
    return new;
  end if;

  -- UPDATE: nothing a client sends can move these
  new.id                         := old.id;
  new.user_id                    := old.user_id;
  new.stripe_account_id          := old.stripe_account_id;
  new.stripe_onboarding_complete := old.stripe_onboarding_complete;
  new.stripe_payouts_enabled     := old.stripe_payouts_enabled;
  new.rating_avg                 := old.rating_avg;
  new.rating_count               := old.rating_count;
  return new;
end;
$function$;

drop trigger if exists tg_zz_lock_shift_worker_columns on public.shift_worker_profiles;
create trigger tg_zz_lock_shift_worker_columns
  before insert or update on public.shift_worker_profiles
  for each row execute function public.tg_lock_shift_worker_columns();

create or replace function public.tg_lock_shift_employer_trust()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if public.tg_is_trusted_writer() then return new; end if;

  if tg_op = 'INSERT' then
    -- the schema defaults, whatever the client sent
    new.is_verified  := false;
    new.rating_avg   := 0;
    new.rating_count := 0;
    return new;
  end if;

  -- UPDATE: the apps send is_verified = false on every save; keeping the stored value means a verified employer stays verified
  new.is_verified  := old.is_verified;
  new.rating_avg   := old.rating_avg;
  new.rating_count := old.rating_count;
  return new;
end;
$function$;

drop trigger if exists tg_zz_lock_shift_employer_trust on public.shift_employer_profiles;
create trigger tg_zz_lock_shift_employer_trust
  before insert or update on public.shift_employer_profiles
  for each row execute function public.tg_lock_shift_employer_trust();

-- ── prove the end state inside the same transaction ──────────────────────────────────────────────────────────────────────
do $$
declare
  r text; a text; c text;
  protected text[] := array['stripe_account_id', 'stripe_onboarding_complete', 'stripe_payouts_enabled', 'rating_avg', 'rating_count'];
  safe text[] := array['id', 'user_id', 'tagline', 'skills', 'is_open_to_work', 'open_to_categories', 'min_hourly_pay', 'bio', 'experience_summary',
                       'hourly_rate_min', 'hourly_rate_max', 'qualifications', 'created_at', 'updated_at'];
begin
  foreach r in array array['anon', 'authenticated'] loop
    foreach a in array array['SELECT', 'INSERT', 'UPDATE'] loop
      foreach c in array protected loop
        if has_column_privilege(r, 'public.shift_worker_profiles', c, a) then
          raise exception 'shift_worker_profiles.% still has % for %', c, a, r;
        end if;
      end loop;
      foreach c in array safe loop
        if not has_column_privilege(r, 'public.shift_worker_profiles', c, a) then
          raise exception 'shift_worker_profiles.% lost % for %', c, a, r;
        end if;
      end loop;
    end loop;
  end loop;
  foreach a in array array['SELECT', 'INSERT', 'UPDATE'] loop
    foreach c in array protected loop
      if not has_column_privilege('service_role', 'public.shift_worker_profiles', c, a) then
        raise exception 'service_role lost % on shift_worker_profiles.%', a, c;
      end if;
    end loop;
  end loop;
  if (select count(*) from pg_trigger where tgname in ('tg_zz_lock_shift_worker_columns', 'tg_zz_lock_shift_employer_trust') and not tgisinternal and tgenabled <> 'D') <> 2 then
    raise exception 'guard triggers are not both in place';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'shift_worker_profiles' and policyname = 'worker manages own profile'
        and qual like '%user_id%' and with_check like '%user_id%') <> 1 then
    raise exception 'worker identity policy is not the expected one';
  end if;
end $$;

commit;
