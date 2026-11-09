-- My Saved, Phase 1: one private "keep this for later" list (events, event dates, Regular Activities and their sessions, jobs, businesses).
-- Design: design_draft.md ("My Saved"), product decisions: concepts_brief.md. NOT applied to production by this file being written.
--
-- WHAT THIS DOES
--   * Jobs stay in the existing public.saved_jobs. Everything else goes in the new public.saved_items (one generic table, text date key, NO foreign key to
--     the saved item, so a save survives the item being deleted).
--   * public.saved_job_meta holds job snapshots (title, closing time). Members can READ their own rows but cannot write them.
--   * public.saved_jobs gets NO new columns and NO trigger. The only change to an existing object is dropping saved_jobs_job_id_fkey: it is ON DELETE CASCADE,
--     and sync-council-jobs hard-deletes council jobs that leave the feed, which silently erased members' saves. A deleted job now leaves the save in place;
--     My Saved shows it as "No longer available" with a Remove button (a visible, removable tombstone). Nothing in web, app or SQL joins saved_jobs to jobs
--     through the relationship (checked); both clients read ids and then fetch jobs with .in('id', ids).
--   * All writes go through definer functions with no direct write grant. save_item never reveals whether an item exists or is visible.
--   * my_saved_list runs with the CALLER's rights, so every existing access rule applies. For items that came back empty it asks the narrow definer lookup
--     saved_item_reasons, which returns a reason code only (expired / postponed / ended / unavailable) and defaults to "unavailable".
--   * A snapshot (title, town, one date) is stored at save time ONLY when the item is public right now (saved_public_now copies each type's anonymous read
--     rule) and is shown only for the three natural-end reasons.
--   * Ships dark: nothing here inserts the admin_config key 'saved.enabled'. Absent = off for everyone except staff.
--
-- SECURITY: every function sets search_path, revokes execute from public, anon AND authenticated by name, then grants explicitly. Member functions start with
-- active_uid() (NULL for a closed account) and raise 42501 SIGN_IN_REQUIRED. saved_items / saved_job_meta: RLS on, SELECT-own policy only, no write grant.
-- ROLLBACK: supabase/rollbacks/20261230110000_my_saved.rollback.sql (re-adds the saved_jobs foreign key as NOT VALID so no existing save is deleted).

begin;

-- ── 1. the one change to an existing object ─────────────────────────────────────────────────
set local lock_timeout = '5s';
alter table public.saved_jobs drop constraint if exists saved_jobs_job_id_fkey;
set local lock_timeout = default;

-- ── 2. tables ───────────────────────────────────────────────────────────────────────────────────
create table public.saved_job_meta (
  user_id        uuid not null references public.profiles(id) on delete cascade,
  job_id         uuid not null,
  snapshot_title text check (snapshot_title is null or char_length(snapshot_title) between 1 and 120),
  snapshot_when  timestamptz,
  created_at     timestamptz not null default now(),
  primary key (user_id, job_id)
);
alter table public.saved_job_meta enable row level security;
revoke all on public.saved_job_meta from public, anon, authenticated;
grant select on public.saved_job_meta to authenticated;
grant all on public.saved_job_meta to service_role;
create policy saved_job_meta_own_read on public.saved_job_meta for select to authenticated using (user_id = auth.uid());

