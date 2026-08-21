-- ============================================================================
-- PHASE 3 — HELD BACK ON PURPOSE. NOT IN supabase/migrations/.
--
-- This is the last step of the memory-media cutover: flipping memories-media
-- from a public bucket to a private one, so that possession of an object URL
-- can no longer bypass a memory's visibility.
--
-- IT IS NOT A MIGRATION YET, AND THAT IS DELIBERATE.
--
-- A file in supabase/migrations/ is applied by the next `supabase db push`,
-- whoever runs it and whenever. If this one ran before the WEBSITE is deployed,
-- oneshetland.com/memories would immediately stop rendering images: the live
-- site still addresses media by persisted /object/public/ URLs, and those stop
-- resolving the moment the bucket is private.
--
-- The website code that signs for media at read time is committed and pushed
-- (oneshetland-web b7eca8b) but had NOT been built and served by Netlify at the
-- time this was written — verified repeatedly against the live page, which was
-- still emitting /object/public/ links. This session has no Netlify CLI, token
-- or build access, so it could not deploy or diagnose it.
--
-- Leaving a pending migration in the tree would be a landmine. This lives here
-- instead: version-controlled, reviewable, and inert until somebody moves it.
--
-- ── HOW TO FINISH ───────────────────────────────────────────────────────────
--
-- 1. Confirm the website deploy actually landed. The live page must emit signed
--    URLs, not public ones:
--
--      curl -s https://oneshetland.com/memories | grep -c '/object/sign/memories-media'
--
--    That number must be greater than zero, and
--
--      curl -s https://oneshetland.com/memories | grep -c '/object/public/memories-media'
--
--    must be zero. If it is not, the deploy has not happened — fix that first.
--
-- 2. Move this file into supabase/migrations/ with a current timestamp, e.g.
--    supabase/migrations/<YYYYMMDDHHMMSS>_memories_media_private.sql
--
-- 3. npx supabase db push --linked
--
-- 4. Re-check the live page renders images, and run:
--    npm test -- the storage suites assert the private flag and the
--    visibility matrix, and will confirm the cutover.
--
-- Everything else is already in place: the memory-aware SELECT policy and
-- can_view_memory() shipped in 20260821250000, and both clients resolve media
-- by signed URL. This one line is all that remains.
-- ============================================================================

update storage.buckets
   set public = false
 where id = 'memories-media';

-- Prove the read boundary is the policy, not the flag.
do $$
begin
  if (select public from storage.buckets where id = 'memories-media') then
    raise exception 'memories-media is still public';
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'memories-media visibility read'
  ) then
    raise exception 'the memory-aware read policy is missing — do not make this bucket private without it';
  end if;
end $$;
