-- ============================================================================
-- QA fix H3 — install the RPCs the app calls but that aren't in the repo migrations:
--   • get_customer_info_for_request(request_id)   — driver views the customer
--   • get_driver_info_for_request(request_id)     — customer views the driver
--   • increment_event_tickets_sold(p_event_id, p_count) — ticket counter
--
-- The app reads the result as a plain object (e.g. data.first_name), so these
-- return jsonb. SECURITY DEFINER (bypasses RLS) with in-function access checks so
-- only the parties to a request — or an admin — can see counterparty details.
--
-- RUN: paste into Supabase → SQL editor → Run. Safe to re-run.
--
-- We DROP first: these RPCs already exist on the live DB but with an older
-- return type, so a plain CREATE OR REPLACE errors ("cannot change return type
-- of existing function"). The app reads the result as a single object
-- (data.first_name / driverInfo.departure_start), which requires the jsonb
-- shape below — so we standardise on it. DROP ... IF EXISTS is a no-op when the
-- function is absent, so this is still safe on a fresh DB.
-- ============================================================================

-- Replace any older-typed versions so the return type can change to jsonb.
drop function if exists public.get_customer_info_for_request(uuid);
drop function if exists public.get_driver_info_for_request(uuid);
drop function if exists public.increment_event_tickets_sold(uuid, int);

-- Driver → customer (only the driver whose run this request is on, or an admin).
create or replace function public.get_customer_info_for_request(request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  select jsonb_build_object(
           'first_name', nullif(split_part(coalesce(p.full_name, ''), ' ', 1), ''),
           'full_name',  p.full_name
         )
    into v
    from public.delivery_requests dr
    join public.profiles p on p.id = dr.customer_id
    left join public.runs r on r.id = dr.run_id
   where dr.id = request_id
     and (
       r.driver_id = auth.uid()
       or exists (select 1 from public.profiles me where me.id = auth.uid() and me.role = 'admin')
     );
  return v;  -- null if the caller isn't the assigned driver / admin
end;
$$;

-- Customer → driver (only the customer who owns this request, or an admin).
create or replace function public.get_driver_info_for_request(request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  select jsonb_build_object(
           'full_name',       p.full_name,
           'vehicle_type',    dp.vehicle_type,
           'departure_start', r.departure_start,
           'departure_end',   r.departure_end,
           'ferry_crossing',  r.ferry_crossing
         )
    into v
    from public.delivery_requests dr
    join public.runs r            on r.id = dr.run_id
    join public.profiles p        on p.id = r.driver_id
    left join public.driver_profiles dp on dp.id = r.driver_id
   where dr.id = request_id
     and (
       dr.customer_id = auth.uid()
       or exists (select 1 from public.profiles me where me.id = auth.uid() and me.role = 'admin')
     );
  return v;
end;
$$;

-- Atomic ticket-sold counter (called by the ticket edge functions).
create or replace function public.increment_event_tickets_sold(p_event_id uuid, p_count int)
returns void
language sql
security definer
set search_path = public
as $$
  update public.events set tickets_sold = coalesce(tickets_sold, 0) + p_count where id = p_event_id;
$$;

grant execute on function public.get_customer_info_for_request(uuid) to authenticated;
grant execute on function public.get_driver_info_for_request(uuid)   to authenticated;
grant execute on function public.increment_event_tickets_sold(uuid, int) to authenticated, service_role;
