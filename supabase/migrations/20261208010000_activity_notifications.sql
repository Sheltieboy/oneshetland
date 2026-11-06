-- Regular Activities: delivering follower alerts to the Notification Centre (in-app only; NO push, NO email in V1).
--
-- WHAT FOLLOWERS GET. When a session of an activity they follow is cancelled, moved, retimed, relocated, restored, or a holiday break is set
-- (only for sessions in the next three weeks), they get ONE item in their OneShetland Notification Centre per activity per run, however many
-- sessions changed. It is the same inbox the rest of the product uses (notification_log; shown for status sent / no_token / skipped_quiet).
-- Nothing is pushed to a phone and nothing is emailed. Items are written with status 'no_token' ("inbox only, no push attempted"), the
-- existing convention for in-app-only delivery, which also keeps them out of the push-delivery statistics.
--
-- WHY IN THE DATABASE. The first draft was an Edge Function called on a schedule. With in-app delivery there is nothing outside the database
-- to call, so the whole job is ONE transaction per activity: the inbox rows, the "already told" state and the outbox bookkeeping commit
-- together or not at all. No HTTP hop, no shared secret, no partial send. It follows the established pattern for scheduled jobs here
-- (pg_cron running a SQL function; see 20260819240000_schedule_ticket_expiry.sql).
--
-- RULES (all proved in supabase/tests/activity-notifications.node.test.ts)
--   * BATCHING: edits to one session collapse to the last; a cancel then a restore before anything was sent sends nothing; several changed
--     sessions of one activity become one item. A state followers were already told is never sent twice (activity_notice_state).
--   * SETTLE: rows younger than two minutes wait, so an organiser finishing several edits sends one message, not several.
--   * THROTTLE: at most one alert per activity per 30 minutes. Changes made inside that window are held and go out together in the next
--     one, so an organiser fiddling with a note cannot send followers a string of items. The exception is urgency: a change to a session
--     starting within six hours is never held back.
--   * UNFOLLOWING: followers are read when the job RUNS, so someone who unfollowed first gets nothing. Someone who followed AFTER a change is
--     not told about that change.
--   * PREFERENCES: the existing should_notify() is asked (as urgent, so quiet hours do not hide an inbox item). A member who has switched
--     off notifications, or the Events category, gets a hidden 'skipped_pref' record and nothing visible, exactly like every other sender.
--   * FAILURE: each activity is processed in its own sub-transaction. One that fails is rolled back whole, its attempts and error are recorded,
--     and it is retried every minute; other activities are unaffected. After five failed attempts it is given up (outcome 'failed', visible to
--     staff) so a poison row can never block the queue.
--   * CONCURRENCY: rows are claimed with FOR UPDATE SKIP LOCKED, so overlapping runs cannot double-send.
--   * BOUNDED: at most 200 outbox rows and 5,000 followers per activity per run.
--
-- ROLLBACK: drop functions process_activity_change_notices, activity_notices_for_activity, activity_notice_line, activity_notice_when,
-- activity_is_public, admin_activity_notice_status. Already-delivered inbox rows stay (they are the user's records).

-- A SECURITY DEFINER copy of the public-visibility rule (the processor bypasses row security, so it must apply the rule itself).
-- Tested to agree with what visitors can actually read.
create or replace function public.activity_is_public(a public.regular_activities)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.status = 'published' and not a.admin_paused
     and (a.organiser_hub_id is null or (a.calendar_approved and exists (select 1 from public.hubs h where h.id = a.organiser_hub_id and h.is_active)))
     and (a.organiser_business_id is null or exists (select 1 from public.local_businesses b where b.id = a.organiser_business_id and b.is_active));
$$;
revoke all on function public.activity_is_public(public.regular_activities) from public, anon, authenticated;

create or replace function public.activity_notice_when(p_ts timestamptz)
returns text
language sql
immutable
as $$ select to_char(p_ts at time zone 'Europe/London', 'Dy FMDD Mon HH24:MI') $$;

create or replace function public.activity_notice_line(n public.activity_change_notices)
returns text
language sql
immutable
as $$
  select case n.kind
    when 'cancelled' then public.activity_notice_when(n.session_starts_at) || ' is cancelled' || coalesce(' (' || nullif(btrim(n.note), '') || ')', '')
    when 'restored'  then public.activity_notice_when(n.session_starts_at) || ' is back on'
    when 'extra'     then 'extra session on ' || public.activity_notice_when(n.session_starts_at) || coalesce(' (' || nullif(btrim(n.note), '') || ')', '')
    when 'break'     then 'no sessions ' || coalesce(nullif(btrim(n.note), ''), 'for a short break')
    else case
      when n.new_starts_at is not null then public.activity_notice_when(n.session_starts_at) || ' has moved to ' || public.activity_notice_when(n.new_starts_at)
                                            || coalesce(' at ' || n.new_venue, '') || coalesce(' (' || nullif(btrim(n.note), '') || ')', '')
      when n.new_venue is not null     then public.activity_notice_when(n.session_starts_at) || ' is now at ' || n.new_venue || coalesce(' (' || nullif(btrim(n.note), '') || ')', '')
      else 'update for ' || public.activity_notice_when(n.session_starts_at) || coalesce(' (' || nullif(btrim(n.note), '') || ')', '')
    end
  end
$$;

-- One activity's share of a run. Raises on any failure so the caller can roll back exactly this activity.
create or replace function public.activity_notices_for_activity(p_act uuid, p_claimed uuid[], p_now timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a public.regular_activities;
  n public.activity_change_notices;
  f record;
  v_cand public.activity_change_notices[] := '{}';
  v_mine public.activity_change_notices[];
  v_last text;
  v_lines text[];
  v_body text;
  c_super int := 0; c_ident int := 0; c_past int := 0; c_never int := 0; c_cand int := 0; c_recip int := 0; c_optout int := 0; c_x int;
begin
  -- Older rows for a session that has a newer one are consumed without a message.
  update public.activity_change_notices o
     set processed_at = p_now, outcome = 'superseded'
   where o.id = any (p_claimed) and o.activity_id = p_act
     and o.id not in (select distinct on (l.session_key) l.id from public.activity_change_notices l
                       where l.id = any (p_claimed) and l.activity_id = p_act order by l.session_key, l.created_at desc, l.id desc);
  get diagnostics c_super = row_count;

  for n in select distinct on (l.session_key) l.* from public.activity_change_notices l
            where l.id = any (p_claimed) and l.activity_id = p_act and l.processed_at is null
            order by l.session_key, l.created_at desc, l.id desc
  loop
    select s.last_state_hash into v_last from public.activity_notice_state s where s.session_key = n.session_key;
    if (case when n.kind = 'break' then n.session_starts_at < p_now - interval '1 day' else n.session_starts_at < p_now end) then
      update public.activity_change_notices set processed_at = p_now, outcome = 'past' where id = n.id; c_past := c_past + 1;
    elsif v_last is not distinct from n.state_hash then
      update public.activity_change_notices set processed_at = p_now, outcome = 'identical' where id = n.id; c_ident := c_ident + 1;
    elsif n.kind = 'restored' and v_last is null then
      update public.activity_change_notices set processed_at = p_now, outcome = 'never_told' where id = n.id; c_never := c_never + 1;
    else
      v_cand := v_cand || n; c_cand := c_cand + 1;
    end if;
  end loop;

  if c_cand = 0 then
    return jsonb_build_object('superseded', c_super, 'identical', c_ident, 'past', c_past, 'never_told', c_never, 'candidates', 0, 'recipients', 0, 'optout', 0);
  end if;

  -- Throttle: held (left pending, not failed) unless something starts within six hours.
  if exists (select 1 from public.activity_notice_state s where s.activity_id = p_act and s.last_sent_at > p_now - interval '30 minutes')
     and not exists (select 1 from unnest(v_cand) c where c.session_starts_at < p_now + interval '6 hours') then
    return jsonb_build_object('superseded', c_super, 'identical', c_ident, 'past', c_past, 'never_told', c_never, 'candidates', c_cand, 'recipients', 0, 'optout', 0, 'throttled', c_cand);
  end if;

  select * into a from public.regular_activities where id = p_act;
  if not found or not public.activity_is_public(a) then
    update public.activity_change_notices set processed_at = p_now, outcome = 'inactive' where id in (select (x).id from unnest(v_cand) x);
    return jsonb_build_object('superseded', c_super, 'identical', c_ident, 'past', c_past, 'never_told', c_never, 'candidates', c_cand, 'recipients', 0, 'optout', 0, 'inactive', true);
  end if;

  for f in select user_id, created_at from public.activity_follows where activity_id = p_act order by created_at limit 5000 loop
    -- Only changes made AFTER they followed.
    select array_agg(c order by c.session_starts_at) into v_mine from unnest(v_cand) c where c.created_at >= f.created_at;
    continue when v_mine is null;
    select array_agg(public.activity_notice_line(c) order by c.session_starts_at) into v_lines from unnest(v_mine) c;
    v_body := case when array_length(v_lines, 1) = 1
                   then upper(left(v_lines[1], 1)) || substr(v_lines[1], 2)
                   else array_length(v_lines, 1) || ' changes to upcoming sessions. Open the activity to see the latest times.' end;
    insert into public.notification_log (user_id, category, title, body, data, status)
    values (f.user_id, 'events.activity_change', a.title, v_body,
            jsonb_build_object('screen', 'regular-activity', 'activity_id', a.id, 'activity_slug', a.slug),
            case when public.should_notify(f.user_id, 'events', true) then 'no_token' else 'skipped_pref' end);
    if public.should_notify(f.user_id, 'events', true) then c_recip := c_recip + 1; else c_optout := c_optout + 1; end if;
  end loop;

  insert into public.activity_notice_state (session_key, activity_id, last_state_hash, last_sent_at)
  select (x).session_key, p_act, (x).state_hash, p_now from unnest(v_cand) x
  on conflict (session_key) do update set last_state_hash = excluded.last_state_hash, last_sent_at = excluded.last_sent_at, activity_id = excluded.activity_id;
  update public.activity_change_notices
     set processed_at = p_now, outcome = case when c_recip + c_optout > 0 then 'delivered' else 'no_followers' end
   where id in (select (x).id from unnest(v_cand) x);
  get diagnostics c_x = row_count;

  return jsonb_build_object('superseded', c_super, 'identical', c_ident, 'past', c_past, 'never_told', c_never, 'candidates', c_cand, 'recipients', c_recip, 'optout', c_optout);
end;
$$;
revoke all on function public.activity_notices_for_activity(uuid, uuid[], timestamptz) from public, anon, authenticated;

-- The scheduled entry point.
create or replace function public.process_activity_change_notices(p_max integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_claimed uuid[];
  v_act uuid;
  v_r jsonb;
  v_sum jsonb := jsonb_build_object('claimed', 0, 'activities', 0, 'messages_for_activities', 0, 'recipients', 0, 'optout', 0, 'superseded', 0, 'identical', 0, 'past', 0, 'never_told', 0, 'failed_activities', 0, 'gave_up', 0, 'throttled', 0);
  v_gave int;
begin
  -- Claim a bounded batch; rows another run holds are skipped, never waited for, so overlapping runs cannot double-send.
  select array_agg(id) into v_claimed from (
    select id from public.activity_change_notices
     where processed_at is null and created_at <= v_now - interval '2 minutes'
     order by created_at
     limit least(greatest(coalesce(p_max, 200), 1), 500)
       for update skip locked) c;
  if v_claimed is null then return v_sum; end if;
  v_sum := jsonb_set(v_sum, '{claimed}', to_jsonb(array_length(v_claimed, 1)));

  for v_act in select distinct activity_id from public.activity_change_notices where id = any (v_claimed) loop
    v_sum := jsonb_set(v_sum, '{activities}', to_jsonb((v_sum ->> 'activities')::int + 1));
    begin
      v_r := public.activity_notices_for_activity(v_act, v_claimed, v_now);
      if (v_r ->> 'recipients')::int + (v_r ->> 'optout')::int > 0 then
        v_sum := jsonb_set(v_sum, '{messages_for_activities}', to_jsonb((v_sum ->> 'messages_for_activities')::int + 1));
      end if;
      v_sum := jsonb_set(v_sum, '{recipients}', to_jsonb((v_sum ->> 'recipients')::int + (v_r ->> 'recipients')::int));
      v_sum := jsonb_set(v_sum, '{optout}', to_jsonb((v_sum ->> 'optout')::int + (v_r ->> 'optout')::int));
      v_sum := jsonb_set(v_sum, '{superseded}', to_jsonb((v_sum ->> 'superseded')::int + (v_r ->> 'superseded')::int));
      v_sum := jsonb_set(v_sum, '{identical}', to_jsonb((v_sum ->> 'identical')::int + (v_r ->> 'identical')::int));
      v_sum := jsonb_set(v_sum, '{past}', to_jsonb((v_sum ->> 'past')::int + (v_r ->> 'past')::int));
      v_sum := jsonb_set(v_sum, '{never_told}', to_jsonb((v_sum ->> 'never_told')::int + (v_r ->> 'never_told')::int));
      v_sum := jsonb_set(v_sum, '{throttled}', to_jsonb((v_sum ->> 'throttled')::int + coalesce((v_r ->> 'throttled')::int, 0)));
    exception when others then
      -- This activity's work is rolled back whole. Record why, keep it queued, and carry on with the others.
      update public.activity_change_notices
         set attempts = attempts + 1, last_error = left(sqlerrm, 300)
       where id = any (v_claimed) and activity_id = v_act and processed_at is null;
      update public.activity_change_notices
         set processed_at = v_now, outcome = 'failed'
       where id = any (v_claimed) and activity_id = v_act and processed_at is null and attempts >= 5;
      get diagnostics v_gave = row_count;
      v_sum := jsonb_set(v_sum, '{failed_activities}', to_jsonb((v_sum ->> 'failed_activities')::int + 1));
      v_sum := jsonb_set(v_sum, '{gave_up}', to_jsonb((v_sum ->> 'gave_up')::int + v_gave));
    end;
  end loop;

  insert into public.activity_notice_runs (summary) values (v_sum);
  delete from public.activity_notice_runs where ran_at < now() - interval '30 days';
  delete from public.activity_change_notices where processed_at < now() - interval '60 days';
  return v_sum;
end;
$$;
revoke all on function public.process_activity_change_notices(integer) from public, anon, authenticated;
grant execute on function public.process_activity_change_notices(integer) to service_role;

-- What staff need to see before and after launch: is it running, is anything stuck.
create or replace function public.admin_activity_notice_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.attribution_staff() then raise exception 'Only OneShetland staff can see notification status' using errcode = '42501'; end if;
  return (select jsonb_build_object(
    'waiting', count(*) filter (where processed_at is null),
    'retrying', count(*) filter (where processed_at is null and attempts > 0),
    'oldest_waiting_seconds', (extract(epoch from now() - min(created_at) filter (where processed_at is null)))::int,
    'delivered_7d', count(*) filter (where outcome = 'delivered' and processed_at > now() - interval '7 days'),
    'failed_7d', count(*) filter (where outcome = 'failed' and processed_at > now() - interval '7 days'),
    'last_error', (select last_error from public.activity_change_notices where last_error is not null order by created_at desc limit 1),
    'last_run', (select max(ran_at) from public.activity_notice_runs),
    'followers', (select count(*) from public.activity_follows))
    from public.activity_change_notices);
end;
$$;
revoke all on function public.admin_activity_notice_status() from public, anon;
grant execute on function public.admin_activity_notice_status() to authenticated;
