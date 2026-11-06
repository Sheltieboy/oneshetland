-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Fetch v2 — Step 8: notifications (docs/FETCH_V2_IMPLEMENTATION.md, Step 8 and section L).
--
-- One outbox, fed only by authoritative server events — never by a client:
--   · matching          fetch_match_notifications rows (Step 7 selection; now called automatically when a job is created or
--                       returns to the board)
--   · job lifecycle     fetch_request_events rows (Steps 3–5)
--   · verification      driver_verification_events rows with a notify_kind (Step 6)
--   · issues            fetch_issues opened / resolved
-- Each producer is an AFTER INSERT trigger on its own append-only table; a failure there is caught and can never undo the
-- Fetch action that caused it.
--
-- NOTIFICATION CENTRE FIRST. The existing inbox is public.notification_log (one row per notification; the clients — iOS build
-- 148 included — show rows whose status is sent / no_token / skipped_quiet). For every eligible notice the drain writes that inbox
-- row FIRST, with a visible status, and only then is a push attempted; the row becomes 'sent' only if Expo accepted the push.
-- A push that is not sent, fails or is refused never removes the inbox row. The single exception is an OPPORTUNITY a member has
-- muted (Fetch notifications off, or all notifications off): that is written as 'skipped_pref', the existing "you chose not to hear
-- about this" status the inbox hides — the same rule every other OneShetland module follows.
--
-- Push policy: should_notify(user, 'fetch', urgent) — the existing preference + quiet-hours check. Only four narrow time-critical
-- notices pass quiet hours (payment action needed, cancellation requested, could not deliver, verification blocking a collection);
-- none passes a member's opt-out. Opportunities never pass quiet hours and have their own hourly/daily push ceiling.
--
-- Nothing here sends. The edge function's drain (fetch-v2-runner) claims rows, pushes through Expo and settles the result.
-- Rollback: supabase/rollbacks/20261222000000_fetch_v2_notifications.down.sql
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
begin;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 0. Configuration and the outbox
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
insert into public.admin_config (key, value, category, description, is_secret) values
  ('fetch.notify.opportunity_hourly_max', '3', 'fetch', 'Fetch v2: at most this many new-job pushes per driver per hour (more still reach the inbox).', false),
  ('fetch.notify.opportunity_daily_max',  '8', 'fetch', 'Fetch v2: at most this many new-job pushes per driver per day (more still reach the inbox).', false),
  ('fetch.notify.max_push_attempts',      '4', 'fetch', 'Fetch v2: retryable push failures are retried up to this many attempts in all.', false)
on conflict (key) do nothing;

create table if not exists public.fetch_notifications (
  id             bigserial primary key,
  dedupe_key     text not null unique check (char_length(dedupe_key) between 3 and 200),
  recipient_id   uuid not null references public.profiles (id) on delete cascade,
  request_id     uuid references public.delivery_requests (id) on delete cascade,
  kind           text not null check (kind in (
                   'new_request_run', 'new_request_area', 'new_request_broad', 'back_on_board',
                   'driver_accepted', 'payment_action_needed', 'payment_ready', 'payment_not_completed', 'job_released_payment',
                   'driver_released', 'returned_to_board_requester', 'returned_to_board_driver', 'cancel_requested',
                   'cancellation_agreed', 'cancellation_declined', 'cancellation_kept', 'job_cancelled', 'expired', 'collected',
                   'delivered', 'undeliverable', 'return_resolved', 'issue_resolved', 'verification_blocks_collection',
                   'evidence_approved', 'evidence_expiring', 'evidence_expired', 'evidence_rejected', 'replacement_required', 'driver_approved',
                   'driver_rejected', 'driver_suspended', 'driver_reinstated',
                   'admin_review', 'admin_issue', 'admin_payment', 'admin_cancel_review', 'admin_undeliverable',
                   'message')),
  audience       text not null check (audience in ('opportunity', 'activity', 'verification', 'admin')),
  time_critical  boolean not null default false,
  category       text not null check (category ~ '^fetch\.[a-z_]{2,40}$'),
  title          text not null check (char_length(title) between 3 and 80),
  body           text not null check (char_length(body) between 3 and 200),
  data           jsonb not null check (jsonb_typeof(data) = 'object'),
  source         text not null check (source in ('match', 'request_event', 'verification_event', 'issue')),
  source_id      text not null,
  state          text not null default 'pending' check (state in ('pending', 'inbox_created', 'completed', 'failed')),
  inbox_id       uuid,
  inbox_status   text check (inbox_status is null or inbox_status in ('sent', 'no_token', 'skipped_quiet', 'skipped_pref')),
  push_result    text check (push_result is null or push_result in ('accepted', 'no_token', 'opted_out', 'quiet_hours', 'rate_limited',
                   'provider_error', 'invalid_token', 'push_unavailable', 'job_closed')),
  push_due_at    timestamptz,
  claimed_at     timestamptz,
  attempts       integer not null default 0 check (attempts >= 0),
  last_error     text check (last_error is null or char_length(last_error) <= 300),
  created_at     timestamptz not null default now(),
  inbox_at       timestamptz,
  completed_at   timestamptz,
  check (not (audience = 'opportunity' and time_critical)),
  check (state = 'pending' or inbox_id is not null or push_result = 'job_closed' or state = 'failed'),
  check ((state = 'completed') = (completed_at is not null))
);
create index if not exists fetch_notifications_due_idx on public.fetch_notifications (id) where state in ('pending', 'inbox_created');
create index if not exists fetch_notifications_recipient_idx on public.fetch_notifications (recipient_id, created_at);
create index if not exists fetch_notifications_request_idx on public.fetch_notifications (request_id) where request_id is not null;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. What each kind is: audience, urgency, category, where it opens
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_notice_meta(p_kind text)
  returns table (audience text, time_critical boolean, category text, route_kind text)
  language sql immutable set search_path = public, pg_temp
