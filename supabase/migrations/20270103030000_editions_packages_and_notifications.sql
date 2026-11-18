-- Editions: packages are chosen AFTER approval, free packages are a real kind of package, and the people involved are told.
--
--   * edition_packages.is_free: a package is either priced (> 0 pence) or explicitly free; an ACTIVE package can never be a £0 placeholder. Prices, duration and features stay ordinary
--     administrator-set rows (nothing is hard-coded here, and no price is decided here). The Hub-only Community audience is unchanged.
--   * A package can only be bought or claimed for an APPROVED Edition whose Business/Hub is live, by an organiser owner or admin. Money (Stripe) and free claims go through the same order and
--     entitlement ledger; a free claim needs no payment and cannot stack on a live package.
--   * Notifications: review decisions, package activation and helper invitations are queued in the existing Editions outbox (sent by the existing editions-email-cron). Helper invitations can go
--     to an address with no OneShetland account yet (the invitation row holds the address; the outbox still never stores it).
-- Expand-only. Rollback: supabase/rollbacks/20270103030000_editions_packages_and_notifications.rollback.sql

-- ── packages ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
alter table public.edition_packages add column if not exists is_free boolean not null default false;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'edition_packages_free_is_zero') then
    alter table public.edition_packages add constraint edition_packages_free_is_zero check (not is_free or price_pence = 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'edition_packages_active_is_priced_or_free') then
    alter table public.edition_packages add constraint edition_packages_active_is_priced_or_free check (not active or price_pence > 0 or is_free);
  end if;
end $$;

drop function if exists public.admin_upsert_edition_package(text, text, text, integer, integer, jsonb, integer, boolean, integer);
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

