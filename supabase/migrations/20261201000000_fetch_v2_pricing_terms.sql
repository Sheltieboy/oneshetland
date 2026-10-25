-- Fetch v2 — authoritative pricing, frozen terms, island derivation and 18+ eligibility
-- (docs/FETCH_V2_IMPLEMENTATION.md, Step 4).
--
-- ONE SOURCE OF PRICE. Every Fetch v2 amount is computed by fetch_v2_price() in this database, from delivery_pricing_config and
-- admin_config fees.fetch.*. Edge functions and clients never compute a Fetch v2 price: fetch-v2-quote and fetch-v2-create call
-- fetch_v2_quote / fetch_v2_create_request and pass the answer through. (_shared/commission-config.ts is still used by v1 Fetch and the
-- other rails; it reads the same admin_config keys with the same £1.50 default, which a test pins.)
--
-- FROZEN TERMS. When a requester commits, every number needed to finish that job is written once to fetch_v2_terms and never changes:
-- rates, road factor, minimums, size class, measured miles, delivery fee, ferry supplement, service fee, waiting rules and cap, return
-- rate and maximum, normal total and maximum hold, and a pricing version. The hold, waiting fee, capture total and return resolution all
-- read these, not live configuration.
--
-- WHERE A JOB IS. Coordinates come only from server-side geocoding. The island is derived from those coordinates (fetch_island_areas,
-- admin-maintained bounding areas; Mainland is everything else inside Shetland). The region a client picks is accepted only if it lies
-- on that island — so a Yell address cannot be priced as Lerwick to avoid the ferry supplement.
--
-- 18+. Fetch v2 is for adults (requesters and drivers). The server-side signal is an explicit confirmation recorded per member
-- (fetch_member_stats.adult_confirmed_at). Create, claim and run creation refuse without it.
--
-- REPLACEMENT HOLDS. fetch_v2_claim_authorisation freezes a driver's hold from the job's terms; fetch_v2_retire_authorisation archives a
-- released driver's voided hold so the next driver's starts clean, at the next generation (the Stripe idempotency key moves with it).
--
-- NOT APPLIED to production. Held until iOS Build 148 has cleared App Review and Darren approves (plan S.1).
-- Reversal: supabase/rollbacks/20261201000000_fetch_v2_pricing_terms.down.sql (proved by the isolated suite).

begin;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. 18+ eligibility (requesters and drivers)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
alter table public.fetch_member_stats
  add column if not exists adult_confirmed_at        timestamptz,
  add column if not exists adult_confirmation_version text check (adult_confirmation_version is null or adult_confirmation_version ~ '^[a-z0-9_.-]{1,40}$');
alter table public.fetch_member_stats
  drop constraint if exists fetch_member_stats_adult_pair,
  add constraint fetch_member_stats_adult_pair check ((adult_confirmed_at is null) = (adult_confirmation_version is null));

-- Why a member may not take part (null = may).
create or replace function public.fetch_v2_member_problem(p_user uuid) returns text
  language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when s.restricted_at is not null       then 'member_restricted'
    when s.adult_confirmed_at is null       then 'age_confirmation_required'
  end
  from (select 1) one left join public.fetch_member_stats s on s.user_id = p_user;
$$;

-- The member confirms, themselves, that they are 18 or over. Recorded once, with the wording version they saw.
create or replace function public.fetch_v2_confirm_adult(p_version text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid();
begin
  perform public.fetch_v2_require();
  if p_version is null or p_version !~ '^[a-z0-9_.-]{1,40}$' then return public.fetch_v2_refuse('invalid_request'); end if;
  insert into public.fetch_member_stats (user_id) values (v_uid) on conflict (user_id) do nothing;
  update public.fetch_member_stats set adult_confirmed_at = coalesce(adult_confirmed_at, now()),
         adult_confirmation_version = coalesce(adult_confirmation_version, p_version), updated_at = now()
   where user_id = v_uid;
  return jsonb_build_object('ok', true, 'adult_confirmed', true);
end;
$$;

create or replace function public.fetch_v2_eligibility_for(p_user uuid) returns jsonb
  language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'fetch_enabled', public.fetch_v2_enabled_for(p_user),
    'adult_confirmed', coalesce((select adult_confirmed_at is not null from public.fetch_member_stats where user_id = p_user), false),
    'restricted', coalesce((select restricted_at is not null from public.fetch_member_stats where user_id = p_user), false),
    'problem', public.fetch_v2_member_problem(p_user),
    'driver_problem', public.fetch_v2_driver_problem(p_user));
