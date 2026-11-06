-- Reverses supabase/migrations/20261217000000_fetch_v2_lifecycle.sql exactly (proved by supabase/tests/fetch-v2-lifecycle.node.test.ts:
-- apply → roll back → the catalogue equals the pre-migration one). The Step 2 detail function is restored verbatim from
-- 20261216000000_fetch_v2_access_boundary.sql.
--
-- NOT a migration: it lives outside supabase/migrations so no tool applies it by accident. Run by hand only with Darren's approval.
-- Removing the lifecycle actions leaves Fetch v2 with NO way to change a job (client writes were retired in Step 2) — that is the
-- safe failure. It refuses while a member restriction is recorded, because dropping those columns would lose an admin decision.
-- Jobs, events and issues created through these actions are data and are kept.

begin;

do $$
begin
  if exists (select 1 from public.fetch_member_stats where restricted_at is not null) then
    raise exception 'member restrictions are recorded; refusing to roll back the lifecycle actions';
  end if;
end $$;

drop function if exists public.fetch_v2_cancel_run(uuid);
drop function if exists public.fetch_v2_create_run(uuid, uuid, timestamptz, timestamptz, text[], text, text);
drop function if exists public.fetch_v2_escalate_cancel_requests();
drop function if exists public.fetch_v2_release_unpaid_due();
drop function if exists public.fetch_v2_expire_due();
drop function if exists public.fetch_v2_resolve_return(uuid, uuid, text, text, integer, text);
drop function if exists public.fetch_v2_report_return(uuid, text);
drop function if exists public.fetch_v2_mark_undeliverable(uuid, text, text);
drop function if exists public.fetch_v2_complete_delivery(uuid, uuid, boolean);
drop function if exists public.fetch_v2_mark_collected(uuid);
drop function if exists public.fetch_v2_mark_arrived(uuid);
drop function if exists public.fetch_v2_confirm_ready(uuid);
drop function if exists public.fetch_v2_extend(uuid);
drop function if exists public.fetch_v2_admin_cancel(uuid, uuid, text);
drop function if exists public.fetch_v2_resolve_cancellation(uuid, uuid, text, text);
drop function if exists public.fetch_v2_decline_cancellation(uuid, text);
drop function if exists public.fetch_v2_agree_cancellation(uuid, uuid);
drop function if exists public.fetch_v2_cancel_matched_internal(public.delivery_requests, uuid, text, text, text);
drop function if exists public.fetch_v2_request_cancellation(uuid, text);
drop function if exists public.fetch_v2_cancel_open(uuid, text);
drop function if exists public.fetch_v2_release(uuid, uuid, text, text);
drop function if exists public.fetch_v2_release_internal(uuid, uuid, text, text, text);
drop function if exists public.fetch_v2_claim(uuid, uuid, boolean);
drop function if exists public.fetch_v2_create_request(uuid, jsonb);
drop function if exists public.fetch_v2_ok(public.delivery_requests, jsonb);
drop function if exists public.fetch_v2_driver_problem(uuid);
drop function if exists public.fetch_v2_service_actor(uuid, boolean);
drop function if exists public.fetch_v2_lock(uuid);
drop function if exists public.fetch_v2_bump_member(uuid, text);
drop function if exists public.fetch_v2_log(uuid, uuid, text, text, text, text, text, text, jsonb);
drop function if exists public.fetch_v2_refuse(text, jsonb);
drop function if exists public.fetch_v2_price(numeric, text, boolean);
drop function if exists public.fetch_v2_service_fee_pence(integer);
drop function if exists public.fetch_v2_straight_miles(numeric, numeric, numeric, numeric);
drop function if exists public.fetch_v2_size_rank(text);
drop function if exists public.fetch_v2_transition_allowed(text, text, text);

