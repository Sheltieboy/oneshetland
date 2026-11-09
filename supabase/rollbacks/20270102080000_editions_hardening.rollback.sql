-- Rollback for 20270102080000_editions_hardening.sql. Restores the earlier (wider) grants; review before running: it re-opens the exposures the migration closed.
begin;
drop trigger if exists aa_edition_links_invite_guard on public.edition_links;
drop function if exists public.edition_links_invite_guard() cascade;
drop function if exists public.admin_edition_org_internal(uuid) cascade;
drop function if exists public.admin_edition_org_flags() cascade;
drop function if exists public.delete_member_editions(uuid) cascade;
grant select on public.edition_organisers to anon, authenticated;
grant select on public.edition_venues to anon;
grant select on public.edition_updates to anon;
grant select on public.edition_payments to authenticated;
grant select on public.edition_participations to authenticated;
commit;
