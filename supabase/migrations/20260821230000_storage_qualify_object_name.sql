-- ============================================================================
-- `name` inside a storage policy subquery is not always the object's name.
--
-- 20260821220000 restated the resource-scoped policies and dropped a
-- qualification that mattered. The live originals read:
--
--   split_part(objects.name, '/', 1)
--
-- and the rewrite read:
--
--   split_part(name, '/', 1)
--
-- which looks equivalent and is not. That expression sits inside
--
--   exists (select 1 from public.hubs h where h.id::text = split_part(name,'/',1) ...)
--
-- and public.hubs HAS a column called `name`. Postgres resolves the inner
-- table's column first, so the policy was comparing each hub's id to the first
-- path segment of the HUB'S OWN DISPLAY NAME rather than to the object path.
-- That is never equal, so EXISTS was always false and a hub owner could not
-- upload their own hub's media.
--
-- Caught by the owner/admin matrix, which is exactly what it is for: the
-- adversarial cases all still passed, because a predicate that is always false
-- denies attackers beautifully. Only the legitimate-owner case failed.
--
-- public.local_businesses also has a `name` column, so business-media carried
-- the same fault. It did not show up in the matrix because the business owner
-- used for the test is also a platform admin, and the `or public.is_admin()`
-- branch let the insert through — a false pass that hid a real break for every
-- non-admin business owner.
--
-- memories-media was unaffected by luck rather than by care: public.memories
-- has no `name` column, so the reference resolved to storage.objects.name. It
-- is qualified here anyway, because relying on the absence of a column name in
-- another table is not a property worth depending on.
--
-- Same class as the Step 6 bug where a RETURNS TABLE output column shadowed a
-- table column: it compiles, it runs, and it is silently wrong.
-- ============================================================================

-- business-media ─────────────────────────────────────────────────────────────
drop policy if exists "business-media owner write"  on storage.objects;
drop policy if exists "business-media owner update" on storage.objects;
drop policy if exists "business-media owner delete" on storage.objects;

create policy "business-media owner write" on storage.objects
  for insert with check (
    bucket_id = 'business-media' and auth.uid() is not null
    and (exists (select 1 from public.local_businesses b
                  where b.id::text = split_part(objects.name,'/',1) and b.owner_id = auth.uid())
         or public.is_admin()));
create policy "business-media owner update" on storage.objects
  for update using (
    bucket_id = 'business-media'
    and (exists (select 1 from public.local_businesses b
                  where b.id::text = split_part(objects.name,'/',1) and b.owner_id = auth.uid())
         or public.is_admin()));
create policy "business-media owner delete" on storage.objects
  for delete using (
    bucket_id = 'business-media'
    and (exists (select 1 from public.local_businesses b
                  where b.id::text = split_part(objects.name,'/',1) and b.owner_id = auth.uid())
         or public.is_admin()));

-- hub-media ──────────────────────────────────────────────────────────────────
drop policy if exists "hub-media owner write"  on storage.objects;
drop policy if exists "hub-media owner update" on storage.objects;
drop policy if exists "hub-media owner delete" on storage.objects;

create policy "hub-media owner write" on storage.objects
  for insert with check (
    bucket_id = 'hub-media' and auth.uid() is not null
    and (exists (select 1 from public.hubs h
                  where h.id::text = split_part(objects.name,'/',1)
                    and (h.owner_id = auth.uid() or public.is_hub_admin(h.id, auth.uid())))
         or public.is_admin()));
create policy "hub-media owner update" on storage.objects
  for update using (
    bucket_id = 'hub-media'
    and (exists (select 1 from public.hubs h
                  where h.id::text = split_part(objects.name,'/',1)
                    and (h.owner_id = auth.uid() or public.is_hub_admin(h.id, auth.uid())))
         or public.is_admin()));
create policy "hub-media owner delete" on storage.objects
  for delete using (
    bucket_id = 'hub-media'
    and (exists (select 1 from public.hubs h
                  where h.id::text = split_part(objects.name,'/',1)
                    and (h.owner_id = auth.uid() or public.is_hub_admin(h.id, auth.uid())))
         or public.is_admin()));

-- memories-media ─────────────────────────────────────────────────────────────
-- Qualified for the same reason, even though it works today.
drop policy if exists "memories-media author write"  on storage.objects;
drop policy if exists "memories-media author update" on storage.objects;
drop policy if exists "memories-media author delete" on storage.objects;

create policy "memories-media author write" on storage.objects
  for insert with check (
    bucket_id = 'memories-media' and auth.uid() is not null
    and (exists (select 1 from public.memories m
                  where m.id::text = (storage.foldername(objects.name))[1] and m.author_id = auth.uid())
         or public.is_admin()));
create policy "memories-media author update" on storage.objects
  for update using (
    bucket_id = 'memories-media'
    and (exists (select 1 from public.memories m
                  where m.id::text = (storage.foldername(objects.name))[1] and m.author_id = auth.uid())
         or public.is_admin()));
create policy "memories-media author delete" on storage.objects
  for delete using (
    bucket_id = 'memories-media'
    and (exists (select 1 from public.memories m
                  where m.id::text = (storage.foldername(objects.name))[1] and m.author_id = auth.uid())
         or public.is_admin()));

-- Guard: no resource-scoped storage policy may reference an unqualified `name`
-- inside a subquery again.
do $$
declare v_bad text;
begin
  select string_agg(policyname, ', ') into v_bad
    from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and (policyname like 'business-media%' or policyname like 'hub-media%'
          or policyname like 'memories-media%')
     and coalesce(qual, with_check) is not null
     and coalesce(qual, with_check) like '%EXISTS%'
     and coalesce(qual, with_check) not like '%objects.name%';
  if v_bad is not null then
    raise exception 'policy still uses an unqualified name inside a subquery: %', v_bad;
  end if;
end $$;
