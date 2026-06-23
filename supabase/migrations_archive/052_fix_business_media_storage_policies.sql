-- Migration 052: Fix business-media storage write policies
--
-- Replaces (storage.foldername(name))[1] with split_part(name, '/', 1).
-- storage.foldername() is Supabase-internal and its array indexing has been
-- the source of silent RLS failures when the path has more than one subfolder
-- (e.g. <business_id>/event/<filename>).  split_part is plain SQL and
-- unambiguously returns the first path segment regardless of depth.
--
-- Run via: Supabase SQL editor → paste → Run.

DROP POLICY IF EXISTS "business-media owner write"  ON storage.objects;
DROP POLICY IF EXISTS "business-media owner update" ON storage.objects;
DROP POLICY IF EXISTS "business-media owner delete" ON storage.objects;

-- INSERT — any authenticated business owner may upload under their business folder.
CREATE POLICY "business-media owner write"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'business-media'
    AND auth.uid() IS NOT NULL
    AND (
      EXISTS (
        SELECT 1 FROM public.local_businesses b
        WHERE b.id::text = split_part(name, '/', 1)
          AND b.owner_id  = auth.uid()
      )
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = auth.uid() AND p.role = 'admin'
      )
    )
  );

-- UPDATE — same ownership check on the stored path.
CREATE POLICY "business-media owner update"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'business-media'
    AND (
      EXISTS (
        SELECT 1 FROM public.local_businesses b
        WHERE b.id::text = split_part(name, '/', 1)
          AND b.owner_id  = auth.uid()
      )
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = auth.uid() AND p.role = 'admin'
      )
    )
  );

-- DELETE — same.
CREATE POLICY "business-media owner delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'business-media'
    AND (
      EXISTS (
        SELECT 1 FROM public.local_businesses b
        WHERE b.id::text = split_part(name, '/', 1)
          AND b.owner_id  = auth.uid()
      )
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = auth.uid() AND p.role = 'admin'
      )
    )
  );
