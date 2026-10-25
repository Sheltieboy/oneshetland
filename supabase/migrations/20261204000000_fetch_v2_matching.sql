-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Fetch v2 — Step 7: matching (docs/FETCH_V2_IMPLEMENTATION.md, Step 7 and section I).
--
-- Fetch works because somebody is already travelling. Matching answers one question, deterministically and in words a driver can
-- read: "does this request fit a journey you are already making?" No optimisation, no scoring a person cannot explain.
--
-- One definition of "can take Fetch jobs" (fetch_v2_driver_eligibility_problem: Fetch on for them, 18+, not restricted, approved,
-- verified, not suspended, payouts on) and one of "can carry this item" (fetch_v2_capacity_problem: size and two-person lift) are
-- shared by the board, the public journey list, the requester hint, notification-recipient selection and the claim itself.
--
-- A run fits a request (fetch_v2_run_fit) when ALL hold:
--   · the run is open and not finished;
--   · DIRECTION: the request's pickup and destination islands both lie on the run's island route, in that order (Lerwick → Unst
--     covers Mainland → Yell; Yell → Lerwick is the reverse and does not fit; a Mainland-only run never covers Whalsay);
--   · ENDPOINT (section I): the pickup region is the run's origin region, or the destination region is the run's destination;
--   · TIMING: the run sets off before the request's deadline;
--   · the category is one the run accepts (or the run accepts any);
--   · the item fits the run's size limit and the driver's vehicle (including a two-person lift).
-- Island routes come from a fixed tree of Shetland's ferry links, not from distance: two places close across water are not close.
--
-- Nothing here sends a notification (Step 8) or reserves a driver. Rollback: supabase/rollbacks/20261204000000_fetch_v2_matching.down.sql
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
begin;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 0. Configuration, recipient record, indexes
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
insert into public.admin_config (key, value, category, description, is_secret) values
  ('fetch.matching.broad_max', '15', 'fetch', 'Fetch v2: when no driver''s journey or area fits a new request, at most this many other eligible drivers are chosen to hear about it.', false)
on conflict (key) do nothing;

-- Who was chosen to hear about a request, once. Step 8 sends and stamps notified_at; a rerun can never choose the same driver twice
-- for the same kind of notice.
create table if not exists public.fetch_match_notifications (
  id          bigserial primary key,
  request_id  uuid not null references public.delivery_requests (id) on delete cascade,
  driver_id   uuid not null references public.profiles (id) on delete cascade,
  kind        text not null check (kind in ('new_request', 'back_on_board')),
  tier        text not null check (tier in ('run', 'area', 'broad')),
  reason      text not null check (reason ~ '^[a-z_]{3,40}$'),
  selected_at timestamptz not null default now(),
  notified_at timestamptz,
  unique (request_id, driver_id, kind)
);
create index if not exists fetch_match_notifications_driver_idx on public.fetch_match_notifications (driver_id, selected_at);
create index if not exists fetch_match_notifications_unsent_idx on public.fetch_match_notifications (selected_at) where notified_at is null;

-- The open board, by deadline; open runs by driver and by departure.
create index if not exists delivery_requests_v2_board_idx on public.delivery_requests (expires_at, created_at) where fetch_version = 2 and status = 'pending';
create index if not exists runs_open_driver_idx on public.runs (driver_id, departure_end) where status = 'open';
create index if not exists runs_open_departure_idx on public.runs (departure_start) where status = 'open';

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. One eligibility and one capacity rule for everything
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_driver_eligibility_problem(p_driver uuid) returns text
  language sql stable security definer set search_path = public, pg_temp
as $$
  select case when p_driver is null or not public.fetch_v2_enabled_for(p_driver) then 'fetch_unavailable'
              else coalesce(public.fetch_v2_member_problem(p_driver), public.fetch_v2_driver_problem(p_driver)) end;
$$;

