-- Reverses supabase/migrations/20261218000000_fetch_v2_pricing_terms.sql exactly (proved by supabase/tests/fetch-v2-pricing-terms.node.test.ts).
-- Step 3's function bodies are restored verbatim from 20261217000000_fetch_v2_lifecycle.sql, and fetch_capture_total_pence from
-- 20260909120000_fetch_price_lock.sql.
--
-- NOT a migration: it lives outside supabase/migrations so no tool applies it by accident. Run by hand only with Darren's approval.
-- It refuses while any frozen terms or 18+ confirmations exist, because dropping them would lose what members agreed to.

begin;

do $$
begin
  if exists (select 1 from public.fetch_v2_terms) or exists (select 1 from public.fetch_member_stats where adult_confirmed_at is not null) then
    raise exception 'frozen Fetch terms or 18+ confirmations exist; refusing to roll back the pricing terms';
  end if;
end $$;

delete from public.rate_limit_policies where action in ('fetch_v2_quote', 'fetch_v2_quote_day', 'fetch_v2_create', 'fetch_v2_create_day');

drop function if exists public.fetch_v2_retire_authorisation(uuid);
drop function if exists public.fetch_v2_claim_authorisation(uuid, uuid);
drop function if exists public.fetch_v2_quote(uuid, jsonb);
drop function if exists public.fetch_v2_resolve_job(uuid, uuid, numeric, numeric, numeric, numeric, text);
drop function if exists public.fetch_v2_island_at(numeric, numeric);
drop function if exists public.fetch_v2_my_eligibility();
drop function if exists public.fetch_v2_eligibility_for(uuid);
drop function if exists public.fetch_v2_confirm_adult(text);

create or replace function public.fetch_capture_total_pence(p_request uuid)
  returns table (total_pence integer, authorised_pence integer, terms_frozen boolean)
  language plpgsql stable set search_path = public
as $$
declare a public.fetch_authorisation_attempts%rowtype; v_base integer; v_svc integer;
begin
  select * into a from public.fetch_authorisation_attempts where delivery_request_id = p_request;
  select coalesce(a.base_fee_pence, d.base_fee_pence, 0) into v_base
    from public.delivery_requests d where d.id = p_request;
  v_svc := a.service_fee_pence;   -- null on legacy rows; the caller falls back
  return query select
    (v_base + coalesce(v_svc, 0) + public.fetch_waiting_fee_pence(p_request))::integer,
    a.amount_pence,
    (a.service_fee_pence is not null and a.wait_max_pence is not null);
end;
$$;

create or replace function public.fetch_v2_service_fee_pence(p_base integer) returns integer
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_fixed text; v_bps text;
begin
  select value into v_fixed from public.admin_config where key = 'fees.fetch.fixed_pence';
  select value into v_bps   from public.admin_config where key = 'fees.fetch.percent_bps';
  return (case when v_fixed ~ '^\s*[0-9]{1,6}\s*$' then btrim(v_fixed)::integer else 150 end)
       + round(p_base * (case when v_bps ~ '^\s*[0-9]{1,5}\s*$' then btrim(v_bps)::integer else 0 end) / 10000.0)::integer;
end;
$$;

create or replace function public.fetch_v2_price(p_straight_miles numeric, p_size text, p_ferry boolean) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  c          public.delivery_pricing_config;
  v_mileage  integer;
  v_min      integer;
  v_base     integer;
  v_ferry    integer;
  v_service  integer;
