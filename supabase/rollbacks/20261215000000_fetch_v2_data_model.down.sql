-- Reverses supabase/migrations/20261215000000_fetch_v2_data_model.sql exactly (proved by supabase/tests/fetch-v2-data-model.node.test.ts:
-- apply → roll back → the catalogue fingerprint equals the pre-migration one).
--
-- NOT a migration: it lives outside supabase/migrations so no tool ever applies it by accident. Run it by hand only with Darren's approval.
--
-- It refuses (and changes nothing) if any Fetch v2 data exists — a v2 request, an event, a message, an issue, a photo, a verification
-- record or a stored Fetch object — because dropping those columns and tables would destroy it. Export first, then decide.
-- On hosted Supabase the two storage buckets may have to be removed through the Storage API rather than SQL; the rest is plain SQL.

begin;

do $$
begin
  if exists (select 1 from public.delivery_requests where fetch_version = 2)
     or exists (select 1 from public.fetch_request_events) or exists (select 1 from public.fetch_messages)
     or exists (select 1 from public.fetch_issues) or exists (select 1 from public.fetch_request_photos)
     or exists (select 1 from public.driver_verification_items) or exists (select 1 from public.fetch_member_stats)
     or exists (select 1 from storage.objects where bucket_id in ('fetch-photos', 'fetch-driver-verification')) then
    raise exception 'Fetch v2 data exists; refusing to roll back the data model';
  end if;
end $$;

-- storage
drop policy if exists "fetch-photos read" on storage.objects;
drop policy if exists "fetch-photos update" on storage.objects;
drop policy if exists "fetch-photos delete" on storage.objects;
drop policy if exists "fetch-driver-verification read" on storage.objects;
drop policy if exists "fetch-driver-verification update" on storage.objects;
drop policy if exists "fetch-driver-verification delete" on storage.objects;
delete from storage.buckets where id in ('fetch-photos', 'fetch-driver-verification');
drop function if exists public.fetch_v2_photo_object_readable(text);

-- new tables (their policies, triggers and indexes go with them)
drop table if exists public.driver_verification_files;
drop table if exists public.driver_verification_items;
drop table if exists public.driver_verification_requirements;
drop table if exists public.fetch_member_stats;
drop table if exists public.fetch_request_photos;
drop table if exists public.fetch_issues;
drop table if exists public.fetch_messages;
drop table if exists public.fetch_request_events;
drop function if exists public.tg_driver_verification_file_deleted();
drop function if exists public.tg_fetch_photo_write_once();
drop function if exists public.tg_fetch_issue_report_immutable();
drop function if exists public.tg_fetch_message_immutable();
drop function if exists public.tg_fetch_event_append_only();

-- driver_profiles and runs
drop trigger if exists driver_profiles_v2_server_columns on public.driver_profiles;
drop function if exists public.tg_fetch_v2_driver_server_columns();
alter table public.driver_profiles drop constraint if exists driver_profiles_v2_vehicle_check;
alter table public.driver_profiles
  drop column if exists vehicle_class, drop column if exists max_size_class, drop column if exists can_two_person_lift,
  drop column if exists areas, drop column if exists release_count, drop column if exists fault_return_count,
  drop column if exists last_release_at, drop column if exists decision_reason, drop column if exists decided_by,
  drop column if exists decided_at, drop column if exists verification_ok_until;
alter table public.runs drop constraint if exists runs_max_size_class_check;
alter table public.runs drop column if exists max_size_class;

