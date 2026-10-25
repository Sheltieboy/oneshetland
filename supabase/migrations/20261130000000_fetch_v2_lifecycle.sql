-- Fetch v2 — the lifecycle server actions (docs/FETCH_V2_IMPLEMENTATION.md, Step 3; sections F, K, S).
--
-- From here on a client never changes a Fetch job; it asks, and the server decides. Every action:
--   authenticates the actor · checks the Fetch v2 flag for that actor · checks role and ownership · locks the job (SELECT … FOR
--   UPDATE) · asks the ONE state machine (fetch_v2_transition_allowed) · writes the change and an append-only event in the same
--   transaction · returns a shaped response with no private fields.
--
-- Two kinds of action:
--   CLIENT    granted to authenticated; the actor is auth.uid(). Actions with no money side-effect: cancel an open request, ask to
--             cancel, decline a cancellation, extend, confirm ready, arrive, collect, cannot-deliver, report the return, runs.
--   SERVICE   granted to service_role only; the actor is passed explicitly by the edge function that verified the user's JWT
--             (Steps 4–5). Actions that must be paired with Stripe or with server-only inputs: create (server geocoding), claim
--             (→ authorise), release / agree / admin cancel (→ void), complete delivery (after capture), resolve a return
--             (→ capture or void), admin cancellation decision, and the timed sweeps.
--
-- Payments are NOT performed here. Each money-bearing action returns a payment instruction ({action, amount_pence,
-- payment_intent_id}) for the Step 5 edge function to carry out, and collection/delivery require the payment state the existing
-- Paygate machinery maintains (fetch_hold_is_fulfillable; payment_status = 'captured').
--
-- Expected refusals are answers, not errors: {ok:false, code}. "Not yours" and "does not exist" are the same P0002 error as in
-- Step 2. A repeated action that already happened returns {ok:true, already:true} and changes nothing.
--
-- NOT APPLIED to production. Held until iOS Build 148 has cleared App Review and Darren approves (plan S.1).
-- Reversal: supabase/rollbacks/20261130000000_fetch_v2_lifecycle.down.sql (proved by the isolated suite).

begin;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 0. Member restriction (plan J: admin can stop a requester using Fetch)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
alter table public.fetch_member_stats
  add column if not exists restricted_at     timestamptz,
  add column if not exists restricted_reason text check (restricted_reason is null or char_length(btrim(restricted_reason)) between 3 and 500);
alter table public.fetch_member_stats
  drop constraint if exists fetch_member_stats_restriction_reason,
  add constraint fetch_member_stats_restriction_reason check ((restricted_at is null) = (restricted_reason is null));

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. The state machine — the only place a Fetch v2 status rule lives
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_transition_allowed(p_from text, p_to text, p_role text) returns boolean
  language sql immutable set search_path = public, pg_temp
as $$
  select (p_from, p_to, p_role) in (
    ('pending',       'matched',       'driver'),     -- claim
    ('pending',       'cancelled',     'requester'),  -- cancel before acceptance
    ('pending',       'cancelled',     'admin'),
    ('pending',       'expired',       'system'),
    ('matched',       'pending',       'driver'),     -- release before collection
    ('matched',       'pending',       'admin'),      -- return to board
    ('matched',       'pending',       'system'),     -- payment not completed in time
    ('matched',       'cancelled',     'driver'),     -- agrees to the requester's cancellation request
    ('matched',       'cancelled',     'admin'),
    ('matched',       'collected',     'driver'),
    ('collected',     'delivered',     'driver'),
    ('collected',     'undeliverable', 'driver'),
    ('undeliverable', 'delivered',     'driver'),     -- delivery retried successfully
    ('undeliverable', 'returned',      'admin')       -- return resolved
  );
$$;
comment on function public.fetch_v2_transition_allowed(text, text, text) is
  'Fetch v2 state machine: every allowed (from, to, actor role). Every lifecycle action asks this; nothing else decides a status.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. Internal helpers (definer; never granted to clients)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

create or replace function public.fetch_v2_size_rank(p_size text) returns integer
  language sql immutable set search_path = public, pg_temp
as $$ select case p_size when 'small' then 1 when 'medium' then 2 when 'large' then 3 when 'bulky' then 4 end; $$;

-- Great-circle miles. Distances are always measured here, from server-geocoded coordinates — never taken from a client.
create or replace function public.fetch_v2_straight_miles(p_lat1 numeric, p_lng1 numeric, p_lat2 numeric, p_lng2 numeric) returns numeric
  language sql immutable set search_path = public, pg_temp
as $$
  select (2 * 3958.8 * asin(sqrt(
           power(sin(radians((p_lat2 - p_lat1)::float8) / 2), 2)
         + cos(radians(p_lat1::float8)) * cos(radians(p_lat2::float8)) * power(sin(radians((p_lng2 - p_lng1)::float8) / 2), 2))))::numeric;
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

-- The P0 price (S.12–S.15). Delivery fee: 65p/mile × road factor on straight-line miles, with a £4 minimum (£8 for bulky). Ferry:
-- one flat supplement per job. Service fee: once, on top. Waiting and return headroom are disclosed and held, charged only if incurred.
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

create or replace function public.fetch_v2_refuse(p_code text, p_extra jsonb default '{}') returns jsonb
  language sql immutable set search_path = public, pg_temp
as $$ select jsonb_build_object('ok', false, 'code', p_code) || coalesce(p_extra, '{}'); $$;

