-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Fetch v2 — Step 9: messages, issues and photos (docs/FETCH_V2_IMPLEMENTATION.md, Step 9).
--
-- Narrow, job-specific services on the Step 1 tables (fetch_messages, fetch_issues, fetch_request_photos):
--   · MESSAGES   between the requester and the assigned driver only, plain text, never edited; an administrator may hide one (with a
--                reason) — the record stays. Readable and sendable while the job is live and for participant_history_secs (30 days)
--                after it closes. A "new message" notice (Step 8 outbox) is collapsed to one unread notice per job and recipient and
--                never contains the text.
--   · ISSUES     reported by a participant within issue_window_secs (72 hours) of the job closing, or while it is live; never
--                rewritten; resolved by an administrator with the outcome recorded.
--   · PHOTOS     by signed upload to a server-chosen path in the private fetch-photos bucket; role and timing checked per kind
--                (item: requester, before claim; collection/delivery/return: the assigned driver, at the right stage; issue: the
--                reporter, while the issue is open). Evidence is write-once; administrators may remove from view, with a reason.
--                Shown only through short-lived signed links; the bucket has no client policy at all any more.
--
-- Direct table reads of messages, issues and photos become administrator-only (the Step 2 pattern); participants read through the
-- functions here, which apply the participant windows. Exact addresses (72h) and phone (live only) are untouched.
-- Every material action is a fetch_request_events row with ids only (never message text, issue detail or image data).
--
-- Rollback: supabase/rollbacks/20261223000000_fetch_v2_messages_issues_photos.down.sql
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
begin;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 0. Configuration, schema
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
insert into public.admin_config (key, value, category, description, is_secret) values
  ('fetch.timeouts.photo_upload_secs', '900', 'fetch', 'Fetch v2: a signed photo upload must be completed within this time, or it is discarded.', false)
on conflict (key) do nothing;

create or replace function public.fetch_v2_timeout_secs(p_name text) returns integer
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_default integer := case p_name
    when 'payment_needed_secs'        then 7200
    when 'cancel_request_secs'        then 7200
    when 'issue_window_secs'          then 259200
    when 'participant_history_secs'   then 2592000
    when 'exact_address_secs'         then 259200
    when 'collect_min_hold_secs'      then 86400
    when 'hold_expiry_margin_secs'    then 172800
    when 'verification_reminder_secs' then 2592000
    when 'verification_upload_secs'   then 900
    when 'photo_upload_secs'          then 900
  end;
  v_raw text;
begin
  if v_default is null then
    raise exception 'unknown Fetch timeout %', p_name;
  end if;
  select value into v_raw from public.admin_config where key = 'fetch.timeouts.' || p_name;
  if v_raw ~ '^\s*[0-9]{1,9}\s*$' and btrim(v_raw)::integer > 0 then
    return btrim(v_raw)::integer;
  end if;
  return v_default;
end;
$$;

insert into public.rate_limit_policies (action, window_seconds, max_count, note) values
  ('fetch_v2_photos', 3600, 60, 'Fetch v2 photo uploads, registrations and views per member per hour')
on conflict (action) do nothing;

-- A retried send/report carries the same client reference and gets the original back.
alter table public.fetch_messages add column if not exists client_ref uuid;
create unique index if not exists fetch_messages_client_ref_key on public.fetch_messages (request_id, sender_id, client_ref) where client_ref is not null;
alter table public.fetch_issues add column if not exists client_ref uuid;
create unique index if not exists fetch_issues_client_ref_key on public.fetch_issues (reporter_id, client_ref) where client_ref is not null;

