-- Migration 053: Dedicated event-media storage bucket
--
-- Creates a separate public bucket for event cover images and gallery photos.
-- Uses a simple user-id-based path (no business lookup), so the RLS policy
-- is a single auth.uid() comparison — nothing that can silently fail.
--
-- Path convention: <user_id>/events/<timestamp>.<ext>
--
-- Run via: Supabase SQL editor → paste → Run.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'event-media',
  'event-media',
  TRUE,
  10485760,   -- 10 MB per file
  ARRAY['image/jpeg','image/jpg','image/png','image/webp','image/heic','image/heif']
)
ON CONFLICT (id) DO NOTHING;

-- Anyone can read (bucket is public).
DROP POLICY IF EXISTS "event-media public read"  ON storage.objects;
CREATE POLICY "event-media public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'event-media');

-- Only the owner of the path's first folder (their user ID) may upload.
DROP POLICY IF EXISTS "event-media owner write"  ON storage.objects;
CREATE POLICY "event-media owner write"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'event-media'
    AND auth.uid() IS NOT NULL
    AND split_part(name, '/', 1) = auth.uid()::text
  );

DROP POLICY IF EXISTS "event-media owner update" ON storage.objects;
CREATE POLICY "event-media owner update"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'event-media'
    AND split_part(name, '/', 1) = auth.uid()::text
  );

DROP POLICY IF EXISTS "event-media owner delete" ON storage.objects;
CREATE POLICY "event-media owner delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'event-media'
    AND split_part(name, '/', 1) = auth.uid()::text
  );
