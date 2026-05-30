-- ── Link shifts to Local businesses ──────────────────────────────────────────
-- Lets a user who already has a Local business profile post shifts AS that
-- business — no need to fill in employer name / address / contact again.
-- Multi-business naturally supported (different shifts can be posted as
-- different businesses on the same user).
--
-- ON DELETE SET NULL — if a business is deleted, its old shift listings
-- remain (they still have employer_id pointing at the user) but lose the
-- business link. Display falls back to the user's shift_employer_profile.

ALTER TABLE public.shifts
  ADD COLUMN IF NOT EXISTS posted_as_business_id UUID
    REFERENCES public.local_businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_shifts_posted_as_business
  ON public.shifts(posted_as_business_id)
  WHERE posted_as_business_id IS NOT NULL;