create or replace function public.fetch_v2_capacity_problem(p_driver uuid, p_size text, p_flags text[]) returns text
  language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when dp.id is null                                                                                      then 'too_large_for_vehicle'
    when public.fetch_v2_size_rank(p_size) > public.fetch_v2_size_rank(coalesce(dp.max_size_class, 'small')) then 'too_large_for_vehicle'
    when 'heavy_two_person' = any (coalesce(p_flags, '{}')) and not dp.can_two_person_lift                   then 'two_person_lift_required'
  end
  from (select 1) one left join public.driver_profiles dp on dp.id = p_driver;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. Island routes and run fit
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- Shetland's ferry links as a tree rooted at the Mainland: Yell from the Mainland; Unst and Fetlar from Yell; every other isle
-- from the Mainland. Unknown island → null.
create or replace function public.fetch_v2_island_parent(p_island text) returns text
  language sql immutable set search_path = public, pg_temp
as $$
  select case p_island
    when 'mainland' then null
    when 'yell' then 'mainland' when 'unst' then 'yell' when 'fetlar' then 'yell'
    when 'bressay' then 'mainland' when 'whalsay' then 'mainland' when 'out_skerries' then 'mainland'
    when 'papa_stour' then 'mainland' when 'foula' then 'mainland' when 'fair_isle' then 'mainland'
  end;
$$;

-- The islands a journey passes through, in order (Lerwick → Unst: mainland, yell, unst; Unst → Bressay: unst, yell, mainland, bressay).
create or replace function public.fetch_v2_island_route(p_from text, p_to text) returns text[]
  language plpgsql immutable set search_path = public, pg_temp
as $$
declare
  a text[] := '{}';   -- p_from and its ancestors
  b text[] := '{}';   -- p_to and its ancestors
  x text;
  i integer;
  j integer;
begin
  if p_from is null or p_to is null then return null; end if;
  x := p_from; while x is not null and cardinality(a) < 5 loop a := a || x; x := public.fetch_v2_island_parent(x); end loop;
  x := p_to;   while x is not null and cardinality(b) < 5 loop b := b || x; x := public.fetch_v2_island_parent(x); end loop;
  if a[cardinality(a)] is distinct from 'mainland' or b[cardinality(b)] is distinct from 'mainland' then return null; end if;
  for i in 1 .. cardinality(a) loop
    j := array_position(b, a[i]);
    if j is not null then
      return a[1:i] || (select coalesce(array_agg(b[k] order by k desc), '{}') from generate_series(1, j - 1) k);
    end if;
  end loop;
  return null;
end;
$$;

-- Why a run does or does not fit a request: 'run_match', or the first reason it does not.
create or replace function public.fetch_v2_run_fit(p_run uuid, p_request uuid) returns text
  language sql stable security definer set search_path = public, pg_temp
as $$
  with x as (
    select ru.*, r.pickup_region_id, r.destination_region_id as req_dest, r.pickup_island_group, r.dest_island_group,
           r.expires_at, r.category_slug, r.size_class, r.handling_flags,
           public.fetch_v2_island_route(o.island_group, d.island_group) as route
      from public.runs ru join public.delivery_requests r on r.id = p_request
      left join public.regions o on o.id = ru.origin_region_id
      left join public.regions d on d.id = ru.destination_region_id
     where ru.id = p_run)
  select case
    when x.id is null                                                                        then 'run_closed'
    when x.status <> 'open' or x.departure_end <= now()                                      then 'run_closed'
    when x.route is null or not (x.pickup_island_group = any (x.route)) or not (x.dest_island_group = any (x.route)) then 'off_route'
    when array_position(x.route, x.pickup_island_group) > array_position(x.route, x.dest_island_group) then 'wrong_direction'
    when x.pickup_region_id is distinct from x.origin_region_id and x.req_dest is distinct from x.destination_region_id then 'region_mismatch'
    when x.expires_at is not null and x.departure_start >= x.expires_at                      then 'timing_mismatch'
    when cardinality(x.categories_accepted) > 0 and not (x.category_slug = any (x.categories_accepted)) then 'category_mismatch'
    when public.fetch_v2_size_rank(x.size_class) > public.fetch_v2_size_rank(coalesce(x.max_size_class, 'bulky'))
      or public.fetch_v2_capacity_problem(x.driver_id, x.size_class, x.handling_flags) is not null then 'capacity_mismatch'
    else 'run_match'
  end
  from (select 1) one left join x on true;