create or replace function public.fetch_v2_log(p_request uuid, p_actor uuid, p_role text, p_event text, p_from text, p_to text,
                                               p_reason text default null, p_fault text default null, p_meta jsonb default '{}')
  returns void
  language sql security definer set search_path = public, pg_temp
as $$
  insert into public.fetch_request_events (request_id, actor_id, actor_role, event, from_status, to_status, reason, fault_party, metadata)
  values (p_request, p_actor, p_role, p_event, p_from, p_to, left(p_reason, 1000), p_fault, coalesce(p_meta, '{}'));
$$;

create or replace function public.fetch_v2_bump_member(p_user uuid, p_counter text) returns void
  language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  insert into public.fetch_member_stats (user_id) values (p_user) on conflict (user_id) do nothing;
  update public.fetch_member_stats set
    requests_created             = requests_created             + (p_counter = 'requests_created')::integer,
    cancels_before_accept        = cancels_before_accept        + (p_counter = 'cancels_before_accept')::integer,
    cancel_requests_after_accept = cancel_requests_after_accept + (p_counter = 'cancel_requests_after_accept')::integer,
    fault_returns_requester_side = fault_returns_requester_side + (p_counter = 'fault_returns_requester_side')::integer,
    updated_at = now()
   where user_id = p_user;
end;
$$;

-- Lock and load a v2 job. Missing and not-v2 are the same "not found".
create or replace function public.fetch_v2_lock(p_request uuid) returns public.delivery_requests
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.delivery_requests;
begin
  select * into r from public.delivery_requests where id = p_request and fetch_version = 2 for update;
  if not found then raise exception 'Fetch request not found' using errcode = 'P0002'; end if;
  return r;
end;
$$;

-- The actor of a SERVICE action: must exist, must be inside the Fetch v2 audience, and (where asked) must be an administrator.
create or replace function public.fetch_v2_service_actor(p_actor uuid, p_need_admin boolean default false) returns void
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if p_actor is null or not exists (select 1 from public.profiles where id = p_actor) then
    raise exception 'A Fetch action needs a signed-in member' using errcode = '42501';
  end if;
  if not public.fetch_v2_enabled_for(p_actor) then
    raise exception 'Fetch is not available' using errcode = '42501';
  end if;
  if p_need_admin and not exists (select 1 from public.profiles where id = p_actor and role = 'admin') then
    raise exception 'Only an administrator can do that' using errcode = '42501';
  end if;
end;
$$;

-- Driver eligibility: approved, verified (evidence not expired), able to be paid.
create or replace function public.fetch_v2_driver_problem(p_driver uuid) returns text
  language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when dp.id is null or dp.driver_status <> 'approved'                 then 'driver_not_approved'
    when dp.verification_ok_until is null or dp.verification_ok_until <= now() then 'driver_verification_expired'
    when not dp.stripe_payouts_enabled                                    then 'driver_payouts_not_enabled'
  end
  from (select 1) one left join public.driver_profiles dp on dp.id = p_driver;
$$;

create or replace function public.fetch_v2_ok(r public.delivery_requests, p_extra jsonb default '{}') returns jsonb
  language sql stable set search_path = public, pg_temp