as $$
  select v.audience, v.time_critical, v.category, v.route_kind from (values
    ('new_request_run',               'opportunity',  false, 'fetch.request_on_route',     'board'),
    ('new_request_area',              'opportunity',  false, 'fetch.new_request',          'board'),
    ('new_request_broad',             'opportunity',  false, 'fetch.new_request',          'board'),
    ('back_on_board',                 'opportunity',  false, 'fetch.released',             'board'),
    ('driver_accepted',               'activity',     false, 'fetch.driver_matched',       'request'),
    ('payment_action_needed',         'activity',     true,  'fetch.payment_needed',       'payment'),
    ('payment_ready',                 'activity',     false, 'fetch.payment_ready',        'job'),
    ('payment_not_completed',         'activity',     false, 'fetch.released',             'request'),
    ('job_released_payment',          'activity',     false, 'fetch.released',             'job'),
    ('driver_released',               'activity',     false, 'fetch.released',             'request'),
    ('returned_to_board_requester',   'activity',     false, 'fetch.released',             'request'),
    ('returned_to_board_driver',      'activity',     false, 'fetch.released',             'job'),
    ('cancel_requested',              'activity',     true,  'fetch.cancel_requested',     'job'),
    ('cancellation_agreed',           'activity',     false, 'fetch.cancel_resolved',      'request'),
    ('cancellation_declined',         'activity',     false, 'fetch.cancel_resolved',      'request'),
    ('cancellation_kept',             'activity',     false, 'fetch.cancel_resolved',      'party'),
    ('job_cancelled',                 'activity',     false, 'fetch.cancel_resolved',      'party'),
    ('expired',                       'activity',     false, 'fetch.expired',              'request'),
    ('collected',                     'activity',     false, 'fetch.collected',            'request'),
    ('delivered',                     'activity',     false, 'fetch.delivered',            'request'),
    ('undeliverable',                 'activity',     true,  'fetch.undeliverable',        'request'),
    ('return_resolved',               'activity',     false, 'fetch.returned',             'party'),
    ('issue_resolved',                'activity',     false, 'fetch.issue',                'party'),
    ('verification_blocks_collection','activity',     true,  'fetch.driver_verification',  'verification'),
    ('evidence_approved',             'verification', false, 'fetch.driver_verification',  'verification'),
    ('evidence_expiring',             'verification', false, 'fetch.driver_verification',  'verification'),
    ('evidence_expired',              'verification', false, 'fetch.driver_verification',  'verification'),
    ('evidence_rejected',             'verification', false, 'fetch.driver_verification',  'verification'),
    ('replacement_required',          'verification', false, 'fetch.driver_verification',  'verification'),
    ('driver_approved',               'verification', false, 'fetch.driver_decision',      'verification'),
    ('driver_rejected',               'verification', false, 'fetch.driver_decision',      'verification'),
    ('driver_suspended',              'verification', false, 'fetch.driver_decision',      'verification'),
    ('driver_reinstated',             'verification', false, 'fetch.driver_decision',      'verification'),
    ('admin_review',                  'admin',        false, 'fetch.admin_review',         'admin_driver'),
    ('admin_issue',                   'admin',        false, 'fetch.admin_review',         'admin_request'),
    ('admin_payment',                 'admin',        false, 'fetch.admin_review',         'admin_request'),
    ('admin_cancel_review',           'admin',        false, 'fetch.admin_review',         'admin_request'),
    ('admin_undeliverable',           'admin',        false, 'fetch.admin_review',         'admin_request'),
    ('message',                       'activity',     false, 'fetch.message',              'party')
  ) v(kind, audience, time_critical, category, route_kind) where v.kind = p_kind;
$$;

