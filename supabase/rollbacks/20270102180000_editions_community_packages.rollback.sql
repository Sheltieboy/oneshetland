-- Rolls back 20270102180000_editions_community_packages.sql. Data written through the new features (Hub links, Hub items, Hub-run organisers) is removed or unlinked as stated; everything older is restored exactly as before.
-- Hub-only package orders (if any were ever made) keep their snapshot; the draft Community packages are removed unless an order references them.
delete from public.edition_packages p where p.code in ('community_publish', 'community_collect') and not exists (select 1 from public.edition_orders o where o.package_id = p.id);
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
  if pk.price_pence > public.edition_commerce_cfg('editions.commerce.max_charge_pence', '500000')::integer then raise exception 'that amount is above the allowed limit' using errcode = '23514'; end if;
  insert into public.edition_orders (organiser_id, edition_id, package_id, buyer_id, amount_pence, package_snapshot, attempt_id)
  values (p_org, p_edition, p_package, auth.uid(), pk.price_pence, to_jsonb(pk), p_attempt) returning id into v_id;
  perform public.edition_audit(p_org, p_edition, 'order_created', jsonb_build_object('order', v_id, 'package', pk.code, 'amount', pk.price_pence));
  return v_id;
end $$;
drop policy if exists "edition_packages read" on public.edition_packages;
create policy "edition_packages read" on public.edition_packages for select to authenticated using (active or public.is_admin());
drop function if exists public.admin_set_edition_package_audience(text, text);
drop function if exists public.edition_available_packages(uuid);
drop function if exists public.edition_org_is_hub_run(uuid);
alter table public.edition_packages drop column if exists audience;