$$;

-- The earliest run of this driver that fits this request (null if none).
create or replace function public.fetch_v2_best_run(p_driver uuid, p_request uuid) returns uuid
  language sql stable security definer set search_path = public, pg_temp
as $$
  select ru.id from public.runs ru
   where ru.driver_id = p_driver and ru.status = 'open' and ru.departure_end > now()
     and public.fetch_v2_run_fit(ru.id, p_request) = 'run_match'
   order by ru.departure_start, ru.id limit 1;
$$;

-- Plain-English timing words for a request.
create or replace function public.fetch_v2_timing_reason(p_mode text, p_expires timestamptz) returns text
  language sql stable set search_path = public, pg_temp
as $$
  select case
    when p_mode = 'flexible' then 'flexible_timing'
    when p_expires is not null and (p_expires at time zone 'Europe/London')::date = (now() at time zone 'Europe/London')::date then 'needed_today'
    when p_mode = 'by' then 'needed_by_date'
    else 'as_soon_as_possible'
  end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. The driver board (only for drivers who can take jobs right now)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
drop function if exists public.fetch_v2_board();

-- match: 'your_run' (fits one of your journeys), 'your_area' (pickup or destination in your areas), 'other' (fits your vehicle),
-- 'beyond_vehicle' (show_all only; can_claim false — the claim refuses it anyway). Ordered by match, then deadline, then newest.
create or replace function public.fetch_v2_board(p_show_all boolean default false)
  returns table (
    request_id uuid, created_at timestamptz,
    pickup_region text, pickup_area text, pickup_island_group text,
    destination_region text, destination_area text, dest_island_group text, ferry_required boolean,
    scheduling_mode text, needed_by timestamptz, flexible_until timestamptz, expires_at timestamptz,
    category_slug text, item_description text, size_class text, approx_dimensions_cm jsonb, handling_flags text[],
    matching_photo_ids uuid[], driver_pay_pence integer,
    match text, match_reasons text[], match_summary text, fits_run_id uuid, can_claim boolean
  )
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_uid     uuid := auth.uid();
  v_problem text;
  v_areas   uuid[];