$$;

create or replace function public.fetch_v2_my_eligibility() returns jsonb
  language sql stable security definer set search_path = public, pg_temp
as $$ select public.fetch_v2_eligibility_for(auth.uid()); $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. Which island a coordinate is on
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create table if not exists public.fetch_island_areas (
  id           serial primary key,
  island_group text not null check (island_group in ('bressay', 'whalsay', 'yell', 'unst', 'fetlar', 'out_skerries', 'fair_isle', 'foula', 'papa_stour')),
  min_lat numeric(8, 5) not null, max_lat numeric(8, 5) not null,
  min_lng numeric(8, 5) not null, max_lng numeric(8, 5) not null,
  note text,
  check (min_lat < max_lat and min_lng < max_lng)
);
alter table public.fetch_island_areas enable row level security;
revoke all on public.fetch_island_areas from public, anon, authenticated;
grant all on public.fetch_island_areas to service_role;
drop policy if exists "Fetch island areas: admins" on public.fetch_island_areas;
create policy "Fetch island areas: admins" on public.fetch_island_areas for select to authenticated using (public.is_admin());
grant select on public.fetch_island_areas to authenticated;

-- P0 approximations, checked against the ferry terminals and main settlements in the test suite. Bluemull Sound (Yell/Unst) is at
-- about −0.975°; Bressay Sound at about −1.125°; Yell Sound south of 60.48°N. Burra, Trondra and Muckle Roe are bridged (Mainland).
insert into public.fetch_island_areas (island_group, min_lat, max_lat, min_lng, max_lng, note)
select * from (values
  ('bressay',      60.09000, 60.18500, -1.12500, -1.02000, 'Bressay and Noss'),
  ('whalsay',      60.32000, 60.39000, -1.06000, -0.88000, 'Whalsay'),
  ('out_skerries', 60.40000, 60.45000, -0.82000, -0.70000, 'Out Skerries'),
  ('yell',         60.48000, 60.75000, -1.22000, -0.97500, 'Yell (Ulsta, Mid Yell, Cullivoe, Gutcher)'),
  ('unst',         60.68000, 60.86000, -0.97500, -0.72000, 'Unst (Belmont, Uyeasound, Baltasound, Haroldswick)'),
  ('fetlar',       60.58000, 60.65000, -0.97500, -0.72000, 'Fetlar (Hamars Ness, Houbie)'),
  ('fair_isle',    59.50000, 59.56000, -1.68000, -1.57000, 'Fair Isle'),
  ('foula',        60.10000, 60.17000, -2.12000, -2.00000, 'Foula'),
  ('papa_stour',   60.31000, 60.36000, -1.74000, -1.64000, 'Papa Stour')
) v(island_group, min_lat, max_lat, min_lng, max_lng, note)
where not exists (select 1 from public.fetch_island_areas);

-- null = outside the Shetland service area; otherwise the island, Mainland being everything not inside an island area.
create or replace function public.fetch_v2_island_at(p_lat numeric, p_lng numeric) returns text
  language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when p_lat is null or p_lng is null or p_lat not between 59.45 and 60.90 or p_lng not between -2.20 and -0.65 then null
    else coalesce((select a.island_group from public.fetch_island_areas a
                    where p_lat between a.min_lat and a.max_lat and p_lng between a.min_lng and a.max_lng
                    order by (a.max_lat - a.min_lat) * (a.max_lng - a.min_lng) limit 1), 'mainland')
  end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. The authoritative price, and the terms it freezes
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_price(p_straight_miles numeric, p_size text, p_ferry boolean) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  c          public.delivery_pricing_config;
  v_fixed    text;
  v_bps      text;
  v_fixed_p  integer;
  v_bps_n    integer;
  v_road     numeric;
  v_mileage  integer;
  v_min      integer;
  v_base     integer;
  v_ferry    integer;
  v_service  integer;
  v_total    integer;
