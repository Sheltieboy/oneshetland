-- Regular Activities: ONE listing per distinct activity, weekly sessions computed (never stored), exceptions for individual sessions.
--
-- WHY NOT `events`. Every recurring thing used to be a hand-inserted row per week (e.g. Bressay Under 5s, 7 rows), so a date change was a
-- manual edit of one row and the What's On mosaic was cluttered by repeats. Roughly twenty readers (web, app, edge functions) take events
-- at face value, so occurrences are NOT stored there. An activity is ONE row; its sessions are calculated, in Europe/London, from weekly
-- rules, minus exceptions and breaks. A real `events` row is only ever needed later for a ticketed session, and then only for that session.
--
-- OWNERSHIP mirrors events exactly (same helpers, same exactly-one-owner rule, same hub verification gate):
--   a business  -> its owner manages it            (controls_event_entity)
--   a hub       -> its owner / committee manage it  (controls_event_entity); public only once the hub is verified or staff-approved
--   the platform-> staff only; staff can hand it to a hub or business with admin_assign_activity_owner (audited)
-- Staff can pause any listing (admin_set_activity_paused); a paused listing is not public and the organiser still sees why.
--
-- SESSIONS. A session is identified by (rule, occurrence_date): the rule's scheduled London date. Two sessions on one day are two rules,
-- so an exception always names exactly one of them. An exception can cancel it, or change its time/date/venue/note. An 'extra' session
-- belongs to no rule. A break cancels every rule session in a date range.
--
-- FOLLOWING. activity_follows is opt-in. Changes to sessions (cancel / change / extra / restore, and breaks) write to a private outbox;
-- a separate sender (not part of this migration) reads it. Nothing here sends anything.
--
-- Additive only. No existing table, policy, grant or row is touched.
--
-- ROLLBACK: drop table activity_notice_state, activity_change_notices, activity_legacy_events, activity_owner_log, activity_follows,
-- activity_breaks, activity_exceptions, activity_schedule_rules, regular_activities (in that order, CASCADE) and the functions
-- activity_sessions, regular_activities_listing, activity_rule_occurs_on, can_manage_activity, admin_set_activity_paused,
-- admin_assign_activity_owner, activity_follower_count and the tg_ra_* / tg_activity_* trigger functions.

-- 1. The listing ---------------------------------------------------------------------------------------------------------------------
create table if not exists public.regular_activities (
  id                    uuid primary key default gen_random_uuid(),
  slug                  text not null unique,
  title                 text not null check (char_length(btrim(title)) between 1 and 120),
  description           text check (description is null or char_length(description) <= 4000),
  category              text not null default 'other'
                          check (category in ('fitness','kids_family','social','arts_crafts','sport','faith','learning','music','wellbeing','other')),
  audience              text check (audience is null or char_length(audience) <= 80),
  venue                 text check (venue is null or char_length(venue) <= 160),
  locality              text check (locality is null or char_length(locality) <= 80),
  lat                   double precision,
  lng                   double precision,
  cover_url             text,
  price_text            text check (price_text is null or char_length(price_text) <= 80),
  booking_mode          text not null default 'drop_in' check (booking_mode in ('drop_in','contact','link')),
  contact_info          text check (contact_info is null or char_length(contact_info) <= 300),
  booking_url           text check (booking_url is null or booking_url ~ '^https://[^\s<>"]+$'),
  status                text not null default 'draft' check (status in ('draft','published','ended')),
  active_from           date,
  active_until          date,
  organiser_business_id uuid references public.local_businesses(id) on delete cascade,
  organiser_hub_id      uuid references public.hubs(id) on delete cascade,
  is_platform_activity  boolean not null default false,
  calendar_approved     boolean not null default false,
  calendar_approved_by  uuid,
  calendar_approved_at  timestamptz,
  admin_paused          boolean not null default false,
  admin_pause_reason    text,
  admin_paused_by       uuid,
  admin_paused_at       timestamptz,
  created_by            uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint ra_owner_exclusive check (
    (is_platform_activity and organiser_business_id is null and organiser_hub_id is null)
    or (not is_platform_activity and num_nonnulls(organiser_business_id, organiser_hub_id) = 1)),
  constraint ra_season check (active_from is null or active_until is null or active_until >= active_from),
  constraint ra_link_needs_url check (booking_mode <> 'link' or booking_url is not null)
);
create index if not exists idx_ra_owner_business on public.regular_activities (organiser_business_id) where organiser_business_id is not null;
create index if not exists idx_ra_owner_hub on public.regular_activities (organiser_hub_id) where organiser_hub_id is not null;
create index if not exists idx_ra_public on public.regular_activities (category, locality) where status = 'published' and not admin_paused;