-- The words. Short and calm; only region names, a day, a size word and a destination region. Never an address, phone number,
-- access note, item description, payment detail or anything from a verification document.
create or replace function public.fetch_v2_notice_copy(p_kind text, p_request uuid, p_recipient uuid, p_extra jsonb default '{}')
  returns table (title text, body text)
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  r       public.delivery_requests;
  v_from  text;
  v_to    text;
  v_size  text;
  v_route text;
  v_day   text;
begin
  if p_request is not null then
    select * into r from public.delivery_requests where id = p_request;
    select name into v_from from public.regions where id = r.pickup_region_id;
    select name into v_to from public.regions where id = r.destination_region_id;
  end if;
  v_size  := case r.size_class when 'small' then 'small item' when 'medium' then 'medium item' when 'large' then 'large item'
                               when 'bulky' then 'bulky item' else 'item' end;
  v_route := coalesce(v_from, 'Shetland') || ' → ' || coalesce(v_to, 'Shetland');
  v_day   := coalesce(p_extra ->> 'day', 'upcoming');

  return query select v.t, v.b from (values
    ('new_request_run',   'A Fetch fits your ' || v_day || ' journey', v_route || ', ' || v_size || '. Have a look if it suits you.'),
    ('new_request_area',  'A new Fetch in your area', v_route || ', ' || v_size || '. Have a look if it suits you.'),
    ('new_request_broad', 'A new Fetch needs a driver', v_route || ', ' || v_size || '. Have a look if it suits you.'),
    ('back_on_board',     'A Fetch needs a driver again', v_route || ', ' || v_size || '. Have a look if it suits you.'),
    ('driver_accepted',   'Someone has accepted your Fetch', 'Your Fetch to ' || coalesce(v_to, 'its destination') || ' has a driver.'),
    ('payment_action_needed', 'Payment needs your attention', 'Please confirm payment within 2 hours so your driver can collect.'),
    ('payment_ready',     'You''re ready to collect', 'Payment for the Fetch to ' || coalesce(v_to, 'its destination') || ' is confirmed.'),
    ('payment_not_completed', 'Your Fetch is back on the board', 'Payment wasn''t completed in time, so another driver can take it.'),
    ('job_released_payment', 'This Fetch has been released', 'Payment wasn''t completed in time, so the job has gone back on the board.'),
    ('driver_released',   'Your driver can''t do this Fetch', 'It''s back on the board for another driver.'),
    ('returned_to_board_requester', 'Your Fetch is back on the board', 'OneShetland has returned it to the board for another driver.'),
    ('returned_to_board_driver', 'A Fetch was taken off your list', 'OneShetland has returned it to the board.'),
    ('cancel_requested',  'The requester has asked to cancel', 'Please agree or decline in the app.'),
    ('cancellation_agreed', 'Your cancellation was agreed', 'The Fetch is cancelled and any payment hold is released.'),
    ('cancellation_declined', 'Your driver would like to continue', 'They declined the cancellation. OneShetland can help if needed.'),
    ('cancellation_kept', 'The Fetch goes ahead', 'OneShetland reviewed the cancellation request and kept the job.'),
    ('job_cancelled',     'This Fetch has been cancelled', 'Open the app for the details.'),
    ('expired',           'No driver took your Fetch in time', 'You can post it again whenever you like.'),
    ('collected',         'Your item has been collected', 'It''s on its way to ' || coalesce(v_to, 'its destination') || '.'),
    ('delivered',         'Your Fetch has been delivered', 'Thank you for using Fetch.'),
    ('undeliverable',     'Your Fetch could not be delivered', 'Please open the app to see what happens next.'),
    ('return_resolved',   'A returned Fetch has been sorted', 'Open the app for the details.'),
    ('issue_resolved',    'Your reported problem has been resolved', 'Open the app for the details.'),
    ('verification_blocks_collection', 'Your driver verification needs updating', 'You can''t collect your next Fetch until it is updated.'),
    ('evidence_approved', 'A driver document was accepted', 'Thank you. Open the app to see what else is needed.'),
    ('evidence_expiring', 'A driver document expires soon', 'Please upload a renewed copy to keep driving for Fetch.'),
    ('evidence_expired',  'A driver document has expired', 'Upload a renewed copy to take new Fetches.'),
    ('evidence_rejected', 'Your driver verification needs updating', 'A document couldn''t be accepted. Open the app to see why.'),
    ('replacement_required', 'Your driver verification needs updating', 'Please upload a new document. Open the app to see which.'),
    ('driver_approved',   'You''re approved to drive for Fetch', 'You can now take Fetches that fit your journeys.'),
    ('driver_rejected',   'Your driver application wasn''t approved', 'Open the app to see why.'),
    ('driver_suspended',  'Your Fetch driver account is paused', 'Open the app for the details.'),
    ('driver_reinstated', 'Your Fetch driver account is active again', 'You can take new Fetches again.'),
    ('admin_review',      'Driver verification to review', 'A driver has applied or handed in evidence.'),
    ('admin_issue',       'A Fetch needs attention', 'A problem has been reported on a Fetch.'),
    ('admin_payment',     'A Fetch payment needs attention', 'A payment on a Fetch needs a decision.'),
    ('admin_cancel_review', 'A cancellation needs a decision', 'A driver has not answered a cancellation request in time.'),
    ('admin_undeliverable', 'A Fetch could not be delivered', 'A driver could not deliver an item. It needs a return decision.'),
    ('message',           'New message about your Fetch', 'Open the app to read it.')
  ) v(k, t, b) where v.k = p_kind;
