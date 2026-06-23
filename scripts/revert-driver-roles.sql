-- ============================================================================
-- One-time data fix: driver is now a CAPABILITY (driver_profiles.driver_status),
-- not a role. Revert anyone whose profiles.role was flipped to 'driver' back to
-- 'customer'. Their driver_profiles row (driver_status, vehicle, Stripe payout)
-- is UNTOUCHED, so they keep full driver capability — only the navigation-only
-- role string changes.
--
-- Safe: no RLS policy depends on role='driver' (verified against the schema);
-- the migration-064 self-edit lock is bypassed here because the SQL editor runs
-- as the postgres/service role (auth.uid() is null), not as the user.
--
-- The RETURNING clause shows exactly which rows changed (acts as the count).
-- Re-running is a harmless no-op once there are no role='driver' rows left.
-- ============================================================================

update public.profiles
   set role = 'customer'
 where role = 'driver'
returning id, full_name, role as new_role;