-- 2. Weekly rules, exceptions, breaks ----------------------------------------------------------------------------------------------
create table if not exists public.activity_schedule_rules (
  id            uuid primary key default gen_random_uuid(),
  activity_id   uuid not null references public.regular_activities(id) on delete cascade,
  day_of_week   smallint not null check (day_of_week between 0 and 6),            -- 0 = Sunday (Postgres dow, as Book uses)
  start_time    time not null,
  end_time      time not null,
  interval_weeks smallint not null default 1 check (interval_weeks in (1, 2, 4)), -- V1 UI offers weekly only; the column is ready
  anchor_date   date not null default ((now() at time zone 'Europe/London')::date),
  valid_from    date,
  valid_until   date,
  label         text check (label is null or char_length(label) <= 60),
  venue         text check (venue is null or char_length(venue) <= 160),          -- overrides the listing's venue for this rule
  locality      text check (locality is null or char_length(locality) <= 80),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  constraint asr_times check (end_time > start_time),
  constraint asr_range check (valid_from is null or valid_until is null or valid_until >= valid_from)
);
create index if not exists idx_asr_activity on public.activity_schedule_rules (activity_id) where is_active;

create table if not exists public.activity_exceptions (
  id              uuid primary key default gen_random_uuid(),
  activity_id     uuid not null references public.regular_activities(id) on delete cascade,
  rule_id         uuid references public.activity_schedule_rules(id) on delete cascade,
  occurrence_date date,                                   -- the rule's SCHEDULED London date: names exactly one session
  kind            text not null check (kind in ('cancelled','changed','extra')),
  new_starts_at   timestamptz,
  new_ends_at     timestamptz,
  new_venue       text check (new_venue is null or char_length(new_venue) <= 160),
  new_locality    text check (new_locality is null or char_length(new_locality) <= 80),
  note            text check (note is null or char_length(note) <= 200),   -- public: "No session: school holidays"
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint ae_shape check (
    (kind = 'extra'     and rule_id is null and occurrence_date is null and new_starts_at is not null and new_ends_at is not null)
    or (kind = 'cancelled' and rule_id is not null and occurrence_date is not null and new_starts_at is null and new_ends_at is null)
    or (kind = 'changed'   and rule_id is not null and occurrence_date is not null
        and (new_starts_at is not null or new_venue is not null or new_locality is not null or note is not null)
        and (new_ends_at is null or new_starts_at is not null))),
  constraint ae_times check (new_ends_at is null or new_starts_at is null or new_ends_at > new_starts_at)
);
-- ONE exception per session; extras are unique by their own start.
create unique index if not exists uq_ae_session on public.activity_exceptions (rule_id, occurrence_date) where rule_id is not null;
create unique index if not exists uq_ae_extra   on public.activity_exceptions (activity_id, new_starts_at) where kind = 'extra';
create index if not exists idx_ae_activity on public.activity_exceptions (activity_id);

create table if not exists public.activity_breaks (
  id          uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.regular_activities(id) on delete cascade,
  start_date  date not null,
  end_date    date not null,
  reason      text check (reason is null or char_length(reason) <= 120),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  constraint ab_range check (end_date >= start_date and end_date - start_date <= 370)
);
create index if not exists idx_ab_activity on public.activity_breaks (activity_id, start_date, end_date);

