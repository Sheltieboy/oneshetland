-- Business discovery: Directory tiers, the live plan, and the date a business became owner-managed.
--
-- WHAT THIS ADDS (all additive; no row is deleted, no policy or grant is loosened):
--   1. local_businesses.owner_activated_at — when the business actually became owner-managed (an approved claim, or a listing
--      created by its owner). Kept true by a trigger; clients cannot set it. Backfilled from the real records below.
--   2. Four APPENDED columns on local_businesses_public:
--        directory_rank  0 featured, 1 owner-managed, 2 unclaimed   (the Directory's tier; lower first)
--        live_tier       'premium' | 'pro' | 'free'                  (the plan the business is ACTUALLY entitled to right now)
--        owner_activated_at
--        homepage_excluded                                           (admin switch: keep this business off the homepage showcase)
--   3. An admin-controlled, audited switch to keep ONE business out of the homepage promotional showcase (homepage_excluded). It
--      changes nothing else: not the plan or its entitlement, not the Directory tier, not any feature. Only an administrator can
--      set it (admin_set_homepage_exclusion); clients cannot. It is a per-business switch, never a rule about who owns a business.
--
-- ENTITLEMENT. "Paid" is decided by business_meets_tier(), the one deployed predicate that the wallet, passes, bookings and the
-- read policies already use: the plan must be recorded high enough AND have a live (non-null, future) end date. Stripe, launch
-- grants and boosts all write the same two columns, so one test covers every route. The subscription_tier IN (...) guard in front
-- only avoids calling the function for free rows; it never widens the result (the function is false for them anyway).
--
-- OWNER-MANAGED. owner_activated_at IS NOT NULL (the ownership record; a claim and an owner-created listing both set it) OR the
-- existing is_claimed flag, so nothing the Directory already treats as claimed is demoted.
--
-- NO SECURITY DEFINER. local_businesses_public is security_invoker and anon cannot read owner_id, so an earlier draft used a
-- SECURITY DEFINER helper to learn "has an owner". owner_activated_at removes that need: it is a plain column the view can read
-- (column grant below), with the invariant "owner_id IS NULL  <=>  owner_activated_at IS NULL" held by the trigger and a CHECK.
--
-- VISIBILITY. Unchanged. Hidden/inactive listings are excluded exactly as before by the table's RLS and the callers' is_active
-- filters. The view is re-created WITH (security_invoker = true): CREATE OR REPLACE VIEW replaces the view's options, so leaving
-- it out would silently turn the view owner-privileged, bypass row security and expose hidden listings.
--
-- ROLLBACK: stop reading the new columns in the web (nothing else uses them) and leave them in place; they are harmless. To
-- remove: re-create local_businesses_public without the last four columns (same options: security_invoker=true, same grants),
-- drop trigger tg_zzz_owner_activation / tg_zzz_homepage_exclusion_lock on local_businesses, drop functions tg_owner_activation(),
-- tg_homepage_exclusion_lock(), admin_set_homepage_exclusion(uuid, boolean, text), admin_homepage_exclusions(), drop table
-- homepage_exclusion_log, drop constraint local_businesses_owner_activation_consistent, drop columns owner_activated_at and
-- homepage_excluded[_reason|_at|_by]. To put the seeded business back on the homepage without rolling back: use the admin screen.

-- 1. The ownership activation date ------------------------------------------------------------------------------------------
alter table public.local_businesses add column if not exists owner_activated_at timestamptz;

-- Backfill from what the data actually records, most precise first:
--   an APPROVED claim's review date  >  claimed_at  >  created_at (an owner-created listing was owned from the moment it was inserted).
-- Done BEFORE the trigger and the constraint exist, and only for rows that have an owner and no date yet, so it is safe to re-run.
update public.local_businesses b
   set owner_activated_at = coalesce(
         (select max(c.reviewed_at) from public.business_claims c
           where c.business_id = b.id and c.status = 'approved' and c.reviewed_at is not null),
         b.claimed_at,
         b.created_at)
 where b.owner_id is not null and b.owner_activated_at is null;

create or replace function public.tg_owner_activation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_trusted boolean := public.tg_is_trusted_writer();
begin
  -- No owner, no activation date.
  if new.owner_id is null then
    new.owner_activated_at := null;
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- Created with an owner: owned from now. Only a trusted writer (service role, migration, admin) may supply a date.
    if not v_trusted or new.owner_activated_at is null then new.owner_activated_at := now(); end if;
  elsif old.owner_id is null then
    -- Ownership BEGINS here (an approved claim, or an admin assigning an owner).
    if not v_trusted or new.owner_activated_at is null then new.owner_activated_at := now(); end if;
  else
    -- Already owner-managed: the date does not move for clients. A trusted writer may correct it.
    if not v_trusted or new.owner_activated_at is null then new.owner_activated_at := old.owner_activated_at; end if;
  end if;
  return new;
end;
$$;

revoke all on function public.tg_owner_activation() from public, anon, authenticated;

-- Named so it fires AFTER tg_zz_lock_business_columns (which restores owner_id for clients), and sees the final owner_id.
drop trigger if exists tg_zzz_owner_activation on public.local_businesses;
create trigger tg_zzz_owner_activation
  before insert or update on public.local_businesses
  for each row execute function public.tg_owner_activation();

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.local_businesses'::regclass and conname = 'local_businesses_owner_activation_consistent') then
    alter table public.local_businesses
      add constraint local_businesses_owner_activation_consistent
      check ((owner_id is null) = (owner_activated_at is null));
  end if;
end $$;

-- anon/authenticated hold column-level SELECT on this table; the view reads as the caller, so the new column needs its grant.
grant select (owner_activated_at) on public.local_businesses to anon, authenticated;

create index if not exists idx_local_businesses_owner_activated
  on public.local_businesses (owner_activated_at desc) where owner_activated_at is not null and is_active;

comment on column public.local_businesses.owner_activated_at is
  'When this business became owner-managed (approved claim, or created by its owner). Set by trigger; NULL exactly when owner_id is NULL.';

-- 1b. Admin-controlled exclusion from homepage promotional placement ------------------------------------------------------------
alter table public.local_businesses
  add column if not exists homepage_excluded        boolean not null default false,
  add column if not exists homepage_excluded_reason text,
  add column if not exists homepage_excluded_at     timestamptz,
  add column if not exists homepage_excluded_by     uuid;

-- Only the boolean is public (the showcase needs it). Reason / who / when are NOT granted to anon or authenticated.
grant select (homepage_excluded) on public.local_businesses to anon, authenticated;

-- Append-only history. RLS on with no policies and no grants: reachable only through the SECURITY DEFINER functions below.
create table if not exists public.homepage_exclusion_log (
  id          bigint generated always as identity primary key,
  business_id uuid not null references public.local_businesses(id) on delete cascade,
  excluded    boolean not null,
  reason      text,
  actor       uuid,
  created_at  timestamptz not null default now()
);
alter table public.homepage_exclusion_log enable row level security;
revoke all on public.homepage_exclusion_log from public, anon, authenticated;

-- Clients (owners) can never set or clear their own exclusion; administrators, the service role and migrations can.
create or replace function public.tg_homepage_exclusion_lock()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.tg_is_trusted_writer() then return new; end if;
  if tg_op = 'INSERT' then
    new.homepage_excluded := false; new.homepage_excluded_reason := null; new.homepage_excluded_at := null; new.homepage_excluded_by := null;
  else
    new.homepage_excluded := old.homepage_excluded; new.homepage_excluded_reason := old.homepage_excluded_reason;
    new.homepage_excluded_at := old.homepage_excluded_at; new.homepage_excluded_by := old.homepage_excluded_by;
  end if;
  return new;
end;
$$;
revoke all on function public.tg_homepage_exclusion_lock() from public, anon, authenticated;

drop trigger if exists tg_zzz_homepage_exclusion_lock on public.local_businesses;
create trigger tg_zzz_homepage_exclusion_lock
  before insert or update on public.local_businesses
  for each row execute function public.tg_homepage_exclusion_lock();

-- The one write path for the switch. SECURITY DEFINER because it records the audit row; it checks is_admin() first and touches
-- only the four exclusion columns of one named business. It never reads or changes a plan, a tier or a listing's content.
create or replace function public.admin_set_homepage_exclusion(p_business_id uuid, p_excluded boolean, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name   text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_uid    uuid := auth.uid();
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can change homepage promotion' using errcode = '42501';
  end if;
  if p_business_id is null or p_excluded is null then
    raise exception 'A business and a yes/no are required' using errcode = '22023';
  end if;
  if p_excluded and (v_reason is null or char_length(v_reason) < 5) then
    raise exception 'Say why (at least 5 characters) so the next person knows' using errcode = '22023';
  end if;

  select name into v_name from public.local_businesses where id = p_business_id for update;
  if not found then
    raise exception 'No such business: %', p_business_id using errcode = 'P0002';
  end if;

  update public.local_businesses
     set homepage_excluded        = p_excluded,
         homepage_excluded_reason = case when p_excluded then v_reason end,
         homepage_excluded_at     = case when p_excluded then now() end,
         homepage_excluded_by     = case when p_excluded then v_uid end
   where id = p_business_id;

  insert into public.homepage_exclusion_log (business_id, excluded, reason, actor)
  values (p_business_id, p_excluded, v_reason, v_uid);

  return jsonb_build_object('business_id', p_business_id, 'name', v_name, 'excluded', p_excluded);
end;
$$;
revoke all on function public.admin_set_homepage_exclusion(uuid, boolean, text) from public, anon;
grant execute on function public.admin_set_homepage_exclusion(uuid, boolean, text) to authenticated;

-- What is excluded right now, for the admin screen.
create or replace function public.admin_homepage_exclusions()
returns table (business_id uuid, name text, category text, reason text, excluded_at timestamptz, live_tier text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can see homepage promotion settings' using errcode = '42501';
  end if;
  return query
    select b.id, b.name, b.category, b.homepage_excluded_reason, b.homepage_excluded_at,
           case when b.subscription_tier = 'premium' and public.business_meets_tier(b.id, 'premium') then 'premium'
                when b.subscription_tier in ('pro', 'premium') and public.business_meets_tier(b.id, 'pro') then 'pro'
                else 'free' end
      from public.local_businesses b
     where b.homepage_excluded
     order by b.homepage_excluded_at desc nulls last, b.name;
end;
$$;
revoke all on function public.admin_homepage_exclusions() from public, anon;
grant execute on function public.admin_homepage_exclusions() to authenticated;

-- Initial setting, by id and name together (not a rule about founders): Darren Fullerton Consultancy Ltd holds the only Premium
-- plan and must not take the first homepage promotional position. Seeded once; re-running never re-applies it after an admin
-- has changed it (the log already has an entry).
do $$
declare v_id constant uuid := 'a0848cef-c8d1-435a-83be-0187502f4da3';
begin
  if exists (select 1 from public.local_businesses where id = v_id and name = 'Darren Fullerton Consultancy Ltd')
     and not exists (select 1 from public.homepage_exclusion_log where business_id = v_id) then
    update public.local_businesses
       set homepage_excluded = true,
           homepage_excluded_reason = 'Founder-owned business: kept out of the homepage promotional showcase',
           homepage_excluded_at = now()
     where id = v_id;
    insert into public.homepage_exclusion_log (business_id, excluded, reason, actor)
    values (v_id, true, 'Founder-owned business: kept out of the homepage promotional showcase', null);
  end if;
end $$;

-- 2. The public view: append directory_rank, live_tier, owner_activated_at, homepage_excluded --------------------------------------------------
create or replace view public.local_businesses_public with (security_invoker = true) as
 SELECT id,
    name,
    category,
    description,
    address,
    lat,
    lng,
    logo_url,
    cover_url,
    phone,
    website,
    email,
    opening_hours,
    is_verified,
    is_active,
    accepts_wallet,
    cashback_percent,
    payout_enabled,
    created_at,
    subscription_tier,
    subscription_until,
    accepts_bookings,
    slug,
    brand_color,
    tags,
    is_claimed,
    claimed_at,
    verified_at,
    can_publish_urgent,
    planner_visitor_ready,
    planner_dwell_minutes,
    planner_setting,
    planner_good_for,
    planner_booking,
    planner_note,
    planner_context_source,
    opening_hours_until,
    trade_categories,
    trade_availability,
    trade_availability_set_at,
    trade_min_job_pence,
    trade_credentials,
    accepts_wallet AND is_active AND business_meets_tier(id, 'pro'::text) AS wallet_live,
    business_locality(address) AS locality,
    CASE
        WHEN subscription_tier = ANY (ARRAY['pro'::text, 'premium'::text]) AND business_meets_tier(id, 'pro'::text) THEN 0
        WHEN is_claimed OR owner_activated_at IS NOT NULL THEN 1
        ELSE 2
    END AS directory_rank,
    CASE
        WHEN subscription_tier = 'premium'::text AND business_meets_tier(id, 'premium'::text) THEN 'premium'::text
        WHEN subscription_tier = ANY (ARRAY['pro'::text, 'premium'::text]) AND business_meets_tier(id, 'pro'::text) THEN 'pro'::text
        ELSE 'free'::text
    END AS live_tier,
    owner_activated_at,
    homepage_excluded
   FROM local_businesses b;

comment on column public.local_businesses_public.directory_rank is
  'Directory tier, lower first: 0 featured (live Pro or Premium by business_meets_tier), 1 owner-managed (claimed or created by its owner), 2 unclaimed.';
comment on column public.local_businesses_public.homepage_excluded is
  'An administrator has asked for this business to be kept out of the homepage promotional showcase. Changes nothing else (plan, Directory tier, features).';
comment on column public.local_businesses_public.live_tier is
  'The plan this business is entitled to right now (business_meets_tier): premium, pro or free. Launch grants and boosts count as what they granted.';
