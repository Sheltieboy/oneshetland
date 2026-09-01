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
-- decides which rows come back. That also means the caller needs SELECT on
-- every column the view BODY reads, not merely the ones they ask for -- which
-- is why owner_id is absent here. anon cannot read it, and including it would
-- have made the whole view unreadable to anon for exactly the reason the
-- computed column failed. Anything needing owner_id reads the table directly,
-- where the existing column grants decide.

drop view if exists public.local_businesses_public;
create view public.local_businesses_public
  with (security_invoker = true) as
  select b.id,
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

revoke all on public.local_businesses_public from public;
grant select on public.local_businesses_public to anon, authenticated, service_role;