end;
$$;

create or replace function public.fetch_v2_notice_route(p_route_kind text, p_request uuid, p_recipient uuid) returns text
  language sql stable security definer set search_path = public, pg_temp
as $$
  select case p_route_kind
    when 'board'         then '/fetch/board/' || p_request
    when 'request'       then '/fetch/requests/' || p_request
    when 'payment'       then '/fetch/requests/' || p_request || '/payment'
    when 'job'           then '/fetch/jobs/' || p_request
    when 'party'         then case when exists (select 1 from public.delivery_requests where id = p_request and customer_id = p_recipient)
                                   then '/fetch/requests/' || p_request else '/fetch/jobs/' || p_request end
    when 'verification'  then '/fetch/driver/verification'
    when 'admin_request' then '/admin/fetch/requests/' || p_request
    when 'admin_driver'  then '/admin/fetch/drivers/' || p_recipient
  end;
$$;

-- Queue one notice. Idempotent on its key; text, link and urgency are always the server's.
create or replace function public.fetch_v2_enqueue_notice(p_key text, p_recipient uuid, p_request uuid, p_kind text, p_source text,
                                                          p_source_id text, p_extra jsonb default '{}')
  returns boolean
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  m  record;
  c  record;
  v_route text;
  v_n integer;
begin
  if p_recipient is null then return false; end if;
  select * into m from public.fetch_v2_notice_meta(p_kind);
  if m.audience is null then raise exception 'unknown Fetch notice %', p_kind; end if;
  select * into c from public.fetch_v2_notice_copy(p_kind, p_request, p_recipient, p_extra);
  v_route := public.fetch_v2_notice_route(m.route_kind,
               p_request, case when m.route_kind = 'admin_driver' then (p_extra ->> 'driver_id')::uuid else p_recipient end);
  insert into public.fetch_notifications (dedupe_key, recipient_id, request_id, kind, audience, time_critical, category, title, body,
                                          data, source, source_id)
  values (p_key, p_recipient, p_request, p_kind, m.audience, m.time_critical, m.category, c.title, c.body,
          jsonb_strip_nulls(jsonb_build_object('screen', 'fetch', 'route', v_route, 'kind', p_kind, 'request_id', p_request)),
          p_source, p_source_id)
  on conflict (dedupe_key) do nothing;
  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;

create or replace function public.fetch_v2_admin_ids() returns setof uuid
  language sql stable security definer set search_path = public, pg_temp
as $$ select id from public.profiles where role = 'admin' or is_platform_owner order by id; $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. Producers (AFTER INSERT triggers). A failure is logged and swallowed: a notice can never undo a Fetch action.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- Matching: one notice per Step 7 selection row.
create or replace function public.tg_fetch_v2_notice_from_match() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_day text;
  v_run uuid;
begin
  begin
    if new.tier = 'run' then
      v_run := public.fetch_v2_best_run(new.driver_id, new.request_id);
      select to_char(ru.departure_start at time zone 'Europe/London', 'FMDay') into v_day from public.runs ru where ru.id = v_run;
    end if;
    perform public.fetch_v2_enqueue_notice('match:' || new.kind || ':' || new.request_id || ':' || new.driver_id, new.driver_id, new.request_id,
      case when new.kind = 'back_on_board' then 'back_on_board' else 'new_request_' || new.tier end,
      'match', new.id::text, jsonb_build_object('day', v_day));
  exception when others then
    raise warning 'Fetch notice (match %) not queued: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

-- Job lifecycle.
create or replace function public.tg_fetch_v2_notice_from_event() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r     public.delivery_requests;
  v_gen text := coalesce(new.metadata ->> 'generation', '1');
  v_rel uuid;
  a     uuid;
  k     text := 'ev:' || new.id || ':';