begin
  select * into c from public.delivery_pricing_config limit 1;
  if not found then raise exception 'Fetch pricing is not configured'; end if;
  select value into v_fixed from public.admin_config where key = 'fees.fetch.fixed_pence';
  select value into v_bps   from public.admin_config where key = 'fees.fetch.percent_bps';
  v_fixed_p := case when v_fixed ~ '^\s*[0-9]{1,6}\s*$' then btrim(v_fixed)::integer else 150 end;
  v_bps_n   := case when v_bps   ~ '^\s*[0-9]{1,5}\s*$' then btrim(v_bps)::integer   else 0   end;

  v_road    := round(greatest(p_straight_miles, 0) * c.road_correction_factor, 2);
  v_mileage := round(v_road * c.price_per_mile_pence)::integer;
  v_min     := case when p_size = 'bulky' then c.bulky_min_fee_pence else c.min_fee_pence end;
  v_base    := greatest(v_min, v_mileage);
  v_ferry   := case when p_ferry then c.ferry_supplement_pence else 0 end;
  v_service := v_fixed_p + round(v_base * v_bps_n / 10000.0)::integer;
  v_total   := v_base + v_ferry + v_service;

  return jsonb_build_object(
    'pricing_version', 'fetch_v2_p0',
    'price_per_mile_pence', c.price_per_mile_pence, 'road_correction_factor', c.road_correction_factor,
    'min_fee_pence', c.min_fee_pence, 'bulky_min_fee_pence', c.bulky_min_fee_pence, 'size_class', p_size,
    'straight_miles', round(greatest(p_straight_miles, 0), 2), 'road_miles', v_road,
    'mileage_pence', v_mileage, 'min_fee_applied_pence', case when v_mileage < v_min then v_min end,
    'delivery_fee_pence', v_base,
    'ferry_required', coalesce(p_ferry, false), 'ferry_supplement_pence', v_ferry,
    'ferry_pricing_basis', case when p_ferry then 'flat_per_job_v1' end,
    'service_fixed_pence', v_fixed_p, 'service_percent_bps', v_bps_n, 'service_fee_pence', v_service,
    'wait_grace_secs', c.wait_grace_secs, 'wait_period_secs', c.wait_period_secs,
    'wait_period_pence', c.wait_period_pence, 'waiting_max_pence', c.wait_max_pence,
    -- the return leg is the same journey back: same rate and road factor, no minimum, no second service fee or ferry supplement
    'return_per_mile_pence', c.price_per_mile_pence, 'return_road_factor', c.road_correction_factor, 'return_max_pence', v_mileage,
    'total_pence', v_total,
    'max_hold_pence', v_total + c.wait_max_pence + v_mileage);
end;
$$;

-- fetch_v2_price is now the only place the fee configuration is read; Step 3's separate helper would be a second one.
drop function if exists public.fetch_v2_service_fee_pence(integer);

create table if not exists public.fetch_v2_terms (
  request_id              uuid primary key references public.delivery_requests (id) on delete cascade,
  pricing_version         text not null,
  price_per_mile_pence    integer not null check (price_per_mile_pence >= 0),
  road_correction_factor  numeric(4, 2) not null check (road_correction_factor >= 1),
  min_fee_pence           integer not null,
  bulky_min_fee_pence     integer not null,
  size_class              text not null check (size_class in ('small', 'medium', 'large', 'bulky')),
  straight_miles          numeric(8, 2) not null,
  road_miles              numeric(8, 2) not null,
  mileage_pence           integer not null,
  min_fee_applied_pence   integer,
  delivery_fee_pence      integer not null check (delivery_fee_pence >= 0),
  ferry_required          boolean not null,
  ferry_supplement_pence  integer not null check (ferry_supplement_pence >= 0),
  ferry_pricing_basis     text,
  service_fixed_pence     integer not null,
  service_percent_bps     integer not null,
  service_fee_pence       integer not null check (service_fee_pence >= 0),
  wait_grace_secs         integer not null,
  wait_period_secs        integer not null check (wait_period_secs > 0),
  wait_period_pence       integer not null,
  wait_max_pence          integer not null,
  return_per_mile_pence   integer not null,
  return_road_factor      numeric(4, 2) not null,
  return_max_pence        integer not null check (return_max_pence >= 0),
  total_pence             integer not null,
  max_hold_pence          integer not null,
  frozen_at               timestamptz not null default now(),
  check (total_pence = delivery_fee_pence + ferry_supplement_pence + service_fee_pence),
  check (max_hold_pence = total_pence + wait_max_pence + return_max_pence),
  check (ferry_required = (ferry_supplement_pence > 0))
);
alter table public.fetch_v2_terms enable row level security;
revoke all on public.fetch_v2_terms from public, anon, authenticated;
grant select on public.fetch_v2_terms to authenticated;
grant all on public.fetch_v2_terms to service_role;
drop policy if exists "Fetch terms: admins" on public.fetch_v2_terms;
create policy "Fetch terms: admins" on public.fetch_v2_terms for select to authenticated using (public.is_admin());

