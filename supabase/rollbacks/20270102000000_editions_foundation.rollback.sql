-- Rollback for 20270102000000_editions_foundation.sql. Drops ONLY objects that migration created. Run, then
-- `supabase migration repair --status reverted 20270102000000`. Loses all Edition data (none exists before launch).
drop policy if exists "edition-media public read" on storage.objects;
drop policy if exists "edition-media member write" on storage.objects;
drop policy if exists "edition-media member update" on storage.objects;
drop policy if exists "edition-media member delete" on storage.objects;
delete from storage.objects where bucket_id = 'edition-media';
delete from storage.buckets where id = 'edition-media';
delete from public.analytics_event_defs where event_name in ('edition_viewed','edition_session_viewed','edition_ticket_clicked');
drop table if exists public.edition_audit_log, public.edition_entitlements, public.edition_sponsors, public.edition_updates, public.edition_sessions,
  public.edition_venues, public.edition_pages, public.editions, public.edition_series, public.edition_organiser_verifications,
  public.edition_organiser_invites, public.edition_organiser_members, public.edition_organisers, public.edition_reserved_names cascade;
do $$ declare r record; begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (p.proname like 'edition%' or p.proname in ('create_edition_organiser','request_edition_organiser_verification','invite_edition_member','revoke_edition_invite','accept_edition_invite','set_edition_member_role','remove_edition_member','admin_decide_edition_organiser','admin_link_edition_organiser_hub','admin_grant_edition_entitlement','admin_void_edition_entitlement','admin_mark_edition_test','organisers_audit_status'))
  loop execute 'drop function if exists ' || r.sig || ' cascade'; end loop;
end $$;
