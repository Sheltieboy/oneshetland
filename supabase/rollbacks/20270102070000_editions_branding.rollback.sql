-- Rollback for 20270102070000_editions_branding.sql (Editions R6 branding). Removes only the two focus-point columns. Run before the older rollbacks (reverse order).
begin;
alter table public.edition_organisers drop column if exists cover_focus;
alter table public.editions drop column if exists cover_focus;
commit;