create or replace function public.tg_fetch_v2_terms_frozen() returns trigger
  language plpgsql set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;   -- only with the job itself (account deletion)
  raise exception 'Fetch terms are frozen when the job is created' using errcode = '42501';
end;
$$;
drop trigger if exists fetch_v2_terms_frozen on public.fetch_v2_terms;
create trigger fetch_v2_terms_frozen before update or delete on public.fetch_v2_terms
  for each row execute function public.tg_fetch_v2_terms_frozen();

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. Resolve where a job is and price it (shared by quote and create)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_resolve_job(p_pickup_region uuid, p_dest_region uuid, p_plat numeric, p_plng numeric,
                                                       p_dlat numeric, p_dlng numeric, p_size text) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_pi text; v_di text; v_pr public.regions; v_dr public.regions; v_supported text[];
begin
  if p_plat is null or p_plng is null or p_dlat is null or p_dlng is null then return public.fetch_v2_refuse('location_unresolved'); end if;
  v_pi := public.fetch_v2_island_at(p_plat, p_plng);
  v_di := public.fetch_v2_island_at(p_dlat, p_dlng);
  if v_pi is null or v_di is null then
    return public.fetch_v2_refuse('outside_service_area', jsonb_build_object('end', case when v_pi is null then 'pickup' else 'destination' end));
  end if;
  select coalesce(array_agg(btrim(x)), '{}') into v_supported
    from unnest(string_to_array(coalesce((select value from public.admin_config where key = 'fetch.ferry.supported_island_groups'),
                                          'mainland,bressay,whalsay,yell,unst,fetlar'), ',')) x;
  if not (v_pi = any (v_supported)) or not (v_di = any (v_supported)) then return public.fetch_v2_refuse('area_not_supported'); end if;
  select * into v_pr from public.regions where id = p_pickup_region;
  select * into v_dr from public.regions where id = p_dest_region;
  if v_pr.id is null or v_dr.id is null then return public.fetch_v2_refuse('invalid_request', jsonb_build_object('field', 'region')); end if;
  if v_pr.island_group is distinct from v_pi or v_dr.island_group is distinct from v_di then
    return public.fetch_v2_refuse('region_mismatch', jsonb_build_object('end', case when v_pr.island_group is distinct from v_pi then 'pickup' else 'destination' end));
  end if;
  if public.fetch_v2_size_rank(p_size) is null then return public.fetch_v2_refuse('invalid_request', jsonb_build_object('field', 'size_class')); end if;
  return jsonb_build_object('ok', true, 'pickup_island_group', v_pi, 'dest_island_group', v_di,
    'terms', public.fetch_v2_price(public.fetch_v2_straight_miles(p_plat, p_plng, p_dlat, p_dlng), p_size, v_pi <> v_di));
end;
$$;

-- The quote a requester sees before committing. Writes nothing.
create or replace function public.fetch_v2_quote(p_user uuid, p jsonb) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_res jsonb; v_problem text; t jsonb;
begin
  perform public.fetch_v2_service_actor(p_user);
  v_problem := public.fetch_v2_member_problem(p_user);
  if v_problem is not null then return public.fetch_v2_refuse(v_problem); end if;
  begin
    v_res := public.fetch_v2_resolve_job((p ->> 'pickup_region_id')::uuid, (p ->> 'destination_region_id')::uuid,
      (p ->> 'pickup_lat')::numeric, (p ->> 'pickup_lng')::numeric, (p ->> 'dest_lat')::numeric, (p ->> 'dest_lng')::numeric, p ->> 'size_class');
  exception when invalid_text_representation then
    return public.fetch_v2_refuse('invalid_request', jsonb_build_object('field', 'format'));
  end;
  if not (v_res ->> 'ok')::boolean then return v_res; end if;
  t := v_res -> 'terms';
  return jsonb_build_object('ok', true, 'pickup_island_group', v_res ->> 'pickup_island_group', 'dest_island_group', v_res ->> 'dest_island_group',
    'terms', t);
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 5. CREATE — now: 18+ and restriction, coordinates decide the island, terms frozen with the job
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_create_request(p_customer uuid, p jsonb) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_key       text := p ->> 'idempotency_key';
  v_existing  public.delivery_requests;
  v_problem   text;
  v_size      text := p ->> 'size_class';
  v_mode      text := coalesce(p ->> 'scheduling_mode', 'asap');
  v_needed    timestamptz;
  v_until     timestamptz;
  v_expires   timestamptz;
  v_pick_region uuid; v_dest_region uuid;
  v_plat numeric; v_plng numeric; v_dlat numeric; v_dlng numeric;
  v_res       jsonb;
  t           jsonb;
  v_id        uuid := gen_random_uuid();
  r           public.delivery_requests;
