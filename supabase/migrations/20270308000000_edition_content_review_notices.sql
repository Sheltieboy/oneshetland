-- When a linked event moves, tell the organiser their own words may now be wrong.
--
-- 20270307000000 made a programme item follow its What's On event, so the listing is never stale. The Edition's
-- PROSE is a separate matter: edition_pages.body is free text somebody wrote, and when the Lerwick Christmas Parade
-- moved from Sunday 29 to Saturday 28 November the programme was one of five places that had to be corrected — the
-- other four were sentences on the Welcome, Family and What's On pages. Nothing can safely rewrite those sentences,
-- and nothing here tries to.
--
-- WHAT THIS DOES. When a linked event's DATE, TIME or PLACE changes, a notice is raised for that Edition. The notice
-- remembers the wording that was true BEFORE the change, and the organiser's manage screen turns that into a list of
-- their own pages that still contain it, with a link to each. They read it and decide. Nothing is blocked, nothing is
-- edited, nothing is published or unpublished, and if they ignore it entirely the Edition carries on exactly as now.
--
-- A TITLE CHANGE DOES NOT RAISE ONE, on purpose: a title is edited far more often than a date, usually to fix a
-- typo, and a notice for every one of those would teach organisers to ignore all of them.
--
-- THE MATCH IS A PROMPT, NOT A FINDING. Prose is free text: "Sunday 29 November", "the 29th", "the last Sunday of
-- the month" and "a week on Sunday" all mean the same day and only the first can be found. The screen says so. A
-- page that matches is worth a look; a notice with no matching page still says the event moved.

begin;

-- ── 1. the notice ──────────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.edition_content_notices (
  id          uuid primary key default gen_random_uuid(),
  edition_id  uuid not null references public.editions (id) on delete cascade,
  session_id  uuid not null references public.edition_sessions (id) on delete cascade,
  event_id    uuid references public.events (id) on delete set null,
  title       text not null,
  -- The wording that was true before the FIRST unreviewed change, and what it is now. If an event moves twice before
  -- anyone looks, the prose may still carry the oldest wording, so `from` is never overwritten — only `to` is.
  was_at      timestamptz not null,
  now_at      timestamptz not null,
  was_place   text,
  now_place   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null
);
-- One open notice per programme item: a second change updates the first rather than stacking up.
create unique index if not exists edition_content_notices_open
  on public.edition_content_notices (session_id) where resolved_at is null;
create index if not exists edition_content_notices_edition_idx
  on public.edition_content_notices (edition_id) where resolved_at is null;

alter table public.edition_content_notices enable row level security;
revoke all on public.edition_content_notices from public, anon, authenticated;
-- Only the Edition's own team (and platform staff) ever see these. They are not public and they are not visitor-facing.
drop policy if exists "edition_content_notices read" on public.edition_content_notices;
create policy "edition_content_notices read" on public.edition_content_notices for select to authenticated
  using (public.edition_can(edition_id, 'editor') or public.edition_staff());
grant select on public.edition_content_notices to authenticated;

-- ── 2. the wording a date used to have ─────────────────────────────────────────────────────────────────────────────
--
-- The forms somebody actually types into a page. Generated in the Edition's own timezone, because "29 November" is a
-- Shetland date and the server is not in Shetland. Deliberately conservative: only unambiguous, searchable strings.
create or replace function public.edition_prose_cues(p_at timestamptz, p_tz text, p_place text)
returns text[] language plpgsql immutable set search_path = public, pg_temp as $$
declare d timestamp; out text[] := '{}'; part text;
begin
  if p_at is null then return out; end if;
  d := p_at at time zone coalesce(p_tz, 'Europe/London');
  -- Deliberately NO bare weekday. "Sunday" on its own matched every page that mentioned any Sunday, which is most
  -- of them, and a list of matches that is always everything is a list nobody reads. The weekday is kept only
  -- attached to the day number, where it is specific.
  out := out
      || (to_char(d, 'FMDD') || ' ' || to_char(d, 'FMMonth'))                        -- 29 November
      || (to_char(d, 'FMDD') || ' ' || to_char(d, 'FMMon'))                          -- 29 Nov
      || (to_char(d, 'FMMonth') || ' ' || to_char(d, 'FMDD'))                        -- November 29
      || (to_char(d, 'FMDay') || ' ' || to_char(d, 'FMDD'))                          -- Sunday 29
      || (to_char(d, 'FMDay') || ' ' || to_char(d, 'FMDD') || ' ' || to_char(d, 'FMMonth')); -- Sunday 29 November
  if extract(minute from d) = 0 then
    out := out || (to_char(d, 'FMHH12') || 'pm') || (to_char(d, 'FMHH12') || ' ' || to_char(d, 'am'))
               || to_char(d, 'HH24:MI');
  else
    out := out || (to_char(d, 'FMHH12') || '.' || to_char(d, 'MI') || to_char(d, 'am'))   -- 3.15pm
               || (to_char(d, 'FMHH12') || ':' || to_char(d, 'MI') || to_char(d, 'am'))   -- 3:15pm
               || to_char(d, 'HH24:MI');                                                  -- 15:15
  end if;
  -- The place, and its first part on its own ("Market Cross" out of "Market Cross, Lerwick").
  if coalesce(btrim(p_place), '') <> '' then
    out := out || btrim(p_place);
    part := btrim(split_part(p_place, ',', 1));
    if part <> '' and part <> btrim(p_place) then out := out || part; end if;
  end if;
  return (select array_agg(distinct c) from unnest(out) c where btrim(coalesce(c, '')) <> '');
