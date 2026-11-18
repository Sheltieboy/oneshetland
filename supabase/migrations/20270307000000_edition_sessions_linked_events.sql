-- Edition programme items that ARE a What's On event now say so, and follow it.
--
-- THE PROBLEM. edition_sessions was a flat copy. A programme item built from an event carried its own title, date,
-- time and venue, with nothing joining the two, so an event could be corrected in What's On while the Edition went on
-- showing the old details. That is not hypothetical: the Lerwick Christmas Parade was corrected from Sunday 29 to
-- Saturday 28 November 2026 on 18 November and the Edition had to be corrected by hand, in four places, afterwards.
--
-- THE SHAPE OF THE FIX. A session may name the event it represents (`event_id`). While it does, the four fields the
-- two genuinely share — title, start, end, where — plus the event's own status are MIRRORED into the session by the
-- database, on every change, and cannot be edited by hand. Everything else about the session stays the Edition's own.
--
-- WHY MIRRORED COLUMNS AND NOT A VIEW. A view resolving the event at read time would be the tidier model, but it is
-- only correct for the readers that use it, and the programme is read from eight places today (the Edition page and
-- its programme, a session's own page, the calendar file, the sitemap, the visitor's plan, the readiness checklist,
-- the manage screens and the admin counts). One reader left on the table would be exactly the bug being fixed here.
-- Mirroring puts the answer in the row, so every reader — including any written later, and any written by someone
-- who has never read this file — is correct without being told. The event stays the single authority: the mirrored
-- columns are written by trigger only, never by hand, so they cannot drift.
--
-- WHAT IS NOT MIRRORED, AND WHY. The Edition's own words about an item are the point of an Edition, so description,
-- photograph, presenters, price note, ticket link, type and running order stay editorial and are never overwritten.
-- A session's description is SEEDED from the event's when it is first linked and is the Edition's own from then on.
--
-- CONSENT IS NOT WEAKENED. Linking is not a way to put somebody else's event in your Edition. It is allowed only
-- where the person already controls that event, or where the event's owner has ALREADY approved a partnership with
-- this Edition (edition_links, state 'approved'), or where platform staff link one of OneShetland's own platform
-- events. The same authority edition_controls_subject() uses everywhere else.

begin;

-- ── 1. the link, and the room to mirror into ───────────────────────────────────────────────────────────────────────
alter table public.edition_sessions
  add column if not exists event_id          uuid references public.events (id) on delete set null,
  add column if not exists linked_at         timestamptz,
  -- Set when the event behind a linked session is DELETED. The session keeps its last known details and stays in the
  -- programme: an Edition must never lose a listing because somebody tidied up What's On.
  add column if not exists event_detached_at timestamptz,
  -- Where the event says it is. Sessions keep venue_id for the organiser's OWN venues; an event has free text.
  add column if not exists venue_text        text,
  -- The event's own status, mirrored. Null when the session is not linked.
  add column if not exists event_status      text,
  -- What the ORGANISER asked for. `status` stays the resolved answer that every existing reader already reads, so a
  -- cancelled event shows as cancelled without one line of reading code changing.
  add column if not exists organiser_status  text not null default 'scheduled';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'edition_sessions_venue_text_len') then
    alter table public.edition_sessions add constraint edition_sessions_venue_text_len
      check (venue_text is null or char_length(venue_text) <= 160);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'edition_sessions_organiser_status') then
    alter table public.edition_sessions add constraint edition_sessions_organiser_status
      check (organiser_status in ('scheduled', 'cancelled', 'changed'));
  end if;
  -- A detached session is one that HAD an event. It can never be detached and linked at the same time.
  if not exists (select 1 from pg_constraint where conname = 'edition_sessions_detached_unlinked') then
    alter table public.edition_sessions add constraint edition_sessions_detached_unlinked
      check (event_detached_at is null or event_id is null);
  end if;
end $$;