-- A signed photo upload the server has issued: fixed request, kind, uploader and path; it lapses.
create table if not exists public.fetch_photo_uploads (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null references public.delivery_requests (id) on delete cascade,
  uploader_id  uuid not null references public.profiles (id) on delete cascade,
  kind         text not null check (kind in ('item', 'collection', 'delivery', 'return', 'issue')),
  issue_id     uuid references public.fetch_issues (id) on delete cascade,
  storage_path text not null unique,
  mime_type    text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes   integer not null check (size_bytes between 1 and 10485760),
  matching_visible boolean not null default false,
  photo_id     uuid,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  check ((kind = 'issue') = (issue_id is not null)),
  check (not matching_visible or kind = 'item'),
  check (storage_path ~ ('^requests/' || request_id::text || '/' || kind || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'))
);
create index if not exists fetch_photo_uploads_uploader_idx on public.fetch_photo_uploads (uploader_id, created_at);

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. Who is a participant right now (messages and photos): the requester, or the CURRENT assigned driver, while the job is live
--    and for participant_history_secs after it closes. Administrators always. A released driver is no longer a participant.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_participant_role(p_request uuid, p_user uuid) returns text
  language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when p_user is null or r.id is null then null
    when exists (select 1 from public.profiles p where p.id = p_user and (p.role = 'admin' or p.is_platform_owner)) then 'admin'
    when r.closed_at is not null and r.closed_at <= now() - make_interval(secs => public.fetch_v2_timeout_secs('participant_history_secs')) then null
    when r.customer_id = p_user then 'requester'
    when r.driver_id = p_user then 'driver'
  end
  from (select 1) one left join public.delivery_requests r on r.id = p_request and r.fetch_version = 2;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. Messages
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_send_message(p_request uuid, p_body text, p_client_ref uuid default null) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  r      public.delivery_requests;
  v_role text;
  v_body text := btrim(coalesce(p_body, ''), E' \t\r\n\f');
  m      public.fetch_messages;
begin
  perform public.fetch_v2_require();
  select * into r from public.delivery_requests where id = p_request and fetch_version = 2;
  -- Only the two people on the job (administrators read, they do not join the conversation), within the participant window.
  v_role := case when r.customer_id = v_uid then 'requester' when r.driver_id = v_uid then 'driver' end;
  if r.id is null or v_role is null then raise exception 'Fetch request not found' using errcode = 'P0002'; end if;
  if r.closed_at is not null and r.closed_at <= now() - make_interval(secs => public.fetch_v2_timeout_secs('participant_history_secs')) then
    return public.fetch_v2_refuse('message_window_closed');
  end if;
  if r.driver_id is null then return public.fetch_v2_refuse('no_driver_yet'); end if;
  if v_body = '' then return public.fetch_v2_refuse('message_empty'); end if;
  if char_length(v_body) > 1000 then return public.fetch_v2_refuse('message_too_long'); end if;
  if p_client_ref is not null then
    select * into m from public.fetch_messages where request_id = r.id and sender_id = v_uid and client_ref = p_client_ref;
    if m.id is not null then return jsonb_build_object('ok', true, 'already', true, 'message_id', m.id, 'created_at', m.created_at); end if;
  end if;
  if (select count(*) from public.fetch_messages where sender_id = v_uid and request_id = r.id and created_at > now() - interval '10 minutes') >= 20
     or (select count(*) from public.fetch_messages where sender_id = v_uid and created_at > now() - interval '1 day') >= 200 then
    return public.fetch_v2_refuse('rate_limited');
  end if;
  insert into public.fetch_messages (request_id, sender_id, sender_role, body, client_ref)
  values (r.id, v_uid, v_role, v_body, p_client_ref) returning * into m;
  perform public.fetch_v2_log(r.id, v_uid, v_role, 'message_sent', null, null, null, null, jsonb_build_object('message_id', m.id));
  return jsonb_build_object('ok', true, 'already', false, 'message_id', m.id, 'created_at', m.created_at);
end;
$$;

-- A participant's view: oldest first; a hidden message shows only that it was removed. Administrators also see the hidden text,
-- who hid it and why (support and disputes).
create or replace function public.fetch_v2_messages(p_request uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_role text;
begin
  perform public.fetch_v2_require();
  v_role := public.fetch_v2_participant_role(p_request, v_uid);
  if v_role is null then raise exception 'Fetch request not found' using errcode = 'P0002'; end if;
  return jsonb_build_object('ok', true, 'can_send', v_role in ('requester', 'driver')
      and exists (select 1 from public.delivery_requests r where r.id = p_request and r.driver_id is not null),
    'messages', coalesce((select jsonb_agg(
      case when v_role = 'admin' then jsonb_build_object('id', m.id, 'from', m.sender_role, 'sender_id', m.sender_id, 'body', m.body,
                                     'created_at', m.created_at, 'hidden', m.hidden_at is not null, 'hidden_at', m.hidden_at,
                                     'hidden_by', m.hidden_by, 'hidden_reason', m.hidden_reason)
           else jsonb_build_object('id', m.id, 'from', case when m.sender_id = v_uid then 'you' else m.sender_role end,
                                   'body', case when m.hidden_at is null then m.body end,
                                   'hidden', m.hidden_at is not null, 'created_at', m.created_at) end
      order by m.created_at, m.id) from public.fetch_messages m where m.request_id = p_request), '[]'));
end;
$$;

create or replace function public.fetch_v2_hide_message(p_admin uuid, p_message uuid, p_reason text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  m        public.fetch_messages;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform public.fetch_v2_service_actor(p_admin, true);
  if v_reason is null or char_length(v_reason) < 3 or char_length(v_reason) > 500 then return public.fetch_v2_refuse('reason_required'); end if;
  select * into m from public.fetch_messages where id = p_message for update;
  if m.id is null then return public.fetch_v2_refuse('not_found'); end if;
  if m.hidden_at is not null then return jsonb_build_object('ok', true, 'already', true); end if;
  update public.fetch_messages set hidden_at = now(), hidden_by = p_admin, hidden_reason = v_reason where id = m.id;
  perform public.fetch_v2_log(m.request_id, p_admin, 'admin', 'message_hidden', null, null, v_reason, null, jsonb_build_object('message_id', m.id));
  return jsonb_build_object('ok', true, 'already', false);
end;
$$;

-- The "new message" notice (Step 8 outbox, kind 'message'): one per job and recipient until that one has been read; never the text.
create or replace function public.tg_fetch_v2_notice_from_message() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r     public.delivery_requests;
  v_to  uuid;
begin
  if new.event <> 'message_sent' then return null; end if;
  begin
    select * into r from public.delivery_requests where id = new.request_id and fetch_version = 2;
    v_to := case when new.actor_id = r.customer_id then r.driver_id else r.customer_id end;
    if v_to is null or v_to = new.actor_id then return null; end if;
    if exists (select 1 from public.fetch_notifications n
                left join public.notification_log l on l.id = n.inbox_id
               where n.request_id = r.id and n.recipient_id = v_to and n.kind = 'message'
                 and (n.state = 'pending' or (l.id is not null and l.read_at is null))) then
      return null;   -- an unread "new message" notice already stands for this job
    end if;
    perform public.fetch_v2_enqueue_notice('msg:' || r.id || ':' || v_to || ':' || new.id, v_to, r.id, 'message', 'request_event', new.id::text);
  exception when others then
    raise warning 'Fetch message notice (event %) not queued: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;
drop trigger if exists fetch_v2_notice_from_message on public.fetch_request_events;
create trigger fetch_v2_notice_from_message after insert on public.fetch_request_events
  for each row execute function public.tg_fetch_v2_notice_from_message();

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. Issues
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_report_issue(p_request uuid, p_kind text, p_detail text default null, p_client_ref uuid default null)
  returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  r        public.delivery_requests;
  v_role   text;
  v_detail text := nullif(btrim(coalesce(p_detail, ''), E' \t\r\n\f'), '');
  i        public.fetch_issues;
begin
  perform public.fetch_v2_require();
  select * into r from public.delivery_requests where id = p_request and fetch_version = 2;
  v_role := case when r.customer_id = v_uid then 'requester' when r.driver_id = v_uid then 'driver' end;
  if r.id is null or v_role is null then raise exception 'Fetch request not found' using errcode = 'P0002'; end if;
  -- Live, or within the issue window after it closed.
  if r.closed_at is not null and r.closed_at <= now() - make_interval(secs => public.fetch_v2_timeout_secs('issue_window_secs')) then
    return public.fetch_v2_refuse('issue_window_closed');
  end if;
  if p_kind is null or p_kind not in ('not_delivered', 'damaged', 'wrong_item', 'payment', 'safety', 'other',
                                      case v_role when 'requester' then 'driver_conduct' else 'requester_conduct' end) then
    return public.fetch_v2_refuse('invalid_kind');
  end if;
  if v_detail is not null and char_length(v_detail) > 2000 then return public.fetch_v2_refuse('detail_too_long'); end if;
  if p_client_ref is not null then
    select * into i from public.fetch_issues where reporter_id = v_uid and client_ref = p_client_ref;
    if i.id is not null then return jsonb_build_object('ok', true, 'already', true, 'issue_id', i.id, 'status', i.status); end if;
  end if;
  if (select count(*) from public.fetch_issues where request_id = r.id and reporter_id = v_uid and status = 'open') >= 3
     or (select count(*) from public.fetch_issues where reporter_id = v_uid and created_at > now() - interval '1 day') >= 10 then
    return public.fetch_v2_refuse('rate_limited');
  end if;
  insert into public.fetch_issues (request_id, reporter_id, reporter_role, kind, detail, client_ref)
  values (r.id, v_uid, v_role, p_kind, v_detail, p_client_ref) returning * into i;
  perform public.fetch_v2_log(r.id, v_uid, v_role, 'issue_reported', null, null, null, null, jsonb_build_object('issue_id', i.id, 'kind', i.kind));
  return jsonb_build_object('ok', true, 'already', false, 'issue_id', i.id, 'status', 'open');
end;
$$;

-- The reporter's own issues on a job (within the participant window): kind, status and the recorded outcome.
create or replace function public.fetch_v2_my_issues(p_request uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid();
begin
  perform public.fetch_v2_require();
  if public.fetch_v2_participant_role(p_request, v_uid) is null then raise exception 'Fetch request not found' using errcode = 'P0002'; end if;
  return jsonb_build_object('ok', true, 'issues', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'kind', i.kind, 'detail', i.detail,
      'status', i.status, 'resolution', i.resolution, 'created_at', i.created_at, 'resolved_at', i.resolved_at) order by i.created_at)
    from public.fetch_issues i where i.request_id = p_request and i.reporter_id = v_uid), '[]'));
end;
$$;

create or replace function public.fetch_v2_resolve_issue(p_admin uuid, p_issue uuid, p_resolution text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  i     public.fetch_issues;
  v_res text := nullif(btrim(coalesce(p_resolution, '')), '');
begin
  perform public.fetch_v2_service_actor(p_admin, true);
  if v_res is null or char_length(v_res) < 3 or char_length(v_res) > 2000 then return public.fetch_v2_refuse('resolution_required'); end if;
  select * into i from public.fetch_issues where id = p_issue for update;
  if i.id is null then return public.fetch_v2_refuse('not_found'); end if;
  if i.status = 'resolved' then return jsonb_build_object('ok', true, 'already', true); end if;
  update public.fetch_issues set status = 'resolved', resolution = v_res, resolved_by = p_admin, resolved_at = now() where id = i.id;
  perform public.fetch_v2_log(i.request_id, p_admin, 'admin', 'issue_resolved', null, null, null, null, jsonb_build_object('issue_id', i.id, 'kind', i.kind));
  return jsonb_build_object('ok', true, 'already', false);
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. Photos
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- May this member add a photo of this kind to this job now? null = yes, otherwise the reason.
create or replace function public.fetch_v2_photo_problem(p_actor uuid, p_request uuid, p_kind text, p_issue uuid) returns text
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  r public.delivery_requests;
  i public.fetch_issues;
  v_cap integer := case p_kind when 'item' then 6 when 'issue' then 5 else 4 end;
  v_n integer;
begin
  select * into r from public.delivery_requests where id = p_request and fetch_version = 2;
  if r.id is null then return 'not_found'; end if;
  if p_kind = 'item' then
    if r.customer_id <> p_actor then return 'not_found'; end if;
    if r.status <> 'pending' or r.driver_id is not null then return 'item_photos_closed'; end if;
  elsif p_kind in ('collection', 'delivery', 'return') then
    if r.driver_id is distinct from p_actor then return 'not_found'; end if;
    if p_kind = 'collection' and r.status not in ('matched', 'collected') then return 'invalid_state'; end if;
    if p_kind = 'delivery' and r.status not in ('collected', 'undeliverable') then return 'invalid_state'; end if;
    if p_kind = 'return' and r.status <> 'undeliverable' then return 'invalid_state'; end if;
  elsif p_kind = 'issue' then
    select * into i from public.fetch_issues where id = p_issue and request_id = r.id;
    if i.id is null or i.reporter_id is distinct from p_actor then return 'not_found'; end if;
    if i.status <> 'open' then return 'issue_closed'; end if;
  else
    return 'invalid_kind';
  end if;
  select count(*) into v_n from public.fetch_request_photos
   where request_id = r.id and kind = p_kind and removed_at is null and (p_kind <> 'issue' or issue_id = p_issue);
  if v_n >= v_cap then return 'too_many_photos'; end if;
  return null;
end;
$$;

create or replace function public.fetch_v2_begin_photo_upload(p_actor uuid, p_request uuid, p_kind text, p_mime text, p_size integer,
                                                              p_issue uuid default null, p_matching_visible boolean default false) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_problem text;
  v_ext  text := case p_mime when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp' end;
  v_path text;
  v_exp  timestamptz := now() + make_interval(secs => public.fetch_v2_timeout_secs('photo_upload_secs'));
  v_id   uuid;
begin
  perform public.fetch_v2_service_actor(p_actor);
  if v_ext is null then return public.fetch_v2_refuse('file_type_not_allowed'); end if;
  if p_size is null or p_size < 1 then return public.fetch_v2_refuse('invalid_request'); end if;
  if p_size > 10485760 then return public.fetch_v2_refuse('file_too_large'); end if;
  v_problem := public.fetch_v2_photo_problem(p_actor, p_request, p_kind, case when p_kind = 'issue' then p_issue end);
  if v_problem is not null then return public.fetch_v2_refuse(v_problem); end if;
  if (select count(*) from public.fetch_photo_uploads where uploader_id = p_actor and created_at > now() - interval '1 hour') >= 20 then
    return public.fetch_v2_refuse('too_many_uploads');
  end if;
  v_path := 'requests/' || p_request || '/' || p_kind || '/' || gen_random_uuid() || '.' || v_ext;
  insert into public.fetch_photo_uploads (request_id, uploader_id, kind, issue_id, storage_path, mime_type, size_bytes, matching_visible, expires_at)
  values (p_request, p_actor, p_kind, case when p_kind = 'issue' then p_issue end, v_path, p_mime, p_size,
          p_kind = 'item' and coalesce(p_matching_visible, false), v_exp)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'upload_id', v_id, 'storage_path', v_path, 'expires_at', v_exp);
end;
$$;

create or replace function public.fetch_v2_pending_photo_upload(p_actor uuid, p_upload uuid) returns jsonb
  language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce((select jsonb_build_object('ok', true, 'storage_path', u.storage_path, 'mime_type', u.mime_type,
                                             'consumed', u.consumed_at is not null, 'expired', u.expires_at <= now(), 'photo_id', u.photo_id)
                     from public.fetch_photo_uploads u where u.id = p_upload and u.uploader_id = p_actor),
                  public.fetch_v2_refuse('not_found'));
$$;

-- The edge function has read the stored object back (real size, real type from its bytes) and removed its metadata.
create or replace function public.fetch_v2_register_photo(p_actor uuid, p_upload uuid, p_size integer, p_mime text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  u         public.fetch_photo_uploads;
  v_problem text;
  v_id      uuid;
  v_role    text;
begin
  perform public.fetch_v2_service_actor(p_actor);
  select * into u from public.fetch_photo_uploads where id = p_upload and uploader_id = p_actor for update;
  if u.id is null then return public.fetch_v2_refuse('not_found'); end if;
  if u.consumed_at is not null then return jsonb_build_object('ok', true, 'already', true, 'photo_id', u.photo_id, 'kind', u.kind); end if;
  if u.expires_at <= now() then return public.fetch_v2_refuse('upload_expired'); end if;
  if p_mime is distinct from u.mime_type then return public.fetch_v2_refuse('file_type_mismatch'); end if;
  if p_size is null or p_size < 1 or p_size > 10485760 then return public.fetch_v2_refuse('file_too_large'); end if;
  perform 1 from public.delivery_requests where id = u.request_id for update;   -- serialise with lifecycle changes
  v_problem := public.fetch_v2_photo_problem(p_actor, u.request_id, u.kind, u.issue_id);
  if v_problem is not null then return public.fetch_v2_refuse(v_problem); end if;

  insert into public.fetch_request_photos (request_id, issue_id, kind, storage_path, created_by, matching_visible)
  values (u.request_id, u.issue_id, u.kind, u.storage_path, p_actor, u.matching_visible) returning id into v_id;
  update public.fetch_photo_uploads set consumed_at = now(), photo_id = v_id where id = u.id;
  v_role := case when u.kind = 'item' then 'requester' when u.kind = 'issue'
                 then (select reporter_role from public.fetch_issues where id = u.issue_id) else 'driver' end;
  perform public.fetch_v2_log(u.request_id, p_actor, v_role, 'photo_added', null, null, null, null,
    jsonb_build_object('photo_id', v_id, 'kind', u.kind, 'matching_visible', u.matching_visible));
  return jsonb_build_object('ok', true, 'already', false, 'photo_id', v_id, 'kind', u.kind);
end;
$$;

create or replace function public.fetch_v2_discard_photo_upload(p_actor uuid, p_upload uuid) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_path text;
begin
  delete from public.fetch_photo_uploads where id = p_upload and uploader_id = p_actor and consumed_at is null returning storage_path into v_path;
  if v_path is null then return public.fetch_v2_refuse('not_found'); end if;
  return jsonb_build_object('ok', true, 'storage_path', v_path);
end;
$$;

create or replace function public.fetch_v2_stale_photo_uploads() returns table (upload_id uuid, uploader_id uuid, storage_path text)
  language sql stable security definer set search_path = public, pg_temp
as $$ select id, uploader_id, storage_path from public.fetch_photo_uploads where consumed_at is null and expires_at < now() order by expires_at limit 200; $$;

-- The requester decides, before the job is claimed, whether an item photo may be shown on the drivers' board; or withdraws it.
create or replace function public.fetch_v2_set_item_photo(p_request uuid, p_photo uuid, p_action text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  r     public.delivery_requests;
  ph    public.fetch_request_photos;
begin
  perform public.fetch_v2_require();
  r := public.fetch_v2_lock(p_request);
  if r.customer_id is distinct from v_uid then raise exception 'Fetch request not found' using errcode = 'P0002'; end if;
  select * into ph from public.fetch_request_photos where id = p_photo and request_id = r.id and kind = 'item' and removed_at is null;
  if ph.id is null then return public.fetch_v2_refuse('not_found'); end if;
  if r.status <> 'pending' or r.driver_id is not null then return public.fetch_v2_refuse('item_photos_closed'); end if;
  if p_action = 'show_on_board' then
    update public.fetch_request_photos set matching_visible = true where id = ph.id;
  elsif p_action = 'hide_from_board' then
    update public.fetch_request_photos set matching_visible = false where id = ph.id;
  elsif p_action = 'withdraw' then
    update public.fetch_request_photos set removed_at = now(), removed_by = v_uid, removed_reason = 'Withdrawn by the requester', matching_visible = false
     where id = ph.id;
  else
    return public.fetch_v2_refuse('invalid_request');
  end if;
  perform public.fetch_v2_log(r.id, v_uid, 'requester', case when p_action = 'withdraw' then 'photo_withdrawn' else 'photo_visibility_changed' end,
    null, null, null, null, jsonb_build_object('photo_id', ph.id, 'action', p_action));
  return jsonb_build_object('ok', true);
end;
$$;

-- A participant's list of a job's photos (ids and roles; links come from the edge function).
create or replace function public.fetch_v2_photos(p_request uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_role text;
begin
  perform public.fetch_v2_require();
  v_role := public.fetch_v2_participant_role(p_request, v_uid);
  if v_role is null then raise exception 'Fetch request not found' using errcode = 'P0002'; end if;
  return jsonb_build_object('ok', true, 'photos', coalesce((select jsonb_agg(jsonb_build_object('id', ph.id, 'kind', ph.kind, 'issue_id', ph.issue_id,
      'matching_visible', ph.matching_visible, 'created_at', ph.created_at, 'mine', ph.created_by = v_uid,
      'removed', ph.removed_at is not null, 'removed_reason', case when v_role = 'admin' then ph.removed_reason end) order by ph.created_at)
    from public.fetch_request_photos ph where ph.request_id = p_request and (ph.removed_at is null or v_role = 'admin')), '[]'));
end;
$$;

-- The storage path behind a short-lived link: 'party' (a participant, within the window, not removed), 'board' (a driver who can take
-- jobs, an open job's matching-visible item photo), 'admin' (always — including removed photos and after the windows, so evidence
-- for an unresolved issue stays reachable). Paths never leave the server.
create or replace function public.fetch_v2_photo_for_view(p_actor uuid, p_photo uuid, p_purpose text) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  ph public.fetch_request_photos;
  r  public.delivery_requests;
  v_role text;
begin
  select * into ph from public.fetch_request_photos where id = p_photo;
  select * into r from public.delivery_requests where id = ph.request_id and fetch_version = 2;
  if ph.id is null or r.id is null then return public.fetch_v2_refuse('not_found'); end if;
  v_role := public.fetch_v2_participant_role(r.id, p_actor);
  if p_purpose = 'admin' then
    if v_role is distinct from 'admin' then raise exception 'Only an administrator can do that' using errcode = '42501'; end if;
  elsif p_purpose = 'party' then
    if coalesce(v_role, '') not in ('requester', 'driver') or ph.removed_at is not null then return public.fetch_v2_refuse('not_found'); end if;
  elsif p_purpose = 'board' then
    if ph.kind <> 'item' or not ph.matching_visible or ph.removed_at is not null or r.status <> 'pending' or r.driver_id is not null
       or (r.expires_at is not null and r.expires_at <= now()) or r.customer_id = p_actor
       or public.fetch_v2_driver_eligibility_problem(p_actor) is not null then
      return public.fetch_v2_refuse('not_found');
    end if;
  else
    return public.fetch_v2_refuse('invalid_request');
  end if;
  return jsonb_build_object('ok', true, 'storage_path', ph.storage_path, 'kind', ph.kind, 'removed', ph.removed_at is not null,
                            'evidence_held', public.fetch_v2_evidence_held(r.id));
end;
$$;

create or replace function public.fetch_v2_remove_photo(p_admin uuid, p_photo uuid, p_reason text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  ph       public.fetch_request_photos;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform public.fetch_v2_service_actor(p_admin, true);
  if v_reason is null or char_length(v_reason) < 3 or char_length(v_reason) > 500 then return public.fetch_v2_refuse('reason_required'); end if;
  select * into ph from public.fetch_request_photos where id = p_photo for update;
  if ph.id is null then return public.fetch_v2_refuse('not_found'); end if;
  if ph.removed_at is not null then return jsonb_build_object('ok', true, 'already', true); end if;
  update public.fetch_request_photos set removed_at = now(), removed_by = p_admin, removed_reason = v_reason, matching_visible = false where id = ph.id;
  perform public.fetch_v2_log(ph.request_id, p_admin, 'admin', 'photo_removed', null, null, v_reason, null,
    jsonb_build_object('photo_id', ph.id, 'kind', ph.kind));
  return jsonb_build_object('ok', true, 'already', false);
end;
$$;

-- The support view of one job for administrators: every message (hidden included), issue and photo record — ids, no storage paths.
create or replace function public.fetch_v2_support_record(p_admin uuid, p_request uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  perform public.fetch_v2_service_actor(p_admin, true);
  if not exists (select 1 from public.delivery_requests where id = p_request and fetch_version = 2) then return public.fetch_v2_refuse('not_found'); end if;
  return jsonb_build_object('ok', true, 'evidence_held', public.fetch_v2_evidence_held(p_request),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'from', m.sender_role, 'sender_id', m.sender_id, 'body', m.body,
        'created_at', m.created_at, 'hidden_at', m.hidden_at, 'hidden_by', m.hidden_by, 'hidden_reason', m.hidden_reason) order by m.created_at)
      from public.fetch_messages m where m.request_id = p_request), '[]'),
    'issues', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'kind', i.kind, 'reporter_role', i.reporter_role, 'reporter_id', i.reporter_id,
        'detail', i.detail, 'status', i.status, 'resolution', i.resolution, 'resolved_by', i.resolved_by, 'created_at', i.created_at,
        'resolved_at', i.resolved_at) order by i.created_at) from public.fetch_issues i where i.request_id = p_request), '[]'),
    'photos', coalesce((select jsonb_agg(jsonb_build_object('id', ph.id, 'kind', ph.kind, 'issue_id', ph.issue_id, 'created_by', ph.created_by,
        'created_at', ph.created_at, 'matching_visible', ph.matching_visible, 'removed_at', ph.removed_at, 'removed_by', ph.removed_by,
        'removed_reason', ph.removed_reason) order by ph.created_at) from public.fetch_request_photos ph where ph.request_id = p_request), '[]'));
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 5. Evidence that counts: from the assigned driver, of the right kind, taken at the right stage, still in view
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_has_evidence(p_request uuid, p_kind text) returns boolean
  language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.delivery_requests r join public.fetch_request_photos ph on ph.request_id = r.id
     where r.id = p_request and ph.kind = p_kind and ph.removed_at is null and ph.created_by = r.driver_id
       and ph.created_at >= case p_kind when 'delivery' then r.collected_at when 'return' then r.undeliverable_at else r.claimed_at end);
