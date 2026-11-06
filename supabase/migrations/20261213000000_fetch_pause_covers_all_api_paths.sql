-- ============================================================================
-- FETCH PAUSE: cover every API path, including SECURITY DEFINER functions.      (pending: NOT applied to production)
--
-- Migration 20261212000000 keys its guards on current_user (the role PostgREST switches to). A SECURITY DEFINER function runs as its OWNER, so a definer function
-- called through the API (every Fetch v2 RPC is one) would not have been stopped by those guards. The caller is still recognisable: PostgREST connects as
-- `authenticator` for EVERY request (session_user), whatever role or function owner is current. The guards now treat "reached through the API" as
-- current_user in (anon, authenticated, service_role)  OR  session_user = 'authenticator'.
-- Unchanged: the database owner and SQL run in the dashboard/CLI (session_user is not authenticator) are never blocked, nothing is deleted or changed,
-- and the paused/open switch, its default and the rules about WHAT is blocked are exactly as in 20261212000000.
-- Reverse: supabase/rollbacks/20261213000000_fetch_pause_covers_all_api_paths.rollback.sql
-- ============================================================================

begin;

create or replace function public.fetch_is_api_call() returns boolean
language sql stable set search_path = public, pg_temp as $$
  select current_user in ('anon', 'authenticated', 'service_role') or session_user = 'authenticator'
$$;
revoke all on function public.fetch_is_api_call() from public, anon, authenticated;
grant execute on function public.fetch_is_api_call() to anon, authenticated, service_role;   -- the guard triggers are SECURITY INVOKER: they run AS the calling API role, which therefore needs EXECUTE (it reveals nothing about the caller beyond what it already knows)
comment on function public.fetch_is_api_call() is 'True when the statement arrived through the API (PostgREST), including inside SECURITY DEFINER functions.';

create or replace function public.tg_fetch_pause_requests() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if not public.fetch_is_api_call() or public.fetch_is_open() then return new; end if;
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

create or replace function public.tg_fetch_pause_runs() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if public.fetch_is_api_call() and not public.fetch_is_open() then
    raise exception 'Fetch is being prepared for launch. New runs are paused.' using errcode = 'P0001', hint = 'fetch_paused';
  end if;
  return new;
end $$;

create or replace function public.tg_fetch_pause_drivers() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if not public.fetch_is_api_call() or public.fetch_is_open() then return new; end if;
  if tg_op = 'INSERT' then
    raise exception 'Fetch is being prepared for launch. Driver applications are paused.' using errcode = 'P0001', hint = 'fetch_paused';
  end if;
  if new.driver_status = 'approved' and old.driver_status is distinct from 'approved' then
    raise exception 'Fetch is being prepared for launch. Driver approvals are paused.' using errcode = 'P0001', hint = 'fetch_paused';
  end if;
  return new;
end $$;

commit;