-- One session per event per Edition: the same event cannot be listed twice in one programme.
create unique index if not exists edition_sessions_one_per_event
  on public.edition_sessions (edition_id, event_id) where event_id is not null;
-- The mirror trigger looks sessions up BY event, on every event update: this index is what keeps that cheap.
create index if not exists edition_sessions_event_idx
  on public.edition_sessions (event_id) where event_id is not null;

-- The new columns are readable by everyone who can already read the row, and writable by nobody: they are maintained
-- by trigger. organiser_status is reached through `status`, which is already granted, so the manage screen is unchanged.
grant select on public.edition_sessions to anon, authenticated;

-- ── 2. the one place the mapping is written ────────────────────────────────────────────────────────────────────────

-- Where an event says it is, as one line. `venue` is the place, `locality` the district; either may be blank.
create or replace function public.edition_event_place(p_venue text, p_locality text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select nullif(btrim(concat_ws(', ', nullif(btrim(coalesce(p_venue, '')), ''), nullif(btrim(coalesce(p_locality, '')), ''))), '')
$$;

-- What a visitor is told, given what the organiser asked for and what the event says. The event wins when it has
-- something to say, because "cancelled" from the source is never overridden by an Edition that has not noticed yet.
create or replace function public.edition_session_state(p_organiser_status text, p_event_status text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case
    when p_event_status = 'cancelled' then 'cancelled'
    when p_event_status = 'postponed' then 'changed'
    when p_organiser_status in ('cancelled', 'changed') then p_organiser_status
    else 'scheduled' end
$$;

-- ── 3. a linked session cannot be edited out of step with its event ────────────────────────────────────────────────
--
-- This runs on EVERY write to edition_sessions, whoever makes it. While a session is linked the five mirrored fields
-- are taken from the event and any attempt to set them by hand is simply overwritten — so there is no path, through
-- the manage screen, the API, a script or psql, by which a linked session can come to disagree with its event.
create or replace function public.edition_sessions_mirror() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.events%rowtype;
begin
  -- An outside writer only knows about `status`; read their intent out of it before it is recomputed.
  if tg_op = 'INSERT' then
    if new.status is distinct from 'scheduled' then new.organiser_status := new.status; end if;
  elsif new.status is distinct from old.status and new.organiser_status is not distinct from old.organiser_status then
    new.organiser_status := new.status;
  end if;

  if new.event_id is not null then
    select * into e from public.events where id = new.event_id;
    if not found then
      raise exception 'that What''s On event no longer exists' using errcode = 'P0002', hint = 'event_missing';
    end if;
    new.title             := e.title;
    new.starts_at         := e.starts_at;
    new.ends_at           := e.ends_at;
    new.venue_text        := public.edition_event_place(e.venue, e.locality);
    new.event_status      := e.status;
    new.event_detached_at := null;
  else
    -- Not linked (or detached): the event's status no longer speaks for it. The snapshot in title/starts_at/... stays
    -- exactly as it was, which is what keeps a detached session in the programme instead of blanking it.
    new.event_status := null;
  end if;

  new.status := public.edition_session_state(new.organiser_status, new.event_status);
  return new;
end $$;

drop trigger if exists aa_edition_sessions_mirror on public.edition_sessions;
-- Named to sort before edition_sessions_window, so the window check sees the mirrored dates, not the submitted ones.
create trigger aa_edition_sessions_mirror before insert or update on public.edition_sessions
  for each row execute function public.edition_sessions_mirror();

-- ── 4. the window check stops holding a linked session hostage ─────────────────────────────────────────────────────
--
-- edition_sessions_window refuses a session outside the Edition's dates. That is right for an item the organiser
-- types, and wrong for one that follows an event: an event owner moving their own event must never be refused
-- because somebody else's Edition has it in a programme. The window is therefore checked when the link is MADE
-- (edition_session_link_event, below) and not afterwards. A linked event that later moves outside the Edition still
-- appears, on its real date, where the organiser can see it and decide — rather than vanishing quietly.
create or replace function public.edition_sessions_window() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare e public.editions%rowtype; d date;
begin
  select * into e from public.editions where id = new.edition_id;
  -- Checked only when the date is being SET: on insert, or on an update that actually moves it. A row that is already
  -- outside the window — because the event it follows was moved, or because it has just been unlinked from one — must
  -- stay editable, or the organiser is trapped with a session they can neither correct nor let go of. Before this,
  -- unlinking such a session was refused by this very check, with nothing the organiser could do about it.
  if new.event_id is null and (tg_op = 'INSERT' or new.starts_at is distinct from old.starts_at) then
    d := (new.starts_at at time zone e.timezone)::date;
    if d < e.starts_on - 1 or d > e.ends_on + 1 then
      raise exception 'session falls outside the edition dates' using errcode = '23514', hint = 'session_outside_edition';
    end if;
  end if;
  if new.venue_id is not null and not exists (select 1 from public.edition_venues v where v.id = new.venue_id and v.organiser_id = e.organiser_id) then
    raise exception 'venue belongs to another organiser' using errcode = '42501';
  end if;
  return new;
end $$;

-- ── 5. an event change reaches its Editions at once ────────────────────────────────────────────────────────────────
--
-- SECURITY DEFINER on purpose: the person correcting an event in What's On has no rights over anyone's Edition, and
-- must not need any. They change the event; the Editions follow. Narrow `when` clause so an ordinary event edit that
-- touches none of the shared fields costs nothing at all.
create or replace function public.events_sync_edition_sessions() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Deliberately NOT `status`: the row trigger works it out from organiser_status and the event's status. Setting it
  -- here made that trigger read the EVENT's change as the ORGANISER's own intent, and a postponed event that was
  -- later reinstated stayed marked "changed" for ever.
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

drop trigger if exists events_sync_edition_sessions on public.events;
create trigger events_sync_edition_sessions after update on public.events for each row
  when (old.title is distinct from new.title
     or old.starts_at is distinct from new.starts_at
     or old.ends_at is distinct from new.ends_at
     or old.venue is distinct from new.venue
     or old.locality is distinct from new.locality
     or old.status is distinct from new.status)
  execute function public.events_sync_edition_sessions();

-- ── 6. a deleted event detaches; it never empties the programme ────────────────────────────────────────────────────
--
-- BEFORE DELETE, so this runs while event_id still points at the row and before the foreign key nulls it. The session
-- keeps the last details it was given and is marked detached, which is what the manage screen reads to say "the
-- original listing has been removed — these are the last details we had". Nothing disappears from a public programme
-- because somebody deleted an event.
create or replace function public.events_detach_edition_sessions() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- event_id is cleared HERE rather than left to the foreign key's ON DELETE SET NULL: the row trigger runs on this
  -- update, and a row that still named an event would be re-read from it and have this stamp wiped off again.
  update public.edition_sessions s
     set event_id          = null,
         linked_at         = null,
         event_detached_at = now(),
         event_status      = null,
         updated_at        = now()
   where s.event_id = old.id;
  return old;
end $$;

drop trigger if exists events_detach_edition_sessions on public.events;
create trigger events_detach_edition_sessions before delete on public.events for each row
  execute function public.events_detach_edition_sessions();

-- ── 7. linking and unlinking ───────────────────────────────────────────────────────────────────────────────────────

-- May this person put this event in this Edition's programme? Three routes, and no fourth:
--   * they control the event (the same test every other Edition feature uses);
--   * the event's owner has already approved a partnership with this Edition;
--   * platform staff, for one of OneShetland's own platform events, which have no owner to ask.
create or replace function public.edition_session_may_link(p_edition uuid, p_event uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.edition_controls_subject('event', null, p_event, null)
      or exists (select 1 from public.edition_links l
                  where l.edition_id = p_edition and l.event_id = p_event and l.kind = 'event' and l.state = 'approved')
      or (public.edition_staff() and exists (select 1 from public.events e where e.id = p_event and e.is_platform_event))
$$;

create or replace function public.edition_session_link_event(p_session uuid, p_event uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.edition_sessions%rowtype; ed public.editions%rowtype; e public.events%rowtype; d date;
begin
  select * into s from public.edition_sessions where id = p_session;
  if not found then raise exception 'session not found' using errcode = 'P0002'; end if;
  if not public.edition_can(s.edition_id, 'editor') then raise exception 'not permitted' using errcode = '42501'; end if;
  select * into e from public.events where id = p_event;
  if not found then raise exception 'that What''s On event could not be found' using errcode = 'P0002', hint = 'event_missing'; end if;
  if not public.edition_session_may_link(s.edition_id, p_event) then
    raise exception 'that event belongs to somebody else — invite them to the Edition first' using errcode = '42501', hint = 'event_not_yours';
  end if;
  select * into ed from public.editions where id = s.edition_id;
  d := (e.starts_at at time zone ed.timezone)::date;
  if d < ed.starts_on - 1 or d > ed.ends_on + 1 then
    raise exception 'that event is not inside this Edition''s dates' using errcode = '23514', hint = 'event_outside_edition';
  end if;
  update public.edition_sessions
     set event_id = p_event, linked_at = now(), event_detached_at = null,
         -- The Edition's own words are kept. Only an empty description is seeded from the event, and it is the
         -- Edition's from then on.
         description = coalesce(nullif(btrim(coalesce(description, '')), ''), e.description)
   where id = p_session;
  perform public.edition_audit(ed.organiser_id, ed.id, 'session_linked_to_event',
    jsonb_build_object('session', p_session, 'event', p_event, 'event_title', e.title, 'starts_at', e.starts_at));
end $$;

create or replace function public.edition_session_unlink_event(p_session uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.edition_sessions%rowtype; ed public.editions%rowtype;
begin
  select * into s from public.edition_sessions where id = p_session;
  if not found then raise exception 'session not found' using errcode = 'P0002'; end if;
  if not public.edition_can(s.edition_id, 'editor') then raise exception 'not permitted' using errcode = '42501'; end if;
  select * into ed from public.editions where id = s.edition_id;
  -- The details it is carrying stay exactly as they are; they simply stop following the event from now on.
  update public.edition_sessions set event_id = null, linked_at = null, event_detached_at = null where id = p_session;
  if s.event_id is not null then
    perform public.edition_audit(ed.organiser_id, ed.id, 'session_unlinked_from_event',
      jsonb_build_object('session', p_session, 'event', s.event_id));
  end if;
end $$;

revoke all on function public.edition_session_link_event(uuid, uuid), public.edition_session_unlink_event(uuid),
                       public.edition_session_may_link(uuid, uuid) from public, anon;
grant execute on function public.edition_session_link_event(uuid, uuid), public.edition_session_unlink_event(uuid),
                          public.edition_session_may_link(uuid, uuid) to authenticated;

-- The events an editor may link, for the picker on the manage screen: inside the Edition's dates, not already in the
-- programme, and only ones this person is actually allowed to use.
create or replace function public.edition_linkable_events(p_edition uuid, p_q text default null)
returns table (event_id uuid, title text, starts_at timestamptz, ends_at timestamptz, place text, status text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare ed public.editions%rowtype;
begin
  select * into ed from public.editions where id = p_edition;
  if not found then raise exception 'edition not found' using errcode = 'P0002'; end if;
  if not public.edition_can(p_edition, 'editor') then raise exception 'not permitted' using errcode = '42501'; end if;
  return query
  select e.id, e.title, e.starts_at, e.ends_at, public.edition_event_place(e.venue, e.locality), e.status
    from public.events e
   where e.status in ('published', 'cancelled', 'postponed')
     and (e.starts_at at time zone ed.timezone)::date between ed.starts_on - 1 and ed.ends_on + 1
     and (p_q is null or btrim(p_q) = '' or e.title ilike '%' || public.edition_like_escape(btrim(p_q)) || '%')
     and not exists (select 1 from public.edition_sessions s where s.edition_id = p_edition and s.event_id = e.id)
     and public.edition_session_may_link(p_edition, e.id)
   order by e.starts_at, e.title
   limit 50;
end $$;
revoke all on function public.edition_linkable_events(uuid, text) from public, anon;
grant execute on function public.edition_linkable_events(uuid, text) to authenticated;

-- ── 8. adopt the copies that are already there ─────────────────────────────────────────────────────────────────────
--
-- Every session in the database today was made by copying an event: all 20 of them match an event on title AND start
-- time exactly, with no session matching two events and no event matching two sessions. Those are linked here, which
-- changes nothing a visitor can see (the mirrored values are already identical) and everything about what happens
-- next time one of those events is corrected.
--
-- Conservative on purpose. A pair is adopted only when the match is exact and unambiguous from BOTH sides. Anything
-- less stays unlinked and keeps working exactly as it does today — an unlinked session is still a first-class
-- programme item, which is requirement three, not a failure state.
do $$
declare n_before integer; n_after integer;
begin
  select count(*) into n_before from public.edition_sessions where event_id is not null;

  with candidate as (
    select s.id as session_id, e.id as event_id,
           count(*) over (partition by s.id) as per_session,
           count(*) over (partition by e.id, s.edition_id) as per_event
      from public.edition_sessions s
      join public.editions ed on ed.id = s.edition_id
      join public.events e
        on btrim(lower(e.title)) = btrim(lower(s.title))
       and e.starts_at = s.starts_at
     where s.event_id is null and s.event_detached_at is null
  )
  update public.edition_sessions s
     set event_id = c.event_id, linked_at = now()
    from candidate c
   where s.id = c.session_id and c.per_session = 1 and c.per_event = 1;

  select count(*) into n_after from public.edition_sessions where event_id is not null;
  raise notice 'edition sessions linked to their events: % (was %)', n_after, n_before;
end $$;

-- ── post-checks ────────────────────────────────────────────────────────────────────────────────────────────────────
do $$
declare bad integer;
begin
  if to_regclass('public.edition_sessions') is null then raise exception 'post-check: edition_sessions is missing'; end if;
  -- the mirror must be in front of the window check, or a linked session outside the Edition would still be refused
  if (select tgname from pg_trigger where tgrelid = 'public.edition_sessions'::regclass and not tgisinternal
        and tgtype & 2 = 2 order by tgname limit 1) <> 'aa_edition_sessions_mirror' then
    raise exception 'post-check: the mirror trigger must sort first on edition_sessions';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.events'::regclass and tgname = 'events_sync_edition_sessions') then
    raise exception 'post-check: events_sync_edition_sessions is missing';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.events'::regclass and tgname = 'events_detach_edition_sessions') then
    raise exception 'post-check: events_detach_edition_sessions is missing';
  end if;
  -- nothing may be linked and detached at once, and nothing may disagree with the event it names
  select count(*) into bad from public.edition_sessions s join public.events e on e.id = s.event_id
   where s.title is distinct from e.title or s.starts_at is distinct from e.starts_at or s.ends_at is distinct from e.ends_at
      or s.event_status is distinct from e.status;
  if bad > 0 then raise exception 'post-check: % linked session(s) disagree with their event', bad; end if;
  -- an unlinked session must still be a complete listing
  select count(*) into bad from public.edition_sessions where title is null or starts_at is null;
  if bad > 0 then raise exception 'post-check: % session(s) lost their details', bad; end if;
  -- anon must not be able to link anything
  if has_function_privilege('anon', 'public.edition_session_link_event(uuid,uuid)', 'execute')
     or has_function_privilege('anon', 'public.edition_linkable_events(uuid,text)', 'execute') then
    raise exception 'post-check: anon must not execute the linking functions';
  end if;
end $$;

commit;
