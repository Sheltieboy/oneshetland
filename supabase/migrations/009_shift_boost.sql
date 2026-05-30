-- 009_shift_boost.sql
-- Adds boost support to shifts.
-- A shift is "actively boosted" when boosted_until > NOW().
-- Employers pay £2.99 to boost a shift for 24 hours; boosting fires
-- the notify-matching-workers edge function (free posts do not).

ALTER TABLE public.shifts
  ADD COLUMN IF NOT EXISTS boosted_until TIMESTAMPTZ;
