-- ── 037_images_and_buckets.sql ──────────────────────────────────────────────
--
-- One-shot media plumbing pass.
--
-- Part A — schema gaps
--   * book_services.image_url            (was the only Marketplace media-bearing
--                                         row missing an image column)
--
-- Part B — Supabase Storage buckets
--   Public-read, owner-write buckets for the three places users upload media:
--     business-media   business logos + cover images + offer images + unit
--                      item images + service images (one bucket, sub-folders
--                      keep things sortable)
--     employer-logos   Shifts employer profile logos
--     avatars          existing personal avatars — created here if absent so
--                      profile photo upload is a single code path
--
--   Path convention:
--     business-media/<business_id>/<kind>/<uuid>.<ext>
--       kind ∈ { logo | cover | offer | service | unit }
--     employer-logos/<user_id>/<uuid>.<ext>
--       (shift_employer_profiles.id == profiles.id, so user_id == profile id)
--     avatars/<user_id>/<uuid>.<ext>
--
-- Part C — RLS on storage.objects
--   * Anyone can READ from these buckets (the URLs are surfaced publicly in
--     the app — listings, offers, etc.).
--   * Only authenticated users can WRITE, and only into a folder that matches
--     a business / employer / avatar they own.
--
-- Idempotent — safe to re-run.
-- ────────────────────────────────────────────────────────────────────────────

-- ══ Part A — schema ═════════════════════════════════════════════════════════

ALTER TABLE public.book_services
  ADD COLUMN IF NOT EXISTS image_url TEXT;

-- ══ Part B — buckets ════════════════════════════════════════════════════════

INSERT INTO storage.buckets (id, name, public)
VALUES
  ('business-media', 'business-media', TRUE),
  ('employer-logos', 'employer-logos', TRUE),
  ('avatars',        'avatars',        TRUE)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public;

-- ══ Part C — RLS policies on storage.objects ═══════════════════════════════
--
-- storage.objects already has RLS enabled by Supabase. We layer per-bucket
-- policies on top. Drop-and-recreate keeps the migration idempotent.

DROP POLICY IF EXISTS "business-media public read"           ON storage.objects;
DROP POLICY IF EXISTS "business-media owner write"           ON storage.objects;
DROP POLICY IF EXISTS "business-media owner update"          ON storage.objects;
DROP POLICY IF EXISTS "business-media owner delete"          ON storage.objects;

DROP POLICY IF EXISTS "employer-logos public read"           ON storage.objects;
DROP POLICY IF EXISTS "employer-logos owner write"           ON storage.objects;
DROP POLICY IF EXISTS "employer-logos owner update"          ON storage.objects;
DROP POLICY IF EXISTS "employer-logos owner delete"          ON storage.objects;

DROP POLICY IF EXISTS "avatars public read"                  ON storage.objects;
DROP POLICY IF EXISTS "avatars owner write"                  ON storage.objects;
DROP POLICY IF EXISTS "avatars owner update"                 ON storage.objects;
DROP POLICY IF EXISTS "avatars owner delete"                 ON storage.objects;

-- ── business-media ──────────────────────────────────────────────────────────

CREATE POLICY "business-media public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'business-media');

-- Path: <business_id>/<kind>/<filename>
-- Writer must own the business OR be an admin.
CREATE POLICY "business-media owner write"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'business-media'
    AND auth.uid() IS NOT NULL
    AND (
      EXISTS (
        SELECT 1 FROM public.local_businesses b
        WHERE b.id::text = (storage.foldername(name))[1]
          AND b.owner_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = auth.uid() AND p.role = 'admin'
      )
    )
  );

CREATE POLICY "business-media owner update"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'business-media'
    AND (
      EXISTS (
        SELECT 1 FROM public.local_businesses b
        WHERE b.id::text = (storage.foldername(name))[1]
          AND b.owner_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = auth.uid() AND p.role = 'admin'
      )
    )
  );

CREATE POLICY "business-media owner delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'business-media'
    AND (
      EXISTS (
        SELECT 1 FROM public.local_businesses b
        WHERE b.id::text = (storage.foldername(name))[1]
          AND b.owner_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = auth.uid() AND p.role = 'admin'
      )
    )
  );

-- ── employer-logos ──────────────────────────────────────────────────────────

CREATE POLICY "employer-logos public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'employer-logos');

-- Path: <user_id>/<filename>   (shift_employer_profiles.id is the user id)
CREATE POLICY "employer-logos owner write"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'employer-logos'
    AND auth.uid() IS NOT NULL
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "employer-logos owner update"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'employer-logos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "employer-logos owner delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'employer-logos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- ── avatars ─────────────────────────────────────────────────────────────────

CREATE POLICY "avatars public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'avatars');

CREATE POLICY "avatars owner write"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'avatars'
    AND auth.uid() IS NOT NULL
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "avatars owner update"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "avatars owner delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
