-- Rollback of 20261221000000_fetch_v2_matching.sql (Fetch v2 Step 7: matching).
-- Restores exactly the catalogue before it: Step 2's fetch_v2_board() and fetch_public_runs(), Step 4's fetch_v2_claim.
-- Refuses while any notification-recipient record exists (it is the record Step 8 relies on not to notify anyone twice).
begin;

do $$
begin
  if exists (select 1 from public.fetch_match_notifications) then
    raise exception 'refusing to roll back matching: notification-recipient records exist';
  end if;
end $$;

drop function if exists public.fetch_v2_board(boolean);
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
revoke all on function public.fetch_v2_board() from public, anon, authenticated;
grant execute on function public.fetch_v2_board() to authenticated, service_role;
comment on function public.fetch_v2_board() is
  'Fetch v2 matching view for approved drivers: what a job is and where (region/village), never addresses, phone, notes, pickup name or who asked.';

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

create or replace function public.fetch_v2_claim(p_driver uuid, p_request uuid, p_vehicle_confirmed boolean) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r          public.delivery_requests;
  v_problem  text;
  v_max      text;
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
  select coalesce(max_size_class, 'small') into v_max from public.driver_profiles where id = p_driver;
  if public.fetch_v2_size_rank(r.size_class) > public.fetch_v2_size_rank(v_max) then
    return public.fetch_v2_refuse('too_large_for_vehicle');
  end if;
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

drop function if exists
  public.fetch_v2_match_diagnostics(uuid, uuid), public.fetch_v2_select_recipients(uuid, text), public.fetch_v2_heading_that_way(uuid),
  public.fetch_v2_timing_reason(text, timestamptz), public.fetch_v2_best_run(uuid, uuid), public.fetch_v2_run_fit(uuid, uuid),
  public.fetch_v2_island_route(text, text), public.fetch_v2_island_parent(text), public.fetch_v2_capacity_problem(uuid, text, text[]),
  public.fetch_v2_driver_eligibility_problem(uuid);
drop table if exists public.fetch_match_notifications;
drop index if exists public.delivery_requests_v2_board_idx;
drop index if exists public.runs_open_driver_idx;
drop index if exists public.runs_open_departure_idx;
delete from public.admin_config where key = 'fetch.matching.broad_max';

commit;
