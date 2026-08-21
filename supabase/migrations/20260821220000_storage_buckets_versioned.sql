-- ============================================================================
-- Storage stops being Dashboard-shaped and becomes repository-shaped.
--
-- WHAT M2 ACTUALLY FOUND, ONCE RE-DERIVED
--
-- The audit said eight buckets existed and only two were in migrations. The
-- live picture is different in both directions, which is why it was re-read
-- rather than trusted:
--
--   boat-comment-media   IN CODE, NOT IN PRODUCTION. Both clients upload to it
--                        (lib/boats-api.ts and BoatDiscussion.tsx). Its bucket
--                        and policies live in migrations_ARCHIVE/044, which is
--                        not applied, so attaching a photo to a boat comment
--                        fails against a bucket that does not exist.
--   cruise-media         IN PRODUCTION, NOT IN THE AUDIT. 70 objects, 13 MB.
--   employer-logos       IN PRODUCTION, NOT IN THE AUDIT. Empty.
--
-- The policies themselves were in better shape than the finding implied: all
-- nine live buckets already had ownership-checked INSERT/UPDATE/DELETE. What
-- was missing was that none of it was in git, so a restored project would have
-- come up with no buckets and no policies at all.
--
-- WHAT THIS MIGRATION DOES NOT DO
--
-- It does not drop or recreate a single bucket. Every bucket already holding
-- objects is updated in place — visibility, size limit and MIME list only. No
-- storage.objects row is touched, no path is rewritten, no media is moved. The
-- 280 existing objects are exactly where they were.
--
-- Size limits are set ABOVE what each bucket already holds, so nothing that
-- uploads successfully today starts failing tomorrow. hub-media already holds a
-- 16.2 MB image, so its limit is 20 MB rather than the 10 MB that would look
-- tidier and would break the next one.
--
-- THE ONE THING THIS DELIBERATELY LEAVES ALONE — SEE THE REPORT
--
-- memories-media is a PUBLIC bucket, and public.memories has a three-value
-- visibility model (public / community / private) which its own RLS enforces
-- properly. Storage does not: the SELECT policy is `bucket_id =
-- 'memories-media'` and the bucket's public flag serves objects directly. So a
-- memory marked private or community would keep its photos world-readable.
--
-- All 25 memories are currently 'public', so nothing is exposed today. Fixing
-- it properly means a private bucket plus signed URLs, and memory_media.url
-- holds 10 persisted /object/public/ URLs that the LIVE website renders at
-- oneshetland.com/memories. Flipping the flag from here would break that page
-- for real visitors before the website could be redeployed, and this session
-- cannot deploy the website. It is reported rather than half-done.
-- ============================================================================


