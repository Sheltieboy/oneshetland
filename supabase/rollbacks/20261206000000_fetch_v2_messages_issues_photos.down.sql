-- Rollback of 20261206000000_fetch_v2_messages_issues_photos.sql (Fetch v2 Step 9: messages, issues, photos).
-- Restores exactly the catalogue before it: Step 6's fetch_v2_timeout_secs, Step 5's fetch_v2_delivery_precheck, Step 3's
-- fetch_v2_complete_delivery and fetch_v2_report_return, and Step 1's table and storage policies.
-- Refuses while any Step 9 record exists (messages, issues or photos reported/added through it, or pending uploads).
begin;

do $$
begin
  if exists (select 1 from public.fetch_photo_uploads)
     or exists (select 1 from public.fetch_messages where client_ref is not null)
     or exists (select 1 from public.fetch_issues where client_ref is not null)
     or exists (select 1 from public.fetch_request_events where event in ('message_sent', 'message_hidden', 'issue_reported', 'issue_resolved',
                                                                         'photo_added', 'photo_removed', 'photo_withdrawn', 'photo_visibility_changed')) then
    raise exception 'refusing to roll back messages, issues and photos: Step 9 records exist';
  end if;
end $$;

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
    if not exists (select 1 from public.fetch_request_photos where request_id = r.id and kind = 'delivery' and removed_at is null) then
      return public.fetch_v2_refuse('delivery_photo_required');
    end if;
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
    if not exists (select 1 from public.fetch_request_photos where request_id = r.id and kind = 'delivery' and removed_at is null) then
      return public.fetch_v2_refuse('delivery_photo_required');
    end if;
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
  -- EVIDENCE HOOK (Step 9 uploads): a return photo is required.
  if not exists (select 1 from public.fetch_request_photos where request_id = r.id and kind = 'return' and removed_at is null) then
    return public.fetch_v2_refuse('return_photo_required');
  end if;
  if char_length(coalesce(p_note, '')) > 1000 then return public.fetch_v2_refuse('invalid_request'); end if;
  perform public.fetch_v2_log(r.id, v_uid, 'driver', 'return_reported', 'undeliverable', 'undeliverable', p_note);
  return public.fetch_v2_ok(r, jsonb_build_object('already', false, 'awaiting', 'admin'));
end;
$$;

drop trigger if exists fetch_v2_notice_from_message on public.fetch_request_events;

drop policy if exists "Fetch messages: administrators" on public.fetch_messages;
drop policy if exists "Fetch issues: administrators" on public.fetch_issues;
drop policy if exists "Fetch photos: administrators" on public.fetch_request_photos;
drop policy if exists "Fetch messages: parties and admins" on public.fetch_messages;
drop policy if exists "Fetch issues: reporter and admins" on public.fetch_issues;
drop policy if exists "Fetch photos: parties and admins" on public.fetch_request_photos;
drop policy if exists "fetch-photos read" on storage.objects;
drop policy if exists "fetch-photos delete" on storage.objects;
create policy "Fetch messages: parties and admins" on public.fetch_messages for select to authenticated
  using (public.is_admin() or (hidden_at is null and public.fetch_v2_is_party(request_id)));

create policy "Fetch issues: reporter and admins" on public.fetch_issues for select to authenticated
  using (public.is_admin() or (reporter_id = auth.uid() and public.fetch_v2_is_party(request_id)));

create policy "Fetch photos: parties and admins" on public.fetch_request_photos for select to authenticated
  using (public.is_admin() or (removed_at is null and public.fetch_v2_is_party(request_id)));

create policy "fetch-photos read" on storage.objects for select to authenticated
  using (bucket_id = 'fetch-photos' and public.fetch_v2_photo_object_readable(objects.name));

create policy "fetch-photos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'fetch-photos' and public.is_admin());

drop function if exists
  public.fetch_v2_has_evidence(uuid, text), public.fetch_v2_support_record(uuid, uuid), public.fetch_v2_remove_photo(uuid, uuid, text),
  public.fetch_v2_photo_for_view(uuid, uuid, text), public.fetch_v2_photos(uuid), public.fetch_v2_set_item_photo(uuid, uuid, text),
  public.fetch_v2_stale_photo_uploads(), public.fetch_v2_discard_photo_upload(uuid, uuid), public.fetch_v2_register_photo(uuid, uuid, integer, text),
  public.fetch_v2_pending_photo_upload(uuid, uuid), public.fetch_v2_begin_photo_upload(uuid, uuid, text, text, integer, uuid, boolean),
  public.fetch_v2_photo_problem(uuid, uuid, text, uuid), public.fetch_v2_resolve_issue(uuid, uuid, text), public.fetch_v2_my_issues(uuid),
  public.fetch_v2_report_issue(uuid, text, text, uuid), public.tg_fetch_v2_notice_from_message(), public.fetch_v2_hide_message(uuid, uuid, text),
  public.fetch_v2_messages(uuid), public.fetch_v2_send_message(uuid, text, uuid), public.fetch_v2_participant_role(uuid, uuid);
drop table if exists public.fetch_photo_uploads;
drop index if exists public.fetch_messages_client_ref_key;
drop index if exists public.fetch_issues_client_ref_key;
alter table public.fetch_messages drop column if exists client_ref;
alter table public.fetch_issues drop column if exists client_ref;
delete from public.rate_limit_policies where action = 'fetch_v2_photos';
delete from public.admin_config where key = 'fetch.timeouts.photo_upload_secs';

commit;