begin
  perform public.fetch_v2_require();
  v_problem := public.fetch_v2_driver_eligibility_problem(v_uid);
  if v_problem is not null then
    raise exception 'Only drivers who can take Fetch jobs can browse requests (%)', v_problem using errcode = '42501';
  end if;
  select coalesce(areas, '{}') into v_areas from public.driver_profiles where id = v_uid;

  return query
  with open_jobs as (
    select r.* from public.delivery_requests r
     where r.fetch_version = 2 and r.status = 'pending' and r.driver_id is null
       and r.customer_id <> v_uid and (r.expires_at is null or r.expires_at > now())),
  judged as (
    select j.*, public.fetch_v2_capacity_problem(v_uid, j.size_class, j.handling_flags) as cap,
           public.fetch_v2_best_run(v_uid, j.id) as best_run,
           (j.pickup_region_id = any (v_areas) or j.destination_region_id = any (v_areas)) as in_area
      from open_jobs j),
  tiered as (
    select g.*, case when g.cap is not null then 4 when g.best_run is not null then 1 when g.in_area then 2 else 3 end as tier
      from judged g)
  select t.id, t.created_at,
         pr.name, t.pickup_area, t.pickup_island_group,
         dr.name, t.destination_area, t.dest_island_group, t.ferry_required,
         t.scheduling_mode, t.needed_by, t.flexible_until, t.expires_at,
         t.category_slug, t.item_description, t.size_class, t.approx_dimensions_cm, t.handling_flags,
         coalesce((select array_agg(p.id order by p.created_at) from public.fetch_request_photos p
                    where p.request_id = t.id and p.kind = 'item' and p.matching_visible and p.removed_at is null), '{}'),
         case when t.base_fee_pence is null then null else t.base_fee_pence + t.ferry_supplement_pence end,
         case t.tier when 1 then 'your_run' when 2 then 'your_area' when 3 then 'other' else 'beyond_vehicle' end,
         array_remove(array[
           case t.tier when 1 then 'fits_your_run' when 2 then 'in_your_area' end,
           case when t.cap is null then 'fits_your_vehicle' else t.cap end,
           public.fetch_v2_timing_reason(t.scheduling_mode, t.expires_at)], null),
         concat_ws(' · ',
           case when t.tier = 1 then 'Fits your ' || ro.name || ' → ' || rd.name || ' journey'
                when t.tier = 2 then 'In your area' end,
           case when t.cap is null then 'Fits your vehicle'
                when t.cap = 'two_person_lift_required' then 'Needs a two-person lift'
                else 'Too large for your vehicle' end,
           case public.fetch_v2_timing_reason(t.scheduling_mode, t.expires_at)
             when 'flexible_timing' then 'Flexible timing' when 'needed_today' then 'Needed today'
             when 'needed_by_date' then 'Needed by ' || to_char(t.expires_at at time zone 'Europe/London', 'FMDay')
             else 'As soon as possible' end),
         t.best_run,
         t.cap is null
    from tiered t
    left join public.regions pr on pr.id = t.pickup_region_id
    left join public.regions dr on dr.id = t.destination_region_id
    left join public.runs ru on ru.id = t.best_run
    left join public.regions ro on ro.id = ru.origin_region_id
    left join public.regions rd on rd.id = ru.destination_region_id
   where t.tier < 4 or p_show_all
   order by t.tier, t.expires_at nulls last, t.created_at desc, t.id
   limit 200;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. Public journeys (Step 2), now only from drivers who can take jobs, and ordered without revealing exact departure times
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_public_runs()
  returns table (
    run_key text, origin_region text, origin_island_group text, destination_region text, destination_island_group text,
    departure_date date, part_of_day text, max_size_class text, categories text[], crosses_water boolean
  )
  language sql stable security definer set search_path = public, pg_temp
