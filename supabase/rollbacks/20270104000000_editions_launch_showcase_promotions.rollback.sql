-- Rollback of 20270104000000_editions_launch_showcase_promotions (run AFTER the part-2 rollback). Re-runnable.
-- Promotion rights, bookings and counters are DISCARDED (the tables are dropped). The six rate-card rows are removed unless an order already references them (then they are kept, inactive,
-- and the columns that describe them are kept too so the rows stay valid). The five retired rows are un-retired (they stay inactive: nothing is switched on by a rollback).
drop table if exists public.edition_promo_track_rate;
drop table if exists public.edition_promo_daily;
drop table if exists public.edition_promo_bookings;
drop table if exists public.edition_promo_rights;
drop function if exists public.edition_promo_rights_guard();
drop function if exists public.edition_promo_bookings_guard();
drop function if exists public.edition_promo_settings();
drop function if exists public.edition_promo_today();
drop function if exists public.edition_promo_cfg_int(text, integer);

-- the previous catalogue functions, policy and validator
drop function if exists public.admin_upsert_edition_package(text, text, text, integer, integer, jsonb, integer, boolean, integer, boolean, text, jsonb);
drop function if exists public.edition_available_packages(uuid);
create or replace function public.admin_upsert_edition_package(p_code text, p_name text, p_description text, p_price integer, p_days integer, p_features jsonb, p_max_members integer, p_active boolean, p_sort integer, p_is_free boolean default false) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if jsonb_typeof(coalesce(p_features, '[]'::jsonb)) <> 'array' or exists (select 1 from jsonb_array_elements_text(coalesce(p_features, '[]'::jsonb)) f where f not in ('collect_payments', 'memberships', 'offline_records', 'participation_fees', 'csv_export')) then
    raise exception 'unknown feature in package' using errcode = '22023';
  end if;
  if coalesce(p_is_free, false) and p_price <> 0 then raise exception 'a free package costs nothing' using errcode = '23514', hint = 'free_priced'; end if;
  if coalesce(p_active, false) and p_price = 0 and not coalesce(p_is_free, false) then raise exception 'a package at £0 must be marked free on purpose before it can be offered' using errcode = '23514', hint = 'zero_not_free'; end if;
  insert into public.edition_packages (code, name, description, price_pence, duration_days, features, max_members, active, sort, is_free)
  values (p_code, p_name, p_description, p_price, p_days, coalesce(p_features, '[]'::jsonb), p_max_members, coalesce(p_active, false), p_sort, coalesce(p_is_free, false))
  on conflict (code) do update set name = excluded.name, description = excluded.description, price_pence = excluded.price_pence, duration_days = excluded.duration_days, features = excluded.features,
    max_members = excluded.max_members, active = excluded.active, sort = excluded.sort, is_free = excluded.is_free, updated_at = now() returning id into v_id;
  perform public.edition_audit(null, null, 'package_upserted', jsonb_build_object('code', p_code, 'price', p_price, 'active', p_active, 'free', coalesce(p_is_free, false)));
  return v_id;
end $$;

create or replace function public.edition_available_packages(p_org uuid) returns table (id uuid, code text, name text, description text, price_pence integer, duration_days integer, features jsonb, max_members integer, audience text, sort integer, is_free boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not (public.edition_org_can(p_org, 'editor') or public.edition_staff()) then raise exception 'not permitted' using errcode = '42501'; end if;
  return query select k.id, k.code, k.name, k.description, k.price_pence, k.duration_days, k.features, k.max_members, k.audience, k.sort, k.is_free
                 from public.edition_packages k
                where k.active and (k.audience = 'any' or public.edition_org_is_hub_run(p_org))
                order by k.sort, k.price_pence;
end $$;

create or replace function public.admin_set_edition_package_audience(p_code text, p_audience text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if p_audience not in ('any', 'hub') then raise exception 'audience must be any or hub' using errcode = '22023'; end if;
  update public.edition_packages set audience = p_audience, updated_at = now() where code = p_code;
  if not found then raise exception 'no such package' using errcode = 'P0002'; end if;
  perform public.edition_audit(null, null, 'package_audience_set', jsonb_build_object('code', p_code, 'audience', p_audience));
end $$;

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
    else false end;
  if not coalesce(v_ok, false) then raise exception 'that setting or value is not allowed' using errcode = '22023'; end if;
  insert into public.admin_config (key, value, category) values (p_key, p_value, 'editions') on conflict (key) do update set value = excluded.value;
  perform public.edition_audit(null, null, 'commerce_config_set', jsonb_build_object('key', p_key, 'value', p_value));
end $$;

do $rb$ begin
  if to_regclass('public.edition_packages') is not null then
    drop policy if exists "edition_packages read" on public.edition_packages;
    create policy "edition_packages read" on public.edition_packages for select to authenticated using (public.is_admin() or (active and audience = 'any'));
  end if;
end $rb$;

do $$ declare f text; begin
  foreach f in array array['admin_upsert_edition_package(text,text,text,integer,integer,jsonb,integer,boolean,integer,boolean)', 'edition_available_packages(uuid)', 'admin_set_edition_package_audience(text,text)', 'admin_set_edition_commerce_config(text,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- the rate-card rows (only when nothing references them), then the columns
do $rb$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'edition_packages' and column_name = 'kind') then
    delete from public.edition_packages p where p.code in ('launch', 'showcase', 'promo_discovery_2w', 'promo_discovery_6w', 'promo_homepage_7d', 'promo_campaign_full')
      and not exists (select 1 from public.edition_orders o where o.package_id = p.id);
    if not exists (select 1 from public.edition_packages where kind <> 'package') then
      alter table public.edition_packages drop constraint if exists edition_packages_promotion_shape;
      alter table public.edition_packages drop constraint if exists edition_packages_duration_by_kind;
      alter table public.edition_packages drop constraint if exists edition_packages_retired_inactive;
      alter table public.edition_packages drop constraint if exists edition_packages_grants_ok;
      alter table public.edition_packages drop constraint if exists edition_packages_kind_check;
      if not exists (select 1 from public.edition_packages where duration_days is null) then alter table public.edition_packages alter column duration_days set not null; end if;
      alter table public.edition_packages drop column if exists kind;
      alter table public.edition_packages drop column if exists grants;
      alter table public.edition_packages drop column if exists retired_at;
      drop function if exists public.edition_package_grants_ok(jsonb);
    end if;
  end if;
end $rb$;
