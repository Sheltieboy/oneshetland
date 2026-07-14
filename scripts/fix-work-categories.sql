-- ─────────────────────────────────────────────────────────────────────────────
-- Fix drifted Work sector tags (run once in the Supabase SQL editor).
--
-- Diagnosis: the post forms constrain category to the canonical lists, but a few
-- legacy/demo rows were created with off-list values, so they don't match any
-- filter chip and vanish from sector browsing.
--
--   JOBS use Title-Case labels  (JOB_CATEGORIES: "Hospitality", "Trades", … "Other")
--   SHIFTS use snake_case keys   (CATEGORY_LABELS: hospitality, retail, trades, …)
--
-- Off-list values found:
--   jobs   : "Trade"          → should be "Trades"
--            "Hair & Beauty"  → not a job category → "Other"
--   shifts : "Retail"         → "retail"
--            "Hospitality"    → "hospitality"
--            "Hair & Beauty"  → no beauty key → "retail" (closest; edit if you prefer)
-- ─────────────────────────────────────────────────────────────────────────────

-- Jobs (Title-Case canonical list)
UPDATE public.jobs   SET category = 'Trades' WHERE category = 'Trade';
UPDATE public.jobs   SET category = 'Other'  WHERE category = 'Hair & Beauty';

-- Shifts (snake_case canonical keys)
UPDATE public.shifts SET category = 'retail'      WHERE category = 'Retail';
UPDATE public.shifts SET category = 'hospitality' WHERE category = 'Hospitality';
UPDATE public.shifts SET category = 'retail'      WHERE category = 'Hair & Beauty';

-- Verify nothing is left off-list:
-- SELECT DISTINCT category FROM public.jobs   WHERE status = 'open';
-- SELECT DISTINCT category FROM public.shifts WHERE status IN ('open','filled','completed');