begin
  perform public.fetch_v2_service_actor(p_customer);
  v_problem := public.fetch_v2_member_problem(p_customer);
  if v_problem is not null then return public.fetch_v2_refuse(v_problem); end if;
  if v_key is null or v_key !~ '^[A-Za-z0-9_-]{8,80}$' then
    return public.fetch_v2_refuse('idempotency_key_required');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('fetch-create:' || p_customer::text || ':' || v_key, 0));
  select * into v_existing from public.delivery_requests where customer_id = p_customer and idempotency_key = v_key;
  if found then   -- a retry after a timeout or a double tap: the same job, the same frozen terms
    return public.fetch_v2_ok(v_existing, jsonb_build_object('already', true,
      'terms', (select to_jsonb(ft) from public.fetch_v2_terms ft where ft.request_id = v_existing.id),
      'needs_item_photo', v_existing.size_class = 'bulky', 'expires_at', v_existing.expires_at));
  end if;

  begin
    v_pick_region := (p ->> 'pickup_region_id')::uuid;
    v_dest_region := (p ->> 'destination_region_id')::uuid;
    v_needed := (p ->> 'needed_by')::timestamptz;
    v_until  := (p ->> 'flexible_until')::timestamptz;
    v_plat := (p ->> 'pickup_lat')::numeric; v_plng := (p ->> 'pickup_lng')::numeric;
    v_dlat := (p ->> 'dest_lat')::numeric;   v_dlng := (p ->> 'dest_lng')::numeric;
  exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format then
    return public.fetch_v2_refuse('invalid_request', jsonb_build_object('field', 'format'));
  end;

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

  v_res := public.fetch_v2_resolve_job(v_pick_region, v_dest_region, v_plat, v_plng, v_dlat, v_dlng, v_size);
  if not (v_res ->> 'ok')::boolean then return v_res; end if;
  t := v_res -> 'terms';

  if v_mode = 'asap' then
    v_needed := null; v_until := null;
    v_expires := now() + interval '24 hours';
  elsif v_mode = 'by' then
    if v_needed is null or v_needed < now() + interval '30 minutes' or v_needed > now() + interval '7 days' then
      return public.fetch_v2_refuse('invalid_request', jsonb_build_object('field', 'needed_by'));
    end if;
    v_until := null; v_expires := v_needed;
  elsif v_mode = 'flexible' then
    if v_until is null or v_until < now() + interval '1 hour' or v_until > now() + interval '7 days' then
      return public.fetch_v2_refuse('invalid_request', jsonb_build_object('field', 'flexible_until'));
    end if;
    v_needed := null; v_expires := v_until;
  else
    return public.fetch_v2_refuse('invalid_request', jsonb_build_object('field', 'scheduling_mode'));
  end if;

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
      btrim(p ->> 'pickup_name'), btrim(p ->> 'pickup_location'), nullif(btrim(p ->> 'pickup_notes'), ''), v_pick_region,
      nullif(btrim(p ->> 'pickup_area'), ''), v_plat, v_plng, v_res ->> 'pickup_island_group',
      btrim(p ->> 'destination_address'), nullif(btrim(p ->> 'delivery_notes'), ''), v_dest_region,
      nullif(btrim(p ->> 'destination_area'), ''), v_dlat, v_dlng, v_res ->> 'dest_island_group',
      nullif(btrim(p ->> 'contact_phone'), ''), coalesce((p ->> 'share_phone_with_driver')::boolean, false),
      coalesce((p ->> 'safe_place_allowed')::boolean, false), nullif(btrim(p ->> 'safe_place_note'), ''),
      coalesce((p ->> 'already_paid')::boolean, false), coalesce((p ->> 'liability_acknowledged')::boolean, false),
      v_mode, v_needed, v_until, v_expires,
      (t ->> 'ferry_required')::boolean, (t ->> 'ferry_supplement_pence')::integer, t ->> 'ferry_pricing_basis',
      (t ->> 'delivery_fee_pence')::integer, (t ->> 'total_pence')::integer,
      (t ->> 'min_fee_applied_pence')::integer, (t ->> 'return_max_pence')::integer)
    returning * into r;

    insert into public.fetch_v2_terms (request_id, pricing_version, price_per_mile_pence, road_correction_factor, min_fee_pence,
      bulky_min_fee_pence, size_class, straight_miles, road_miles, mileage_pence, min_fee_applied_pence, delivery_fee_pence,
      ferry_required, ferry_supplement_pence, ferry_pricing_basis, service_fixed_pence, service_percent_bps, service_fee_pence,
      wait_grace_secs, wait_period_secs, wait_period_pence, wait_max_pence, return_per_mile_pence, return_road_factor, return_max_pence,
      total_pence, max_hold_pence)
    values (r.id, t ->> 'pricing_version', (t ->> 'price_per_mile_pence')::integer, (t ->> 'road_correction_factor')::numeric,
      (t ->> 'min_fee_pence')::integer, (t ->> 'bulky_min_fee_pence')::integer, t ->> 'size_class', (t ->> 'straight_miles')::numeric,
      (t ->> 'road_miles')::numeric, (t ->> 'mileage_pence')::integer, (t ->> 'min_fee_applied_pence')::integer,
      (t ->> 'delivery_fee_pence')::integer, (t ->> 'ferry_required')::boolean, (t ->> 'ferry_supplement_pence')::integer,
      t ->> 'ferry_pricing_basis', (t ->> 'service_fixed_pence')::integer, (t ->> 'service_percent_bps')::integer,
      (t ->> 'service_fee_pence')::integer, (t ->> 'wait_grace_secs')::integer, (t ->> 'wait_period_secs')::integer,
      (t ->> 'wait_period_pence')::integer, (t ->> 'waiting_max_pence')::integer, (t ->> 'return_per_mile_pence')::integer,
      (t ->> 'return_road_factor')::numeric, (t ->> 'return_max_pence')::integer, (t ->> 'total_pence')::integer,
      (t ->> 'max_hold_pence')::integer);
  exception
    when check_violation or not_null_violation or invalid_text_representation or datetime_field_overflow or invalid_parameter_value then
      return public.fetch_v2_refuse('invalid_request', jsonb_build_object('detail', sqlerrm));
  end;

  perform public.fetch_v2_bump_member(p_customer, 'requests_created');
  perform public.fetch_v2_log(r.id, p_customer, 'requester', 'created', null, 'pending', null, null,
    jsonb_build_object('size_class', r.size_class, 'ferry_required', r.ferry_required, 'total_pence', r.total_fee_pence,
                       'pricing_version', t ->> 'pricing_version'));

  return public.fetch_v2_ok(r, jsonb_build_object('already', false, 'terms', t,
    'needs_item_photo', r.size_class = 'bulky', 'expires_at', r.expires_at));
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 6. CLAIM, RETURN and RUNS read the frozen terms; drivers must be adults too
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
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