$$;

create or replace function public.fetch_v2_delivery_precheck(p_driver uuid, p_request uuid, p_left_in_safe_place boolean) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare r public.delivery_requests;
begin
  select * into r from public.delivery_requests where id = p_request and fetch_version = 2;
  if r.id is null or r.driver_id is distinct from p_driver then return public.fetch_v2_refuse('not_found'); end if;
  if r.status = 'delivered' then return jsonb_build_object('ok', true, 'already', true); end if;
  if not public.fetch_v2_transition_allowed(r.status, 'delivered', 'driver') then return public.fetch_v2_refuse('invalid_transition'); end if;
  if p_left_in_safe_place then
    if not r.safe_place_allowed then return public.fetch_v2_refuse('safe_place_not_allowed'); end if;
    if not public.fetch_v2_has_evidence(r.id, 'delivery') then return public.fetch_v2_refuse('delivery_photo_required'); end if;
  end if;
  return jsonb_build_object('ok', true, 'already', false);
end;
$$;

create or replace function public.fetch_v2_complete_delivery(p_driver uuid, p_request uuid, p_left_in_safe_place boolean default false) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.delivery_requests; v_from text;
begin
  perform public.fetch_v2_service_actor(p_driver);
  r := public.fetch_v2_lock(p_request);
  if r.driver_id is distinct from p_driver then raise exception 'Fetch request not found' using errcode = 'P0002'; end if;
  if r.status = 'delivered' then return public.fetch_v2_ok(r, jsonb_build_object('already', true)); end if;
  if not public.fetch_v2_transition_allowed(r.status, 'delivered', 'driver') then return public.fetch_v2_refuse('invalid_transition'); end if;
  -- PAYMENT HOOK: delivery is recorded only after the capture succeeded.
  if r.payment_status <> 'captured' then return public.fetch_v2_refuse('payment_not_captured'); end if;
  if p_left_in_safe_place then
    if not r.safe_place_allowed then return public.fetch_v2_refuse('safe_place_not_allowed'); end if;
    if not public.fetch_v2_has_evidence(r.id, 'delivery') then return public.fetch_v2_refuse('delivery_photo_required'); end if;
  end if;
  v_from := r.status;
  update public.delivery_requests set status = 'delivered', delivered_at = now() where id = r.id returning * into r;
  perform public.fetch_v2_log(r.id, p_driver, 'driver', 'delivered', v_from, 'delivered', null, null,
    jsonb_build_object('left_in_safe_place', coalesce(p_left_in_safe_place, false), 'retry', v_from = 'undeliverable'));
  return public.fetch_v2_ok(r, jsonb_build_object('already', false));
