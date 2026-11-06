-- Reverses 20261213000000: restores the three guard functions exactly as 20261212000000 defined them (current_user only) and removes the helper.
begin;
create or replace function public.tg_fetch_pause_requests() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user not in ('anon', 'authenticated', 'service_role') or public.fetch_is_open() then return new; end if;
  if tg_op = 'INSERT' then raise exception 'Fetch is being prepared for launch. New delivery requests are paused.' using errcode = 'P0001', hint = 'fetch_paused'; end if;
  if new.status = 'matched' and old.status is distinct from 'matched' then raise exception 'Fetch is being prepared for launch. Accepting jobs is paused.' using errcode = 'P0001', hint = 'fetch_paused'; end if;
  if current_user = 'authenticated' and coalesce(public.get_my_role(), '') <> 'admin' then raise exception 'Fetch is being prepared for launch. Requests cannot be changed right now.' using errcode = 'P0001', hint = 'fetch_paused'; end if;
  return new;
end $$;
create or replace function public.tg_fetch_pause_runs() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user in ('anon', 'authenticated', 'service_role') and not public.fetch_is_open() then raise exception 'Fetch is being prepared for launch. New runs are paused.' using errcode = 'P0001', hint = 'fetch_paused'; end if;
  return new;
end $$;
create or replace function public.tg_fetch_pause_drivers() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user not in ('anon', 'authenticated', 'service_role') or public.fetch_is_open() then return new; end if;
  if tg_op = 'INSERT' then raise exception 'Fetch is being prepared for launch. Driver applications are paused.' using errcode = 'P0001', hint = 'fetch_paused'; end if;
  if new.driver_status = 'approved' and old.driver_status is distinct from 'approved' then raise exception 'Fetch is being prepared for launch. Driver approvals are paused.' using errcode = 'P0001', hint = 'fetch_paused'; end if;
  return new;
end $$;
drop function if exists public.fetch_is_api_call();
commit;
