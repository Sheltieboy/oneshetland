-- Unify the two Work-hub worker-profile systems into ONE canonical profile.
--
-- Background
-- ----------
-- The Work hub had two divergent candidate-profile tables:
--   • public.worker_profiles       — used by JOBS  (PK user_id -> profiles.id)
--   • public.shift_worker_profiles — used by SHIFTS (PK id -> auth.users.id,
--                                     plus a synced user_id column, see 20260629120000)
-- A worker had to fill in two separate profiles to apply for Jobs vs Shifts.
--
-- This migration makes `worker_profiles` a SUPERSET that serves both flows:
--   1. adds the shift-specific columns worker_profiles lacked,
--   2. backfills worker_profiles from shift_worker_profiles (merging, non-null wins),
--   3. broadens the employer-read RLS so SHIFT employers can also read an
--      applicant's unified profile (previously only JOB employers could).
--
-- Non-destructive + reversible:
--   • only ADD COLUMN IF NOT EXISTS (no drops, no truncates, no type changes),
--   • shift_worker_profiles is LEFT INTACT (a later cleanup migration can drop it
--     once the unified flow is verified in production),
--   • the only pre-existing object replaced is the "employer read" policy, whose
--     prior definition is reproduced verbatim inside the new one (Jobs branch),
--     so it is a strict superset — see the DOWN section for the exact revert.
--
-- No FK repointing is required: shift_applications.worker_id references
-- auth.users(id), NOT shift_worker_profiles — the employer applicant view joins
-- on worker_id in application code, so pointing it at worker_profiles is a pure
-- code change (done in the same PR).
--
-- NOTE: worker_profiles is NOT the locked `profiles` table, so these columns are
-- client-writable under the table's own owner RLS (user_id = auth.uid()). No
-- locked profiles columns (role / has_payment_method) are touched.

-- ── 1. Add the shift-specific superset columns ──────────────────────────────
-- experience_summary : shift form's second free-text field (kept distinct from
--                      `summary`, which is the "about you" paragraph).
-- hourly_rate_min/max: shift pay expectation (Jobs uses free-text desired_pay_text;
--                      both are retained — they serve different UIs).
-- is_open_to_work    : "show me to employers looking for shift workers" flag.
-- open_to_categories : shift categories the worker is open to.
ALTER TABLE public.worker_profiles
  ADD COLUMN IF NOT EXISTS experience_summary text,
  ADD COLUMN IF NOT EXISTS hourly_rate_min    numeric,
  ADD COLUMN IF NOT EXISTS hourly_rate_max    numeric,
  ADD COLUMN IF NOT EXISTS is_open_to_work    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS open_to_categories text[]  NOT NULL DEFAULT '{}'::text[];

-- ── 2. Backfill from shift_worker_profiles ──────────────────────────────────
-- (a) Users who have a SHIFT profile but no JOBS profile yet: create the unified
--     row. Map shift `bio` -> `summary` (both are the "about you" paragraph).
--     skills / qualifications on shift are the rich-column arrays (may be NULL on
--     legacy rows) — coalesce to empty arrays to satisfy the NOT NULL columns.
INSERT INTO public.worker_profiles (
  user_id, summary, experience_summary, skills, qualifications,
  hourly_rate_min, hourly_rate_max, is_open_to_work, open_to_categories
)
SELECT
  swp.user_id,
  swp.bio,
  swp.experience_summary,
  COALESCE(swp.skills, '{}'::text[]),
  COALESCE(swp.qualifications, '{}'::text[]),
  swp.hourly_rate_min,
  swp.hourly_rate_max,
  COALESCE(swp.is_open_to_work, false),
  COALESCE(swp.open_to_categories, '{}'::text[])
FROM public.shift_worker_profiles swp
WHERE swp.user_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = swp.user_id)  -- FK safety
  AND NOT EXISTS (
    SELECT 1 FROM public.worker_profiles wp WHERE wp.user_id = swp.user_id
  );

-- (b) Users who have BOTH profiles: fill only the shift-specific fields that are
--     still empty on the Jobs profile (prefer the existing non-null Jobs value).
--     We do NOT overwrite summary / skills / qualifications here — the Jobs
--     profile is authoritative for those once it exists, and clobbering a
--     populated Jobs CV with shift data would be the risky merge direction.
UPDATE public.worker_profiles wp
SET
  experience_summary = COALESCE(wp.experience_summary, swp.experience_summary),
  hourly_rate_min    = COALESCE(wp.hourly_rate_min,    swp.hourly_rate_min),
  hourly_rate_max    = COALESCE(wp.hourly_rate_max,    swp.hourly_rate_max),
  -- only lift the open-to-work signal / categories across if they were never set
  is_open_to_work    = (wp.is_open_to_work OR COALESCE(swp.is_open_to_work, false)),
  open_to_categories = CASE
                         WHEN wp.open_to_categories = '{}'::text[]
                         THEN COALESCE(swp.open_to_categories, '{}'::text[])
                         ELSE wp.open_to_categories
                       END
FROM public.shift_worker_profiles swp
WHERE swp.user_id = wp.user_id;

-- ── 3. Broaden employer-read RLS to include SHIFT employers ─────────────────
-- Prior policy (JOBS employers + admins/mods) is reproduced verbatim as the
-- first two branches; a third branch grants read to an employer who has a
-- pending/any shift application from this worker on a shift they posted.
DROP POLICY IF EXISTS "worker_profiles employer read" ON public.worker_profiles;
CREATE POLICY "worker_profiles employer read" ON public.worker_profiles
  FOR SELECT USING (
    -- JOBS employer: has a job this worker applied to
    EXISTS (
      SELECT 1
      FROM public.job_applications ja
      JOIN public.jobs j ON j.id = ja.job_id
      WHERE ja.applicant_id = worker_profiles.user_id
        AND j.employer_id = auth.uid()
    )
    -- SHIFT employer: has a shift this worker applied to
    OR EXISTS (
      SELECT 1
      FROM public.shift_applications sa
      JOIN public.shifts s ON s.id = sa.shift_id
      WHERE sa.worker_id = worker_profiles.user_id
        AND s.employer_id = auth.uid()
    )
    -- Admins / moderators
    OR EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.role = ANY (ARRAY['admin'::text, 'moderator'::text])
    )
  );

-- ── DOWN (manual revert; documented, not auto-run) ──────────────────────────
-- To revert:
--   DROP POLICY IF EXISTS "worker_profiles employer read" ON public.worker_profiles;
--   CREATE POLICY "worker_profiles employer read" ON public.worker_profiles
--     FOR SELECT USING (
--       (EXISTS ( SELECT 1 FROM public.job_applications ja
--                 JOIN public.jobs j ON j.id = ja.job_id
--                 WHERE ja.applicant_id = worker_profiles.user_id
--                   AND j.employer_id = auth.uid()))
--       OR (EXISTS ( SELECT 1 FROM public.profiles p
--                    WHERE p.id = auth.uid()
--                      AND p.role = ANY (ARRAY['admin'::text,'moderator'::text]))));
--   ALTER TABLE public.worker_profiles
--     DROP COLUMN IF EXISTS experience_summary,
--     DROP COLUMN IF EXISTS hourly_rate_min,
--     DROP COLUMN IF EXISTS hourly_rate_max,
--     DROP COLUMN IF EXISTS is_open_to_work,
--     DROP COLUMN IF EXISTS open_to_categories;
-- (Backfilled rows/values are left as-is on revert — harmless extra data.)
