-- 008_shift_checkins.sql
-- Adds check-in / check-out / employer confirmation tracking to shift applications.
-- The lifecycle for an accepted worker is:
--   null → checked_in → checked_out → employer_confirmed

ALTER TABLE public.shift_applications
  ADD COLUMN IF NOT EXISTS check_in_status       TEXT        CHECK (
    check_in_status IN ('checked_in', 'checked_out', 'employer_confirmed')
  ),
  ADD COLUMN IF NOT EXISTS checked_in_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS checked_out_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS employer_confirmed_at TIMESTAMPTZ;