end;
$$;

create or replace function public.fetch_v2_report_return(p_request uuid, p_note text default null) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.delivery_requests; v_uid uuid := auth.uid();
begin
  perform public.fetch_v2_require();
  r := public.fetch_v2_lock(p_request);
  if r.driver_id is distinct from v_uid then raise exception 'Fetch request not found' using errcode = 'P0002'; end if;
  if r.status <> 'undeliverable' then return public.fetch_v2_refuse('invalid_state'); end if;
  if exists (select 1 from public.fetch_request_events where request_id = r.id and event = 'return_reported') then
    return public.fetch_v2_ok(r, jsonb_build_object('already', true));
  end if;
  -- EVIDENCE: a return photo from this driver, taken after the job became undeliverable.
  if not public.fetch_v2_has_evidence(r.id, 'return') then return public.fetch_v2_refuse('return_photo_required'); end if;
  if char_length(coalesce(p_note, '')) > 1000 then return public.fetch_v2_refuse('invalid_request'); end if;
  perform public.fetch_v2_log(r.id, v_uid, 'driver', 'return_reported', 'undeliverable', 'undeliverable', p_note);
  return public.fetch_v2_ok(r, jsonb_build_object('already', false, 'awaiting', 'admin'));
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 6. Access: direct reads are administrators' only; the photo bucket has no client policy; grants
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
drop policy if exists "Fetch messages: parties and admins" on public.fetch_messages;
drop policy if exists "Fetch messages: administrators" on public.fetch_messages;
create policy "Fetch messages: administrators" on public.fetch_messages for select to authenticated using (public.is_admin());
drop policy if exists "Fetch issues: reporter and admins" on public.fetch_issues;
drop policy if exists "Fetch issues: administrators" on public.fetch_issues;
create policy "Fetch issues: administrators" on public.fetch_issues for select to authenticated using (public.is_admin());
drop policy if exists "Fetch photos: parties and admins" on public.fetch_request_photos;
drop policy if exists "Fetch photos: administrators" on public.fetch_request_photos;
create policy "Fetch photos: administrators" on public.fetch_request_photos for select to authenticated using (public.is_admin());

