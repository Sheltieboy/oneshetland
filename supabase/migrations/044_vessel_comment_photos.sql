-- ── 044_vessel_comment_photos.sql ──────────────────────────────────────────
--
-- Lets the discussion go visual. Adds optional image attachments to
-- vessel_comments — the men sharing what they remember can now also
-- share the photo from the kitchen drawer.
--
-- One photo per comment for now. If/when multi-photo becomes a real ask
-- we can spin off vessel_comment_media without breaking these columns.
--
-- Storage: boat-comment-media bucket, public read, author-write.
-- Path:    <author_id>/<uuid>.<ext>
--
-- Idempotent — safe to re-run.
-- ────────────────────────────────────────────────────────────────────────────

-- ══ 1. Schema ══════════════════════════════════════════════════════════════

ALTER TABLE public.vessel_comments
  ADD COLUMN IF NOT EXISTS image_url  TEXT,
  ADD COLUMN IF NOT EXISTS image_path TEXT;

-- ══ 2. Bucket ══════════════════════════════════════════════════════════════

INSERT INTO storage.buckets (id, name, public)
VALUES ('boat-comment-media', 'boat-comment-media', TRUE)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

-- ══ 3. Storage RLS ═════════════════════════════════════════════════════════
--
-- Anyone can READ (the public URLs are baked into the comments). Authenticated
-- users can WRITE only to a folder matching their own user id, so the path
-- becomes the proof-of-ownership.

DROP POLICY IF EXISTS "boat-comment-media public read"   ON storage.objects;
DROP POLICY IF EXISTS "boat-comment-media author write"  ON storage.objects;
DROP POLICY IF EXISTS "boat-comment-media author update" ON storage.objects;
DROP POLICY IF EXISTS "boat-comment-media author delete" ON storage.objects;

CREATE POLICY "boat-comment-media public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'boat-comment-media');

CREATE POLICY "boat-comment-media author write"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'boat-comment-media'
    AND auth.uid() IS NOT NULL
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "boat-comment-media author update"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'boat-comment-media'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "boat-comment-media author delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'boat-comment-media'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.id = auth.uid() AND p.role IN ('admin','moderator'))
    )
  );
