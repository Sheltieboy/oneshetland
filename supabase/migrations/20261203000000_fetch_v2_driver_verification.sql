-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Fetch v2 — Step 6: driver verification (docs/FETCH_V2_IMPLEMENTATION.md, Step 6).
--
-- Approval is the server's. A member APPLIES (become-driver → fetch_v2_apply_driver: pending), SUBMITS evidence (signed upload →
-- fetch_v2_submit_evidence: submitted), a REVIEWER approves or rejects each piece (fetch_v2_review_evidence), and a reviewer
-- DECIDES the driver (fetch_v2_decide_driver: approved / rejected / suspended / reinstated). Expiry is the sweep's.
--
-- Two separate states:
--   · ACCOUNT  driver_profiles.driver_status   not_applied → pending → approved | rejected; approved ↔ suspended
--   · EVIDENCE driver_verification_items.status submitted → verified | rejected; verified → expired | superseded
-- verification_ok_until is DERIVED (fetch_v2_verification_state): the earliest expiry among the current verified evidence for every
-- active REQUIRED requirement of the driver's vehicle class, 'infinity' when none of it expires, NULL when anything is missing,
-- awaiting review, rejected or expired — and NULL unless the driver is approved. The claim gate reads it live, never a cache.
--
-- What evidence is required stays DATA (driver_verification_requirements). This migration adds no legal statement.
--
-- Nobody — not a driver, not an admin's browser session — writes approval, verification, decision or vehicle-capacity fields
-- directly any more: those writes are refused loudly. Every material action goes through an audited function and is recorded in
-- driver_verification_events (append-only; the document's content never enters it). Events that should reach the driver carry a
-- notify_kind: an outbox the notification step drains. Nothing here sends anything.
--
-- Documents: the private fetch-driver-verification bucket is now reachable ONLY by the service role. Uploads go to a server-
-- generated path through a short-lived signed upload; reading is by short-lived signed link from the edge function. No client
-- role — admins included — can list, read or delete the bucket directly any more.
--
-- Rollback: supabase/rollbacks/20261203000000_fetch_v2_driver_verification.down.sql
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
begin;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 0. Configuration
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
insert into public.admin_config (key, value, category, description, is_secret) values
  ('fetch.timeouts.verification_reminder_secs', '2592000', 'fetch', 'Fetch v2: drivers are reminded when a piece of verified evidence expires within this window.', false),
  ('fetch.timeouts.verification_upload_secs',   '900',     'fetch', 'Fetch v2: a driver''s signed evidence upload must be submitted within this time, or it is discarded.', false)
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
  ('fetch_v2_apply',        86400, 10, 'Fetch v2 driver applications per member per day'),
  ('fetch_v2_verification',  3600, 60, 'Fetch v2 driver verification actions (uploads, submissions, views) per hour')
on conflict (action) do nothing;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. Schema
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- Evidence that belongs to a particular vehicle (its details, its insurance) must be supplied again when the vehicle changes.
alter table public.driver_verification_requirements add column if not exists per_vehicle boolean not null default false;
update public.driver_verification_requirements set per_vehicle = true where evidence_kind in ('vehicle', 'insurance') and not per_vehicle;

-- Each submission of a kind is a new item (a version); nothing is overwritten. At most one awaiting review and one verified per kind.
alter table public.driver_verification_items add column if not exists version integer not null default 1;
alter table public.driver_verification_items
  drop constraint if exists driver_verification_items_version_check,
  add constraint driver_verification_items_version_check check (version >= 1);
create unique index if not exists driver_verification_items_one_submitted on public.driver_verification_items (driver_id, kind) where status = 'submitted';
create unique index if not exists driver_verification_items_one_verified  on public.driver_verification_items (driver_id, kind) where status = 'verified';
create unique index if not exists driver_verification_items_version_key   on public.driver_verification_items (driver_id, kind, version);

-- A lapsed driver's live job is surfaced to a person as its own kind of issue.
alter table public.fetch_issues drop constraint if exists fetch_issues_kind_check;
alter table public.fetch_issues add constraint fetch_issues_kind_check check (kind in ('not_delivered', 'damaged', 'wrong_item', 'driver_conduct',
  'requester_conduct', 'payment', 'safety', 'cancellation', 'return', 'other', 'driver_verification'));

-- A signed upload the server has issued: the path is the server's, the item id is fixed in advance, and it lapses.
create table if not exists public.driver_verification_uploads (
  id           uuid primary key default gen_random_uuid(),
  driver_id    uuid not null references public.profiles (id) on delete cascade,
  item_id      uuid not null unique,
  kind         text not null check (kind ~ '^[a-z][a-z_]{1,40}$'),
  storage_path text not null unique,
  mime_type    text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf')),
  size_bytes   integer not null check (size_bytes between 1 and 10485760),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  check (storage_path = 'drivers/' || driver_id::text || '/' || item_id::text || '/' || split_part(storage_path, '/', 4)),
  check (split_part(storage_path, '/', 4) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|heic|heif|pdf)$')
);
create index if not exists driver_verification_uploads_driver_idx on public.driver_verification_uploads (driver_id, created_at);

-- The audit trail. Append-only; the driver's notifications are drained from it (notify_kind / notified_at).
create table if not exists public.driver_verification_events (
  id          bigserial primary key,
  driver_id   uuid references public.profiles (id) on delete cascade,
  item_id     uuid references public.driver_verification_items (id) on delete set null,
  actor_id    uuid references public.profiles (id) on delete set null,
  actor_role  text not null check (actor_role in ('driver', 'admin', 'system')),
  event       text not null check (event in (
                'application_submitted', 'application_resubmitted', 'application_updated', 'vehicle_changed',
                'evidence_submitted', 'evidence_replaced', 'evidence_approved', 'evidence_rejected', 'replacement_requested',
                'evidence_expiring', 'evidence_expired', 'evidence_viewed', 'evidence_file_deleted',
                'verification_valid', 'verification_lapsed',
                'driver_approved', 'driver_rejected', 'driver_suspended', 'driver_reinstated', 'requirement_changed')),
  reason      text check (reason is null or char_length(reason) <= 1000),
  detail      jsonb not null default '{}' check (jsonb_typeof(detail) = 'object'),
  notify_kind text check (notify_kind is null or notify_kind in ('evidence_expiring', 'evidence_expired', 'evidence_rejected',
                'replacement_required', 'driver_approved', 'driver_rejected', 'driver_suspended', 'driver_reinstated')),
  notified_at timestamptz,
  created_at  timestamptz not null default now(),
  check (notified_at is null or notify_kind is not null),
  check (driver_id is not null or event = 'requirement_changed')
);
create index if not exists driver_verification_events_driver_idx on public.driver_verification_events (driver_id, id);
create index if not exists driver_verification_events_item_idx   on public.driver_verification_events (item_id, event);
create index if not exists driver_verification_events_outbox_idx on public.driver_verification_events (id) where notify_kind is not null and notified_at is null;

-- Nothing edits or removes history. Exceptions: the cascade when the member's account is deleted (arrives from inside the
-- foreign-key trigger), and the outbox stamping notified_at once.
create or replace function public.tg_driver_verification_event_append_only() returns trigger
  language plpgsql set search_path = public, pg_temp
