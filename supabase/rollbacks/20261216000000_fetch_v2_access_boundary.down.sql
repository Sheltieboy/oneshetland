-- Reverses supabase/migrations/20261216000000_fetch_v2_access_boundary.sql exactly (proved by supabase/tests/fetch-v2-access-boundary.node.test.ts:
-- apply → roll back → the catalogue fingerprint equals the pre-migration one). The retired v1 policies below are copied verbatim from
-- the baseline schema, and the Step 1 objects verbatim from 20261215000000_fetch_v2_data_model.sql.
--
-- Grants are restored exactly as they were before Step 2 — everything except TRUNCATE, which an earlier OneShetland hardening
-- migration had already removed from client roles (GRANT ALL here would have widened it).
--
-- NOT a migration: it lives outside supabase/migrations so no tool applies it by accident. Run by hand only with Darren's approval.
-- Rolling back REOPENS the v1 access model (drivers reading every pending request's address and phone, open waiting-event inserts,
-- public raw runs) — it is a recovery tool, not a privacy-neutral one. It refuses if a photo has been marked for matching, because
-- dropping that column would lose the requester's choice.

begin;

do $$
begin
  if exists (select 1 from public.fetch_request_photos where matching_visible) then
    raise exception 'photos are marked for matching; refusing to roll back the access boundary';
  end if;
end $$;

-- new representations
drop function if exists public.fetch_v2_evidence_held(uuid);
drop function if exists public.fetch_v2_request_detail(uuid);
drop function if exists public.fetch_v2_board();
drop function if exists public.fetch_public_runs();
alter table public.fetch_request_photos drop constraint if exists fetch_request_photos_matching_item_only;
alter table public.fetch_request_photos drop column if exists matching_visible;

-- delivery_requests
drop policy if exists "Fetch v2 requests: administrators only (direct reads)" on public.delivery_requests;
drop policy if exists "Admins read all requests" on public.delivery_requests;
-- NOT RESTORED, ON PURPOSE: "Approved drivers can read (all) pending requests", "Approved drivers can accept pending requests" and "Drivers must have bank connected to accept requests"
-- were dropped from production by the Fetch safety fix (20261212000000) BEFORE this migration existed. They let any approved driver read every pending address/phone and edit any
-- request. Rolling back Fetch v2 must return to production's state just before v2, which does not have them. (Re-creating them would re-open a privacy hole.)
CREATE POLICY "Drivers can accept pending requests" ON public.delivery_requests FOR UPDATE USING ((status = 'pending'::text)) WITH CHECK (((status = 'matched'::text) AND (run_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.runs r
  WHERE ((r.id = delivery_requests.run_id) AND (r.driver_id = auth.uid()))))));
CREATE POLICY "Drivers can update matched requests" ON public.delivery_requests FOR UPDATE USING (((status = ANY (ARRAY['matched'::text, 'collected'::text])) AND (EXISTS ( SELECT 1
   FROM public.runs r
  WHERE ((r.id = delivery_requests.run_id) AND (r.driver_id = auth.uid()))))));
CREATE POLICY "Drivers can update status of their matched requests" ON public.delivery_requests FOR UPDATE USING (((run_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.runs r
  WHERE ((r.id = delivery_requests.run_id) AND (r.driver_id = auth.uid())))))) WITH CHECK ((status = ANY (ARRAY['matched'::text, 'collected'::text, 'delivered'::text, 'cancelled'::text])));
CREATE POLICY "Authenticated users can create requests" ON public.delivery_requests FOR INSERT WITH CHECK ((auth.uid() = customer_id));
CREATE POLICY "Drivers can read requests on their runs" ON public.delivery_requests FOR SELECT USING (((run_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.runs r
  WHERE ((r.id = delivery_requests.run_id) AND (r.driver_id = auth.uid()))))));