as $$ select jsonb_build_object('ok', true, 'request_id', r.id, 'status', r.status) || coalesce(p_extra, '{}'); $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. CREATE (service: the edge function geocodes; distance and price are computed here)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
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

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. CLAIM (service: Step 5's fetch-accept places the hold the response asks for)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
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

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 5. RELEASE back to the board (driver before collection · admin return-to-board · system payment timeout)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_release_internal(p_request uuid, p_actor uuid, p_role text, p_reason text, p_note text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r       public.delivery_requests;
  v_from  text;
  v_to    text;
  v_pi    text;
  v_drv   uuid;
  v_last  public.fetch_request_events;
begin
  r := public.fetch_v2_lock(p_request);

  if r.status <> 'matched' then
    select * into v_last from public.fetch_request_events where request_id = r.id order by id desc limit 1;
    if v_last.event in ('released', 'returned_to_board', 'payment_timeout') and v_last.actor_id is not distinct from p_actor then
      return public.fetch_v2_ok(r, jsonb_build_object('already', true));
    end if;
    return public.fetch_v2_refuse(case when r.status in ('collected', 'undeliverable') then 'already_collected' else 'invalid_state' end);
  end if;
  if p_role = 'driver' and r.driver_id is distinct from p_actor then
    raise exception 'Fetch request not found' using errcode = 'P0002';
  end if;

  -- A driver releasing a job whose requester has already asked to cancel ends it rather than re-listing it.
  v_to := case when r.cancel_requested_at is not null then 'cancelled' else 'pending' end;
  if not public.fetch_v2_transition_allowed('matched', v_to, p_role) then return public.fetch_v2_refuse('invalid_transition'); end if;

  v_from := r.status; v_pi := r.payment_intent_id; v_drv := r.driver_id;
  delete from public.waiting_events where request_id = r.id and driver_id = v_drv;   -- the next driver's waiting starts from nothing

  update public.delivery_requests set
    status = v_to, driver_id = null, claimed_at = null, vehicle_confirmed_at = null,
    payment_status = 'unpaid', payment_intent_id = null,
    cancelled_at  = case when v_to = 'cancelled' then now() else null end,
    cancel_reason = case when v_to = 'cancelled' then 'Driver released after a cancellation request' else cancel_reason end,
    cancel_requested_at = case when v_to = 'cancelled' then cancel_requested_at else null end,
    expires_at    = case when v_to = 'pending' then greatest(coalesce(expires_at, now()), now() + interval '2 hours') else expires_at end
   where id = r.id returning * into r;

  if p_role = 'driver' and p_reason not in ('not_as_described', 'prohibited_item') then
    update public.driver_profiles set release_count = release_count + 1, last_release_at = now() where id = v_drv;
  end if;

  perform public.fetch_v2_log(r.id, p_actor, p_role,
    case p_role when 'driver' then 'released' when 'admin' then 'returned_to_board' else 'payment_timeout' end,
    v_from, v_to, coalesce(p_reason, '') || coalesce(': ' || p_note, ''), null,
    jsonb_build_object('released_driver', v_drv, 'counted', p_role = 'driver' and p_reason not in ('not_as_described', 'prohibited_item')));

  return public.fetch_v2_ok(r, jsonb_build_object('already', false,
    'payment', jsonb_build_object('action', case when v_pi is null then 'none' else 'void' end, 'payment_intent_id', v_pi)));
end;
$$;

create or replace function public.fetch_v2_release(p_actor uuid, p_request uuid, p_reason text, p_note text default null) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_admin boolean;
begin
  perform public.fetch_v2_service_actor(p_actor);
  v_admin := exists (select 1 from public.profiles where id = p_actor and role = 'admin');
  if v_admin and not exists (select 1 from public.delivery_requests where id = p_request and driver_id = p_actor) then
    if coalesce(btrim(p_reason), '') = '' or char_length(btrim(p_reason)) < 3 then return public.fetch_v2_refuse('reason_required'); end if;
    return public.fetch_v2_release_internal(p_request, p_actor, 'admin', p_reason, p_note);
  end if;
  if p_reason is null or p_reason not in ('changed_plans', 'vehicle_unsuitable', 'not_as_described', 'prohibited_item', 'other') then
    return public.fetch_v2_refuse('reason_required');
  end if;
  if char_length(coalesce(p_note, '')) > 500 then return public.fetch_v2_refuse('invalid_request'); end if;
  return public.fetch_v2_release_internal(p_request, p_actor, 'driver', p_reason, p_note);
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 6. CANCELLATION (S.6)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- Before acceptance: the requester cancels outright.
create or replace function public.fetch_v2_cancel_open(p_request uuid, p_reason text default null) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.delivery_requests; v_uid uuid := auth.uid();
begin
  perform public.fetch_v2_require();
  r := public.fetch_v2_lock(p_request);
  if r.customer_id is distinct from v_uid then raise exception 'Fetch request not found' using errcode = 'P0002'; end if;
  if r.status = 'cancelled' then return public.fetch_v2_ok(r, jsonb_build_object('already', true)); end if;
  if r.status = 'matched' then return public.fetch_v2_refuse('use_cancellation_request'); end if;
  if r.status in ('collected', 'undeliverable') then return public.fetch_v2_refuse('cannot_cancel_after_collection'); end if;
  if not public.fetch_v2_transition_allowed(r.status, 'cancelled', 'requester') then return public.fetch_v2_refuse('invalid_transition'); end if;
  if char_length(coalesce(p_reason, '')) > 500 then return public.fetch_v2_refuse('invalid_request'); end if;

  update public.delivery_requests set status = 'cancelled', cancelled_at = now(), cancel_reason = nullif(btrim(p_reason), '')
   where id = r.id returning * into r;
  perform public.fetch_v2_bump_member(v_uid, 'cancels_before_accept');
  perform public.fetch_v2_log(r.id, v_uid, 'requester', 'cancelled', 'pending', 'cancelled', p_reason);
  return public.fetch_v2_ok(r, jsonb_build_object('already', false));
end;
$$;

-- After acceptance, before collection: a REQUEST. The job is not touched; the driver is asked.
create or replace function public.fetch_v2_request_cancellation(p_request uuid, p_reason text default null) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.delivery_requests; v_uid uuid := auth.uid();
begin
  perform public.fetch_v2_require();
  r := public.fetch_v2_lock(p_request);
  if r.customer_id is distinct from v_uid then raise exception 'Fetch request not found' using errcode = 'P0002'; end if;
  if r.status = 'pending' then return public.fetch_v2_refuse('cancel_directly'); end if;
  if r.status in ('collected', 'undeliverable') then return public.fetch_v2_refuse('cannot_cancel_after_collection'); end if;
  if r.status <> 'matched' then return public.fetch_v2_refuse('invalid_state'); end if;
  if r.cancel_requested_at is not null then
    return public.fetch_v2_ok(r, jsonb_build_object('already', true, 'driver_response_due',
      r.cancel_requested_at + make_interval(secs => public.fetch_v2_timeout_secs('cancel_request_secs'))));
  end if;
  if char_length(coalesce(p_reason, '')) > 500 then return public.fetch_v2_refuse('invalid_request'); end if;

  update public.delivery_requests set cancel_requested_at = now(), cancel_request_reason = nullif(btrim(p_reason), '')
   where id = r.id returning * into r;
  perform public.fetch_v2_bump_member(v_uid, 'cancel_requests_after_accept');
  perform public.fetch_v2_log(r.id, v_uid, 'requester', 'cancellation_requested', 'matched', 'matched', p_reason);
  return public.fetch_v2_ok(r, jsonb_build_object('already', false, 'driver_response_due',
    r.cancel_requested_at + make_interval(secs => public.fetch_v2_timeout_secs('cancel_request_secs'))));
end;
$$;

-- Shared by "driver agrees" and "admin decides to cancel": the job ends before collection; any hold is to be voided.
create or replace function public.fetch_v2_cancel_matched_internal(r public.delivery_requests, p_actor uuid, p_role text, p_event text, p_reason text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_pi text := r.payment_intent_id; v_from text := r.status;
begin
  if not public.fetch_v2_transition_allowed(r.status, 'cancelled', p_role) then return public.fetch_v2_refuse('invalid_transition'); end if;
  update public.delivery_requests set status = 'cancelled', cancelled_at = now(), cancel_reason = left(p_reason, 500)
   where id = r.id returning * into r;
  update public.fetch_issues set status = 'resolved', resolution = left('Job cancelled: ' || coalesce(p_reason, p_event), 2000),
         resolved_by = p_actor, resolved_at = now()
   where request_id = r.id and kind = 'cancellation' and status = 'open';
  perform public.fetch_v2_log(r.id, p_actor, p_role, p_event, v_from, 'cancelled', p_reason);
  return public.fetch_v2_ok(r, jsonb_build_object('already', false,
    'payment', jsonb_build_object('action', case when v_pi is null then 'none' else 'void' end, 'payment_intent_id', v_pi)));
end;
$$;

create or replace function public.fetch_v2_agree_cancellation(p_driver uuid, p_request uuid) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.delivery_requests;
begin
  perform public.fetch_v2_service_actor(p_driver);
  r := public.fetch_v2_lock(p_request);
  if r.driver_id is distinct from p_driver and not (r.status = 'cancelled' and exists (
       select 1 from public.fetch_request_events e where e.request_id = r.id and e.event = 'cancellation_agreed' and e.actor_id = p_driver)) then
    raise exception 'Fetch request not found' using errcode = 'P0002';
  end if;
  if r.status = 'cancelled' then return public.fetch_v2_ok(r, jsonb_build_object('already', true)); end if;
  if r.status <> 'matched' or r.cancel_requested_at is null then return public.fetch_v2_refuse('no_cancellation_request'); end if;
  return public.fetch_v2_cancel_matched_internal(r, p_driver, 'driver', 'cancellation_agreed', coalesce(r.cancel_request_reason, 'Cancelled at the requester''s request'));
end;
$$;

-- The driver does not agree (e.g. already on the way): an administrator decides. Collection stays blocked meanwhile.
create or replace function public.fetch_v2_decline_cancellation(p_request uuid, p_note text default null) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.delivery_requests; v_uid uuid := auth.uid();
begin
  perform public.fetch_v2_require();
  r := public.fetch_v2_lock(p_request);
  if r.driver_id is distinct from v_uid then raise exception 'Fetch request not found' using errcode = 'P0002'; end if;
  if r.status <> 'matched' or r.cancel_requested_at is null then return public.fetch_v2_refuse('no_cancellation_request'); end if;
  if exists (select 1 from public.fetch_issues where request_id = r.id and kind = 'cancellation' and status = 'open') then
    return public.fetch_v2_ok(r, jsonb_build_object('already', true, 'awaiting', 'admin'));
  end if;
  if char_length(coalesce(p_note, '')) > 1000 then return public.fetch_v2_refuse('invalid_request'); end if;
  insert into public.fetch_issues (request_id, reporter_id, reporter_role, kind, detail)
  values (r.id, v_uid, 'driver', 'cancellation', coalesce(nullif(btrim(p_note), ''), 'Driver did not agree to the cancellation request'));
  perform public.fetch_v2_log(r.id, v_uid, 'driver', 'cancellation_declined', 'matched', 'matched', p_note);
  return public.fetch_v2_ok(r, jsonb_build_object('already', false, 'awaiting', 'admin'));
end;
$$;

create or replace function public.fetch_v2_resolve_cancellation(p_admin uuid, p_request uuid, p_decision text, p_reason text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.delivery_requests;
begin
  perform public.fetch_v2_service_actor(p_admin, true);
  if p_decision not in ('cancel', 'keep') then return public.fetch_v2_refuse('invalid_request'); end if;
  if coalesce(char_length(btrim(p_reason)), 0) < 3 then return public.fetch_v2_refuse('reason_required'); end if;
  r := public.fetch_v2_lock(p_request);
  if r.cancel_requested_at is null or r.status <> 'matched' then
    if exists (select 1 from public.fetch_request_events e where e.request_id = r.id and e.event in ('cancellation_resolved', 'admin_cancelled')
                and e.actor_id = p_admin) then
      return public.fetch_v2_ok(r, jsonb_build_object('already', true));
    end if;
    return public.fetch_v2_refuse('no_cancellation_request');
  end if;
  if p_decision = 'cancel' then
    return public.fetch_v2_cancel_matched_internal(r, p_admin, 'admin', 'cancellation_resolved', p_reason);
  end if;
  update public.delivery_requests set cancel_requested_at = null, cancel_request_reason = null where id = r.id returning * into r;
  update public.fetch_issues set status = 'resolved', resolution = left('Job continues: ' || p_reason, 2000), resolved_by = p_admin, resolved_at = now()
   where request_id = r.id and kind = 'cancellation' and status = 'open';
  perform public.fetch_v2_log(r.id, p_admin, 'admin', 'cancellation_resolved', 'matched', 'matched', p_reason, null, jsonb_build_object('decision', 'keep'));
  return public.fetch_v2_ok(r, jsonb_build_object('already', false, 'payment', jsonb_build_object('action', 'none')));
end;
$$;

create or replace function public.fetch_v2_admin_cancel(p_admin uuid, p_request uuid, p_reason text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.delivery_requests; v_pi text;
begin
  perform public.fetch_v2_service_actor(p_admin, true);
  if coalesce(char_length(btrim(p_reason)), 0) < 3 then return public.fetch_v2_refuse('reason_required'); end if;
  r := public.fetch_v2_lock(p_request);
  if r.status = 'cancelled' then return public.fetch_v2_ok(r, jsonb_build_object('already', true)); end if;
  if r.status in ('collected', 'undeliverable') then return public.fetch_v2_refuse('use_return_resolution'); end if;
  if r.status = 'matched' then return public.fetch_v2_cancel_matched_internal(r, p_admin, 'admin', 'admin_cancelled', p_reason); end if;
  if not public.fetch_v2_transition_allowed(r.status, 'cancelled', 'admin') then return public.fetch_v2_refuse('invalid_transition'); end if;
  v_pi := r.payment_intent_id;
  update public.delivery_requests set status = 'cancelled', cancelled_at = now(), cancel_reason = left(p_reason, 500) where id = r.id returning * into r;
  perform public.fetch_v2_log(r.id, p_admin, 'admin', 'admin_cancelled', 'pending', 'cancelled', p_reason);
  return public.fetch_v2_ok(r, jsonb_build_object('already', false,
    'payment', jsonb_build_object('action', case when v_pi is null then 'none' else 'void' end, 'payment_intent_id', v_pi)));
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 7. EXTEND and READY (requester)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_extend(p_request uuid) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.delivery_requests; v_uid uuid := auth.uid(); v_old timestamptz;
begin
  perform public.fetch_v2_require();
  r := public.fetch_v2_lock(p_request);
  if r.customer_id is distinct from v_uid then raise exception 'Fetch request not found' using errcode = 'P0002'; end if;
  if r.status <> 'pending' then return public.fetch_v2_refuse('invalid_state'); end if;
  if (select count(*) from public.fetch_request_events where request_id = r.id and event = 'extended') >= 2 then
    return public.fetch_v2_refuse('extension_limit');
  end if;
  v_old := r.expires_at;
  update public.delivery_requests set expires_at = greatest(coalesce(expires_at, now()), now()) + interval '24 hours'
   where id = r.id returning * into r;
  perform public.fetch_v2_log(r.id, v_uid, 'requester', 'extended', 'pending', 'pending', null, null,
    jsonb_build_object('from', v_old, 'to', r.expires_at));
  return public.fetch_v2_ok(r, jsonb_build_object('expires_at', r.expires_at));
end;
$$;

-- The waiting clock (fetch_waiting_fee_pence) only bills time after the requester said the item is ready.
create or replace function public.fetch_v2_confirm_ready(p_request uuid) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.delivery_requests; v_uid uuid := auth.uid();
begin
  perform public.fetch_v2_require();
  r := public.fetch_v2_lock(p_request);
  if r.customer_id is distinct from v_uid then raise exception 'Fetch request not found' using errcode = 'P0002'; end if;
  if r.status not in ('pending', 'matched') then return public.fetch_v2_refuse('invalid_state'); end if;
  if r.ready_for_collection then return public.fetch_v2_ok(r, jsonb_build_object('already', true)); end if;
  update public.delivery_requests set ready_for_collection = true where id = r.id returning * into r;
  perform public.fetch_v2_log(r.id, v_uid, 'requester', 'ready_confirmed', r.status, r.status);
  return public.fetch_v2_ok(r, jsonb_build_object('already', false));
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 8. ARRIVE and COLLECT (assigned driver) — waiting time is measured from server timestamps only
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_mark_arrived(p_request uuid) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.delivery_requests; v_uid uuid := auth.uid(); v_at timestamptz;
begin
  perform public.fetch_v2_require();
  r := public.fetch_v2_lock(p_request);
  if r.driver_id is distinct from v_uid then raise exception 'Fetch request not found' using errcode = 'P0002'; end if;
  if r.status <> 'matched' then return public.fetch_v2_refuse('invalid_state'); end if;
  select min(arrived_at) into v_at from public.waiting_events where request_id = r.id and driver_id = v_uid;
  if v_at is not null then   -- arriving again never restarts (or extends) the clock
    return public.fetch_v2_ok(r, jsonb_build_object('already', true, 'arrived_at', v_at));
  end if;
  insert into public.waiting_events (request_id, driver_id, arrived_at) values (r.id, v_uid, now()) returning arrived_at into v_at;
  perform public.fetch_v2_log(r.id, v_uid, 'driver', 'arrived', 'matched', 'matched');
  return public.fetch_v2_ok(r, jsonb_build_object('already', false, 'arrived_at', v_at));
end;
$$;

create or replace function public.fetch_v2_mark_collected(p_request uuid) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r       public.delivery_requests;
  v_uid   uuid := auth.uid();
  v_hold  record;
  v_fee   integer;
  v_secs  integer;
begin
  perform public.fetch_v2_require();
  r := public.fetch_v2_lock(p_request);
  if r.driver_id is distinct from v_uid then raise exception 'Fetch request not found' using errcode = 'P0002'; end if;
  if r.status = 'collected' then
    return public.fetch_v2_ok(r, jsonb_build_object('already', true, 'waiting_fee_pence', r.waiting_fee_pence));
  end if;
  if r.cancel_requested_at is not null then return public.fetch_v2_refuse('cancellation_pending'); end if;
  if not public.fetch_v2_transition_allowed(r.status, 'collected', 'driver') then return public.fetch_v2_refuse('invalid_transition'); end if;

  -- PAYMENT HOOK: the Paygate hold must be genuinely fulfillable (placed, unexpired, recently confirmed with Stripe).
  select * into v_hold from public.fetch_hold_is_fulfillable(r.id);
  if not coalesce(v_hold.ok, false) then
    return public.fetch_v2_refuse('payment_not_ready', jsonb_build_object('reason', v_hold.reason));
  end if;

  update public.waiting_events set collected_at = now() where request_id = r.id and driver_id = v_uid and collected_at is null;
  select greatest(0, extract(epoch from now() - min(arrived_at)))::integer into v_secs
    from public.waiting_events where request_id = r.id and driver_id = v_uid;
  v_fee := coalesce(public.fetch_waiting_fee_pence(r.id), 0);

  update public.delivery_requests set status = 'collected', collected_at = now(), waiting_fee_pence = v_fee
   where id = r.id returning * into r;
  perform public.fetch_v2_log(r.id, v_uid, 'driver', 'collected', 'matched', 'collected', null, null,
    jsonb_build_object('waiting_fee_pence', v_fee, 'waited_secs', v_secs, 'ready_for_collection', r.ready_for_collection));
  return public.fetch_v2_ok(r, jsonb_build_object('already', false, 'waiting_fee_pence', v_fee));
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 9. DELIVER (service: Step 5's capture path calls this once the money is captured)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_complete_delivery(p_driver uuid, p_request uuid, p_left_in_safe_place boolean default false) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.delivery_requests; v_from text;
begin
  perform public.fetch_v2_service_actor(p_driver);
  r := public.fetch_v2_lock(p_request);
  if r.driver_id is distinct from p_driver then raise exception 'Fetch request not found' using errcode = 'P0002'; end if;
  if r.status = 'delivered' then return public.fetch_v2_ok(r, jsonb_build_object('already', true)); end if;
  if not public.fetch_v2_transition_allowed(r.status, 'delivered', 'driver') then return public.fetch_v2_refuse('invalid_transition'); end if;
  -- PAYMENT HOOK: delivery is recorded only after the capture succeeded.
  if r.payment_status <> 'captured' then return public.fetch_v2_refuse('payment_not_captured'); end if;
  if p_left_in_safe_place then
    if not r.safe_place_allowed then return public.fetch_v2_refuse('safe_place_not_allowed'); end if;
    if not exists (select 1 from public.fetch_request_photos where request_id = r.id and kind = 'delivery' and removed_at is null) then
      return public.fetch_v2_refuse('delivery_photo_required');
    end if;
  end if;
  v_from := r.status;
  update public.delivery_requests set status = 'delivered', delivered_at = now() where id = r.id returning * into r;
  perform public.fetch_v2_log(r.id, p_driver, 'driver', 'delivered', v_from, 'delivered', null, null,
    jsonb_build_object('left_in_safe_place', coalesce(p_left_in_safe_place, false), 'retry', v_from = 'undeliverable'));
  return public.fetch_v2_ok(r, jsonb_build_object('already', false));
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 10. CANNOT DELIVER → RETURN → RESOLUTION (S.7, S.14)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_mark_undeliverable(p_request uuid, p_reason text, p_note text default null) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.delivery_requests; v_uid uuid := auth.uid();
begin
  perform public.fetch_v2_require();
  r := public.fetch_v2_lock(p_request);
  if r.driver_id is distinct from v_uid then raise exception 'Fetch request not found' using errcode = 'P0002'; end if;
  if r.status = 'undeliverable' then return public.fetch_v2_ok(r, jsonb_build_object('already', true)); end if;
  if p_reason is null or p_reason not in ('recipient_absent', 'address_wrong', 'item_refused', 'not_as_described', 'requester_aborted',
                                          'damaged', 'vehicle_unsuitable', 'driver_unable', 'other') then
    return public.fetch_v2_refuse('reason_required');
  end if;
  if char_length(coalesce(p_note, '')) > 1000 then return public.fetch_v2_refuse('invalid_request'); end if;
  if not public.fetch_v2_transition_allowed(r.status, 'undeliverable', 'driver') then return public.fetch_v2_refuse('invalid_transition'); end if;

  update public.delivery_requests set status = 'undeliverable', undeliverable_at = now(), undeliverable_reason = p_reason,
         undeliverable_note = nullif(btrim(p_note), '')
   where id = r.id returning * into r;
  insert into public.fetch_issues (request_id, reporter_id, reporter_role, kind, detail)
  values (r.id, v_uid, 'driver', 'return', left('Cannot deliver: ' || p_reason || coalesce(' — ' || nullif(btrim(p_note), ''), ''), 2000));
  perform public.fetch_v2_log(r.id, v_uid, 'driver', 'undeliverable', 'collected', 'undeliverable', p_reason);
  return public.fetch_v2_ok(r, jsonb_build_object('already', false));
end;
$$;

-- The driver says the item is back with the sender (or retained / disposed with consent). An administrator then resolves money.
create or replace function public.fetch_v2_report_return(p_request uuid, p_note text default null) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.delivery_requests; v_uid uuid := auth.uid();
begin
  perform public.fetch_v2_require();
  r := public.fetch_v2_lock(p_request);
  if r.driver_id is distinct from v_uid then raise exception 'Fetch request not found' using errcode = 'P0002'; end if;
  if r.status <> 'undeliverable' then return public.fetch_v2_refuse('invalid_state'); end if;
  if exists (select 1 from public.fetch_request_events where request_id = r.id and event = 'return_reported') then
    return public.fetch_v2_ok(r, jsonb_build_object('already', true));
  end if;
  -- EVIDENCE HOOK (Step 9 uploads): a return photo is required.
  if not exists (select 1 from public.fetch_request_photos where request_id = r.id and kind = 'return' and removed_at is null) then
    return public.fetch_v2_refuse('return_photo_required');
  end if;
  if char_length(coalesce(p_note, '')) > 1000 then return public.fetch_v2_refuse('invalid_request'); end if;
  perform public.fetch_v2_log(r.id, v_uid, 'driver', 'return_reported', 'undeliverable', 'undeliverable', p_note);
  return public.fetch_v2_ok(r, jsonb_build_object('already', false, 'awaiting', 'admin'));
end;
$$;

-- Money follows fault (K.4), computed here; an administrator may override within the hold, always with a reason.
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

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 11. Timed sweeps (service; run by the reminder runner in Step 5)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_expire_due() returns integer
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id uuid; n integer := 0;
begin
  for v_id in select id from public.delivery_requests
               where fetch_version = 2 and status = 'pending' and expires_at <= now() for update skip locked loop
    if public.fetch_v2_transition_allowed('pending', 'expired', 'system') then
      update public.delivery_requests set status = 'expired' where id = v_id and status = 'pending';
      perform public.fetch_v2_log(v_id, null, 'system', 'expired', 'pending', 'expired');
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;

-- A driver accepted but the requester never completed payment: back to the board; the caller voids any intent returned.
create or replace function public.fetch_v2_release_unpaid_due() returns table (request_id uuid, payment_intent_id text)
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id uuid; v_res jsonb;
begin
  for v_id in select d.id from public.delivery_requests d
               where d.fetch_version = 2 and d.status = 'matched' and d.payment_status not in ('authorised', 'captured')
                 and d.claimed_at <= now() - make_interval(secs => public.fetch_v2_timeout_secs('payment_needed_secs'))
               for update skip locked loop
    v_res := public.fetch_v2_release_internal(v_id, null, 'system', 'payment_timeout', null);
    if (v_res ->> 'ok')::boolean then
      request_id := v_id; payment_intent_id := v_res -> 'payment' ->> 'payment_intent_id'; return next;
    end if;
  end loop;
end;
$$;

-- A cancellation request the driver has not answered in time goes to an administrator (it is never decided automatically).
create or replace function public.fetch_v2_escalate_cancel_requests() returns integer
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id uuid; n integer := 0;
begin
  for v_id in select d.id from public.delivery_requests d
               where d.fetch_version = 2 and d.status = 'matched' and d.cancel_requested_at is not null
                 and d.cancel_requested_at <= now() - make_interval(secs => public.fetch_v2_timeout_secs('cancel_request_secs'))
                 and not exists (select 1 from public.fetch_issues i where i.request_id = d.id and i.kind = 'cancellation')
               for update skip locked loop
    insert into public.fetch_issues (request_id, reporter_role, kind, detail)
    values (v_id, 'system', 'cancellation', 'The driver did not answer the cancellation request in time');
    perform public.fetch_v2_log(v_id, null, 'system', 'cancellation_escalated', 'matched', 'matched');
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 12. RUNS (driver)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
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

-- Fetch v2 jobs are never attached to runs (catch-a-run moved server-side), so cancelling a run affects no job; a legacy v1
-- run that still carries an in-progress v1 job is refused rather than orphaning it.
create or replace function public.fetch_v2_cancel_run(p_run uuid) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); v_status text;
begin
  perform public.fetch_v2_require();
  select status into v_status from public.runs where id = p_run and driver_id = v_uid for update;
  if not found then raise exception 'Run not found' using errcode = 'P0002'; end if;
  if v_status = 'cancelled' then return jsonb_build_object('ok', true, 'already', true, 'status', 'cancelled'); end if;
  if v_status <> 'open' then return public.fetch_v2_refuse('invalid_state'); end if;
  if exists (select 1 from public.delivery_requests where run_id = p_run and status in ('matched', 'collected')) then
    return public.fetch_v2_refuse('run_has_jobs');
  end if;
  update public.runs set status = 'cancelled', updated_at = now() where id = p_run;
  return jsonb_build_object('ok', true, 'already', false, 'status', 'cancelled');
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 13. Requester long-term history (plan Step 3 status): operational details expire with the history window
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
  v_recent   boolean;
  v_common   jsonb;
  v_driver   jsonb;
  v_requester_first text;
begin
  perform public.fetch_v2_require();

  select * into r from public.delivery_requests where id = p_request and fetch_version = 2;
  if not found then
    raise exception 'Fetch request not found' using errcode = 'P0002';
  end if;

  v_recent := r.closed_at is null or r.closed_at > now() - make_interval(secs => public.fetch_v2_timeout_secs('participant_history_secs'));
  v_role := case
    when v_admin then 'admin'
    when r.customer_id = v_uid then 'requester'
    when r.driver_id = v_uid and v_recent then 'driver'
  end;
  if v_role is null then
    raise exception 'Fetch request not found' using errcode = 'P0002';
  end if;

  if v_role = 'admin' then
    return jsonb_build_object('viewer', 'admin', 'request', to_jsonb(r));
  end if;

  v_live := r.closed_at is null and r.status in ('matched', 'collected', 'undeliverable');

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
    v_common := v_common || jsonb_build_object(
      'base_fee_pence', r.base_fee_pence, 'ferry_supplement_pence', r.ferry_supplement_pence,
      'waiting_fee_pence', r.waiting_fee_pence, 'total_fee_pence', r.total_fee_pence,
      'min_fee_applied_pence', r.min_fee_applied_pence, 'return_max_pence', r.return_max_pence,
      'resolution_capture_pence', r.resolution_capture_pence, 'share_phone_with_driver', r.share_phone_with_driver,
      'driver', v_driver, 'operational_details_visible', v_recent);
    -- The requester's own operational details (addresses, instructions, phone) stay with the job for the history window after it
    -- closes; after that the long-term history is the safe summary above.
    if v_recent then
      v_common := v_common || jsonb_build_object(
        'pickup_name', r.pickup_name, 'pickup_location', r.pickup_location, 'pickup_notes', r.pickup_notes,
        'destination_address', r.destination_address, 'delivery_notes', r.delivery_notes,
        'safe_place_allowed', r.safe_place_allowed, 'safe_place_note', r.safe_place_note,
        'contact_phone', r.contact_phone);
    end if;
    return jsonb_build_object('viewer', 'requester', 'request', v_common);
  end if;

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

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 14. Grants
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
revoke all on function
  public.fetch_v2_transition_allowed(text, text, text), public.fetch_v2_size_rank(text),
  public.fetch_v2_straight_miles(numeric, numeric, numeric, numeric), public.fetch_v2_service_fee_pence(integer),
  public.fetch_v2_price(numeric, text, boolean), public.fetch_v2_refuse(text, jsonb),
  public.fetch_v2_log(uuid, uuid, text, text, text, text, text, text, jsonb), public.fetch_v2_bump_member(uuid, text),
  public.fetch_v2_lock(uuid), public.fetch_v2_service_actor(uuid, boolean), public.fetch_v2_driver_problem(uuid),
  public.fetch_v2_ok(public.delivery_requests, jsonb),
  public.fetch_v2_release_internal(uuid, uuid, text, text, text), public.fetch_v2_cancel_matched_internal(public.delivery_requests, uuid, text, text, text),
  public.fetch_v2_create_request(uuid, jsonb), public.fetch_v2_claim(uuid, uuid, boolean), public.fetch_v2_release(uuid, uuid, text, text),
  public.fetch_v2_agree_cancellation(uuid, uuid), public.fetch_v2_resolve_cancellation(uuid, uuid, text, text),
  public.fetch_v2_admin_cancel(uuid, uuid, text), public.fetch_v2_complete_delivery(uuid, uuid, boolean),
  public.fetch_v2_resolve_return(uuid, uuid, text, text, integer, text),
  public.fetch_v2_expire_due(), public.fetch_v2_release_unpaid_due(), public.fetch_v2_escalate_cancel_requests(),
  public.fetch_v2_cancel_open(uuid, text), public.fetch_v2_request_cancellation(uuid, text), public.fetch_v2_decline_cancellation(uuid, text),
  public.fetch_v2_extend(uuid), public.fetch_v2_confirm_ready(uuid), public.fetch_v2_mark_arrived(uuid), public.fetch_v2_mark_collected(uuid),
  public.fetch_v2_mark_undeliverable(uuid, text, text), public.fetch_v2_report_return(uuid, text),
  public.fetch_v2_create_run(uuid, uuid, timestamptz, timestamptz, text[], text, text), public.fetch_v2_cancel_run(uuid)
from public, anon, authenticated;

-- SERVICE actions (and the internal helpers, for the server's own use)
grant execute on function
  public.fetch_v2_transition_allowed(text, text, text), public.fetch_v2_price(numeric, text, boolean),
  public.fetch_v2_straight_miles(numeric, numeric, numeric, numeric),
  public.fetch_v2_create_request(uuid, jsonb), public.fetch_v2_claim(uuid, uuid, boolean), public.fetch_v2_release(uuid, uuid, text, text),
  public.fetch_v2_agree_cancellation(uuid, uuid), public.fetch_v2_resolve_cancellation(uuid, uuid, text, text),
  public.fetch_v2_admin_cancel(uuid, uuid, text), public.fetch_v2_complete_delivery(uuid, uuid, boolean),
  public.fetch_v2_resolve_return(uuid, uuid, text, text, integer, text),
  public.fetch_v2_expire_due(), public.fetch_v2_release_unpaid_due(), public.fetch_v2_escalate_cancel_requests()
to service_role;

-- CLIENT actions
grant execute on function
  public.fetch_v2_cancel_open(uuid, text), public.fetch_v2_request_cancellation(uuid, text), public.fetch_v2_decline_cancellation(uuid, text),
  public.fetch_v2_extend(uuid), public.fetch_v2_confirm_ready(uuid), public.fetch_v2_mark_arrived(uuid), public.fetch_v2_mark_collected(uuid),
  public.fetch_v2_mark_undeliverable(uuid, text, text), public.fetch_v2_report_return(uuid, text),
  public.fetch_v2_create_run(uuid, uuid, timestamptz, timestamptz, text[], text, text), public.fetch_v2_cancel_run(uuid)
to authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 15. End-state assertions
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
do $$
begin
  if has_function_privilege('authenticated', 'public.fetch_v2_claim(uuid, uuid, boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.fetch_v2_create_request(uuid, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.fetch_v2_resolve_return(uuid, uuid, text, text, integer, text)', 'execute')
     or has_function_privilege('authenticated', 'public.fetch_v2_log(uuid, uuid, text, text, text, text, text, text, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.fetch_v2_mark_collected(uuid)', 'execute') then
    raise exception 'a Fetch service action or helper is reachable by a client';
  end if;
  if not public.fetch_v2_transition_allowed('pending', 'matched', 'driver') or public.fetch_v2_transition_allowed('pending', 'collected', 'driver') then
    raise exception 'state machine self-check failed';
  end if;
end $$;

commit;