create or replace function public.fetch_v2_resolve_return(p_admin uuid, p_request uuid, p_outcome text, p_fault text,
                                                          p_override_capture_pence integer default null, p_reason text default null) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r           public.delivery_requests;
  t           public.fetch_v2_terms;
  v_miles     numeric := 0;
  v_fee       integer := 0;
  v_computed  integer;
  v_capture   integer;
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
  select * into t from public.fetch_v2_terms where request_id = r.id;
  if t.request_id is null then return public.fetch_v2_refuse('terms_missing'); end if;

  -- FROZEN: the return leg is priced at the rate and road factor agreed when the job was created, capped at the disclosed maximum.
  if p_outcome = 'returned_to_sender' then
    v_miles := round(public.fetch_v2_straight_miles(r.dest_lat, r.dest_lng, r.pickup_lat, r.pickup_lng) * t.return_road_factor, 2);
    v_fee   := least(round(v_miles * t.return_per_mile_pence)::integer, t.return_max_pence);
  end if;
  v_computed := case p_fault
    when 'not_driver' then t.total_pence + coalesce(r.waiting_fee_pence, 0) + v_fee
    when 'driver'     then 0
  end;
  if v_override then
    if p_override_capture_pence < 0 or p_override_capture_pence > t.max_hold_pence then return public.fetch_v2_refuse('override_out_of_range'); end if;
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
                       'return_per_mile_pence', t.return_per_mile_pence, 'computed_capture_pence', v_computed,
                       'capture_pence', v_capture, 'override', v_override, 'pricing_version', t.pricing_version));
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
  v_problem := coalesce(public.fetch_v2_member_problem(v_uid), public.fetch_v2_driver_problem(v_uid));
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

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 7. Paygate: holds frozen from the job's terms, and clean replacement after a release
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- Step 5's fetch-accept calls this before creating the PaymentIntent. Amounts come from fetch_v2_terms; nothing is passed in.
-- The generation continues after any retired hold, so the Stripe idempotency key (fetch-auth-<id>[-g<n>]) is never reused.
create or replace function public.fetch_v2_claim_authorisation(p_driver uuid, p_request uuid)
  returns table (outcome text, status text, stripe_payment_intent_id text, generation integer, amount_pence integer, idempotency_key text)
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r      public.delivery_requests;
  t      public.fetch_v2_terms;
  c      record;
  v_gen  integer;
