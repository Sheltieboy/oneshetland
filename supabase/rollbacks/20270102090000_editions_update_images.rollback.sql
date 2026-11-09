-- Rollback for 20270102090000_editions_update_images.sql (Editions R8). Removes only the image column. Run before the hardening rollback (reverse order).
begin;
alter table public.edition_updates drop column if exists image_url;
commit;
