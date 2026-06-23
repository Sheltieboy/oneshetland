-- 060_fix_business_media_name_capture.sql
--
-- Migrations 037 & 052 defined the business-media storage write/update/delete
-- policies with an EXISTS subquery over local_businesses. The unqualified
-- `name` inside split_part(name, '/', 1) was captured by local_businesses.name
-- (the business NAME column) instead of storage.objects.name (the file path),
-- so the ownership check was always false and ALL uploads to business-media
-- were silently rejected with "new row violates row-level security policy".
--
-- Fix: qualify the path as objects.name (as the memories-media policies do).
--
-- Run via: Supabase SQL editor → paste → Run.

drop policy if exists "business-media owner write"  on storage.objects;
drop policy if exists "business-media owner update" on storage.objects;
drop policy if exists "business-media owner delete" on storage.objects;

create policy "business-media owner write"
  on storage.objects for insert
  with check (
    bucket_id = 'business-media' and auth.uid() is not null and (
      exists (select 1 from public.local_businesses b
              where b.id::text = split_part(objects.name, '/', 1) and b.owner_id = auth.uid())
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    )
  );

create policy "business-media owner update"
  on storage.objects for update
  using (
    bucket_id = 'business-media' and (
      exists (select 1 from public.local_businesses b
              where b.id::text = split_part(objects.name, '/', 1) and b.owner_id = auth.uid())
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    )
  );

create policy "business-media owner delete"
  on storage.objects for delete
  using (
    bucket_id = 'business-media' and (
      exists (select 1 from public.local_businesses b
              where b.id::text = split_part(objects.name, '/', 1) and b.owner_id = auth.uid())
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    )
  );
