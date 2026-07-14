-- Editable homepage promo tiles, managed from the admin control centre.
-- A single-row table (like email_settings): public read (the home page is public),
-- admin-only writes. Plus a `site-media` storage bucket for the tile images.
-- Purely additive.

create table if not exists public.home_content (
  id uuid primary key default gen_random_uuid(),
  welcome_title    text,
  welcome_body     text,
  welcome_href     text,
  welcome_cta      text,
  feature_title    text,
  feature_image    text,
  feature_href     text,
  spotlight_title  text,
  spotlight_body   text,
  spotlight_image  text,
  spotlight_href   text,
  spotlight_cta    text,
  updated_at       timestamptz not null default now(),
  updated_by       uuid
);

alter table public.home_content enable row level security;

drop policy if exists "home_content public read" on public.home_content;
create policy "home_content public read" on public.home_content
  for select using (true);

drop policy if exists "home_content admin write" on public.home_content;
create policy "home_content admin write" on public.home_content
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Seed exactly one row so the admin form always has something to update.
insert into public.home_content (id)
select gen_random_uuid()
where not exists (select 1 from public.home_content);

-- ── Storage bucket for homepage images (public read, admin write) ──────────────
insert into storage.buckets (id, name, public)
values ('site-media', 'site-media', true)
on conflict (id) do nothing;

drop policy if exists "site-media public read" on storage.objects;
create policy "site-media public read" on storage.objects
  for select using (bucket_id = 'site-media');

drop policy if exists "site-media admin write" on storage.objects;
create policy "site-media admin write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'site-media' and public.is_admin());

drop policy if exists "site-media admin update" on storage.objects;
create policy "site-media admin update" on storage.objects
  for update to authenticated
  using (bucket_id = 'site-media' and public.is_admin())
  with check (bucket_id = 'site-media' and public.is_admin());

drop policy if exists "site-media admin delete" on storage.objects;
create policy "site-media admin delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'site-media' and public.is_admin());