begin
  select * into c from public.delivery_pricing_config limit 1;
  if not found then raise exception 'Fetch pricing is not configured'; end if;
  v_mileage := round(greatest(p_straight_miles, 0) * c.road_correction_factor * c.price_per_mile_pence)::integer;
  v_min     := case when p_size = 'bulky' then c.bulky_min_fee_pence else c.min_fee_pence end;
  v_base    := greatest(v_min, v_mileage);
  v_ferry   := case when p_ferry then c.ferry_supplement_pence else 0 end;
  v_service := public.fetch_v2_service_fee_pence(v_base);
  return jsonb_build_object(
    'delivery_fee_pence', v_base, 'ferry_supplement_pence', v_ferry, 'service_fee_pence', v_service,
    'total_pence', v_base + v_ferry + v_service,
    'min_fee_applied_pence', case when v_mileage < v_min then v_min end,
    'waiting_max_pence', c.wait_max_pence,
    -- the return leg is the same journey back: same rate and road factor, no minimum, no second service fee or ferry supplement
    'return_max_pence', v_mileage,
    'straight_miles', round(p_straight_miles, 2));
end;
$$;

create or replace function public.fetch_v2_create_request(p_customer uuid, p jsonb) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_key       text := p ->> 'idempotency_key';
  v_existing  public.delivery_requests;
  v_pick      public.regions;
  v_dest      public.regions;
  v_supported text[];
  v_size      text := p ->> 'size_class';
  v_mode      text := coalesce(p ->> 'scheduling_mode', 'asap');
  v_needed    timestamptz;
  v_until     timestamptz;
  v_expires   timestamptz;
  v_plat numeric; v_plng numeric; v_dlat numeric; v_dlng numeric;
  v_ferry     boolean;
  v_quote     jsonb;
  v_id        uuid := gen_random_uuid();
  r           public.delivery_requests;
