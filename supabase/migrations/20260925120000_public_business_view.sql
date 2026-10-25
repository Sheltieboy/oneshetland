-- RECONCILED TO WHAT PRODUCTION APPLIED (8 Oct 2026).
-- The text previously committed under this name differed from the SQL production recorded in supabase_migrations.schema_migrations
-- (the file had been edited after it was applied). This file is reconstructed from the statements production recorded, verbatim,
-- joined with ";". Applied migrations are immutable; later changes belong in a new migration. See docs/MIGRATION-HISTORY.md.

-- Restore the public Directory.
--
-- wallet_live(local_businesses) was added as a PostgREST computed column. To
-- evaluate one, PostgREST writes wallet_live(local_businesses) -- a WHOLE-ROW
-- reference -- and Postgres checks a whole-row var against TABLE-level SELECT,
-- not against the columns the function actually reads. anon and authenticated
-- deliberately hold only COLUMN-level SELECT on local_businesses, so that
-- Stripe ids, NFC tokens, import provenance and (for anon) owner_id stay
-- private. The two are incompatible: every public select that asked for
-- wallet_live returned 401 / 42501 "permission denied for table
-- local_businesses", and the loaders turned that into an empty list. The
-- Directory read "0 listings" while all 528 active businesses sat untouched.
--
-- The rule itself was right and is kept exactly. It moves into a view, where
-- it is computed from columns the caller may already read, in the same single
-- query -- no whole-row reference, no RPC per business, no expiry arithmetic
-- on the client.
--
-- security_invoker: the view runs as the caller, so the base table's RLS still
-- decides which rows come back. The view adds a derived column; it does not
-- add reach.

create or replace view public.local_businesses_public
  with (security_invoker = true) as
  select b.id,
         b.owner_id,
         b.name,
         b.category,
         b.description,
         b.address,
         b.lat,
         b.lng,
         b.logo_url,
         b.cover_url,
         b.phone,
         b.website,
         b.email,
         b.opening_hours,
         b.is_verified,
         b.is_active,
         b.accepts_wallet,
         b.cashback_percent,
         b.payout_enabled,
         b.created_at,
         b.subscription_tier,
         b.subscription_until,
         b.accepts_bookings,
         b.slug,
         b.brand_color,
         b.tags,
         b.is_claimed,
         b.claimed_at,
         b.verified_at,
         b.can_publish_urgent,
         b.planner_visitor_ready,
         b.planner_dwell_minutes,
         b.planner_setting,
         b.planner_good_for,
         b.planner_booking,
         b.planner_note,
         b.planner_context_source,
         b.opening_hours_until,
         b.trade_categories,
         b.trade_availability,
         b.trade_availability_set_at,
         b.trade_min_job_pence,
         b.trade_credentials,
         (b.accepts_wallet and b.is_active and public.business_meets_tier(b.id, 'pro')) as wallet_live
    from public.local_businesses b;
-- Grants mirror the base table exactly, column for column. anon does not get
-- owner_id here either -- a view must not become a way round the column
-- privacy it sits on top of.
revoke all on public.local_businesses_public from public, anon, authenticated;
grant select (id, name, category, description, address, lat, lng, logo_url, cover_url, phone, website, email, opening_hours, is_verified, is_active, accepts_wallet, cashback_percent, payout_enabled, created_at, subscription_tier, subscription_until, accepts_bookings, slug, brand_color, tags, is_claimed, claimed_at, verified_at, can_publish_urgent, planner_visitor_ready, planner_dwell_minutes, planner_setting, planner_good_for, planner_booking, planner_note, planner_context_source, opening_hours_until, trade_categories, trade_availability, trade_availability_set_at, trade_min_job_pence, trade_credentials, wallet_live) on public.local_businesses_public to anon;
grant select (id, owner_id, name, category, description, address, lat, lng, logo_url, cover_url, phone, website, email, opening_hours, is_verified, is_active, accepts_wallet, cashback_percent, payout_enabled, created_at, subscription_tier, subscription_until, accepts_bookings, slug, brand_color, tags, is_claimed, claimed_at, verified_at, can_publish_urgent, planner_visitor_ready, planner_dwell_minutes, planner_setting, planner_good_for, planner_booking, planner_note, planner_context_source, opening_hours_until, trade_categories, trade_availability, trade_availability_set_at, trade_min_job_pence, trade_credentials, wallet_live) on public.local_businesses_public to authenticated;
grant select on public.local_businesses_public to service_role;
