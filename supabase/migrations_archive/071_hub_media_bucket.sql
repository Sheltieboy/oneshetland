-- 071_hub_media_bucket.sql
-- Storage bucket for hub logos & cover images.
--
-- Path convention: hub-media/<hub_id>/<kind>/<uuid>.<ext>   (kind = logo | cover)
-- Public read; write/update/delete restricted to the hub's owner/committee
-- (or platform admin). The ownership check qualifies the path as objects.name
-- and compares hub id as text — avoiding both the unqualified-`name` capture bug
-- (see migration 060) and a uuid-cast error on a malformed path.

insert into storage.buckets (id, name, public)
values ('hub-media', 'hub-media', true)
on conflict (id) do nothing;

drop policy if exists "hub-media public read"  on storage.objects;
drop policy if exists "hub-media owner write"  on storage.objects;
drop policy if exists "hub-media owner update" on storage.objects;
drop policy if exists "hub-media owner delete" on storage.objects;

create policy "hub-media public read"
  on storage.objects for select
  using (bucket_id = 'hub-media');

create policy "hub-media owner write"
  on storage.objects for insert
  with check (
    bucket_id = 'hub-media' and auth.uid() is not null and (
      exists (select 1 from public.hubs h
              where h.id::text = split_part(objects.name, '/', 1)
                and (h.owner_id = auth.uid() or public.is_hub_admin(h.id, auth.uid())))
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    )
  );

create policy "hub-media owner update"
  on storage.objects for update
  using (
    bucket_id = 'hub-media' and (
      exists (select 1 from public.hubs h
              where h.id::text = split_part(objects.name, '/', 1)
                and (h.owner_id = auth.uid() or public.is_hub_admin(h.id, auth.uid())))
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    )
  );

create policy "hub-media owner delete"
  on storage.objects for delete
  using (
    bucket_id = 'hub-media' and (
      exists (select 1 from public.hubs h
              where h.id::text = split_part(objects.name, '/', 1)
                and (h.owner_id = auth.uid() or public.is_hub_admin(h.id, auth.uid())))
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    )
  );