begin
  perform public.fetch_v2_service_actor(p_customer);
  if exists (select 1 from public.fetch_member_stats where user_id = p_customer and restricted_at is not null) then
    return public.fetch_v2_refuse('member_restricted');
  end if;
  if v_key is null or v_key !~ '^[A-Za-z0-9_-]{8,80}$' then
    return public.fetch_v2_refuse('idempotency_key_required');
  end if;

  -- One request per (member, key), even under concurrent double-submits.
  perform pg_advisory_xact_lock(hashtextextended('fetch-create:' || p_customer::text || ':' || v_key, 0));
  select * into v_existing from public.delivery_requests where customer_id = p_customer and idempotency_key = v_key;
  if found then
    return public.fetch_v2_ok(v_existing, jsonb_build_object('already', true));
  end if;

  begin
    select * into v_pick from public.regions where id = (p ->> 'pickup_region_id')::uuid;
    select * into v_dest from public.regions where id = (p ->> 'destination_region_id')::uuid;
    v_needed := (p ->> 'needed_by')::timestamptz;
    v_until  := (p ->> 'flexible_until')::timestamptz;
  exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format then
    return public.fetch_v2_refuse('invalid_request', jsonb_build_object('field', 'format'));
  end;
  if v_pick.id is null or v_dest.id is null then
    return public.fetch_v2_refuse('invalid_request', jsonb_build_object('field', 'region'));
  end if;
  select coalesce(array_agg(btrim(x)), '{}') into v_supported
    from unnest(string_to_array(coalesce((select value from public.admin_config where key = 'fetch.ferry.supported_island_groups'),
                                          'mainland,bressay,whalsay,yell,unst,fetlar'), ',')) x;
  if v_pick.island_group is null or v_dest.island_group is null
     or not (v_pick.island_group = any (v_supported)) or not (v_dest.island_group = any (v_supported)) then
    return public.fetch_v2_refuse('area_not_supported');
  end if;

  if not exists (select 1 from public.delivery_categories where slug = p ->> 'category_slug') then
    return public.fetch_v2_refuse('invalid_request', jsonb_build_object('field', 'category_slug'));
  end if;
  if p ->> 'category_slug' in ('pharmacy', 'takeaway') and coalesce((p ->> 'liability_acknowledged')::boolean, false) is not true then
    return public.fetch_v2_refuse('liability_required');
  end if;
  if coalesce(btrim(p ->> 'pickup_name'), '') = '' or coalesce(btrim(p ->> 'pickup_location'), '') = ''
     or coalesce(btrim(p ->> 'destination_address'), '') = ''
     or char_length(p ->> 'pickup_name') > 120 or char_length(p ->> 'pickup_location') > 300 or char_length(p ->> 'destination_address') > 300
     or char_length(coalesce(p ->> 'pickup_notes', '')) > 500 or char_length(coalesce(p ->> 'delivery_notes', '')) > 500
     or char_length(coalesce(p ->> 'contact_phone', '')) > 30 then
    return public.fetch_v2_refuse('invalid_request', jsonb_build_object('field', 'addresses'));
  end if;

  -- Server-geocoded coordinates, inside Shetland. Without them there is no honest price (no silent minimum — K.2.3).
  begin
    v_plat := (p ->> 'pickup_lat')::numeric; v_plng := (p ->> 'pickup_lng')::numeric;
    v_dlat := (p ->> 'dest_lat')::numeric;   v_dlng := (p ->> 'dest_lng')::numeric;
  exception when others then
    return public.fetch_v2_refuse('location_unresolved');
  end;
  if v_plat is null or v_plng is null or v_dlat is null or v_dlng is null
     or v_plat not between 59.3 and 60.95 or v_dlat not between 59.3 and 60.95
     or v_plng not between -2.2 and -0.6 or v_dlng not between -2.2 and -0.6 then
    return public.fetch_v2_refuse('location_unresolved');
  end if;

  -- When (plan O-D): ASAP lasts a day; "by" and "flexible" up to 7 days.
  if v_mode = 'asap' then
    v_needed := null; v_until := null;
    v_expires := now() + interval '24 hours';
  elsif v_mode = 'by' then
    if v_needed is null or v_needed < now() + interval '30 minutes' or v_needed > now() + interval '7 days' then
      return public.fetch_v2_refuse('invalid_request', jsonb_build_object('field', 'needed_by'));
    end if;
    v_expires := v_needed;
  elsif v_mode = 'flexible' then
    if v_until is null or v_until < now() + interval '1 hour' or v_until > now() + interval '7 days' then
      return public.fetch_v2_refuse('invalid_request', jsonb_build_object('field', 'flexible_until'));
    end if;
    v_expires := v_until;
  else
    return public.fetch_v2_refuse('invalid_request', jsonb_build_object('field', 'scheduling_mode'));
  end if;

  v_ferry := v_pick.island_group <> v_dest.island_group;
  v_quote := public.fetch_v2_price(public.fetch_v2_straight_miles(v_plat, v_plng, v_dlat, v_dlng), v_size, v_ferry);

  begin
    insert into public.delivery_requests (
      id, customer_id, fetch_version, status, payment_status, idempotency_key,
      category_slug, item_description, size_class, approx_dimensions_cm, handling_flags,
      pickup_name, pickup_location, pickup_notes, pickup_region_id, pickup_area, pickup_lat, pickup_lng, pickup_island_group,
      destination_address, delivery_notes, destination_region_id, destination_area, dest_lat, dest_lng, dest_island_group,
      contact_phone, share_phone_with_driver, safe_place_allowed, safe_place_note,
      already_paid, liability_acknowledged, scheduling_mode, needed_by, flexible_until, expires_at,
      ferry_required, ferry_supplement_pence, ferry_pricing_basis,
      base_fee_pence, total_fee_pence, min_fee_applied_pence, return_max_pence)
    values (
      v_id, p_customer, 2, 'pending', 'unpaid', v_key,
      p ->> 'category_slug', btrim(p ->> 'item_description'), v_size, p -> 'approx_dimensions_cm',
      coalesce(array(select jsonb_array_elements_text(p -> 'handling_flags')), '{}'),
      btrim(p ->> 'pickup_name'), btrim(p ->> 'pickup_location'), nullif(btrim(p ->> 'pickup_notes'), ''), v_pick.id,
      nullif(btrim(p ->> 'pickup_area'), ''), v_plat, v_plng, v_pick.island_group,
      btrim(p ->> 'destination_address'), nullif(btrim(p ->> 'delivery_notes'), ''), v_dest.id,
      nullif(btrim(p ->> 'destination_area'), ''), v_dlat, v_dlng, v_dest.island_group,
      nullif(btrim(p ->> 'contact_phone'), ''), coalesce((p ->> 'share_phone_with_driver')::boolean, false),
      coalesce((p ->> 'safe_place_allowed')::boolean, false), nullif(btrim(p ->> 'safe_place_note'), ''),
      coalesce((p ->> 'already_paid')::boolean, false), coalesce((p ->> 'liability_acknowledged')::boolean, false),
      v_mode, v_needed, v_until, v_expires,
      v_ferry, (v_quote ->> 'ferry_supplement_pence')::integer, case when v_ferry then 'flat_per_job_v1' end,
      (v_quote ->> 'delivery_fee_pence')::integer, (v_quote ->> 'total_pence')::integer,
      (v_quote ->> 'min_fee_applied_pence')::integer, (v_quote ->> 'return_max_pence')::integer)
    returning * into r;
  exception
    when check_violation or not_null_violation or invalid_text_representation or datetime_field_overflow or invalid_parameter_value then
      return public.fetch_v2_refuse('invalid_request', jsonb_build_object('detail', sqlerrm));
  end;

  perform public.fetch_v2_bump_member(p_customer, 'requests_created');
  perform public.fetch_v2_log(r.id, p_customer, 'requester', 'created', null, 'pending', null, null,
    jsonb_build_object('size_class', r.size_class, 'ferry_required', r.ferry_required, 'total_pence', r.total_fee_pence));

  return public.fetch_v2_ok(r, jsonb_build_object('already', false,
    'quote', v_quote - 'straight_miles', 'needs_item_photo', r.size_class = 'bulky', 'expires_at', r.expires_at));