as $$
begin
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' and old.notified_at is null and new.notified_at is not null
     and (to_jsonb(new) - 'notified_at') = (to_jsonb(old) - 'notified_at') then
    return new;
  end if;
  raise exception 'Driver verification history is append-only' using errcode = '42501';
end;
$$;
drop trigger if exists driver_verification_events_append_only on public.driver_verification_events;
create trigger driver_verification_events_append_only before update or delete on public.driver_verification_events
  for each row execute function public.tg_driver_verification_event_append_only();

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. driver_profiles: approval, verification, decision and vehicle capacity are the server's — refused loudly to every client
--    session, administrators' included (the old admin screens wrote driver_status directly; they now must use the audited actions).
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.tg_fetch_v2_driver_server_columns() returns trigger
  language plpgsql set search_path = public
as $$
begin
  -- SECURITY INVOKER on purpose (see tg_is_trusted_writer): current_user is the role actually writing. Unlike that helper, an
  -- administrator's browser session is NOT trusted here.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.release_count := 0; new.fault_return_count := 0; new.last_release_at := null;
    new.decision_reason := null; new.decided_by := null; new.decided_at := null; new.verification_ok_until := null;
    new.vehicle_class := null; new.max_size_class := null; new.can_two_person_lift := false; new.vehicle_reg := null;
    return new;
  end if;
  if new.driver_status         is distinct from old.driver_status
     or new.verification_ok_until is distinct from old.verification_ok_until
     or new.decision_reason    is distinct from old.decision_reason
     or new.decided_by         is distinct from old.decided_by
     or new.decided_at         is distinct from old.decided_at
     or new.vehicle_class      is distinct from old.vehicle_class
     or new.max_size_class     is distinct from old.max_size_class
     or new.can_two_person_lift is distinct from old.can_two_person_lift
     or new.vehicle_reg        is distinct from old.vehicle_reg then
    raise exception 'Driver approval, verification and vehicle details change only through Fetch''s audited actions'
      using errcode = '42501';
  end if;
  new.release_count := old.release_count; new.fault_return_count := old.fault_return_count; new.last_release_at := old.last_release_at;
  return new;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. Helpers
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- Who may see and decide driver evidence. Today: platform administrators. This is the one place to narrow it to a dedicated
-- reviewer permission later, so not every future administrator has to see driving licences.
create or replace function public.fetch_v2_is_verification_reviewer(p_user uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp
as $$ select exists (select 1 from public.profiles where id = p_user and (role = 'admin' or is_platform_owner)); $$;

create or replace function public.fetch_v2_vlog(p_driver uuid, p_item uuid, p_actor uuid, p_role text, p_event text,
                                                p_reason text default null, p_detail jsonb default '{}', p_notify text default null)
  returns void
  language sql security definer set search_path = public, pg_temp
as $$
  insert into public.driver_verification_events (driver_id, item_id, actor_id, actor_role, event, reason, detail, notify_kind)
  values (p_driver, p_item, p_actor, p_role, p_event, left(p_reason, 1000), coalesce(p_detail, '{}'), p_notify);
$$;

-- The live verification state of a driver's evidence, independent of their account status.
--   ok_until: earliest expiry among the current verified evidence of every active required kind ('infinity' if none expire);
--             null when anything required is unsatisfied, when there is no vehicle class, or when the class requires nothing.
--   missing:  required kinds not currently satisfied. expired: those whose last verified evidence has expired.
create or replace function public.fetch_v2_verification_state(p_driver uuid)
  returns table (ok_until timestamptz, missing text[], expired text[])
  language sql stable security definer set search_path = public, pg_temp
as $$
  with dp as (select vehicle_class from public.driver_profiles where id = p_driver),
  req as (
    select r.evidence_kind as kind, r.needs_expiry
      from public.driver_verification_requirements r join dp on r.vehicle_class = dp.vehicle_class
     where r.active and r.required),
  cur as (
    select distinct on (i.kind) i.kind, i.expires_at
      from public.driver_verification_items i
     where i.driver_id = p_driver and i.status = 'verified'
     order by i.kind, i.verified_at desc),
  judged as (
    select req.kind, cur.expires_at,
           cur.kind is not null and (not req.needs_expiry or cur.expires_at is not null) and (cur.expires_at is null or cur.expires_at > now()) as ok,
           cur.kind is not null and cur.expires_at is not null and cur.expires_at <= now()
             or (cur.kind is null and exists (select 1 from public.driver_verification_items x where x.driver_id = p_driver
                                               and x.kind = req.kind and x.status = 'expired')) as lapsed
      from req left join cur on cur.kind = req.kind)
  select case when exists (select 1 from dp where vehicle_class is not null) and count(*) > 0 and bool_and(ok)
              then coalesce(min(expires_at), 'infinity'::timestamptz) end,
         coalesce(array_agg(kind order by kind) filter (where not ok), '{}'),
         coalesce(array_agg(kind order by kind) filter (where not ok and lapsed), '{}')
    from judged;
$$;

-- What an APPROVED driver is verified until (null for anyone not approved). The claim gate and the collection gate read this.
create or replace function public.fetch_v2_verified_until(p_driver uuid) returns timestamptz
  language sql stable security definer set search_path = public, pg_temp
as $$
  select case when dp.driver_status = 'approved' then (select s.ok_until from public.fetch_v2_verification_state(p_driver) s) end
    from public.driver_profiles dp where dp.id = p_driver;
$$;

-- Bring the stored verification_ok_until into line with the live state; record when the driver becomes valid or lapses.
create or replace function public.fetch_v2_sync_verification(p_driver uuid, p_actor uuid default null, p_role text default 'system')
  returns timestamptz
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_old timestamptz;
  v_new timestamptz := public.fetch_v2_verified_until(p_driver);
  v_missing text[];
begin
  select verification_ok_until into v_old from public.driver_profiles where id = p_driver for update;
  if not found or v_old is not distinct from v_new then
    return v_new;
  end if;
  update public.driver_profiles set verification_ok_until = v_new where id = p_driver;
  if v_old is null or v_old <= now() then
    perform public.fetch_v2_vlog(p_driver, null, p_actor, p_role, 'verification_valid', null,
      jsonb_build_object('until', case when v_new = 'infinity' then null else v_new end));
  elsif v_new is null or v_new <= now() then
    select s.missing into v_missing from public.fetch_v2_verification_state(p_driver) s;
    perform public.fetch_v2_vlog(p_driver, null, p_actor, p_role, 'verification_lapsed', null,
      jsonb_build_object('missing', to_jsonb(coalesce(v_missing, '{}'))));
  end if;
  return v_new;
end;
$$;

-- One open driver_verification issue per live job.
create or replace function public.fetch_v2_open_verification_issue(p_request uuid, p_detail text) returns boolean
  language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.fetch_issues where request_id = p_request and kind = 'driver_verification' and status = 'open') then
    return false;
  end if;
  insert into public.fetch_issues (request_id, reporter_role, kind, detail) values (p_request, 'system', 'driver_verification', p_detail);
  return true;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. The claim gate (Step 3's fetch_v2_driver_problem, now reading verification live)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_driver_problem(p_driver uuid) returns text
  language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when dp.id is null or dp.driver_status <> all (array['approved', 'suspended']) then 'driver_not_approved'
    when dp.driver_status = 'suspended'                                         then 'driver_suspended'
    when dp.vehicle_class is null                                               then 'driver_vehicle_missing'
    when s.ok_until is null and cardinality(s.expired) > 0                      then 'driver_verification_expired'
    when s.ok_until is null                                                     then 'driver_verification_incomplete'
    when s.ok_until <= now()                                                    then 'driver_verification_expired'
    when not dp.stripe_payouts_enabled                                          then 'driver_payouts_not_enabled'
  end
  from (select 1) one
  left join public.driver_profiles dp on dp.id = p_driver
  left join lateral public.fetch_v2_verification_state(p_driver) s on true;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 5. Application (become-driver) and vehicle
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- Apply the vehicle fields; a material change (class, registration, or a larger size) supersedes per-vehicle evidence.
create or replace function public.fetch_v2_apply_vehicle(p_driver uuid, p_actor uuid, p_role text, p jsonb) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  d          public.driver_profiles;
  v_class    text := nullif(btrim(coalesce(p ->> 'vehicle_class', '')), '');
  v_size     text := nullif(btrim(coalesce(p ->> 'max_size_class', '')), '');
  v_two      boolean := coalesce((p ->> 'can_two_person_lift')::boolean, false);
  v_reg      text := nullif(upper(regexp_replace(coalesce(p ->> 'vehicle_reg', ''), '\s+', ' ', 'g')), '');
  v_material boolean;
  v_kinds    text[];
begin
  select * into d from public.driver_profiles where id = p_driver for update;
  if v_class is null or v_class not in ('on_foot', 'bicycle', 'car', 'estate', 'van', 'pickup', 'car_with_trailer') then
    return public.fetch_v2_refuse('invalid_vehicle');
  end if;
  v_size := coalesce(v_size, 'small');
  if v_size not in ('small', 'medium', 'large', 'bulky') then return public.fetch_v2_refuse('invalid_vehicle'); end if;
  if v_class in ('on_foot', 'bicycle') then
    if v_size <> 'small' then return public.fetch_v2_refuse('size_exceeds_vehicle'); end if;
    v_reg := null;
  elsif v_reg is null or v_reg !~ '^[A-Z0-9][A-Z0-9 ]{1,9}$' then
    return public.fetch_v2_refuse('registration_required');
  end if;

  v_material := d.vehicle_class is distinct from v_class or d.vehicle_reg is distinct from v_reg
                or public.fetch_v2_size_rank(v_size) > coalesce(public.fetch_v2_size_rank(d.max_size_class), 0);
  if d.vehicle_class is not distinct from v_class and d.vehicle_reg is not distinct from v_reg
     and d.max_size_class is not distinct from v_size and d.can_two_person_lift = v_two then
    return jsonb_build_object('ok', true, 'already', true, 're_verification_required', false);
  end if;

  update public.driver_profiles set vehicle_class = v_class, max_size_class = v_size, can_two_person_lift = v_two, vehicle_reg = v_reg
   where id = p_driver;
  if v_material and d.vehicle_class is not null then
    with gone as (
      update public.driver_verification_items i set status = 'superseded'
       where i.driver_id = p_driver and i.status in ('submitted', 'verified', 'rejected', 'expired')
         and i.kind in (select evidence_kind from public.driver_verification_requirements where per_vehicle)
      returning i.kind)
    select coalesce(array_agg(distinct kind), '{}') into v_kinds from gone;
  end if;
  perform public.fetch_v2_vlog(p_driver, null, p_actor, p_role, 'vehicle_changed', null,
    jsonb_build_object('from', jsonb_build_object('vehicle_class', d.vehicle_class, 'max_size_class', d.max_size_class),
                       'to', jsonb_build_object('vehicle_class', v_class, 'max_size_class', v_size),
                       'registration_changed', d.vehicle_reg is distinct from v_reg, 'superseded', to_jsonb(coalesce(v_kinds, '{}'))),
    case when cardinality(coalesce(v_kinds, '{}')) > 0 then 'replacement_required' end);
  perform public.fetch_v2_sync_verification(p_driver, p_actor, p_role);
  return jsonb_build_object('ok', true, 'already', false, 're_verification_required', v_material and d.vehicle_class is not null,
                            'superseded', to_jsonb(coalesce(v_kinds, '{}')));
end;
$$;

-- become-driver. Only an allow-list of fields is read; status, verification, decision and review fields in the payload are ignored.
create or replace function public.fetch_v2_apply_driver(p_user uuid, p jsonb) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  d         public.driver_profiles;
  v_problem text;
  v_note    text := nullif(btrim(left(coalesce(p ->> 'statement', ''), 1000)), '');
  v_type    text := nullif(btrim(left(coalesce(p ->> 'vehicle_type', ''), 60)), '');
  v_event   text;
  v_vehicle jsonb;
begin
  perform public.fetch_v2_service_actor(p_user);
  v_problem := public.fetch_v2_member_problem(p_user);
  if v_problem is not null then return public.fetch_v2_refuse(v_problem); end if;
  if jsonb_typeof(coalesce(p, '{}')) <> 'object' then return public.fetch_v2_refuse('invalid_request'); end if;

  insert into public.driver_profiles (id) values (p_user) on conflict (id) do nothing;
  select * into d from public.driver_profiles where id = p_user for update;

  if d.driver_status = 'suspended' then return public.fetch_v2_refuse('driver_suspended'); end if;
  if d.driver_status = 'approved' then
    -- Already approved: nothing here changes. Vehicle changes go through set_vehicle, which applies re-verification.
    return jsonb_build_object('ok', true, 'already', true, 'driver_status', 'approved');
  end if;

  -- The vehicle first: a refusal there must leave nothing changed.
  if p ? 'vehicle_class' then
    v_vehicle := public.fetch_v2_apply_vehicle(p_user, p_user, 'driver', p);
    if (v_vehicle ->> 'ok')::boolean is not true then return v_vehicle; end if;
  end if;

  v_event := case d.driver_status when 'rejected' then 'application_resubmitted' when 'pending' then 'application_updated'
                                  else 'application_submitted' end;
  update public.driver_profiles
     set driver_status = 'pending', notes = coalesce(v_note, notes), vehicle_type = coalesce(v_type, vehicle_type),
         decided_by = null, decided_at = null, decision_reason = null
   where id = p_user;

  if not p ? 'vehicle_class' and nullif(btrim(coalesce(p ->> 'vehicle_reg', '')), '') is not null and d.vehicle_class is null then
    -- The original apply form (vehicle_type + vehicle_reg, no class): keep the registration; the class follows via set_vehicle.
    update public.driver_profiles set vehicle_reg = upper(btrim(left(p ->> 'vehicle_reg', 12))) where id = p_user;
  end if;

  perform public.fetch_v2_vlog(p_user, null, p_user, 'driver', v_event, null,
    jsonb_build_object('from', d.driver_status, 'vehicle_class', (select vehicle_class from public.driver_profiles where id = p_user)));
  return jsonb_build_object('ok', true, 'already', false, 'driver_status', 'pending');
end;
$$;

create or replace function public.fetch_v2_set_vehicle(p_driver uuid, p jsonb) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  perform public.fetch_v2_service_actor(p_driver);
  select driver_status into v_status from public.driver_profiles where id = p_driver;
  if v_status is null or v_status in ('not_applied', 'rejected') then return public.fetch_v2_refuse('driver_not_applied'); end if;
  if v_status = 'suspended' then return public.fetch_v2_refuse('driver_suspended'); end if;
  return public.fetch_v2_apply_vehicle(p_driver, p_driver, 'driver', coalesce(p, '{}'));
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 6. Evidence: upload → submit
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_begin_evidence_upload(p_driver uuid, p_kind text, p_mime text, p_size integer) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  d      public.driver_profiles;
  v_item uuid := gen_random_uuid();
  v_ext  text := case p_mime when 'application/pdf' then 'pdf' when 'image/jpeg' then 'jpg' when 'image/png' then 'png'
                             when 'image/webp' then 'webp' when 'image/heic' then 'heic' when 'image/heif' then 'heif' end;
  v_path text;
  v_exp  timestamptz := now() + make_interval(secs => public.fetch_v2_timeout_secs('verification_upload_secs'));
  v_id   uuid;
begin
  perform public.fetch_v2_service_actor(p_driver);
  select * into d from public.driver_profiles where id = p_driver;
  if d.id is null or d.driver_status in ('not_applied', 'rejected') then return public.fetch_v2_refuse('driver_not_applied'); end if;
  if d.driver_status = 'suspended' then return public.fetch_v2_refuse('driver_suspended'); end if;
  if d.vehicle_class is null then return public.fetch_v2_refuse('driver_vehicle_missing'); end if;
  if not exists (select 1 from public.driver_verification_requirements
                  where vehicle_class = d.vehicle_class and evidence_kind = p_kind and active) then
    return public.fetch_v2_refuse('evidence_kind_not_required');
  end if;
  if v_ext is null then return public.fetch_v2_refuse('file_type_not_allowed'); end if;
  if p_size is null or p_size < 1 then return public.fetch_v2_refuse('invalid_request'); end if;
  if p_size > 10485760 then return public.fetch_v2_refuse('file_too_large'); end if;
  if (select count(*) from public.driver_verification_uploads where driver_id = p_driver and created_at > now() - interval '1 hour') >= 10 then
    return public.fetch_v2_refuse('too_many_uploads');
  end if;
  v_path := 'drivers/' || p_driver::text || '/' || v_item::text || '/' || gen_random_uuid()::text || '.' || v_ext;
  insert into public.driver_verification_uploads (driver_id, item_id, kind, storage_path, mime_type, size_bytes, expires_at)
  values (p_driver, v_item, p_kind, v_path, p_mime, p_size, v_exp) returning id into v_id;
  return jsonb_build_object('ok', true, 'upload_id', v_id, 'storage_path', v_path, 'expires_at', v_exp);
end;
$$;

-- The edge function's view of one of the driver's own uploads, before it inspects the stored object.
create or replace function public.fetch_v2_pending_evidence_upload(p_driver uuid, p_upload uuid) returns jsonb
  language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce((select jsonb_build_object('ok', true, 'storage_path', u.storage_path, 'mime_type', u.mime_type,
                                             'consumed', u.consumed_at is not null, 'expired', u.expires_at <= now())
                     from public.driver_verification_uploads u where u.id = p_upload and u.driver_id = p_driver),
                  public.fetch_v2_refuse('not_found'));
$$;

-- The edge function has checked the stored object (it exists, its real size, its real type from the file's first bytes).
create or replace function public.fetch_v2_submit_evidence(p_driver uuid, p_upload uuid, p_size integer, p_mime text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  u         public.driver_verification_uploads;
  d         public.driver_profiles;
  v_version integer;
  v_prior   boolean;
begin
  perform public.fetch_v2_service_actor(p_driver);
  select * into u from public.driver_verification_uploads where id = p_upload and driver_id = p_driver for update;
  if u.id is null then return public.fetch_v2_refuse('not_found'); end if;
  if u.consumed_at is not null then
    return jsonb_build_object('ok', true, 'already', true, 'item_id', u.item_id, 'kind', u.kind,
      'version', (select version from public.driver_verification_items where id = u.item_id), 'status',
      (select status from public.driver_verification_items where id = u.item_id));
  end if;
  if u.expires_at <= now() then return public.fetch_v2_refuse('upload_expired'); end if;
  if p_mime is distinct from u.mime_type then return public.fetch_v2_refuse('file_type_mismatch'); end if;
  if p_size is null or p_size < 1 or p_size > 10485760 then return public.fetch_v2_refuse('file_too_large'); end if;

  select * into d from public.driver_profiles where id = p_driver for update;
  if d.driver_status not in ('pending', 'approved') then
    return public.fetch_v2_refuse(case d.driver_status when 'suspended' then 'driver_suspended' else 'driver_not_applied' end);
  end if;
  if not exists (select 1 from public.driver_verification_requirements
                  where vehicle_class = d.vehicle_class and evidence_kind = u.kind and active) then
    return public.fetch_v2_refuse('evidence_kind_not_required');
  end if;

  -- An older submission still awaiting review, or a rejected/expired one, is replaced now. A VERIFIED one keeps counting until the
  -- new one is approved (a renewal never leaves the driver unverified while it waits).
  v_prior := exists (select 1 from public.driver_verification_items where driver_id = p_driver and kind = u.kind);
  update public.driver_verification_items set status = 'superseded'
   where driver_id = p_driver and kind = u.kind and status in ('submitted', 'rejected', 'expired');
  select coalesce(max(version), 0) + 1 into v_version from public.driver_verification_items where driver_id = p_driver and kind = u.kind;

  insert into public.driver_verification_items (id, driver_id, kind, status, version) values (u.item_id, p_driver, u.kind, 'submitted', v_version);
  insert into public.driver_verification_files (item_id, storage_path, mime_type, size_bytes) values (u.item_id, u.storage_path, u.mime_type, p_size);
  update public.driver_verification_uploads set consumed_at = now() where id = u.id;
  perform public.fetch_v2_vlog(p_driver, u.item_id, p_driver, 'driver', case when v_prior then 'evidence_replaced' else 'evidence_submitted' end,
    null, jsonb_build_object('kind', u.kind, 'version', v_version));
  return jsonb_build_object('ok', true, 'already', false, 'item_id', u.item_id, 'kind', u.kind, 'version', v_version, 'status', 'submitted');
end;
$$;

-- An upload the edge refused (wrong bytes, too big) or the driver abandoned: forget it and hand back the path so the object goes too.
create or replace function public.fetch_v2_discard_evidence_upload(p_driver uuid, p_upload uuid) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_path text;
begin
  delete from public.driver_verification_uploads where id = p_upload and driver_id = p_driver and consumed_at is null
  returning storage_path into v_path;
  if v_path is null then return public.fetch_v2_refuse('not_found'); end if;
  return jsonb_build_object('ok', true, 'storage_path', v_path);
end;
$$;

-- Lapsed, never-submitted uploads (the runner removes the objects, then forgets them).
create or replace function public.fetch_v2_stale_evidence_uploads() returns table (upload_id uuid, driver_id uuid, storage_path text)
  language sql stable security definer set search_path = public, pg_temp
as $$ select id, driver_id, storage_path from public.driver_verification_uploads where consumed_at is null and expires_at < now() order by expires_at limit 200; $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 7. Review and decision (reviewers only; every outcome audited)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_require_reviewer(p_actor uuid) returns void
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not public.fetch_v2_is_verification_reviewer(p_actor) then
    raise exception 'Only an administrator can do that' using errcode = '42501';
  end if;
end;
$$;

-- p_expires_on is the date printed on the document; it is valid through the end of that day in the UK.
create or replace function public.fetch_v2_review_evidence(p_reviewer uuid, p_item uuid, p_outcome text, p_reason text default null,
                                                           p_expires_on date default null) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  i        public.driver_verification_items;
  v_needs  boolean;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_until  timestamptz;
  v_state  record;
  v_expires_at timestamptz := (p_expires_on::timestamp + interval '23:59:59') at time zone 'Europe/London';
begin
  perform public.fetch_v2_require_reviewer(p_reviewer);
  select * into i from public.driver_verification_items where id = p_item for update;
  if i.id is null then return public.fetch_v2_refuse('not_found'); end if;
  if i.driver_id = p_reviewer then return public.fetch_v2_refuse('cannot_review_own'); end if;
  if v_reason is not null and char_length(v_reason) > 1000 then return public.fetch_v2_refuse('invalid_request'); end if;
  select coalesce(bool_or(r.needs_expiry), false) into v_needs
    from public.driver_verification_requirements r join public.driver_profiles dp on dp.vehicle_class = r.vehicle_class
   where dp.id = i.driver_id and r.evidence_kind = i.kind;

  if p_outcome = 'approve' then
    if i.status = 'verified' then return jsonb_build_object('ok', true, 'already', true, 'item_id', i.id, 'status', i.status); end if;
    if i.status <> 'submitted' then return public.fetch_v2_refuse('invalid_state'); end if;
    if v_needs and v_expires_at is null then return public.fetch_v2_refuse('expiry_required'); end if;
    if v_expires_at is not null and (v_expires_at <= now() or v_expires_at > now() + interval '20 years') then
      return public.fetch_v2_refuse('expiry_out_of_range');
    end if;
    update public.driver_verification_items set status = 'superseded'
     where driver_id = i.driver_id and kind = i.kind and status = 'verified' and id <> i.id;
    update public.driver_verification_items
       set status = 'verified', verified_by = p_reviewer, verified_at = now(), expires_at = v_expires_at, decision_note = v_reason
     where id = i.id;
    perform public.fetch_v2_vlog(i.driver_id, i.id, p_reviewer, 'admin', 'evidence_approved', v_reason,
      jsonb_build_object('kind', i.kind, 'version', i.version, 'expires_on', p_expires_on));
  elsif p_outcome in ('reject', 'request_replacement') then
    if v_reason is null or char_length(v_reason) < 3 then return public.fetch_v2_refuse('reason_required'); end if;
    if i.status = 'rejected' then return jsonb_build_object('ok', true, 'already', true, 'item_id', i.id, 'status', i.status); end if;
    if i.status not in ('submitted', 'verified') then return public.fetch_v2_refuse('invalid_state'); end if;
    update public.driver_verification_items
       set status = 'rejected', verified_by = p_reviewer, verified_at = now(), decision_note = v_reason
     where id = i.id;
    perform public.fetch_v2_vlog(i.driver_id, i.id, p_reviewer, 'admin',
      case p_outcome when 'reject' then 'evidence_rejected' else 'replacement_requested' end, v_reason,
      jsonb_build_object('kind', i.kind, 'version', i.version, 'previous_status', i.status),
      case p_outcome when 'reject' then 'evidence_rejected' else 'replacement_required' end);
  else
    return public.fetch_v2_refuse('invalid_request');
  end if;

  v_until := public.fetch_v2_sync_verification(i.driver_id, p_reviewer, 'admin');
  select * into v_state from public.fetch_v2_verification_state(i.driver_id);
  return jsonb_build_object('ok', true, 'already', false, 'item_id', i.id,
    'status', (select status from public.driver_verification_items where id = i.id),
    'evidence_complete', v_state.ok_until is not null and v_state.ok_until > now(), 'missing', to_jsonb(v_state.missing));
end;
$$;

create or replace function public.fetch_v2_decide_driver(p_reviewer uuid, p_driver uuid, p_decision text, p_reason text default null) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  d        public.driver_profiles;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_to     text;
  v_event  text;
  v_state  record;
  v_live   integer;
begin
  perform public.fetch_v2_require_reviewer(p_reviewer);
  select * into d from public.driver_profiles where id = p_driver for update;
  if d.id is null then return public.fetch_v2_refuse('not_found'); end if;
  if p_driver = p_reviewer then return public.fetch_v2_refuse('cannot_review_own'); end if;
  if v_reason is not null and char_length(v_reason) > 1000 then return public.fetch_v2_refuse('invalid_request'); end if;

  v_to := case p_decision when 'approve' then 'approved' when 'reject' then 'rejected' when 'suspend' then 'suspended'
                          when 'reinstate' then 'approved' end;
  if v_to is null then return public.fetch_v2_refuse('invalid_request'); end if;
  if p_decision in ('reject', 'suspend', 'reinstate') and (v_reason is null or char_length(v_reason) < 3) then
    return public.fetch_v2_refuse('reason_required');
  end if;
  if d.driver_status = v_to and p_decision <> 'reinstate' then
    return jsonb_build_object('ok', true, 'already', true, 'driver_status', d.driver_status);
  end if;
  if not (   (p_decision = 'approve'   and d.driver_status in ('pending', 'rejected'))
          or (p_decision = 'reject'    and d.driver_status = 'pending')
          or (p_decision = 'suspend'   and d.driver_status in ('approved', 'pending'))
          or (p_decision = 'reinstate' and d.driver_status = 'suspended')) then
    return public.fetch_v2_refuse('invalid_state', jsonb_build_object('driver_status', d.driver_status));
  end if;

  if v_to = 'approved' then
    if d.vehicle_class is null then return public.fetch_v2_refuse('driver_vehicle_missing'); end if;
    select * into v_state from public.fetch_v2_verification_state(p_driver);
    if v_state.ok_until is null or v_state.ok_until <= now() then
      return public.fetch_v2_refuse('evidence_incomplete', jsonb_build_object('missing', to_jsonb(v_state.missing)));
    end if;
  end if;

  update public.driver_profiles set driver_status = v_to, decided_by = p_reviewer, decided_at = now(), decision_reason = v_reason
   where id = p_driver;
  v_event := case p_decision when 'approve' then 'driver_approved' when 'reject' then 'driver_rejected'
                             when 'suspend' then 'driver_suspended' else 'driver_reinstated' end;
  perform public.fetch_v2_vlog(p_driver, null, p_reviewer, 'admin', v_event, v_reason,
    jsonb_build_object('from', d.driver_status, 'to', v_to), v_event);
  perform public.fetch_v2_sync_verification(p_driver, p_reviewer, 'admin');
  -- Jobs already in progress are never touched here: an administrator resolves them with the existing audited job actions.
  select count(*) into v_live from public.delivery_requests
   where driver_id = p_driver and fetch_version = 2 and status in ('matched', 'collected', 'undeliverable');
  return jsonb_build_object('ok', true, 'already', false, 'driver_status', v_to, 'live_jobs', v_live);
end;
$$;

-- What evidence a vehicle class requires. Changing it re-derives every affected driver's verification at once.
create or replace function public.fetch_v2_set_requirement(p_admin uuid, p jsonb) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_class  text := p ->> 'vehicle_class';
  v_kind   text := p ->> 'evidence_kind';
  v_before public.driver_verification_requirements;
  v_after  public.driver_verification_requirements;
  v_n      integer := 0;
  v_d      uuid;
  v_old    timestamptz;
begin
  perform public.fetch_v2_require_reviewer(p_admin);
  if v_class is null or v_kind is null or v_kind !~ '^[a-z][a-z_]{1,40}$'
     or v_class not in ('on_foot', 'bicycle', 'car', 'estate', 'van', 'pickup', 'car_with_trailer') then
    return public.fetch_v2_refuse('invalid_request');
  end if;
  select * into v_before from public.driver_verification_requirements where vehicle_class = v_class and evidence_kind = v_kind for update;
  if v_before.id is null and nullif(btrim(coalesce(p ->> 'guidance_text', '')), '') is null then
    return public.fetch_v2_refuse('guidance_required');
  end if;
  insert into public.driver_verification_requirements (vehicle_class, evidence_kind, required, needs_expiry, per_vehicle, guidance_text, active)
  values (v_class, v_kind, coalesce((p ->> 'required')::boolean, true), coalesce((p ->> 'needs_expiry')::boolean, false),
          coalesce((p ->> 'per_vehicle')::boolean, false), coalesce(nullif(btrim(p ->> 'guidance_text'), ''), v_before.guidance_text),
          coalesce((p ->> 'active')::boolean, true))
  on conflict (vehicle_class, evidence_kind) do update set
    required      = coalesce((p ->> 'required')::boolean, driver_verification_requirements.required),
    needs_expiry  = coalesce((p ->> 'needs_expiry')::boolean, driver_verification_requirements.needs_expiry),
    per_vehicle   = coalesce((p ->> 'per_vehicle')::boolean, driver_verification_requirements.per_vehicle),
    guidance_text = coalesce(nullif(btrim(p ->> 'guidance_text'), ''), driver_verification_requirements.guidance_text),
    active        = coalesce((p ->> 'active')::boolean, driver_verification_requirements.active),
    updated_at    = now()
  returning * into v_after;
  perform public.fetch_v2_vlog(null, null, p_admin, 'admin', 'requirement_changed', nullif(btrim(coalesce(p ->> 'reason', '')), ''),
    jsonb_build_object('vehicle_class', v_class, 'evidence_kind', v_kind,
      'before', case when v_before.id is null then null else jsonb_build_object('required', v_before.required, 'needs_expiry', v_before.needs_expiry,
                  'per_vehicle', v_before.per_vehicle, 'active', v_before.active) end,
      'after', jsonb_build_object('required', v_after.required, 'needs_expiry', v_after.needs_expiry, 'per_vehicle', v_after.per_vehicle,
                  'active', v_after.active)));
  for v_d, v_old in select id, verification_ok_until from public.driver_profiles where vehicle_class = v_class loop
    if public.fetch_v2_sync_verification(v_d, p_admin, 'admin') is distinct from v_old then v_n := v_n + 1; end if;
  end loop;
  return jsonb_build_object('ok', true, 'drivers_affected', v_n);
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 8. Documents: who may get a short-lived link, and deleting a file without deleting the record
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- The storage path for a signed link. 'driver' = the driver's own current evidence; 'reviewer' = any (viewing is audited);
-- 'delete' = a reviewer about to remove the file. Paths never leave the server.
create or replace function public.fetch_v2_evidence_file_for(p_actor uuid, p_item uuid, p_purpose text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  i public.driver_verification_items;
  f public.driver_verification_files;
begin
  select * into i from public.driver_verification_items where id = p_item;
  if p_purpose = 'driver' then
    if i.id is null or i.driver_id is distinct from p_actor or i.status = 'superseded' then return public.fetch_v2_refuse('not_found'); end if;
  elsif p_purpose in ('reviewer', 'delete') then
    perform public.fetch_v2_require_reviewer(p_actor);
    if i.id is null then return public.fetch_v2_refuse('not_found'); end if;
  else
    return public.fetch_v2_refuse('invalid_request');
  end if;
  select * into f from public.driver_verification_files where item_id = i.id order by uploaded_at desc limit 1;
  if f.id is null then return public.fetch_v2_refuse('file_deleted'); end if;
  if p_purpose = 'reviewer' then
    perform public.fetch_v2_vlog(i.driver_id, i.id, p_actor, 'admin', 'evidence_viewed', null, jsonb_build_object('kind', i.kind, 'version', i.version));
  end if;
  return jsonb_build_object('ok', true, 'storage_path', f.storage_path, 'mime_type', f.mime_type);
end;
$$;

-- Called after the object has been removed from storage. The item, its review and its history remain; the record says the file went.
create or replace function public.fetch_v2_record_evidence_file_deleted(p_admin uuid, p_item uuid, p_reason text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  i        public.driver_verification_items;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_n      integer;
begin
  perform public.fetch_v2_require_reviewer(p_admin);
  if v_reason is null or char_length(v_reason) < 3 or char_length(v_reason) > 500 then return public.fetch_v2_refuse('reason_required'); end if;
  select * into i from public.driver_verification_items where id = p_item for update;
  if i.id is null then return public.fetch_v2_refuse('not_found'); end if;
  delete from public.driver_verification_files where item_id = i.id;
  get diagnostics v_n = row_count;
  if v_n = 0 and i.file_deleted_at is not null then return jsonb_build_object('ok', true, 'already', true); end if;
  update public.driver_verification_items
     set file_deleted_at = coalesce(file_deleted_at, now()), file_deleted_by = p_admin, file_deletion_reason = v_reason
   where id = i.id;
  perform public.fetch_v2_vlog(i.driver_id, i.id, p_admin, 'admin', 'evidence_file_deleted', v_reason,
    jsonb_build_object('kind', i.kind, 'version', i.version, 'status', i.status));
  return jsonb_build_object('ok', true, 'already', false);
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 9. Read models (no storage paths, no reviewer identities for the driver)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_verification_summary(p_driver uuid) returns jsonb
  language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'driver_status', coalesce(dp.driver_status, 'not_applied'),
    'decision_reason', case when dp.driver_status in ('rejected', 'suspended') then dp.decision_reason end,
    'vehicle', jsonb_build_object('vehicle_class', dp.vehicle_class, 'max_size_class', dp.max_size_class,
                                  'can_two_person_lift', coalesce(dp.can_two_person_lift, false), 'has_registration', dp.vehicle_reg is not null),
    'verified_until', case when public.fetch_v2_verified_until(p_driver) = 'infinity' then null
                           else (public.fetch_v2_verified_until(p_driver) at time zone 'Europe/London')::date end,
    'verified', coalesce(public.fetch_v2_verified_until(p_driver) > now(), false),
    'can_claim', public.fetch_v2_driver_problem(p_driver) is null,
    'claim_problem', public.fetch_v2_driver_problem(p_driver),
    'requirements', coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', r.evidence_kind, 'required', r.required, 'needs_expiry', r.needs_expiry, 'guidance', r.guidance_text,
        'current', (select jsonb_build_object('item_id', i.id, 'status', i.status, 'version', i.version, 'submitted_at', i.submitted_at,
                             'reviewed_at', i.verified_at, 'expires_on', (i.expires_at at time zone 'Europe/London')::date,
                             'note', case when i.status = 'rejected' then i.decision_note end)
                      from public.driver_verification_items i
                     where i.driver_id = p_driver and i.kind = r.evidence_kind and i.status <> 'superseded'
                     order by (i.status = 'verified') desc, i.version desc limit 1),
        'awaiting_review', (select jsonb_build_object('item_id', i.id, 'version', i.version, 'submitted_at', i.submitted_at)
                              from public.driver_verification_items i
                             where i.driver_id = p_driver and i.kind = r.evidence_kind and i.status = 'submitted'))
        order by r.required desc, r.evidence_kind)
        from public.driver_verification_requirements r where r.vehicle_class = dp.vehicle_class and r.active), '[]'))
  from (select 1) one left join public.driver_profiles dp on dp.id = p_driver;
