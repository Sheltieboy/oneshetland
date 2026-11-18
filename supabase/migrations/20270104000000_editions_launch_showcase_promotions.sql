-- OneShetland Editions: the Launch / Showcase rate card, promotion rights, and the promotion tables (part 1 of 2: catalogue, configuration, tables).
-- Authoritative spec: docs/editions/WEB_APP_BUILD_CONTRACT.md (web repo). Darren's corrections govern:
--   * No artificial restrictions: Launch and Showcase carry ALL five features and no member cap. Showcase differs only by promotion.
--   * Promotions never extend the 12-month publishing entitlement (enforced in part 2: a promotion window must lie inside the live publish window).
--   * Same prices for everyone: Business-run and Hub-run Editions see identical rows. The audience column is DORMANT (kept, nothing reads it).
--   * Everything ships INACTIVE; payments stay behind the existing switch. No VAT is computed; one configurable note (editions.commerce.vat_note) is stored.
-- Expand-only. Rollback: supabase/rollbacks/20270104000000_editions_launch_showcase_promotions.rollback.sql (run AFTER the part-2 rollback).

-- ── catalogue columns ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
alter table public.edition_packages add column if not exists kind text not null default 'package';
alter table public.edition_packages add column if not exists grants jsonb not null default '{}'::jsonb;
alter table public.edition_packages add column if not exists retired_at timestamptz;
alter table public.edition_packages alter column duration_days drop not null;

-- grants: {"discovery_days": n, "homepage_days": n, "grouped": bool}; whole days, 0..400; "grouped" needs both kinds
create or replace function public.edition_package_grants_ok(g jsonb) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select case when g is null or jsonb_typeof(g) <> 'object' then false
    else (g - 'discovery_days' - 'homepage_days' - 'grouped') = '{}'::jsonb
      and (not (g ? 'discovery_days') or case when jsonb_typeof(g -> 'discovery_days') = 'number' and (g ->> 'discovery_days') ~ '^[0-9]{1,3}$' then (g ->> 'discovery_days')::int <= 400 else false end)
      and (not (g ? 'homepage_days') or case when jsonb_typeof(g -> 'homepage_days') = 'number' and (g ->> 'homepage_days') ~ '^[0-9]{1,3}$' then (g ->> 'homepage_days')::int <= 400 else false end)
      and (not (g ? 'grouped') or jsonb_typeof(g -> 'grouped') = 'boolean')
      and ((g -> 'grouped') is distinct from 'true'::jsonb
           or (case when (g ->> 'discovery_days') ~ '^[0-9]{1,3}$' then (g ->> 'discovery_days')::int > 0 else false end
               and case when (g ->> 'homepage_days') ~ '^[0-9]{1,3}$' then (g ->> 'homepage_days')::int > 0 else false end))
  end