begin
  begin
    select * into r from public.delivery_requests where id = new.request_id and fetch_version = 2;
    if r.id is null then return null; end if;
    v_rel := case when new.metadata ->> 'released_driver' ~ '^[0-9a-f-]{36}$' then (new.metadata ->> 'released_driver')::uuid end;

    case new.event
      when 'created' then
        perform 1 from public.fetch_v2_select_recipients(r.id, 'new_request');
      when 'claimed' then
        perform public.fetch_v2_enqueue_notice(k || 'r', r.customer_id, r.id, 'driver_accepted', 'request_event', new.id::text);
      when 'payment_requires_action', 'payment_requires_payment_method' then
        perform public.fetch_v2_enqueue_notice('pay:' || r.id || ':g' || v_gen || ':action', r.customer_id, r.id, 'payment_action_needed', 'request_event', new.id::text);
      when 'payment_authorised' then
        -- Only after the requester had to act, and only when the hold really is ready to collect against.
        if r.status = 'matched' and r.driver_id is not null
           and exists (select 1 from public.fetch_notifications n where n.dedupe_key = 'pay:' || r.id || ':g' || v_gen || ':action')
           and coalesce((select h.ok from public.fetch_v2_hold_ready(r.id) h), false) then
          perform public.fetch_v2_enqueue_notice('pay:' || r.id || ':g' || v_gen || ':ready', r.driver_id, r.id, 'payment_ready', 'request_event', new.id::text);
        end if;
      when 'payment_timeout' then
        perform public.fetch_v2_enqueue_notice(k || 'r', r.customer_id, r.id, 'payment_not_completed', 'request_event', new.id::text);
        perform public.fetch_v2_enqueue_notice(k || 'd', v_rel, r.id, 'job_released_payment', 'request_event', new.id::text);
        perform 1 from public.fetch_v2_select_recipients(r.id, 'back_on_board');
      when 'released' then
        perform public.fetch_v2_enqueue_notice(k || 'r', r.customer_id, r.id, 'driver_released', 'request_event', new.id::text);
        perform 1 from public.fetch_v2_select_recipients(r.id, 'back_on_board');
      when 'returned_to_board' then
        perform public.fetch_v2_enqueue_notice(k || 'r', r.customer_id, r.id, 'returned_to_board_requester', 'request_event', new.id::text);
        perform public.fetch_v2_enqueue_notice(k || 'd', v_rel, r.id, 'returned_to_board_driver', 'request_event', new.id::text);
        perform 1 from public.fetch_v2_select_recipients(r.id, 'back_on_board');
      when 'cancellation_requested' then
        perform public.fetch_v2_enqueue_notice(k || 'd', r.driver_id, r.id, 'cancel_requested', 'request_event', new.id::text);
      when 'cancellation_agreed' then
        perform public.fetch_v2_enqueue_notice(k || 'r', r.customer_id, r.id, 'cancellation_agreed', 'request_event', new.id::text);
      when 'cancellation_declined' then
        perform public.fetch_v2_enqueue_notice(k || 'r', r.customer_id, r.id, 'cancellation_declined', 'request_event', new.id::text);
      when 'cancellation_escalated' then
        for a in select * from public.fetch_v2_admin_ids() loop
          perform public.fetch_v2_enqueue_notice(k || a, a, r.id, 'admin_cancel_review', 'request_event', new.id::text);
        end loop;
      when 'cancellation_resolved', 'admin_cancelled' then
        perform public.fetch_v2_enqueue_notice(k || 'r', r.customer_id, r.id,
          case when new.to_status = 'cancelled' then 'job_cancelled' else 'cancellation_kept' end, 'request_event', new.id::text);
        perform public.fetch_v2_enqueue_notice(k || 'd', r.driver_id, r.id,
          case when new.to_status = 'cancelled' then 'job_cancelled' else 'cancellation_kept' end, 'request_event', new.id::text);
      when 'expired' then
        perform public.fetch_v2_enqueue_notice(k || 'r', r.customer_id, r.id, 'expired', 'request_event', new.id::text);
      when 'collected' then
        perform public.fetch_v2_enqueue_notice(k || 'r', r.customer_id, r.id, 'collected', 'request_event', new.id::text);
      when 'delivered' then
        perform public.fetch_v2_enqueue_notice(k || 'r', r.customer_id, r.id, 'delivered', 'request_event', new.id::text);
      when 'undeliverable' then
        perform public.fetch_v2_enqueue_notice(k || 'r', r.customer_id, r.id, 'undeliverable', 'request_event', new.id::text);
        for a in select * from public.fetch_v2_admin_ids() loop
          perform public.fetch_v2_enqueue_notice(k || a, a, r.id, 'admin_undeliverable', 'request_event', new.id::text);
        end loop;
      when 'return_resolved' then
        perform public.fetch_v2_enqueue_notice(k || 'r', r.customer_id, r.id, 'return_resolved', 'request_event', new.id::text);
        perform public.fetch_v2_enqueue_notice(k || 'd', r.driver_id, r.id, 'return_resolved', 'request_event', new.id::text);
      when 'payment_escalated' then
        for a in select * from public.fetch_v2_admin_ids() loop
          perform public.fetch_v2_enqueue_notice(k || a, a, r.id, 'admin_payment', 'request_event', new.id::text);
        end loop;
      else
        null;   -- arrived, ready_confirmed, extended, cancelled by the requester, hold rotation, captures…: no one needs telling
    end case;
  exception when others then
    raise warning 'Fetch notice (event %) not queued: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