-- No client role reads, lists or deletes fetch-photos — administrators included. Short-lived signed links from the edge only.
drop policy if exists "fetch-photos read" on storage.objects;
drop policy if exists "fetch-photos delete" on storage.objects;

alter table public.fetch_photo_uploads enable row level security;
revoke all on public.fetch_photo_uploads from public, anon, authenticated;
grant all on public.fetch_photo_uploads to service_role;

revoke all on function
  public.fetch_v2_participant_role(uuid, uuid), public.fetch_v2_send_message(uuid, text, uuid), public.fetch_v2_messages(uuid),
  public.fetch_v2_hide_message(uuid, uuid, text), public.tg_fetch_v2_notice_from_message(), public.fetch_v2_report_issue(uuid, text, text, uuid),
  public.fetch_v2_my_issues(uuid), public.fetch_v2_resolve_issue(uuid, uuid, text), public.fetch_v2_photo_problem(uuid, uuid, text, uuid),
  public.fetch_v2_begin_photo_upload(uuid, uuid, text, text, integer, uuid, boolean), public.fetch_v2_pending_photo_upload(uuid, uuid),
  public.fetch_v2_register_photo(uuid, uuid, integer, text), public.fetch_v2_discard_photo_upload(uuid, uuid), public.fetch_v2_stale_photo_uploads(),
  public.fetch_v2_set_item_photo(uuid, uuid, text), public.fetch_v2_photos(uuid), public.fetch_v2_photo_for_view(uuid, uuid, text),
  public.fetch_v2_remove_photo(uuid, uuid, text), public.fetch_v2_support_record(uuid, uuid), public.fetch_v2_has_evidence(uuid, text)
  from public, anon, authenticated;
