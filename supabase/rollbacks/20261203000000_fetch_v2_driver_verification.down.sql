-- Rollback of 20261203000000_fetch_v2_driver_verification.sql (Fetch v2 Step 6: driver verification).
-- Restores exactly the catalogue before it: the Step 1 trigger, policies and kind list, the Step 3 driver gate, the Step 5 timeouts
-- and collection function. Refuses while any Step 6 record exists (audit events, uploads, versioned evidence, verification issues):
-- those are audit history and are not discarded by a rollback.
begin;

do $$
begin
  if exists (select 1 from public.driver_verification_events) or exists (select 1 from public.driver_verification_uploads)
     or exists (select 1 from public.driver_verification_items where version > 1)
     or exists (select 1 from public.fetch_issues where kind = 'driver_verification') then
    raise exception 'refusing to roll back driver verification: Step 6 records exist';
  end if;
end $$;

-- 1. The Step 5 / Step 3 / Step 1 functions, verbatim
create or replace function public.fetch_v2_timeout_secs(p_name text) returns integer
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_default integer := case p_name
    when 'payment_needed_secs'      then 7200
    when 'cancel_request_secs'      then 7200
    when 'issue_window_secs'        then 259200
    when 'participant_history_secs' then 2592000
    when 'exact_address_secs'       then 259200
    when 'collect_min_hold_secs'    then 86400
    when 'hold_expiry_margin_secs'  then 172800
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

create or replace function public.fetch_v2_driver_problem(p_driver uuid) returns text
  language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when dp.id is null or dp.driver_status <> 'approved'                 then 'driver_not_approved'
    when dp.verification_ok_until is null or dp.verification_ok_until <= now() then 'driver_verification_expired'
    when not dp.stripe_payouts_enabled                                    then 'driver_payouts_not_enabled'
  end
  from (select 1) one left join public.driver_profiles dp on dp.id = p_driver;
$$;

create or replace function public.fetch_v2_mark_collected(p_request uuid) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r       public.delivery_requests;
  v_uid   uuid := auth.uid();
  v_hold  record;
  v_fee   integer;
  v_secs  integer;
begin
  perform public.fetch_v2_require();
  r := public.fetch_v2_lock(p_request);
  if r.driver_id is distinct from v_uid then raise exception 'Fetch request not found' using errcode = 'P0002'; end if;
  if r.status = 'collected' then
    return public.fetch_v2_ok(r, jsonb_build_object('already', true, 'waiting_fee_pence', r.waiting_fee_pence));
  end if;
  if r.cancel_requested_at is not null then return public.fetch_v2_refuse('cancellation_pending'); end if;
  if not public.fetch_v2_transition_allowed(r.status, 'collected', 'driver') then return public.fetch_v2_refuse('invalid_transition'); end if;

  -- PAYMENT GATE: a live, sufficient, long-enough Stripe hold, confirmed recently.
  select * into v_hold from public.fetch_v2_hold_ready(r.id);
  if not coalesce(v_hold.ok, false) then
    return public.fetch_v2_refuse('payment_not_ready', jsonb_build_object('reason', v_hold.reason));
  end if;

  update public.waiting_events set collected_at = now() where request_id = r.id and driver_id = v_uid and collected_at is null;
  select greatest(0, extract(epoch from now() - min(arrived_at)))::integer into v_secs
    from public.waiting_events where request_id = r.id and driver_id = v_uid;
  v_fee := coalesce(public.fetch_waiting_fee_pence(r.id), 0);

  update public.delivery_requests set status = 'collected', collected_at = now(), waiting_fee_pence = v_fee
   where id = r.id returning * into r;
  perform public.fetch_v2_log(r.id, v_uid, 'driver', 'collected', 'matched', 'collected', null, null,
    jsonb_build_object('waiting_fee_pence', v_fee, 'waited_secs', v_secs, 'ready_for_collection', r.ready_for_collection));
  return public.fetch_v2_ok(r, jsonb_build_object('already', false, 'waiting_fee_pence', v_fee));
end;
$$;

create or replace function public.tg_fetch_v2_driver_server_columns() returns trigger
  language plpgsql set search_path = public
