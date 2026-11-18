-- Undo 20270308000000. The warning goes; the synchronisation from 20270307000000 stays exactly as it was.
--
-- The table is dropped: a notice is a prompt about work somebody has either done or not done, and keeping a pile of
-- stale prompts after the feature is gone helps nobody. No page, listing or Edition is touched either way.

begin;

drop function if exists public.edition_content_review(uuid);
drop function if exists public.edition_content_notice_resolve(uuid);
drop function if exists public.edition_prose_cues(timestamptz, text, text);

-- events_sync_edition_sessions, exactly as 20270307000000 left it: mirror the five shared fields, raise nothing.
create or replace function public.events_sync_edition_sessions() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.edition_sessions s
     set title        = new.title,
         starts_at    = new.starts_at,
         ends_at      = new.ends_at,
         venue_text   = public.edition_event_place(new.venue, new.locality),
         event_status = new.status,
         updated_at   = now()
   where s.event_id = new.id;
  return null;
end $$;

drop table if exists public.edition_content_notices;

do $$
begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.events'::regclass and tgname = 'events_sync_edition_sessions') then
    raise exception 'rollback post-check: the sync trigger was lost';
  end if;
  if (select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'events_sync_edition_sessions') like '%edition_content_notices%' then
    raise exception 'rollback post-check: the sync still writes notices';
  end if;
  if to_regclass('public.edition_content_notices') is not null then raise exception 'rollback post-check: the table survived'; end if;
end $$;

commit;
