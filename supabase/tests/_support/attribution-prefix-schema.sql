-- attribution-prefix-schema.sql — the PRE-FIX production state of events / notices and everything their authorisation touches.
-- Policies, triggers and functions are copied VERBATIM from read-only introspection of production on 8 Oct 2026 (pg_policies,
-- pg_get_functiondef, pg_get_triggerdef); tables carry only the columns the proofs need, with the same constraints and defaults
-- for the columns that matter. Test-only. Nothing here ships.
drop schema if exists public cascade; create schema public;
drop schema if exists auth cascade; create schema auth;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
alter role service_role bypassrls;
grant usage on schema public to anon, authenticated, service_role;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;

create table profiles (id uuid primary key, role text not null default 'customer', is_platform_owner boolean default false,
  stripe_account_id text, stripe_payouts_enabled boolean default false);
create table driver_profiles (id uuid primary key, stripe_account_id text, stripe_payouts_enabled boolean default false);
create table local_businesses (id uuid primary key default gen_random_uuid(), owner_id uuid references profiles(id), name text, slug text,
  use_business_payout boolean default false, payout_enabled boolean default false, stripe_account_id text,
  business_stripe_payouts_enabled boolean, business_stripe_account_id text, can_publish_urgent boolean default false);
create table hubs (id uuid primary key default gen_random_uuid(), owner_id uuid references profiles(id), name text, slug text,
  is_verified boolean default false, payout_enabled boolean default false, stripe_account_id text, is_active boolean default true);
create table hub_members (hub_id uuid references hubs(id) on delete cascade, user_id uuid references profiles(id), role text not null default 'member',
  status text not null default 'active', paid_until timestamptz, primary key (hub_id, user_id));
create table compliance_log (event_type text, user_id uuid, document_version text, metadata jsonb);
create function commercial_terms_version() returns text language sql immutable as $$ select 'v1' $$;

create table events (
  id uuid primary key default gen_random_uuid(), organiser_user_id uuid references profiles(id) on delete set null,
  organiser_business_id uuid references local_businesses(id) on delete set null, title text not null,
  description text, category text, venue text, locality text, starts_at timestamptz not null, ends_at timestamptz, cover_url text,
  price_text text, ticket_url text, is_featured boolean not null default false, is_hidden boolean not null default true,
  created_at timestamptz not null default now(), status text not null default 'draft', capacity integer, has_tickets boolean not null default false,
  tickets_sold integer not null default 0, updated_at timestamptz not null default now(),
  place_id text, formatted_address text, gallery_urls text[] not null default '{}', video_url text, doors_open_at timestamptz,
  accessibility_info text, age_restriction text, refund_policy text, contact_info text, event_notes text, lat numeric, lng numeric,
  organiser_hub_id uuid references hubs(id) on delete set null, hub_visibility text, calendar_approved boolean not null default false,
  calendar_approved_by uuid references profiles(id) on delete set null, calendar_approved_at timestamptz, reminder_sent_at timestamptz,
  constraint events_hub_visibility_check check (hub_visibility = any (array['members','hub','islands'])),
  constraint events_status_check check (status = any (array['draft','published','cancelled','postponed','archived'])),
  constraint events_title_check check (length(trim(both from title)) between 1 and 200));
create table event_ticket_types (id uuid primary key default gen_random_uuid(), event_id uuid references events(id) on delete cascade, price_pence int not null default 0, is_active boolean default true);
create table event_ticket_orders (id uuid primary key default gen_random_uuid(), event_id uuid references events(id), buyer_id uuid);
create table hub_campaigns (id uuid primary key default gen_random_uuid(), hub_id uuid not null references hubs(id) on delete cascade, title text);
create table notices (
  id uuid primary key default gen_random_uuid(), publisher_business_id uuid references local_businesses(id) on delete set null,
  publisher_user_id uuid references profiles(id) on delete set null, severity text not null default 'community', title text not null, body text,
  locality text, is_pinned boolean not null default false, is_hidden boolean not null default false, expires_at timestamptz,
  published_at timestamptz not null default now(), created_at timestamptz not null default now(),
  publisher_hub_id uuid references hubs(id) on delete cascade, visibility text not null default 'public', image_url text, category text,
  campaign_id uuid, event_id uuid references events(id) on delete cascade, broadcast_at timestamptz, broadcast_by uuid references profiles(id),
  constraint notices_severity_check check (severity = any (array['urgent','community','info'])),
  constraint notices_visibility_check check (visibility = any (array['public','members','committee'])),
  constraint notices_title_check check (length(trim(both from title)) between 1 and 200));

