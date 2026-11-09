-- OneShetland Editions R4c: organisation memberships. Organisers define tiers; businesses apply, are invited, pay (or are recorded offline), renew and leave.
-- Memberships are INDEPENDENT of Business Pro/Premium and Hub memberships: separate tables, separate Stripe customers and metadata, and nothing here reads or
-- writes local_businesses subscription columns, hub_members or any plan state. A membership unlocks Edition benefits only; it never edits a listing or an offer.
-- Money enters only through service-role functions (verified webhook, not deployed) or the organiser's offline record. Gated by edition_collect_blocker().

create table if not exists public.organiser_membership_tiers (
  id                      uuid primary key default gen_random_uuid(),
  organiser_id            uuid not null references public.edition_organisers (id) on delete cascade,
  name                    text not null check (char_length(btrim(name)) between 2 and 80),
  description             text check (description is null or char_length(description) <= 600),
  benefits                jsonb not null default '[]'::jsonb,
  price_monthly_pence     integer check (price_monthly_pence is null or price_monthly_pence between 100 and 1000000),
  price_annual_pence      integer check (price_annual_pence is null or price_annual_pence between 100 and 10000000),
  is_free                 boolean not null default false,
  vat_mode                text not null default 'none' check (vat_mode in ('none', 'inclusive', 'exclusive')),
  join_mode               text not null default 'application' check (join_mode in ('open', 'application', 'invite_only')),
  edition_benefit         text not null default 'none' check (edition_benefit in ('none', 'free', 'percent_off')),
  edition_discount_percent integer check (edition_discount_percent is null or edition_discount_percent between 1 and 99),
  max_members             integer check (max_members is null or max_members > 0),
  active                  boolean not null default true,
  sort                    integer not null default 0,
  version                 integer not null default 1,
  replaces_id             uuid references public.organiser_membership_tiers (id) on delete set null,
  archived_at             timestamptz,
  stripe_price_monthly_id text,
  stripe_price_annual_id  text,
  created_at              timestamptz not null default now(),
  constraint tier_priced check ((is_free and price_monthly_pence is null and price_annual_pence is null) or (not is_free and (price_monthly_pence is not null or price_annual_pence is not null))),
  constraint tier_discount check ((edition_benefit = 'percent_off') = (edition_discount_percent is not null)),
  constraint tier_benefits_shape check (jsonb_typeof(benefits) = 'array' and jsonb_array_length(benefits) <= 12)
);
create index if not exists tiers_org_idx on public.organiser_membership_tiers (organiser_id, active, sort);