grant execute on function
  public.fetch_v2_send_message(uuid, text, uuid), public.fetch_v2_messages(uuid), public.fetch_v2_report_issue(uuid, text, text, uuid),
  public.fetch_v2_my_issues(uuid), public.fetch_v2_set_item_photo(uuid, uuid, text), public.fetch_v2_photos(uuid)
  to authenticated, service_role;
grant execute on function
  public.fetch_v2_participant_role(uuid, uuid), public.fetch_v2_hide_message(uuid, uuid, text), public.fetch_v2_resolve_issue(uuid, uuid, text),
  public.fetch_v2_photo_problem(uuid, uuid, text, uuid), public.fetch_v2_begin_photo_upload(uuid, uuid, text, text, integer, uuid, boolean),
  public.fetch_v2_pending_photo_upload(uuid, uuid), public.fetch_v2_register_photo(uuid, uuid, integer, text),
  public.fetch_v2_discard_photo_upload(uuid, uuid), public.fetch_v2_stale_photo_uploads(), public.fetch_v2_photo_for_view(uuid, uuid, text),
  public.fetch_v2_remove_photo(uuid, uuid, text), public.fetch_v2_support_record(uuid, uuid), public.fetch_v2_has_evidence(uuid, text)
  to service_role;
-- fetch_v2_delivery_precheck, fetch_v2_complete_delivery, fetch_v2_report_return and fetch_v2_timeout_secs keep their grants.

do $$
begin
  if has_function_privilege('authenticated', 'public.fetch_v2_hide_message(uuid, uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'public.fetch_v2_photo_for_view(uuid, uuid, text)', 'execute')
     or has_function_privilege('anon', 'public.fetch_v2_messages(uuid)', 'execute')
     or has_function_privilege('anon', 'public.fetch_v2_send_message(uuid, text, uuid)', 'execute') then
    raise exception 'a Fetch support function is reachable by the wrong role';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
              and coalesce(qual, '') || coalesce(with_check, '') like '%fetch-photos%' and cmd in ('SELECT', 'INSERT', 'DELETE', 'ALL')) then
    raise exception 'the fetch-photos bucket must have no client read, write or delete policy';
  end if;
  if exists (select 1 from storage.buckets where id = 'fetch-photos' and public) then
    raise exception 'the fetch-photos bucket must be private';
  end if;
end $$;

commit;