as $$
  select s.run_key, s.origin_region, s.origin_island_group, s.destination_region, s.destination_island_group,
         s.departure_date, s.part_of_day, s.max_size_class, s.categories, s.crosses_water
    from (
      select md5('fetch-public-run:' || r.id::text) as run_key,
             o.name as origin_region, o.island_group as origin_island_group, d.name as destination_region, d.island_group as destination_island_group,
             (r.departure_start at time zone 'Europe/London')::date as departure_date,
             case
               when extract(hour from r.departure_start at time zone 'Europe/London') < 12 then 'morning'
               when extract(hour from r.departure_start at time zone 'Europe/London') < 17 then 'afternoon'
               when extract(hour from r.departure_start at time zone 'Europe/London') < 21 then 'evening'
               else 'night'
             end as part_of_day,
             coalesce(r.max_size_class, dp.max_size_class) as max_size_class,
             r.categories_accepted as categories,
             coalesce(o.island_group is distinct from d.island_group, r.ferry_crossing) as crosses_water
        from public.runs r
        join public.driver_profiles dp on dp.id = r.driver_id
        left join public.regions o on o.id = r.origin_region_id
        left join public.regions d on d.id = r.destination_region_id
       where public.fetch_v2_enabled_for(auth.uid())
         and r.status = 'open'
         and r.departure_end > now()
         and public.fetch_v2_driver_eligibility_problem(r.driver_id) is null) s
   order by s.departure_date, case s.part_of_day when 'morning' then 1 when 'afternoon' then 2 when 'evening' then 3 else 4 end,
            s.origin_region, s.destination_region, s.run_key
   limit 200;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 5. The requester's hint: "a Fetch driver may be heading that way" — a day, never a driver, never a booking
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_heading_that_way(p_request uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  r     public.delivery_requests;
  v_day date;
  v_txt text;
begin
  perform public.fetch_v2_require();
  select * into r from public.delivery_requests where id = p_request and fetch_version = 2;
  if r.id is null or r.customer_id is distinct from auth.uid() then
    raise exception 'Fetch request not found' using errcode = 'P0002';
  end if;
  if r.status <> 'pending' or (r.expires_at is not null and r.expires_at <= now()) then
    return jsonb_build_object('ok', true, 'heading_that_way', false);
  end if;
  select min((ru.departure_start at time zone 'Europe/London')::date) into v_day
    from public.runs ru
   where ru.status = 'open' and ru.departure_end > now() and ru.driver_id <> r.customer_id
     and public.fetch_v2_driver_eligibility_problem(ru.driver_id) is null
     and public.fetch_v2_run_fit(ru.id, r.id) = 'run_match';
  if v_day is null then
    return jsonb_build_object('ok', true, 'heading_that_way', false);
  end if;
  v_txt := 'A Fetch driver may be heading that way ' ||
    case when v_day = (now() at time zone 'Europe/London')::date then 'today'
         when v_day = (now() at time zone 'Europe/London')::date + 1 then 'tomorrow'
         else 'on ' || to_char(v_day, 'FMDay') end ||
    '. This isn''t a booking: a driver still needs to accept your request.';
  return jsonb_build_object('ok', true, 'heading_that_way', true, 'on', v_day, 'hint', v_txt);
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 6. Who should hear about a request (chosen once; Step 8 sends)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Tier run: an eligible driver with an open journey that fits. Tier area: an eligible driver whose areas include either end and
-- who can carry it. Tier broad: only when nobody is in either tier, at most fetch.matching.broad_max other eligible drivers who
-- can carry it, in a fixed order. Never the requester, never anyone ineligible, never a driver who already held this job (for
-- back_on_board). Returns only the drivers chosen THIS call; a rerun chooses nobody twice.
create or replace function public.fetch_v2_select_recipients(p_request uuid, p_kind text default 'new_request')
  returns table (driver_id uuid, tier text, reason text)
  language plpgsql security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  r       public.delivery_requests;
  v_broad integer := coalesce((select case when value ~ '^\s*[0-9]{1,3}\s*$' then btrim(value)::integer end
                                 from public.admin_config where key = 'fetch.matching.broad_max'), 15);
begin
  if p_kind not in ('new_request', 'back_on_board') then raise exception 'unknown notification kind %', p_kind; end if;
  select * into r from public.delivery_requests where id = p_request and fetch_version = 2;
  if r.id is null or r.status <> 'pending' or r.driver_id is not null or (r.expires_at is not null and r.expires_at <= now()) then
    return;
  end if;

  return query
  with cand as (
    select dp.id, dp.areas from public.driver_profiles dp
     where dp.driver_status = 'approved' and dp.id <> r.customer_id
       and public.fetch_v2_driver_eligibility_problem(dp.id) is null
       and public.fetch_v2_capacity_problem(dp.id, r.size_class, r.handling_flags) is null
       and not (p_kind = 'back_on_board' and exists (select 1 from public.fetch_request_events e
                                                      where e.request_id = r.id and e.actor_id = dp.id and e.event = 'claimed'))),
  tiered as (
    select c.id, case when public.fetch_v2_best_run(c.id, r.id) is not null then 'run'
                      when r.pickup_region_id = any (c.areas) or r.destination_region_id = any (c.areas) then 'area' end as tier
      from cand c),
  chosen as (
    select t.id, t.tier, case t.tier when 'run' then 'run_match' else 'area_match' end as reason from tiered t where t.tier is not null
    union all
    select b.id, 'broad', 'broad_fallback' from (
      select t.id from tiered t where not exists (select 1 from tiered t2 where t2.tier is not null) order by t.id limit v_broad) b),
  ins as (
    insert into public.fetch_match_notifications (request_id, driver_id, kind, tier, reason)
    select r.id, ch.id, p_kind, ch.tier, ch.reason from chosen ch
    on conflict on constraint fetch_match_notifications_request_id_driver_id_kind_key do nothing
    returning fetch_match_notifications.driver_id, fetch_match_notifications.tier, fetch_match_notifications.reason)
  select ins.driver_id, ins.tier, ins.reason from ins
   order by case ins.tier when 'run' then 1 when 'area' then 2 else 3 end, ins.driver_id;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 7. Administrator diagnostics: why a driver did, or did not, see / hear about a request. Codes and region names only.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_match_diagnostics(p_request uuid, p_driver uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  r       public.delivery_requests;
  dp      public.driver_profiles;
  v_elig  text;
  v_cap   text;
  v_run   uuid;
  v_area  boolean;
begin
  if not public.is_admin() then raise exception 'Only an administrator can do that' using errcode = '42501'; end if;
  select * into r from public.delivery_requests where id = p_request and fetch_version = 2;
  if r.id is null then return public.fetch_v2_refuse('not_found'); end if;
  select * into dp from public.driver_profiles where id = p_driver;
  v_elig := public.fetch_v2_driver_eligibility_problem(p_driver);
  v_cap  := public.fetch_v2_capacity_problem(p_driver, r.size_class, r.handling_flags);
  v_run  := public.fetch_v2_best_run(p_driver, r.id);
  v_area := coalesce(r.pickup_region_id = any (dp.areas) or r.destination_region_id = any (dp.areas), false);
  return jsonb_build_object('ok', true,
    'job', case when r.status = 'pending' and r.driver_id is null and (r.expires_at is null or r.expires_at > now()) then 'job_open' else 'job_not_open' end,
    'job_status', r.status,
    'own_request', r.customer_id = p_driver,
    'driver', coalesce(v_elig, 'eligible'),
    'capacity', coalesce(v_cap, 'fits'),
    'in_area', v_area,
    'board_match', case when v_elig is not null or r.customer_id = p_driver then 'not_shown'
                        when v_cap is not null then 'beyond_vehicle' when v_run is not null then 'your_run'
                        when v_area then 'your_area' else 'other' end,
    'runs', coalesce((select jsonb_agg(jsonb_build_object('run_id', ru.id, 'route', o.name || ' → ' || d.name,
                        'departs_on', (ru.departure_start at time zone 'Europe/London')::date, 'result', public.fetch_v2_run_fit(ru.id, r.id))
                        order by ru.departure_start)
                       from public.runs ru left join public.regions o on o.id = ru.origin_region_id
                       left join public.regions d on d.id = ru.destination_region_id
                      where ru.driver_id = p_driver and ru.departure_end > now() - interval '1 day'), '[]'),
    'selected', coalesce((select jsonb_agg(jsonb_build_object('kind', n.kind, 'tier', n.tier, 'reason', n.reason,
                            'selected_at', n.selected_at, 'notified_at', n.notified_at) order by n.id)
                           from public.fetch_match_notifications n where n.request_id = r.id and n.driver_id = p_driver), '[]'));
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 8. The claim uses the same capacity rule (adds the two-person lift; Step 4 otherwise unchanged)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_claim(p_driver uuid, p_request uuid, p_vehicle_confirmed boolean) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r          public.delivery_requests;
  v_problem  text;
  v_hold     integer;
begin
  perform public.fetch_v2_service_actor(p_driver);
  v_problem := coalesce(public.fetch_v2_member_problem(p_driver), public.fetch_v2_driver_problem(p_driver));
  if v_problem is not null then return public.fetch_v2_refuse(v_problem); end if;

  r := public.fetch_v2_lock(p_request);

  if r.driver_id = p_driver and r.status = 'matched' then
    return public.fetch_v2_ok(r, jsonb_build_object('already', true));
  end if;
  if r.customer_id = p_driver then return public.fetch_v2_refuse('own_request'); end if;
  if r.status <> 'pending' or r.driver_id is not null then
    return public.fetch_v2_refuse(case when r.status in ('matched', 'collected', 'undeliverable', 'delivered', 'returned') then 'already_taken' else 'not_claimable' end);
  end if;
  if r.expires_at is not null and r.expires_at <= now() then return public.fetch_v2_refuse('not_claimable'); end if;
  if p_vehicle_confirmed is not true then return public.fetch_v2_refuse('vehicle_confirmation_required'); end if;
  v_problem := public.fetch_v2_capacity_problem(p_driver, r.size_class, r.handling_flags);
  if v_problem is not null then return public.fetch_v2_refuse(v_problem); end if;
  if r.size_class = 'bulky' and not exists (select 1 from public.fetch_request_photos ph
                                             where ph.request_id = r.id and ph.kind = 'item' and ph.removed_at is null) then
    return public.fetch_v2_refuse('item_photo_required');
  end if;
  select max_hold_pence into v_hold from public.fetch_v2_terms where request_id = r.id;
  if v_hold is null then return public.fetch_v2_refuse('terms_missing'); end if;
  if not public.fetch_v2_transition_allowed(r.status, 'matched', 'driver') then return public.fetch_v2_refuse('invalid_transition'); end if;

  update public.delivery_requests
     set status = 'matched', driver_id = p_driver, claimed_at = now(), vehicle_confirmed_at = now(), payment_status = 'unpaid'
   where id = r.id returning * into r;
  perform public.fetch_v2_log(r.id, p_driver, 'driver', 'claimed', 'pending', 'matched', null, null,
    jsonb_build_object('vehicle_confirmed', true, 'size_class', r.size_class,
                       'vehicle_class', (select vehicle_class from public.driver_profiles where id = p_driver)));

  return public.fetch_v2_ok(r, jsonb_build_object('already', false,
    'payment', jsonb_build_object('action', 'authorise', 'amount_pence', v_hold)));
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 9. Grants
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
alter table public.fetch_match_notifications enable row level security;
revoke all on public.fetch_match_notifications from public, anon, authenticated;
grant all on public.fetch_match_notifications to service_role;
grant usage on sequence public.fetch_match_notifications_id_seq to service_role;

revoke all on function
  public.fetch_v2_driver_eligibility_problem(uuid), public.fetch_v2_capacity_problem(uuid, text, text[]),
  public.fetch_v2_island_parent(text), public.fetch_v2_island_route(text, text), public.fetch_v2_run_fit(uuid, uuid),
  public.fetch_v2_best_run(uuid, uuid), public.fetch_v2_timing_reason(text, timestamptz), public.fetch_v2_board(boolean),
  public.fetch_v2_heading_that_way(uuid), public.fetch_v2_select_recipients(uuid, text), public.fetch_v2_match_diagnostics(uuid, uuid)
  from public, anon, authenticated;
grant execute on function
  public.fetch_v2_driver_eligibility_problem(uuid), public.fetch_v2_capacity_problem(uuid, text, text[]),
  public.fetch_v2_island_parent(text), public.fetch_v2_island_route(text, text), public.fetch_v2_run_fit(uuid, uuid),
  public.fetch_v2_best_run(uuid, uuid), public.fetch_v2_timing_reason(text, timestamptz), public.fetch_v2_select_recipients(uuid, text)
  to service_role;
grant execute on function public.fetch_v2_board(boolean), public.fetch_v2_heading_that_way(uuid), public.fetch_v2_match_diagnostics(uuid, uuid)
  to authenticated, service_role;
-- fetch_public_runs and fetch_v2_claim keep their grants (CREATE OR REPLACE preserves them).

comment on function public.fetch_v2_board(boolean) is
  'Fetch v2 matching view for drivers who can take jobs now: what a job is and where (region/village), why it is shown, never addresses, phone, notes, pickup name or who asked.';

do $$
begin
  if has_function_privilege('authenticated', 'public.fetch_v2_select_recipients(uuid, text)', 'execute')
     or has_function_privilege('anon', 'public.fetch_v2_board(boolean)', 'execute')
     or has_function_privilege('anon', 'public.fetch_v2_heading_that_way(uuid)', 'execute')
     or has_table_privilege('authenticated', 'public.fetch_match_notifications', 'select') then
    raise exception 'a Fetch matching function or table is reachable by the wrong role';
  end if;
  if public.fetch_v2_island_route('mainland', 'unst') <> array['mainland', 'yell', 'unst']
     or public.fetch_v2_island_route('unst', 'bressay') <> array['unst', 'yell', 'mainland', 'bressay']
     or public.fetch_v2_island_route('mainland', 'mainland') <> array['mainland']
     or public.fetch_v2_island_route('yell', 'fetlar') <> array['yell', 'fetlar'] then
    raise exception 'island route self-check failed';
  end if;
end $$;

commit;