create table if not exists public.organiser_memberships (
  id                      uuid primary key default gen_random_uuid(),
  organiser_id            uuid not null references public.edition_organisers (id) on delete cascade,
  tier_id                 uuid not null references public.organiser_membership_tiers (id) on delete restrict,
  business_id             uuid not null references public.local_businesses (id) on delete cascade,
  owner_user_id           uuid references auth.users (id) on delete set null,
  status                  text not null check (status in ('applied', 'invited', 'pending_payment', 'active', 'past_due', 'cancel_at_period_end', 'cancelled', 'expired', 'declined', 'withdrawn')),
  billing_interval        text check (billing_interval in ('monthly', 'annual', 'offline', 'complimentary')),
  source                  text not null check (source in ('application', 'invitation', 'offline_record')),
  price_pence             integer check (price_pence is null or price_pence >= 0),
  vat_mode                text not null default 'none' check (vat_mode in ('none', 'inclusive', 'exclusive')),
  stripe_subscription_id  text unique,
  current_period_start    timestamptz,
  current_period_end      timestamptz,
  past_due_since          timestamptz,
  cancel_requested_at     timestamptz,
  joined_at               timestamptz,
  message                 text check (message is null or char_length(message) <= 500),
  decision_note           text check (decision_note is null or char_length(decision_note) <= 300),
  organiser_note          text check (organiser_note is null or char_length(organiser_note) <= 1000),
  decided_by              uuid references auth.users (id) on delete set null,
  decided_at              timestamptz,
  created_by              uuid references auth.users (id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create unique index if not exists memberships_live_uq on public.organiser_memberships (organiser_id, business_id) where status in ('applied', 'invited', 'pending_payment', 'active', 'past_due', 'cancel_at_period_end');
create index if not exists memberships_biz_idx on public.organiser_memberships (business_id);
create index if not exists memberships_tier_idx on public.organiser_memberships (tier_id, status);

create table if not exists public.organiser_membership_events (
  id            bigint generated always as identity primary key,
  membership_id uuid not null references public.organiser_memberships (id) on delete cascade,
  at            timestamptz not null default now(),
  actor         uuid,
  event         text not null,
  detail        jsonb not null default '{}'::jsonb
);
create index if not exists membership_events_idx on public.organiser_membership_events (membership_id, at);

create table if not exists public.organiser_membership_reminders (
  membership_id uuid not null references public.organiser_memberships (id) on delete cascade,
  kind          text not null check (kind in ('renewal_30d', 'renewal_7d', 'past_due', 'expired')),
  period_end    timestamptz not null,
  sent_at       timestamptz not null default now(),
  primary key (membership_id, kind, period_end)
);

-- ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────

create or replace function public.edition_biz_owner(p_business uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and exists (select 1 from public.local_businesses b where b.id = p_business and b.owner_id = auth.uid())
$$;

create or replace function public.edition_mem_event(p_membership uuid, p_event text, p_detail jsonb default '{}'::jsonb) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.organiser_membership_events (membership_id, actor, event, detail) values (p_membership, auth.uid(), p_event, coalesce(p_detail, '{}'::jsonb))
$$;

-- Benefits apply while a membership is active, or ending at a known date, or past due inside the grace period.
create or replace function public.edition_membership_live(m public.organiser_memberships) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when m.status = 'active' then m.current_period_end is null or m.current_period_end > now()
    when m.status = 'cancel_at_period_end' then m.current_period_end is not null and m.current_period_end > now()
    when m.status = 'past_due' then m.past_due_since is not null and m.past_due_since + make_interval(days => public.edition_commerce_cfg('editions.commerce.grace_days', '14')::int) > now()
    else false end
$$;

-- What a business gets from its membership of an organiser right now (null = nothing). Used by paid participation (R4d).
create or replace function public.edition_member_benefit(p_org uuid, p_business uuid) returns table (tier_id uuid, tier_name text, edition_benefit text, discount_percent integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select t.id, t.name, t.edition_benefit, t.edition_discount_percent
    from public.organiser_memberships m join public.organiser_membership_tiers t on t.id = m.tier_id
   where m.organiser_id = p_org and m.business_id = p_business and public.edition_membership_live(m) order by (t.edition_benefit = 'free') desc, t.edition_discount_percent desc nulls last limit 1
$$;

-- ── tiers (organiser admins; requires the 'memberships' entitlement) ────────────────────────────────────────────────

create or replace function public.edition_tier_save(p_org uuid, p_tier uuid, p_name text, p_description text, p_benefits jsonb, p_monthly integer, p_annual integer, p_free boolean,
  p_vat_mode text, p_join_mode text, p_edition_benefit text, p_discount integer, p_max_members integer, p_sort integer) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.organiser_membership_tiers%rowtype; v_id uuid; v_price_changed boolean; v_has_members boolean;
begin
  if auth.uid() is null or not public.edition_org_can(p_org, 'admin') then raise exception 'only an organiser admin can edit membership tiers' using errcode = '42501'; end if;
  if not public.edition_org_entitled(p_org, 'memberships') then raise exception 'memberships are not included in your package' using errcode = '23514', hint = 'no_memberships_entitlement'; end if;
  if jsonb_typeof(coalesce(p_benefits, '[]'::jsonb)) <> 'array' or exists (select 1 from jsonb_array_elements(coalesce(p_benefits, '[]'::jsonb)) b where jsonb_typeof(b) <> 'string' or char_length(b #>> '{}') not between 1 and 120) then
    raise exception 'benefits must be short lines of text' using errcode = '22023'; end if;
  if p_tier is null then
    if (select count(*) from public.organiser_membership_tiers where organiser_id = p_org and archived_at is null) >= 10 then raise exception 'you have reached the limit of 10 tiers' using errcode = '23514'; end if;
    insert into public.organiser_membership_tiers (organiser_id, name, description, benefits, price_monthly_pence, price_annual_pence, is_free, vat_mode, join_mode, edition_benefit, edition_discount_percent, max_members, sort)
    values (p_org, p_name, p_description, coalesce(p_benefits, '[]'::jsonb), case when p_free then null else p_monthly end, case when p_free then null else p_annual end, coalesce(p_free, false), coalesce(p_vat_mode, 'none'),
            coalesce(p_join_mode, 'application'), coalesce(p_edition_benefit, 'none'), p_discount, p_max_members, coalesce(p_sort, 0)) returning id into v_id;
    perform public.edition_audit(p_org, null, 'tier_created', jsonb_build_object('tier', v_id));
    return v_id;
  end if;
  select * into t from public.organiser_membership_tiers where id = p_tier and organiser_id = p_org and archived_at is null for update;
  if not found then raise exception 'tier not found' using errcode = 'P0002'; end if;
  v_price_changed := (t.price_monthly_pence, t.price_annual_pence, t.is_free, t.vat_mode, t.edition_benefit, t.edition_discount_percent)
    is distinct from (case when p_free then null else p_monthly end, case when p_free then null else p_annual end, coalesce(p_free, false), coalesce(p_vat_mode, 'none'), coalesce(p_edition_benefit, 'none'), p_discount);
  select exists (select 1 from public.organiser_memberships m where m.tier_id = t.id) into v_has_members;
  if v_price_changed and v_has_members then
    -- members keep exactly what they signed up to; the new terms are a new version of the tier
    update public.organiser_membership_tiers set archived_at = now(), active = false where id = t.id;
    insert into public.organiser_membership_tiers (organiser_id, name, description, benefits, price_monthly_pence, price_annual_pence, is_free, vat_mode, join_mode, edition_benefit, edition_discount_percent, max_members, sort, version, replaces_id)
    values (p_org, p_name, p_description, coalesce(p_benefits, '[]'::jsonb), case when p_free then null else p_monthly end, case when p_free then null else p_annual end, coalesce(p_free, false), coalesce(p_vat_mode, 'none'),
            coalesce(p_join_mode, 'application'), coalesce(p_edition_benefit, 'none'), p_discount, p_max_members, coalesce(p_sort, t.sort), t.version + 1, t.id) returning id into v_id;
    perform public.edition_audit(p_org, null, 'tier_versioned', jsonb_build_object('from', t.id, 'to', v_id));
    return v_id;
  end if;
  update public.organiser_membership_tiers set name = p_name, description = p_description, benefits = coalesce(p_benefits, '[]'::jsonb), price_monthly_pence = case when p_free then null else p_monthly end,
    price_annual_pence = case when p_free then null else p_annual end, is_free = coalesce(p_free, false), vat_mode = coalesce(p_vat_mode, 'none'), join_mode = coalesce(p_join_mode, 'application'),
    edition_benefit = coalesce(p_edition_benefit, 'none'), edition_discount_percent = p_discount, max_members = p_max_members, sort = coalesce(p_sort, sort),
    stripe_price_monthly_id = case when v_price_changed then null else stripe_price_monthly_id end, stripe_price_annual_id = case when v_price_changed then null else stripe_price_annual_id end where id = t.id;
  perform public.edition_audit(p_org, null, 'tier_updated', jsonb_build_object('tier', t.id));
  return t.id;
end $$;

create or replace function public.edition_tier_archive(p_tier uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.organiser_membership_tiers%rowtype;
begin
  select * into t from public.organiser_membership_tiers where id = p_tier;
  if not found or auth.uid() is null or not public.edition_org_can(t.organiser_id, 'admin') then raise exception 'tier not found' using errcode = 'P0002'; end if;
  update public.organiser_membership_tiers set archived_at = coalesce(archived_at, now()), active = false where id = p_tier;
  perform public.edition_audit(t.organiser_id, null, 'tier_archived', jsonb_build_object('tier', p_tier));
end $$;

-- Tiers the public (and any signed-in business) may see: active, not archived, organiser verified and not a test, and either free or the organiser can actually collect.
create or replace function public.edition_tier_public(t public.organiser_membership_tiers) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select t.active and t.archived_at is null and t.join_mode <> 'invite_only' and public.editions_enabled()
     and exists (select 1 from public.edition_organisers o where o.id = t.organiser_id and o.status = 'verified' and not o.is_test)
     and (t.is_free or public.edition_collect_blocker(t.organiser_id) is null)
$$;

-- ── joining: apply, invite, decide, respond, withdraw ───────────────────────────────────────────────────────────────

create or replace function public.edition_membership_open_status(t public.organiser_membership_tiers) returns text
language sql immutable set search_path = public, pg_temp as $$ select case when t.is_free then 'active' else 'pending_payment' end $$;

create or replace function public.edition_membership_apply(p_tier uuid, p_business uuid, p_interval text, p_message text default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.organiser_membership_tiers%rowtype; v_id uuid; v_status text; v_price integer; v_cool timestamptz;
begin
  if auth.uid() is null or not public.edition_biz_owner(p_business) then raise exception 'only the owner of the business can apply' using errcode = '42501'; end if;
  select * into t from public.organiser_membership_tiers where id = p_tier;
  if not found or not public.edition_tier_public(t) then raise exception 'that membership is not open' using errcode = '23514'; end if;
  if not exists (select 1 from public.local_businesses b where b.id = p_business and b.is_active) then raise exception 'that business is not listed' using errcode = '23514'; end if;
  if not t.is_free and p_interval not in ('monthly', 'annual') then raise exception 'choose monthly or annual' using errcode = '22023'; end if;
  v_price := case p_interval when 'monthly' then t.price_monthly_pence when 'annual' then t.price_annual_pence end;
  if not t.is_free and v_price is null then raise exception 'that billing choice is not offered for this tier' using errcode = '23514'; end if;
  if char_length(coalesce(p_message, '')) > 500 then raise exception 'message is too long' using errcode = '22001'; end if;
  if exists (select 1 from public.organiser_memberships m where m.organiser_id = t.organiser_id and m.business_id = p_business and m.status in ('applied', 'invited', 'pending_payment', 'active', 'past_due', 'cancel_at_period_end')) then
    raise exception 'already a member or already applied' using errcode = '23505'; end if;
  if t.max_members is not null and (select count(*) from public.organiser_memberships m where m.tier_id = t.id and m.status in ('pending_payment', 'active', 'past_due', 'cancel_at_period_end')) >= t.max_members then raise exception 'this tier is full' using errcode = '23514'; end if;
  select max(m.decided_at) into v_cool from public.organiser_memberships m where m.organiser_id = t.organiser_id and m.business_id = p_business and m.status = 'declined' and m.source = 'application';
  if v_cool is not null and v_cool > now() - interval '30 days' then raise exception 'your last application was declined recently; please wait before applying again' using errcode = '23514'; end if;
  v_status := case when t.join_mode = 'open' then public.edition_membership_open_status(t) else 'applied' end;
  insert into public.organiser_memberships (organiser_id, tier_id, business_id, owner_user_id, status, billing_interval, source, price_pence, vat_mode, message, joined_at, created_by)
  values (t.organiser_id, t.id, p_business, auth.uid(), v_status, case when t.is_free then 'complimentary' else p_interval end, 'application', v_price, t.vat_mode, nullif(btrim(p_message), ''), case when v_status = 'active' then now() end, auth.uid()) returning id into v_id;
  perform public.edition_mem_event(v_id, 'applied', jsonb_build_object('status', v_status));
  perform public.edition_audit(t.organiser_id, null, 'membership_applied', jsonb_build_object('membership', v_id));
  return v_id;
end $$;

create or replace function public.edition_membership_invite(p_org uuid, p_tier uuid, p_business uuid, p_interval text, p_message text default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.organiser_membership_tiers%rowtype; v_id uuid; v_price integer;
begin
  if auth.uid() is null or not public.edition_org_can(p_org, 'admin') then raise exception 'only an organiser admin can invite members' using errcode = '42501'; end if;
  if not public.edition_org_entitled(p_org, 'memberships') then raise exception 'memberships are not included in your package' using errcode = '23514'; end if;
  select * into t from public.organiser_membership_tiers where id = p_tier and organiser_id = p_org and active and archived_at is null;
  if not found then raise exception 'tier not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.local_businesses b where b.id = p_business and b.is_active and b.owner_id is not null and not public.is_discovery_hidden('business', b.id)) then raise exception 'that business is not available to invite (it may not be claimed yet)' using errcode = '23514'; end if;
  if not t.is_free and p_interval not in ('monthly', 'annual') then raise exception 'choose monthly or annual' using errcode = '22022'; end if;
  v_price := case p_interval when 'monthly' then t.price_monthly_pence when 'annual' then t.price_annual_pence end;
  if not t.is_free and v_price is null then raise exception 'that billing choice is not offered for this tier' using errcode = '23514'; end if;
  if exists (select 1 from public.organiser_memberships m where m.organiser_id = p_org and m.business_id = p_business and m.status in ('applied', 'invited', 'pending_payment', 'active', 'past_due', 'cancel_at_period_end')) then raise exception 'already a member or already invited' using errcode = '23505'; end if;
  if exists (select 1 from public.organiser_memberships m where m.organiser_id = p_org and m.business_id = p_business and m.status = 'declined' and m.source = 'invitation' and m.decided_at > now() - interval '30 days') then raise exception 'they declined recently; please wait before inviting again' using errcode = '23514'; end if;
  if (select count(*) from public.organiser_memberships m where m.business_id = p_business and m.status = 'invited') >= 10 then raise exception 'they already have several invitations waiting' using errcode = '23514'; end if;
  insert into public.organiser_memberships (organiser_id, tier_id, business_id, status, billing_interval, source, price_pence, vat_mode, message, created_by)
  values (p_org, t.id, p_business, 'invited', case when t.is_free then 'complimentary' else p_interval end, 'invitation', v_price, t.vat_mode, nullif(btrim(p_message), ''), auth.uid()) returning id into v_id;
  perform public.edition_mem_event(v_id, 'invited');
  perform public.edition_audit(p_org, null, 'membership_invited', jsonb_build_object('membership', v_id));
  return v_id;
end $$;

-- organiser side: approve or decline an application
create or replace function public.edition_membership_decide(p_membership uuid, p_decision text, p_note text default null) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.organiser_memberships%rowtype; t public.organiser_membership_tiers%rowtype; v_to text;
begin
  select * into m from public.organiser_memberships where id = p_membership for update;
  if not found or auth.uid() is null or not public.edition_org_can(m.organiser_id, 'admin') then raise exception 'not found' using errcode = 'P0002'; end if;
  if m.status <> 'applied' then raise exception 'this application has already been answered' using errcode = '23514'; end if;
  if char_length(coalesce(p_note, '')) > 300 then raise exception 'note is too long' using errcode = '22001'; end if;
  select * into t from public.organiser_membership_tiers where id = m.tier_id;
  if p_decision = 'approve' then v_to := public.edition_membership_open_status(t); elsif p_decision = 'decline' then v_to := 'declined'; else raise exception 'unknown decision' using errcode = '22023'; end if;
  update public.organiser_memberships set status = v_to, decided_by = auth.uid(), decided_at = now(), decision_note = nullif(btrim(p_note), ''), joined_at = case when v_to = 'active' then now() else joined_at end, updated_at = now() where id = m.id;
  perform public.edition_mem_event(m.id, 'application_' || p_decision, jsonb_build_object('to', v_to));
  perform public.edition_audit(m.organiser_id, null, 'membership_' || p_decision, jsonb_build_object('membership', m.id));
  return v_to;
end $$;

-- business side: accept or decline an invitation
create or replace function public.edition_membership_respond(p_membership uuid, p_accept boolean, p_note text default null) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.organiser_memberships%rowtype; t public.organiser_membership_tiers%rowtype; v_to text;
begin
  select * into m from public.organiser_memberships where id = p_membership for update;
  if not found or not public.edition_biz_owner(m.business_id) then raise exception 'not found' using errcode = 'P0002'; end if;
  if m.status <> 'invited' then raise exception 'this invitation has already been answered' using errcode = '23514'; end if;
  select * into t from public.organiser_membership_tiers where id = m.tier_id;
  if p_accept and not t.is_free and public.edition_collect_blocker(m.organiser_id) is not null then raise exception 'this organiser cannot take payments right now' using errcode = '23514', hint = 'organiser_cannot_collect'; end if;
  v_to := case when p_accept then public.edition_membership_open_status(t) else 'declined' end;
  update public.organiser_memberships set status = v_to, owner_user_id = auth.uid(), decided_by = auth.uid(), decided_at = now(), decision_note = nullif(btrim(p_note), ''), joined_at = case when v_to = 'active' then now() else joined_at end, updated_at = now() where id = m.id;
  perform public.edition_mem_event(m.id, case when p_accept then 'invitation_accepted' else 'invitation_declined' end, jsonb_build_object('to', v_to));
  return v_to;
end $$;

-- business side: take back an application or an unpaid acceptance
create or replace function public.edition_membership_withdraw(p_membership uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.organiser_memberships%rowtype;
begin
  select * into m from public.organiser_memberships where id = p_membership for update;
  if not found or not public.edition_biz_owner(m.business_id) then raise exception 'not found' using errcode = 'P0002'; end if;
  if m.status not in ('applied', 'invited', 'pending_payment') then raise exception 'only an application that has not been paid can be withdrawn; cancel the membership instead' using errcode = '23514'; end if;
  update public.organiser_memberships set status = 'withdrawn', updated_at = now() where id = m.id;
  perform public.edition_mem_event(m.id, 'withdrawn');
end $$;

-- ── leaving and ending ──────────────────────────────────────────────────────────────────────────────────────────────

-- Business: stop at the end of the paid period (benefits continue until then). Card memberships also need the provider told: the edge function does that
-- using the stored subscription id; this records the owner's intent and is safe to call first.
create or replace function public.edition_membership_cancel(p_membership uuid) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.organiser_memberships%rowtype; v_to text;
begin
  select * into m from public.organiser_memberships where id = p_membership for update;
  if not found or not public.edition_biz_owner(m.business_id) then raise exception 'not found' using errcode = 'P0002'; end if;
  if m.status not in ('active', 'past_due') then raise exception 'only a current membership can be cancelled' using errcode = '23514'; end if;
  v_to := case when m.status = 'past_due' then 'cancelled' else 'cancel_at_period_end' end;
  update public.organiser_memberships set status = v_to, cancel_requested_at = now(), updated_at = now() where id = m.id;
  perform public.edition_mem_event(m.id, 'cancel_requested', jsonb_build_object('to', v_to));
  return v_to;
end $$;

-- Organiser: end a member now or at period end (with a reason the member can see). Refunds are separate and explicit.
create or replace function public.edition_membership_end(p_membership uuid, p_when text, p_note text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.organiser_memberships%rowtype; v_to text;
begin
  select * into m from public.organiser_memberships where id = p_membership for update;
  if not found or auth.uid() is null or not public.edition_org_can(m.organiser_id, 'admin') then raise exception 'not found' using errcode = 'P0002'; end if;
  if m.status not in ('active', 'past_due', 'cancel_at_period_end') then raise exception 'only a current membership can be ended' using errcode = '23514'; end if;
  if char_length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'say why, so the member can see it' using errcode = '23514'; end if;
  v_to := case when p_when = 'now' then 'cancelled' when p_when = 'period_end' then 'cancel_at_period_end' else null end;
  if v_to is null then raise exception 'choose now or period_end' using errcode = '22023'; end if;
  update public.organiser_memberships set status = v_to, decision_note = btrim(p_note), cancel_requested_at = now(), updated_at = now(), current_period_end = case when v_to = 'cancelled' then least(coalesce(current_period_end, now()), now()) else current_period_end end where id = m.id;
  perform public.edition_mem_event(m.id, 'ended_by_organiser', jsonb_build_object('when', p_when));
  perform public.edition_audit(m.organiser_id, null, 'membership_ended', jsonb_build_object('membership', m.id, 'when', p_when));
  return v_to;
end $$;

create or replace function public.edition_membership_set_note(p_membership uuid, p_note text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_org uuid;
begin
  select organiser_id into v_org from public.organiser_memberships where id = p_membership;
  if v_org is null or auth.uid() is null or not public.edition_org_can(v_org, 'editor') then raise exception 'not found' using errcode = 'P0002'; end if;
  if char_length(coalesce(p_note, '')) > 1000 then raise exception 'note is too long' using errcode = '22001'; end if;
  update public.organiser_memberships set organiser_note = nullif(btrim(p_note), ''), updated_at = now() where id = p_membership;
end $$;

-- ── offline and complimentary records (organiser; needs the 'offline_records' entitlement) ──────────────────────────

create or replace function public.edition_membership_record_offline(p_org uuid, p_tier uuid, p_business uuid, p_kind text, p_start timestamptz, p_end timestamptz, p_amount integer, p_method text, p_note text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.organiser_membership_tiers%rowtype; v_id uuid; v_pay uuid;
begin
  if auth.uid() is null or not public.edition_org_can(p_org, 'admin') then raise exception 'only an organiser admin can record memberships' using errcode = '42501'; end if;
  if not public.edition_org_entitled(p_org, 'offline_records') then raise exception 'recording offline memberships is not included in your package' using errcode = '23514', hint = 'no_offline_entitlement'; end if;
  if p_kind not in ('offline', 'complimentary') then raise exception 'choose offline or complimentary' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'a note is required (for example the receipt reference or why it is free)' using errcode = '23514'; end if;
  if p_end is null or p_end <= coalesce(p_start, now()) or p_end > coalesce(p_start, now()) + interval '13 months' then raise exception 'the period must end after it starts and be at most a year' using errcode = '23514'; end if;
  if p_kind = 'offline' and (p_amount is null or p_amount < 0 or p_amount > 10000000 or p_method not in ('cheque', 'bank_transfer', 'cash', 'imported', 'other')) then raise exception 'record the amount and how it was paid' using errcode = '23514'; end if;
  select * into t from public.organiser_membership_tiers where id = p_tier and organiser_id = p_org and archived_at is null;
  if not found then raise exception 'tier not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.local_businesses b where b.id = p_business and b.is_active) then raise exception 'that business is not in the directory' using errcode = '23514'; end if;
  if exists (select 1 from public.organiser_memberships m where m.organiser_id = p_org and m.business_id = p_business and m.status in ('applied', 'invited', 'pending_payment', 'active', 'past_due', 'cancel_at_period_end')) then raise exception 'already a member or already has a pending application' using errcode = '23505'; end if;
  if t.max_members is not null and (select count(*) from public.organiser_memberships m where m.tier_id = t.id and m.status in ('pending_payment', 'active', 'past_due', 'cancel_at_period_end')) >= t.max_members then raise exception 'this tier is full' using errcode = '23514'; end if;
  if public.edition_org_limit(p_org, 'memberships') is not null and (select count(*) from public.organiser_memberships m where m.organiser_id = p_org and m.status in ('active', 'past_due', 'cancel_at_period_end')) >= public.edition_org_limit(p_org, 'memberships') then raise exception 'you have reached the member limit of your package' using errcode = '23514'; end if;
  insert into public.organiser_memberships (organiser_id, tier_id, business_id, status, billing_interval, source, price_pence, vat_mode, current_period_start, current_period_end, joined_at, decided_by, decided_at, organiser_note, created_by)
  values (p_org, p_tier, p_business, 'active', p_kind, 'offline_record', coalesce(p_amount, 0), 'none', coalesce(p_start, now()), p_end, now(), auth.uid(), now(), btrim(p_note), auth.uid()) returning id into v_id;
  v_pay := public.edition_record_payment_row(p_org, p_business, 'membership', v_id, case when p_kind = 'offline' then 'offline' else 'complimentary' end, 'succeeded', coalesce(p_amount, 0), 0, 'none', 0, coalesce(p_amount, 0), coalesce(p_amount, 0),
    null, null, null, coalesce(p_start, now()), p_end, case when p_kind = 'offline' then p_method end, auth.uid(), null, btrim(p_note), null);
  perform public.edition_mem_event(v_id, 'recorded_offline', jsonb_build_object('kind', p_kind, 'amount', p_amount));
  perform public.edition_audit(p_org, null, 'membership_recorded_offline', jsonb_build_object('membership', v_id, 'kind', p_kind, 'amount', p_amount));
  return v_id;
end $$;

create or replace function public.edition_membership_renew_offline(p_membership uuid, p_end timestamptz, p_amount integer, p_method text, p_note text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.organiser_memberships%rowtype; v_start timestamptz;
begin
  select * into m from public.organiser_memberships where id = p_membership for update;
  if not found or auth.uid() is null or not public.edition_org_can(m.organiser_id, 'admin') then raise exception 'not found' using errcode = 'P0002'; end if;
  if m.billing_interval not in ('offline', 'complimentary') then raise exception 'only offline or complimentary memberships are renewed by hand' using errcode = '23514'; end if;
  if not public.edition_org_entitled(m.organiser_id, 'offline_records') then raise exception 'recording offline memberships is not included in your package' using errcode = '23514'; end if;
  if m.status not in ('active', 'expired', 'cancelled', 'cancel_at_period_end') then raise exception 'this membership cannot be renewed' using errcode = '23514'; end if;
  if char_length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'a note is required' using errcode = '23514'; end if;
  if exists (select 1 from public.organiser_memberships x where x.organiser_id = m.organiser_id and x.business_id = m.business_id and x.id <> m.id and x.status in ('applied', 'invited', 'pending_payment', 'active', 'past_due', 'cancel_at_period_end')) then raise exception 'this business has another membership in progress' using errcode = '23505'; end if;
  v_start := greatest(now(), coalesce(m.current_period_end, now()));
  if p_end <= v_start or p_end > v_start + interval '13 months' then raise exception 'the new period must end after it starts and be at most a year' using errcode = '23514'; end if;
  update public.organiser_memberships set status = 'active', current_period_start = v_start, current_period_end = p_end, cancel_requested_at = null, updated_at = now() where id = m.id;
  perform public.edition_record_payment_row(m.organiser_id, m.business_id, 'membership', m.id, case when m.billing_interval = 'offline' then 'offline' else 'complimentary' end, 'succeeded', coalesce(p_amount, 0), 0, 'none', 0, coalesce(p_amount, 0), coalesce(p_amount, 0),
    null, null, null, v_start, p_end, case when m.billing_interval = 'offline' then p_method end, auth.uid(), null, btrim(p_note), null);
  perform public.edition_mem_event(m.id, 'renewed_offline', jsonb_build_object('until', p_end));
end $$;

-- ── paying by card: prepare (person) and the service-role provider events ───────────────────────────────────────────

-- Returns exactly what the payment function must charge, computed here from the stored tier snapshot. The caller supplies nothing about price.
create or replace function public.edition_membership_pay_prepare(p_membership uuid, p_attempt text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.organiser_memberships%rowtype; t public.organiser_membership_tiers%rowtype; b record; v_block text; v_max integer;
begin
  select * into m from public.organiser_memberships where id = p_membership;
  if not found or not public.edition_biz_owner(m.business_id) then raise exception 'not found' using errcode = 'P0002'; end if;
  if m.status not in ('pending_payment', 'past_due') then raise exception 'this membership is not waiting for payment' using errcode = '23514'; end if;
  if m.billing_interval not in ('monthly', 'annual') then raise exception 'this membership is not paid by card' using errcode = '23514'; end if;
  if char_length(coalesce(p_attempt, '')) not between 8 and 80 then raise exception 'invalid attempt id' using errcode = '22023'; end if;
  -- a person on the organiser's own team cannot pay the organiser (same rule as hubs and tickets)
  if public.edition_org_role(m.organiser_id) is not null then raise exception 'you cannot pay an organiser you are part of; ask them to record it instead' using errcode = '23514', hint = 'self_payment'; end if;
  v_block := public.edition_collect_blocker(m.organiser_id);
  if v_block is not null then raise exception 'this organiser cannot take payments right now (%)', v_block using errcode = '23514', hint = v_block; end if;
  select * into t from public.organiser_membership_tiers where id = m.tier_id;
  v_max := public.edition_commerce_cfg('editions.commerce.max_charge_pence', '500000')::integer;
  select * into b from public.edition_charge_breakdown('membership', m.price_pence, m.vat_mode, m.organiser_id);
  if b.charge_pence > v_max then raise exception 'that amount is above the allowed limit' using errcode = '23514'; end if;
  return jsonb_build_object('membership_id', m.id, 'organiser_id', m.organiser_id, 'business_id', m.business_id, 'interval', m.billing_interval, 'price_pence', b.price_pence, 'vat_pence', b.vat_pence,
    'platform_fee_pence', b.platform_fee_pence, 'charge_pence', b.charge_pence, 'net_to_organiser_pence', b.net_to_organiser_pence, 'vat_mode', b.vat_mode, 'tier_name', t.name,
    'stripe_price_id', case m.billing_interval when 'monthly' then t.stripe_price_monthly_id else t.stripe_price_annual_id end, 'tier_id', t.id, 'attempt', p_attempt);
end $$;

-- Service role: the connected account to route funds to (never exposed to people).
create or replace function public.edition_payout_account_for(p_org uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select stripe_account_id from public.edition_payout_accounts where organiser_id = p_org
$$;

create or replace function public.edition_tier_set_stripe_price(p_tier uuid, p_interval text, p_price_id text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.organiser_membership_tiers set stripe_price_monthly_id = case when p_interval = 'monthly' then p_price_id else stripe_price_monthly_id end,
    stripe_price_annual_id = case when p_interval = 'annual' then p_price_id else stripe_price_annual_id end where id = p_tier
$$;

-- Service role: a membership payment (first or renewal) succeeded. Idempotent on the invoice (or the PaymentIntent for one-off). The charged amount must equal
-- what the stored snapshot says it should be; a mismatch is refused (and surfaced to reconciliation) rather than activating on the wrong money.
create or replace function public.edition_membership_payment_succeeded(p_membership uuid, p_subscription text, p_payment_intent text, p_invoice text, p_charge text,
  p_period_start timestamptz, p_period_end timestamptz, p_charge_pence integer, p_stripe_fee integer default null, p_platform_fee integer default null) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.organiser_memberships%rowtype; b record; v_dup uuid; v_pay uuid;
begin
  select * into m from public.organiser_memberships where id = p_membership for update;
  if not found then raise exception 'unknown membership' using errcode = 'P0002'; end if;
  if p_invoice is not null then select id into v_dup from public.edition_payments where stripe_invoice_id = p_invoice;
  else select id into v_dup from public.edition_payments where stripe_payment_intent_id = p_payment_intent and stripe_invoice_id is null; end if;
  if v_dup is not null then return 'already_recorded'; end if;
  if m.status not in ('pending_payment', 'active', 'past_due', 'cancel_at_period_end', 'expired') then raise exception 'membership is not payable in status %', m.status using errcode = '23514'; end if;
  select * into b from public.edition_charge_breakdown('membership', m.price_pence, m.vat_mode, m.organiser_id);
  if p_charge_pence is distinct from b.charge_pence then raise exception 'charged amount does not match the membership price' using errcode = '23514', hint = 'amount_mismatch'; end if;
  -- Subscriptions can only carry the platform fee as a percentage, so the provider's actual fee is the truth for the ledger; a difference from the computed fee is
  -- surfaced to reconciliation rather than hidden.
  v_pay := public.edition_record_payment_row(m.organiser_id, m.business_id, 'membership', m.id, 'stripe', 'succeeded', b.price_pence, b.vat_pence, b.vat_mode, coalesce(p_platform_fee, b.platform_fee_pence), b.charge_pence,
    b.charge_pence - coalesce(p_platform_fee, b.platform_fee_pence), p_payment_intent, p_invoice, p_charge, p_period_start, p_period_end, null, null, m.owner_user_id, null, null);
  if p_platform_fee is not null and p_platform_fee is distinct from b.platform_fee_pence then
    insert into public.edition_reconciliation_exceptions (organiser_id, kind, provider_ref, payment_id, detail) values (m.organiser_id, 'fee_mismatch', coalesce(p_invoice, p_payment_intent), v_pay, jsonb_build_object('provider', p_platform_fee, 'computed', b.platform_fee_pence)) on conflict do nothing;
  end if;
  if p_stripe_fee is not null then update public.edition_payments set stripe_fee_pence = p_stripe_fee where id = v_pay; end if;
  update public.organiser_memberships set status = case when status = 'cancel_at_period_end' then 'cancel_at_period_end' else 'active' end, past_due_since = null, stripe_subscription_id = coalesce(p_subscription, stripe_subscription_id),
    current_period_start = p_period_start, current_period_end = p_period_end, joined_at = coalesce(joined_at, now()), updated_at = now() where id = m.id;
  perform public.edition_mem_event(m.id, 'payment_succeeded', jsonb_build_object('charge', p_charge_pence, 'period_end', p_period_end));
  return 'recorded';
end $$;

create or replace function public.edition_membership_payment_failed(p_membership uuid, p_invoice text, p_attempt_count integer) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.organiser_memberships%rowtype;
begin
  select * into m from public.organiser_memberships where id = p_membership for update;
  if not found then raise exception 'unknown membership' using errcode = 'P0002'; end if;
  if m.status = 'active' then update public.organiser_memberships set status = 'past_due', past_due_since = now(), updated_at = now() where id = m.id;
    perform public.edition_mem_event(m.id, 'payment_failed', jsonb_build_object('attempt', p_attempt_count)); return 'past_due';
  end if;
  perform public.edition_mem_event(m.id, 'payment_failed', jsonb_build_object('attempt', p_attempt_count, 'status', m.status));
  return m.status;
end $$;

create or replace function public.edition_membership_subscription_changed(p_membership uuid, p_status text, p_cancel_at_period_end boolean, p_period_end timestamptz) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.organiser_memberships%rowtype;
begin
  select * into m from public.organiser_memberships where id = p_membership for update;
  if not found then raise exception 'unknown membership' using errcode = 'P0002'; end if;
  if p_status = 'canceled' then update public.organiser_memberships set status = 'cancelled', current_period_end = least(coalesce(current_period_end, now()), now()), updated_at = now() where id = m.id and status not in ('cancelled', 'expired');
  elsif m.status in ('active', 'cancel_at_period_end') then
    update public.organiser_memberships set status = case when p_cancel_at_period_end then 'cancel_at_period_end' else 'active' end, current_period_end = coalesce(p_period_end, current_period_end), updated_at = now() where id = m.id;
  end if;
  perform public.edition_mem_event(m.id, 'subscription_' || coalesce(p_status, 'changed'), jsonb_build_object('cancel_at_period_end', p_cancel_at_period_end));
end $$;

-- Service role / scheduled: housekeeping the provider cannot do for us. Returns counts for monitoring.
create or replace function public.edition_membership_sweep() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_expired int := 0; v_cancelled int := 0; v_withdrawn int := 0; v_grace int := public.edition_commerce_cfg('editions.commerce.grace_days', '14')::int; n int;
begin
  update public.organiser_memberships set status = 'expired', updated_at = now() where status = 'past_due' and past_due_since + make_interval(days => v_grace) < now(); get diagnostics n = row_count; v_expired := v_expired + n;
  update public.organiser_memberships set status = 'expired', updated_at = now() where status = 'active' and billing_interval in ('offline', 'complimentary') and current_period_end < now(); get diagnostics n = row_count; v_expired := v_expired + n;
  update public.organiser_memberships set status = 'cancelled', updated_at = now() where status = 'cancel_at_period_end' and current_period_end < now(); get diagnostics n = row_count; v_cancelled := n;
  update public.organiser_memberships set status = 'withdrawn', updated_at = now() where (status = 'pending_payment' and updated_at < now() - interval '30 days') or (status in ('invited', 'applied') and updated_at < now() - interval '60 days'); get diagnostics n = row_count; v_withdrawn := n;
  return jsonb_build_object('expired', v_expired, 'cancelled', v_cancelled, 'withdrawn', v_withdrawn);
end $$;

-- ── read models ─────────────────────────────────────────────────────────────────────────────────────────────────────

-- Organiser-private member list (includes private notes; never exposed to businesses).
create or replace function public.edition_org_members(p_org uuid)
returns table (membership_id uuid, business_id uuid, business_name text, tier_id uuid, tier_name text, status text, billing_interval text, source text, price_pence integer,
               current_period_end timestamptz, joined_at timestamptz, past_due_since timestamptz, organiser_note text, message text, last_payment_at timestamptz, last_payment_pence integer, live boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not (public.edition_org_can(p_org, 'editor') or public.is_admin()) then raise exception 'not permitted' using errcode = '42501'; end if;
  return query select m.id, m.business_id, b.name, t.id, t.name, m.status, m.billing_interval, m.source, m.price_pence, m.current_period_end, m.joined_at, m.past_due_since, m.organiser_note, m.message,
    (select max(p.created_at) from public.edition_payments p where p.kind = 'membership' and p.ref_id = m.id and p.status in ('succeeded', 'partially_refunded')),
    (select p.charge_pence from public.edition_payments p where p.kind = 'membership' and p.ref_id = m.id and p.status in ('succeeded', 'partially_refunded') order by p.created_at desc limit 1), public.edition_membership_live(m)
    from public.organiser_memberships m join public.organiser_membership_tiers t on t.id = m.tier_id join public.local_businesses b on b.id = m.business_id
   where m.organiser_id = p_org order by (m.status in ('applied')) desc, (m.status = 'past_due') desc, b.name;
end $$;

-- What the owner of a business sees: their memberships and invitations across organisers, with the timeline minus private notes.
create or replace function public.edition_my_memberships()
returns table (membership_id uuid, business_id uuid, business_name text, organiser_id uuid, organiser_name text, organiser_slug text, tier_name text, benefits jsonb, edition_benefit text, discount_percent integer,
               status text, billing_interval text, source text, price_pence integer, vat_mode text, current_period_end timestamptz, cancel_requested_at timestamptz, message text, decision_note text,
               can_pay boolean, pay_blocker text, live boolean, created_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select m.id, m.business_id, b.name, o.id, o.name, case when o.status = 'verified' and not o.is_test then o.slug end, t.name, t.benefits, t.edition_benefit, t.edition_discount_percent, m.status, m.billing_interval, m.source, m.price_pence, m.vat_mode,
         m.current_period_end, m.cancel_requested_at, m.message, m.decision_note,
         (m.status in ('pending_payment', 'past_due') and m.billing_interval in ('monthly', 'annual') and public.edition_collect_blocker(m.organiser_id) is null and public.edition_org_role(m.organiser_id) is null),
         case when m.status in ('pending_payment', 'past_due') then coalesce(public.edition_collect_blocker(m.organiser_id), case when public.edition_org_role(m.organiser_id) is not null then 'self_payment' end) end,
         public.edition_membership_live(m), m.created_at
    from public.organiser_memberships m join public.organiser_membership_tiers t on t.id = m.tier_id join public.edition_organisers o on o.id = m.organiser_id join public.local_businesses b on b.id = m.business_id
   where auth.uid() is not null and public.edition_biz_owner(m.business_id) order by (m.status in ('invited', 'pending_payment', 'past_due')) desc, m.created_at desc
$$;

create or replace function public.edition_membership_timeline(p_membership uuid) returns table (at timestamptz, event text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare m public.organiser_memberships%rowtype;
begin
  select * into m from public.organiser_memberships where id = p_membership;
  if not found or not (public.edition_biz_owner(m.business_id) or public.edition_org_can(m.organiser_id, 'editor') or public.is_admin()) then raise exception 'not found' using errcode = 'P0002'; end if;
  return query select e.at, e.event from public.organiser_membership_events e where e.membership_id = p_membership order by e.at;
end $$;

-- Tiers shown on an organiser's public membership page.
create or replace function public.edition_public_tiers(p_org_slug text)
returns table (tier_id uuid, organiser_id uuid, organiser_name text, name text, description text, benefits jsonb, price_monthly_pence integer, price_annual_pence integer, is_free boolean, vat_mode text,
               join_mode text, edition_benefit text, discount_percent integer, full boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select t.id, o.id, o.name, t.name, t.description, t.benefits, t.price_monthly_pence, t.price_annual_pence, t.is_free, t.vat_mode, t.join_mode, t.edition_benefit, t.edition_discount_percent,
         (t.max_members is not null and (select count(*) from public.organiser_memberships m where m.tier_id = t.id and m.status in ('pending_payment', 'active', 'past_due', 'cancel_at_period_end')) >= t.max_members)
    from public.organiser_membership_tiers t join public.edition_organisers o on o.id = t.organiser_id
   where o.slug = p_org_slug and public.edition_tier_public(t) order by t.sort, t.price_monthly_pence nulls last
$$;

create or replace function public.edition_org_tiers(p_org uuid) returns setof public.organiser_membership_tiers
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not (public.edition_org_can(p_org, 'editor') or public.is_admin()) then raise exception 'not permitted' using errcode = '42501'; end if;
  return query select t.* from public.organiser_membership_tiers t where t.organiser_id = p_org order by t.archived_at nulls first, t.sort;
end $$;

create or replace function public.edition_membership_renewals_due(p_org uuid, p_days integer default 30)
returns table (membership_id uuid, business_name text, tier_name text, billing_interval text, current_period_end timestamptz, status text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not (public.edition_org_can(p_org, 'editor') or public.is_admin()) then raise exception 'not permitted' using errcode = '42501'; end if;
  return query select m.id, b.name, t.name, m.billing_interval, m.current_period_end, m.status from public.organiser_memberships m join public.local_businesses b on b.id = m.business_id join public.organiser_membership_tiers t on t.id = m.tier_id
   where m.organiser_id = p_org and m.status in ('active', 'cancel_at_period_end') and m.current_period_end between now() and now() + make_interval(days => least(greatest(p_days, 1), 120)) order by m.current_period_end;
end $$;

-- Service role (the email job in R5): memberships needing a reminder that has not been sent for this period.
create or replace function public.edition_membership_reminders_due() returns table (membership_id uuid, kind text, period_end timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select m.id, k.kind, m.current_period_end from public.organiser_memberships m
   cross join lateral (values ('renewal_30d', interval '30 days'), ('renewal_7d', interval '7 days')) as k(kind, win)
   where m.status = 'active' and m.billing_interval in ('offline', 'complimentary') and m.current_period_end between now() and now() + k.win
     and not exists (select 1 from public.organiser_membership_reminders r where r.membership_id = m.id and r.kind = k.kind and r.period_end = m.current_period_end)
$$;
create or replace function public.edition_membership_reminder_sent(p_membership uuid, p_kind text, p_period_end timestamptz) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.organiser_membership_reminders (membership_id, kind, period_end) values (p_membership, p_kind, p_period_end) on conflict do nothing
$$;

-- Find Directory businesses to invite or record as members (organiser admins). Same visibility rules as the Edition partner search.
create or replace function public.edition_member_find_businesses(p_org uuid, p_q text)
returns table (id uuid, name text, category text, address text, claimed boolean, membership_status text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_q text := btrim(coalesce(p_q, ''));
begin
  if auth.uid() is null or not public.edition_org_can(p_org, 'admin') then raise exception 'not permitted' using errcode = '42501'; end if;
  if char_length(v_q) < 2 then return; end if;
  return query select b.id, b.name, b.category, b.address, (b.owner_id is not null),
      (select m.status from public.organiser_memberships m where m.organiser_id = p_org and m.business_id = b.id and m.status in ('applied', 'invited', 'pending_payment', 'active', 'past_due', 'cancel_at_period_end') limit 1)
    from public.local_businesses b where b.is_active and not public.is_discovery_hidden('business', b.id) and b.name ilike '%' || public.edition_like_escape(v_q) || '%' escape '\' order by b.name limit 20;
end $$;
revoke all on function public.edition_member_find_businesses(uuid, text) from public, anon, authenticated;
grant execute on function public.edition_member_find_businesses(uuid, text) to authenticated;

-- ── lock down ───────────────────────────────────────────────────────────────────────────────────────────────────────

alter table public.organiser_membership_tiers enable row level security;
alter table public.organiser_memberships enable row level security;
alter table public.organiser_membership_events enable row level security;
alter table public.organiser_membership_reminders enable row level security;
revoke all on public.organiser_membership_tiers, public.organiser_memberships, public.organiser_membership_events, public.organiser_membership_reminders from public, anon, authenticated;
revoke all on sequence public.organiser_membership_events_id_seq from public, anon, authenticated;
-- Direct reads are for the organiser team and admins only (everything a business sees goes through the functions above, which strip private notes).
create policy "tiers team read" on public.organiser_membership_tiers for select to authenticated using (public.edition_org_can(organiser_id, 'editor') or public.is_admin());
create policy "memberships team read" on public.organiser_memberships for select to authenticated using (public.edition_org_can(organiser_id, 'editor') or public.is_admin());
create policy "memberships owner read" on public.organiser_memberships for select to authenticated using (public.edition_biz_owner(business_id));
grant select on public.organiser_membership_tiers to authenticated;
-- A business owner may read their own membership rows, but never the organiser's private note or the provider ids: column-level grant omits them.
grant select (id, organiser_id, tier_id, business_id, owner_user_id, status, billing_interval, source, price_pence, vat_mode, current_period_start, current_period_end, past_due_since, cancel_requested_at,
  joined_at, message, decision_note, decided_by, decided_at, created_by, created_at, updated_at) on public.organiser_memberships to authenticated;

do $$ declare f text; begin
  foreach f in array array[
    'edition_biz_owner(uuid)', 'edition_mem_event(uuid,text,jsonb)', 'edition_membership_live(public.organiser_memberships)', 'edition_member_benefit(uuid,uuid)',
    'edition_tier_save(uuid,uuid,text,text,jsonb,integer,integer,boolean,text,text,text,integer,integer,integer)', 'edition_tier_archive(uuid)', 'edition_tier_public(public.organiser_membership_tiers)',
    'edition_membership_open_status(public.organiser_membership_tiers)', 'edition_membership_apply(uuid,uuid,text,text)', 'edition_membership_invite(uuid,uuid,uuid,text,text)',
    'edition_membership_decide(uuid,text,text)', 'edition_membership_respond(uuid,boolean,text)', 'edition_membership_withdraw(uuid)', 'edition_membership_cancel(uuid)',
    'edition_membership_end(uuid,text,text)', 'edition_membership_set_note(uuid,text)', 'edition_membership_record_offline(uuid,uuid,uuid,text,timestamptz,timestamptz,integer,text,text)',
    'edition_membership_renew_offline(uuid,timestamptz,integer,text,text)', 'edition_membership_pay_prepare(uuid,text)', 'edition_payout_account_for(uuid)', 'edition_tier_set_stripe_price(uuid,text,text)',
    'edition_membership_payment_succeeded(uuid,text,text,text,text,timestamptz,timestamptz,integer,integer,integer)', 'edition_membership_payment_failed(uuid,text,integer)',
    'edition_membership_subscription_changed(uuid,text,boolean,timestamptz)', 'edition_membership_sweep()', 'edition_org_members(uuid)', 'edition_my_memberships()', 'edition_membership_timeline(uuid)',
    'edition_public_tiers(text)', 'edition_org_tiers(uuid)', 'edition_membership_renewals_due(uuid,integer)', 'edition_membership_reminders_due()', 'edition_membership_reminder_sent(uuid,text,timestamptz)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'edition_tier_save(uuid,uuid,text,text,jsonb,integer,integer,boolean,text,text,text,integer,integer,integer)', 'edition_tier_archive(uuid)', 'edition_membership_apply(uuid,uuid,text,text)', 'edition_membership_invite(uuid,uuid,uuid,text,text)',
    'edition_membership_decide(uuid,text,text)', 'edition_membership_respond(uuid,boolean,text)', 'edition_membership_withdraw(uuid)', 'edition_membership_cancel(uuid)', 'edition_membership_end(uuid,text,text)',
    'edition_membership_set_note(uuid,text)', 'edition_membership_record_offline(uuid,uuid,uuid,text,timestamptz,timestamptz,integer,text,text)', 'edition_membership_renew_offline(uuid,timestamptz,integer,text,text)',
    'edition_membership_pay_prepare(uuid,text)', 'edition_org_members(uuid)', 'edition_my_memberships()', 'edition_membership_timeline(uuid)', 'edition_public_tiers(text)', 'edition_org_tiers(uuid)', 'edition_membership_renewals_due(uuid,integer)'] loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array[
    'edition_payout_account_for(uuid)', 'edition_tier_set_stripe_price(uuid,text,text)', 'edition_membership_payment_succeeded(uuid,text,text,text,text,timestamptz,timestamptz,integer,integer,integer)',
    'edition_membership_payment_failed(uuid,text,integer)', 'edition_membership_subscription_changed(uuid,text,boolean,timestamptz)', 'edition_membership_sweep()', 'edition_membership_reminders_due()', 'edition_membership_reminder_sent(uuid,text,timestamptz)'] loop
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
-- public (signed-out) read of tiers for the membership page
grant execute on function public.edition_public_tiers(text) to anon;
-- the owner-read policy calls this helper as the querying role
grant execute on function public.edition_biz_owner(uuid) to authenticated;
