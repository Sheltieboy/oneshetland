-- ─────────────────────────────────────────────────────────────────────────────
-- 007 — Shift alerts + employer profile description
-- Run in Supabase SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

-- Add description to employer profiles
ALTER TABLE public.shift_employer_profiles
  ADD COLUMN IF NOT EXISTS description TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- SHIFT ALERTS
-- One row per worker. Empty arrays mean "match all".
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.shift_alerts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  categories  TEXT[]      NOT NULL DEFAULT '{}',  -- empty = all categories
  urgency     TEXT[]      NOT NULL DEFAULT '{}',  -- empty = all urgencies
  min_pay     NUMERIC,                             -- null = no minimum
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);

ALTER TABLE public.shift_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own alerts"
  ON public.shift_alerts
  FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Service role can read all alerts (for edge function matching)
CREATE POLICY "Service role reads all alerts"
  ON public.shift_alerts
  FOR SELECT
  USING (true);