end;
$$;

create or replace function public.fetch_v2_claim(p_driver uuid, p_request uuid, p_vehicle_confirmed boolean) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r          public.delivery_requests;
  v_problem  text;
  v_max      text;
begin
  perform public.fetch_v2_service_actor(p_driver);
  v_problem := public.fetch_v2_driver_problem(p_driver);
  if v_problem is not null then return public.fetch_v2_refuse(v_problem); end if;

  r := public.fetch_v2_lock(p_request);   -- the second of two simultaneous claims waits here, then sees the first one's result

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
  if not public.fetch_v2_transition_allowed(r.status, 'matched', 'driver') then return public.fetch_v2_refuse('invalid_transition'); end if;

  update public.delivery_requests
     set status = 'matched', driver_id = p_driver, claimed_at = now(), vehicle_confirmed_at = now(), payment_status = 'unpaid'
   where id = r.id returning * into r;
  perform public.fetch_v2_log(r.id, p_driver, 'driver', 'claimed', 'pending', 'matched', null, null,
    jsonb_build_object('vehicle_confirmed', true, 'size_class', r.size_class,
                       'vehicle_class', (select vehicle_class from public.driver_profiles where id = p_driver)));

  return public.fetch_v2_ok(r, jsonb_build_object('already', false, 'payment', jsonb_build_object(
    'action', 'authorise',
    'amount_pence', r.total_fee_pence + (select wait_max_pence from public.delivery_pricing_config limit 1) + coalesce(r.return_max_pence, 0))));
end;
$$;

create or replace function public.fetch_v2_resolve_return(p_admin uuid, p_request uuid, p_outcome text, p_fault text,
                                                          p_override_capture_pence integer default null, p_reason text default null) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r           public.delivery_requests;
  c           public.delivery_pricing_config;
  v_miles     numeric := 0;
  v_fee       integer := 0;
  v_computed  integer;
  v_capture   integer;
  v_max_hold  integer;
  v_override  boolean := p_override_capture_pence is not null;
