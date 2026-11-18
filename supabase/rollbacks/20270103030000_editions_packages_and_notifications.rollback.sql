-- Rollback of 20270103030000_editions_packages_and_notifications. Pending helper-invitation emails and package-active emails that have not been sent are discarded.
drop trigger if exists edition_entitlement_notify on public.edition_entitlements;
drop function if exists public.edition_entitlement_notify();
drop function if exists public.edition_claim_free_package(uuid, uuid, uuid, text);
delete from public.edition_email_outbox where user_id is null;
drop function if exists public.edition_email_next(integer);
alter table public.edition_email_outbox drop constraint if exists edition_email_outbox_recipient;
alter table public.edition_email_outbox drop column if exists invite_id;
alter table public.edition_email_outbox alter column user_id set not null;
CREATE OR REPLACE FUNCTION public.edition_email_next(p_limit integer DEFAULT 25)
 RETURNS TABLE(id bigint, kind text, user_id uuid, email text, payload jsonb, attempts integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
  select o.id, o.kind, o.user_id, u.email::text, o.payload, o.attempts from public.edition_email_outbox o join auth.users u on u.id = o.user_id
   where o.sent_at is null and o.attempts < 5 and u.email is not null order by o.created_at limit least(greatest(p_limit, 1), 100)
$function$;

CREATE OR REPLACE FUNCTION public.invite_edition_member(p_org uuid, p_email text, p_role text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_id uuid; v_email text := lower(btrim(p_email));
begin
  if auth.uid() is null or not public.edition_org_can(p_org, 'owner') then raise exception 'owners only' using errcode = '42501'; end if;
  if p_role not in ('admin', 'editor') then raise exception 'role must be admin or editor' using errcode = '23514'; end if;
  if (select count(*) from public.edition_organiser_members where organiser_id = p_org) + (select count(*) from public.edition_organiser_invites where organiser_id = p_org and status = 'pending') >= 25 then
    raise exception 'team limit reached' using errcode = '53400', hint = 'team_limit';
  end if;
  insert into public.edition_organiser_invites (organiser_id, email, role, invited_by) values (p_org, v_email, p_role, auth.uid()) returning id into v_id;
  perform public.edition_audit(p_org, null, 'member_invited', jsonb_build_object('role', p_role));
  return v_id;
end $function$;

drop function if exists public.admin_upsert_edition_package(text, text, text, integer, integer, jsonb, integer, boolean, integer, boolean);
drop function if exists public.edition_available_packages(uuid);
CREATE OR REPLACE FUNCTION public.admin_upsert_edition_package(p_code text, p_name text, p_description text, p_price integer, p_days integer, p_features jsonb, p_max_members integer, p_active boolean, p_sort integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_id uuid;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then raise exception 'admins only' using errcode = '42501'; end if;
  if jsonb_typeof(coalesce(p_features, '[]'::jsonb)) <> 'array' or exists (select 1 from jsonb_array_elements_text(coalesce(p_features, '[]'::jsonb)) f where f not in ('collect_payments', 'memberships', 'offline_records', 'participation_fees', 'csv_export')) then
    raise exception 'unknown feature in package' using errcode = '22023';
  end if;
  insert into public.edition_packages (code, name, description, price_pence, duration_days, features, max_members, active, sort) values (p_code, p_name, p_description, p_price, p_days, coalesce(p_features, '[]'::jsonb), p_max_members, coalesce(p_active, false), coalesce(p_sort, 0))
  on conflict (code) do update set name = excluded.name, description = excluded.description, price_pence = excluded.price_pence, duration_days = excluded.duration_days, features = excluded.features,
    max_members = excluded.max_members, active = excluded.active, sort = excluded.sort, updated_at = now() returning id into v_id;
  perform public.edition_audit(null, null, 'package_upserted', jsonb_build_object('code', p_code, 'price', p_price, 'active', p_active));
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION public.edition_available_packages(p_org uuid)
 RETURNS TABLE(id uuid, code text, name text, description text, price_pence integer, duration_days integer, features jsonb, max_members integer, audience text, sort integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null or not (public.edition_org_can(p_org, 'editor') or public.edition_staff()) then raise exception 'not permitted' using errcode = '42501'; end if;
  return query select k.id, k.code, k.name, k.description, k.price_pence, k.duration_days, k.features, k.max_members, k.audience, k.sort
                 from public.edition_packages k
                where k.active and (k.audience = 'any' or public.edition_org_is_hub_run(p_org))
                order by k.sort, k.price_pence;
end $function$;

CREATE OR REPLACE FUNCTION public.edition_create_order(p_org uuid, p_edition uuid, p_package uuid, p_attempt text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
end $function$;

alter table public.edition_packages drop constraint if exists edition_packages_active_is_priced_or_free;
alter table public.edition_packages drop constraint if exists edition_packages_free_is_zero;
alter table public.edition_packages drop column if exists is_free;
do $$ declare f text; begin
  foreach f in array array['admin_upsert_edition_package(text,text,text,integer,integer,jsonb,integer,boolean,integer)','edition_available_packages(uuid)','edition_create_order(uuid,uuid,uuid,text)','invite_edition_member(uuid,text,text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  revoke all on function public.edition_email_next(integer) from public, anon, authenticated;
end $$;
