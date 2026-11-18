-- Rollback for 20270102020000_editions_visitor.sql. Deletes every visitor's saved Editions and plans (no other data is touched).
begin;
drop function if exists public.edition_my_plan();
drop function if exists public.edition_my_flags(uuid);
drop function if exists public.edition_plan_toggle(uuid, text, uuid, boolean);
drop function if exists public.edition_save(uuid, boolean);
drop table if exists public.edition_plan_items;
drop table if exists public.edition_saves;
delete from public.analytics_event_defs where event_name in ('edition_saved', 'edition_plan_added', 'edition_calendar_exported', 'edition_search');
commit;
