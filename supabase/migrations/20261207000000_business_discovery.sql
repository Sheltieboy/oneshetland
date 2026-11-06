-- Business discovery: Directory tiers, the live plan, and the date a business became owner-managed.
--
-- WHAT THIS ADDS (all additive; no row is deleted, no policy or grant is loosened):
--   1. local_businesses.owner_activated_at — when the business actually became owner-managed (an approved claim, or a listing
--      created by its owner). Kept true by a trigger; clients cannot set it. Backfilled from the real records below.
--   2. Three APPENDED columns on local_businesses_public:
--        directory_rank  0 featured, 1 owner-managed, 2 unclaimed   (the Directory's tier; lower first)
--        live_tier       'premium' | 'pro' | 'free'                  (the plan the business is ACTUALLY entitled to right now)
--        owner_activated_at
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
-- remove: re-create local_businesses_public without the last three columns (same options: security_invoker=true, same grants),
-- drop trigger tg_zzz_owner_activation on local_businesses, drop function tg_owner_activation(), drop constraint
-- local_businesses_owner_activation_consistent, drop column owner_activated_at.

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

-- 2. The public view: append directory_rank, live_tier, owner_activated_at --------------------------------------------------
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
    owner_activated_at
   FROM local_businesses b;

comment on column public.local_businesses_public.directory_rank is
  'Directory tier, lower first: 0 featured (live Pro or Premium by business_meets_tier), 1 owner-managed (claimed or created by its owner), 2 unclaimed.';
comment on column public.local_businesses_public.live_tier is
  'The plan this business is entitled to right now (business_meets_tier): premium, pro or free. Launch grants and boosts count as what they granted.';
