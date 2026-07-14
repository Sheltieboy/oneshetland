-- Fix: creating a business failed with
--   "new row violates row-level security policy for table business_addons"
--
-- The AFTER INSERT trigger tg_seed_business_addons seeds default add-on rows for
-- a new business. It was SECURITY DEFINER in the baseline, but a later migration
-- (20260628120000_analytics_spine.sql) redefined it WITHOUT SECURITY DEFINER, so
-- it began running as the calling (authenticated) user. business_addons has no
-- owner INSERT policy, so the seed insert is blocked by RLS and the whole
-- business INSERT rolls back.
--
-- Restore SECURITY DEFINER (and pin search_path) on the existing function WITHOUT
-- touching its body, so the current add-on defaults are preserved.

alter function public.tg_seed_business_addons()
  security definer
  set search_path = public;
