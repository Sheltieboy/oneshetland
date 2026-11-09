-- Editions R8: an optional photograph on an editorial update (the Journal on an Edition's home page). One nullable, checked column, written by the organiser team with a
-- column-level grant like its neighbours and readable by the public like the rest of an update. Nothing else changes.
alter table public.edition_updates
  add column if not exists image_url text check (image_url is null or image_url ~ '^https://[^[:space:]\\<>"'']+$');
comment on column public.edition_updates.image_url is 'Optional photograph shown with the update in the Journal. https only.';
grant insert (image_url), update (image_url) on public.edition_updates to authenticated;
grant select (image_url) on public.edition_updates to anon;   -- anon reads updates by an explicit column list (see the hardening migration)