begin
  perform public.fetch_v2_service_actor(p_admin, true);
  r := public.fetch_v2_lock(p_request);
  if r.status = 'returned' then return public.fetch_v2_ok(r, jsonb_build_object('already', true, 'capture_pence', r.resolution_capture_pence)); end if;
  if not public.fetch_v2_transition_allowed(r.status, 'returned', 'admin') then return public.fetch_v2_refuse('invalid_transition'); end if;
  if p_outcome not in ('returned_to_sender', 'retained_for_collection', 'disposed_with_consent')
     or p_fault not in ('not_driver', 'driver', 'undetermined') then
    return public.fetch_v2_refuse('invalid_request');
  end if;
  if (v_override or p_fault = 'undetermined') and coalesce(char_length(btrim(p_reason)), 0) < 3 then
    return public.fetch_v2_refuse('override_reason_required');
  end if;

  select * into c from public.delivery_pricing_config limit 1;
  -- The return leg: the same 65p basis and road factor, measured from the delivery point back to the pickup; no minimum;
  -- capped at the disclosed return_max_pence; no second service fee and no second ferry supplement (both live in total_fee_pence once).
  if p_outcome = 'returned_to_sender' then
    v_miles := round(public.fetch_v2_straight_miles(r.dest_lat, r.dest_lng, r.pickup_lat, r.pickup_lng) * c.road_correction_factor, 2);
    v_fee   := least(round(v_miles * c.price_per_mile_pence)::integer, coalesce(r.return_max_pence, 0));
  end if;
  v_computed := case p_fault
    when 'not_driver' then r.total_fee_pence + coalesce(r.waiting_fee_pence, 0) + v_fee
    when 'driver'     then 0
  end;
  v_max_hold := r.total_fee_pence + c.wait_max_pence + coalesce(r.return_max_pence, 0);
  if v_override then
    if p_override_capture_pence < 0 or p_override_capture_pence > v_max_hold then return public.fetch_v2_refuse('override_out_of_range'); end if;
    v_capture := p_override_capture_pence;
  elsif v_computed is null then
    return public.fetch_v2_refuse('override_required');
  else
    v_capture := v_computed;
  end if;

  update public.delivery_requests set
    status = 'returned', returned_at = now(), return_outcome = p_outcome, fault_party = p_fault,
    return_road_miles = v_miles, return_fee_pence = case when p_fault = 'driver' then 0 else v_fee end,
    resolution_capture_pence = v_capture,
    resolution_override_reason = case when v_override or p_fault = 'undetermined' then btrim(p_reason) end,
    resolved_by = p_admin, resolved_at = now()
   where id = r.id returning * into r;

  if p_fault = 'driver' then
    update public.driver_profiles set fault_return_count = fault_return_count + 1 where id = r.driver_id;
  elsif p_fault = 'not_driver' and r.undeliverable_reason in ('recipient_absent', 'address_wrong', 'item_refused', 'not_as_described', 'requester_aborted') then
    perform public.fetch_v2_bump_member(r.customer_id, 'fault_returns_requester_side');
  end if;
  update public.fetch_issues set status = 'resolved', resolution = left('Return resolved (' || p_fault || '): ' || coalesce(btrim(p_reason), p_outcome), 2000),
         resolved_by = p_admin, resolved_at = now()
   where request_id = r.id and kind = 'return' and status = 'open';

  perform public.fetch_v2_log(r.id, p_admin, 'admin', 'return_resolved', 'undeliverable', 'returned', p_reason, p_fault,
    jsonb_build_object('outcome', p_outcome, 'return_road_miles', v_miles, 'return_fee_pence', r.return_fee_pence,
                       'computed_capture_pence', v_computed, 'capture_pence', v_capture, 'override', v_override));
  return public.fetch_v2_ok(r, jsonb_build_object('already', false, 'capture_pence', v_capture,
    'payment', jsonb_build_object('action', case when v_capture > 0 then 'capture' else 'void' end, 'amount_pence', v_capture,
                                  'payment_intent_id', r.payment_intent_id)));
