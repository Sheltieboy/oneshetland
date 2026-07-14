-- Shift worker profile — add the "rich" columns the app + web already target.
--
-- Root cause: app/shift-worker-profile.tsx (write) and app/employer-applications.tsx
-- + web jobs-data.server.ts (read) all reference bio / experience_summary /
-- hourly_rate_min / hourly_rate_max / qualifications on shift_worker_profiles, and
-- upsert keyed on `user_id` (onConflict: 'user_id'). None of those existed: the live
-- table only had id (PK = auth.users.id), tagline, skills, qualifications? no,
-- is_open_to_work, open_to_categories, min_hourly_pay. So the whole rich shift-profile
-- feature was non-functional (employers saw blank; the editor could not save).
--
-- This migration is ADDITIVE and requires NO app/web code changes:
--   • adds the missing columns
--   • adds a `user_id` column kept in sync with the existing `id` PK (= the worker's
--     auth uid) via a BEFORE trigger, so code that writes either key works
--   • adds a UNIQUE(user_id) so `onConflict: 'user_id'` upserts resolve
--   • broadens the owner RLS policy to accept either id or user_id
-- The pre-existing columns (tagline, min_hourly_pay, open_to_categories, etc.) are left
-- untouched.

ALTER TABLE public.shift_worker_profiles
  ADD COLUMN IF NOT EXISTS bio                text,
  ADD COLUMN IF NOT EXISTS experience_summary text,
  ADD COLUMN IF NOT EXISTS hourly_rate_min    numeric,
  ADD COLUMN IF NOT EXISTS hourly_rate_max    numeric,
  ADD COLUMN IF NOT EXISTS qualifications     text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS user_id            uuid;

-- Backfill user_id from the existing id (id is the worker's auth uid).
UPDATE public.shift_worker_profiles SET user_id = id WHERE user_id IS NULL;

-- Keep id <-> user_id in sync regardless of which key the writer supplies.
-- (The app upserts with user_id only; id is the NOT NULL PK with no default.)
CREATE OR REPLACE FUNCTION public.shift_worker_profiles_sync_ids()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS NULL AND NEW.user_id IS NOT NULL THEN
    NEW.id := NEW.user_id;
  END IF;
  IF NEW.user_id IS NULL AND NEW.id IS NOT NULL THEN
    NEW.user_id := NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shift_worker_profiles_sync_ids ON public.shift_worker_profiles;
CREATE TRIGGER trg_shift_worker_profiles_sync_ids
  BEFORE INSERT OR UPDATE ON public.shift_worker_profiles
  FOR EACH ROW EXECUTE FUNCTION public.shift_worker_profiles_sync_ids();

-- onConflict: 'user_id' requires a unique constraint on user_id.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shift_worker_profiles_user_id_key'
  ) THEN
    ALTER TABLE public.shift_worker_profiles
      ADD CONSTRAINT shift_worker_profiles_user_id_key UNIQUE (user_id);
  END IF;
END $$;

-- Broaden the owner policy so an upsert keyed by user_id is allowed (id stays in
-- sync via the trigger; either match is the same person).
DROP POLICY IF EXISTS "worker manages own profile" ON public.shift_worker_profiles;
CREATE POLICY "worker manages own profile" ON public.shift_worker_profiles
  USING (auth.uid() = id OR auth.uid() = user_id)
  WITH CHECK (auth.uid() = id OR auth.uid() = user_id);