-- helper functions (verbatim)
create function is_business_owner(p_business uuid, p_user uuid) returns boolean language sql stable security definer set search_path to 'public','pg_temp' as $$
  select exists (select 1 from public.local_businesses b where b.id = p_business and b.owner_id = p_user); $$;
create function is_hub_admin(p_hub uuid, p_user uuid) returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.hub_members where hub_id = p_hub and user_id = p_user and status = 'active' and role in ('owner','committee')); $$;
create function is_hub_member(p_hub uuid, p_user uuid) returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.hub_members where hub_id = p_hub and user_id = p_user and status = 'active' and (paid_until is null or paid_until > now())); $$;
create function holds_ticket_for(p uuid) returns boolean language sql as $$ select false $$;
create function is_event_business_owner(p_event uuid, p_user uuid) returns boolean language sql stable security definer as $$
  select exists (select 1 from public.events e join public.local_businesses b on b.id = e.organiser_business_id where e.id = p_event and b.owner_id = p_user); $$;
create function has_accepted_commercial_terms(p_business_id uuid, p_user_id uuid default null) returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.compliance_log where event_type='business.commercial_terms_accepted' and user_id=coalesce(p_user_id, auth.uid())
    and document_version=public.commercial_terms_version() and metadata->>'business_id' = p_business_id::text); $$;
create function business_may_transact(p_business_id uuid, p_user_id uuid) returns boolean language plpgsql stable security definer set search_path to 'public' as $$
begin
  if p_business_id is null or p_user_id is null then return false; end if;
  if auth.uid() is not null and p_user_id is distinct from auth.uid() then raise exception 'business_may_transact: may only be asked about yourself' using errcode='42501'; end if;
  return exists (select 1 from public.local_businesses b where b.id = p_business_id and b.owner_id = p_user_id) and public.has_accepted_commercial_terms(p_business_id, p_user_id);
end; $$;
create function _business_payout_resolve(p_business uuid) returns table(account_id text, is_demo boolean) language sql stable security definer set search_path to 'public','pg_temp' as $$
  select case
      when coalesce(b.use_business_payout,false) and coalesce(b.payout_enabled,false) and b.stripe_account_id is not null then b.stripe_account_id
      when coalesce(b.use_business_payout,false) and coalesce(b.business_stripe_payouts_enabled,false) and b.business_stripe_account_id is not null then b.business_stripe_account_id
      else (select coalesce(case when pr.stripe_payouts_enabled and pr.stripe_account_id is not null then pr.stripe_account_id end,
                            case when d.stripe_payouts_enabled and d.stripe_account_id is not null then d.stripe_account_id end)
              from public.profiles pr left join public.driver_profiles d on d.id = pr.id where pr.id = b.owner_id) end as account_id,
    coalesce(b.slug,'') like 'demo-%' as is_demo from public.local_businesses b where b.id = p_business; $$;
create function _event_payout_resolve(p_event_id uuid) returns table(account_id text, is_demo boolean, all_free boolean) language plpgsql security definer set search_path to 'public' as $$
declare v_event public.events%rowtype; v_acct text := null; v_demo boolean := false; v_free boolean := false;
begin
  select * into v_event from public.events where id = p_event_id;
  if not found then return query select null::text, false, false; return; end if;
  select coalesce(bool_and(t.price_pence = 0), false) into v_free from public.event_ticket_types t where t.event_id = p_event_id and t.is_active;
  if v_event.organiser_hub_id is not null then
    select case when h.payout_enabled and h.stripe_account_id is not null then h.stripe_account_id else null end, coalesce(h.slug,'') like 'demo-%'
      into v_acct, v_demo from public.hubs h where h.id = v_event.organiser_hub_id;
  elsif v_event.organiser_business_id is not null then
    select r.account_id, r.is_demo into v_acct, v_demo from public._business_payout_resolve(v_event.organiser_business_id) r;
  end if;
  return query select v_acct, coalesce(v_demo,false), coalesce(v_free,false);
end; $$;
create function can_refund_event_orders(p_event_id uuid, p_user_id uuid) returns boolean language plpgsql security definer set search_path to 'public' as $$
declare v_event public.events%rowtype;
begin
  if p_event_id is null or p_user_id is null then return false; end if;
  select * into v_event from public.events where id = p_event_id; if not found then return false; end if;
  if exists (select 1 from public.profiles where id = p_user_id and (role='admin' or is_platform_owner is true)) then return true; end if;
  if v_event.organiser_business_id is not null and exists (select 1 from public.local_businesses where id = v_event.organiser_business_id and owner_id is not null and owner_id = p_user_id) then return true; end if;
  if v_event.organiser_hub_id is not null and exists (select 1 from public.hubs where id = v_event.organiser_hub_id and owner_id is not null and owner_id = p_user_id) then return true; end if;
  return false;