end;
$$;

create or replace function public.fetch_v2_create_run(p_origin_region uuid, p_destination_region uuid, p_departure_start timestamptz,
                                                      p_departure_end timestamptz, p_categories text[] default '{}',
                                                      p_max_size text default null, p_notes text default null) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_problem text;
  o public.regions; d public.regions;
  v_driver_max text;
  v_max     text;
  v_id      uuid;
  v_supported text[];
begin
  perform public.fetch_v2_require();
  v_problem := public.fetch_v2_driver_problem(v_uid);
  if v_problem is not null then return public.fetch_v2_refuse(v_problem); end if;
  select * into o from public.regions where id = p_origin_region;
  select * into d from public.regions where id = p_destination_region;
  select coalesce(array_agg(btrim(x)), '{}') into v_supported
    from unnest(string_to_array(coalesce((select value from public.admin_config where key = 'fetch.ferry.supported_island_groups'),
                                          'mainland,bressay,whalsay,yell,unst,fetlar'), ',')) x;
  if o.id is null or d.id is null or not (o.island_group = any (v_supported)) or not (d.island_group = any (v_supported)) then
    return public.fetch_v2_refuse('area_not_supported');
  end if;
  if p_departure_start is null or p_departure_end is null or p_departure_start < now() - interval '5 minutes'
     or p_departure_end <= p_departure_start or p_departure_end - p_departure_start > interval '12 hours'
     or p_departure_start > now() + interval '14 days' then
    return public.fetch_v2_refuse('invalid_request', jsonb_build_object('field', 'departure'));
  end if;
  if exists (select 1 from unnest(coalesce(p_categories, '{}')) c where not exists (select 1 from public.delivery_categories dc where dc.slug = c)) then
    return public.fetch_v2_refuse('invalid_request', jsonb_build_object('field', 'categories'));
  end if;
  select coalesce(max_size_class, 'small') into v_driver_max from public.driver_profiles where id = v_uid;
  v_max := coalesce(p_max_size, v_driver_max);
  if public.fetch_v2_size_rank(v_max) is null or public.fetch_v2_size_rank(v_max) > public.fetch_v2_size_rank(v_driver_max) then
    return public.fetch_v2_refuse('too_large_for_vehicle');
  end if;
  if char_length(coalesce(p_notes, '')) > 500 then return public.fetch_v2_refuse('invalid_request', jsonb_build_object('field', 'notes')); end if;
  if (select count(*) from public.runs where driver_id = v_uid and status = 'open' and departure_end > now()) >= 10 then
    return public.fetch_v2_refuse('too_many_open_runs');
  end if;

  insert into public.runs (driver_id, origin_region_id, destination_region_id, departure_start, departure_end, categories_accepted,
                           ferry_crossing, notes, max_size_class, status)
  values (v_uid, o.id, d.id, p_departure_start, p_departure_end, coalesce(p_categories, '{}'),
          o.island_group <> d.island_group, nullif(btrim(p_notes), ''), v_max, 'open')
  returning id into v_id;
  return jsonb_build_object('ok', true, 'run_id', v_id, 'run_key', md5('fetch-public-run:' || v_id::text), 'status', 'open');
end;
$$;

revoke all on function public.fetch_v2_service_fee_pence(integer) from public, anon, authenticated;
drop function if exists public.fetch_v2_member_problem(uuid);

drop table if exists public.fetch_v2_terms;
drop function if exists public.tg_fetch_v2_terms_frozen();
drop table if exists public.fetch_island_areas;

alter table public.fetch_member_stats drop constraint if exists fetch_member_stats_adult_pair;
alter table public.fetch_member_stats drop column if exists adult_confirmed_at, drop column if exists adult_confirmation_version;

commit;