-- Driver verification: Step 6's notify_kind events, each accepted document, and a once-a-day review nudge to administrators.
create or replace function public.tg_fetch_v2_notice_from_verification() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  a uuid;
begin
  begin
    if new.notify_kind is not null and new.driver_id is not null then
      perform public.fetch_v2_enqueue_notice(
        case when new.notify_kind in ('evidence_expiring', 'evidence_expired') and new.item_id is not null
             then 'verif:' || new.notify_kind || ':' || new.item_id else 'verif:' || new.id end,
        new.driver_id, null, new.notify_kind, 'verification_event', new.id::text);
    end if;
    if new.event = 'evidence_approved' and new.driver_id is not null then
      perform public.fetch_v2_enqueue_notice('verif:' || new.id, new.driver_id, null, 'evidence_approved', 'verification_event', new.id::text);
    end if;
    if new.event in ('application_submitted', 'application_resubmitted', 'evidence_submitted', 'evidence_replaced') and new.driver_id is not null then
      for a in select x from public.fetch_v2_admin_ids() x where x <> new.driver_id loop
        perform public.fetch_v2_enqueue_notice('admin_review:' || new.driver_id || ':' || (now() at time zone 'Europe/London')::date || ':' || a,
          a, null, 'admin_review', 'verification_event', new.id::text, jsonb_build_object('driver_id', new.driver_id));
      end loop;
    end if;
  exception when others then
    raise warning 'Fetch notice (verification %) not queued: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

-- Issues: administrators hear about every open issue; a verification problem before collection is also the driver's; a resolved
-- issue is told to the member who reported it.
create or replace function public.tg_fetch_v2_notice_from_issue() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r public.delivery_requests;
  a uuid;
begin
  begin
    select * into r from public.delivery_requests where id = new.request_id and fetch_version = 2;
    if r.id is null then return null; end if;
    if tg_op = 'INSERT' and new.status = 'open' then
      if new.kind <> 'payment' then   -- payment escalations are already announced by their payment_escalated event
        for a in select * from public.fetch_v2_admin_ids() loop
          perform public.fetch_v2_enqueue_notice('issue:' || new.id || ':open:' || a, a, r.id, 'admin_issue', 'issue', new.id::text);
        end loop;
      end if;
      if new.kind = 'driver_verification' and r.status = 'matched' and r.driver_id is not null then
        perform public.fetch_v2_enqueue_notice('issue:' || new.id || ':driver', r.driver_id, r.id, 'verification_blocks_collection', 'issue', new.id::text);
      end if;
    elsif tg_op = 'UPDATE' and old.status = 'open' and new.status = 'resolved' and new.reporter_id is not null
          and new.reporter_role in ('requester', 'driver') then
      perform public.fetch_v2_enqueue_notice('issue:' || new.id || ':resolved', new.reporter_id, r.id, 'issue_resolved', 'issue', new.id::text);
    end if;
  exception when others then
    raise warning 'Fetch notice (issue %) not queued: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists fetch_v2_notice_from_match on public.fetch_match_notifications;
create trigger fetch_v2_notice_from_match after insert on public.fetch_match_notifications
  for each row execute function public.tg_fetch_v2_notice_from_match();
drop trigger if exists fetch_v2_notice_from_event on public.fetch_request_events;
create trigger fetch_v2_notice_from_event after insert on public.fetch_request_events
  for each row execute function public.tg_fetch_v2_notice_from_event();
drop trigger if exists fetch_v2_notice_from_verification on public.driver_verification_events;
create trigger fetch_v2_notice_from_verification after insert on public.driver_verification_events
  for each row execute function public.tg_fetch_v2_notice_from_verification();
drop trigger if exists fetch_v2_notice_from_issue on public.fetch_issues;
create trigger fetch_v2_notice_from_issue after insert or update of status on public.fetch_issues
  for each row execute function public.tg_fetch_v2_notice_from_issue();

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. The drain: inbox first, then claim pushes; then settle
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- 'allowed', 'opted_out' (all notifications off, or Fetch off) or 'quiet_hours' — from the existing should_notify.
create or replace function public.fetch_v2_push_decision(p_user uuid, p_time_critical boolean) returns text
  language sql stable security definer set search_path = public, pg_temp
as $$
  select case when not public.should_notify(p_user, 'fetch', true) then 'opted_out'
              when not public.should_notify(p_user, 'fetch', p_time_critical) then 'quiet_hours'
              else 'allowed' end;