-- ── Buckets ─────────────────────────────────────────────────────────────────
--
-- ON CONFLICT DO UPDATE, never DELETE + INSERT: recreating a populated bucket
-- would orphan its objects. Only the metadata columns are written.
--
-- Limits are chosen per bucket from what each actually stores, not one number
-- applied everywhere:
--
--   avatars            8 MB   largest today 6.2 MB — the clients do not resize
--   business-media    10 MB   largest today 0.2 MB
--   boat-comment-media 10 MB  new; a phone photo attached to a comment
--   cruise-media      10 MB   largest today 0.6 MB, admin-managed
--   employer-logos     5 MB   empty; a logo needs no more
--   event-media       10 MB   unchanged, already set
--   hub-media         20 MB   largest today 16.2 MB
--   memories-media    25 MB   images AND audio recordings, which run long
--   site-media        10 MB   largest today 0.06 MB
--   spik-audio        10 MB   unchanged, already set
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('avatars',            'avatars',            true,  8388608,
   array['image/jpeg','image/jpg','image/png','image/webp']),
  ('boat-comment-media', 'boat-comment-media', true, 10485760,
   array['image/jpeg','image/jpg','image/png','image/webp']),
  ('business-media',     'business-media',     true, 10485760,
   array['image/jpeg','image/jpg','image/png','image/webp']),
  ('cruise-media',       'cruise-media',       true, 10485760,
   array['image/jpeg','image/jpg','image/png','image/webp']),
  ('employer-logos',     'employer-logos',     true,  5242880,
   array['image/jpeg','image/jpg','image/png','image/webp']),
  ('event-media',        'event-media',        true, 10485760,
   array['image/jpeg','image/jpg','image/png','image/webp']),
  ('hub-media',          'hub-media',          true, 20971520,
   array['image/jpeg','image/jpg','image/png','image/webp']),
  ('memories-media',     'memories-media',     true, 26214400,
   array['image/jpeg','image/jpg','image/png','image/webp',
         'audio/webm','audio/ogg','audio/mpeg','audio/mp4','audio/m4a','audio/wav']),
  ('site-media',         'site-media',         true, 10485760,
   array['image/jpeg','image/jpg','image/png','image/webp']),
  ('spik-audio',         'spik-audio',         true, 10485760,
   array['audio/webm','audio/ogg','audio/mpeg','audio/mp4'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;


-- ── Policies ────────────────────────────────────────────────────────────────
--
-- Named exactly, dropped then created, so re-running produces the same set
-- rather than accumulating duplicates. Only OneShetland's own policies are
-- named — nothing Supabase manages is touched.
--
-- The ownership expressions below are the ones already live, restated here so
-- git is the source rather than the Dashboard. Each was checked against the
-- path the clients actually write:
--
--   avatars             <user_id>/…                     foldername[1]
--   boat-comment-media  <author_id>/…                   foldername[1]
--   business-media      <business_id>/<kind>/…          split_part 1
--   employer-logos      <user_id>/…                     foldername[1]
--   event-media         <user_id>/events/…              split_part 1
--   hub-media           <hub_id>/<kind>/…               split_part 1
--   memories-media      <memory_id>/<kind>/…            foldername[1]
--   spik-audio          <word_id>/<user_id>/…           foldername[2]
--   site-media, cruise-media   no folder convention; admin-gated
--
-- UPDATE policies deliberately carry USING only. Postgres reuses USING as the
-- WITH CHECK when none is given, so a user cannot rename an object out of their
-- own namespace into somebody else's — the new row must satisfy the same test.

-- avatars ────────────────────────────────────────────────────────────────────
drop policy if exists "avatars public read"   on storage.objects;
drop policy if exists "avatars owner write"   on storage.objects;
drop policy if exists "avatars owner update"  on storage.objects;
drop policy if exists "avatars owner delete"  on storage.objects;

create policy "avatars public read" on storage.objects
  for select using (bucket_id = 'avatars');
create policy "avatars owner write" on storage.objects
  for insert with check (
    bucket_id = 'avatars' and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatars owner update" on storage.objects
  for update using (
    bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatars owner delete" on storage.objects
  for delete using (
    bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- boat-comment-media ─────────────────────────────────────────────────────────
-- Restored from migrations_archive/044, which never ran against production.
drop policy if exists "boat-comment-media public read"   on storage.objects;
drop policy if exists "boat-comment-media author write"  on storage.objects;
drop policy if exists "boat-comment-media author update" on storage.objects;
drop policy if exists "boat-comment-media author delete" on storage.objects;

create policy "boat-comment-media public read" on storage.objects
  for select using (bucket_id = 'boat-comment-media');
create policy "boat-comment-media author write" on storage.objects
  for insert with check (
    bucket_id = 'boat-comment-media' and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text);
create policy "boat-comment-media author update" on storage.objects
  for update using (
    bucket_id = 'boat-comment-media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "boat-comment-media author delete" on storage.objects
  for delete using (
    bucket_id = 'boat-comment-media'
    and ((storage.foldername(name))[1] = auth.uid()::text
         or exists (select 1 from public.profiles p
                     where p.id = auth.uid() and p.role in ('admin','moderator'))));

-- business-media ─────────────────────────────────────────────────────────────
-- Ownership comes from local_businesses, not from the caller's word for it.
drop policy if exists "business-media public read"  on storage.objects;
drop policy if exists "business-media owner write"  on storage.objects;
drop policy if exists "business-media owner update" on storage.objects;
drop policy if exists "business-media owner delete" on storage.objects;

create policy "business-media public read" on storage.objects
  for select using (bucket_id = 'business-media');
create policy "business-media owner write" on storage.objects
  for insert with check (
    bucket_id = 'business-media' and auth.uid() is not null
    and (exists (select 1 from public.local_businesses b
                  where b.id::text = split_part(name,'/',1) and b.owner_id = auth.uid())
         or public.is_admin()));
create policy "business-media owner update" on storage.objects
  for update using (
    bucket_id = 'business-media'
    and (exists (select 1 from public.local_businesses b
                  where b.id::text = split_part(name,'/',1) and b.owner_id = auth.uid())
         or public.is_admin()));
create policy "business-media owner delete" on storage.objects
  for delete using (
    bucket_id = 'business-media'
    and (exists (select 1 from public.local_businesses b
                  where b.id::text = split_part(name,'/',1) and b.owner_id = auth.uid())
         or public.is_admin()));

-- cruise-media ───────────────────────────────────────────────────────────────
drop policy if exists "cruise-media public read"  on storage.objects;
drop policy if exists "cruise-media admin write"  on storage.objects;
drop policy if exists "cruise-media admin update" on storage.objects;
drop policy if exists "cruise-media admin delete" on storage.objects;

create policy "cruise-media public read" on storage.objects
  for select using (bucket_id = 'cruise-media');
create policy "cruise-media admin write" on storage.objects
  for insert with check (bucket_id = 'cruise-media' and public.is_admin());
create policy "cruise-media admin update" on storage.objects
  for update using (bucket_id = 'cruise-media' and public.is_admin());
create policy "cruise-media admin delete" on storage.objects
  for delete using (bucket_id = 'cruise-media' and public.is_admin());

-- employer-logos ─────────────────────────────────────────────────────────────
drop policy if exists "employer-logos public read"  on storage.objects;
drop policy if exists "employer-logos owner write"  on storage.objects;
drop policy if exists "employer-logos owner update" on storage.objects;
drop policy if exists "employer-logos owner delete" on storage.objects;

create policy "employer-logos public read" on storage.objects
  for select using (bucket_id = 'employer-logos');
create policy "employer-logos owner write" on storage.objects
  for insert with check (
    bucket_id = 'employer-logos' and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text);
create policy "employer-logos owner update" on storage.objects
  for update using (
    bucket_id = 'employer-logos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "employer-logos owner delete" on storage.objects
  for delete using (
    bucket_id = 'employer-logos' and (storage.foldername(name))[1] = auth.uid()::text);

-- event-media ────────────────────────────────────────────────────────────────
drop policy if exists "event-media public read"  on storage.objects;
drop policy if exists "event-media owner write"  on storage.objects;
drop policy if exists "event-media owner update" on storage.objects;
drop policy if exists "event-media owner delete" on storage.objects;

create policy "event-media public read" on storage.objects
  for select using (bucket_id = 'event-media');
create policy "event-media owner write" on storage.objects
  for insert with check (
    bucket_id = 'event-media' and auth.uid() is not null
    and split_part(name,'/',1) = auth.uid()::text);
create policy "event-media owner update" on storage.objects
  for update using (
    bucket_id = 'event-media' and split_part(name,'/',1) = auth.uid()::text);
create policy "event-media owner delete" on storage.objects
  for delete using (
    bucket_id = 'event-media'
    and (split_part(name,'/',1) = auth.uid()::text or public.is_admin()));

-- hub-media ──────────────────────────────────────────────────────────────────
-- Owner or hub ADMIN, deliberately not "any member": membership does not imply
-- permission to replace a hub's branding.
drop policy if exists "hub-media public read"  on storage.objects;
drop policy if exists "hub-media owner write"  on storage.objects;
drop policy if exists "hub-media owner update" on storage.objects;
drop policy if exists "hub-media owner delete" on storage.objects;

create policy "hub-media public read" on storage.objects
  for select using (bucket_id = 'hub-media');
create policy "hub-media owner write" on storage.objects
  for insert with check (
    bucket_id = 'hub-media' and auth.uid() is not null
    and (exists (select 1 from public.hubs h
                  where h.id::text = split_part(name,'/',1)
                    and (h.owner_id = auth.uid() or public.is_hub_admin(h.id, auth.uid())))
         or public.is_admin()));
create policy "hub-media owner update" on storage.objects
  for update using (
    bucket_id = 'hub-media'
    and (exists (select 1 from public.hubs h
                  where h.id::text = split_part(name,'/',1)
                    and (h.owner_id = auth.uid() or public.is_hub_admin(h.id, auth.uid())))
         or public.is_admin()));
create policy "hub-media owner delete" on storage.objects
  for delete using (
    bucket_id = 'hub-media'
    and (exists (select 1 from public.hubs h
                  where h.id::text = split_part(name,'/',1)
                    and (h.owner_id = auth.uid() or public.is_hub_admin(h.id, auth.uid())))
         or public.is_admin()));

-- memories-media ─────────────────────────────────────────────────────────────
-- Write/update/delete follow the memory's author, which is correct. SELECT
-- remains open because the bucket is public — the mismatch documented at the
-- top of this file, left for a coordinated change rather than broken here.
drop policy if exists "memories-media public read"    on storage.objects;
drop policy if exists "memories-media author write"   on storage.objects;
drop policy if exists "memories-media author update"  on storage.objects;
drop policy if exists "memories-media author delete"  on storage.objects;

create policy "memories-media public read" on storage.objects
  for select using (bucket_id = 'memories-media');
create policy "memories-media author write" on storage.objects
  for insert with check (
    bucket_id = 'memories-media' and auth.uid() is not null
    and (exists (select 1 from public.memories m
                  where m.id::text = (storage.foldername(name))[1] and m.author_id = auth.uid())
         or public.is_admin()));
create policy "memories-media author update" on storage.objects
  for update using (
    bucket_id = 'memories-media'
    and (exists (select 1 from public.memories m
                  where m.id::text = (storage.foldername(name))[1] and m.author_id = auth.uid())
         or public.is_admin()));
create policy "memories-media author delete" on storage.objects
  for delete using (
    bucket_id = 'memories-media'
    and (exists (select 1 from public.memories m
                  where m.id::text = (storage.foldername(name))[1] and m.author_id = auth.uid())
         or public.is_admin()));

-- site-media ─────────────────────────────────────────────────────────────────
drop policy if exists "site-media public read"  on storage.objects;
drop policy if exists "site-media admin write"  on storage.objects;
drop policy if exists "site-media admin update" on storage.objects;
drop policy if exists "site-media admin delete" on storage.objects;

create policy "site-media public read" on storage.objects
  for select using (bucket_id = 'site-media');
create policy "site-media admin write" on storage.objects
  for insert to authenticated with check (bucket_id = 'site-media' and public.is_admin());
create policy "site-media admin update" on storage.objects
  for update to authenticated
  using (bucket_id = 'site-media' and public.is_admin())
  with check (bucket_id = 'site-media' and public.is_admin());
create policy "site-media admin delete" on storage.objects
  for delete to authenticated using (bucket_id = 'site-media' and public.is_admin());

-- spik-audio ─────────────────────────────────────────────────────────────────
-- The live INSERT policy was `bucket_id = 'spik-audio'` and nothing else: any
-- signed-in user could write to any path, including one naming another
-- contributor. Both clients already write <word_id>/<user_id>/…, and the mobile
-- helper's own comment claims "RLS lets a signed-in user write under their own
-- folder" — which was the intent, not the enforcement. Now it is enforced.
drop policy if exists "spik-audio public read"      on storage.objects;
drop policy if exists "spik-audio signed-in write"  on storage.objects;
drop policy if exists "spik-audio owner write"      on storage.objects;
drop policy if exists "spik-audio owner update"     on storage.objects;
drop policy if exists "spik-audio admin delete"     on storage.objects;

create policy "spik-audio public read" on storage.objects
  for select using (bucket_id = 'spik-audio');
create policy "spik-audio owner write" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'spik-audio' and auth.uid() is not null
    and (storage.foldername(name))[2] = auth.uid()::text);
create policy "spik-audio owner update" on storage.objects
  for update to authenticated using (
    bucket_id = 'spik-audio' and (storage.foldername(name))[2] = auth.uid()::text);
create policy "spik-audio admin delete" on storage.objects
  for delete to authenticated using (
    bucket_id = 'spik-audio'
    and ((storage.foldername(name))[2] = auth.uid()::text or public.is_admin()));


-- ── Prove it in the transaction that did it ─────────────────────────────────
do $$
declare
  v_missing text;
  v_unpoliced text;
begin
  select string_agg(b.id, ', ') into v_missing
    from (values ('avatars'),('boat-comment-media'),('business-media'),('cruise-media'),
                 ('employer-logos'),('event-media'),('hub-media'),('memories-media'),
                 ('site-media'),('spik-audio')) b(id)
   where not exists (select 1 from storage.buckets sb where sb.id = b.id);
  if v_missing is not null then
    raise exception 'buckets missing after migration: %', v_missing;
  end if;

  -- every bucket must have all four commands covered
  select string_agg(b.id || '(' || c.cmd || ')', ', ') into v_unpoliced
    from (values ('avatars'),('boat-comment-media'),('business-media'),('cruise-media'),
                 ('employer-logos'),('event-media'),('hub-media'),('memories-media'),
                 ('site-media'),('spik-audio')) b(id)
    cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) c(cmd)
   where not exists (
     select 1 from pg_policies p
      where p.schemaname='storage' and p.tablename='objects'
        and p.cmd = c.cmd and p.policyname like b.id || ' %');
  if v_unpoliced is not null then
    raise exception 'bucket/command combinations with no policy: %', v_unpoliced;
  end if;
end $$;