-- 3. Following, audit, legacy URL map, outbox --------------------------------------------------------------------------------------
create table if not exists public.activity_follows (
  activity_id uuid not null references public.regular_activities(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (activity_id, user_id)
);
create index if not exists idx_af_user on public.activity_follows (user_id);

create table if not exists public.activity_owner_log (
  id          bigint generated always as identity primary key,
  activity_id uuid not null references public.regular_activities(id) on delete cascade,
  kind        text not null check (kind in ('handover','pause','resume')),
  from_owner  text,
  to_owner    text,
  reason      text,
  actor       uuid,
  created_at  timestamptz not null default now()
);

-- Old event URLs keep working: an event that has become a session of an activity redirects to it.
create table if not exists public.activity_legacy_events (
  event_id        uuid primary key references public.events(id) on delete cascade,
  activity_id     uuid not null references public.regular_activities(id) on delete cascade,
  rule_id         uuid references public.activity_schedule_rules(id) on delete set null,
  occurrence_date date,
  created_at      timestamptz not null default now()
);

-- Private outbox of session changes worth telling followers about. Written by triggers; read only by the sender (service role).
create table if not exists public.activity_change_notices (
  id                  uuid primary key default gen_random_uuid(),
  activity_id         uuid not null references public.regular_activities(id) on delete cascade,
  kind                text not null check (kind in ('cancelled','changed','extra','restored','break')),
  session_key         text not null,                       -- 'rule:<id>:<date>' | 'extra:<exception id>' | 'break:<id>'
  session_starts_at   timestamptz not null,                -- the ORIGINAL scheduled start (or the extra's start)
  new_starts_at       timestamptz,
  new_venue           text,
  note                text,
  state_hash          text not null,                       -- what the session looks like now; identical state is never sent twice
  created_at          timestamptz not null default now(),
  processed_at        timestamptz,
  outcome             text,                                -- delivered | superseded | identical | past | never_told | inactive | no_followers | failed
  attempts            smallint not null default 0,
  last_error          text
);
alter table public.activity_change_notices add column if not exists outcome text;
alter table public.activity_change_notices add column if not exists attempts smallint not null default 0;
alter table public.activity_change_notices add column if not exists last_error text;
create unique index if not exists uq_acn_pending on public.activity_change_notices (session_key, state_hash) where processed_at is null;
create index if not exists idx_acn_pending on public.activity_change_notices (created_at) where processed_at is null;

-- One row per processor run that had something to do (for monitoring; pruned after 30 days).
create table if not exists public.activity_notice_runs (
  id      bigint generated always as identity primary key,
  ran_at  timestamptz not null default now(),
  summary jsonb not null
);

create table if not exists public.activity_notice_state (
  session_key    text primary key,
  activity_id    uuid not null references public.regular_activities(id) on delete cascade,
  last_state_hash text not null,
  last_sent_at   timestamptz not null default now()
);
create index if not exists idx_ans_activity on public.activity_notice_state (activity_id, last_sent_at desc);

-- 4. Ownership and permission helpers ---------------------------------------------------------------------------------------------
create or replace function public.can_manage_activity(p_activity uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from public.regular_activities a
     where a.id = p_activity
       and (public.attribution_staff()
            or (not a.is_platform_activity and public.controls_event_entity(a.organiser_business_id, a.organiser_hub_id))));
$$;
revoke all on function public.can_manage_activity(uuid) from public;
-- Not executable by visitors (they never need it, and the helpers it calls are not theirs to run).
revoke all on function public.can_manage_activity(uuid) from anon;
grant execute on function public.can_manage_activity(uuid) to authenticated, service_role;

-- 5. Guard, slug, hub approval --------------------------------------------------------------------------------------------------------
create or replace function public.tg_ra_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_hub_verified boolean := false;
  v_privileged boolean := current_user not in ('authenticated', 'anon') or public.attribution_staff();
  v_base text;
  v_slug text;
  v_n int := 1;
begin
  new.updated_at := now();

  -- Slug: set once, never changed (URLs are forever), unique.
  if tg_op = 'INSERT' then
    v_base := left(trim(both '-' from lower(regexp_replace(coalesce(new.title, 'activity'), '[^a-zA-Z0-9]+', '-', 'g'))), 60);
    if v_base = '' then v_base := 'activity'; end if;
    v_slug := v_base;
    while exists (select 1 from public.regular_activities where slug = v_slug) loop
      v_n := v_n + 1; v_slug := v_base || '-' || v_n;
    end loop;
    if new.slug is null or not v_privileged then new.slug := v_slug; end if;
  else
    new.slug := old.slug;
  end if;

  if new.organiser_hub_id is not null then
    select coalesce(is_verified, false) into v_hub_verified from public.hubs where id = new.organiser_hub_id;
  end if;

  if v_privileged then
    -- Staff and server paths: the CHECK still holds. A verified hub is approved automatically.
    if new.organiser_hub_id is not null and v_hub_verified then new.calendar_approved := true; end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.is_platform_activity then raise exception 'Only OneShetland staff can create platform activities' using errcode = '42501'; end if;
    if num_nonnulls(new.organiser_business_id, new.organiser_hub_id) <> 1 then
      raise exception 'An activity must belong to exactly one business or hub' using errcode = '42501';
    end if;
    if not public.controls_event_entity(new.organiser_business_id, new.organiser_hub_id) then
      raise exception 'You do not manage that business or hub' using errcode = '42501';
    end if;
    new.created_by := auth.uid();
    new.admin_paused := false; new.admin_pause_reason := null; new.admin_paused_by := null; new.admin_paused_at := null;
    new.calendar_approved := v_hub_verified and new.organiser_hub_id is not null; new.calendar_approved_by := null; new.calendar_approved_at := null;
    return new;
  end if;

  -- UPDATE by a client
  if new.organiser_business_id is distinct from old.organiser_business_id
     or new.organiser_hub_id is distinct from old.organiser_hub_id
     or new.is_platform_activity is distinct from old.is_platform_activity then
    raise exception 'An activity''s owner cannot be changed here' using errcode = '42501';
  end if;
  if old.is_platform_activity or not public.controls_event_entity(old.organiser_business_id, old.organiser_hub_id) then
    raise exception 'You no longer manage this activity' using errcode = '42501';
  end if;
  new.created_by := old.created_by;
  new.admin_paused := old.admin_paused; new.admin_pause_reason := old.admin_pause_reason;
  new.admin_paused_by := old.admin_paused_by; new.admin_paused_at := old.admin_paused_at;
  new.calendar_approved_by := old.calendar_approved_by; new.calendar_approved_at := old.calendar_approved_at;
  new.calendar_approved := old.calendar_approved or (new.organiser_hub_id is not null and v_hub_verified);
  return new;
end;
$$;
revoke all on function public.tg_ra_guard() from public, anon, authenticated;

drop trigger if exists tg_ra_guard on public.regular_activities;
create trigger tg_ra_guard before insert or update on public.regular_activities
  for each row execute function public.tg_ra_guard();

-- Exceptions: the rule must belong to the activity, and the date must be a real scheduled session of that rule.
create or replace function public.activity_rule_occurs_on(p_anchor date, p_dow smallint, p_interval smallint, p_day date)
returns boolean
language sql
immutable
as $$
  select extract(dow from p_day)::int = p_dow
     and p_day >= (p_anchor + ((p_dow - extract(dow from p_anchor)::int + 7) % 7))
     and ((p_day - (p_anchor + ((p_dow - extract(dow from p_anchor)::int + 7) % 7))) % (7 * p_interval)) = 0;
$$;

create or replace function public.tg_activity_exception_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare r public.activity_schedule_rules;
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then new.created_by := coalesce(auth.uid(), new.created_by); else new.created_by := old.created_by; end if;
  if new.rule_id is not null then
    select * into r from public.activity_schedule_rules where id = new.rule_id;
    if not found or r.activity_id <> new.activity_id then
      raise exception 'That session belongs to a different activity' using errcode = '22023';
    end if;
    if not public.activity_rule_occurs_on(r.anchor_date, r.day_of_week, r.interval_weeks, new.occurrence_date) then
      raise exception 'That date is not one of this rule''s scheduled sessions' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.tg_activity_exception_guard() from public, anon, authenticated;
drop trigger if exists tg_activity_exception_guard on public.activity_exceptions;
create trigger tg_activity_exception_guard before insert or update on public.activity_exceptions
  for each row execute function public.tg_activity_exception_guard();

create or replace function public.tg_activity_rule_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.activity_id <> old.activity_id then raise exception 'A rule cannot move to another activity' using errcode = '22023'; end if;
  return new;
end;
$$;
revoke all on function public.tg_activity_rule_guard() from public, anon, authenticated;
drop trigger if exists tg_activity_rule_guard on public.activity_schedule_rules;
create trigger tg_activity_rule_guard before insert or update on public.activity_schedule_rules
  for each row execute function public.tg_activity_rule_guard();

-- 6. Row security --------------------------------------------------------------------------------------------------------------------
alter table public.regular_activities      enable row level security;
alter table public.activity_schedule_rules enable row level security;
alter table public.activity_exceptions     enable row level security;
alter table public.activity_breaks         enable row level security;
alter table public.activity_follows        enable row level security;
alter table public.activity_owner_log      enable row level security;
alter table public.activity_legacy_events  enable row level security;
alter table public.activity_change_notices enable row level security;
alter table public.activity_notice_state   enable row level security;
alter table public.activity_notice_runs    enable row level security;

-- Two permissive policies, OR-ed: the PUBLIC rule (visitors and everyone) and the MANAGER rule (signed-in only). They are split because the
-- ownership helpers are not executable by the anonymous role in production, and a visitor's read must never call them.
drop policy if exists ra_read on public.regular_activities;
drop policy if exists ra_read_public on public.regular_activities;
create policy ra_read_public on public.regular_activities for select to anon, authenticated using (
  status = 'published' and not admin_paused
  and (organiser_hub_id is null or (calendar_approved and exists (select 1 from public.hubs h where h.id = organiser_hub_id and h.is_active)))
  and (organiser_business_id is null or exists (select 1 from public.local_businesses b where b.id = organiser_business_id and b.is_active)));
drop policy if exists ra_read_manage on public.regular_activities;
create policy ra_read_manage on public.regular_activities for select to authenticated using (
  public.attribution_staff()
  or (not is_platform_activity and public.controls_event_entity(organiser_business_id, organiser_hub_id)));

drop policy if exists ra_insert on public.regular_activities;
create policy ra_insert on public.regular_activities for insert to authenticated with check (
  public.attribution_staff()
  or ((not is_platform_activity) and num_nonnulls(organiser_business_id, organiser_hub_id) = 1
      and public.controls_event_entity(organiser_business_id, organiser_hub_id)));

drop policy if exists ra_update on public.regular_activities;
create policy ra_update on public.regular_activities for update to authenticated
  using (public.attribution_staff() or ((not is_platform_activity) and public.controls_event_entity(organiser_business_id, organiser_hub_id)))
  with check (public.attribution_staff() or ((not is_platform_activity) and num_nonnulls(organiser_business_id, organiser_hub_id) = 1
      and public.controls_event_entity(organiser_business_id, organiser_hub_id)));

drop policy if exists ra_delete on public.regular_activities;
create policy ra_delete on public.regular_activities for delete to authenticated
  using (public.attribution_staff() or ((not is_platform_activity) and public.controls_event_entity(organiser_business_id, organiser_hub_id)));

-- Child tables: readable exactly when their activity is (the activity's own row security decides); writable by who manages the activity.
do $$
declare t text;
begin
  foreach t in array array['activity_schedule_rules', 'activity_exceptions', 'activity_breaks'] loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select using (exists (select 1 from public.regular_activities a where a.id = activity_id))', t || '_read', t);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format('create policy %I on public.%I for all to authenticated using (public.can_manage_activity(activity_id)) with check (public.can_manage_activity(activity_id))', t || '_write', t);
  end loop;
end $$;

drop policy if exists af_own_read on public.activity_follows;
create policy af_own_read on public.activity_follows for select to authenticated using (user_id = auth.uid());
drop policy if exists af_own_insert on public.activity_follows;
create policy af_own_insert on public.activity_follows for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.regular_activities a where a.id = activity_id and a.status = 'published' and not a.admin_paused));
drop policy if exists af_own_delete on public.activity_follows;
create policy af_own_delete on public.activity_follows for delete to authenticated using (user_id = auth.uid());

drop policy if exists ale_read on public.activity_legacy_events;
create policy ale_read on public.activity_legacy_events for select using (true);       -- an event id and where it went; nothing private

-- 7. Grants: nothing by default, then exactly what is needed ------------------------------------------------------------------------
revoke all on public.regular_activities, public.activity_schedule_rules, public.activity_exceptions, public.activity_breaks,
              public.activity_follows, public.activity_owner_log, public.activity_legacy_events, public.activity_change_notices,
              public.activity_notice_state, public.activity_notice_runs from public, anon, authenticated;

grant select (id, slug, title, description, category, audience, venue, locality, lat, lng, cover_url, price_text, booking_mode, contact_info,
              booking_url, status, active_from, active_until, organiser_business_id, organiser_hub_id, is_platform_activity,
              calendar_approved, admin_paused, created_at, updated_at)
  on public.regular_activities to anon, authenticated;
grant select (admin_pause_reason) on public.regular_activities to authenticated;
grant insert (title, description, category, audience, venue, locality, lat, lng, cover_url, price_text, booking_mode, contact_info, booking_url,
              status, active_from, active_until, organiser_business_id, organiser_hub_id, is_platform_activity)
  on public.regular_activities to authenticated;
grant update (title, description, category, audience, venue, locality, lat, lng, cover_url, price_text, booking_mode, contact_info, booking_url,
              status, active_from, active_until, calendar_approved)
  on public.regular_activities to authenticated;
grant delete on public.regular_activities to authenticated;

grant select on public.activity_schedule_rules to anon, authenticated;
grant insert, update, delete on public.activity_schedule_rules to authenticated;
grant select (id, activity_id, rule_id, occurrence_date, kind, new_starts_at, new_ends_at, new_venue, new_locality, note, created_at, updated_at)
  on public.activity_exceptions to anon, authenticated;
grant insert (activity_id, rule_id, occurrence_date, kind, new_starts_at, new_ends_at, new_venue, new_locality, note) on public.activity_exceptions to authenticated;
grant update (new_starts_at, new_ends_at, new_venue, new_locality, note, kind) on public.activity_exceptions to authenticated;
grant delete on public.activity_exceptions to authenticated;
grant select (id, activity_id, start_date, end_date, reason, created_at) on public.activity_breaks to anon, authenticated;
grant insert (activity_id, start_date, end_date, reason) on public.activity_breaks to authenticated;
grant update (start_date, end_date, reason) on public.activity_breaks to authenticated;
grant delete on public.activity_breaks to authenticated;
grant select, insert, delete on public.activity_follows to authenticated;
grant select on public.activity_legacy_events to anon, authenticated;
-- activity_owner_log, activity_change_notices, activity_notice_state, activity_notice_runs: no client grant at all (service role / definer functions only).

-- 8. Sessions: computed, in Europe/London, bounded --------------------------------------------------------------------------------
create or replace function public.activity_sessions(p_from timestamptz, p_to timestamptz, p_activity_id uuid default null, p_limit integer default 400)
returns table (
  activity_id uuid, rule_id uuid, exception_id uuid, occurrence_date date, original_starts_at timestamptz,
  starts_at timestamptz, ends_at timestamptz, status text, venue text, locality text, note text, is_extra boolean)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare v_lim int := least(greatest(coalesce(p_limit, 400), 1), 1000);
begin
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'A date window is required' using errcode = '22023';
  end if;
  if p_to - p_from > interval '93 days' then
    raise exception 'The window may be at most 93 days' using errcode = '22023';
  end if;

  return query
  with bounds as (
    select ((p_from at time zone 'Europe/London')::date - 1) as d0, ((p_to at time zone 'Europe/London')::date + 1) as d1
  ),
  base as (
    select r.id as rid, r.activity_id as aid, g.d as occ, r.start_time as t0, r.end_time as t1,
           coalesce(r.venue, a.venue) as ven, coalesce(r.locality, a.locality) as loc
      from public.activity_schedule_rules r
      join public.regular_activities a on a.id = r.activity_id and a.status in ('draft', 'published')
      cross join bounds b
      cross join lateral generate_series(
          greatest(b.d0, r.anchor_date, coalesce(r.valid_from, b.d0), coalesce(a.active_from, b.d0))::timestamp,
          least(b.d1, coalesce(r.valid_until, b.d1), coalesce(a.active_until, b.d1))::timestamp,
          interval '1 day') as gs(ts)
      cross join lateral (select gs.ts::date as d) g
     where r.is_active
       and (p_activity_id is null or r.activity_id = p_activity_id)
       and public.activity_rule_occurs_on(r.anchor_date, r.day_of_week, r.interval_weeks, g.d)
  ),
  applied as (
    select s.aid, s.rid, e.id as eid, s.occ,
           ((s.occ + s.t0) at time zone 'Europe/London') as orig_start,
           coalesce(case when e.kind = 'changed' then e.new_starts_at end, (s.occ + s.t0) at time zone 'Europe/London') as st,
           case when e.kind = 'changed' and e.new_starts_at is not null
                  then coalesce(e.new_ends_at, e.new_starts_at + (((s.occ + s.t1) at time zone 'Europe/London') - ((s.occ + s.t0) at time zone 'Europe/London')))
                else (s.occ + s.t1) at time zone 'Europe/London' end as en,
           case when e.kind = 'cancelled' then 'cancelled'
                when e.kind = 'changed' then
                  (case when e.new_starts_at is not null and (e.new_starts_at at time zone 'Europe/London')::date <> s.occ then 'moved' else 'changed' end)
                when brk.reason is not null or brk.hit then 'break'
                else 'scheduled' end as stat,
           coalesce(case when e.kind = 'changed' then e.new_venue end, s.ven) as ven,
           coalesce(case when e.kind = 'changed' then e.new_locality end, s.loc) as loc,
           coalesce(e.note, case when e.id is null then brk.reason end) as note
      from base s
      left join public.activity_exceptions e on e.rule_id = s.rid and e.occurrence_date = s.occ
      left join lateral (
        select true as hit, br.reason from public.activity_breaks br
         where br.activity_id = s.aid and s.occ between br.start_date and br.end_date order by br.start_date limit 1
      ) brk on true
  ),
  extras as (
    select e.activity_id as aid, null::uuid as rid, e.id as eid, (e.new_starts_at at time zone 'Europe/London')::date as occ,
           e.new_starts_at as orig_start, e.new_starts_at as st, e.new_ends_at as en, 'extra'::text as stat,
           coalesce(e.new_venue, a.venue) as ven, coalesce(e.new_locality, a.locality) as loc, e.note
      from public.activity_exceptions e
      join public.regular_activities a on a.id = e.activity_id and a.status in ('draft', 'published')
     where e.kind = 'extra' and (p_activity_id is null or e.activity_id = p_activity_id)
       and e.new_starts_at >= p_from - interval '1 day' and e.new_starts_at < p_to + interval '1 day'
  )
  select x.aid, x.rid, x.eid, x.occ, x.orig_start, x.st, x.en, x.stat, x.ven, x.loc, x.note, (x.stat = 'extra')
    from (select * from applied union all select * from extras) x
   where x.st >= p_from and x.st < p_to
   order by x.st, x.aid
   limit v_lim;
end;
$$;
grant execute on function public.activity_sessions(timestamptz, timestamptz, uuid, integer) to anon, authenticated, service_role;

-- 9. The listing: one row per activity, with its next sessions in a window ----------------------------------------------------------
create or replace function public.regular_activities_listing(
  p_from timestamptz, p_to timestamptz,
  p_dow integer[] default null, p_category text default null, p_locality text default null,
  p_drop_in boolean default null, p_q text default null, p_limit integer default 60)
returns table (
  id uuid, slug text, title text, description text, category text, audience text, venue text, locality text, price_text text,
  booking_mode text, cover_url text, owner_kind text, owner_id uuid, owner_name text, owner_slug text,
  next_starts_at timestamptz, next_ends_at timestamptz, sessions_in_window integer, cancelled_in_window integer, upcoming jsonb)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with s as (
    select * from public.activity_sessions(p_from, p_to, null, 1000)
     where p_dow is null or extract(dow from starts_at at time zone 'Europe/London')::int = any (p_dow)
  ),
  agg as (
    select activity_id,
           count(*) filter (where status not in ('cancelled', 'break'))::int as live,
           count(*) filter (where status in ('cancelled', 'break'))::int as gone,
           min(starts_at) filter (where status not in ('cancelled', 'break')) as nxt
      from s group by activity_id
  )
  select a.id, a.slug, a.title, a.description, a.category, a.audience, a.venue, a.locality, a.price_text, a.booking_mode, a.cover_url,
         case when a.organiser_hub_id is not null then 'hub' when a.organiser_business_id is not null then 'business' else 'platform' end,
         coalesce(a.organiser_hub_id, a.organiser_business_id),
         coalesce(h.name, b.name, 'OneShetland'),
         coalesce(h.slug, b.slug),
         g.nxt,
         (select s2.ends_at from s s2 where s2.activity_id = a.id and s2.starts_at = g.nxt limit 1),
         g.live, g.gone,
         (select coalesce(jsonb_agg(jsonb_build_object('starts_at', u.starts_at, 'ends_at', u.ends_at, 'status', u.status, 'venue', u.venue, 'note', u.note) order by u.starts_at), '[]'::jsonb)
            from (select * from s s3 where s3.activity_id = a.id order by s3.starts_at limit 3) u)
    from agg g
    join public.regular_activities a on a.id = g.activity_id
    left join public.hubs h on h.id = a.organiser_hub_id
    left join public.local_businesses b on b.id = a.organiser_business_id
   where (g.live > 0 or g.gone > 0)
     and (p_category is null or a.category = p_category)
     and (p_locality is null or lower(coalesce(a.locality, '')) = lower(p_locality))
     and (p_drop_in is null or (p_drop_in and a.booking_mode = 'drop_in') or (not p_drop_in and a.booking_mode <> 'drop_in'))
     and (p_q is null or btrim(p_q) = '' or a.title ilike '%' || btrim(p_q) || '%' or a.description ilike '%' || btrim(p_q) || '%'
          or a.audience ilike '%' || btrim(p_q) || '%' or a.venue ilike '%' || btrim(p_q) || '%' or a.locality ilike '%' || btrim(p_q) || '%'
          or coalesce(h.name, b.name, '') ilike '%' || btrim(p_q) || '%')
   order by (g.live = 0), g.nxt nulls last, a.title
   limit least(greatest(coalesce(p_limit, 60), 1), 100);
$$;
grant execute on function public.regular_activities_listing(timestamptz, timestamptz, integer[], text, text, boolean, text, integer) to anon, authenticated, service_role;

-- 10. Staff: pause and hand over, both audited ---------------------------------------------------------------------------------------
create or replace function public.admin_set_activity_paused(p_activity_id uuid, p_paused boolean, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not public.attribution_staff() then raise exception 'Only OneShetland staff can pause an activity' using errcode = '42501'; end if;
  if p_paused is null then raise exception 'Say whether to pause or resume' using errcode = '22023'; end if;
  if p_paused and (v_reason is null or char_length(v_reason) < 5) then raise exception 'Say why (at least 5 characters)' using errcode = '22023'; end if;
  update public.regular_activities
     set admin_paused = p_paused,
         admin_pause_reason = case when p_paused then v_reason end,
         admin_paused_by = case when p_paused then auth.uid() end,
         admin_paused_at = case when p_paused then now() end
   where id = p_activity_id;
  if not found then raise exception 'No such activity' using errcode = 'P0002'; end if;
  insert into public.activity_owner_log (activity_id, kind, reason, actor)
  values (p_activity_id, case when p_paused then 'pause' else 'resume' end, v_reason, auth.uid());
  return jsonb_build_object('activity_id', p_activity_id, 'paused', p_paused);
end;
$$;
revoke all on function public.admin_set_activity_paused(uuid, boolean, text) from public, anon;
grant execute on function public.admin_set_activity_paused(uuid, boolean, text) to authenticated;

create or replace function public.admin_assign_activity_owner(p_activity_id uuid, p_business_id uuid, p_hub_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  a public.regular_activities;
  v_from text; v_to text;
begin
  if not public.attribution_staff() then raise exception 'Only OneShetland staff can hand over an activity' using errcode = '42501'; end if;
  if v_reason is null or char_length(v_reason) < 10 then raise exception 'Say why (at least 10 characters)' using errcode = '22023'; end if;
  if num_nonnulls(p_business_id, p_hub_id) <> 1 then raise exception 'Choose exactly one business or hub' using errcode = '22023'; end if;
  select * into a from public.regular_activities where id = p_activity_id for update;
  if not found then raise exception 'No such activity' using errcode = 'P0002'; end if;
  if p_business_id is not null and not exists (select 1 from public.local_businesses where id = p_business_id) then raise exception 'No such business' using errcode = 'P0002'; end if;
  if p_hub_id is not null and not exists (select 1 from public.hubs where id = p_hub_id) then raise exception 'No such hub' using errcode = 'P0002'; end if;

  v_from := case when a.is_platform_activity then 'platform' when a.organiser_hub_id is not null then 'hub:' || a.organiser_hub_id when a.organiser_business_id is not null then 'business:' || a.organiser_business_id end;
  v_to   := case when p_hub_id is not null then 'hub:' || p_hub_id else 'business:' || p_business_id end;

  update public.regular_activities
     set is_platform_activity = false, organiser_business_id = p_business_id, organiser_hub_id = p_hub_id,
         -- A hub's activity is public only once the hub is verified or staff approve it: handover does not skip that gate.
         calendar_approved = (p_hub_id is not null and coalesce((select is_verified from public.hubs where id = p_hub_id), false)),
         calendar_approved_by = null, calendar_approved_at = null
   where id = p_activity_id;
  insert into public.activity_owner_log (activity_id, kind, from_owner, to_owner, reason, actor)
  values (p_activity_id, 'handover', v_from, v_to, v_reason, auth.uid());
  return jsonb_build_object('activity_id', p_activity_id, 'from', v_from, 'to', v_to);
end;
$$;
revoke all on function public.admin_assign_activity_owner(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.admin_assign_activity_owner(uuid, uuid, uuid, text) to authenticated;

-- Organisers may see HOW MANY follow, never who.
create or replace function public.activity_follower_count(p_activity uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when public.can_manage_activity(p_activity) then (select count(*)::int from public.activity_follows where activity_id = p_activity) end;
$$;
revoke all on function public.activity_follower_count(uuid) from public, anon;
grant execute on function public.activity_follower_count(uuid) to authenticated;

-- 11. The change outbox: written by triggers, never sent from here ----------------------------------------------------------------
create or replace function public.tg_activity_exception_notice()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.activity_exceptions;
  r public.activity_schedule_rules;
  v_kind text; v_start timestamptz; v_key text; v_hash text; v_pub boolean;
begin
  e := case when tg_op = 'DELETE' then old else new end;
  select (a.status = 'published' and not a.admin_paused) into v_pub from public.regular_activities a where a.id = e.activity_id;
  if not coalesce(v_pub, false) then return null; end if;

  if e.kind = 'extra' then
    v_key := 'extra:' || e.id; v_start := e.new_starts_at;
    v_kind := case when tg_op = 'DELETE' then 'cancelled' else 'extra' end;
  else
    select * into r from public.activity_schedule_rules where id = e.rule_id;
    if not found then return null; end if;
    v_key := 'rule:' || e.rule_id || ':' || e.occurrence_date;
    v_start := (e.occurrence_date + r.start_time) at time zone 'Europe/London';
    v_kind := case when tg_op = 'DELETE' then 'restored' when e.kind = 'cancelled' then 'cancelled' else 'changed' end;
  end if;

  -- Only sessions in the next three weeks are worth a message.
  if v_start < now() or v_start > now() + interval '21 days' then return null; end if;

  v_hash := md5(concat_ws('|', v_kind, e.new_starts_at, e.new_ends_at, e.new_venue, e.new_locality, e.note));
  insert into public.activity_change_notices (activity_id, kind, session_key, session_starts_at, new_starts_at, new_venue, note, state_hash)
  values (e.activity_id, v_kind, v_key, v_start, e.new_starts_at, coalesce(e.new_venue, e.new_locality), e.note, v_hash)
  on conflict do nothing;
  return null;
end;
$$;
revoke all on function public.tg_activity_exception_notice() from public, anon, authenticated;
drop trigger if exists tg_activity_exception_notice on public.activity_exceptions;
create trigger tg_activity_exception_notice after insert or update or delete on public.activity_exceptions
  for each row execute function public.tg_activity_exception_notice();

create or replace function public.tg_activity_break_notice()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_pub boolean;
begin
  select (a.status = 'published' and not a.admin_paused) into v_pub from public.regular_activities a where a.id = new.activity_id;
  if not coalesce(v_pub, false) then return null; end if;
  if new.end_date < (now() at time zone 'Europe/London')::date or new.start_date > (now() at time zone 'Europe/London')::date + 21 then return null; end if;
  insert into public.activity_change_notices (activity_id, kind, session_key, session_starts_at, note, state_hash)
  values (new.activity_id, 'break', 'break:' || new.id, (new.start_date::timestamp at time zone 'Europe/London'),
          concat_ws(' ', to_char(new.start_date, 'FMDD Mon'), '–', to_char(new.end_date, 'FMDD Mon'),
                    case when nullif(btrim(new.reason), '') is not null then '(' || btrim(new.reason) || ')' end),
          md5(concat_ws('|', 'break', new.start_date, new.end_date, new.reason)))
  on conflict do nothing;
  return null;
end;
$$;
revoke all on function public.tg_activity_break_notice() from public, anon, authenticated;
drop trigger if exists tg_activity_break_notice on public.activity_breaks;
create trigger tg_activity_break_notice after insert or update on public.activity_breaks
  for each row execute function public.tg_activity_break_notice();

comment on table public.regular_activities is 'One row per distinct regular activity. Sessions are COMPUTED by activity_sessions(); they are never stored in events.';
comment on column public.activity_exceptions.occurrence_date is 'The rule''s SCHEDULED London date this exception names (not the new date if the session is moved).';