$$;

create or replace function public.fetch_v2_cfg_int(p_key text, p_default integer) returns integer
  language sql stable security definer set search_path = public, pg_temp
as $$ select coalesce((select btrim(value)::integer from public.admin_config where key = p_key and value ~ '^\s*[0-9]{1,6}\s*$'), p_default); $$;

-- Writes every pending notice's inbox row (or closes it), then leases up to p_limit pushes that are due. Repeat-safe: a notice's
-- inbox row is written exactly once (state moves on in the same statement), and a leased push is re-offered only after 5 minutes.
create or replace function public.fetch_v2_claim_notifications(p_limit integer default 50)
  returns table (notification_id bigint, recipient_id uuid, category text, title text, body text, data jsonb)
  language plpgsql security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  n        public.fetch_notifications;
  v_dec    text;
  v_status text;
  v_err    text;
  v_inbox  uuid;
  v_hour   integer := public.fetch_v2_cfg_int('fetch.notify.opportunity_hourly_max', 3);
  v_day    integer := public.fetch_v2_cfg_int('fetch.notify.opportunity_daily_max', 8);
begin
  for n in select * from public.fetch_notifications where state = 'pending' order by id limit greatest(p_limit, 1) * 4
           for update skip locked loop
    -- An opportunity that is no longer one (taken, cancelled, expired, or the driver can no longer take it) is dropped quietly.
    if n.audience = 'opportunity' and (
         not exists (select 1 from public.delivery_requests d where d.id = n.request_id and d.status = 'pending' and d.driver_id is null
                                                              and (d.expires_at is null or d.expires_at > now()))
         or public.fetch_v2_driver_eligibility_problem(n.recipient_id) is not null) then
      update public.fetch_notifications set state = 'completed', push_result = 'job_closed', completed_at = now() where id = n.id;
      continue;
    end if;

    v_dec := public.fetch_v2_push_decision(n.recipient_id, n.time_critical);
    if v_dec = 'allowed' and n.audience = 'opportunity'
       and ((select count(*) from public.fetch_notifications x where x.recipient_id = n.recipient_id and x.audience = 'opportunity'
              and x.push_result = 'accepted' and x.completed_at > now() - interval '1 hour') >= v_hour
         or (select count(*) from public.fetch_notifications x where x.recipient_id = n.recipient_id and x.audience = 'opportunity'
              and x.push_result = 'accepted' and x.completed_at > now() - interval '1 day') >= v_day) then
      v_dec := 'rate_limited';
    end if;

    -- The inbox status: visible unless the member muted an opportunity.
    v_status := case when v_dec = 'quiet_hours' then 'skipped_quiet'
                     when v_dec = 'opted_out' and n.audience = 'opportunity' then 'skipped_pref'
                     else 'no_token' end;
    v_err    := case v_dec when 'allowed' then 'push_pending' when 'opted_out' then 'push_off' when 'rate_limited' then 'opportunity_limit' end;
    insert into public.notification_log (user_id, category, title, body, data, status, error)
    values (n.recipient_id, n.category, n.title, n.body, n.data, v_status, v_err)
    returning id into v_inbox;

    if v_dec = 'allowed' then
      update public.fetch_notifications set state = 'inbox_created', inbox_id = v_inbox, inbox_status = v_status, inbox_at = now(),
             push_due_at = now() where id = n.id;
    else
      update public.fetch_notifications set state = 'completed', inbox_id = v_inbox, inbox_status = v_status, inbox_at = now(),
             push_result = v_dec, completed_at = now() where id = n.id;
    end if;
  end loop;

  return query
  with due as (
    select f.id from public.fetch_notifications f
     where f.state = 'inbox_created' and f.push_due_at <= now() and (f.claimed_at is null or f.claimed_at < now() - interval '5 minutes')
     order by f.push_due_at, f.id limit greatest(p_limit, 1) for update skip locked),
  leased as (
    update public.fetch_notifications f set claimed_at = now(), attempts = f.attempts + 1
      from due where f.id = due.id
    returning f.id, f.recipient_id, f.category, f.title, f.body, f.data)
  select * from leased order by 1;
end;
$$;

-- The push outcome for one leased notice. 'accepted' means Expo accepted it — never "delivered".
create or replace function public.fetch_v2_settle_notification(p_id bigint, p_result text, p_error text default null) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  n     public.fetch_notifications;
  v_max integer := public.fetch_v2_cfg_int('fetch.notify.max_push_attempts', 4);
  v_res text;