-- waiting_events and delivery_requests policies
drop policy if exists "Fetch v2 waiting events: parties read" on public.waiting_events;
drop policy if exists "Fetch v2 waiting events: server writes only (insert)" on public.waiting_events;
drop policy if exists "Fetch v2 waiting events: server writes only (update)" on public.waiting_events;
drop policy if exists "Fetch v2 waiting events: server writes only (delete)" on public.waiting_events;
drop policy if exists "Fetch v2 requests: parties only" on public.delivery_requests;
drop policy if exists "Fetch v2 requests: assigned driver reads" on public.delivery_requests;
drop policy if exists "Fetch v2 requests: server writes only (insert)" on public.delivery_requests;
drop policy if exists "Fetch v2 requests: server writes only (update)" on public.delivery_requests;
drop policy if exists "Fetch v2 requests: server writes only (delete)" on public.delivery_requests;
drop function if exists public.fetch_v2_is_party(uuid);
drop function if exists public.fetch_request_is_v1(uuid);

-- delivery_requests
drop trigger if exists delivery_requests_v2_server_managed on public.delivery_requests;
drop function if exists public.tg_fetch_v2_request_server_managed();
drop index if exists public.delivery_requests_customer_idempotency_uidx;
drop index if exists public.delivery_requests_driver_idx;
drop index if exists public.delivery_requests_v2_open_idx;
alter table public.delivery_requests
  drop constraint if exists delivery_requests_v2_shape,
  drop constraint if exists delivery_requests_v2_values,
  drop constraint if exists delivery_requests_v2_only_states,
  drop constraint if exists delivery_requests_fetch_version_check,
  drop constraint if exists delivery_requests_status_check;
alter table public.delivery_requests add constraint delivery_requests_status_check
  check (status = any (array['pending'::text, 'matched'::text, 'collected'::text, 'delivered'::text, 'cancelled'::text, 'expired'::text]));
alter table public.delivery_requests drop column if exists closed_at;
alter table public.delivery_requests
  drop column if exists fetch_version, drop column if exists item_description, drop column if exists size_class,
  drop column if exists approx_dimensions_cm, drop column if exists handling_flags, drop column if exists pickup_region_id,
  drop column if exists pickup_area, drop column if exists pickup_lat, drop column if exists pickup_lng,
  drop column if exists dest_lat, drop column if exists dest_lng, drop column if exists pickup_island_group,
  drop column if exists dest_island_group, drop column if exists ferry_required, drop column if exists ferry_supplement_pence,
  drop column if exists ferry_pricing_basis, drop column if exists min_fee_applied_pence, drop column if exists return_max_pence,
  drop column if exists flexible_until, drop column if exists safe_place_allowed, drop column if exists safe_place_note,
  drop column if exists share_phone_with_driver, drop column if exists idempotency_key, drop column if exists driver_id,
  drop column if exists vehicle_confirmed_at, drop column if exists claimed_at, drop column if exists collected_at,
  drop column if exists delivered_at, drop column if exists cancelled_at, drop column if exists cancel_reason,
  drop column if exists cancel_requested_at, drop column if exists cancel_request_reason, drop column if exists undeliverable_at,
  drop column if exists undeliverable_reason, drop column if exists undeliverable_note, drop column if exists returned_at,
  drop column if exists return_outcome, drop column if exists fault_party, drop column if exists return_road_miles,
  drop column if exists return_fee_pence, drop column if exists resolution_capture_pence,
  drop column if exists resolution_override_reason, drop column if exists resolved_by, drop column if exists resolved_at;

-- configuration
delete from public.admin_config where key in ('fetch.timeouts.payment_needed_secs', 'fetch.timeouts.cancel_request_secs',
  'fetch.timeouts.issue_window_secs', 'fetch.timeouts.address_access_secs', 'fetch.ferry.supported_island_groups');
drop function if exists public.fetch_v2_timeout_secs(text);
alter table public.regions drop constraint if exists regions_island_group_check;
alter table public.regions drop column if exists island_group;
alter table public.delivery_pricing_config drop constraint if exists delivery_pricing_config_v2_sane;
alter table public.delivery_pricing_config drop column if exists bulky_min_fee_pence, drop column if exists ferry_supplement_pence;
alter table public.delivery_pricing_config alter column price_per_mile_pence set default 95;

commit;
