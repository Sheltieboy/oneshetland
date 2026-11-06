-- ============================================================================
-- FETCH URGENT SAFETY FIX
--
--  1. PRIVACY (permanent). Approved drivers could SELECT every pending delivery request (pickup + destination address, phone, notes) through two row-security
--     policies. Both are dropped: a driver now sees only requests on THEIR OWN run (policy "Drivers can read requests on their runs", unchanged), and the customer
--     sees their own. Three over-broad UPDATE policies that let a driver (or any payouts-enabled driver) change ANY pending request are dropped too.
--  2. PAUSE (switchable). Fetch operations are PAUSED by default and fail closed: admin_config 'fetch.operations' must equal 'open' for any of the following to work
--     through the API (website, existing mobile builds, direct REST/RPC, edge functions using the service key):
--        - creating a delivery request                 - accepting a job (status -> matched)
--        - any direct client edit of a request         - creating a run
--        - creating a driver application               - approving a driver (driver_status -> approved)
--     Cancelling, refunding and capturing an EXISTING job through the server-side functions are NOT blocked, so nothing already in flight can be stranded.
--     Rejecting or suspending a driver is NOT blocked (a safety action must always be possible). Maintenance run directly in SQL as the database owner is not blocked.
--
-- Nothing is deleted or changed: no driver approved/rejected, no request, run or application touched. Fully reversible: supabase/rollbacks/20261212000000_*.sql.
-- To reopen Fetch later (only with explicit approval):  update public.admin_config set value = 'open' where key = 'fetch.operations';
-- ============================================================================

begin;

-- 1a. The kill switch. Missing row, bad value, or any error reads as PAUSED.
insert into public.admin_config (key, value, category, description, is_secret) values
  ('fetch.operations', 'paused', 'fetch', 'Fetch (community delivery) operations: "paused" blocks new requests, job acceptance, runs, driver applications and approvals through every API path. Only the exact value "open" enables them.', false)
on conflict (key) do nothing;

create or replace function public.fetch_is_open() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select lower(btrim(value)) from public.admin_config where key = 'fetch.operations'), 'paused') = 'open'
$$;
revoke all on function public.fetch_is_open() from public;
grant execute on function public.fetch_is_open() to anon, authenticated, service_role;
comment on function public.fetch_is_open() is 'True only when admin_config fetch.operations = open. Fail-closed. Used by the website notice and the guard triggers.';

-- 1b. Guards. They act only for the API roles; the database owner (migrations, SQL editor) and SECURITY DEFINER server routines owned by it are unaffected.
create or replace function public.tg_fetch_pause_requests() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user not in ('anon', 'authenticated', 'service_role') or public.fetch_is_open() then return new; end if;
  if tg_op = 'INSERT' then
    raise exception 'Fetch is being prepared for launch. New delivery requests are paused.' using errcode = 'P0001', hint = 'fetch_paused';
  end if;
  if new.status = 'matched' and old.status is distinct from 'matched' then
    raise exception 'Fetch is being prepared for launch. Accepting jobs is paused.' using errcode = 'P0001', hint = 'fetch_paused';
  end if;
  if current_user = 'authenticated' and coalesce(public.get_my_role(), '') <> 'admin' then
    raise exception 'Fetch is being prepared for launch. Requests cannot be changed right now.' using errcode = 'P0001', hint = 'fetch_paused';
  end if;
  return new;
end $$;
revoke all on function public.tg_fetch_pause_requests() from public, anon, authenticated;

create or replace function public.tg_fetch_pause_runs() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user in ('anon', 'authenticated', 'service_role') and not public.fetch_is_open() then
    raise exception 'Fetch is being prepared for launch. New runs are paused.' using errcode = 'P0001', hint = 'fetch_paused';
  end if;
  return new;
end $$;
revoke all on function public.tg_fetch_pause_runs() from public, anon, authenticated;

create or replace function public.tg_fetch_pause_drivers() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user not in ('anon', 'authenticated', 'service_role') or public.fetch_is_open() then return new; end if;
  if tg_op = 'INSERT' then
    raise exception 'Fetch is being prepared for launch. Driver applications are paused.' using errcode = 'P0001', hint = 'fetch_paused';
  end if;
  if new.driver_status = 'approved' and old.driver_status is distinct from 'approved' then
    raise exception 'Fetch is being prepared for launch. Driver approvals are paused.' using errcode = 'P0001', hint = 'fetch_paused';
  end if;
  return new;
end $$;
revoke all on function public.tg_fetch_pause_drivers() from public, anon, authenticated;

drop trigger if exists delivery_requests_a_fetch_pause on public.delivery_requests;
create trigger delivery_requests_a_fetch_pause before insert or update on public.delivery_requests for each row execute function public.tg_fetch_pause_requests();
drop trigger if exists runs_a_fetch_pause on public.runs;
create trigger runs_a_fetch_pause before insert on public.runs for each row execute function public.tg_fetch_pause_runs();
drop trigger if exists driver_profiles_a_fetch_pause on public.driver_profiles;
create trigger driver_profiles_a_fetch_pause before insert or update of driver_status on public.driver_profiles for each row execute function public.tg_fetch_pause_drivers();

-- 2. PRIVACY: no driver can browse other people's pending requests, and no driver may edit rows that are not theirs.
drop policy if exists "Approved drivers can read all pending requests" on public.delivery_requests;
drop policy if exists "Approved drivers can read pending requests" on public.delivery_requests;
drop policy if exists "Approved drivers can accept pending requests" on public.delivery_requests;      -- any approved driver could set ANY pending request to matched/collected/delivered
drop policy if exists "Drivers must have bank connected to accept requests" on public.delivery_requests;  -- no row condition: any payouts-enabled driver could UPDATE ANY request

commit;
