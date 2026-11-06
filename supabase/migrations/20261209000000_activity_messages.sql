-- Regular Activities: organiser messages to followers (Notification Centre only: NO push, NO email, no queue, no Edge Function).
--
-- WHAT IT IS. An authorised manager of a published activity writes a short plain-text message and it lands, once, in the Notification Centre of
-- everyone who follows that activity. It reuses what the schedule-change alerts already use: activity_follows (the opt-in), activity_is_public()
-- (published, approved, not paused, owner active), should_notify() (the member's own preferences), and notification_log (the inbox).
--
-- WHY ONE FUNCTION. send_activity_message() does everything in ONE transaction: permission, eligibility, text rules, limits, the message row and the
-- inbox rows. Either all of it commits or none of it does, so a failure can never leave half a send or a spent allowance. One advisory lock
-- (per organiser; an activity has exactly one organiser) makes concurrent sends take turns, so the limits cannot be raced past.
--
-- RULES (proved in supabase/tests/activity-messages.node.test.ts)
--   * WHO: public.can_manage_activity() (business owner; hub owner or committee member; staff for platform activities). Checked inside the function.
--   * WHEN: only an activity that is public right now. A draft, ended, paused, unapproved-hub or inactive-owner activity cannot send.
--   * TEXT: 1 to 500 characters, plain. Links, web addresses, email addresses (any @) and phone numbers are refused. Control characters are stripped.
--   * LIMITS (rolling windows, counted on the ACTIVITY and the ORGANISER, never on the person, so a second manager cannot start a second allowance):
--       1 per activity per hour, 3 per activity per 24 hours, 10 per organiser (business, hub, or OneShetland itself) per 24 hours across all its activities.
--       A refused attempt consumes nothing. Hidden messages still count.
--   * NO DOUBLE SEND: (activity_id, client_request_id) is unique. A retry or double click with the same request id returns the first result and writes nothing.
--     A partial unique index on notification_log (user, message id) for THIS category only is the backstop; it does not touch any other notification type.
--   * RECIPIENTS: followers at the moment of sending. Someone who follows later is not told. Preferences are honoured exactly as for schedule alerts: should_notify(user,
--     'events', urgent) so quiet hours do not hide an inbox item; a member who switched notifications or the Events category off gets a hidden 'skipped_pref' record.
--   * CAP: up to 5,000 followers per message. More than that is REFUSED before anything is written (never a partial send).
--   * PRIVACY: organisers get counts only. activity_follows stays readable only by the follower; nothing returns who received a message.
--   * MODERATION: staff can hide a message from every inbox and restore it. Hiding flips the inbox rows to the existing hidden status 'skipped_pref' (marked
--     error='hidden_by_staff' so a restore only touches those rows). The message row, its text and who hid it and why are kept as the audit record.
--
-- ROLLBACK: drop index notification_log_activity_message_once; drop functions send_activity_message, activity_messaging_status, activity_message_problem,
-- admin_hide_activity_message, admin_restore_activity_message, admin_activity_messages; drop table activity_messages. Inbox rows already delivered stay.

create table if not exists public.activity_messages (
  id                uuid primary key default gen_random_uuid(),
  activity_id       uuid not null references public.regular_activities(id) on delete cascade,
  author_id         uuid references auth.users(id) on delete set null,
  client_request_id uuid not null,
  body              text not null check (char_length(body) between 1 and 500),
  created_at        timestamptz not null default now(),
  followers         integer not null default 0,
  recipients        integer not null default 0,
  opted_out         integer not null default 0,
  hidden_at         timestamptz,
  hidden_by         uuid references auth.users(id) on delete set null,
  hidden_reason     text check (hidden_reason is null or char_length(hidden_reason) <= 300),
  unique (activity_id, client_request_id)
);
create index if not exists idx_am_activity_created on public.activity_messages (activity_id, created_at desc);
create index if not exists idx_am_created on public.activity_messages (created_at);

alter table public.activity_messages enable row level security;
drop policy if exists am_manager_read on public.activity_messages;
create policy am_manager_read on public.activity_messages for select to authenticated using (public.can_manage_activity(activity_id));
revoke all on public.activity_messages from public, anon, authenticated;
-- Managers read the message and its counts. Who wrote it, who hid it and why stay with staff.
grant select (id, activity_id, body, created_at, followers, recipients, opted_out, hidden_at) on public.activity_messages to authenticated;

-- One inbox item per member per message. PARTIAL: it applies to this category only, so no other notification type can ever conflict with it.
create unique index if not exists notification_log_activity_message_once
  on public.notification_log (user_id, (data ->> 'message_id')) where category = 'events.activity_message';

-- The text rules, in one place. Returns the reason a message is refused, or null.
create or replace function public.activity_message_problem(p text)
returns text
language sql
immutable
as $$
  select case
    when p is null or btrim(p, E' \n\t\r') = '' then 'Write a message first.'
    when char_length(p) > 500 then 'Messages can be up to 500 characters.'
    when p ~* '(https?://|ftp://|www\.)' then 'Links are not allowed in messages.'
    when position('@' in p) > 0 then 'Email addresses are not allowed in messages.'
    when p ~* '(^|[^a-z0-9-])[a-z0-9][a-z0-9-]*\.(com|co\.uk|uk|org|net|scot|io|me|ly|info|biz|app|dev|link|gl|xyz|tk|site|online|shop|store|page|tv|eu|ie|us|ca|au|nz|fm|to|cc|ws|top|club|live|news|email|cloud)($|[^a-z0-9])' then 'Web addresses are not allowed in messages.'
    when regexp_replace(p, '[ ()\-]', '', 'g') ~ '\d{7,}' or p ~ '(\+|(^|[^0-9])00)\s?44' or regexp_replace(p, '[ ()\-]', '', 'g') ~ '(^|[^0-9])0[127]\d{8,9}($|[^0-9])'
      then 'Phone numbers are not allowed in messages.'
    else null end
$$;

-- What the composer needs: can I send, if not why, how many follow, when is the next slot. Counts only.
create or replace function public.activity_messaging_status(p_activity uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  a public.regular_activities;
  v_followers int; v_hour timestamptz; v_day3 timestamptz; v_owner_n int; v_day_n int; v_next timestamptz; v_reason text; v_ok boolean;
begin
  if auth.uid() is null or not public.can_manage_activity(p_activity) then raise exception 'You cannot message followers of this activity' using errcode = '42501'; end if;
  select * into a from public.regular_activities where id = p_activity;
  select count(*) into v_followers from public.activity_follows where activity_id = p_activity;
  select max(created_at) into v_hour from public.activity_messages where activity_id = p_activity and created_at > clock_timestamp() - interval '1 hour';
  select count(*), (array_agg(created_at order by created_at desc))[3] into v_day_n, v_day3 from public.activity_messages where activity_id = p_activity and created_at > clock_timestamp() - interval '24 hours';
  select count(*) into v_owner_n from public.activity_messages m join public.regular_activities x on x.id = m.activity_id
   where m.created_at > clock_timestamp() - interval '24 hours'
     and x.organiser_business_id is not distinct from a.organiser_business_id and x.organiser_hub_id is not distinct from a.organiser_hub_id and x.is_platform_activity = a.is_platform_activity;
  v_ok := public.activity_is_public(a);
  v_reason := case
    when v_ok then null
    when a.admin_paused then 'OneShetland has paused this activity, so messages cannot be sent.'
    when a.status <> 'published' then 'Publish this activity before messaging its followers.'
    when a.organiser_hub_id is not null and not a.calendar_approved then 'Your hub is waiting for approval, so messages cannot be sent yet.'
    else 'This activity is not public at the moment, so messages cannot be sent.' end;
  v_next := greatest(coalesce(v_hour + interval '1 hour', '-infinity'), case when v_day_n >= 3 then v_day3 + interval '24 hours' else '-infinity' end);
  return jsonb_build_object('eligible', v_ok, 'reason', v_reason, 'followers', v_followers, 'next_allowed_at', case when v_next > clock_timestamp() then v_next end,
                            'sent_last_24h', v_day_n, 'organiser_sent_last_24h', v_owner_n, 'max_chars', 500, 'follower_cap', 5000);
end;
$$;
revoke all on function public.activity_messaging_status(uuid) from public, anon;
grant execute on function public.activity_messaging_status(uuid) to authenticated;

create or replace function public.send_activity_message(p_activity uuid, p_body text, p_request uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  a public.regular_activities;
  v_body text; v_problem text; v_followers int; v_id uuid; v_recip int; v_opt int; v_now timestamptz;
  v_first timestamptz; v_third timestamptz; v_day_n int; v_owner_n int; v_oldest_owner timestamptz; v_ex public.activity_messages;
  c_cap constant int := 5000;
begin
  if v_uid is null then raise exception 'Please sign in.' using errcode = '42501'; end if;
  if p_request is null then raise exception 'A request id is required' using errcode = '22023'; end if;
  select * into a from public.regular_activities where id = p_activity;
  -- Unknown and not-yours are the same answer, so a draft's existence is never revealed.
  if not found or not public.can_manage_activity(p_activity) then raise exception 'You cannot message followers of this activity' using errcode = '42501'; end if;

  -- Concurrent sends take turns, per organiser. Every activity belongs to exactly one organiser, so this one lock also serialises sends to one activity.
  perform pg_advisory_xact_lock(hashtextextended('activity-message-organiser:' || coalesce('b:' || a.organiser_business_id::text, 'h:' || a.organiser_hub_id::text, 'platform'), 0));

  -- A retry or double click returns the first result and writes nothing.
  select * into v_ex from public.activity_messages where activity_id = p_activity and client_request_id = p_request;
  if found then
    return jsonb_build_object('id', v_ex.id, 'followers', v_ex.followers, 'recipients', v_ex.recipients, 'opted_out', v_ex.opted_out, 'duplicate', true);
  end if;

  if not public.activity_is_public(a) then
    raise exception '%', case when a.admin_paused then 'OneShetland has paused this activity, so messages cannot be sent.'
                              when a.status <> 'published' then 'Publish this activity before messaging its followers.'
                              when a.organiser_hub_id is not null and not a.calendar_approved then 'Your hub is waiting for approval, so messages cannot be sent yet.'
                              else 'This activity is not public at the moment, so messages cannot be sent.' end using errcode = 'P0001', hint = 'not_public';
  end if;

  v_body := regexp_replace(replace(coalesce(p_body, ''), E'\r', ''), '[\x01-\x09\x0b-\x1f\x7f]', '', 'g');
  v_body := btrim(regexp_replace(v_body, E'\n{3,}', E'\n\n', 'g'), E' \n\t');
  v_problem := public.activity_message_problem(v_body);
  if v_problem is not null then raise exception '%', v_problem using errcode = 'P0001', hint = 'bad_text'; end if;

  select count(*) into v_followers from public.activity_follows where activity_id = p_activity;
  if v_followers = 0 then raise exception 'Nobody follows this activity yet, so there is no one to message.' using errcode = 'P0001', hint = 'no_followers'; end if;
  if v_followers > c_cap then
    raise exception 'This activity has more followers than one message can reach (%). Please contact OneShetland.', c_cap using errcode = 'P0001', hint = 'too_many_followers';
  end if;

  v_now := clock_timestamp();
  select max(created_at) into v_first from public.activity_messages where activity_id = p_activity and created_at > v_now - interval '1 hour';
  if v_first is not null then
    raise exception 'You can send one message an hour to the followers of an activity. You can send the next after %.', to_char((v_first + interval '1 hour') at time zone 'Europe/London', 'HH24:MI') using errcode = 'P0001', hint = 'hourly_limit';
  end if;
  select count(*), (array_agg(created_at order by created_at desc))[3] into v_day_n, v_third from public.activity_messages where activity_id = p_activity and created_at > v_now - interval '24 hours';
  if v_day_n >= 3 then
    raise exception 'An activity can send 3 messages in any 24 hours. You can send the next after %.', to_char((v_third + interval '24 hours') at time zone 'Europe/London', 'DD Mon HH24:MI') using errcode = 'P0001', hint = 'daily_limit';
  end if;
  select count(*), min(m.created_at) into v_owner_n, v_oldest_owner from public.activity_messages m join public.regular_activities x on x.id = m.activity_id
   where m.created_at > v_now - interval '24 hours'
     and x.organiser_business_id is not distinct from a.organiser_business_id and x.organiser_hub_id is not distinct from a.organiser_hub_id and x.is_platform_activity = a.is_platform_activity;
  if v_owner_n >= 10 then
    raise exception 'Your organisation can send 10 messages in any 24 hours across all its activities. You can send again after %.', to_char((v_oldest_owner + interval '24 hours') at time zone 'Europe/London', 'DD Mon HH24:MI') using errcode = 'P0001', hint = 'organiser_limit';
  end if;

  insert into public.activity_messages (activity_id, author_id, client_request_id, body, created_at, followers)
  values (p_activity, v_uid, p_request, v_body, v_now, v_followers) returning id into v_id;

  with ins as (
    insert into public.notification_log (user_id, category, title, body, data, status)
    select f.user_id, 'events.activity_message', left(a.title || ': message from the organiser', 200), v_body,
           jsonb_build_object('screen', 'regular-activity', 'activity_id', a.id, 'activity_slug', a.slug, 'message_id', v_id),
           case when public.should_notify(f.user_id, 'events', true) then 'no_token' else 'skipped_pref' end
      from public.activity_follows f where f.activity_id = p_activity
    on conflict (user_id, (data ->> 'message_id')) where category = 'events.activity_message' do nothing
    returning status)
  select count(*) filter (where status = 'no_token'), count(*) filter (where status <> 'no_token') into v_recip, v_opt from ins;
  update public.activity_messages set recipients = v_recip, opted_out = v_opt where id = v_id;
  return jsonb_build_object('id', v_id, 'followers', v_followers, 'recipients', v_recip, 'opted_out', v_opt, 'duplicate', false);
end;
$$;
revoke all on function public.send_activity_message(uuid, text, uuid) from public, anon;
grant execute on function public.send_activity_message(uuid, text, uuid) to authenticated;

-- Staff: see every message (with who wrote and hid it), hide one from every inbox, put it back. The row and its text are never deleted.
create or replace function public.admin_activity_messages(p_activity uuid default null, p_limit integer default 100)
returns table (id uuid, activity_id uuid, activity_title text, activity_slug text, body text, created_at timestamptz, followers int, recipients int, opted_out int,
               author_id uuid, hidden_at timestamptz, hidden_by uuid, hidden_reason text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.attribution_staff() then raise exception 'Only OneShetland staff can see these messages' using errcode = '42501'; end if;
  return query select m.id, m.activity_id, a.title, a.slug, m.body, m.created_at, m.followers, m.recipients, m.opted_out, m.author_id, m.hidden_at, m.hidden_by, m.hidden_reason
    from public.activity_messages m join public.regular_activities a on a.id = m.activity_id
   where p_activity is null or m.activity_id = p_activity
   order by m.created_at desc limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;
revoke all on function public.admin_activity_messages(uuid, integer) from public, anon;
grant execute on function public.admin_activity_messages(uuid, integer) to authenticated;

create or replace function public.admin_hide_activity_message(p_message uuid, p_reason text)
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare n int;
begin
  if not public.attribution_staff() then raise exception 'Only OneShetland staff can hide messages' using errcode = '42501'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'Say why you are hiding it' using errcode = '22023'; end if;
  update public.activity_messages set hidden_at = coalesce(hidden_at, now()), hidden_by = coalesce(hidden_by, auth.uid()), hidden_reason = left(btrim(p_reason), 300) where id = p_message;
  if not found then raise exception 'Message not found' using errcode = 'P0002'; end if;
  update public.notification_log set status = 'skipped_pref', error = 'hidden_by_staff'
   where category = 'events.activity_message' and data ->> 'message_id' = p_message::text and status in ('no_token', 'sent', 'skipped_quiet');
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.admin_hide_activity_message(uuid, text) from public, anon;
grant execute on function public.admin_hide_activity_message(uuid, text) to authenticated;

create or replace function public.admin_restore_activity_message(p_message uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare n int;
begin
  if not public.attribution_staff() then raise exception 'Only OneShetland staff can restore messages' using errcode = '42501'; end if;
  update public.activity_messages set hidden_at = null, hidden_by = null, hidden_reason = null where id = p_message;
  if not found then raise exception 'Message not found' using errcode = 'P0002'; end if;
  update public.notification_log set status = 'no_token', error = null
   where category = 'events.activity_message' and data ->> 'message_id' = p_message::text and status = 'skipped_pref' and error = 'hidden_by_staff';
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.admin_restore_activity_message(uuid) from public, anon;
grant execute on function public.admin_restore_activity_message(uuid) to authenticated;

comment on table public.activity_messages is 'Organiser messages to an activity''s followers (Notification Centre only). Written only by send_activity_message(); managers read counts, staff read everything.';