$$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'edition_packages_kind_check') then
    alter table public.edition_packages add constraint edition_packages_kind_check check (kind in ('package', 'promotion'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'edition_packages_grants_ok') then
    alter table public.edition_packages add constraint edition_packages_grants_ok check (public.edition_package_grants_ok(grants));
  end if;
  -- a package always has a publish window; a promotion never has one (it can never extend publishing)
  if not exists (select 1 from pg_constraint where conname = 'edition_packages_duration_by_kind') then
    alter table public.edition_packages add constraint edition_packages_duration_by_kind check ((kind = 'package' and duration_days is not null) or (kind = 'promotion' and duration_days is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'edition_packages_promotion_shape') then
    alter table public.edition_packages add constraint edition_packages_promotion_shape check (kind <> 'promotion' or
      (features = '[]'::jsonb and max_members is null and coalesce((grants ->> 'discovery_days')::int, 0) + coalesce((grants ->> 'homepage_days')::int, 0) > 0));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'edition_packages_retired_inactive') then
    alter table public.edition_packages add constraint edition_packages_retired_inactive check (retired_at is null or not active);
  end if;
end $$;

-- ── the rate card (INACTIVE; amounts are what the customer is charged, in pence; VAT is not assumed or computed) ──────────────────────────────────
insert into public.edition_packages (code, name, description, price_pence, duration_days, features, max_members, active, sort, audience, kind, grants) values
  ('launch', 'Launch', 'Publish your Edition for 12 months with everything you need to run it: programme, sponsors, partners, updates, memberships, participation fees, offline records, CSV export and payments collection.',
    24900, 365, '["collect_payments","memberships","participation_fees","offline_records","csv_export"]', null, false, 10, 'any', 'package', '{}'),
  ('showcase', 'Showcase', 'Everything in Launch, plus one promotion campaign: 42 days of enhanced discovery and 7 days on the homepage (the homepage days fall inside the discovery period).',
    49900, 365, '["collect_payments","memberships","participation_fees","offline_records","csv_export"]', null, false, 20, 'any', 'package', '{"discovery_days":42,"homepage_days":7,"grouped":true}'),
  ('promo_discovery_2w', 'Two weeks of enhanced discovery', 'Extra visibility for 14 days where people browse Editions. You choose the dates, subject to availability.', 7900, null, '[]', null, false, 30, 'any', 'promotion', '{"discovery_days":14}'),
  ('promo_discovery_6w', 'Six weeks of enhanced discovery', 'Extra visibility for 42 days where people browse Editions. You choose the dates, subject to availability.', 17900, null, '[]', null, false, 40, 'any', 'promotion', '{"discovery_days":42}'),
  ('promo_homepage_7d', 'Seven more days on the homepage', 'Seven days in the Editions strip on the OneShetland homepage. You choose the dates, subject to availability.', 14900, null, '[]', null, false, 50, 'any', 'promotion', '{"homepage_days":7}'),
  ('promo_campaign_full', 'Complete additional campaign', '42 days of enhanced discovery and 7 days on the homepage (the homepage days fall inside the discovery period). You choose the dates, subject to availability.', 24900, null, '[]', null, false, 60, 'any', 'promotion', '{"discovery_days":42,"homepage_days":7,"grouped":true}')
on conflict (code) do nothing;

-- the five earlier draft rows are RETIRED: inactive, stamped, never deleted (orders may reference them), never reactivated by the admin form
update public.edition_packages set active = false, retired_at = coalesce(retired_at, now()), updated_at = now()
 where code in ('publish_single', 'publish_collect', 'publish_full', 'community_publish', 'community_collect') and retired_at is null;

-- every signed-in user reads active rows; administrators read everything (the audience no longer hides anything: same rows and prices for Businesses and Hubs)
drop policy if exists "edition_packages read" on public.edition_packages;
create policy "edition_packages read" on public.edition_packages for select to authenticated using (public.is_admin() or active);

-- a retired row can never come back; Launch and Showcase never lose a feature or gain a cap; a promotion has no publish window
drop function if exists public.admin_upsert_edition_package(text, text, text, integer, integer, jsonb, integer, boolean, integer, boolean);
create or replace function public.admin_upsert_edition_package(p_code text, p_name text, p_description text, p_price integer, p_days integer, p_features jsonb, p_max_members integer, p_active boolean, p_sort integer,
  p_is_free boolean default false, p_kind text default 'package', p_grants jsonb default '{}'::jsonb) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; old public.edition_packages%rowtype; v_kind text := coalesce(p_kind, 'package'); v_grants jsonb := coalesce(p_grants, '{}'::jsonb); v_features jsonb := coalesce(p_features, '[]'::jsonb);
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if jsonb_typeof(v_features) <> 'array' or exists (select 1 from jsonb_array_elements_text(v_features) f where f not in ('collect_payments', 'memberships', 'offline_records', 'participation_fees', 'csv_export')) then
    raise exception 'unknown feature in package' using errcode = '22023';
  end if;
  if v_kind not in ('package', 'promotion') then raise exception 'kind must be package or promotion' using errcode = '22023', hint = 'bad_kind'; end if;
  if not public.edition_package_grants_ok(v_grants) then raise exception 'grants must be {"discovery_days":n,"homepage_days":n,"grouped":true|false} with whole days' using errcode = '22023', hint = 'bad_grants'; end if;
  if coalesce(p_is_free, false) and p_price <> 0 then raise exception 'a free package costs nothing' using errcode = '23514', hint = 'free_priced'; end if;
  if coalesce(p_active, false) and p_price = 0 and not coalesce(p_is_free, false) then raise exception 'a package at £0 must be marked free on purpose before it can be offered' using errcode = '23514', hint = 'zero_not_free'; end if;
  if v_kind = 'promotion' then
    if p_days is not null then raise exception 'a promotion has no publishing period: it can never extend publishing' using errcode = '23514', hint = 'promotion_days'; end if;
    if v_features <> '[]'::jsonb or p_max_members is not null then raise exception 'a promotion grants promotion days only' using errcode = '23514', hint = 'promotion_features'; end if;
    if coalesce((v_grants ->> 'discovery_days')::int, 0) + coalesce((v_grants ->> 'homepage_days')::int, 0) <= 0 then raise exception 'a promotion must grant at least one day' using errcode = '23514', hint = 'promotion_empty'; end if;
  else
    if p_days is null or p_days not between 1 and 800 then raise exception 'a package needs a publishing period of 1 to 800 days' using errcode = '23514', hint = 'package_days'; end if;
  end if;
  select * into old from public.edition_packages where code = p_code for update;
  if found then
    if old.retired_at is not null then raise exception 'that package is retired and cannot be changed or switched back on' using errcode = '23514', hint = 'retired_package'; end if;
    if old.kind <> v_kind then raise exception 'a package cannot change kind' using errcode = '23514', hint = 'kind_change'; end if;
  end if;
  if p_code in ('launch', 'showcase') and (p_max_members is not null or (select count(distinct f) from jsonb_array_elements_text(v_features) f) <> 5) then
    raise exception 'Launch and Showcase include every feature with no member cap' using errcode = '23514', hint = 'no_restrictions';
  end if;
  insert into public.edition_packages (code, name, description, price_pence, duration_days, features, max_members, active, sort, is_free, kind, grants)
  values (p_code, p_name, p_description, p_price, p_days, v_features, p_max_members, coalesce(p_active, false), coalesce(p_sort, 0), coalesce(p_is_free, false), v_kind, v_grants)
  on conflict (code) do update set name = excluded.name, description = excluded.description, price_pence = excluded.price_pence, duration_days = excluded.duration_days, features = excluded.features,
    max_members = excluded.max_members, active = excluded.active, sort = excluded.sort, is_free = excluded.is_free, grants = excluded.grants, updated_at = now() returning id into v_id;
  perform public.edition_audit(null, null, 'package_upserted', jsonb_build_object('code', p_code, 'kind', v_kind, 'price', p_price, 'active', p_active, 'free', coalesce(p_is_free, false), 'grants', v_grants));
  return v_id;
end $$;

-- What an organiser may buy: every active row, identical for Business-run and Hub-run organisers (audience is dormant). Includes kind and grants.
drop function if exists public.edition_available_packages(uuid);
create or replace function public.edition_available_packages(p_org uuid) returns table (id uuid, code text, name text, description text, price_pence integer, duration_days integer, features jsonb, max_members integer, audience text, sort integer, is_free boolean, kind text, grants jsonb)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not (public.edition_org_can(p_org, 'editor') or public.edition_staff()) then raise exception 'not permitted' using errcode = '42501'; end if;
  return query select k.id, k.code, k.name, k.description, k.price_pence, k.duration_days, k.features, k.max_members, k.audience, k.sort, k.is_free, k.kind, k.grants
                 from public.edition_packages k where k.active and k.retired_at is null order by k.sort, k.price_pence;
end $$;

-- the audience can no longer make a package dearer or exclusive: only 'any' may be set (Community pricing is retired)
create or replace function public.admin_set_edition_package_audience(p_code text, p_audience text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if p_audience not in ('any', 'hub') then raise exception 'audience must be any or hub' using errcode = '22023'; end if;
  if p_audience = 'hub' then raise exception 'packages cost the same for Businesses and Hubs: a Hub-only audience is not available' using errcode = '23514', hint = 'same_prices'; end if;
  update public.edition_packages set audience = p_audience, updated_at = now() where code = p_code and retired_at is null;
  if not found then raise exception 'no such package' using errcode = 'P0002'; end if;
  perform public.edition_audit(null, null, 'package_audience_set', jsonb_build_object('code', p_code, 'audience', p_audience));
end $$;

-- ── configuration: the new keys join the existing validator (nothing else may be written through it) ──────────────────────────────────────────────
create or replace function public.admin_set_edition_commerce_config(p_key text, p_value text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ok boolean;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  v_ok := case
    when p_key = 'editions.commerce.enabled' then p_value in ('true', 'false')
    when p_key in ('editions.commerce.participation.fee_percent', 'editions.commerce.membership.fee_percent') then p_value ~ '^[0-9]{1,2}(\.[0-9]{1,2})?$' and p_value::numeric <= 50
    when p_key in ('editions.commerce.participation.fee_fixed_pence', 'editions.commerce.membership.fee_fixed_pence', 'editions.commerce.participation.fee_min_pence', 'editions.commerce.membership.fee_min_pence')
      then p_value ~ '^[0-9]{1,5}$'
    when p_key in ('editions.commerce.participation.fee_cap_pence', 'editions.commerce.membership.fee_cap_pence') then p_value ~ '^[0-9]{1,7}$' or p_value = ''
    when p_key = 'editions.commerce.fee_payer' then p_value in ('organiser', 'business')
    when p_key = 'editions.commerce.grace_days' then p_value ~ '^[0-9]{1,2}$' and p_value::int <= 60
    when p_key = 'editions.commerce.max_charge_pence' then p_value ~ '^[0-9]{3,7}$'
    when p_key = 'editions.commerce.refund_application_fee' then p_value in ('true', 'false')
    when p_key = 'editions.commerce.vat_rate_percent' then p_value ~ '^[0-9]{1,2}(\.[0-9]{1,2})?$' and p_value::numeric <= 30
    when p_key = 'editions.commerce.terms_version' then p_value ~ '^[A-Za-z0-9._-]{1,20}$'
    -- promotions: whole numbers inside sane bounds
    when p_key in ('editions.promo.homepage_capacity', 'editions.promo.discovery_capacity') then p_value ~ '^[0-9]{1,2}$' and p_value::int between 1 and 50
    when p_key in ('editions.promo.homepage_visible', 'editions.promo.discovery_visible') then p_value ~ '^[0-9]{1,2}$' and p_value::int between 1 and 12
    when p_key = 'editions.promo.lead_days' then p_value ~ '^[0-9]{1,2}$' and p_value::int <= 30
    when p_key = 'editions.promo.horizon_days' then p_value ~ '^[0-9]{1,3}$' and p_value::int between 1 and 730
    when p_key = 'editions.promo.homepage_days_per_90' then p_value ~ '^[0-9]{1,2}$' and p_value::int <= 90
    when p_key = 'editions.commerce.renewal_window_days' then p_value ~ '^[0-9]{1,3}$' and p_value::int <= 365
    when p_key = 'editions.promo.reschedule_notice_days' then p_value ~ '^[0-9]{1,2}$' and p_value::int <= 60
    -- the one note shown beside a price: plain text only (no markup, no control characters), may be empty
    when p_key = 'editions.commerce.vat_note' then char_length(p_value) <= 300 and p_value !~ '[<>[:cntrl:]]'
    when p_key in ('editions.app.handoff_ios', 'editions.app.handoff_android') then p_value in ('on', 'off')
    else false end;
  if not coalesce(v_ok, false) then raise exception 'that setting or value is not allowed' using errcode = '22023'; end if;
  insert into public.admin_config (key, value, category) values (p_key, p_value, 'editions') on conflict (key) do update set value = excluded.value;
  perform public.edition_audit(null, null, 'commerce_config_set', jsonb_build_object('key', p_key, 'value', p_value));
end $$;

-- an integer setting that can never be garbage: anything unparseable falls back to the default
create or replace function public.edition_promo_cfg_int(p_key text, p_default integer) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(substring(public.edition_commerce_cfg(p_key, p_default::text) from '^[0-9]{1,6}$')::integer, p_default)
$$;

-- today in the platform's own calendar (whole days, Europe/London)
create or replace function public.edition_promo_today() returns date
language sql stable set search_path = public, pg_temp as $$ select (now() at time zone 'Europe/London')::date $$;

-- the effective settings the web and the apps read (defaults applied): signed-in only
create or replace function public.edition_promo_settings() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = '42501'; end if;
  return jsonb_build_object(
    'homepage_capacity', public.edition_promo_cfg_int('editions.promo.homepage_capacity', 3), 'discovery_capacity', public.edition_promo_cfg_int('editions.promo.discovery_capacity', 6),
    'homepage_visible', public.edition_promo_cfg_int('editions.promo.homepage_visible', 3), 'discovery_visible', public.edition_promo_cfg_int('editions.promo.discovery_visible', 4),
    'lead_days', public.edition_promo_cfg_int('editions.promo.lead_days', 2), 'horizon_days', public.edition_promo_cfg_int('editions.promo.horizon_days', 180),
    'homepage_days_per_90', public.edition_promo_cfg_int('editions.promo.homepage_days_per_90', 14), 'reschedule_notice_days', public.edition_promo_cfg_int('editions.promo.reschedule_notice_days', 3), 'renewal_window_days', public.edition_promo_cfg_int('editions.commerce.renewal_window_days', 30),
    'vat_note', public.edition_commerce_cfg('editions.commerce.vat_note', ''),
    'handoff_ios', public.edition_commerce_cfg('editions.app.handoff_ios', 'off') = 'on', 'handoff_android', public.edition_commerce_cfg('editions.app.handoff_android', 'off') = 'on');
end $$;

-- ── promotion tables ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- A RIGHT is one purchased or granted entitlement to promotion days (one row per kind). A BOOKING places a right on dates. DAILY holds indicative counters.
create table if not exists public.edition_promo_rights (
  id           uuid primary key default gen_random_uuid(),
  edition_id   uuid not null references public.editions (id) on delete restrict,
  organiser_id uuid not null references public.edition_organisers (id) on delete restrict,
  order_id     uuid references public.edition_orders (id) on delete restrict,
  source       text not null check (source in ('order', 'admin_grant')),
  kind         text not null check (kind in ('discovery', 'homepage')),
  days         integer not null check (days between 1 and 400),
  group_id     uuid,
  granted_by   uuid references auth.users (id) on delete set null,
  reason       text,
  created_at   timestamptz not null default now(),
  voided_at    timestamptz,
  void_reason  text,
  constraint edition_promo_rights_source check ((source = 'order' and order_id is not null) or (source = 'admin_grant' and order_id is null and granted_by is not null and char_length(btrim(coalesce(reason, ''))) >= 5))
);
create unique index if not exists edition_promo_rights_order_kind_uq on public.edition_promo_rights (order_id, kind) where order_id is not null;
create index if not exists edition_promo_rights_edition_idx on public.edition_promo_rights (edition_id);
create index if not exists edition_promo_rights_group_idx on public.edition_promo_rights (group_id) where group_id is not null;

create table if not exists public.edition_promo_bookings (
  id            uuid primary key default gen_random_uuid(),
  edition_id    uuid not null references public.editions (id) on delete restrict,
  organiser_id  uuid not null references public.edition_organisers (id) on delete restrict,
  right_id      uuid not null references public.edition_promo_rights (id) on delete restrict,
  kind          text not null check (kind in ('discovery', 'homepage')),
  starts_on     date not null,
  ends_on       date not null,
  status        text not null default 'booked' check (status in ('booked', 'cancelled')),
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  cancelled_at  timestamptz,
  cancelled_by  uuid references auth.users (id) on delete set null,
  cancel_reason text,
  constraint edition_promo_bookings_window check (ends_on >= starts_on),
  constraint edition_promo_bookings_cancel_stamp check ((status = 'cancelled') = (cancelled_at is not null))
);
-- a right is booked at most once at a time (a cancelled booking frees the right; its row stays as history)
create unique index if not exists edition_promo_bookings_right_live_uq on public.edition_promo_bookings (right_id) where status = 'booked';
create index if not exists edition_promo_bookings_live_idx on public.edition_promo_bookings (kind, starts_on, ends_on) where status = 'booked';
create index if not exists edition_promo_bookings_org_idx on public.edition_promo_bookings (organiser_id, kind) where status = 'booked';
create index if not exists edition_promo_bookings_edition_idx on public.edition_promo_bookings (edition_id);

create table if not exists public.edition_promo_daily (
  edition_id uuid not null references public.editions (id) on delete cascade,
  booking_id uuid references public.edition_promo_bookings (id) on delete set null,
  day        date not null,
  surface    text not null check (surface in ('home', 'discovery', 'edition_page')),
  metric     text not null check (metric in ('shown', 'tap', 'view')),
  n          integer not null default 0 check (n >= 0),
  primary key (edition_id, day, surface, metric)
);

-- anonymous tracking needs a brake: one counter per (Edition, surface, metric, minute). Not readable by anyone.
create table if not exists public.edition_promo_track_rate (
  edition_id uuid not null references public.editions (id) on delete cascade,
  surface    text not null,
  metric     text not null,
  bucket     timestamptz not null,
  n          integer not null default 0,
  primary key (edition_id, surface, metric, bucket)
);

-- rights are append-only except for voiding
create or replace function public.edition_promo_rights_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then raise exception 'promotion rights cannot be deleted' using errcode = '42501'; end if;
  if (to_jsonb(new) - 'voided_at' - 'void_reason') is distinct from (to_jsonb(old) - 'voided_at' - 'void_reason') then raise exception 'promotion rights are append-only (only voiding is allowed)' using errcode = '42501'; end if;
  return new;
end $$;
drop trigger if exists edition_promo_rights_guard on public.edition_promo_rights;
create trigger edition_promo_rights_guard before update or delete on public.edition_promo_rights for each row execute function public.edition_promo_rights_guard();

-- a booking must match its right exactly (kind, Edition, organiser, length) and can only ever change dates or be cancelled
create or replace function public.edition_promo_bookings_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare r public.edition_promo_rights%rowtype;
begin
  if tg_op = 'DELETE' then raise exception 'bookings cannot be deleted' using errcode = '42501'; end if;
  select * into r from public.edition_promo_rights where id = new.right_id;
  if not found or r.kind <> new.kind or r.edition_id <> new.edition_id or r.organiser_id <> new.organiser_id or (new.ends_on - new.starts_on + 1) <> r.days then
    raise exception 'a booking must match its right (same Edition, kind and number of days)' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and (new.right_id <> old.right_id or new.edition_id <> old.edition_id or new.organiser_id <> old.organiser_id or new.kind <> old.kind or new.created_at <> old.created_at or new.created_by is distinct from old.created_by) then
    raise exception 'only the dates and the cancelled state of a booking can change' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.status = 'cancelled' and new.status <> 'cancelled' then raise exception 'a cancelled booking cannot be revived: book the right again' using errcode = '42501'; end if;
  return new;
end $$;
drop trigger if exists edition_promo_bookings_guard on public.edition_promo_bookings;
create trigger edition_promo_bookings_guard before insert or update or delete on public.edition_promo_bookings for each row execute function public.edition_promo_bookings_guard();

-- ── lock down: RLS on, nothing writable by any client, members read their own Edition's rows, administrators read all, the public reads nothing ─────
do $$ declare t text; begin
  foreach t in array array['edition_promo_rights', 'edition_promo_bookings', 'edition_promo_daily', 'edition_promo_track_rate'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;
drop policy if exists "edition_promo_rights read" on public.edition_promo_rights;
drop policy if exists "edition_promo_bookings read" on public.edition_promo_bookings;
drop policy if exists "edition_promo_daily read" on public.edition_promo_daily;
create policy "edition_promo_rights read" on public.edition_promo_rights for select to authenticated using (public.edition_can(edition_id, 'editor') or public.is_admin());
create policy "edition_promo_bookings read" on public.edition_promo_bookings for select to authenticated using (public.edition_can(edition_id, 'editor') or public.is_admin());
create policy "edition_promo_daily read" on public.edition_promo_daily for select to authenticated using (public.edition_can(edition_id, 'editor') or public.is_admin());
grant select on public.edition_promo_rights, public.edition_promo_bookings, public.edition_promo_daily to authenticated;

do $$ declare f text; begin
  foreach f in array array['edition_package_grants_ok(jsonb)', 'admin_upsert_edition_package(text,text,text,integer,integer,jsonb,integer,boolean,integer,boolean,text,jsonb)', 'edition_available_packages(uuid)',
    'admin_set_edition_package_audience(text,text)', 'admin_set_edition_commerce_config(text,text)', 'edition_promo_cfg_int(text,integer)', 'edition_promo_today()', 'edition_promo_settings()',
    'edition_promo_rights_guard()', 'edition_promo_bookings_guard()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['admin_upsert_edition_package(text,text,text,integer,integer,jsonb,integer,boolean,integer,boolean,text,jsonb)', 'edition_available_packages(uuid)', 'admin_set_edition_package_audience(text,text)',
    'admin_set_edition_commerce_config(text,text)', 'edition_promo_settings()'] loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
