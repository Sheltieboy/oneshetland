-- Undo 20270307000000. Takes the synchronisation out and leaves every session exactly as it is.
--
-- The columns are deliberately KEPT. Dropping event_id would destroy the record of which programme items are which
-- What's On events, which is the only part of this that cannot be worked out again. Everything a visitor sees is in
-- title/starts_at/ends_at/venue_text already, so with the triggers gone each session simply stops following its
-- event — which is precisely the behaviour this migration replaced. Nothing disappears and nothing changes on screen.

begin;

drop trigger if exists events_sync_edition_sessions on public.events;
drop trigger if exists events_detach_edition_sessions on public.events;
drop trigger if exists aa_edition_sessions_mirror on public.edition_sessions;

drop function if exists public.events_sync_edition_sessions();
drop function if exists public.events_detach_edition_sessions();
drop function if exists public.edition_sessions_mirror();
drop function if exists public.edition_linkable_events(uuid, text);
drop function if exists public.edition_session_link_event(uuid, uuid);
drop function if exists public.edition_session_unlink_event(uuid);
drop function if exists public.edition_session_may_link(uuid, uuid);
drop function if exists public.edition_session_state(text, text);
drop function if exists public.edition_event_place(text, text);

-- The window check, exactly as it was before: every session held to the Edition's dates on every write.
create or replace function public.edition_sessions_window() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare e public.editions%rowtype; d date;
begin
  select * into e from public.editions where id = new.edition_id;
  d := (new.starts_at at time zone e.timezone)::date;
  if d < e.starts_on - 1 or d > e.ends_on + 1 then
    raise exception 'session falls outside the edition dates' using errcode = '23514', hint = 'session_outside_edition';
  end if;
  if new.venue_id is not null and not exists (select 1 from public.edition_venues v where v.id = new.venue_id and v.organiser_id = e.organiser_id) then
    raise exception 'venue belongs to another organiser' using errcode = '42501';
  end if;
  return new;
end $$;

do $$
declare n integer;
begin
  select count(*) into n from public.edition_sessions where title is null or starts_at is null;
  if n > 0 then raise exception 'rollback post-check: % session(s) lost their details', n; end if;
  if exists (select 1 from pg_trigger where tgrelid = 'public.events'::regclass and tgname like 'events_%edition_sessions') then
    raise exception 'rollback post-check: an events trigger survived';
  end if;
end $$;

commit;