end; $$;
create function can_scan_event(p_event_id uuid, p_user_id uuid) returns boolean language plpgsql security definer set search_path to 'public' as $$
declare v_event public.events%rowtype;
begin
  if p_event_id is null or p_user_id is null then return false; end if;
  select * into v_event from public.events where id = p_event_id; if not found then return false; end if;
  if exists (select 1 from public.profiles where id = p_user_id and (role='admin' or is_platform_owner is true)) then return true; end if;
  if v_event.organiser_user_id is not null and v_event.organiser_user_id = p_user_id then return true; end if;
  if v_event.organiser_business_id is not null and exists (select 1 from public.local_businesses where id = v_event.organiser_business_id and owner_id is not null and owner_id = p_user_id) then return true; end if;
  if v_event.organiser_hub_id is not null and exists (select 1 from public.hub_members where hub_id = v_event.organiser_hub_id and user_id = p_user_id and status='active' and role in ('owner','committee')) then return true; end if;
  return false;
end; $$;

create function commercial_terms_write_guard() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_uid uuid := auth.uid(); v_business uuid; v_spec text := coalesce(TG_ARGV[1], ''); o jsonb; n jsonb; k text; v_changed text[] := '{}'; v_pair text; v_col text; v_allowed text[]; v_ok boolean;
begin
  if TG_OP = 'DELETE' then return old; end if;
  if v_uid is null then return new; end if;
  if exists (select 1 from public.profiles p where p.id = v_uid and p.role = any (array['admin','moderator'])) then return new; end if;
  n := to_jsonb(new);
  if TG_ARGV[0] = 'product_id' then select business_id into v_business from public.products where id = (n->>'product_id')::uuid;
  else v_business := nullif(n->>TG_ARGV[0], '')::uuid; end if;
  if v_business is null then return new; end if;
  if public.business_may_transact(v_business, v_uid) then return new; end if;
  if TG_OP <> 'UPDATE' then
    raise exception 'Accept the business & selling terms for this business before adding or changing what it offers' using errcode='42501'; end if;
  o := to_jsonb(old);
  for k in select jsonb_object_keys(n) loop
    if (n -> k) is distinct from (o -> k) and k <> 'updated_at' then v_changed := v_changed || k; end if; end loop;
  if array_length(v_changed, 1) is null then return new; end if;
  foreach k in array v_changed loop
    v_ok := false;
    foreach v_pair in array string_to_array(v_spec, ';') loop
      v_col := split_part(v_pair, '=', 1);
      if v_col = k then v_allowed := string_to_array(split_part(v_pair, '=', 2), ',');
        if (n->>k) = any (v_allowed) and ((o->>k) is null or not ((o->>k) = any (v_allowed))) then v_ok := true; end if; end if;
    end loop;
    if not v_ok then raise exception 'Accept the business & selling terms for this business before changing what it offers' using errcode='42501'; end if;
  end loop;
  return new;
end; $$;
create function tg_events_sync_hidden() returns trigger language plpgsql as $$
declare v_verified boolean := false;
begin
  new.is_hidden := (new.status <> 'published'); new.updated_at := now();
  if new.organiser_hub_id is not null and new.hub_visibility = 'islands' then
    select is_verified into v_verified from public.hubs where id = new.organiser_hub_id;
    if coalesce(v_verified,false) then new.calendar_approved := true;
    else
      if new.calendar_approved_by is distinct from old.calendar_approved_by and not exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','moderator'))
      then new.calendar_approved_by := old.calendar_approved_by; end if;
      new.calendar_approved := (new.calendar_approved_by is not null);
    end if;
  else new.calendar_approved := false; end if;
  if new.calendar_approved and (tg_op = 'INSERT' or not coalesce(old.calendar_approved,false)) then new.calendar_approved_at := now(); end if;
  return new;
end; $$;
create trigger commercial_terms_guard before insert or update on events for each row execute function commercial_terms_write_guard('organiser_business_id','is_hidden=true;status=cancelled,archived');
create trigger tg_events_sync before insert or update on events for each row execute function tg_events_sync_hidden();

-- hubs: client-created hubs get no payout/verification (tg_lock_hub_columns INSERT branch); owner gets an owner membership
create function tg_lock_hub_columns() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then new.is_verified := false; new.payout_enabled := false; new.stripe_account_id := null; return new; end if;
  new.is_verified := old.is_verified; new.payout_enabled := old.payout_enabled; new.stripe_account_id := old.stripe_account_id; new.owner_id := old.owner_id; return new;
