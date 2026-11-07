-- Events & Activities, Phase 1 (part 3 of 3): the original contributor can look after their approved community event without waiting for staff.
--
-- Who: the person who made the submission (event_submissions.submitter_id = auth.uid(), submission.event_id = the event), event not archived.
-- How: ONLY through the SECURITY DEFINER functions below. The events / event_occurrences RLS and guards stay closed to them: they can never write status,
-- is_hidden, is_featured, ownership, source or anyone else's event except by the bounded effects documented per function.
--
--   Tier A  IMMEDIATE, audited, no moderation: cancel a performance / the whole event, restore it within 24h (only if staff has not acted since), a note on a
--           performance. Past performances cannot be changed.
--   Tier B  MODERATED by default: dates and times, title, description, venue, poster, ticket link, price text, contact info -> event_change_requests,
--           applied atomically when staff approve (after re-validating against the CURRENT state).
--   Tier C  TRUSTED organisers (staff-set, event_organiser_trust): dates/times, description, venue, ticket link and contact changes apply at once and are
--           recorded as auto_approved. Title, poster and price changes, and brand-new events, stay moderated. Never auto-applied to an event that sells tickets.
--
-- No emails, no notifications, no triggers that contact anyone. Per-event history lives in event_change_log (readable by the contributor for own events and by staff).
-- Staff edits made directly in the table (not through admin_set_occurrence_status / admin_review_event_change) are not logged; "restore within 24h only if staff
-- did not act" therefore sees only logged staff actions.
-- A second adult co-managing an event is NOT in scope (later).

begin;

-- ── audit log ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create table public.event_change_log (
  id            bigint generated always as identity primary key,
  event_id      uuid not null references public.events(id) on delete cascade,
  occurrence_id uuid,
  actor_id      uuid references public.profiles(id) on delete set null,
  actor_kind    text not null check (actor_kind in ('contributor', 'staff', 'trusted_auto')),
  action        text not null,
  detail        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default clock_timestamp()
);
create index idx_event_change_log_event on public.event_change_log (event_id, id desc);
alter table public.event_change_log enable row level security;
revoke all on public.event_change_log from public, anon, authenticated;
grant select on public.event_change_log to authenticated;
grant all on public.event_change_log to service_role;
create policy event_change_log_staff_read on public.event_change_log for select to authenticated using (public.attribution_staff());
create policy event_change_log_contributor_read on public.event_change_log for select to authenticated
  using (exists (select 1 from public.event_submissions s where s.event_id = event_change_log.event_id and s.submitter_id = auth.uid()));

create or replace function public.event_log(p_event uuid, p_occ uuid, p_kind text, p_action text, p_detail jsonb default '{}') returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.event_change_log (event_id, occurrence_id, actor_id, actor_kind, action, detail) values (p_event, p_occ, auth.uid(), p_kind, p_action, coalesce(p_detail, '{}'));
$$;

