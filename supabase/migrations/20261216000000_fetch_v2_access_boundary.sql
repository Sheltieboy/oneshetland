-- Fetch v2 — the access and privacy boundary (docs/FETCH_V2_IMPLEMENTATION.md, Step 2; sections H, J).
--
-- Retires the v1 access model and replaces direct table reads with server-shaped representations. "Can read this row" is no
-- longer "can read every field": what each person receives is decided here, in the database, never by a client hiding fields.
--
--   A. PUBLIC        fetch_public_runs()           — open journeys, broad regions, date + part of day, size, categories; no one identifiable
--   B. MATCHING      fetch_v2_board()              — approved drivers: region/village, timing, item, size, handling, pay; no address,
--                                                    no phone, no notes, no requester identity, no pickup name
--   C. PARTICIPANT   fetch_v2_request_detail(id)   — the requester's own job; the assigned driver's operational detail within the
--                                                    windows below; the phone only when shared and only while the job is live
--   D. REQUESTER     contact_phone, notes, money   — the requester's own, through the detail call
--   E. ADMIN         everything, by direct SELECT or the detail call — read-only for clients; writes come through Step 3's audited
--                                                    server actions only
--
-- Participant windows (narrowest that still supports support and disputes):
--   job history (status, item, timeline, messages, events, photos)  — 30 days after the job closes  (fetch.timeouts.participant_history_secs)
--   exact addresses and access instructions                         — 72 hours after it closes       (fetch.timeouts.exact_address_secs)
--   the requester's phone                                           — while the job is live, and only if the requester shared it
--   messages and evidence photos                                    — the 30-day history window (a problem reported at hour 71 needs them)
--
-- Participant visibility is not administrative retention: administrators see every job's evidence regardless of these windows, and
-- fetch_v2_evidence_held() marks a job whose evidence must survive any future retention clean-up while an issue is unresolved.
--
-- Retired (v1 behaviours that stop when Steps 1–2 are deployed — see the plan, Step 2 status):
--   delivery_requests: approved drivers reading every pending request (two policies); every client UPDATE path (five policies);
--                      client INSERT; drivers reading requests through their runs; the admin ALL policy (now read-only);
--                      GRANT ALL to anon and authenticated (now SELECT for authenticated only)
--   waiting_events:    client INSERT and UPDATE (the open "any request" insert hole); admin ALL (now read-only); GRANT ALL → SELECT
--   runs:              anon/public reads of the raw table (driver_id, notes); client INSERT/UPDATE; admin ALL and UPDATE; GRANT ALL → SELECT
--
-- NOT APPLIED to production. Held until iOS Build 148 has cleared App Review and Darren approves (plan S.1).
-- Reversal: supabase/rollbacks/20261216000000_fetch_v2_access_boundary.down.sql (proved by the isolated suite).

begin;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. Windows: one 30-day setting becomes two, so addresses do not live as long as history
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

update public.admin_config
   set key = 'fetch.timeouts.participant_history_secs',
       description = 'Fetch v2: how long after a job closes its requester-facing history (status, item, timeline, messages, events, photos) stays visible to the assigned driver. Exact addresses use fetch.timeouts.exact_address_secs; the phone is never shown after a job closes.'
 where key = 'fetch.timeouts.address_access_secs'
   and not exists (select 1 from public.admin_config where key = 'fetch.timeouts.participant_history_secs');

insert into public.admin_config (key, value, category, description, is_secret) values
  ('fetch.timeouts.participant_history_secs', '2592000', 'fetch',
   'Fetch v2: how long after a job closes its requester-facing history (status, item, timeline, messages, events, photos) stays visible to the assigned driver. Exact addresses use fetch.timeouts.exact_address_secs; the phone is never shown after a job closes.', false),
  ('fetch.timeouts.exact_address_secs', '259200', 'fetch',
   'Fetch v2: how long after a job closes the assigned driver can still see its exact addresses and access instructions (aligned with the problem-report window).', false)
on conflict (key) do nothing;

create or replace function public.fetch_v2_timeout_secs(p_name text) returns integer
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_default integer := case p_name
    when 'payment_needed_secs'      then 7200
    when 'cancel_request_secs'      then 7200
    when 'issue_window_secs'        then 259200
    when 'participant_history_secs' then 2592000
    when 'exact_address_secs'       then 259200
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