create table public.saved_items (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  item_type      text not null check (item_type in ('event', 'activity', 'business')),
  item_id        uuid not null,
  occurrence_key text,
  snapshot_title text check (snapshot_title is null or char_length(snapshot_title) between 1 and 120),
  snapshot_town  text check (snapshot_town is null or char_length(snapshot_town) between 1 and 80),
  snapshot_when  timestamptz,
  created_at     timestamptz not null default now(),
  constraint saved_items_key_shape check (
    (item_type = 'business' and occurrence_key is null)
    or (item_type = 'event' and (occurrence_key is null
         or occurrence_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    or (item_type = 'activity' and (occurrence_key is null
         or occurrence_key ~ '^rule:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         or occurrence_key ~ '^extra:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
  )
);
create unique index saved_items_unique on public.saved_items (user_id, item_type, item_id, coalesce(occurrence_key, ''));
create index saved_items_user_created on public.saved_items (user_id, created_at desc);
alter table public.saved_items enable row level security;
revoke all on public.saved_items from public, anon, authenticated;
grant select on public.saved_items to authenticated;
grant all on public.saved_items to service_role;
create policy saved_items_own_read on public.saved_items for select to authenticated using (user_id = auth.uid());

-- ── 3. feature switch (ships dark) ──────────────────────────────────────────────────────────────
create or replace function public.saved_enabled() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select lower(btrim(c.value)) = 'true' from public.admin_config c where c.key = 'saved.enabled'), false)
         or public.attribution_staff();
$$;
revoke all on function public.saved_enabled() from public, anon, authenticated;
grant execute on function public.saved_enabled() to anon, authenticated, service_role;

-- ── 4. "would a signed-out visitor see this right now?" (internal; used only by save_item) ─────────
-- A second copy of each type's anonymous read rule, copied from the current policies (jobs read; events_public_read; ra_read_public; business rule). A test
-- compares this with a real signed-out read for every state of every type.
create or replace function public.saved_public_now(p_type text, p_item uuid, p_occurrence text default null) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_type = 'job' then
    return exists (select 1 from public.jobs j where j.id = p_item and not j.is_hidden and (j.expires_at is null or j.expires_at > now()));
  elsif p_type = 'event' then
    if not exists (select 1 from public.events e where e.id = p_item and not e.is_hidden
                    and (e.organiser_hub_id is null or coalesce(e.hub_visibility = any (array['hub', 'islands']), false))) then
      return false;
    end if;
    if p_occurrence is not null then
      return exists (select 1 from public.event_occurrences o where o.id = p_occurrence::uuid and o.event_id = p_item);
    end if;
    return true;
  elsif p_type = 'activity' then
    if not exists (select 1 from public.regular_activities a
                    where a.id = p_item and a.status = 'published' and not a.admin_paused
                      and (a.organiser_hub_id is null or (a.calendar_approved and exists (select 1 from public.hubs h where h.id = a.organiser_hub_id and h.is_active)))
                      and (a.organiser_business_id is null or exists (select 1 from public.local_businesses b where b.id = a.organiser_business_id and b.is_active))) then
      return false;
    end if;
    if p_occurrence like 'rule:%' then
      return exists (select 1 from public.activity_schedule_rules r where r.id = split_part(p_occurrence, ':', 2)::uuid and r.activity_id = p_item);
    elsif p_occurrence like 'extra:%' then
      return exists (select 1 from public.activity_exceptions x where x.id = split_part(p_occurrence, ':', 2)::uuid and x.activity_id = p_item and x.kind = 'extra');
    end if;
    return true;
  elsif p_type = 'business' then
    return exists (select 1 from public.local_businesses b where b.id = p_item and b.is_active)
       and not exists (select 1 from public.discovery_fixtures f where f.entity = 'business' and f.entity_id = p_item);
  end if;
  return false;
end $$;
revoke all on function public.saved_public_now(text, uuid, text) from public, anon, authenticated;

-- ── 5. save / unsave ─────────────────────────────────────────────────────────────────────────────
create or replace function public.save_item(p_type text, p_item uuid, p_occurrence text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.active_uid();
  v_count integer; v_exists boolean;
  v_title text; v_town text; v_when timestamptz; v_public boolean;
begin
  if v_uid is null then raise exception 'SIGN_IN_REQUIRED' using errcode = '42501'; end if;
  if p_type is null or p_type not in ('job', 'event', 'activity', 'business') or p_item is null then
    raise exception 'BAD_REQUEST' using errcode = '22023';
  end if;
  if p_occurrence is not null and (
       p_type in ('job', 'business')
       or (p_type = 'event' and p_occurrence !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
       or (p_type = 'activity' and p_occurrence !~ '^rule:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                               and p_occurrence !~ '^extra:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) then
    raise exception 'BAD_REQUEST' using errcode = '22023';
  end if;
  if p_type = 'activity' and p_occurrence like 'rule:%' then
    begin perform split_part(p_occurrence, ':', 3)::date; exception when others then raise exception 'BAD_REQUEST' using errcode = '22023'; end;
  end if;
  if not public.saved_enabled() then return jsonb_build_object('ok', false, 'error', 'NOT_ENABLED'); end if;

  perform pg_advisory_xact_lock(hashtextextended('saved:' || v_uid::text, 0));

  if p_type = 'job' then
    v_exists := exists (select 1 from public.saved_jobs where user_id = v_uid and job_id = p_item);
  else
    v_exists := exists (select 1 from public.saved_items where user_id = v_uid and item_type = p_type and item_id = p_item
                         and coalesce(occurrence_key, '') = coalesce(p_occurrence, ''));
  end if;
  if v_exists then return jsonb_build_object('ok', true, 'saved', true, 'already', true); end if;

  select (select count(*) from public.saved_items where user_id = v_uid) + (select count(*) from public.saved_jobs where user_id = v_uid) into v_count;
  if v_count >= 500 then return jsonb_build_object('ok', false, 'error', 'LIMIT_REACHED'); end if;

  v_public := p_type <> 'business' and public.saved_public_now(p_type, p_item, p_occurrence);
  if v_public then
    if p_type = 'job' then
      select left(j.title, 120), j.expires_at into v_title, v_when from public.jobs j where j.id = p_item;
    elsif p_type = 'event' then
      select left(e.title, 120), left(e.locality, 80), coalesce(o.starts_at, e.starts_at) into v_title, v_town, v_when
        from public.events e left join public.event_occurrences o on o.id = nullif(p_occurrence, '')::uuid and o.event_id = e.id where e.id = p_item;
    elsif p_type = 'activity' then
      select left(a.title, 120), left(a.locality, 80) into v_title, v_town from public.regular_activities a where a.id = p_item;
    end if;
  end if;

  if p_type = 'job' then
    insert into public.saved_jobs (user_id, job_id) values (v_uid, p_item) on conflict (user_id, job_id) do nothing;
    if v_title is not null then
      insert into public.saved_job_meta (user_id, job_id, snapshot_title, snapshot_when) values (v_uid, p_item, nullif(btrim(v_title), ''), v_when)
        on conflict (user_id, job_id) do update set snapshot_title = excluded.snapshot_title, snapshot_when = excluded.snapshot_when, created_at = now();
    end if;
  else
    insert into public.saved_items (user_id, item_type, item_id, occurrence_key, snapshot_title, snapshot_town, snapshot_when)
      values (v_uid, p_type, p_item, p_occurrence, nullif(btrim(v_title), ''), nullif(btrim(v_town), ''), v_when)
      on conflict (user_id, item_type, item_id, coalesce(occurrence_key, '')) do nothing;
  end if;
  return jsonb_build_object('ok', true, 'saved', true, 'already', false);
end $$;
revoke all on function public.save_item(text, uuid, text) from public, anon, authenticated;
grant execute on function public.save_item(text, uuid, text) to authenticated;

-- Removing works while the feature is off, so a member can always take a save away.
create or replace function public.unsave_item(p_type text, p_item uuid, p_occurrence text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := public.active_uid(); n integer := 0;
begin
  if v_uid is null then raise exception 'SIGN_IN_REQUIRED' using errcode = '42501'; end if;
  if p_type is null or p_type not in ('job', 'event', 'activity', 'business') or p_item is null then raise exception 'BAD_REQUEST' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('saved:' || v_uid::text, 0));
  if p_type = 'job' then
    delete from public.saved_jobs where user_id = v_uid and job_id = p_item;
    get diagnostics n = row_count;
    delete from public.saved_job_meta where user_id = v_uid and job_id = p_item;
  else
    delete from public.saved_items where user_id = v_uid and item_type = p_type and item_id = p_item and coalesce(occurrence_key, '') = coalesce(p_occurrence, '');
    get diagnostics n = row_count;
  end if;
  return jsonb_build_object('ok', true, 'removed', n > 0);
end $$;
revoke all on function public.unsave_item(text, uuid, text) from public, anon, authenticated;
grant execute on function public.unsave_item(text, uuid, text) to authenticated;

create or replace function public.unsave_many(p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := public.active_uid(); r record; n integer := 0; k integer;
begin
  if v_uid is null then raise exception 'SIGN_IN_REQUIRED' using errcode = '42501'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 200 then raise exception 'BAD_REQUEST' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('saved:' || v_uid::text, 0));
  for r in select * from jsonb_to_recordset(p_items) as t(type text, item uuid, occurrence text) loop
    if r.type = 'job' then
      delete from public.saved_jobs where user_id = v_uid and job_id = r.item; get diagnostics k = row_count; n := n + k;
      delete from public.saved_job_meta where user_id = v_uid and job_id = r.item;
    elsif r.type in ('event', 'activity', 'business') then
      delete from public.saved_items where user_id = v_uid and item_type = r.type and item_id = r.item and coalesce(occurrence_key, '') = coalesce(r.occurrence, '');
      get diagnostics k = row_count; n := n + k;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'removed', n);
end $$;
revoke all on function public.unsave_many(jsonb) from public, anon, authenticated;
grant execute on function public.unsave_many(jsonb) to authenticated;

-- ── 6. batched "which of these are saved?" (caller's rights) ─────────────────────────────────────
create or replace function public.my_saved_flags(p_type text, p_ids uuid[]) returns jsonb
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare v_uid uuid := public.active_uid(); v jsonb;
begin
  if v_uid is null then raise exception 'SIGN_IN_REQUIRED' using errcode = '42501'; end if;
  if p_type is null or p_type not in ('job', 'event', 'activity', 'business') or p_ids is null or cardinality(p_ids) > 200 then
    raise exception 'BAD_REQUEST' using errcode = '22023';
  end if;
  if p_type = 'job' then
    select coalesce(jsonb_agg(jsonb_build_object('item_id', job_id, 'occurrence_key', null)), '[]'::jsonb) into v
      from public.saved_jobs where user_id = v_uid and job_id = any (p_ids);
  else
    select coalesce(jsonb_agg(jsonb_build_object('item_id', item_id, 'occurrence_key', occurrence_key)), '[]'::jsonb) into v
      from public.saved_items where user_id = v_uid and item_type = p_type and item_id = any (p_ids);
  end if;
  return v;
end $$;
revoke all on function public.my_saved_flags(text, uuid[]) from public, anon, authenticated;
grant execute on function public.my_saved_flags(text, uuid[]) to authenticated;

-- ── 7. the narrow lookup: a reason code and nothing else ────────────────────────────────────────
-- Only for the caller's OWN saves (it re-joins them). A snapshot must exist for 'expired' / 'postponed' / 'ended' (a snapshot proves the item was public when
-- saved). Any state not named, and any unreadable fact, is 'unavailable'.
create or replace function public.saved_item_reasons(p_refs jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_uid uuid := public.active_uid(); v jsonb;
begin
  if v_uid is null then raise exception 'SIGN_IN_REQUIRED' using errcode = '42501'; end if;
  if p_refs is null or jsonb_typeof(p_refs) <> 'array' then return '[]'::jsonb; end if;
  if jsonb_array_length(p_refs) > 1000 then raise exception 'BAD_REQUEST' using errcode = '22023'; end if;
  with refs as (select * from jsonb_to_recordset(p_refs) as t(type text, item uuid, occurrence text)),
  mine as (
    select r.type, r.item, r.occurrence, (m.snapshot_title is not null) as snap
      from refs r
      join public.saved_jobs sj on r.type = 'job' and sj.user_id = v_uid and sj.job_id = r.item
      left join public.saved_job_meta m on m.user_id = sj.user_id and m.job_id = sj.job_id and m.created_at >= sj.created_at
    union all
    select r.type, r.item, r.occurrence, (si.snapshot_title is not null)
      from refs r
      join public.saved_items si on si.user_id = v_uid and si.item_type = r.type and si.item_id = r.item and si.occurrence_key is not distinct from r.occurrence
  )
  select coalesce(jsonb_agg(jsonb_build_object('type', m.type, 'item', m.item, 'occurrence', m.occurrence, 'reason',
    case m.type
      when 'job' then case when j.id is null or j.is_hidden then 'unavailable'
                           when j.expires_at is not null and j.expires_at <= now() and m.snap then 'expired'
                           else 'unavailable' end
      when 'event' then case when e.id is null then 'unavailable'
                             when e.status = 'postponed' and m.snap then 'postponed'
                             else 'unavailable' end
      when 'activity' then case when a.id is null then 'unavailable'
                                when a.admin_paused then 'unavailable'
                                when a.organiser_hub_id is not null and not (a.calendar_approved and coalesce(h.is_active, false)) then 'unavailable'
                                when a.organiser_business_id is not null and not coalesce(b.is_active, false) then 'unavailable'
                                when a.status = 'draft' then 'unavailable'
                                when a.status = 'ended' and m.snap then 'ended'
                                else 'unavailable' end
      else 'unavailable'
    end)), '[]'::jsonb) into v
  from mine m
  left join public.jobs j on m.type = 'job' and j.id = m.item
  left join public.events e on m.type = 'event' and e.id = m.item
  left join public.regular_activities a on m.type = 'activity' and a.id = m.item
  left join public.hubs h on h.id = a.organiser_hub_id
  left join public.local_businesses b on b.id = a.organiser_business_id;
  return v;
end $$;
revoke all on function public.saved_item_reasons(jsonb) from public, anon, authenticated;
grant execute on function public.saved_item_reasons(jsonb) to authenticated;

-- ── 8. activity helpers (caller's rights; primary-key lookups, never the window function for one saved session) ───
create or replace function public.saved_session_state(p_activity uuid, p_key text)
returns table (o_state text, o_starts timestamptz, o_ends timestamptz, o_venue text, o_locality text, o_note text, o_moved boolean, o_original date)
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  a record; r record; x record; d date; v_break boolean := false; v_note text; s_start timestamptz; s_end timestamptz; v_state text;
begin
  select ac.id, ac.status, ac.active_from, ac.active_until, ac.venue, ac.locality into a from public.regular_activities ac where ac.id = p_activity;
  if not found then return; end if;
  if p_key like 'extra:%' then
    select ex.id, ex.new_starts_at, ex.new_ends_at, ex.new_venue, ex.new_locality, ex.note into x
      from public.activity_exceptions ex where ex.id = split_part(p_key, ':', 2)::uuid and ex.kind = 'extra' and ex.activity_id = p_activity;
    if not found then return query select 'date_gone', null::timestamptz, null::timestamptz, null::text, null::text, null::text, false, null::date; return; end if;
    v_state := case when coalesce(x.new_ends_at, x.new_starts_at) < now() then 'past' else 'upcoming' end;
    return query select v_state, x.new_starts_at, x.new_ends_at, coalesce(x.new_venue, a.venue), coalesce(x.new_locality, a.locality), x.note, false, (x.new_starts_at at time zone 'Europe/London')::date;
    return;
  end if;
  if p_key like 'rule:%' then
    d := split_part(p_key, ':', 3)::date;
    select ru.id, ru.is_active, ru.anchor_date, ru.day_of_week, ru.interval_weeks, ru.valid_from, ru.valid_until, ru.start_time, ru.end_time, ru.venue, ru.locality into r
      from public.activity_schedule_rules ru where ru.id = split_part(p_key, ':', 2)::uuid and ru.activity_id = p_activity;
    if not found or not r.is_active or a.status not in ('draft', 'published')
       or not public.activity_rule_occurs_on(r.anchor_date, r.day_of_week, r.interval_weeks, d)
       or d < greatest(r.anchor_date, coalesce(r.valid_from, '-infinity'::date), coalesce(a.active_from, '-infinity'::date))
       or d > least(coalesce(r.valid_until, 'infinity'::date), coalesce(a.active_until, 'infinity'::date)) then
      return query select 'date_gone', null::timestamptz, null::timestamptz, null::text, null::text, null::text, false, d; return;
    end if;
    s_start := (d + r.start_time) at time zone 'Europe/London';
    s_end   := (d + r.end_time) at time zone 'Europe/London';
    select ex.kind, ex.new_starts_at, ex.new_ends_at, ex.new_venue, ex.new_locality, ex.note into x
      from public.activity_exceptions ex where ex.rule_id = r.id and ex.occurrence_date = d;
    if found and x.kind = 'cancelled' then
      return query select 'cancelled', s_start, s_end, coalesce(r.venue, a.venue), coalesce(r.locality, a.locality), x.note, false, d; return;
    elsif found and x.kind = 'changed' then
      if x.new_starts_at is not null then
        s_end := coalesce(x.new_ends_at, x.new_starts_at + (s_end - s_start)); s_start := x.new_starts_at;
      end if;
      return query select 'changed', s_start, s_end, coalesce(x.new_venue, r.venue, a.venue), coalesce(x.new_locality, r.locality, a.locality), x.note,
                          (x.new_starts_at is not null and (x.new_starts_at at time zone 'Europe/London')::date <> d), d;
      return;
    end if;
    select true, coalesce(br.reason, '') into v_break, v_note from public.activity_breaks br
      where br.activity_id = p_activity and d between br.start_date and br.end_date order by br.start_date limit 1;
    if coalesce(v_break, false) then
      return query select 'break', s_start, s_end, coalesce(r.venue, a.venue), coalesce(r.locality, a.locality), nullif(v_note, ''), false, d; return;
    end if;
    v_state := case when s_end < now() then 'past' else 'upcoming' end;
    return query select v_state, s_start, s_end, coalesce(r.venue, a.venue), coalesce(r.locality, a.locality), null::text, false, d;
    return;
  end if;
end $$;
revoke all on function public.saved_session_state(uuid, text) from public, anon, authenticated;
grant execute on function public.saved_session_state(uuid, text) to authenticated;

create or replace function public.saved_activity_next(p_activity uuid)
returns table (o_starts timestamptz, o_ends timestamptz, o_venue text, o_locality text, o_note text)
language sql stable security invoker set search_path = public, pg_temp as $$
  select s.starts_at, s.ends_at, s.venue, s.locality, s.note
    from public.activity_sessions(now(), now() + interval '93 days', p_activity, 120) s
   where s.status not in ('cancelled', 'break') and s.starts_at >= now()
   order by s.starts_at limit 1;
$$;
revoke all on function public.saved_activity_next(uuid) from public, anon, authenticated;
grant execute on function public.saved_activity_next(uuid) to authenticated;

-- ── 9. the list ───────────────────────────────────────────────────────────────────────────────────
create or replace function public.my_saved_list(p_type text default null) returns jsonb
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare v_uid uuid := public.active_uid(); v_total integer; v_items jsonb;
begin
  if v_uid is null then raise exception 'SIGN_IN_REQUIRED' using errcode = '42501'; end if;
  if p_type is not null and p_type not in ('job', 'event', 'activity', 'business') then raise exception 'BAD_REQUEST' using errcode = '22023'; end if;
  select (select count(*) from public.saved_items where user_id = v_uid) + (select count(*) from public.saved_jobs where user_id = v_uid) into v_total;

  with base as (
    select 'job'::text as item_type, sj.job_id as item_id, null::text as occurrence_key, sj.created_at as saved_at,
           m.snapshot_title, null::text as snapshot_town, m.snapshot_when
      from public.saved_jobs sj
      left join public.saved_job_meta m on m.user_id = sj.user_id and m.job_id = sj.job_id and m.created_at >= sj.created_at
     where sj.user_id = v_uid
    union all
    select si.item_type, si.item_id, si.occurrence_key, si.created_at, si.snapshot_title, si.snapshot_town, si.snapshot_when
      from public.saved_items si where si.user_id = v_uid
  ), base2 as (select * from base where p_type is null or item_type = p_type),
  jobs_s as (
    select b.item_type, b.item_id, b.occurrence_key, b.saved_at, b.snapshot_title, b.snapshot_town, b.snapshot_when,
           (j.id is null) as needs_reason,
           case when j.id is null then null
                when j.expires_at is not null and j.expires_at <= now() then 'past'
                when j.status = 'closed' then 'closed'
                when j.status = 'filled' then 'filled'
                when j.expires_at is not null then 'upcoming' else 'ok' end as state,
           j.title as title, coalesce(j.location, j.locality) as place, null::timestamptz as starts_at, j.expires_at as ends_at,
           null::text as note, null::text as slug, (j.id is not null) as parent_readable, null::date as original_date, false as moved
      from base2 b left join public.jobs j on j.id = b.item_id where b.item_type = 'job'
  ),
  ev_s as (
    select b.item_type, b.item_id, b.occurrence_key, b.saved_at, b.snapshot_title, b.snapshot_town, b.snapshot_when,
           (e.id is null) as needs_reason,
           case
             when e.id is null then null
             when e.status in ('draft', 'archived') then 'unavailable'
             when b.occurrence_key is not null and o.id is null then 'date_gone'
             when b.occurrence_key is not null then
               case when o.status = 'cancelled' or e.status = 'cancelled' then 'cancelled'
                    when coalesce(o.ends_at, o.starts_at) < now() then 'past'
                    when e.status = 'postponed' then 'postponed'
                    when o.status = 'changed' then 'changed' else 'upcoming' end
             else
               case when e.status = 'cancelled' then 'cancelled'
                    when coalesce(e.ends_at, e.starts_at) < now() then 'past'
                    when e.status = 'postponed' then 'postponed' else 'upcoming' end
           end as state,
           e.title as title, nullif(btrim(concat_ws(', ', coalesce(o.venue, e.venue), coalesce(o.locality, e.locality))), '') as place,
           case when b.occurrence_key is not null then o.starts_at
                else coalesce((select min(oo.starts_at) from public.event_occurrences oo where oo.event_id = e.id and oo.status <> 'cancelled' and oo.starts_at >= now()), e.starts_at) end as starts_at,
           case when b.occurrence_key is not null then o.ends_at else e.ends_at end as ends_at,
           o.note as note, null::text as slug, (e.id is not null) as parent_readable, null::date as original_date, coalesce(o.status = 'changed', false) as moved
      from base2 b
      left join public.events e on e.id = b.item_id
      left join public.event_occurrences o on b.occurrence_key is not null and o.id = nullif(b.occurrence_key, '')::uuid and o.event_id = e.id
     where b.item_type = 'event'
  ),
  act_s as (
    select b.item_type, b.item_id, b.occurrence_key, b.saved_at, b.snapshot_title, b.snapshot_town, b.snapshot_when,
           (a.id is null) as needs_reason,
           case when a.id is null then null
                when b.occurrence_key is not null then ss.o_state
                when nx.o_starts is null then 'no_upcoming' else 'upcoming' end as state,
           a.title as title,
           nullif(btrim(concat_ws(', ', coalesce(ss.o_venue, nx.o_venue, a.venue), coalesce(ss.o_locality, nx.o_locality, a.locality))), '') as place,
           coalesce(ss.o_starts, nx.o_starts) as starts_at, coalesce(ss.o_ends, nx.o_ends) as ends_at,
           coalesce(ss.o_note, nx.o_note) as note, a.slug as slug, (a.id is not null) as parent_readable, ss.o_original as original_date, coalesce(ss.o_moved, false) as moved
      from (select b2.*, row_number() over (order by b2.saved_at desc) as rn from base2 b2 where b2.item_type = 'activity') b
      left join public.regular_activities a on a.id = b.item_id
      left join lateral (select * from public.saved_session_state(a.id, b.occurrence_key) where a.id is not null and b.occurrence_key is not null) ss on true
      left join lateral (select * from public.saved_activity_next(a.id) where a.id is not null and b.occurrence_key is null and b.rn <= 100) nx on true
  ),
  biz_s as (
    select b.item_type, b.item_id, b.occurrence_key, b.saved_at, b.snapshot_title, b.snapshot_town, b.snapshot_when,
           (lb.id is null) as needs_reason, case when lb.id is null then null else 'ok' end as state,
           lb.name as title, coalesce(lb.locality, lb.address) as place, null::timestamptz as starts_at, null::timestamptz as ends_at,
           null::text as note, lb.slug as slug, (lb.id is not null) as parent_readable, null::date as original_date, false as moved
      from base2 b left join public.local_businesses_public lb on lb.id = b.item_id where b.item_type = 'business'
  ),
  parts as (
    select * from jobs_s union all select * from ev_s union all select * from act_s union all select * from biz_s
  ),
  need as (
    select jsonb_agg(jsonb_build_object('type', item_type, 'item', item_id, 'occurrence', occurrence_key)) as refs from parts where needs_reason
  ),
  reasons as (
    select r.type, r.item, r.occurrence, r.reason
      from jsonb_to_recordset(coalesce(public.saved_item_reasons((select refs from need)), '[]'::jsonb)) as r(type text, item uuid, occurrence text, reason text)
  ),
  fin as (
    select p.*,
           case when p.needs_reason then
                  case when r.reason = 'expired' and p.snapshot_title is not null then 'snapshot_expired'
                       when r.reason = 'postponed' and p.snapshot_title is not null then 'snapshot_postponed'
                       when r.reason = 'ended' and p.snapshot_title is not null then 'snapshot_ended'
                       else 'unavailable' end
                else p.state end as fstate
      from parts p
      left join reasons r on r.type = p.item_type and r.item = p.item_id and r.occurrence is not distinct from p.occurrence_key
  ),
  shaped as (
    select f.*,
           case when f.fstate like 'snapshot\_%' then f.snapshot_title when f.fstate = 'unavailable' then null else f.title end as o_title,
           case when f.fstate like 'snapshot\_%' then f.snapshot_town when f.fstate = 'unavailable' then null else f.place end as o_place,
           case when f.fstate like 'snapshot\_%' then f.snapshot_when when f.fstate = 'unavailable' then null else f.starts_at end as o_starts,
           case when f.fstate like 'snapshot\_%' or f.fstate = 'unavailable' then null else f.ends_at end as o_ends,
           case when f.fstate in ('unavailable') or f.fstate like 'snapshot\_%' then null else f.note end as o_note,
           case when f.fstate in ('unavailable') or f.fstate like 'snapshot\_%' then null else f.slug end as o_slug,
           (f.fstate like 'snapshot\_%') as from_snapshot,
           case
             when f.fstate in ('changed', 'cancelled', 'postponed', 'break')
                  and coalesce(f.ends_at, f.starts_at, now()) >= now() then 0
             when f.fstate = 'upcoming' then 1
             when f.fstate in ('closed', 'filled') and f.ends_at is not null and f.ends_at >= now() then 1
             when f.fstate in ('ok', 'no_upcoming', 'closed', 'filled') then 2
             else 3 end as bucket
      from fin f
  ),
  final as (
    select s.*,
           coalesce(s.o_starts, s.ends_at, s.saved_at) as sort_at,
           (s.occurrence_key is not null and exists (select 1 from fin f2 where f2.item_type = s.item_type and f2.item_id = s.item_id and f2.occurrence_key is null)) as shadowed
      from shaped s
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'key', item_type || '|' || item_id || '|' || coalesce(occurrence_key, ''),
           'item_type', item_type, 'item_id', item_id, 'occurrence_key', occurrence_key, 'saved_at', saved_at,
           'state', fstate, 'bucket', bucket, 'sort_at', case when bucket <= 1 then sort_at else saved_at end,
           'title', o_title, 'place', o_place, 'starts_at', o_starts, 'ends_at', o_ends, 'note', o_note,
           'from_snapshot', from_snapshot, 'slug', o_slug, 'parent_readable', parent_readable,
           'original_date', original_date, 'moved', moved, 'shadowed', shadowed)
         order by bucket, (case when bucket <= 1 then sort_at end) asc nulls last, (case when bucket >= 2 then saved_at end) desc nulls last, item_type, item_id, occurrence_key), '[]'::jsonb)
    into v_items
    from (select * from final order by bucket, (case when bucket <= 1 then sort_at end) asc nulls last, (case when bucket >= 2 then saved_at end) desc nulls last limit 1000) q;

  return jsonb_build_object('items', v_items, 'total', v_total, 'more', v_total > 1000);
end $$;
revoke all on function public.my_saved_list(text) from public, anon, authenticated;
grant execute on function public.my_saved_list(text) to authenticated;

-- ── 10. service-role-only maintenance ─────────────────────────────────────────────────────────────
-- Writes a snapshot for every saved job that is public right now and has none; removes meta rows whose save no longer exists. Never overwrites. Idempotent.
-- Back-filled snapshots reflect the time of the back-fill.
create or replace function public.backfill_saved_job_meta() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  delete from public.saved_job_meta m where not exists (select 1 from public.saved_jobs sj where sj.user_id = m.user_id and sj.job_id = m.job_id);
  insert into public.saved_job_meta (user_id, job_id, snapshot_title, snapshot_when)
    select sj.user_id, sj.job_id, left(btrim(j.title), 120), j.expires_at
      from public.saved_jobs sj join public.jobs j on j.id = sj.job_id
     where not j.is_hidden and (j.expires_at is null or j.expires_at > now()) and btrim(j.title) <> ''
       and not exists (select 1 from public.saved_job_meta m where m.user_id = sj.user_id and m.job_id = sj.job_id)
    on conflict (user_id, job_id) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.backfill_saved_job_meta() from public, anon, authenticated;
grant execute on function public.backfill_saved_job_meta() to service_role;

-- Account deletion: removes everything saved. Takes the same per-member lock as save_item so a save cannot land between this and the profile scrub.
create or replace function public.delete_member_saved(p_user uuid) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer := 0; k integer;
begin
  if p_user is null then raise exception 'BAD_REQUEST' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('saved:' || p_user::text, 0));
  delete from public.saved_items where user_id = p_user; get diagnostics k = row_count; n := n + k;
  delete from public.saved_jobs where user_id = p_user; get diagnostics k = row_count; n := n + k;
  delete from public.saved_job_meta where user_id = p_user; get diagnostics k = row_count; n := n + k;
  delete from public.reminder_deliveries where user_id = p_user; get diagnostics k = row_count; n := n + k;
  return n;
end $$;
revoke all on function public.delete_member_saved(uuid) from public, anon, authenticated;
grant execute on function public.delete_member_saved(uuid) to service_role;

-- Snapshots for saves that already exist and whose job is public now (idempotent; the same function can be re-run before the switch is turned on).
select public.backfill_saved_job_meta();

commit;
