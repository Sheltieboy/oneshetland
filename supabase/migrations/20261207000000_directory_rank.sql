-- Directory ranking tiers: 0 featured, 1 owner-managed, 2 unclaimed.
--
-- WHY. The Directory ranked by verified-then-name, with no claimed or owner tier, so a listing its owner created
-- sat among unclaimed imports. "Owner-managed" must come from the real ownership data, not the is_claimed flag alone:
-- owner_id is the ownership record (a verified claim sets it, a listing created by its owner is inserted with it).
--
-- HOW. local_businesses_public is security_invoker and anon holds no SELECT on owner_id, so the view cannot read
-- owner_id itself. business_has_owner() is a SECURITY DEFINER boolean (same pattern as business_meets_tier, already used
-- for wallet_live): it exposes only "has an owner", which is_claimed already shows publicly. It returns false for a
-- missing id. No row, filter, grant or policy changes: hidden/inactive rows stay excluded exactly as before by the
-- view's RLS and the callers' is_active filters; this ADDS one appended column, directory_rank.
--
-- Featured uses the SAME test as the Directory's Featured row (getDirectoryFeatured): pro/premium and not lapsed.
--
-- ROLLBACK: stop ordering by directory_rank in the web (nothing else reads it) and leave the column in place, which is
-- harmless. To remove it entirely, re-create local_businesses_public without the last column (drop view + create view
-- with the same options: security_invoker=true and the same grants), then drop function public.business_has_owner(uuid).

create or replace function public.business_has_owner(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select owner_id is not null from public.local_businesses where id = p_business_id), false)
$$;

revoke all on function public.business_has_owner(uuid) from public;
grant execute on function public.business_has_owner(uuid) to anon, authenticated, service_role;

-- WITH (security_invoker = true) is REQUIRED here: CREATE OR REPLACE VIEW replaces the view's options, so leaving it out would
-- silently turn the view into an owner-privileged one that bypasses row security and exposes hidden/inactive listings.
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
        WHEN subscription_tier = ANY (ARRAY['pro'::text, 'premium'::text]) AND (subscription_until IS NULL OR subscription_until > now()) THEN 0
        WHEN is_claimed OR business_has_owner(id) THEN 1
        ELSE 2
    END AS directory_rank
   FROM local_businesses b;

comment on column public.local_businesses_public.directory_rank is
  'Directory tier, lower first: 0 featured (active pro/premium), 1 owner-managed (approved claim or created by its owner), 2 unclaimed.';