begin
  perform public.fetch_v2_service_actor(p_driver);
  r := public.fetch_v2_lock(p_request);
  if r.driver_id is distinct from p_driver or r.status <> 'matched' then
    raise exception 'Fetch request not found' using errcode = 'P0002';
  end if;
  select * into t from public.fetch_v2_terms where request_id = r.id;
  if t.request_id is null then raise exception 'Fetch terms missing for %', r.id; end if;

  select * into c from public.claim_fetch_authorisation(
    r.id, r.customer_id, p_driver, t.max_hold_pence,
    t.delivery_fee_pence + t.ferry_supplement_pence,      -- the driver's part: delivery fee and ferry supplement, whole
    t.service_fee_pence,                                 -- OneShetland's part: the application fee
    t.wait_grace_secs, t.wait_period_secs, t.wait_period_pence, t.wait_max_pence);

  if c.outcome = 'claimed' then
    select coalesce(max(g.generation), 0) + 1 into v_gen from public.fetch_authorisation_generations g where g.delivery_request_id = r.id;
    update public.fetch_authorisation_attempts a set authorisation_generation = v_gen where a.delivery_request_id = r.id;
  end if;
  select a.authorisation_generation into v_gen from public.fetch_authorisation_attempts a where a.delivery_request_id = r.id;

  return query select c.outcome, c.status, c.stripe_payment_intent_id, v_gen, t.max_hold_pence,
    case when coalesce(v_gen, 1) <= 1 then 'fetch-auth-' || r.id::text else 'fetch-auth-' || r.id::text || '-g' || v_gen end;
end;
$$;

-- After a release (or a cancellation) and AFTER Step 5 has voided the PaymentIntent at Stripe and settled the attempt 'terminal':
-- archive the hold as a generation and remove it, so the next driver's hold is a new claim — never a reuse.
create or replace function public.fetch_v2_retire_authorisation(p_request uuid) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r   public.delivery_requests;
  a   public.fetch_authorisation_attempts;
begin
  r := public.fetch_v2_lock(p_request);
  select * into a from public.fetch_authorisation_attempts where delivery_request_id = r.id for update;
  if not found then return jsonb_build_object('ok', true, 'already', true); end if;
  if r.status not in ('pending', 'cancelled', 'expired') then return public.fetch_v2_refuse('job_still_assigned'); end if;
  if a.status = 'captured' or a.capture_state = 'captured' then return public.fetch_v2_refuse('hold_already_captured'); end if;
  if a.stripe_payment_intent_id is not null and a.status <> 'terminal' then return public.fetch_v2_refuse('hold_still_live'); end if;

  insert into public.fetch_authorisation_generations
    (delivery_request_id, generation, stripe_payment_intent_id, status, amount_pence,
     base_fee_pence, service_fee_pence, wait_grace_secs, wait_period_secs,
     wait_period_pence, wait_max_pence, authorisation_expires_at, hold_state, hold_detail)
  values
    (a.delivery_request_id, coalesce(a.authorisation_generation, 1), a.stripe_payment_intent_id, a.status, a.amount_pence,
     a.base_fee_pence, a.service_fee_pence, a.wait_grace_secs, a.wait_period_secs,
     a.wait_period_pence, a.wait_max_pence, a.authorisation_expires_at, a.hold_state, a.hold_detail)
  on conflict (delivery_request_id, generation) do nothing;
  delete from public.fetch_authorisation_attempts where delivery_request_id = r.id;
  perform public.fetch_v2_log(r.id, null, 'system', 'authorisation_retired', r.status, r.status, null, null,
    jsonb_build_object('generation', coalesce(a.authorisation_generation, 1)));
  return jsonb_build_object('ok', true, 'already', false, 'retired_generation', coalesce(a.authorisation_generation, 1));
