-- Build 144 expects `locality` on local_businesses_public.
--
-- THE DEFECT
--
-- The shipped Local screen (App Store build 144, commit 8563e1a) filters its business grid with
--   .from('local_businesses_public').ilike('locality', '%<area>%')
-- but the view has no `locality` column (only `address`). PostgREST answers 400 "column does not exist", the screen
-- turns that into an empty list, and EVERY area chip (Lerwick, Scalloway, ...) shows "No businesses listed yet".
-- The web filters the same data on address; the app at HEAD was already changed to address. Build 144 cannot be
-- changed, so the view grows the column it asks for.
--
-- THE VALUE
--
-- locality = the business's own address text, trimmed (NULL when blank). Deterministic, derived from existing
-- trusted data only: no business row is rewritten and nothing is guessed. It is a plain substring-matchable place
-- string, which is exactly how the app uses it ("%lerwick%"). Areas whose names do not occur in any address
-- (for example "South Mainland", "Northmavine") return nothing -- the screen's honest empty state -- rather than a
-- fabricated assignment. A structured area column, if ever wanted, replaces business_locality() alone.
--
-- Access is unchanged: the view stays security_invoker (the caller's own row security on local_businesses decides
-- which rows they see), grants are preserved by CREATE OR REPLACE, and the new column is appended LAST so every
-- existing consumer is unaffected.

begin;

create or replace function public.business_locality(p_address text)
returns text
language sql immutable
as $$ select nullif(btrim(p_address), '') $$;

comment on function public.business_locality(text) is
  'Place string a business is filtered by in the app''s area chips (substring match). Today: the trimmed address.';

grant execute on function public.business_locality(text) to anon, authenticated, service_role;

create or replace view public.local_businesses_public
  with (security_invoker = true) as
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
    (accepts_wallet AND is_active AND business_meets_tier(id, 'pro'::text)) AS wallet_live,
    business_locality(b.address) AS locality
   FROM local_businesses b;

commit;