create or replace function public.fetch_v2_request_detail(p_request uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  r          public.delivery_requests;
  v_uid      uuid := auth.uid();
  v_admin    boolean := public.is_admin();
  v_role     text;
  v_live     boolean;
  v_addr_ok  boolean;
  v_common   jsonb;
  v_driver   jsonb;
  v_requester_first text;
begin
  perform public.fetch_v2_require();

  select * into r from public.delivery_requests where id = p_request and fetch_version = 2;
  -- One answer for "does not exist" and "not yours", so the call cannot be used to discover jobs.
  if not found then
    raise exception 'Fetch request not found' using errcode = 'P0002';
  end if;

  v_role := case
    when v_admin then 'admin'
    when r.customer_id = v_uid then 'requester'
    when r.driver_id = v_uid
         and (r.closed_at is null or r.closed_at > now() - make_interval(secs => public.fetch_v2_timeout_secs('participant_history_secs'))) then 'driver'
  end;
  if v_role is null then
    raise exception 'Fetch request not found' using errcode = 'P0002';
  end if;

  if v_role = 'admin' then
    return jsonb_build_object('viewer', 'admin', 'request', to_jsonb(r));
  end if;

  v_live := r.closed_at is null and r.status in ('matched', 'collected', 'undeliverable');

  -- What both parties see: the job itself, never anyone's contact details.
  v_common := jsonb_build_object(
    'id', r.id, 'status', r.status, 'payment_status', r.payment_status,
    'category_slug', r.category_slug, 'item_description', r.item_description, 'size_class', r.size_class,
    'approx_dimensions_cm', r.approx_dimensions_cm, 'handling_flags', to_jsonb(r.handling_flags),
    'pickup_region', (select name from public.regions where id = r.pickup_region_id), 'pickup_area', r.pickup_area,
    'destination_region', (select name from public.regions where id = r.destination_region_id), 'destination_area', r.destination_area,
    'ferry_required', r.ferry_required,
    'scheduling_mode', r.scheduling_mode, 'needed_by', r.needed_by, 'flexible_until', r.flexible_until, 'expires_at', r.expires_at,
    'created_at', r.created_at, 'claimed_at', r.claimed_at, 'collected_at', r.collected_at, 'delivered_at', r.delivered_at,
    'cancelled_at', r.cancelled_at, 'cancel_reason', r.cancel_reason,
    'cancel_requested_at', r.cancel_requested_at, 'cancel_request_reason', r.cancel_request_reason,
    'undeliverable_at', r.undeliverable_at, 'undeliverable_reason', r.undeliverable_reason, 'undeliverable_note', r.undeliverable_note,
    'returned_at', r.returned_at, 'return_outcome', r.return_outcome, 'fault_party', r.fault_party,
    'return_fee_pence', r.return_fee_pence, 'closed_at', r.closed_at);

  if v_role = 'requester' then
    if r.driver_id is not null then
      select jsonb_build_object('first_name', nullif(split_part(coalesce(p.full_name, ''), ' ', 1), ''), 'vehicle_class', dp.vehicle_class)
        into v_driver
        from public.profiles p left join public.driver_profiles dp on dp.id = p.id where p.id = r.driver_id;
    end if;
    return jsonb_build_object('viewer', 'requester', 'request', v_common || jsonb_build_object(
      'pickup_name', r.pickup_name, 'pickup_location', r.pickup_location, 'pickup_notes', r.pickup_notes,
      'destination_address', r.destination_address, 'delivery_notes', r.delivery_notes,
      'safe_place_allowed', r.safe_place_allowed, 'safe_place_note', r.safe_place_note,
      'contact_phone', r.contact_phone, 'share_phone_with_driver', r.share_phone_with_driver,
      'base_fee_pence', r.base_fee_pence, 'ferry_supplement_pence', r.ferry_supplement_pence,
      'waiting_fee_pence', r.waiting_fee_pence, 'total_fee_pence', r.total_fee_pence,
      'min_fee_applied_pence', r.min_fee_applied_pence, 'return_max_pence', r.return_max_pence,
      'resolution_capture_pence', r.resolution_capture_pence,
      'driver', v_driver));
  end if;

  -- The assigned driver.
  select nullif(split_part(coalesce(p.full_name, ''), ' ', 1), '') into v_requester_first from public.profiles p where p.id = r.customer_id;
  v_common := v_common || jsonb_build_object(
    'requester_first_name', v_requester_first,
    'driver_pay_pence', case when r.base_fee_pence is null then null
                             else r.base_fee_pence + r.ferry_supplement_pence + coalesce(r.waiting_fee_pence, 0) + coalesce(r.return_fee_pence, 0) end);

  v_addr_ok := r.closed_at is null
            or r.closed_at > now() - make_interval(secs => public.fetch_v2_timeout_secs('exact_address_secs'));
  if v_addr_ok then
    v_common := v_common || jsonb_build_object(
      'pickup_name', r.pickup_name, 'pickup_location', r.pickup_location, 'pickup_notes', r.pickup_notes,
      'destination_address', r.destination_address, 'delivery_notes', r.delivery_notes,
      'safe_place_allowed', r.safe_place_allowed, 'safe_place_note', r.safe_place_note);
  end if;
  if v_live and r.share_phone_with_driver then
    v_common := v_common || jsonb_build_object('contact_phone', r.contact_phone);
  end if;

  return jsonb_build_object('viewer', 'driver', 'request', v_common,
    'addresses_visible', v_addr_ok, 'phone_shared', v_live and r.share_phone_with_driver);
end;
$$;

alter table public.fetch_member_stats drop constraint if exists fetch_member_stats_restriction_reason;
alter table public.fetch_member_stats drop column if exists restricted_at, drop column if exists restricted_reason;

commit;