end;
$$;

-- The capture total: unchanged for v1; for a v2 return, the amount the resolution decided.
create or replace function public.fetch_capture_total_pence(p_request uuid)
  returns table (total_pence integer, authorised_pence integer, terms_frozen boolean)
  language plpgsql stable set search_path = public
as $$
declare a public.fetch_authorisation_attempts%rowtype; v_base integer; v_svc integer; d public.delivery_requests;
begin
  select * into a from public.fetch_authorisation_attempts where delivery_request_id = p_request;
  select * into d from public.delivery_requests where id = p_request;
  if d.fetch_version = 2 and d.status = 'returned' then
    return query select d.resolution_capture_pence, a.amount_pence, true;
    return;
  end if;
  v_base := coalesce(a.base_fee_pence, d.base_fee_pence, 0);
  v_svc := a.service_fee_pence;   -- null on legacy rows; the caller falls back
  return query select
    (v_base + coalesce(v_svc, 0) + public.fetch_waiting_fee_pence(p_request))::integer,
    a.amount_pence,
    (a.service_fee_pence is not null and a.wait_max_pence is not null);
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 8. Rate limits for the two edge functions (Google Geocoding is billed per call)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
insert into public.rate_limit_policies (action, window_seconds, max_count, note) values
  ('fetch_v2_quote',      3600,  40, 'Fetch v2 quotes: two server geocodes each'),
  ('fetch_v2_quote_day',  86400, 200, 'Fetch v2 quotes: daily ceiling'),
  ('fetch_v2_create',     3600,  10, 'Fetch v2 requests created per member per hour'),
  ('fetch_v2_create_day', 86400, 30, 'Fetch v2 requests created per member per day')
on conflict (action) do nothing;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 9. Grants
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
revoke all on function public.fetch_v2_member_problem(uuid), public.fetch_v2_confirm_adult(text), public.fetch_v2_eligibility_for(uuid),
  public.fetch_v2_my_eligibility(), public.fetch_v2_island_at(numeric, numeric),
  public.fetch_v2_resolve_job(uuid, uuid, numeric, numeric, numeric, numeric, text), public.fetch_v2_quote(uuid, jsonb),
  public.fetch_v2_claim_authorisation(uuid, uuid), public.fetch_v2_retire_authorisation(uuid), public.tg_fetch_v2_terms_frozen()
from public, anon, authenticated;
grant execute on function public.fetch_v2_confirm_adult(text), public.fetch_v2_my_eligibility() to authenticated, service_role;
grant execute on function public.fetch_v2_eligibility_for(uuid), public.fetch_v2_quote(uuid, jsonb), public.fetch_v2_island_at(numeric, numeric),
  public.fetch_v2_claim_authorisation(uuid, uuid), public.fetch_v2_retire_authorisation(uuid) to service_role;
-- create_request / claim / resolve_return / create_run keep their Step 3 grants (CREATE OR REPLACE preserves them).

do $$
begin
  if has_function_privilege('authenticated', 'public.fetch_v2_quote(uuid, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.fetch_v2_claim_authorisation(uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.fetch_v2_create_request(uuid, jsonb)', 'execute') then
    raise exception 'a Fetch service function is reachable by a client';
  end if;
  if public.fetch_v2_island_at(60.155, -1.145) <> 'mainland' or public.fetch_v2_island_at(60.600, -1.060) <> 'yell'
     or public.fetch_v2_island_at(51.5, -0.12) is not null then
    raise exception 'island derivation self-check failed';
  end if;
end $$;

commit;