as $$
begin
  if public.tg_is_trusted_writer() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.release_count := 0; new.fault_return_count := 0; new.last_release_at := null;
    new.decision_reason := null; new.decided_by := null; new.decided_at := null; new.verification_ok_until := null;
  else
    new.release_count := old.release_count; new.fault_return_count := old.fault_return_count;
    new.last_release_at := old.last_release_at; new.decision_reason := old.decision_reason;
    new.decided_by := old.decided_by; new.decided_at := old.decided_at; new.verification_ok_until := old.verification_ok_until;
  end if;
  return new;
end;
$$;

-- 2. Policies and storage as Step 1 left them
drop policy if exists "Verification items: reviewers" on public.driver_verification_items;
drop policy if exists "Verification files: reviewers" on public.driver_verification_files;
drop policy if exists "Verification events: reviewers" on public.driver_verification_events;
create policy "Verification items: owner and admins" on public.driver_verification_items for select to authenticated
  using (driver_id = auth.uid() or public.is_admin());
create policy "Verification files: admins only" on public.driver_verification_files for select to authenticated
  using (public.is_admin());
drop policy if exists "fetch-driver-verification read" on storage.objects;
create policy "fetch-driver-verification read" on storage.objects for select to authenticated
  using (bucket_id = 'fetch-driver-verification' and public.is_admin());
drop policy if exists "fetch-driver-verification delete" on storage.objects;
create policy "fetch-driver-verification delete" on storage.objects for delete to authenticated
  using (bucket_id = 'fetch-driver-verification' and public.is_admin());

-- 3. New functions and tables
drop function if exists
  public.fetch_v2_verification_sweep(), public.fetch_v2_driver_verification_record(uuid, uuid), public.fetch_v2_verification_queue(uuid),
  public.fetch_v2_my_verification(), public.fetch_v2_verification_summary(uuid), public.fetch_v2_record_evidence_file_deleted(uuid, uuid, text),
  public.fetch_v2_evidence_file_for(uuid, uuid, text), public.fetch_v2_set_requirement(uuid, jsonb), public.fetch_v2_decide_driver(uuid, uuid, text, text),
  public.fetch_v2_review_evidence(uuid, uuid, text, text, date), public.fetch_v2_require_reviewer(uuid), public.fetch_v2_stale_evidence_uploads(),
  public.fetch_v2_discard_evidence_upload(uuid, uuid), public.fetch_v2_pending_evidence_upload(uuid, uuid), public.fetch_v2_submit_evidence(uuid, uuid, integer, text),
  public.fetch_v2_begin_evidence_upload(uuid, text, text, integer), public.fetch_v2_set_vehicle(uuid, jsonb), public.fetch_v2_apply_driver(uuid, jsonb),
  public.fetch_v2_apply_vehicle(uuid, uuid, text, jsonb), public.fetch_v2_open_verification_issue(uuid, text), public.fetch_v2_sync_verification(uuid, uuid, text),
  public.fetch_v2_verified_until(uuid), public.fetch_v2_verification_state(uuid),
  public.fetch_v2_vlog(uuid, uuid, uuid, text, text, text, jsonb, text), public.fetch_v2_is_verification_reviewer(uuid);
drop table if exists public.driver_verification_events;
drop function if exists public.tg_driver_verification_event_append_only();
drop table if exists public.driver_verification_uploads;

-- 4. Columns, indexes, constraint
alter table public.fetch_issues drop constraint if exists fetch_issues_kind_check;
alter table public.fetch_issues add constraint fetch_issues_kind_check check (kind in ('not_delivered', 'damaged', 'wrong_item', 'driver_conduct', 'requester_conduct',
                                              'payment', 'safety', 'cancellation', 'return', 'other'));
drop index if exists public.driver_verification_items_one_submitted;
drop index if exists public.driver_verification_items_one_verified;
drop index if exists public.driver_verification_items_version_key;
alter table public.driver_verification_items drop constraint if exists driver_verification_items_version_check;
alter table public.driver_verification_items drop column if exists version;
alter table public.driver_verification_requirements drop column if exists per_vehicle;

-- 5. Configuration
delete from public.rate_limit_policies where action in ('fetch_v2_apply', 'fetch_v2_verification');
delete from public.admin_config where key in ('fetch.timeouts.verification_reminder_secs', 'fetch.timeouts.verification_upload_secs');

commit;