drop function if exists public.edition_available_packages(uuid);
create or replace function public.edition_available_packages(p_org uuid) returns table (id uuid, code text, name text, description text, price_pence integer, duration_days integer, features jsonb, max_members integer, audience text, sort integer, is_free boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not (public.edition_org_can(p_org, 'editor') or public.edition_staff()) then raise exception 'not permitted' using errcode = '42501'; end if;
  return query select k.id, k.code, k.name, k.description, k.price_pence, k.duration_days, k.features, k.max_members, k.audience, k.sort, k.is_free
                 from public.edition_packages k
                where k.active and (k.audience = 'any' or public.edition_org_is_hub_run(p_org))
                order by k.sort, k.price_pence;
end $$;

-- paying: the Edition must be approved and its parent live; an owner or admin buys; a free package is claimed, never "paid for"
create or replace function public.edition_create_order(p_org uuid, p_edition uuid, p_package uuid, p_attempt text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare pk public.edition_packages%rowtype; v_id uuid; e public.editions%rowtype;
begin
  if auth.uid() is null or not public.edition_org_can(p_org, 'admin') then raise exception 'only an owner or admin can buy a package' using errcode = '42501'; end if;
  if not public.edition_commerce_enabled() then raise exception 'payments are not switched on yet' using errcode = '23514', hint = 'payments_off'; end if;
  if char_length(coalesce(p_attempt, '')) not between 8 and 80 then raise exception 'invalid attempt id' using errcode = '22023'; end if;
  select id into v_id from public.edition_orders where buyer_id = auth.uid() and attempt_id = p_attempt;
  if found then return v_id; end if;
  select * into e from public.editions where id = p_edition and organiser_id = p_org;
  if not found then raise exception 'edition not found' using errcode = 'P0002'; end if;
  if e.review_state <> 'approved' then raise exception 'a package can be chosen once OneShetland has approved the Edition' using errcode = '23514', hint = 'not_approved'; end if;
  if not public.edition_parent_live(p_org) then raise exception 'the Business or Hub is not active' using errcode = '23514', hint = 'parent_not_live'; end if;
  select * into pk from public.edition_packages where id = p_package and active;
  if not found then raise exception 'that package is not available' using errcode = '23514'; end if;
  if pk.is_free then raise exception 'that package is free: claim it instead of paying' using errcode = '23514', hint = 'free_package'; end if;
  if pk.audience = 'hub' and not public.edition_org_is_hub_run(p_org) then raise exception 'that package is for Hub-run Editions' using errcode = '23514', hint = 'hub_only_package'; end if;
  if pk.price_pence > public.edition_commerce_cfg('editions.commerce.max_charge_pence', '500000')::integer then raise exception 'that amount is above the allowed limit' using errcode = '23514'; end if;
  insert into public.edition_orders (organiser_id, edition_id, package_id, buyer_id, amount_pence, package_snapshot, attempt_id)
  values (p_org, p_edition, p_package, auth.uid(), pk.price_pence, to_jsonb(pk), p_attempt) returning id into v_id;
  perform public.edition_audit(p_org, p_edition, 'order_created', jsonb_build_object('order', v_id, 'package', pk.code, 'amount', pk.price_pence));
  return v_id;
end $$;

-- a free package: same ledger, no payment, no Stripe; only for a package an administrator has deliberately marked free; never stacked on a live package
create or replace function public.edition_claim_free_package(p_org uuid, p_edition uuid, p_package uuid, p_attempt text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare pk public.edition_packages%rowtype; v_id uuid; e public.editions%rowtype;
begin
  if auth.uid() is null or not public.edition_org_can(p_org, 'admin') then raise exception 'only an owner or admin can choose a package' using errcode = '42501'; end if;
  if char_length(coalesce(p_attempt, '')) not between 8 and 80 then raise exception 'invalid attempt id' using errcode = '22023'; end if;
  select id into v_id from public.edition_orders where buyer_id = auth.uid() and attempt_id = p_attempt;
  if found then return v_id; end if;
  select * into e from public.editions where id = p_edition and organiser_id = p_org for update;
  if not found then raise exception 'edition not found' using errcode = 'P0002'; end if;
  if e.review_state <> 'approved' then raise exception 'a package can be chosen once OneShetland has approved the Edition' using errcode = '23514', hint = 'not_approved'; end if;
  if not public.edition_parent_live(p_org) then raise exception 'the Business or Hub is not active' using errcode = '23514', hint = 'parent_not_live'; end if;
  select * into pk from public.edition_packages where id = p_package and active and is_free and price_pence = 0;
  if not found then raise exception 'that package is not available' using errcode = '23514'; end if;
  if pk.audience = 'hub' and not public.edition_org_is_hub_run(p_org) then raise exception 'that package is for Hub-run Editions' using errcode = '23514', hint = 'hub_only_package'; end if;
  if public.edition_entitled(p_edition, 'publish') then raise exception 'this Edition already has an active package' using errcode = '23514', hint = 'already_entitled'; end if;
  insert into public.edition_orders (organiser_id, edition_id, package_id, buyer_id, amount_pence, package_snapshot, attempt_id)
  values (p_org, p_edition, p_package, auth.uid(), 0, to_jsonb(pk), p_attempt) returning id into v_id;
  perform public.edition_fulfil_order(v_id, null, 0);
  perform public.edition_audit(p_org, p_edition, 'free_package_claimed', jsonb_build_object('order', v_id, 'package', pk.code));
  return v_id;
end $$;

-- ── notifications ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
alter table public.edition_email_outbox alter column user_id drop not null;
alter table public.edition_email_outbox add column if not exists invite_id uuid references public.edition_organiser_invites (id) on delete cascade;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'edition_email_outbox_recipient') then
    alter table public.edition_email_outbox add constraint edition_email_outbox_recipient check (user_id is not null or invite_id is not null);
  end if;
end $$;

create or replace function public.edition_email_next(p_limit integer default 25) returns table (id bigint, kind text, user_id uuid, email text, payload jsonb, attempts integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select o.id, o.kind, o.user_id, coalesce(u.email::text, i.email), o.payload, o.attempts
    from public.edition_email_outbox o
    left join auth.users u on u.id = o.user_id
    left join public.edition_organiser_invites i on i.id = o.invite_id
   where o.sent_at is null and o.attempts < 5 and coalesce(u.email::text, i.email) is not null
   order by o.created_at limit least(greatest(p_limit, 1), 100)
$$;

create or replace function public.invite_edition_member(p_org uuid, p_email text, p_role text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_email text := lower(btrim(p_email)); o public.edition_organisers%rowtype;
begin
  if auth.uid() is null or not public.edition_org_can(p_org, 'owner') then raise exception 'owners only' using errcode = '42501'; end if;
  if p_role not in ('admin', 'editor') then raise exception 'role must be admin or editor' using errcode = '23514'; end if;
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'enter a valid email address' using errcode = '23514', hint = 'bad_email'; end if;
  if (select count(*) from public.edition_organiser_members where organiser_id = p_org) + (select count(*) from public.edition_organiser_invites where organiser_id = p_org and status = 'pending') >= 25 then
    raise exception 'team limit reached' using errcode = '53400', hint = 'team_limit';
  end if;
  select * into o from public.edition_organisers where id = p_org;
  insert into public.edition_organiser_invites (organiser_id, email, role, invited_by) values (p_org, v_email, p_role, auth.uid()) returning id into v_id;
  insert into public.edition_email_outbox (kind, user_id, invite_id, dedupe_key, payload)
    values ('helper_invited', null, v_id, 'invite:' || v_id, jsonb_build_object('organiser_name', o.name, 'organiser_slug', o.slug, 'role', p_role, 'subject_kind', case when o.hub_id is not null then 'hub' else 'business' end,
      'inviter', (select p.full_name from public.profiles p where p.id = auth.uid())))
    on conflict (dedupe_key) do nothing;
  perform public.edition_audit(p_org, null, 'member_invited', jsonb_build_object('role', p_role));
  return v_id;
end $$;

create or replace function public.edition_entitlement_notify() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.editions%rowtype; o public.edition_organisers%rowtype; v_to uuid;
begin
  if new.feature <> 'publish' or new.order_id is null then return new; end if;
  select * into e from public.editions where id = new.edition_id;
  select * into o from public.edition_organisers where id = new.organiser_id;
  for v_to in select * from public.edition_org_admin_users(new.organiser_id) loop
    perform public.edition_enqueue_email('package_active', v_to, 'ent:' || new.id || ':' || v_to,
      jsonb_build_object('edition_title', e.title, 'edition_slug', e.slug, 'organiser_slug', o.slug, 'organiser_name', o.name, 'ends_at', new.ends_at, 'amount_pence', coalesce(new.amount_pence, 0), 'subject_kind', case when o.hub_id is not null then 'hub' else 'business' end));
  end loop;
  return new;
end $$;
drop trigger if exists edition_entitlement_notify on public.edition_entitlements;
create trigger edition_entitlement_notify after insert on public.edition_entitlements for each row execute function public.edition_entitlement_notify();

-- ── privileges ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
do $$ declare f text; begin
  foreach f in array array['admin_upsert_edition_package(text,text,text,integer,integer,jsonb,integer,boolean,integer,boolean)', 'edition_available_packages(uuid)', 'edition_create_order(uuid,uuid,uuid,text)',
    'edition_claim_free_package(uuid,uuid,uuid,text)', 'edition_email_next(integer)', 'invite_edition_member(uuid,text,text)', 'edition_entitlement_notify()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['admin_upsert_edition_package(text,text,text,integer,integer,jsonb,integer,boolean,integer,boolean)', 'edition_available_packages(uuid)', 'edition_create_order(uuid,uuid,uuid,text)',
    'edition_claim_free_package(uuid,uuid,uuid,text)', 'invite_edition_member(uuid,text,text)'] loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