end; $$;
create function tg_hub_owner_membership() returns trigger language plpgsql security definer set search_path to 'public' as $$
begin insert into public.hub_members (hub_id, user_id, role, status) values (new.id, new.owner_id, 'owner', 'active') on conflict do nothing; return new; end; $$;
create trigger tg_zz_lock_hub_columns before insert or update on hubs for each row execute function tg_lock_hub_columns();
create trigger trg_hub_owner_membership after insert on hubs for each row execute function tg_hub_owner_membership();

-- RLS: policies verbatim
alter table hub_campaigns enable row level security;
alter table events enable row level security; alter table notices enable row level security; alter table hubs enable row level security;
alter table event_ticket_types enable row level security; alter table event_ticket_orders enable row level security;
create policy events_owner_write on events for all using ((organiser_user_id = auth.uid()) OR is_business_owner(organiser_business_id, auth.uid()) OR ((organiser_hub_id IS NOT NULL) AND is_hub_admin(organiser_hub_id, auth.uid())) OR (EXISTS (SELECT 1 FROM profiles p WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin','moderator']))))));
create policy events_public_read on events for select using (((NOT is_hidden) AND ((organiser_hub_id IS NULL) OR (hub_visibility = ANY (ARRAY['hub','islands'])))) OR ((organiser_hub_id IS NOT NULL) AND is_hub_member(organiser_hub_id, auth.uid())) OR (organiser_user_id = auth.uid()) OR is_business_owner(organiser_business_id, auth.uid()) OR ((organiser_hub_id IS NOT NULL) AND is_hub_admin(organiser_hub_id, auth.uid())) OR (EXISTS (SELECT 1 FROM profiles p WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin','moderator']))))));
create policy ticket_types_owner_all on event_ticket_types for all using (is_event_business_owner(event_id, auth.uid()) OR (EXISTS (SELECT 1 FROM events e WHERE ((e.id = event_ticket_types.event_id) AND (e.organiser_hub_id IS NOT NULL) AND is_hub_admin(e.organiser_hub_id, auth.uid())))) OR (EXISTS (SELECT 1 FROM profiles p WHERE ((p.id = auth.uid()) AND (p.role = 'admin')))));
create policy ticket_types_public_read on event_ticket_types for select using (EXISTS (SELECT 1 FROM events e WHERE ((e.id = event_ticket_types.event_id) AND (NOT e.is_hidden))));
create policy "hubs insert" on hubs for insert with check (owner_id = auth.uid());
create policy "hubs read" on hubs for select using (true);
create policy "hubs update" on hubs for update using ((owner_id = auth.uid()) OR is_hub_admin(id, auth.uid()));
create policy "notices insert" on notices for insert with check ((auth.uid() IS NOT NULL) AND ((severity <> 'urgent') OR (EXISTS (SELECT 1 FROM local_businesses b WHERE ((b.id = notices.publisher_business_id) AND (b.owner_id = auth.uid()) AND (b.can_publish_urgent = true)))) OR (EXISTS (SELECT 1 FROM profiles p WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin','moderator'])))))) AND ((publisher_user_id = auth.uid()) OR (EXISTS (SELECT 1 FROM local_businesses b WHERE ((b.id = notices.publisher_business_id) AND (b.owner_id = auth.uid())))) OR is_hub_admin(publisher_hub_id, auth.uid()) OR (EXISTS (SELECT 1 FROM profiles p WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin','moderator'])))))));
create policy "notices update" on notices for update using ((publisher_user_id = auth.uid()) OR (EXISTS (SELECT 1 FROM local_businesses b WHERE ((b.id = notices.publisher_business_id) AND (b.owner_id = auth.uid())))) OR is_hub_admin(publisher_hub_id, auth.uid()) OR (EXISTS (SELECT 1 FROM profiles p WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin','moderator']))))));
create policy "notices delete" on notices for delete using ((publisher_user_id = auth.uid()) OR (EXISTS (SELECT 1 FROM local_businesses b WHERE ((b.id = notices.publisher_business_id) AND (b.owner_id = auth.uid())))) OR is_hub_admin(publisher_hub_id, auth.uid()) OR (EXISTS (SELECT 1 FROM profiles p WHERE ((p.id = auth.uid()) AND (p.role = 'admin')))));
create policy "notices read" on notices for select using (true);
grant all on all tables in schema public to anon, authenticated, service_role;
grant select on profiles, local_businesses, hubs, hub_members to authenticated;

