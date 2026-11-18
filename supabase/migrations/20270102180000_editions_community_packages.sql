-- OneShetland Editions 1.1, part 3: a discounted Community Editions package for Hub-run Editions, on the EXISTING packages and entitlements architecture.
--
-- No new payment system and no new money path. A package gains an AUDIENCE: 'any' (everyone, as today) or 'hub' (only an organiser linked to an active Hub may buy it). The order,
-- the fee, the Stripe flow, the entitlement it grants and the refund rules are exactly the existing ones; edition_create_order only gains an eligibility check. Being a Hub, or
-- being linked to one, never grants anything: an Edition still needs a paid package or an administrator's grant. Prices stay placeholders (inactive drafts) until Darren sets them.

alter table public.edition_packages add column if not exists audience text not null default 'any' check (audience in ('any', 'hub'));

-- hub-only packages are not listed to everyone: organisers read the catalogue through edition_available_packages, administrators read the table
drop policy if exists "edition_packages read" on public.edition_packages;
create policy "edition_packages read" on public.edition_packages for select to authenticated using (public.is_admin() or (active and audience = 'any'));

create or replace function public.edition_org_is_hub_run(p_org uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.edition_organisers o join public.hubs h on h.id = o.hub_id where o.id = p_org and h.is_active and o.status <> 'rejected')
$$;

-- what this organiser may actually buy
create or replace function public.edition_available_packages(p_org uuid)
returns table (id uuid, code text, name text, description text, price_pence integer, duration_days integer, features jsonb, max_members integer, audience text, sort integer)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not (public.edition_org_can(p_org, 'editor') or public.edition_staff()) then raise exception 'not permitted' using errcode = '42501'; end if;
  return query select k.id, k.code, k.name, k.description, k.price_pence, k.duration_days, k.features, k.max_members, k.audience, k.sort
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

-- the existing order function, plus the eligibility check (everything else is unchanged)
create or replace function public.edition_create_order(p_org uuid, p_edition uuid, p_package uuid, p_attempt text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare pk public.edition_packages%rowtype; v_id uuid; e public.editions%rowtype;
begin
  if auth.uid() is null or not public.edition_org_can(p_org, 'owner') then raise exception 'only an owner can buy a package' using errcode = '42501'; end if;
  if not public.edition_commerce_enabled() then raise exception 'payments are not switched on yet' using errcode = '23514', hint = 'payments_off'; end if;
  if char_length(coalesce(p_attempt, '')) not between 8 and 80 then raise exception 'invalid attempt id' using errcode = '22023'; end if;
  select id into v_id from public.edition_orders where buyer_id = auth.uid() and attempt_id = p_attempt;
  if found then return v_id; end if;
  select * into e from public.editions where id = p_edition and organiser_id = p_org;
  if not found then raise exception 'edition not found' using errcode = 'P0002'; end if;
  select * into pk from public.edition_packages where id = p_package and active;
  if not found then raise exception 'that package is not available' using errcode = '23514'; end if;
  if pk.audience = 'hub' and not public.edition_org_is_hub_run(p_org) then raise exception 'that package is for Hub-run Editions' using errcode = '23514', hint = 'hub_only_package'; end if;
  if pk.price_pence > public.edition_commerce_cfg('editions.commerce.max_charge_pence', '500000')::integer then raise exception 'that amount is above the allowed limit' using errcode = '23514'; end if;
  insert into public.edition_orders (organiser_id, edition_id, package_id, buyer_id, amount_pence, package_snapshot, attempt_id)
  values (p_org, p_edition, p_package, auth.uid(), pk.price_pence, to_jsonb(pk), p_attempt) returning id into v_id;
  perform public.edition_audit(p_org, p_edition, 'order_created', jsonb_build_object('order', v_id, 'package', pk.code, 'amount', pk.price_pence));
  return v_id;
end $$;

-- Draft Community packages: INACTIVE placeholders with price 0, like the existing drafts. An administrator sets the real discounted price and switches them on.
insert into public.edition_packages (code, name, description, price_pence, duration_days, features, max_members, active, sort, audience) values
  ('community_publish', 'Community Edition (DRAFT)', 'Publish one Hub-run Edition for a year at the community rate.', 0, 365, '[]', null, false, 40, 'hub'),
  ('community_collect', 'Community Edition + collect payments (DRAFT)', 'Hub-run: publish and collect memberships and participation fees at the community rate.', 0, 365,
   '["collect_payments","memberships","participation_fees","offline_records"]', 200, false, 50, 'hub')
on conflict (code) do nothing;

do $$ declare f text; begin
  foreach f in array array['edition_org_is_hub_run(uuid)', 'edition_available_packages(uuid)', 'admin_set_edition_package_audience(text,text)', 'edition_create_order(uuid,uuid,uuid,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['edition_available_packages(uuid)', 'admin_set_edition_package_audience(text,text)', 'edition_create_order(uuid,uuid,uuid,text)'] loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