-- A party to a v2 job for its HISTORY (messages, events, photos, waiting events): the requester, administrators, and the assigned
-- driver until the history window after it closes.
create or replace function public.fetch_v2_is_party(p_request uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from public.delivery_requests r
     where r.id = p_request and r.fetch_version = 2
       and (public.is_admin()
         or r.customer_id = auth.uid()
         or (r.driver_id = auth.uid()
             and (r.closed_at is null or r.closed_at > now() - make_interval(secs => public.fetch_v2_timeout_secs('participant_history_secs')))))
  );
$$;

-- Evidence hold: true while the job has an unresolved issue. Participant windows still apply to participants; this is the signal any
-- retention/purge job (none exists yet) must honour before deleting a job's messages, photos or storage objects. Server-only.
create or replace function public.fetch_v2_evidence_held(p_request uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp
as $$ select exists (select 1 from public.fetch_issues i where i.request_id = p_request and i.status = 'open'); $$;
revoke all on function public.fetch_v2_evidence_held(uuid) from public, anon, authenticated;
grant execute on function public.fetch_v2_evidence_held(uuid) to service_role;
comment on function public.fetch_v2_evidence_held(uuid) is
  'Fetch v2: true while a job has an open issue — its messages, photos and storage objects must not be removed by any retention clean-up until the issue is resolved. Administrators can always read them.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. delivery_requests — retire v1 client access; v2 rows readable directly by administrators only
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

drop policy if exists "Approved drivers can read all pending requests"          on public.delivery_requests;
drop policy if exists "Approved drivers can read pending requests"              on public.delivery_requests;
drop policy if exists "Approved drivers can accept pending requests"            on public.delivery_requests;
drop policy if exists "Drivers can accept pending requests"                     on public.delivery_requests;
drop policy if exists "Drivers can update matched requests"                     on public.delivery_requests;
drop policy if exists "Drivers can update status of their matched requests"     on public.delivery_requests;
drop policy if exists "Drivers must have bank connected to accept requests"     on public.delivery_requests;
drop policy if exists "Authenticated users can create requests"                 on public.delivery_requests;
drop policy if exists "Drivers can read requests on their runs"                 on public.delivery_requests;
drop policy if exists "Admins can manage all requests"                          on public.delivery_requests;
drop policy if exists "Fetch v2 requests: assigned driver reads"                on public.delivery_requests;
drop policy if exists "Fetch v2 requests: parties only"                         on public.delivery_requests;

-- Kept: "Customers can read their own requests" (v1 rows — the requester's own history; v2 rows are narrowed below).
drop policy if exists "Admins read all requests" on public.delivery_requests;
create policy "Admins read all requests" on public.delivery_requests for select to authenticated using (public.is_admin());

-- A v2 row is never read straight from the table except by an administrator: requesters and drivers get the shaped detail call.
drop policy if exists "Fetch v2 requests: administrators only (direct reads)" on public.delivery_requests;
create policy "Fetch v2 requests: administrators only (direct reads)" on public.delivery_requests as restrictive for select to anon, authenticated
  using (fetch_version = 1 or public.is_admin());

revoke all on public.delivery_requests from anon, authenticated;
grant select on public.delivery_requests to authenticated;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. waiting_events — no client ever writes waiting time (Step 3's server actions record it)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

drop policy if exists "Drivers can insert their own waiting events" on public.waiting_events;
drop policy if exists "Drivers can update their own waiting events" on public.waiting_events;
drop policy if exists "Admins can manage all waiting events"        on public.waiting_events;
drop policy if exists "Admins read all waiting events" on public.waiting_events;
create policy "Admins read all waiting events" on public.waiting_events for select to authenticated using (public.is_admin());
-- Kept: "Customers can view waiting events for their requests", "Drivers can read their own waiting events" (v1), and the Step 1
-- restrictive policies (a v2 request's waiting events: its parties, within the history window).

revoke all on public.waiting_events from anon, authenticated;
grant select on public.waiting_events to authenticated;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. runs — the raw table is private; the public sees fetch_public_runs()
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

drop policy if exists "Open runs are publicly readable"   on public.runs;
drop policy if exists "Approved drivers can create runs"  on public.runs;
drop policy if exists "Drivers can update their own runs" on public.runs;
drop policy if exists "Admins can update all runs"        on public.runs;
drop policy if exists "Admins can manage all runs"        on public.runs;
-- Kept: "Drivers can read their own runs", "Admins can read all runs". Creating and cancelling runs are Step 3 server actions.

revoke all on public.runs from anon, authenticated;
grant select on public.runs to authenticated;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 5. Photos: only a photo the requester deliberately marks for matching ever reaches the board
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

alter table public.fetch_request_photos add column if not exists matching_visible boolean not null default false;
alter table public.fetch_request_photos
  drop constraint if exists fetch_request_photos_matching_item_only,
  add constraint fetch_request_photos_matching_item_only check (not matching_visible or kind = 'item');

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 6. A. PUBLIC — open journeys, nobody identifiable
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- Respects the Fetch v2 audience: anonymous visitors see journeys only once Fetch is open to everyone; before that only the
-- admitted audience does. run_key is an opaque handle (not the run id), so the list joins to nothing else.
create or replace function public.fetch_public_runs()
  returns table (
    run_key text, origin_region text, origin_island_group text, destination_region text, destination_island_group text,
    departure_date date, part_of_day text, max_size_class text, categories text[], crosses_water boolean
  )
  language sql stable security definer set search_path = public, pg_temp
as $$
  select md5('fetch-public-run:' || r.id::text),
         o.name, o.island_group, d.name, d.island_group,
         (r.departure_start at time zone 'Europe/London')::date,
         case
           when extract(hour from r.departure_start at time zone 'Europe/London') < 12 then 'morning'
           when extract(hour from r.departure_start at time zone 'Europe/London') < 17 then 'afternoon'
           when extract(hour from r.departure_start at time zone 'Europe/London') < 21 then 'evening'
           else 'night'
         end,
         coalesce(r.max_size_class, dp.max_size_class),
         r.categories_accepted,
         coalesce(o.island_group is distinct from d.island_group, r.ferry_crossing)
    from public.runs r
    join public.driver_profiles dp on dp.id = r.driver_id and dp.driver_status = 'approved'
    left join public.regions o on o.id = r.origin_region_id
    left join public.regions d on d.id = r.destination_region_id
   where public.fetch_v2_enabled_for(auth.uid())
     and r.status = 'open'
     and r.departure_end > now()
   order by r.departure_start
   limit 200;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 7. B. MATCHING — what an approved driver may see before accepting
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- Free text here is item_description only (3–140 chars, needed to judge suitability; the request form warns against personal
-- details). pickup_name, addresses, notes, safe-place note, phone, coordinates and the requester's identity never appear.
-- The driver's pay is the delivery fee plus any ferry supplement (the service fee is OneShetland's, not theirs).
-- Step 7 adds "fits your run" and capacity filtering on top of this same representation.
create or replace function public.fetch_v2_board()
  returns table (
    request_id uuid, created_at timestamptz,
    pickup_region text, pickup_area text, pickup_island_group text,
    destination_region text, destination_area text, dest_island_group text, ferry_required boolean,
    scheduling_mode text, needed_by timestamptz, flexible_until timestamptz, expires_at timestamptz,
    category_slug text, item_description text, size_class text, approx_dimensions_cm jsonb, handling_flags text[],
    matching_photo_ids uuid[], driver_pay_pence integer
  )
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  perform public.fetch_v2_require();
  if not exists (select 1 from public.driver_profiles dp where dp.id = auth.uid() and dp.driver_status = 'approved') then
    raise exception 'Only approved Fetch drivers can browse requests' using errcode = '42501';
  end if;

  return query
  select r.id, r.created_at,
         pr.name, r.pickup_area, r.pickup_island_group,
         dr.name, r.destination_area, r.dest_island_group, r.ferry_required,
         r.scheduling_mode, r.needed_by, r.flexible_until, r.expires_at,
         r.category_slug, r.item_description, r.size_class, r.approx_dimensions_cm, r.handling_flags,
         coalesce((select array_agg(p.id order by p.created_at) from public.fetch_request_photos p
                    where p.request_id = r.id and p.kind = 'item' and p.matching_visible and p.removed_at is null), '{}'),
         case when r.base_fee_pence is null then null else r.base_fee_pence + r.ferry_supplement_pence end
    from public.delivery_requests r
    left join public.regions pr on pr.id = r.pickup_region_id
    left join public.regions dr on dr.id = r.destination_region_id
   where r.fetch_version = 2
     and r.status = 'pending'
     and r.customer_id <> auth.uid()
     and (r.expires_at is null or r.expires_at > now())
   order by r.created_at desc
   limit 200;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 8. C/D/E. PARTICIPANT — one job, shaped for whoever is asking
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

create or replace function public.fetch_v2_request_detail(p_request uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  r          public.delivery_requests;
  v_uid      uuid := auth.uid();
  v_admin    boolean := public.is_admin();
  v_role     text;
  v_live     boolean;
  v_addr_ok  boolean;
  v_common   jsonb;
  v_driver   jsonb;
  v_requester_first text;
begin
  perform public.fetch_v2_require();

  select * into r from public.delivery_requests where id = p_request and fetch_version = 2;
  -- One answer for "does not exist" and "not yours", so the call cannot be used to discover jobs.
  if not found then
    raise exception 'Fetch request not found' using errcode = 'P0002';
  end if;

  v_role := case
    when v_admin then 'admin'
    when r.customer_id = v_uid then 'requester'
    when r.driver_id = v_uid
         and (r.closed_at is null or r.closed_at > now() - make_interval(secs => public.fetch_v2_timeout_secs('participant_history_secs'))) then 'driver'
  end;
  if v_role is null then
    raise exception 'Fetch request not found' using errcode = 'P0002';
  end if;

  if v_role = 'admin' then
    return jsonb_build_object('viewer', 'admin', 'request', to_jsonb(r));
  end if;

  v_live := r.closed_at is null and r.status in ('matched', 'collected', 'undeliverable');

  -- What both parties see: the job itself, never anyone's contact details.
  v_common := jsonb_build_object(
    'id', r.id, 'status', r.status, 'payment_status', r.payment_status,
    'category_slug', r.category_slug, 'item_description', r.item_description, 'size_class', r.size_class,
    'approx_dimensions_cm', r.approx_dimensions_cm, 'handling_flags', to_jsonb(r.handling_flags),
    'pickup_region', (select name from public.regions where id = r.pickup_region_id), 'pickup_area', r.pickup_area,
    'destination_region', (select name from public.regions where id = r.destination_region_id), 'destination_area', r.destination_area,
    'ferry_required', r.ferry_required,
    'scheduling_mode', r.scheduling_mode, 'needed_by', r.needed_by, 'flexible_until', r.flexible_until, 'expires_at', r.expires_at,
    'created_at', r.created_at, 'claimed_at', r.claimed_at, 'collected_at', r.collected_at, 'delivered_at', r.delivered_at,
    'cancelled_at', r.cancelled_at, 'cancel_reason', r.cancel_reason,
    'cancel_requested_at', r.cancel_requested_at, 'cancel_request_reason', r.cancel_request_reason,
    'undeliverable_at', r.undeliverable_at, 'undeliverable_reason', r.undeliverable_reason, 'undeliverable_note', r.undeliverable_note,
    'returned_at', r.returned_at, 'return_outcome', r.return_outcome, 'fault_party', r.fault_party,
    'return_fee_pence', r.return_fee_pence, 'closed_at', r.closed_at);

  if v_role = 'requester' then
    if r.driver_id is not null then
      select jsonb_build_object('first_name', nullif(split_part(coalesce(p.full_name, ''), ' ', 1), ''), 'vehicle_class', dp.vehicle_class)
        into v_driver
        from public.profiles p left join public.driver_profiles dp on dp.id = p.id where p.id = r.driver_id;
    end if;
    return jsonb_build_object('viewer', 'requester', 'request', v_common || jsonb_build_object(
      'pickup_name', r.pickup_name, 'pickup_location', r.pickup_location, 'pickup_notes', r.pickup_notes,
      'destination_address', r.destination_address, 'delivery_notes', r.delivery_notes,
      'safe_place_allowed', r.safe_place_allowed, 'safe_place_note', r.safe_place_note,
      'contact_phone', r.contact_phone, 'share_phone_with_driver', r.share_phone_with_driver,
      'base_fee_pence', r.base_fee_pence, 'ferry_supplement_pence', r.ferry_supplement_pence,
      'waiting_fee_pence', r.waiting_fee_pence, 'total_fee_pence', r.total_fee_pence,
      'min_fee_applied_pence', r.min_fee_applied_pence, 'return_max_pence', r.return_max_pence,
      'resolution_capture_pence', r.resolution_capture_pence,
      'driver', v_driver));
  end if;

  -- The assigned driver.
  select nullif(split_part(coalesce(p.full_name, ''), ' ', 1), '') into v_requester_first from public.profiles p where p.id = r.customer_id;
  v_common := v_common || jsonb_build_object(
    'requester_first_name', v_requester_first,
    'driver_pay_pence', case when r.base_fee_pence is null then null
                             else r.base_fee_pence + r.ferry_supplement_pence + coalesce(r.waiting_fee_pence, 0) + coalesce(r.return_fee_pence, 0) end);

  v_addr_ok := r.closed_at is null
            or r.closed_at > now() - make_interval(secs => public.fetch_v2_timeout_secs('exact_address_secs'));
  if v_addr_ok then
    v_common := v_common || jsonb_build_object(
      'pickup_name', r.pickup_name, 'pickup_location', r.pickup_location, 'pickup_notes', r.pickup_notes,
      'destination_address', r.destination_address, 'delivery_notes', r.delivery_notes,
      'safe_place_allowed', r.safe_place_allowed, 'safe_place_note', r.safe_place_note);
  end if;
  if v_live and r.share_phone_with_driver then
    v_common := v_common || jsonb_build_object('contact_phone', r.contact_phone);
  end if;

  return jsonb_build_object('viewer', 'driver', 'request', v_common,
    'addresses_visible', v_addr_ok, 'phone_shared', v_live and r.share_phone_with_driver);
end;
$$;

revoke all on function public.fetch_public_runs(), public.fetch_v2_board(), public.fetch_v2_request_detail(uuid) from public, anon, authenticated;
grant execute on function public.fetch_public_runs() to anon, authenticated, service_role;
grant execute on function public.fetch_v2_board(), public.fetch_v2_request_detail(uuid) to authenticated, service_role;

comment on function public.fetch_public_runs() is
  'Fetch v2 public journeys: broad regions, date and part of day, size, categories. No driver identity, ids, notes, times or registrations. Honours the Fetch v2 audience.';
comment on function public.fetch_v2_board() is
  'Fetch v2 matching view for approved drivers: what a job is and where (region/village), never addresses, phone, notes, pickup name or who asked.';
comment on function public.fetch_v2_request_detail(uuid) is
  'Fetch v2 job detail shaped for the caller: requester (own job), assigned driver (addresses for 72h after close, history for 30 days, phone only if shared and live), admin (all).';

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 9. End-state assertions
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_t text;
begin
  foreach v_t in array array['delivery_requests', 'waiting_events', 'runs'] loop
    if has_table_privilege('anon', 'public.' || v_t, 'select') or has_table_privilege('anon', 'public.' || v_t, 'insert')
       or has_table_privilege('authenticated', 'public.' || v_t, 'insert') or has_table_privilege('authenticated', 'public.' || v_t, 'update')
       or has_table_privilege('authenticated', 'public.' || v_t, 'delete') or has_table_privilege('authenticated', 'public.' || v_t, 'truncate') then
      raise exception '% must be read-only for clients and closed to anon', v_t;
    end if;
  end loop;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('delivery_requests', 'waiting_events', 'runs')
              and permissive = 'PERMISSIVE' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')) then
    raise exception 'a permissive client write policy survived on a Fetch table';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('delivery_requests', 'runs')
              and roles @> array['anon']::name[] and permissive = 'PERMISSIVE') then
    raise exception 'anon must have no permissive policy on delivery_requests or runs';
  end if;
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and prosrc like '%address_access_secs%')
     or exists (select 1 from pg_policies where qual like '%address_access_secs%' or with_check like '%address_access_secs%') then
    raise exception 'something still reads the renamed address_access_secs window';
  end if;
end $$;

commit;
