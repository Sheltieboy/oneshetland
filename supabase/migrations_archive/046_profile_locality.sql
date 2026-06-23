-- ── 046_profile_locality.sql ────────────────────────────────────────────────
--
-- Adds optional locality fields to profiles so the Home concierge can
-- sort notices "local to me first" and seed the GPS-aware Local tile
-- with a hint of where the user actually is before the OS-level
-- location permission is granted.
--
-- All optional — the concierge gracefully degrades to recency-only
-- sorting when these are NULL.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS parish     TEXT,
  ADD COLUMN IF NOT EXISTS home_lat   NUMERIC(9,6),
  ADD COLUMN IF NOT EXISTS home_lng   NUMERIC(9,6);

-- Small index on parish so the "notices in my parish" query stays cheap.
CREATE INDEX IF NOT EXISTS idx_profiles_parish ON public.profiles(parish);