end $$;

-- ── 3. raising one, from the change that is already detected ───────────────────────────────────────────────────────
--
-- This extends the trigger 20270307000000 already uses to keep linked sessions in step. It fires on the same event
-- update, inside the same transaction, and adds one small insert per affected Edition — only when the date, the time
-- or the place actually moved.
create or replace function public.events_sync_edition_sessions() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare moved boolean;
begin
  update public.edition_sessions s
     set title        = new.title,
         starts_at    = new.starts_at,
         ends_at      = new.ends_at,
         venue_text   = public.edition_event_place(new.venue, new.locality),
         event_status = new.status,
         updated_at   = now()
   where s.event_id = new.id;

  -- Only the three things a sentence in a page is likely to state.
  moved := old.starts_at is distinct from new.starts_at
        or public.edition_event_place(old.venue, old.locality) is distinct from public.edition_event_place(new.venue, new.locality);
  if moved then
    insert into public.edition_content_notices (edition_id, session_id, event_id, title, was_at, now_at, was_place, now_place)
    select s.edition_id, s.id, new.id, new.title, old.starts_at, new.starts_at,
           public.edition_event_place(old.venue, old.locality), public.edition_event_place(new.venue, new.locality)
      from public.edition_sessions s
     where s.event_id = new.id
    on conflict (session_id) where resolved_at is null do update
       -- `was_*` is kept from the first unreviewed change: the prose may still carry the oldest wording.
       set now_at     = excluded.now_at,
           now_place  = excluded.now_place,
           title      = excluded.title,
           updated_at = now();
  end if;
  return null;
end $$;

-- ── 4. what the organiser is shown ─────────────────────────────────────────────────────────────────────────────────
--
-- One row per open notice, with the Edition's OWN pages that still contain the old wording and which cue matched.
-- Pages are searched, never changed. An organiser who is not on this Edition's team gets nothing.
create or replace function public.edition_content_review(p_edition uuid)
returns table (notice_id uuid, session_id uuid, title text, was_at timestamptz, now_at timestamptz,
               was_place text, now_place text, cues text[], pages jsonb, created_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare ed public.editions%rowtype;
begin
  select * into ed from public.editions where id = p_edition;
  if not found then raise exception 'edition not found' using errcode = 'P0002'; end if;
  if not (public.edition_can(p_edition, 'editor') or public.edition_staff()) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return query
  with n as (
    select c.*, public.edition_prose_cues(c.was_at, ed.timezone, c.was_place) as cue
      from public.edition_content_notices c
     where c.edition_id = p_edition and c.resolved_at is null
  )
  select n.id, n.session_id, n.title, n.was_at, n.now_at, n.was_place, n.now_place, n.cue,
         coalesce((
           select jsonb_agg(jsonb_build_object('id', p.id, 'slug', p.slug, 'title', p.title, 'matched', m.hits) order by p.position)
             from public.edition_pages p
             cross join lateral (
               select array_agg(c2) as hits from unnest(n.cue) c2 where p.body ilike '%' || replace(replace(replace(c2, '\', '\\'), '%', '\%'), '_', '\_') || '%'
             ) m
            where p.edition_id = p_edition and m.hits is not null
         ), '[]'::jsonb),
         n.created_at
    from n
   order by n.created_at desc;
end $$;

-- Marking one checked is the organiser saying "I have read my pages". It changes no page and no listing.
create or replace function public.edition_content_notice_resolve(p_notice uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.edition_content_notices%rowtype;
begin
  select * into c from public.edition_content_notices where id = p_notice;
  if not found then raise exception 'notice not found' using errcode = 'P0002'; end if;
  if not public.edition_can(c.edition_id, 'editor') then raise exception 'not permitted' using errcode = '42501'; end if;
  update public.edition_content_notices
     set resolved_at = now(), resolved_by = auth.uid(), updated_at = now()
   where id = p_notice and resolved_at is null;
end $$;

revoke all on function public.edition_content_review(uuid), public.edition_content_notice_resolve(uuid),
                       public.edition_prose_cues(timestamptz, text, text) from public, anon;
grant execute on function public.edition_content_review(uuid), public.edition_content_notice_resolve(uuid),
                          public.edition_prose_cues(timestamptz, text, text) to authenticated;

-- ── post-checks ────────────────────────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.edition_content_notices') is null then raise exception 'post-check: the notices table is missing'; end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.events'::regclass and tgname = 'events_sync_edition_sessions') then
    raise exception 'post-check: the sync trigger was lost';
  end if;
  -- the sync must still do its original job
  if (select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'events_sync_edition_sessions') not like '%venue_text   = public.edition_event_place%' then
    raise exception 'post-check: the sync no longer mirrors the place';
  end if;
  if has_table_privilege('anon', 'public.edition_content_notices', 'select')
     or has_function_privilege('anon', 'public.edition_content_review(uuid)', 'execute') then
    raise exception 'post-check: notices must not be readable by anon';
  end if;
  -- nothing here may write to a page
  if (select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'edition_content_review') ilike '%update public.edition_pages%' then
    raise exception 'post-check: the review must never edit a page';
  end if;
end $$;

commit;
