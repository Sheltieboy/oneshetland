-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Fetch v2 — Step 11: the member-facing lists the web (and later the app) needs (docs/FETCH_V2_IMPLEMENTATION.md, Step 11).
--
-- Since Step 2 a member cannot read a v2 request row directly, and drivers cannot read or write runs directly, so the product had no
-- way to list "my Fetches", "my jobs" or "my journeys", or to set the areas a driver covers. These four functions are that contract,
-- each for the signed-in member only (auth.uid()), each behind the Fetch v2 flag:
--   fetch_v2_my_requests()   the requester's Fetches — a safe summary that stays useful for ever (no addresses, phone or notes)
--   fetch_v2_my_jobs()       the jobs the member drives now or drove — a summary with their pay line by line (no addresses)
--   fetch_v2_my_runs()       the member's journeys, open first
--   fetch_v2_set_my_areas()  the regions a driver covers (used by matching tier "area"); at most 20, existing regions only
--
-- Rollback: supabase/rollbacks/20261208000000_fetch_v2_member_lists.down.sql
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
begin;

create or replace function public.fetch_v2_my_requests() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid();
begin
  perform public.fetch_v2_require();
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', d.id, 'status', d.status, 'payment_status', d.payment_status, 'created_at', d.created_at, 'closed_at', d.closed_at,
      'route', coalesce(pr.name, '?') || ' → ' || coalesce(dr.name, '?'), 'item_description', d.item_description, 'size_class', d.size_class,
      'total_fee_pence', d.total_fee_pence, 'cancel_requested', d.cancel_requested_at is not null, 'expires_at', d.expires_at)
      order by d.created_at desc)
    from (select * from public.delivery_requests where fetch_version = 2 and customer_id = v_uid order by created_at desc limit 200) d
    left join public.regions pr on pr.id = d.pickup_region_id left join public.regions dr on dr.id = d.destination_region_id), '[]');
end;
$$;

create or replace function public.fetch_v2_my_jobs() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid();
begin
  perform public.fetch_v2_require();
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', d.id, 'status', d.status, 'payment_status', d.payment_status, 'claimed_at', d.claimed_at, 'closed_at', d.closed_at,
      'route', coalesce(pr.name, '?') || ' → ' || coalesce(dr.name, '?'), 'item_description', d.item_description, 'size_class', d.size_class,
      'driver_pay_pence', case when d.base_fee_pence is null then null
                               else d.base_fee_pence + d.ferry_supplement_pence + coalesce(d.waiting_fee_pence, 0) + coalesce(d.return_fee_pence, 0) end,
      -- The driver's own pay, line by line (waiting and return only once the server has set them). Never the requester's fee or hold.
      'pay', jsonb_build_object('delivery_pence', d.base_fee_pence, 'ferry_pence', d.ferry_supplement_pence,
                                'waiting_pence', d.waiting_fee_pence, 'return_pence', d.return_fee_pence),
      'cancel_requested', d.cancel_requested_at is not null, 'live', d.closed_at is null and d.status in ('matched', 'collected', 'undeliverable'))
      order by (d.closed_at is null) desc, d.claimed_at desc)
    from (select * from public.delivery_requests where fetch_version = 2 and driver_id = v_uid order by claimed_at desc limit 200) d
    left join public.regions pr on pr.id = d.pickup_region_id left join public.regions dr on dr.id = d.destination_region_id), '[]');
end;
$$;

create or replace function public.fetch_v2_my_runs() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid();
begin
  perform public.fetch_v2_require();
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', r.id, 'status', case when r.status = 'open' and r.departure_end <= now() then 'past' else r.status end,
      'origin', o.name, 'destination', dd.name, 'departure_start', r.departure_start, 'departure_end', r.departure_end,
      'max_size_class', r.max_size_class, 'categories', to_jsonb(r.categories_accepted), 'crosses_water', r.ferry_crossing)
      order by (r.status = 'open' and r.departure_end > now()) desc, r.departure_start desc)
    from (select * from public.runs where driver_id = v_uid and departure_end > now() - interval '30 days' order by departure_start desc limit 100) r
    left join public.regions o on o.id = r.origin_region_id left join public.regions dd on dd.id = r.destination_region_id), '[]');
end;
$$;

create or replace function public.fetch_v2_set_my_areas(p_areas uuid[]) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_areas uuid[] := coalesce((select array_agg(distinct a) from unnest(coalesce(p_areas, '{}')) a), '{}');
begin
  perform public.fetch_v2_require();
  if not exists (select 1 from public.driver_profiles where id = v_uid and driver_status in ('pending', 'approved')) then
    return public.fetch_v2_refuse('driver_not_applied');
  end if;
  if cardinality(v_areas) > 20 then return public.fetch_v2_refuse('too_many_areas'); end if;
  if exists (select 1 from unnest(v_areas) a where not exists (select 1 from public.regions g where g.id = a)) then
    return public.fetch_v2_refuse('invalid_request');
  end if;
  update public.driver_profiles set areas = v_areas where id = v_uid;
  return jsonb_build_object('ok', true, 'areas', to_jsonb(v_areas));
end;
$$;

revoke all on function public.fetch_v2_my_requests(), public.fetch_v2_my_jobs(), public.fetch_v2_my_runs(), public.fetch_v2_set_my_areas(uuid[])
  from public, anon, authenticated;
grant execute on function public.fetch_v2_my_requests(), public.fetch_v2_my_jobs(), public.fetch_v2_my_runs(), public.fetch_v2_set_my_areas(uuid[])
  to authenticated, service_role;

do $$
begin
  if has_function_privilege('anon', 'public.fetch_v2_my_requests()', 'execute') or has_function_privilege('anon', 'public.fetch_v2_set_my_areas(uuid[])', 'execute') then
    raise exception 'a Fetch member function is reachable by signed-out visitors';
  end if;
end $$;

commit;