$$;

-- The signed-in driver's own view (no edge function needed to read it).
create or replace function public.fetch_v2_my_verification() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  perform public.fetch_v2_require();
  return public.fetch_v2_verification_summary(auth.uid());
end;
$$;

create or replace function public.fetch_v2_verification_queue(p_reviewer uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  perform public.fetch_v2_require_reviewer(p_reviewer);
  return jsonb_build_object(
    'awaiting_review', coalesce((select jsonb_agg(jsonb_build_object('item_id', i.id, 'driver_id', i.driver_id,
        'driver_first_name', nullif(split_part(coalesce(p.full_name, ''), ' ', 1), ''), 'kind', i.kind, 'version', i.version,
        'submitted_at', i.submitted_at, 'driver_status', dp.driver_status) order by i.submitted_at)
      from public.driver_verification_items i join public.profiles p on p.id = i.driver_id
      left join public.driver_profiles dp on dp.id = i.driver_id where i.status = 'submitted'), '[]'),
    'pending_applications', coalesce((select jsonb_agg(jsonb_build_object('driver_id', dp.id, 'vehicle_class', dp.vehicle_class,
        'evidence_complete', s.ok_until is not null, 'missing', to_jsonb(s.missing), 'applied_at', dp.updated_at) order by dp.updated_at)
      from public.driver_profiles dp cross join lateral public.fetch_v2_verification_state(dp.id) s where dp.driver_status = 'pending'), '[]'),
    'lapsed_with_live_jobs', coalesce((select jsonb_agg(distinct d.driver_id)
      from public.delivery_requests d where d.fetch_version = 2 and d.status in ('matched', 'collected', 'undeliverable')
       and d.driver_id is not null and public.fetch_v2_driver_problem(d.driver_id) in
           ('driver_verification_expired', 'driver_verification_incomplete', 'driver_suspended', 'driver_not_approved')), '[]'));
end;
$$;

create or replace function public.fetch_v2_driver_verification_record(p_reviewer uuid, p_driver uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  perform public.fetch_v2_require_reviewer(p_reviewer);
  if not exists (select 1 from public.driver_profiles where id = p_driver) then return public.fetch_v2_refuse('not_found'); end if;
  return public.fetch_v2_verification_summary(p_driver) || jsonb_build_object(
    'decided_at', (select decided_at from public.driver_profiles where id = p_driver),
    'decision_reason', (select decision_reason from public.driver_profiles where id = p_driver),
    'items', coalesce((select jsonb_agg(jsonb_build_object('item_id', i.id, 'kind', i.kind, 'version', i.version, 'status', i.status,
        'submitted_at', i.submitted_at, 'reviewed_by', i.verified_by, 'reviewed_at', i.verified_at, 'expires_at', i.expires_at,
        'note', i.decision_note, 'file_present', exists (select 1 from public.driver_verification_files f where f.item_id = i.id),
        'file_deleted_at', i.file_deleted_at) order by i.kind, i.version desc)
      from public.driver_verification_items i where i.driver_id = p_driver), '[]'),
    'history', coalesce((select jsonb_agg(jsonb_build_object('event', e.event, 'at', e.created_at, 'actor_role', e.actor_role,
        'actor_id', e.actor_id, 'item_id', e.item_id, 'reason', e.reason, 'detail', e.detail) order by e.id desc)
      from (select * from public.driver_verification_events where driver_id = p_driver order by id desc limit 200) e), '[]'),
    'live_jobs', (select count(*) from public.delivery_requests where driver_id = p_driver and fetch_version = 2
                   and status in ('matched', 'collected', 'undeliverable')));
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 10. The expiry sweep (repeat-safe; it never touches a job, only records and surfaces)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_verification_sweep() returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_expired  integer := 0;
  v_expiring integer := 0;
  v_synced   integer := 0;
  v_issues   integer := 0;
  r          record;
begin
  for r in update public.driver_verification_items set status = 'expired'
            where status = 'verified' and expires_at is not null and expires_at <= now()
           returning id, driver_id, kind, version, expires_at loop
    perform public.fetch_v2_vlog(r.driver_id, r.id, null, 'system', 'evidence_expired', null,
      jsonb_build_object('kind', r.kind, 'version', r.version, 'expired_on', (r.expires_at at time zone 'Europe/London')::date), 'evidence_expired');
    v_expired := v_expired + 1;
  end loop;

  for r in select i.id, i.driver_id, i.kind, i.version, i.expires_at from public.driver_verification_items i
            where i.status = 'verified' and i.expires_at is not null
              and i.expires_at <= now() + make_interval(secs => public.fetch_v2_timeout_secs('verification_reminder_secs'))
              and not exists (select 1 from public.driver_verification_events e where e.item_id = i.id and e.event = 'evidence_expiring') loop
    perform public.fetch_v2_vlog(r.driver_id, r.id, null, 'system', 'evidence_expiring', null,
      jsonb_build_object('kind', r.kind, 'version', r.version, 'expires_on', (r.expires_at at time zone 'Europe/London')::date), 'evidence_expiring');
    v_expiring := v_expiring + 1;
  end loop;

  for r in select id from public.driver_profiles where verification_ok_until is distinct from public.fetch_v2_verified_until(id) loop
    perform public.fetch_v2_sync_verification(r.id);
    v_synced := v_synced + 1;
  end loop;

  -- A driver who can no longer take new jobs may still hold live ones: a person sees each, once.
  for r in select d.id from public.delivery_requests d
            where d.fetch_version = 2 and d.status in ('matched', 'collected', 'undeliverable') and d.driver_id is not null
              and public.fetch_v2_driver_problem(d.driver_id) in
                  ('driver_verification_expired', 'driver_verification_incomplete', 'driver_suspended', 'driver_not_approved') loop
    if public.fetch_v2_open_verification_issue(r.id, 'The assigned driver''s verification is no longer current. They may finish a job already collected; collection of a job not yet collected is blocked until this is resolved.') then
      v_issues := v_issues + 1;
    end if;
  end loop;

  return jsonb_build_object('expired', v_expired, 'expiring', v_expiring, 'drivers_synced', v_synced, 'issues_opened', v_issues);
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 11. Collection requires current verification (Step 5's function, plus the verification check)
--     After collection nothing is gated: the driver finishes, or returns, the job they hold.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_mark_collected(p_request uuid) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r       public.delivery_requests;
  v_uid   uuid := auth.uid();
  v_hold  record;
  v_fee   integer;
  v_secs  integer;
  v_until timestamptz;
begin
  perform public.fetch_v2_require();
  r := public.fetch_v2_lock(p_request);
  if r.driver_id is distinct from v_uid then raise exception 'Fetch request not found' using errcode = 'P0002'; end if;
  if r.status = 'collected' then
    return public.fetch_v2_ok(r, jsonb_build_object('already', true, 'waiting_fee_pence', r.waiting_fee_pence));
  end if;
  if r.cancel_requested_at is not null then return public.fetch_v2_refuse('cancellation_pending'); end if;
  if not public.fetch_v2_transition_allowed(r.status, 'collected', 'driver') then return public.fetch_v2_refuse('invalid_transition'); end if;

  -- VERIFICATION GATE: the driver's licence, insurance and vehicle evidence must be current to take the item. The job is not
  -- returned to the board automatically; a person resolves it (driver renews, or an administrator returns it to the board).
  v_until := public.fetch_v2_verified_until(v_uid);
  if v_until is null or v_until <= now() then
    perform public.fetch_v2_open_verification_issue(r.id, 'Collection was refused: the assigned driver''s verification is not current.');
    return public.fetch_v2_refuse('driver_verification_expired');
  end if;

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

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 12. Row-level security, storage and grants
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
alter table public.driver_verification_uploads enable row level security;
alter table public.driver_verification_events  enable row level security;
revoke all on public.driver_verification_uploads, public.driver_verification_events from public, anon, authenticated;
grant select on public.driver_verification_events to authenticated;
grant all on public.driver_verification_uploads, public.driver_verification_events to service_role;
grant usage on sequence public.driver_verification_events_id_seq to service_role;

drop policy if exists "Verification events: reviewers" on public.driver_verification_events;
create policy "Verification events: reviewers" on public.driver_verification_events for select to authenticated
  using (public.fetch_v2_is_verification_reviewer(auth.uid()));

-- Items and files: reviewers only by table; the driver reads their own status through fetch_v2_my_verification (no reviewer ids).
drop policy if exists "Verification items: owner and admins" on public.driver_verification_items;
drop policy if exists "Verification items: reviewers" on public.driver_verification_items;
create policy "Verification items: reviewers" on public.driver_verification_items for select to authenticated
  using (public.fetch_v2_is_verification_reviewer(auth.uid()));
drop policy if exists "Verification files: admins only" on public.driver_verification_files;
drop policy if exists "Verification files: reviewers" on public.driver_verification_files;
create policy "Verification files: reviewers" on public.driver_verification_files for select to authenticated
  using (public.fetch_v2_is_verification_reviewer(auth.uid()));

-- The bucket: no client role reads, lists or deletes it — administrators included. Signed links from the edge only.
drop policy if exists "fetch-driver-verification read" on storage.objects;
drop policy if exists "fetch-driver-verification delete" on storage.objects;

revoke all on function
  public.tg_driver_verification_event_append_only(), public.fetch_v2_is_verification_reviewer(uuid),
  public.fetch_v2_vlog(uuid, uuid, uuid, text, text, text, jsonb, text),
  public.fetch_v2_verification_state(uuid), public.fetch_v2_verified_until(uuid), public.fetch_v2_sync_verification(uuid, uuid, text),
  public.fetch_v2_open_verification_issue(uuid, text), public.fetch_v2_apply_vehicle(uuid, uuid, text, jsonb),
  public.fetch_v2_apply_driver(uuid, jsonb), public.fetch_v2_set_vehicle(uuid, jsonb),
  public.fetch_v2_begin_evidence_upload(uuid, text, text, integer), public.fetch_v2_submit_evidence(uuid, uuid, integer, text),
  public.fetch_v2_discard_evidence_upload(uuid, uuid), public.fetch_v2_stale_evidence_uploads(), public.fetch_v2_require_reviewer(uuid),
  public.fetch_v2_pending_evidence_upload(uuid, uuid),
  public.fetch_v2_review_evidence(uuid, uuid, text, text, date), public.fetch_v2_decide_driver(uuid, uuid, text, text),
  public.fetch_v2_set_requirement(uuid, jsonb), public.fetch_v2_evidence_file_for(uuid, uuid, text),
  public.fetch_v2_record_evidence_file_deleted(uuid, uuid, text), public.fetch_v2_verification_summary(uuid),
  public.fetch_v2_my_verification(), public.fetch_v2_verification_queue(uuid), public.fetch_v2_driver_verification_record(uuid, uuid),
  public.fetch_v2_verification_sweep()
  from public, anon, authenticated;
grant execute on function
  public.fetch_v2_is_verification_reviewer(uuid), public.fetch_v2_verification_state(uuid), public.fetch_v2_verified_until(uuid),
  public.fetch_v2_sync_verification(uuid, uuid, text), public.fetch_v2_apply_driver(uuid, jsonb), public.fetch_v2_set_vehicle(uuid, jsonb),
  public.fetch_v2_begin_evidence_upload(uuid, text, text, integer), public.fetch_v2_submit_evidence(uuid, uuid, integer, text),
  public.fetch_v2_discard_evidence_upload(uuid, uuid), public.fetch_v2_stale_evidence_uploads(), public.fetch_v2_pending_evidence_upload(uuid, uuid),
  public.fetch_v2_review_evidence(uuid, uuid, text, text, date), public.fetch_v2_decide_driver(uuid, uuid, text, text),
  public.fetch_v2_set_requirement(uuid, jsonb), public.fetch_v2_evidence_file_for(uuid, uuid, text),
  public.fetch_v2_record_evidence_file_deleted(uuid, uuid, text), public.fetch_v2_verification_summary(uuid),
  public.fetch_v2_verification_queue(uuid), public.fetch_v2_driver_verification_record(uuid, uuid), public.fetch_v2_verification_sweep()
  to service_role;
-- The reviewer check is used by RLS policies evaluated as the signed-in member.
grant execute on function public.fetch_v2_is_verification_reviewer(uuid) to authenticated;
grant execute on function public.fetch_v2_my_verification() to authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 13. End-state assertions
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
do $$
begin
  if has_function_privilege('authenticated', 'public.fetch_v2_decide_driver(uuid, uuid, text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.fetch_v2_review_evidence(uuid, uuid, text, text, date)', 'execute')
     or has_function_privilege('authenticated', 'public.fetch_v2_apply_driver(uuid, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.fetch_v2_evidence_file_for(uuid, uuid, text)', 'execute')
     or has_function_privilege('anon', 'public.fetch_v2_my_verification()', 'execute') then
    raise exception 'a driver-verification service function is reachable by a client';
  end if;
  if has_table_privilege('authenticated', 'public.driver_verification_uploads', 'select')
     or has_table_privilege('authenticated', 'public.driver_verification_events', 'insert')
     or has_table_privilege('authenticated', 'public.driver_verification_events', 'update') then
    raise exception 'driver verification tables must not be client-writable';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
              and coalesce(qual, '') || coalesce(with_check, '') like '%fetch-driver-verification%'
              and cmd in ('SELECT', 'INSERT', 'DELETE', 'ALL')) then
    raise exception 'the driver-verification bucket must have no client read, write or delete policy';
  end if;
  if exists (select 1 from storage.buckets where id = 'fetch-driver-verification' and public) then
    raise exception 'the driver-verification bucket must be private';
  end if;
end $$;

commit;