CREATE POLICY "Admins can manage all requests" ON public.delivery_requests USING ((public.get_my_role() = 'admin'::text));
create policy "Fetch v2 requests: assigned driver reads" on public.delivery_requests for select to authenticated
  using (fetch_version = 2 and driver_id = auth.uid());
create policy "Fetch v2 requests: parties only" on public.delivery_requests as restrictive for select to anon, authenticated
  using (
    fetch_version = 1
    or customer_id = auth.uid()
    or public.is_admin()
    or (driver_id = auth.uid()
        and (closed_at is null or closed_at > now() - make_interval(secs => public.fetch_v2_timeout_secs('address_access_secs'))))
  );
grant select, insert, update, delete, references, trigger, maintain on table public.delivery_requests to anon;
grant select, insert, update, delete, references, trigger, maintain on table public.delivery_requests to authenticated;

-- waiting_events
drop policy if exists "Admins read all waiting events" on public.waiting_events;
CREATE POLICY "Drivers can insert their own waiting events" ON public.waiting_events FOR INSERT WITH CHECK ((auth.uid() = driver_id));
CREATE POLICY "Drivers can update their own waiting events" ON public.waiting_events FOR UPDATE USING ((auth.uid() = driver_id));
CREATE POLICY "Admins can manage all waiting events" ON public.waiting_events USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));
grant select, insert, update, delete, references, trigger, maintain on table public.waiting_events to anon;
grant select, insert, update, delete, references, trigger, maintain on table public.waiting_events to authenticated;

-- runs
CREATE POLICY "Open runs are publicly readable" ON public.runs FOR SELECT USING ((status = 'open'::text));
CREATE POLICY "Approved drivers can create runs" ON public.runs FOR INSERT WITH CHECK (((auth.uid() = driver_id) AND (EXISTS ( SELECT 1
   FROM public.driver_profiles dp
  WHERE ((dp.id = auth.uid()) AND (dp.driver_status = 'approved'::text))))));
CREATE POLICY "Drivers can update their own runs" ON public.runs FOR UPDATE USING ((auth.uid() = driver_id));
CREATE POLICY "Admins can update all runs" ON public.runs FOR UPDATE USING ((public.get_my_role() = 'admin'::text));
CREATE POLICY "Admins can manage all runs" ON public.runs USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));
grant select, insert, update, delete, references, trigger, maintain on table public.runs to anon;
grant select, insert, update, delete, references, trigger, maintain on table public.runs to authenticated;

-- windows: back to the single Step 1 setting
create or replace function public.fetch_v2_is_party(p_request uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from public.delivery_requests r
     where r.id = p_request and r.fetch_version = 2
       and (public.is_admin()
         or r.customer_id = auth.uid()
         or (r.driver_id = auth.uid()
             and (r.closed_at is null or r.closed_at > now() - make_interval(secs => public.fetch_v2_timeout_secs('address_access_secs')))))
  );
$$;
create or replace function public.fetch_v2_timeout_secs(p_name text) returns integer
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_default integer := case p_name
    when 'payment_needed_secs' then 7200
    when 'cancel_request_secs' then 7200
    when 'issue_window_secs'   then 259200
    when 'address_access_secs' then 2592000
  end;
  v_raw text;
begin
  if v_default is null then
    raise exception 'unknown Fetch timeout %', p_name;
  end if;
  select value into v_raw from public.admin_config where key = 'fetch.timeouts.' || p_name;
  if v_raw ~ '^\s*[0-9]{1,9}\s*$' and btrim(v_raw)::integer > 0 then
    return btrim(v_raw)::integer;
  end if;
  return v_default;
end;
$$;
delete from public.admin_config where key = 'fetch.timeouts.exact_address_secs';
update public.admin_config set key = 'fetch.timeouts.address_access_secs', description = 'Fetch v2: how long after a job closes the assigned driver can still see its addresses (S.16).'
 where key = 'fetch.timeouts.participant_history_secs';

commit;
