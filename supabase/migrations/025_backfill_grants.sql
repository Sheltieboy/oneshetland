-- ── 025_backfill_grants.sql ──────────────────────────────────────────────────
-- Explicit GRANTs on every OneShetland table.
-- Skips any table that doesn't exist yet — safe to run before all migrations
-- have been applied. Idempotent — safe to run multiple times.
-- ─────────────────────────────────────────────────────────────────────────────

-- Step 1: temporary helper that grants and silently skips missing tables
CREATE OR REPLACE FUNCTION public._os_grant(privs text, tbl text, role_ text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('GRANT %s ON public.%I TO %I', privs, tbl, role_);
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping % on % (table does not exist yet)', privs, tbl;
END;
$$;

-- Step 2: grant everything
SELECT public._os_grant('SELECT',                         'profiles',                   'anon');
SELECT public._os_grant('SELECT, INSERT, UPDATE',         'profiles',                   'authenticated');
SELECT public._os_grant('ALL',                            'profiles',                   'service_role');
SELECT public._os_grant('SELECT, INSERT, UPDATE, DELETE', 'driver_profiles',            'authenticated');
SELECT public._os_grant('ALL',                            'driver_profiles',            'service_role');

SELECT public._os_grant('SELECT',                         'regions',                    'anon');
SELECT public._os_grant('SELECT',                         'regions',                    'authenticated');
SELECT public._os_grant('ALL',                            'regions',                    'service_role');

SELECT public._os_grant('SELECT',                         'delivery_categories',        'anon');
SELECT public._os_grant('SELECT',                         'delivery_categories',        'authenticated');
SELECT public._os_grant('ALL',                            'delivery_categories',        'service_role');

SELECT public._os_grant('SELECT',                         'runs',                       'anon');
SELECT public._os_grant('SELECT, INSERT, UPDATE',         'runs',                       'authenticated');
SELECT public._os_grant('ALL',                            'runs',                       'service_role');

SELECT public._os_grant('SELECT, INSERT, UPDATE',         'delivery_requests',          'authenticated');
SELECT public._os_grant('ALL',                            'delivery_requests',          'service_role');

SELECT public._os_grant('SELECT',                         'delivery_fees',              'authenticated');
SELECT public._os_grant('ALL',                            'delivery_fees',              'service_role');

SELECT public._os_grant('SELECT',                         'delivery_pricing_config',    'authenticated');
SELECT public._os_grant('ALL',                            'delivery_pricing_config',    'service_role');

SELECT public._os_grant('SELECT, INSERT',                 'waiting_events',             'authenticated');
SELECT public._os_grant('ALL',                            'waiting_events',             'service_role');

SELECT public._os_grant('SELECT, INSERT, UPDATE, DELETE', 'saved_addresses',            'authenticated');
SELECT public._os_grant('ALL',                            'saved_addresses',            'service_role');

SELECT public._os_grant('SELECT',                         'shift_employer_profiles',    'anon');
SELECT public._os_grant('SELECT, INSERT, UPDATE, DELETE', 'shift_employer_profiles',   'authenticated');
SELECT public._os_grant('ALL',                            'shift_employer_profiles',    'service_role');

SELECT public._os_grant('SELECT',                         'shifts',                     'anon');
SELECT public._os_grant('SELECT, INSERT, UPDATE, DELETE', 'shifts',                     'authenticated');
SELECT public._os_grant('ALL',                            'shifts',                     'service_role');

SELECT public._os_grant('SELECT, INSERT, UPDATE, DELETE', 'shift_applications',         'authenticated');
SELECT public._os_grant('ALL',                            'shift_applications',         'service_role');

SELECT public._os_grant('SELECT, INSERT, UPDATE, DELETE', 'shift_alerts',               'authenticated');
SELECT public._os_grant('ALL',                            'shift_alerts',               'service_role');

SELECT public._os_grant('SELECT',                         'local_businesses',           'anon');
SELECT public._os_grant('SELECT, INSERT, UPDATE, DELETE', 'local_businesses',           'authenticated');
SELECT public._os_grant('ALL',                            'local_businesses',           'service_role');

SELECT public._os_grant('SELECT, INSERT, DELETE',         'local_business_follows',     'authenticated');
SELECT public._os_grant('ALL',                            'local_business_follows',     'service_role');

SELECT public._os_grant('SELECT',                         'local_loyalty_programs',     'anon');
SELECT public._os_grant('SELECT, INSERT, UPDATE, DELETE', 'local_loyalty_programs',     'authenticated');
SELECT public._os_grant('ALL',                            'local_loyalty_programs',     'service_role');

SELECT public._os_grant('SELECT, INSERT, UPDATE',         'local_loyalty_cards',        'authenticated');
SELECT public._os_grant('ALL',                            'local_loyalty_cards',        'service_role');

SELECT public._os_grant('SELECT, INSERT',                 'local_loyalty_transactions', 'authenticated');
SELECT public._os_grant('ALL',                            'local_loyalty_transactions', 'service_role');

SELECT public._os_grant('SELECT',                         'local_offers',               'anon');
SELECT public._os_grant('SELECT, INSERT, UPDATE, DELETE', 'local_offers',               'authenticated');
SELECT public._os_grant('ALL',                            'local_offers',               'service_role');

SELECT public._os_grant('SELECT, INSERT',                 'local_offer_redemptions',    'authenticated');
SELECT public._os_grant('ALL',                            'local_offer_redemptions',    'service_role');

SELECT public._os_grant('SELECT, INSERT, UPDATE',         'local_wallet_balances',      'authenticated');
SELECT public._os_grant('ALL',                            'local_wallet_balances',      'service_role');

SELECT public._os_grant('SELECT, INSERT',                 'local_wallet_transactions',  'authenticated');
SELECT public._os_grant('ALL',                            'local_wallet_transactions',  'service_role');

SELECT public._os_grant('SELECT, INSERT, UPDATE, DELETE', 'local_business_codes',       'authenticated');
SELECT public._os_grant('ALL',                            'local_business_codes',       'service_role');

SELECT public._os_grant('SELECT, INSERT',                 'local_boost_purchases',      'authenticated');
SELECT public._os_grant('ALL',                            'local_boost_purchases',      'service_role');

SELECT public._os_grant('SELECT',                         'book_services',              'anon');
SELECT public._os_grant('SELECT, INSERT, UPDATE, DELETE', 'book_services',              'authenticated');
SELECT public._os_grant('ALL',                            'book_services',              'service_role');

SELECT public._os_grant('SELECT',                         'book_availability_rules',    'anon');
SELECT public._os_grant('SELECT, INSERT, UPDATE, DELETE', 'book_availability_rules',    'authenticated');
SELECT public._os_grant('ALL',                            'book_availability_rules',    'service_role');

SELECT public._os_grant('SELECT',                         'book_slot_overrides',        'anon');
SELECT public._os_grant('SELECT, INSERT, UPDATE, DELETE', 'book_slot_overrides',        'authenticated');
SELECT public._os_grant('ALL',                            'book_slot_overrides',        'service_role');

SELECT public._os_grant('SELECT, INSERT, UPDATE',         'book_bookings',              'authenticated');
SELECT public._os_grant('ALL',                            'book_bookings',              'service_role');

SELECT public._os_grant('SELECT, INSERT, UPDATE',         'games_scores',               'authenticated');
SELECT public._os_grant('ALL',                            'games_scores',               'service_role');

SELECT public._os_grant('SELECT, INSERT, UPDATE',         'games_user_stats',           'authenticated');
SELECT public._os_grant('ALL',                            'games_user_stats',           'service_role');

SELECT public._os_grant('SELECT, INSERT, UPDATE',         'notification_preferences',   'authenticated');
SELECT public._os_grant('ALL',                            'notification_preferences',   'service_role');

SELECT public._os_grant('SELECT',                         'notification_log',           'authenticated');
SELECT public._os_grant('ALL',                            'notification_log',           'service_role');

SELECT public._os_grant('SELECT',                         'admin_config',               'anon');
SELECT public._os_grant('SELECT',                         'admin_config',               'authenticated');
SELECT public._os_grant('ALL',                            'admin_config',               'service_role');

-- ── Tables created directly in Supabase (no migration file) ──────────────────
-- These exist in the live project but were built in the dashboard rather than
-- via a migration. Granting explicitly here so they're covered post-Oct 2026.

SELECT public._os_grant('SELECT',                         'spik_dictionary',            'anon');
SELECT public._os_grant('SELECT',                         'spik_dictionary',            'authenticated');
SELECT public._os_grant('ALL',                            'spik_dictionary',            'service_role');

SELECT public._os_grant('SELECT, INSERT',                 'spik_suggestions',           'authenticated');
SELECT public._os_grant('ALL',                            'spik_suggestions',           'service_role');

SELECT public._os_grant('SELECT, INSERT, UPDATE',         'shift_worker_profiles',      'authenticated');
SELECT public._os_grant('ALL',                            'shift_worker_profiles',      'service_role');

SELECT public._os_grant('SELECT',                         'shift_availability',         'authenticated');
SELECT public._os_grant('SELECT, INSERT, UPDATE, DELETE', 'shift_availability',         'authenticated');
SELECT public._os_grant('ALL',                            'shift_availability',         'service_role');

SELECT public._os_grant('SELECT, INSERT, UPDATE',         'shift_check_ins',            'authenticated');
SELECT public._os_grant('ALL',                            'shift_check_ins',            'service_role');

SELECT public._os_grant('SELECT',                         'shift_payments',             'authenticated');
SELECT public._os_grant('ALL',                            'shift_payments',             'service_role');

SELECT public._os_grant('SELECT',                         'shift_qualifications',       'authenticated');
SELECT public._os_grant('SELECT, INSERT, UPDATE, DELETE', 'shift_qualifications',       'authenticated');
SELECT public._os_grant('ALL',                            'shift_qualifications',       'service_role');

SELECT public._os_grant('SELECT',                         'shift_reviews',              'authenticated');
SELECT public._os_grant('SELECT, INSERT',                 'shift_reviews',              'authenticated');
SELECT public._os_grant('ALL',                            'shift_reviews',              'service_role');

SELECT public._os_grant('SELECT',                         'oneshetland_feed',           'anon');
SELECT public._os_grant('SELECT',                         'oneshetland_feed',           'authenticated');
SELECT public._os_grant('ALL',                            'oneshetland_feed',           'service_role');

-- Step 3: clean up the helper
DROP FUNCTION public._os_grant(text, text, text);