begin
  if p_result not in ('accepted', 'no_token', 'provider_error_retryable', 'provider_error', 'invalid_token', 'push_unavailable') then
    raise exception 'unknown push result %', p_result;
  end if;
  select * into n from public.fetch_notifications where id = p_id for update;
  if n.id is null then return public.fetch_v2_refuse('not_found'); end if;
  if n.state <> 'inbox_created' then return jsonb_build_object('ok', true, 'already', true, 'state', n.state); end if;

  if p_result = 'provider_error_retryable' and n.attempts < v_max then
    update public.fetch_notifications
       set claimed_at = null, push_due_at = now() + make_interval(mins => 5 * n.attempts * n.attempts), last_error = left(p_error, 300)
     where id = n.id;
    return jsonb_build_object('ok', true, 'state', 'inbox_created', 'retry', true);
  end if;

  v_res := case p_result when 'provider_error_retryable' then 'provider_error' else p_result end;
  update public.fetch_notifications
     set state = 'completed', push_result = v_res, completed_at = now(), last_error = left(p_error, 300)
   where id = n.id;
  -- The inbox row stays; only its status and reason change. 'sent' = Expo accepted the push.
  update public.notification_log
     set status = case when v_res = 'accepted' then 'sent' else 'no_token' end,
         error  = case when v_res = 'accepted' then null else v_res end
   where id = n.inbox_id;
  -- Producers learn their notice went out.
  if n.source = 'match' then
    update public.fetch_match_notifications set notified_at = coalesce(notified_at, now()) where id = n.source_id::bigint;
  elsif n.source = 'verification_event' then
    update public.driver_verification_events set notified_at = now() where id = n.source_id::bigint and notified_at is null;
  end if;
  return jsonb_build_object('ok', true, 'state', 'completed', 'push_result', v_res);
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. Operations view (administrators): what was queued, written, pushed or skipped, and why. Never "delivered".
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_notification_diagnostics(p_request uuid default null, p_recipient uuid default null) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then raise exception 'Only an administrator can do that' using errcode = '42501'; end if;
  if p_request is null and p_recipient is null then return public.fetch_v2_refuse('invalid_request'); end if;
  return jsonb_build_object('ok', true, 'notices', coalesce((
    select jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'audience', n.audience, 'time_critical', n.time_critical,
             'recipient_id', n.recipient_id, 'request_id', n.request_id, 'state', n.state, 'inbox', n.inbox_status,
             'push', coalesce(n.push_result, case when n.state = 'inbox_created' then 'pending' end), 'attempts', n.attempts,
             'last_error', n.last_error, 'created_at', n.created_at, 'inbox_at', n.inbox_at, 'completed_at', n.completed_at) order by n.id)
      from public.fetch_notifications n
     where (p_request is null or n.request_id = p_request) and (p_recipient is null or n.recipient_id = p_recipient)), '[]'));
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 5. Grants
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
alter table public.fetch_notifications enable row level security;
revoke all on public.fetch_notifications from public, anon, authenticated;
grant all on public.fetch_notifications to service_role;
grant usage on sequence public.fetch_notifications_id_seq to service_role;

revoke all on function
  public.fetch_v2_notice_meta(text), public.fetch_v2_notice_copy(text, uuid, uuid, jsonb), public.fetch_v2_notice_route(text, uuid, uuid),
  public.fetch_v2_enqueue_notice(text, uuid, uuid, text, text, text, jsonb), public.fetch_v2_admin_ids(),
  public.tg_fetch_v2_notice_from_match(), public.tg_fetch_v2_notice_from_event(), public.tg_fetch_v2_notice_from_verification(),
  public.tg_fetch_v2_notice_from_issue(), public.fetch_v2_push_decision(uuid, boolean), public.fetch_v2_cfg_int(text, integer),
  public.fetch_v2_claim_notifications(integer), public.fetch_v2_settle_notification(bigint, text, text),
  public.fetch_v2_notification_diagnostics(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.fetch_v2_claim_notifications(integer), public.fetch_v2_settle_notification(bigint, text, text)
  to service_role;
grant execute on function public.fetch_v2_notification_diagnostics(uuid, uuid) to authenticated, service_role;

do $$
begin
  if has_function_privilege('authenticated', 'public.fetch_v2_enqueue_notice(text, uuid, uuid, text, text, text, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.fetch_v2_claim_notifications(integer)', 'execute')
     or has_function_privilege('authenticated', 'public.fetch_v2_settle_notification(bigint, text, text)', 'execute')
     or has_table_privilege('authenticated', 'public.fetch_notifications', 'select') then
    raise exception 'the Fetch outbox is reachable by a client';
  end if;
  if exists (select k from unnest(array['new_request_run', 'payment_action_needed', 'message', 'admin_review', 'driver_approved']) k
              where not exists (select 1 from public.fetch_v2_notice_copy(k, null, null))
                 or not exists (select 1 from public.fetch_v2_notice_meta(k))) then
    raise exception 'a Fetch notice kind has no copy or meta';
  end if;
end $$;

commit;
