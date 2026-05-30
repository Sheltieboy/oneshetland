-- ── 025_backfill_grants.sql ──────────────────────────────────────────────────
--
-- Explicit GRANTs on every existing table in the OneShetland project.
--
-- WHY: From October 30 2026, Supabase will stop automatically granting
-- Data API access to tables in the public schema. Existing tables keep
-- their implicit grants, but adding explicit ones here means:
--   1. The app still works after October 30 with no further changes.
--   2. New migrations that create tables will know the pattern to follow.
--
-- GRANT RULES USED:
--   anon         → SELECT only on tables that are safe for public browsing
--                  (dictionary words, public business listings, regions, etc.)
--                  Nothing that could leak PII.
--   authenticated → SELECT + write on tables the app reads/writes via supabase-js
--   service_role  → ALL on every table (edge functions run as service_role)
--
-- Run in Supabase Dashboard → SQL Editor → New query → Run.
-- Safe to run multiple times (GRANT is idempotent).
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Core user + driver tables ─────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE           ON public.profiles            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE   ON public.driver_profiles     TO authenticated;
GRANT ALL                              ON public.profiles            TO service_role;
GRANT ALL                              ON public.driver_profiles     TO service_role;
-- anon can read limited profile data (public display name etc) but not write
GRANT SELECT                           ON public.profiles            TO anon;

-- ── Fetch / delivery ─────────────────────────────────────────────────────────

GRANT SELECT                           ON public.regions             TO anon;
GRANT SELECT                           ON public.regions             TO authenticated;
GRANT ALL                              ON public.regions             TO service_role;

GRANT SELECT                           ON public.delivery_categories TO anon;
GRANT SELECT                           ON public.delivery_categories TO authenticated;
GRANT ALL                              ON public.delivery_categories TO service_role;

GRANT SELECT, INSERT, UPDATE           ON public.runs                TO authenticated;
GRANT SELECT                           ON public.runs                TO anon;
GRANT ALL                              ON public.runs                TO service_role;

GRANT SELECT, INSERT, UPDATE           ON public.delivery_requests   TO authenticated;
GRANT ALL                              ON public.delivery_requests   TO service_role;

GRANT SELECT                           ON public.delivery_fees       TO authenticated;
GRANT ALL                              ON public.delivery_fees       TO service_role;

GRANT SELECT                           ON public.delivery_pricing_config TO authenticated;
GRANT ALL                              ON public.delivery_pricing_config TO service_role;

GRANT SELECT, INSERT                   ON public.waiting_events      TO authenticated;
GRANT ALL                              ON public.waiting_events      TO service_role;

GRANT SELECT                           ON public.saved_addresses     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE   ON public.saved_addresses     TO authenticated;
GRANT ALL                              ON public.saved_addresses      TO service_role;

-- ── Shifts ───────────────────────────────────────────────────────────────────

-- shifts, shift_employer_profiles, shift_applications, shift_alerts are
-- read publicly (anyone can browse job listings)
GRANT SELECT                           ON public.shift_employer_profiles TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE   ON public.shift_employer_profiles TO authenticated;
GRANT ALL                              ON public.shift_employer_profiles TO service_role;

GRANT SELECT                           ON public.shift_alerts        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE   ON public.shift_alerts        TO authenticated;
GRANT ALL                              ON public.shift_alerts        TO service_role;

-- ── Local (loyalty, offers, wallet, booking) ─────────────────────────────────

GRANT SELECT                           ON public.local_businesses         TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE   ON public.local_businesses         TO authenticated;
GRANT ALL                              ON public.local_businesses         TO service_role;

GRANT SELECT                           ON public.local_business_follows   TO authenticated;
GRANT SELECT, INSERT, DELETE           ON public.local_business_follows   TO authenticated;
GRANT ALL                              ON public.local_business_follows   TO service_role;

GRANT SELECT                           ON public.local_loyalty_programs   TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE   ON public.local_loyalty_programs   TO authenticated;
GRANT ALL                              ON public.local_loyalty_programs   TO service_role;

GRANT SELECT, INSERT, UPDATE           ON public.local_loyalty_cards      TO authenticated;
GRANT ALL                              ON public.local_loyalty_cards      TO service_role;

GRANT SELECT, INSERT                   ON public.local_loyalty_transactions TO authenticated;
GRANT ALL                              ON public.local_loyalty_transactions TO service_role;

GRANT SELECT                           ON public.local_offers             TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE   ON public.local_offers             TO authenticated;
GRANT ALL                              ON public.local_offers             TO service_role;

GRANT SELECT, INSERT                   ON public.local_offer_redemptions  TO authenticated;
GRANT ALL                              ON public.local_offer_redemptions  TO service_role;

GRANT SELECT, INSERT, UPDATE           ON public.local_wallet_balances    TO authenticated;
GRANT ALL                              ON public.local_wallet_balances    TO service_role;

GRANT SELECT, INSERT                   ON public.local_wallet_transactions TO authenticated;
GRANT ALL                              ON public.local_wallet_transactions TO service_role;

GRANT SELECT                           ON public.local_business_codes     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE   ON public.local_business_codes     TO authenticated;
GRANT ALL                              ON public.local_business_codes     TO service_role;

GRANT SELECT, INSERT                   ON public.local_boost_purchases    TO authenticated;
GRANT ALL                              ON public.local_boost_purchases    TO service_role;

-- ── Book (slot booking) ───────────────────────────────────────────────────────

GRANT SELECT                           ON public.book_services            TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE   ON public.book_services            TO authenticated;
GRANT ALL                              ON public.book_services            TO service_role;

GRANT SELECT                           ON public.book_availability_rules  TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE   ON public.book_availability_rules  TO authenticated;
GRANT ALL                              ON public.book_availability_rules  TO service_role;

GRANT SELECT                           ON public.book_slot_overrides      TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE   ON public.book_slot_overrides      TO authenticated;
GRANT ALL                              ON public.book_slot_overrides      TO service_role;

GRANT SELECT, INSERT, UPDATE           ON public.book_bookings            TO authenticated;
GRANT ALL                              ON public.book_bookings            TO service_role;

-- ── Games ─────────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE           ON public.games_scores             TO authenticated;
GRANT ALL                              ON public.games_scores             TO service_role;

GRANT SELECT, INSERT, UPDATE           ON public.games_user_stats         TO authenticated;
GRANT ALL                              ON public.games_user_stats         TO service_role;

-- ── Notifications ─────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE           ON public.notification_preferences TO authenticated;
GRANT ALL                              ON public.notification_preferences TO service_role;

GRANT SELECT                           ON public.notification_log         TO authenticated;
GRANT ALL                              ON public.notification_log         TO service_role;

-- ── Admin config ─────────────────────────────────────────────────────────────
-- anon + authenticated can SELECT (used for reading prices, feature flags etc)
-- Only service_role can write (config is changed via edge functions / admin UI)

GRANT SELECT                           ON public.admin_config             TO anon;
GRANT SELECT                           ON public.admin_config             TO authenticated;
GRANT ALL                              ON public.admin_config             TO service_role;

-- ── Sequences (UUIDs are gen_random_uuid() so no sequences needed, but ────────
-- ── if any SERIAL columns exist, service_role needs USAGE + SELECT) ──────────
-- Uncomment if PostgREST reports sequence permission errors:
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon;
