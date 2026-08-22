-- F2 — paid job and shift promotion becomes server-managed.
--
-- WHAT WAS WRONG
--
-- jobs.is_featured, jobs.boosted_until and shifts.boosted_until carry
-- column-level UPDATE grants to authenticated, and both tables have an
-- owner-scoped UPDATE policy (`employer_id = auth.uid()`). Neither table had a
-- column lock, so an employer could set their own listing's paid promotion
-- state with one PostgREST call. Proven in a rolled-back transaction against
-- production, with a control edit to show the harness worked:
--
--     control: owner edits own title     ALLOWED (1)
--     owner sets is_featured=true        ALLOWED (1)
--     owner sets boosted_until           ALLOWED (1)
--
-- The intended path is create-boost-intent → payment → confirm-boost (or
-- wallet-checkout), where the SERVICE ROLE writes boosted_until only after the
-- Stripe PaymentIntent has been verified and a replay claim taken. The direct
-- write bypassed all of that.
--
-- This is the same defect as C2 (local_businesses.subscription_tier). Step 2
-- fixed local_businesses, hubs, driver_profiles and profiles; jobs and shifts
-- were never given the same treatment. This is that treatment, in the same
-- shape, reusing the same trusted-writer helper.
--
-- WHY THESE FUNCTIONS ARE SECURITY INVOKER
--
-- A SECURITY DEFINER trigger runs as its owner, so current_user becomes
-- 'postgres' and tg_is_trusted_writer() returns true for EVERY caller — the
-- lock would silently protect nothing while looking correct. Step 2 hit exactly
-- that in a dry run. These are invoker functions, and the assertion at the end
-- of this migration refuses to leave them any other way.
--
-- WHAT IS NOT IN SCOPE
--
-- Only paid-promotion state. jobs.views_count, jobs.application_count and
-- shifts.positions_filled are also client-writable and server-derived, and
-- jobs.source/source_ref describe scraped provenance — both are real, both are
-- a different class, and neither is touched here.

begin;

-- ── jobs ───────────────────────────────────────────────────────────────────
create or replace function public.tg_lock_job_columns()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  -- service role, SECURITY DEFINER paths, migrations, psql — and platform
  -- admins working from the admin screens, exactly as the other locks allow.
  if public.tg_is_trusted_writer() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- Promotion always starts from nothing; it is bought, never declared.
    new.is_featured   := false;
    new.boosted_until := null;
    return new;
  end if;

  -- UPDATE: silently preserve, matching the other locks. An employer editing
  -- their listing gets a successful write with the paid fields unchanged,
  -- rather than an error on a field their client never meant to send.
  new.is_featured   := old.is_featured;
  new.boosted_until := old.boosted_until;
  return new;
end;
$$;

drop trigger if exists lock_job_columns on public.jobs;
create trigger lock_job_columns
  before insert or update on public.jobs
  for each row execute function public.tg_lock_job_columns();

-- ── shifts ─────────────────────────────────────────────────────────────────
create or replace function public.tg_lock_shift_columns()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if public.tg_is_trusted_writer() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.boosted_until := null;
    return new;
  end if;

  new.boosted_until := old.boosted_until;
  return new;
end;
$$;

drop trigger if exists lock_shift_columns on public.shifts;
create trigger lock_shift_columns
  before insert or update on public.shifts
  for each row execute function public.tg_lock_shift_columns();

-- ── the trap this migration must not fall into ─────────────────────────────
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('tg_lock_job_columns', 'tg_lock_shift_columns')
      and p.prosecdef
  ) then
    raise exception
      'F2: a column lock marked SECURITY DEFINER rebinds current_user to the owner, so tg_is_trusted_writer() returns true for everyone and the lock protects nothing';
  end if;
end $$;

commit;