-- ── who is the contributor ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.is_event_contributor(p_event uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and exists (
    select 1 from public.events e join public.event_submissions s on s.id = e.submission_id
     where e.id = p_event and e.is_platform_event and e.source = 'community_submission' and e.status <> 'archived'
       and s.event_id = e.id and s.submitter_id = auth.uid());
$$;

create or replace function public.event_clean_note(p text) returns text
language plpgsql immutable set search_path = public, pg_temp as $$
declare v text := nullif(btrim(regexp_replace(coalesce(p, ''), '[\x00-\x1f\x7f]', '', 'g')), ''); v_problem text;
begin
  if v is null then return null; end if;
  if char_length(v) > 200 then raise exception 'A note can be up to 200 characters.' using errcode = 'P0001', hint = 'note'; end if;
  v_problem := public.event_submission_text_problem(v);
  if v_problem is not null then raise exception '%', replace(v_problem, 'here', 'in a note') using errcode = 'P0001', hint = 'note'; end if;
  return v;
end $$;

-- ── staff: one date cancelled / changed (moved here from part 2 so it can write the audit log) ───────────────────────────────────────────────────
create or replace function public.admin_set_occurrence_status(p_occurrence uuid, p_status text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); o public.event_occurrences; v_note text;
begin
  if v_uid is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  if not public.attribution_staff() then raise exception 'Only OneShetland staff can do this' using errcode = '42501'; end if;
  if p_status not in ('scheduled', 'cancelled', 'changed') then raise exception 'Status must be scheduled, cancelled or changed' using errcode = '22023'; end if;
  v_note := public.event_clean_note(p_note);
  update public.event_occurrences set status = p_status, note = coalesce(v_note, note) where id = p_occurrence returning * into o;
  if not found then raise exception 'No such occurrence' using errcode = 'P0002'; end if;
  perform public.event_log(o.event_id, o.id, 'staff', 'staff_occurrence_status', jsonb_build_object('status', p_status));
  return jsonb_build_object('id', o.id, 'event_id', o.event_id, 'status', o.status, 'note', o.note);
end $$;

-- ── Tier A: immediate, audited ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.report_performance_cancelled(p_occurrence uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.event_occurrences; v_note text; v_live int; v_flag boolean := false;
begin
  if auth.uid() is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  select * into o from public.event_occurrences where id = p_occurrence;
  if found then perform 1 from public.events where id = o.event_id for update; select * into o from public.event_occurrences where id = p_occurrence; end if;
  -- unknown and not-yours are one answer
  if not found or not public.is_event_contributor(o.event_id) then raise exception 'You cannot change that performance' using errcode = '42501'; end if;
  if o.starts_at <= now() then raise exception 'This performance has already started, so it can no longer be changed.' using errcode = 'P0001', hint = 'past'; end if;
  if o.status = 'cancelled' then return jsonb_build_object('id', o.id, 'status', 'cancelled', 'duplicate', true); end if;
  v_note := public.event_clean_note(p_note);
  update public.event_occurrences set status = 'cancelled', note = coalesce(v_note, note) where id = o.id;
  select count(*) into v_live from public.event_occurrences where event_id = o.event_id and status <> 'cancelled';
  if v_live = 0 then
    update public.events set status = 'cancelled' where id = o.event_id and status = 'published';
    v_flag := found;
  end if;
  perform public.event_log(o.event_id, o.id, 'contributor', 'performance_cancelled', jsonb_build_object('note', v_note, 'event_cancelled_too', v_flag));
  return jsonb_build_object('id', o.id, 'status', 'cancelled', 'event_cancelled', v_flag, 'duplicate', false);
end $$;

create or replace function public.report_performance_restored(p_occurrence uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.event_occurrences; l public.event_change_log;
begin
  if auth.uid() is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  select * into o from public.event_occurrences where id = p_occurrence;
  if found then perform 1 from public.events where id = o.event_id for update; select * into o from public.event_occurrences where id = p_occurrence; end if;
  if not found or not public.is_event_contributor(o.event_id) then raise exception 'You cannot change that performance' using errcode = '42501'; end if;
  if o.starts_at <= now() then raise exception 'This performance has already started, so it can no longer be changed.' using errcode = 'P0001', hint = 'past'; end if;
  if o.status <> 'cancelled' then return jsonb_build_object('id', o.id, 'status', o.status, 'duplicate', true); end if;
  select * into l from public.event_change_log where event_id = o.event_id order by id desc limit 1;     -- ANY later entry for this event (staff or you) ends the undo window
  if not found or l.action <> 'performance_cancelled' or l.occurrence_id is distinct from o.id or l.actor_kind <> 'contributor' or l.created_at < clock_timestamp() - interval '24 hours' then
    raise exception 'This can only be undone within 24 hours, and only if nothing else has changed. Please ask OneShetland.' using errcode = 'P0001', hint = 'restore_window';
  end if;
  update public.event_occurrences set status = 'scheduled' where id = o.id;
  if (l.detail ->> 'event_cancelled_too')::boolean then update public.events set status = 'published' where id = o.event_id and status = 'cancelled'; end if;
  perform public.event_log(o.event_id, o.id, 'contributor', 'performance_restored');
  return jsonb_build_object('id', o.id, 'status', 'scheduled', 'duplicate', false);
end $$;

create or replace function public.set_performance_note(p_occurrence uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.event_occurrences; v_note text;
begin
  if auth.uid() is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  select * into o from public.event_occurrences where id = p_occurrence;
  if not found or not public.is_event_contributor(o.event_id) then raise exception 'You cannot change that performance' using errcode = '42501'; end if;
  if o.starts_at <= now() then raise exception 'This performance has already started, so it can no longer be changed.' using errcode = 'P0001', hint = 'past'; end if;
  v_note := public.event_clean_note(p_note);
  update public.event_occurrences set note = v_note where id = o.id;
  perform public.event_log(o.event_id, o.id, 'contributor', 'performance_note', jsonb_build_object('note', v_note));
  return jsonb_build_object('id', o.id, 'note', v_note);
end $$;

-- A date still ahead? (rows if the event has them, else the parent's own times)
create or replace function public.event_has_future_date(p_event uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select case when exists (select 1 from public.event_occurrences where event_id = p_event)
              then exists (select 1 from public.event_occurrences where event_id = p_event and starts_at > now())
              else exists (select 1 from public.events where id = p_event and starts_at > now()) end;
$$;

create or replace function public.report_event_cancelled(p_event uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.events; v_note text;
begin
  if auth.uid() is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  select * into e from public.events where id = p_event for update;
  if not found or not public.is_event_contributor(p_event) then raise exception 'You cannot change that event' using errcode = '42501'; end if;
  if e.status = 'cancelled' then return jsonb_build_object('id', e.id, 'status', 'cancelled', 'duplicate', true); end if;
  if e.status <> 'published' then raise exception 'Only a published event can be cancelled here. Please ask OneShetland.' using errcode = 'P0001', hint = 'not_published'; end if;
  if not public.event_has_future_date(p_event) then raise exception 'This event has already taken place, so it can no longer be changed.' using errcode = 'P0001', hint = 'past'; end if;
  v_note := public.event_clean_note(p_note);
  update public.events set status = 'cancelled' where id = p_event;            -- the sync trigger tg_events_sync_hidden then hides it
  perform public.event_log(p_event, null, 'contributor', 'event_cancelled', jsonb_build_object('note', v_note, 'previous_status', e.status));
  return jsonb_build_object('id', e.id, 'status', 'cancelled', 'duplicate', false);
end $$;

create or replace function public.report_event_restored(p_event uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.events; l public.event_change_log;
begin
  if auth.uid() is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  select * into e from public.events where id = p_event for update;
  if not found or not public.is_event_contributor(p_event) then raise exception 'You cannot change that event' using errcode = '42501'; end if;
  if e.status <> 'cancelled' then return jsonb_build_object('id', e.id, 'status', e.status, 'duplicate', true); end if;
  select * into l from public.event_change_log where event_id = p_event order by id desc limit 1;
  if not found or l.action <> 'event_cancelled' or l.actor_kind <> 'contributor' or l.created_at < clock_timestamp() - interval '24 hours' then
    raise exception 'This can only be undone within 24 hours, and only if nothing else has changed. Please ask OneShetland.' using errcode = 'P0001', hint = 'restore_window';
  end if;
  update public.events set status = coalesce(l.detail ->> 'previous_status', 'published') where id = p_event;
  perform public.event_log(p_event, null, 'contributor', 'event_restored');
  return jsonb_build_object('id', e.id, 'status', 'published', 'duplicate', false);
end $$;

-- ── Tier C: trust ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create table public.event_organiser_trust (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  trusted boolean not null default false,
  set_by  uuid references public.profiles(id) on delete set null,
  set_at  timestamptz not null default now(),
  note    text check (note is null or char_length(note) <= 300)
);
alter table public.event_organiser_trust enable row level security;
revoke all on public.event_organiser_trust from public, anon, authenticated;
grant select on public.event_organiser_trust to authenticated;            -- staff only by policy; writes only through admin_set_organiser_trust
grant all on public.event_organiser_trust to service_role;
create policy event_organiser_trust_staff_read on public.event_organiser_trust for select to authenticated using (public.attribution_staff());

create or replace function public.admin_set_organiser_trust(p_user uuid, p_trusted boolean, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  if not public.attribution_staff() then raise exception 'Only OneShetland staff can do this' using errcode = '42501'; end if;
  if p_user is null or p_trusted is null then raise exception 'A person and a decision are required' using errcode = '22023'; end if;
  if p_note is not null and char_length(p_note) > 300 then raise exception 'The note can be up to 300 characters' using errcode = 'P0001'; end if;
  insert into public.event_organiser_trust (user_id, trusted, set_by, set_at, note) values (p_user, p_trusted, auth.uid(), now(), nullif(btrim(p_note), ''))
  on conflict (user_id) do update set trusted = excluded.trusted, set_by = excluded.set_by, set_at = excluded.set_at, note = excluded.note;
  return jsonb_build_object('user_id', p_user, 'trusted', p_trusted);
end $$;

create or replace function public.is_trusted_organiser(p_user uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select trusted from public.event_organiser_trust where user_id = p_user), false);
$$;

-- ── Tier B: change requests ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create table public.event_change_requests (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references public.events(id) on delete cascade,
  requester_id  uuid not null references public.profiles(id) on delete cascade,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn', 'auto_approved')),
  kind          text not null check (kind in ('dates', 'details', 'mixed')),
  payload       jsonb not null check (jsonb_typeof(payload) = 'object'),     -- the DIFF: only the keys that change (occurrences = the full list of future dates)
  before        jsonb not null default '{}'::jsonb,                          -- what those keys were when the request was made
  review_reason text check (review_reason is null or char_length(review_reason) <= 500),
  reviewed_by   uuid references public.profiles(id) on delete set null,
  reviewed_at   timestamptz,
  request_id    uuid not null,
  created_at    timestamptz not null default now(),
  constraint event_change_requests_request_key unique (requester_id, request_id)
);
create index idx_event_change_requests_event on public.event_change_requests (event_id, status);
create index idx_event_change_requests_status on public.event_change_requests (status, created_at);
alter table public.event_change_requests enable row level security;
revoke all on public.event_change_requests from public, anon, authenticated;
grant select on public.event_change_requests to authenticated;
grant all on public.event_change_requests to service_role;
create policy event_change_requests_own_read on public.event_change_requests for select to authenticated using (requester_id = auth.uid());
create policy event_change_requests_staff_read on public.event_change_requests for select to authenticated using (public.attribution_staff());

-- the future dates as they stand now, normalised the same way as a proposal
create or replace function public.event_current_future_dates(p_event uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(x order by x ->> 'starts_at'), '[]'::jsonb) from (
    select jsonb_strip_nulls(jsonb_build_object('starts_at', to_char(o.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
             'ends_at', case when o.ends_at is not null then to_char(o.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') end, 'note', o.note)) x
      from public.event_occurrences o where o.event_id = p_event and o.starts_at > now()
    union all
    select jsonb_strip_nulls(jsonb_build_object('starts_at', to_char(e.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
             'ends_at', case when e.ends_at is not null then to_char(e.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') end))
      from public.events e where e.id = p_event and e.starts_at > now() and not exists (select 1 from public.event_occurrences where event_id = p_event)
  ) q;
$$;

-- a sold event stays a single date
create or replace function public.event_dates_ticket_problem(p_event uuid, p_list jsonb) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_past int;
begin
  if jsonb_array_length(p_list) < 2 and not exists (select 1 from public.event_occurrences where event_id = p_event and starts_at <= now()) then return; end if;
  if public.event_has_ticketing(p_event) then
    select count(*) into v_past from public.event_occurrences where event_id = p_event and starts_at <= now();
    if v_past + jsonb_array_length(p_list) >= 2 then
      raise exception 'This event sells tickets through OneShetland, so it cannot have more than one date. Remove the tickets, or create a separate event for each date.'
        using errcode = 'P0001', hint = 'ticketed_event_single_date';
    end if;
  end if;
end $$;

-- Apply an already-validated request. Internal: callers hold the event lock.
create or replace function public.event_apply_change(p_req uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.event_change_requests; e public.events; p jsonb; v_list jsonb; it jsonb; k text;
  v_title text; v_desc text; v_venue text; v_cover text; v_ticket text; v_price text; v_contact text;
begin
  select * into r from public.event_change_requests where id = p_req;
  select * into e from public.events where id = r.event_id for update;
  if e.status = 'archived' then raise exception 'This event has been archived and can no longer be changed.' using errcode = 'P0001', hint = 'archived'; end if;
  p := r.payload;
  -- re-validate EVERYTHING against the current state, as the requester
  if p ? 'title' then v_title := public.event_clean_field('title', p -> 'title', r.requester_id); end if;
  if p ? 'description' then v_desc := public.event_clean_field('description', p -> 'description', r.requester_id); end if;
  if p ? 'venue' then v_venue := public.event_clean_field('venue', p -> 'venue', r.requester_id); end if;
  if p ? 'cover_url' then v_cover := public.event_clean_field('cover_url', p -> 'cover_url', r.requester_id); end if;
  if p ? 'ticket_url' then v_ticket := public.event_clean_field('ticket_url', p -> 'ticket_url', r.requester_id); end if;
  if p ? 'price_text' then v_price := public.event_clean_field('price_text', p -> 'price_text', r.requester_id); end if;
  if p ? 'contact_info' then v_contact := public.event_clean_field('contact_info', p -> 'contact_info', r.requester_id); end if;

  update public.events set
    title = case when p ? 'title' then v_title else title end,
    description = case when p ? 'description' then v_desc else description end,
    venue = case when p ? 'venue' then v_venue else venue end,
    cover_url = case when p ? 'cover_url' then v_cover else cover_url end,
    ticket_url = case when p ? 'ticket_url' then v_ticket else ticket_url end,
    price_text = case when p ? 'price_text' then v_price else price_text end,
    contact_info = case when p ? 'contact_info' then v_contact else contact_info end
   where id = e.id;

  if p ? 'occurrences' then
    v_list := public.event_validate_occurrences(p -> 'occurrences', now());          -- stale dates fail here, loudly
    if not exists (select 1 from public.event_occurrences where event_id = e.id) and e.starts_at <= now() then
      raise exception 'This event has already taken place, so its dates can no longer be changed.' using errcode = 'P0001', hint = 'past';
    end if;
    perform public.event_dates_ticket_problem(e.id, v_list);
    if not exists (select 1 from public.event_occurrences where event_id = e.id) then
      if jsonb_array_length(v_list) = 1 then
        update public.events set starts_at = (v_list -> 0 ->> 'starts_at')::timestamptz, ends_at = (v_list -> 0 ->> 'ends_at')::timestamptz where id = e.id;
      else
        insert into public.event_occurrences (event_id, starts_at, ends_at, note)
          select e.id, (x ->> 'starts_at')::timestamptz, (x ->> 'ends_at')::timestamptz, x ->> 'note' from jsonb_array_elements(v_list) x;
      end if;
    else
      delete from public.event_occurrences o where o.event_id = e.id and o.starts_at > now()
         and not exists (select 1 from jsonb_array_elements(v_list) x where (x ->> 'starts_at')::timestamptz = o.starts_at);
      update public.event_occurrences o set ends_at = (x ->> 'ends_at')::timestamptz, note = x ->> 'note'
        from jsonb_array_elements(v_list) x where o.event_id = e.id and o.starts_at = (x ->> 'starts_at')::timestamptz;
      insert into public.event_occurrences (event_id, starts_at, ends_at, note)
        select e.id, (x ->> 'starts_at')::timestamptz, (x ->> 'ends_at')::timestamptz, x ->> 'note' from jsonb_array_elements(v_list) x
         where not exists (select 1 from public.event_occurrences o where o.event_id = e.id and o.starts_at = (x ->> 'starts_at')::timestamptz);
    end if;
  end if;
end $$;

create or replace function public.request_event_change(p_event uuid, p_payload jsonb, p_request uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid(); e public.events; v_ex public.event_change_requests; k text; v_diff jsonb := '{}'::jsonb; v_before jsonb := '{}'::jsonb;
  v_new text; v_list jsonb; v_cur jsonb; v_kind text; v_trusted boolean; v_auto boolean; v_id uuid; v_status text := 'pending'; v_cur_text text;
  c_keys constant text[] := array['title','description','venue','cover_url','ticket_url','price_text','contact_info','occurrences'];
  c_auto constant text[] := array['description','venue','ticket_url','contact_info','occurrences'];
begin
  if v_uid is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  if p_request is null then raise exception 'A request id is required' using errcode = '22023'; end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 60000 then raise exception 'Send the changes as an object' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('event-change:' || v_uid::text, 0));
  select * into v_ex from public.event_change_requests where requester_id = v_uid and request_id = p_request;
  if found then return jsonb_build_object('id', v_ex.id, 'status', v_ex.status, 'duplicate', true); end if;

  select * into e from public.events where id = p_event for update;
  if not found or not public.is_event_contributor(p_event) then raise exception 'You cannot change that event' using errcode = '42501'; end if;
  for k in select jsonb_object_keys(p_payload) loop
    if k <> all (c_keys) then raise exception 'You cannot change "%" here', k using errcode = 'P0001', hint = 'field_not_allowed'; end if;
  end loop;

  foreach k in array c_keys loop
    continue when not p_payload ? k;
    if k = 'occurrences' then
      v_list := public.event_validate_occurrences(p_payload -> 'occurrences', now());
      v_cur := public.event_current_future_dates(p_event);
      if v_list is distinct from v_cur then
        if not exists (select 1 from public.event_occurrences where event_id = p_event) and e.starts_at <= now() then
          raise exception 'This event has already taken place, so its dates can no longer be changed.' using errcode = 'P0001', hint = 'past';
        end if;
        perform public.event_dates_ticket_problem(p_event, v_list);
        v_diff := v_diff || jsonb_build_object('occurrences', v_list); v_before := v_before || jsonb_build_object('occurrences', v_cur);
      end if;
    else
      v_new := public.event_clean_field(k, p_payload -> k, v_uid);
      v_cur_text := case k when 'title' then e.title when 'description' then e.description when 'venue' then e.venue when 'cover_url' then e.cover_url
                          when 'ticket_url' then e.ticket_url when 'price_text' then e.price_text when 'contact_info' then e.contact_info end;
      if v_new is distinct from nullif(v_cur_text, '') then
        v_diff := v_diff || jsonb_build_object(k, to_jsonb(v_new)); v_before := v_before || jsonb_build_object(k, to_jsonb(v_cur_text));
      end if;
    end if;
  end loop;
  if v_diff = '{}'::jsonb then raise exception 'Nothing has changed.' using errcode = 'P0001', hint = 'no_change'; end if;

  if (select count(*) from public.event_change_requests where event_id = p_event and status = 'pending') >= 5 then
    raise exception 'This event already has 5 changes waiting for review.' using errcode = 'P0001', hint = 'pending_limit';
  end if;
  if (select count(*) from public.event_change_requests where requester_id = v_uid and created_at > now() - interval '24 hours') >= 20 then
    raise exception 'You can send 20 change requests in any 24 hours. Please try again later.' using errcode = 'P0001', hint = 'daily_limit';
  end if;

  v_kind := case when v_diff ? 'occurrences' and (select count(*) from jsonb_object_keys(v_diff)) = 1 then 'dates' when not v_diff ? 'occurrences' then 'details' else 'mixed' end;
  v_trusted := public.is_trusted_organiser(v_uid);
  v_auto := v_trusted and not exists (select 1 from jsonb_object_keys(v_diff) x where x <> all (c_auto))
            and not (v_diff ? 'occurrences' and public.event_has_ticketing(p_event));         -- never auto-change the date of a sold event
  insert into public.event_change_requests (event_id, requester_id, status, kind, payload, before, request_id, reviewed_at)
  values (p_event, v_uid, case when v_auto then 'auto_approved' else 'pending' end, v_kind, v_diff, v_before, p_request, case when v_auto then now() end)
  returning id into v_id;
  if v_auto then
    perform public.event_apply_change(v_id);
    perform public.event_log(p_event, null, 'trusted_auto', 'change_auto_approved', jsonb_build_object('request_id', v_id, 'fields', (select jsonb_agg(x) from jsonb_object_keys(v_diff) x)));
    v_status := 'auto_approved';
  else
    perform public.event_log(p_event, null, 'contributor', 'change_requested', jsonb_build_object('request_id', v_id, 'fields', (select jsonb_agg(x) from jsonb_object_keys(v_diff) x)));
  end if;
  return jsonb_build_object('id', v_id, 'status', v_status, 'duplicate', false);
end $$;

create or replace function public.withdraw_event_change(p_id uuid) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.event_change_requests;
begin
  if auth.uid() is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  select * into r from public.event_change_requests where id = p_id and requester_id = auth.uid() for update;
  if not found then raise exception 'You cannot withdraw that request' using errcode = '42501'; end if;
  if r.status = 'withdrawn' then return 'withdrawn'; end if;
  if r.status <> 'pending' then raise exception 'This request has already been decided' using errcode = 'P0001', hint = 'decided'; end if;
  update public.event_change_requests set status = 'withdrawn' where id = p_id;
  perform public.event_log(r.event_id, null, 'contributor', 'change_withdrawn', jsonb_build_object('request_id', r.id));
  return 'withdrawn';
end $$;

create or replace function public.admin_review_event_change(p_id uuid, p_decision text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.event_change_requests; v_reason text := nullif(btrim(p_reason), '');
begin
  if auth.uid() is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  if not public.attribution_staff() then raise exception 'Only OneShetland staff can review changes' using errcode = '42501'; end if;
  if p_decision not in ('approve', 'reject') then raise exception 'Decision must be approve or reject' using errcode = '22023'; end if;
  if p_decision = 'reject' and v_reason is null then raise exception 'Give a reason for the member' using errcode = 'P0001', hint = 'reason_required'; end if;
  if v_reason is not null and char_length(v_reason) > 500 then raise exception 'The reason can be up to 500 characters' using errcode = 'P0001', hint = 'reason_too_long'; end if;
  select event_id into r.event_id from public.event_change_requests where id = p_id;
  if not found then raise exception 'No such request' using errcode = 'P0002'; end if;
  perform 1 from public.events where id = r.event_id for update;                       -- event first, then the request: the same order every writer uses
  select * into r from public.event_change_requests where id = p_id for update;
  if p_decision = 'approve' and r.status in ('approved', 'auto_approved') then return jsonb_build_object('id', r.id, 'status', r.status, 'duplicate', true); end if;
  if r.status <> 'pending' then raise exception 'This request is % and can no longer be decided', r.status using errcode = 'P0001', hint = 'not_pending'; end if;
  if p_decision = 'approve' then
    perform public.event_apply_change(r.id);      -- re-validates against the current state; a stale request raises and stays pending
    update public.event_change_requests set status = 'approved', review_reason = v_reason, reviewed_by = auth.uid(), reviewed_at = now() where id = r.id;
    perform public.event_log(r.event_id, null, 'staff', 'change_approved', jsonb_build_object('request_id', r.id));
    return jsonb_build_object('id', r.id, 'status', 'approved', 'duplicate', false);
  end if;
  update public.event_change_requests set status = 'rejected', review_reason = v_reason, reviewed_by = auth.uid(), reviewed_at = now() where id = r.id;
  perform public.event_log(r.event_id, null, 'staff', 'change_rejected', jsonb_build_object('request_id', r.id));
  return jsonb_build_object('id', r.id, 'status', 'rejected', 'duplicate', false);
end $$;

create or replace function public.admin_list_event_changes(p_status text default 'pending', p_limit int default 50)
returns table (id uuid, event_id uuid, event_title text, requester_id uuid, status text, kind text, payload jsonb, created_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  if not public.attribution_staff() then raise exception 'Only OneShetland staff can do this' using errcode = '42501'; end if;
  return query select c.id, c.event_id, e.title, c.requester_id, c.status, c.kind, c.payload, c.created_at
    from public.event_change_requests c join public.events e on e.id = c.event_id where c.status = p_status order by c.created_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200);
end $$;

create or replace function public.admin_event_change_counts() returns table (pending int, auto_approved_7d int)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  if not public.attribution_staff() then raise exception 'Only OneShetland staff can do this' using errcode = '42501'; end if;
  return query select count(*) filter (where c.status = 'pending')::int, count(*) filter (where c.status = 'auto_approved' and c.created_at > now() - interval '7 days')::int from public.event_change_requests c;
end $$;

-- ── privileges ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
revoke all on function public.event_log(uuid, uuid, text, text, jsonb), public.is_event_contributor(uuid), public.event_clean_note(text), public.event_has_future_date(uuid),
  public.is_trusted_organiser(uuid), public.event_current_future_dates(uuid), public.event_dates_ticket_problem(uuid, jsonb), public.event_apply_change(uuid),
  public.admin_set_occurrence_status(uuid, text, text), public.report_performance_cancelled(uuid, text), public.report_performance_restored(uuid),
  public.set_performance_note(uuid, text), public.report_event_cancelled(uuid, text), public.report_event_restored(uuid), public.admin_set_organiser_trust(uuid, boolean, text),
  public.request_event_change(uuid, jsonb, uuid), public.withdraw_event_change(uuid), public.admin_review_event_change(uuid, text, text),
  public.admin_list_event_changes(text, int), public.admin_event_change_counts() from public, anon, authenticated;
grant execute on function public.admin_set_occurrence_status(uuid, text, text), public.report_performance_cancelled(uuid, text), public.report_performance_restored(uuid),
  public.set_performance_note(uuid, text), public.report_event_cancelled(uuid, text), public.report_event_restored(uuid), public.admin_set_organiser_trust(uuid, boolean, text),
  public.request_event_change(uuid, jsonb, uuid), public.withdraw_event_change(uuid), public.admin_review_event_change(uuid, text, text),
  public.admin_list_event_changes(text, int), public.admin_event_change_counts() to authenticated, service_role;

-- ── reserve_ticket_basket: refuse a multi-performance event ────────────────────────────────────────────────────────────────────────────────────
-- Every OneShetland ticket sale funnels through this function. It is restated in full (CREATE OR REPLACE keeps its grants) with ONE addition, marked below.
-- BEFORE APPLYING: diff this body against production's current definition - this copy comes from the migration history. The create-event-ticket-intent
-- Edge Function maps unknown reserve failures to a generic "Those tickets are not available"; it should map a message starting MULTI_PERFORMANCE to a clear
-- "This event has more than one date" (Edge Functions are NOT changed in this phase).
CREATE OR REPLACE FUNCTION public.reserve_ticket_basket(p_event_id uuid, p_buyer_id uuid, p_tickets jsonb, p_total_pence integer, p_platform_fee_pence integer, p_snapshot jsonb, p_client_request_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_count      int;
  v_order      public.event_ticket_orders%rowtype;
  v_order_id   uuid;
  v_ticket_ids uuid[];
  v_bad        record;
  v_mismatch   boolean;
begin
  -- ── Input contract, enforced here as well as in the edge function ────────
  if p_tickets is null or jsonb_typeof(p_tickets) <> 'array' then
    raise exception 'reserve_ticket_basket: tickets must be a JSON array' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_tickets);
  if v_count < 1 then
    raise exception 'reserve_ticket_basket: basket is empty' using errcode = '22023';
  end if;
  if v_count > 500 then
    raise exception 'reserve_ticket_basket: too many tickets in one order' using errcode = '22023';
  end if;
  if p_event_id is null or p_buyer_id is null then
    raise exception 'reserve_ticket_basket: event and buyer are required' using errcode = '22023';
  end if;
  if p_total_pence is null or p_total_pence < 0 or p_platform_fee_pence is null or p_platform_fee_pence < 0 then
    raise exception 'reserve_ticket_basket: invalid amounts' using errcode = '22023';
  end if;

  -- Required. Without it there is nothing tying a retry to its original order,
  -- and the whole idempotency guarantee is off.
  if p_client_request_id is null or btrim(p_client_request_id) = '' then
    raise exception 'reserve_ticket_basket: a checkout reference is required' using errcode = '22023';
  end if;
  if length(p_client_request_id) < 8 or length(p_client_request_id) > 100 then
    raise exception 'reserve_ticket_basket: client_request_id must be 8-100 characters' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_tickets) t
     where (t->>'ticket_type_id') is null
        or (t->>'token_hash') is null
        or length(t->>'token_hash') < 32
  ) then
    raise exception 'reserve_ticket_basket: every ticket needs a type and a token hash' using errcode = '22023';
  end if;

  -- ── Is this a retry of an attempt we already handled? ────────────────────
  select * into v_order from public.event_ticket_orders
    where buyer_id = p_buyer_id and client_request_id = p_client_request_id
    for update;

  if found then
    if v_order.event_id is distinct from p_event_id then
      raise exception 'IDEMPOTENCY_CONFLICT: this checkout reference belongs to a different event'
        using errcode = '22023';
    end if;
    select exists (
      select 1 from (
        select (t->>'ticket_type_id')::uuid tt, count(*)::int qty
          from jsonb_array_elements(p_tickets) t group by 1
      ) want
      full outer join (
        select ticket_type_id tt, count(*)::int qty
          from public.event_tickets where order_id = v_order.id group by 1
      ) had on had.tt = want.tt
      where want.tt is null or had.tt is null or want.qty <> had.qty
    ) into v_mismatch;
    if v_mismatch then
      raise exception 'IDEMPOTENCY_CONFLICT: this checkout reference was used for a different basket'
        using errcode = '22023';
    end if;

    if v_order.status in ('cancelled', 'refunded') then
      raise exception 'CHECKOUT_EXPIRED: this checkout has expired — start a new one'
        using errcode = '22023';
    end if;

    -- Still pending: nobody holds the raw tokens from the lost response, so
    -- give this call's hashes to the existing tickets. Paid: the buyer may
    -- already hold working tickets, so leave them alone.
    if v_order.status = 'pending' then
      with numbered as (
        select id, row_number() over (order by created_at, id) rn
          from public.event_tickets where order_id = v_order.id
      ), fresh as (
        select (t->>'token_hash') hash, ord rn
          from jsonb_array_elements(p_tickets) with ordinality as e(t, ord)
      )
      update public.event_tickets tk
         set validation_token_hash = fresh.hash
        from numbered n join fresh on fresh.rn = n.rn
       where tk.id = n.id;
    end if;

    select array_agg(id order by created_at, id) into v_ticket_ids
      from public.event_tickets where order_id = v_order.id;

    return jsonb_build_object(
      'order_id',   v_order.id,
      'ticket_ids', to_jsonb(coalesce(v_ticket_ids, '{}'::uuid[])),
      'already',    true,
      'status',     v_order.status,
      'stripe_payment_intent_id', v_order.stripe_payment_intent_id
    );
  end if;

  -- ── A run of dates cannot be sold here: tickets bind to the EVENT, not to one performance ────────────────────────────────────────────────────
  -- (events.occurrences phase 1.) Checked for a NEW reservation only - a retry of an existing order was answered above. FOR KEY SHARE conflicts with the
  -- occurrence guard's FOR UPDATE on the same event row, so a second date and a sale cannot both slip through a race. It deliberately does NOT conflict
  -- with the plain UPDATE of events (FOR NO KEY UPDATE) that refund_event_tickets_for_payment() and the tickets_sold counter perform: that refund locks
  -- ticket types FIRST and the event row afterwards, this function locks the event row first, so a stronger lock here (FOR SHARE) could deadlock a refund
  -- against a sale of the same event.
  perform 1 from public.events where id = p_event_id for key share;
  if (select count(*) from public.event_occurrences o where o.event_id = p_event_id and o.status <> 'cancelled') >= 2 then
    raise exception 'MULTI_PERFORMANCE: this event has more than one date, so its tickets cannot be sold here' using errcode = '22023';
  end if;

  -- ── Lock every affected type, in a deterministic order ──────────────────
  perform 1
     from public.event_ticket_types tt
    where tt.id in (select distinct (t->>'ticket_type_id')::uuid
                      from jsonb_array_elements(p_tickets) t)
    order by tt.id
      for update;

  if (select count(distinct (t->>'ticket_type_id')::uuid) from jsonb_array_elements(p_tickets) t)
     <> (select count(*) from public.event_ticket_types
          where id in (select distinct (t->>'ticket_type_id')::uuid
                         from jsonb_array_elements(p_tickets) t)) then
    raise exception 'reserve_ticket_basket: one or more ticket types do not exist' using errcode = '22023';
  end if;

  -- ── Make the sold counter TRUE before trusting it ───────────────────────
  -- The type rows are locked above, so nothing can reserve or release a seat
  -- while this runs. quantity_sold is a cache of the ticket rows that hold a
  -- seat; if anything ever left it wrong (a refund that used to keep its seat,
  -- a hand edit, a crashed writer) it is put right HERE, so the capacity check
  -- below always judges the real number and a stale counter can never refuse a
  -- sale it should accept, or accept one it should refuse.
  update public.event_ticket_types tt
     set quantity_sold = public.ticket_type_held(tt.id)
   where tt.id in (select distinct (t->>'ticket_type_id')::uuid
                     from jsonb_array_elements(p_tickets) t)
     and tt.quantity_sold is distinct from public.ticket_type_held(tt.id);

  select w.ticket_type_id, l.name, l.event_id, l.is_active,
         l.quantity_available, l.quantity_sold, l.per_order_max, w.qty
    into v_bad
    from (select (t->>'ticket_type_id')::uuid as ticket_type_id, count(*)::int as qty
            from jsonb_array_elements(p_tickets) t group by 1) w
    join public.event_ticket_types l on l.id = w.ticket_type_id
   where l.event_id is distinct from p_event_id
      or l.is_active is not true
      or w.qty > l.per_order_max
      or (l.quantity_available is not null and (l.quantity_available - l.quantity_sold) < w.qty)
   limit 1;

  if found then
    if v_bad.event_id is distinct from p_event_id then
      raise exception 'reserve_ticket_basket: ticket type does not belong to this event' using errcode = '22023';
    elsif v_bad.is_active is not true then
      raise exception 'reserve_ticket_basket: ticket type is not on sale' using errcode = '22023';
    elsif v_bad.qty > v_bad.per_order_max then
      raise exception 'reserve_ticket_basket: more than % allowed per order', v_bad.per_order_max using errcode = '22023';
    else
      raise exception 'SOLD_OUT' using errcode = '23514';
    end if;
  end if;

  -- ── Claim the attempt BEFORE any counter moves ──────────────────────────
  insert into public.event_ticket_orders
    (event_id, buyer_id, status, total_pence, platform_fee_pence, tickets_count, client_request_id)
  values
    (p_event_id, p_buyer_id, 'pending', p_total_pence, p_platform_fee_pence, v_count, p_client_request_id)
  on conflict (buyer_id, client_request_id) where client_request_id is not null
  do nothing
  returning id into v_order_id;

  if v_order_id is null then
    select * into v_order from public.event_ticket_orders
      where buyer_id = p_buyer_id and client_request_id = p_client_request_id;
    if not found then
      raise exception 'reserve_ticket_basket: could not claim this checkout' using errcode = '40001';
    end if;
    select array_agg(id order by created_at, id) into v_ticket_ids
      from public.event_tickets where order_id = v_order.id;
    return jsonb_build_object(
      'order_id',   v_order.id,
      'ticket_ids', to_jsonb(coalesce(v_ticket_ids, '{}'::uuid[])),
      'already',    true,
      'status',     v_order.status,
      'stripe_payment_intent_id', v_order.stripe_payment_intent_id
    );
  end if;

  -- ── Now, and only now, commit the capacity ──────────────────────────────
  update public.event_ticket_types tt
     set quantity_sold = tt.quantity_sold + w.qty
    from (select (t->>'ticket_type_id')::uuid as ticket_type_id, count(*)::int as qty
            from jsonb_array_elements(p_tickets) t group by 1) w
   where tt.id = w.ticket_type_id;

  with ins as (
    insert into public.event_tickets
      (order_id, event_id, ticket_type_id, holder_id, validation_token_hash,
       backup_code, status, attendee_name, attendee_email, price_pence, event_snapshot)
    select v_order_id,
           p_event_id,
           (t->>'ticket_type_id')::uuid,
           p_buyer_id,
           t->>'token_hash',
           public.generate_ticket_backup_code(),
           'pending_payment',
           nullif(t->>'attendee_name',''),
           nullif(t->>'attendee_email',''),
           l.price_pence,
           coalesce(p_snapshot, '{}'::jsonb)
      from jsonb_array_elements(p_tickets) with ordinality as e(t, ord)
      join public.event_ticket_types l on l.id = (t->>'ticket_type_id')::uuid
     order by e.ord
    returning id
  )
  select array_agg(id) into v_ticket_ids from ins;

  return jsonb_build_object(
    'order_id',   v_order_id,
    'ticket_ids', to_jsonb(v_ticket_ids),
    'already',    false,
    'status',     'pending',
    'stripe_payment_intent_id', null
  );
end;
$function$;

-- ── the contributor can always READ their own community event, even when it is hidden ─────────────────────────────────────────────────────────────────
-- Cancelling an event sets status 'cancelled', and the existing events trigger hides every non-published row. Without this, the person who submitted the
-- event could no longer see it, its dates or its history (found while rendering the contributor screens). It grants READ of the contributor's OWN event
-- only: no write, no other event, nothing for anyone else. The occurrence read policy asks the events policies, so the dates come with it.
create or replace function public.is_my_community_event(p_event uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and exists (
    select 1 from public.events e join public.event_submissions s on s.id = e.submission_id
     where e.id = p_event and e.is_platform_event and e.source = 'community_submission' and s.event_id = e.id and s.submitter_id = auth.uid());
$$;
revoke all on function public.is_my_community_event(uuid) from public, anon;
grant execute on function public.is_my_community_event(uuid) to authenticated, service_role;
create policy events_contributor_read on public.events for select to authenticated using (public.is_my_community_event(id));

-- Lets the change form say in advance whether the caller's changes go live straight away (the trust table itself stays staff-only).
create or replace function public.my_event_organiser_trusted() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and coalesce((select t.trusted from public.event_organiser_trust t where t.user_id = auth.uid()), false);
$$;
revoke all on function public.my_event_organiser_trusted() from public, anon;
grant execute on function public.my_event_organiser_trusted() to authenticated, service_role;

commit;
