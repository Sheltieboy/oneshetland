-- Fetch v2 — the authoritative data model (docs/FETCH_V2_IMPLEMENTATION.md, Step 1; sections F, G, H, J, K, S).
--
-- ADDITIVE. Every existing Fetch row becomes fetch_version = 1 and behaves exactly as it does today: no existing column, policy,
-- trigger or function changes meaning for v1 rows. Fetch v2 rows (fetch_version = 2) are created and changed only by the server
-- (SECURITY DEFINER RPCs and edge functions arriving in Steps 3–6), and are private from the moment they exist:
--
--   · a v2 request is readable by its requester, its assigned driver (until the address-access window after it closes) and
--     administrators — never by other drivers, other members or anon. The broad v1 "approved drivers read all pending" policies
--     cannot reach v2 rows because a RESTRICTIVE policy narrows them. (Removing the v1 policies themselves is Step 2, because that
--     changes how the current Fetch behaves.)
--   · no client role — administrators included — can insert, update or delete a v2 request directly; admin actions go through
--     audited server functions so history is never silently overwritten.
--   · the new v2 columns on delivery_requests and the server-maintained driver columns cannot be written by clients at all, on v1
--     rows either, so this migration opens no new client-writable money or identity field.
--   · every new table has RLS on from creation, SELECT-only grants to clients scoped by policy, and no client write grant.
--   · private storage: item, delivery and return photos are readable only by the request's parties and admins; driver
--     verification files are readable only by admins. Uploads arrive later through server-issued signed URLs.
--
-- Configuration (production values are NOT changed — new columns/keys only): 65p/mile, ×1.40, £4 minimum and the £1.50 service fee
-- stay exactly as configured; this adds the £8 bulky minimum, the flat £2 per-job ferry journey supplement (paid to the driver),
-- the agreed timeouts, the P0 ferry island groups and the region → island-group mapping.
--
-- NOT APPLIED to production. Held until iOS Build 148 has cleared App Review and Darren approves (plan S.1).
-- Reversal: supabase/rollbacks/20261128000000_fetch_v2_data_model.down.sql (proved by the isolated suite).

begin;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. Configuration
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- The obsolete 95p was still the column DEFAULT (the live row has always said 65). Only the default changes: no row is touched.
alter table public.delivery_pricing_config alter column price_per_mile_pence set default 65;

alter table public.delivery_pricing_config
  add column if not exists bulky_min_fee_pence    integer not null default 800,
  add column if not exists ferry_supplement_pence integer not null default 200;

alter table public.delivery_pricing_config
  drop constraint if exists delivery_pricing_config_v2_sane,
  add constraint delivery_pricing_config_v2_sane check (bulky_min_fee_pence >= 0 and ferry_supplement_pence >= 0);

comment on column public.delivery_pricing_config.bulky_min_fee_pence is
  'Fetch v2: minimum delivery fee for a job classified bulky (S.13). Same mileage formula; this replaces min_fee_pence for bulky.';
comment on column public.delivery_pricing_config.ferry_supplement_pence is
  'Fetch v2: flat ferry journey supplement, ONCE per job when the job involves one or more crossings — not per crossing, not by route (S.15). Paid 100% to the driver; never part of the OneShetland application fee.';

insert into public.admin_config (key, value, category, description, is_secret) values
  ('fetch.timeouts.payment_needed_secs', '7200',    'fetch', 'Fetch v2: time a requester has to complete a payment action after a driver accepts, before the job returns to the board (S.16).', false),
  ('fetch.timeouts.cancel_request_secs', '7200',    'fetch', 'Fetch v2: time a driver has to answer a requester''s cancellation request before an admin resolves it (S.16).', false),
  ('fetch.timeouts.issue_window_secs',   '259200',  'fetch', 'Fetch v2: how long after a job closes either party can report a problem (S.16).', false),
  ('fetch.timeouts.address_access_secs', '2592000', 'fetch', 'Fetch v2: how long after a job closes the assigned driver can still see its addresses (S.16).', false),
  ('fetch.ferry.supported_island_groups', 'mainland,bressay,whalsay,yell,unst,fetlar', 'fetch',
   'Fetch v2 P0 island groups (S.15). A request touching any other group is refused as not yet available.', false)
on conflict (key) do nothing;

-- Positive integer from admin_config, falling back to the agreed default — an unreadable or nonsensical value never shortens a
-- privacy window to zero or removes a deadline.
create or replace function public.fetch_v2_timeout_secs(p_name text) returns integer
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_default integer := case p_name
    when 'payment_needed_secs' then 7200
    when 'cancel_request_secs' then 7200
    when 'issue_window_secs'   then 259200
    when 'address_access_secs' then 2592000
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

-- ── regions → island groups ─────────────────────────────────────────────────────────────────────────────────────────────────
alter table public.regions add column if not exists island_group text;
alter table public.regions
  drop constraint if exists regions_island_group_check,
  add constraint regions_island_group_check check (island_group is null or island_group in
    ('mainland', 'bressay', 'whalsay', 'yell', 'unst', 'fetlar', 'out_skerries', 'fair_isle', 'foula', 'papa_stour'));
comment on column public.regions.island_group is
  'Fetch v2: which island a region is on. A job requires a ferry when pickup and destination island groups differ (S.15). Burra, Trondra and Muckle Roe are bridged to the Mainland.';

update public.regions set island_group = case slug
    when 'lerwick' then 'mainland' when 'scalloway' then 'mainland' when 'central-mainland' then 'mainland'
    when 'south-mainland' then 'mainland' when 'west-mainland' then 'mainland' when 'north-mainland' then 'mainland'
    when 'northmavine' then 'mainland' when 'burra' then 'mainland' when 'trondra' then 'mainland' when 'muckle-roe' then 'mainland'
    when 'bressay' then 'bressay' when 'whalsay' then 'whalsay' when 'yell' then 'yell' when 'unst' then 'unst'
    when 'fetlar' then 'fetlar' when 'out-skerries' then 'out_skerries' when 'fair-isle' then 'fair_isle'
    else island_group end
 where island_group is null;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. delivery_requests — the v2 request (G.1) and the v2 lifecycle (F.1)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

alter table public.delivery_requests
  add column if not exists fetch_version             smallint not null default 1,
  -- what is being moved (S.5, S.13)
  add column if not exists item_description          text,
  add column if not exists size_class                text,
  add column if not exists approx_dimensions_cm      jsonb,
  add column if not exists handling_flags            text[] not null default '{}',
  -- where (redacted display + matching; coordinates are server-measured and never shown on the board)
  add column if not exists pickup_region_id          uuid references public.regions (id),
  add column if not exists pickup_area               text,
  add column if not exists pickup_lat                numeric(9, 6),
  add column if not exists pickup_lng                numeric(9, 6),
  add column if not exists dest_lat                  numeric(9, 6),
  add column if not exists dest_lng                  numeric(9, 6),
  -- ferries (S.15)
  add column if not exists pickup_island_group       text,
  add column if not exists dest_island_group         text,
  add column if not exists ferry_required            boolean not null default false,
  add column if not exists ferry_supplement_pence    integer not null default 0,
  add column if not exists ferry_pricing_basis       text,
  -- money the requester is told about up front (K.1)
  add column if not exists min_fee_applied_pence     integer,
  add column if not exists return_max_pence          integer,
  -- timing and delivery preferences
  add column if not exists flexible_until            timestamptz,
  add column if not exists safe_place_allowed        boolean not null default false,
  add column if not exists safe_place_note           text,
  add column if not exists share_phone_with_driver   boolean not null default false,
  add column if not exists idempotency_key           text,
  -- the assignment and its timestamps
  add column if not exists driver_id                 uuid references public.profiles (id) on delete set null,
  add column if not exists vehicle_confirmed_at      timestamptz,
  add column if not exists claimed_at                timestamptz,
  add column if not exists collected_at              timestamptz,
  add column if not exists delivered_at              timestamptz,
  add column if not exists cancelled_at              timestamptz,
  add column if not exists cancel_reason             text,
  -- cancellation requested after acceptance (S.6) — a flag, not a state
  add column if not exists cancel_requested_at       timestamptz,
  add column if not exists cancel_request_reason     text,
  -- cannot deliver / return (S.7, S.14)
  add column if not exists undeliverable_at          timestamptz,
  add column if not exists undeliverable_reason      text,
  add column if not exists undeliverable_note        text,
  add column if not exists returned_at               timestamptz,
  add column if not exists return_outcome            text,
  add column if not exists fault_party               text,
  add column if not exists return_road_miles         numeric(7, 2),
  add column if not exists return_fee_pence          integer,
  add column if not exists resolution_capture_pence  integer,
  add column if not exists resolution_override_reason text,
  add column if not exists resolved_by               uuid references public.profiles (id) on delete set null,
  add column if not exists resolved_at               timestamptz;

alter table public.delivery_requests
  add column if not exists closed_at timestamptz generated always as (coalesce(delivered_at, returned_at, cancelled_at)) stored;

-- ── the lifecycle: the existing six words plus undeliverable and returned (F.1) ────────────────────────────────────────────
alter table public.delivery_requests drop constraint if exists delivery_requests_status_check;
alter table public.delivery_requests add constraint delivery_requests_status_check
  check (status = any (array['pending', 'matched', 'collected', 'delivered', 'undeliverable', 'returned', 'cancelled', 'expired']::text[]));

-- ── shape rules, all scoped to v2 rows so every existing (v1) row stays valid ──────────────────────────────────────────────
alter table public.delivery_requests
  drop constraint if exists delivery_requests_fetch_version_check,
  add constraint delivery_requests_fetch_version_check check (fetch_version in (1, 2)),
  drop constraint if exists delivery_requests_v2_only_states,
  add constraint delivery_requests_v2_only_states check (fetch_version = 2 or status not in ('undeliverable', 'returned')),
  drop constraint if exists delivery_requests_v2_values,
  add constraint delivery_requests_v2_values check (
        (size_class is null or size_class in ('small', 'medium', 'large', 'bulky'))
    and handling_flags <@ array['heavy_two_person', 'fragile', 'awkward_shape']::text[]
    and (item_description is null or char_length(btrim(item_description)) between 3 and 140)
    and (pickup_area is null or char_length(pickup_area) <= 120)
    and (safe_place_note is null or char_length(safe_place_note) <= 500)
    and (cancel_reason is null or char_length(cancel_reason) <= 500)
    and (cancel_request_reason is null or char_length(cancel_request_reason) <= 500)
    and (undeliverable_note is null or char_length(undeliverable_note) <= 1000)
    and (resolution_override_reason is null or char_length(btrim(resolution_override_reason)) between 3 and 1000)
    and (idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9_-]{8,80}$')
    and (pickup_island_group is null or pickup_island_group in ('mainland', 'bressay', 'whalsay', 'yell', 'unst', 'fetlar', 'out_skerries', 'fair_isle', 'foula', 'papa_stour'))
    and (dest_island_group   is null or dest_island_group   in ('mainland', 'bressay', 'whalsay', 'yell', 'unst', 'fetlar', 'out_skerries', 'fair_isle', 'foula', 'papa_stour'))
    and (ferry_pricing_basis is null or ferry_pricing_basis in ('flat_per_job_v1'))
    and ferry_supplement_pence >= 0
    and (min_fee_applied_pence is null or min_fee_applied_pence >= 0)
    and (return_max_pence is null or return_max_pence >= 0)
    and (return_fee_pence is null or return_fee_pence >= 0)
    and (return_road_miles is null or return_road_miles >= 0)
    and (resolution_capture_pence is null or resolution_capture_pence >= 0)
    and (undeliverable_reason is null or undeliverable_reason in
          ('recipient_absent', 'address_wrong', 'item_refused', 'not_as_described', 'requester_aborted', 'damaged',
           'vehicle_unsuitable', 'driver_unable', 'other'))
    and (return_outcome is null or return_outcome in ('returned_to_sender', 'retained_for_collection', 'disposed_with_consent'))
    and (fault_party is null or fault_party in ('not_driver', 'driver', 'undetermined'))
    -- coalesce: a missing key makes these comparisons NULL, and a NULL CHECK passes — malformed dimensions must fail
    and (approx_dimensions_cm is null or coalesce(
          jsonb_typeof(approx_dimensions_cm) = 'object'
      and jsonb_typeof(approx_dimensions_cm -> 'l') = 'number'
      and jsonb_typeof(approx_dimensions_cm -> 'w') = 'number'
      and jsonb_typeof(approx_dimensions_cm -> 'h') = 'number'
      and (approx_dimensions_cm ->> 'l')::numeric > 0 and (approx_dimensions_cm ->> 'l')::numeric <= 1000
      and (approx_dimensions_cm ->> 'w')::numeric > 0 and (approx_dimensions_cm ->> 'w')::numeric <= 1000
      and (approx_dimensions_cm ->> 'h')::numeric > 0 and (approx_dimensions_cm ->> 'h')::numeric <= 1000, false))
  ),
  drop constraint if exists delivery_requests_v2_shape,
  add constraint delivery_requests_v2_shape check (
    fetch_version = 1 or (
          item_description is not null
      and size_class is not null
      and pickup_region_id is not null
      and destination_region_id is not null
      and pickup_island_group is not null
      and dest_island_group is not null
      -- large and bulky items need dimensions (S.5, S.13); the photo is a row in fetch_request_photos, required by the create RPC
      and (size_class in ('small', 'medium') or approx_dimensions_cm is not null)
      -- ferry: required exactly when the island groups differ; a supplement only then, with its basis recorded (S.15)
      and ferry_required = (pickup_island_group <> dest_island_group)
      and ((ferry_required and ferry_supplement_pence > 0 and ferry_pricing_basis is not null)
        or (not ferry_required and ferry_supplement_pence = 0 and ferry_pricing_basis is null))
      -- an assignment exists from acceptance onwards, and never before
      and ((status in ('pending', 'expired') and driver_id is null)
        or (status in ('matched', 'collected', 'delivered', 'undeliverable', 'returned') and driver_id is not null and claimed_at is not null and vehicle_confirmed_at is not null)
        or status = 'cancelled')
      and (status not in ('collected', 'delivered', 'undeliverable', 'returned') or collected_at is not null)
      and (status <> 'delivered' or delivered_at is not null)
      and (status <> 'cancelled' or cancelled_at is not null)
      -- a cancellation request only exists on an accepted, uncollected job (or one it ended)
      and (cancel_requested_at is null or status in ('matched', 'cancelled', 'pending'))
      -- cannot deliver: a reason always; the return resolution records outcome and fault, and an override always has a reason
      and (status not in ('undeliverable', 'returned') or (undeliverable_at is not null and undeliverable_reason is not null))
      and (status <> 'returned' or (returned_at is not null and return_outcome is not null and fault_party is not null
                                    and resolved_by is not null and resolved_at is not null and resolution_capture_pence is not null))
      and (fault_party is distinct from 'undetermined' or resolution_override_reason is not null)
    )
  );

create unique index if not exists delivery_requests_customer_idempotency_uidx
  on public.delivery_requests (customer_id, idempotency_key) where idempotency_key is not null;
create index if not exists delivery_requests_driver_idx on public.delivery_requests (driver_id) where driver_id is not null;
create index if not exists delivery_requests_v2_open_idx on public.delivery_requests (status, pickup_region_id, destination_region_id)
  where fetch_version = 2;

comment on column public.delivery_requests.fetch_version is
  '1 = the original Fetch (unchanged behaviour). 2 = Fetch v2: created and changed only by the server, private to its parties.';
comment on column public.delivery_requests.closed_at is
  'When a job ended (delivered, returned or cancelled). The assigned driver''s access to its addresses lapses fetch.timeouts.address_access_secs after this.';

-- ── no client can write the v2 columns, the v2-only states, or a v2 row ────────────────────────────────────────────────────
-- SECURITY INVOKER on purpose (see tg_is_trusted_writer): current_user must stay the role that is actually writing.
create or replace function public.tg_fetch_v2_request_server_managed() returns trigger
  language plpgsql set search_path = public
as $$
declare
  v_client boolean := current_user in ('authenticated', 'anon');
begin
  if not v_client then
    return new;   -- service role, SECURITY DEFINER server functions, migrations
  end if;

  if tg_op = 'UPDATE' and old.fetch_version = 2 then
    raise exception 'A Fetch v2 request can only be changed through Fetch' using errcode = '42501';
  end if;
  if new.status in ('undeliverable', 'returned') then
    raise exception 'That status can only be set by Fetch' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    new.fetch_version := 1;
    new.item_description := null; new.size_class := null; new.approx_dimensions_cm := null; new.handling_flags := '{}';
    new.pickup_region_id := null; new.pickup_area := null;
    new.pickup_lat := null; new.pickup_lng := null; new.dest_lat := null; new.dest_lng := null;
    new.pickup_island_group := null; new.dest_island_group := null;
    new.ferry_required := false; new.ferry_supplement_pence := 0; new.ferry_pricing_basis := null;
    new.min_fee_applied_pence := null; new.return_max_pence := null;
    new.flexible_until := null; new.safe_place_allowed := false; new.safe_place_note := null;
    new.share_phone_with_driver := false; new.idempotency_key := null;
    new.driver_id := null; new.vehicle_confirmed_at := null; new.claimed_at := null; new.collected_at := null;
    new.delivered_at := null; new.cancelled_at := null; new.cancel_reason := null;
    new.cancel_requested_at := null; new.cancel_request_reason := null;
    new.undeliverable_at := null; new.undeliverable_reason := null; new.undeliverable_note := null;
    new.returned_at := null; new.return_outcome := null; new.fault_party := null;
    new.return_road_miles := null; new.return_fee_pence := null;
    new.resolution_capture_pence := null; new.resolution_override_reason := null; new.resolved_by := null; new.resolved_at := null;
  else
    new.fetch_version := old.fetch_version;
    new.item_description := old.item_description; new.size_class := old.size_class;
    new.approx_dimensions_cm := old.approx_dimensions_cm; new.handling_flags := old.handling_flags;
    new.pickup_region_id := old.pickup_region_id; new.pickup_area := old.pickup_area;
    new.pickup_lat := old.pickup_lat; new.pickup_lng := old.pickup_lng; new.dest_lat := old.dest_lat; new.dest_lng := old.dest_lng;
    new.pickup_island_group := old.pickup_island_group; new.dest_island_group := old.dest_island_group;
    new.ferry_required := old.ferry_required; new.ferry_supplement_pence := old.ferry_supplement_pence;
    new.ferry_pricing_basis := old.ferry_pricing_basis;
    new.min_fee_applied_pence := old.min_fee_applied_pence; new.return_max_pence := old.return_max_pence;
    new.flexible_until := old.flexible_until; new.safe_place_allowed := old.safe_place_allowed; new.safe_place_note := old.safe_place_note;
    new.share_phone_with_driver := old.share_phone_with_driver; new.idempotency_key := old.idempotency_key;
    new.driver_id := old.driver_id; new.vehicle_confirmed_at := old.vehicle_confirmed_at; new.claimed_at := old.claimed_at;
    new.collected_at := old.collected_at; new.delivered_at := old.delivered_at; new.cancelled_at := old.cancelled_at;
    new.cancel_reason := old.cancel_reason;
    new.cancel_requested_at := old.cancel_requested_at; new.cancel_request_reason := old.cancel_request_reason;
    new.undeliverable_at := old.undeliverable_at; new.undeliverable_reason := old.undeliverable_reason;
    new.undeliverable_note := old.undeliverable_note;
    new.returned_at := old.returned_at; new.return_outcome := old.return_outcome; new.fault_party := old.fault_party;
    new.return_road_miles := old.return_road_miles; new.return_fee_pence := old.return_fee_pence;
    new.resolution_capture_pence := old.resolution_capture_pence;
    new.resolution_override_reason := old.resolution_override_reason;
    new.resolved_by := old.resolved_by; new.resolved_at := old.resolved_at;
  end if;
  return new;
end;
$$;

drop trigger if exists delivery_requests_v2_server_managed on public.delivery_requests;
create trigger delivery_requests_v2_server_managed before insert or update on public.delivery_requests
  for each row execute function public.tg_fetch_v2_request_server_managed();

-- ── v2 privacy: RESTRICTIVE policies narrow every existing permissive policy for v2 rows only ──────────────────────────────
-- Who may read a v2 request: its requester, its assigned driver until the address window after it closes, administrators.
create or replace function public.fetch_v2_is_party(p_request uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from public.delivery_requests r
     where r.id = p_request and r.fetch_version = 2
       and (public.is_admin()
         or r.customer_id = auth.uid()
         or (r.driver_id = auth.uid()
             and (r.closed_at is null or r.closed_at > now() - make_interval(secs => public.fetch_v2_timeout_secs('address_access_secs')))))
  );
$$;

create or replace function public.fetch_request_is_v1(p_request uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp
as $$ select exists (select 1 from public.delivery_requests r where r.id = p_request and r.fetch_version = 1); $$;

drop policy if exists "Fetch v2 requests: parties only" on public.delivery_requests;
create policy "Fetch v2 requests: parties only" on public.delivery_requests as restrictive for select to anon, authenticated
  using (
    fetch_version = 1
    or customer_id = auth.uid()
    or public.is_admin()
    or (driver_id = auth.uid()
        and (closed_at is null or closed_at > now() - make_interval(secs => public.fetch_v2_timeout_secs('address_access_secs'))))
  );
-- The v1 driver policies grant reads through runs.driver_id; a v2 job is assigned through driver_id, so the assigned driver needs
-- this permissive grant (the restrictive policy above still limits it to the address window).
drop policy if exists "Fetch v2 requests: assigned driver reads" on public.delivery_requests;
create policy "Fetch v2 requests: assigned driver reads" on public.delivery_requests for select to authenticated
  using (fetch_version = 2 and driver_id = auth.uid());
drop policy if exists "Fetch v2 requests: server writes only (insert)" on public.delivery_requests;
create policy "Fetch v2 requests: server writes only (insert)" on public.delivery_requests as restrictive for insert to anon, authenticated
  with check (fetch_version = 1);
drop policy if exists "Fetch v2 requests: server writes only (update)" on public.delivery_requests;
create policy "Fetch v2 requests: server writes only (update)" on public.delivery_requests as restrictive for update to anon, authenticated
  using (fetch_version = 1) with check (fetch_version = 1);
drop policy if exists "Fetch v2 requests: server writes only (delete)" on public.delivery_requests;
create policy "Fetch v2 requests: server writes only (delete)" on public.delivery_requests as restrictive for delete to anon, authenticated
  using (fetch_version = 1);

-- waiting_events: v1 keeps today's rules; for a v2 request clients may only read (as a party), never write — arrival and
-- collection are recorded by the server (Step 3).
drop policy if exists "Fetch v2 waiting events: parties read" on public.waiting_events;
create policy "Fetch v2 waiting events: parties read" on public.waiting_events as restrictive for select to anon, authenticated
  using (public.fetch_request_is_v1(request_id) or public.fetch_v2_is_party(request_id));
drop policy if exists "Fetch v2 waiting events: server writes only (insert)" on public.waiting_events;
create policy "Fetch v2 waiting events: server writes only (insert)" on public.waiting_events as restrictive for insert to anon, authenticated
  with check (public.fetch_request_is_v1(request_id));
drop policy if exists "Fetch v2 waiting events: server writes only (update)" on public.waiting_events;
create policy "Fetch v2 waiting events: server writes only (update)" on public.waiting_events as restrictive for update to anon, authenticated
  using (public.fetch_request_is_v1(request_id)) with check (public.fetch_request_is_v1(request_id));
drop policy if exists "Fetch v2 waiting events: server writes only (delete)" on public.waiting_events;
create policy "Fetch v2 waiting events: server writes only (delete)" on public.waiting_events as restrictive for delete to anon, authenticated
  using (public.fetch_request_is_v1(request_id));

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. runs and driver_profiles (G.4, G.6)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

alter table public.runs add column if not exists max_size_class text;
alter table public.runs
  drop constraint if exists runs_max_size_class_check,
  add constraint runs_max_size_class_check check (max_size_class is null or max_size_class in ('small', 'medium', 'large', 'bulky'));

-- vehicle_type stays the free text the current apply form writes; vehicle_class is the constrained v2 field used for matching.
alter table public.driver_profiles
  add column if not exists vehicle_class         text,
  add column if not exists max_size_class        text,
  add column if not exists can_two_person_lift   boolean not null default false,
  add column if not exists areas                 uuid[] not null default '{}',
  add column if not exists release_count         integer not null default 0,
  add column if not exists fault_return_count    integer not null default 0,
  add column if not exists last_release_at       timestamptz,
  add column if not exists decision_reason       text,
  add column if not exists decided_by            uuid references public.profiles (id) on delete set null,
  add column if not exists decided_at            timestamptz,
  add column if not exists verification_ok_until timestamptz;

alter table public.driver_profiles
  drop constraint if exists driver_profiles_v2_vehicle_check,
  add constraint driver_profiles_v2_vehicle_check check (
        (vehicle_class is null or vehicle_class in ('on_foot', 'bicycle', 'car', 'estate', 'van', 'pickup', 'car_with_trailer'))
    and (max_size_class is null or max_size_class in ('small', 'medium', 'large', 'bulky'))
    -- without a motor vehicle, small items only (G.4)
    and (vehicle_class is null or vehicle_class not in ('on_foot', 'bicycle') or max_size_class is null or max_size_class = 'small')
    and cardinality(areas) <= 20
    and release_count >= 0 and fault_return_count >= 0
    and (decision_reason is null or char_length(decision_reason) <= 1000)
  );

-- The driver declares vehicle_class, max_size_class, can_two_person_lift and areas; everything else here is the server's.
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
drop trigger if exists driver_profiles_v2_server_columns on public.driver_profiles;
create trigger driver_profiles_v2_server_columns before insert or update on public.driver_profiles
  for each row execute function public.tg_fetch_v2_driver_server_columns();

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. New tables — RLS on from creation; clients read by policy and never write directly
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- ── the history: append-only (F.3) ──────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.fetch_request_events (
  id          bigint generated always as identity primary key,
  request_id  uuid not null references public.delivery_requests (id) on delete cascade,
  actor_id    uuid,                                   -- no FK: the record of who acted outlives the account
  actor_role  text not null check (actor_role in ('requester', 'driver', 'admin', 'system')),
  event       text not null check (event ~ '^[a-z][a-z_]{1,48}$'),
  from_status text check (from_status is null or from_status in ('pending', 'matched', 'collected', 'delivered', 'undeliverable', 'returned', 'cancelled', 'expired')),
  to_status   text check (to_status   is null or to_status   in ('pending', 'matched', 'collected', 'delivered', 'undeliverable', 'returned', 'cancelled', 'expired')),
  reason      text check (reason is null or char_length(reason) <= 1000),
  fault_party text check (fault_party is null or fault_party in ('not_driver', 'driver', 'undetermined')),
  metadata    jsonb not null default '{}' check (jsonb_typeof(metadata) = 'object'),
  created_at  timestamptz not null default now(),
  check (actor_role = 'system' or actor_id is not null)
);
create index if not exists fetch_request_events_request_idx on public.fetch_request_events (request_id, id);

-- Nothing edits or removes history — not the service role, not a superuser. The only deletion is the cascade when the request
-- itself is deleted (account deletion), recognisable because it arrives from inside the foreign-key trigger.
create or replace function public.tg_fetch_event_append_only() returns trigger
  language plpgsql set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'Fetch history is append-only' using errcode = '42501';
end;
$$;
drop trigger if exists fetch_request_events_append_only on public.fetch_request_events;
create trigger fetch_request_events_append_only before update or delete on public.fetch_request_events
  for each row execute function public.tg_fetch_event_append_only();

-- ── messages between the requester and the assigned driver (P0-9) ──────────────────────────────────────────────────────────
create table if not exists public.fetch_messages (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null references public.delivery_requests (id) on delete cascade,
  sender_id     uuid references public.profiles (id) on delete set null,
  sender_role   text not null check (sender_role in ('requester', 'driver', 'admin')),
  body          text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at    timestamptz not null default now(),
  hidden_at     timestamptz,
  hidden_by     uuid references public.profiles (id) on delete set null,
  hidden_reason text check (hidden_reason is null or char_length(btrim(hidden_reason)) between 3 and 500),
  check ((hidden_at is null) = (hidden_reason is null))
);
create index if not exists fetch_messages_request_idx on public.fetch_messages (request_id, created_at);

-- What was said never changes; an admin can only hide it (with a reason), never rewrite it.
create or replace function public.tg_fetch_message_immutable() returns trigger
  language plpgsql set search_path = public, pg_temp
as $$
begin
  if new.request_id is distinct from old.request_id or new.sender_id is distinct from old.sender_id and new.sender_id is not null
     or new.sender_role is distinct from old.sender_role or new.body is distinct from old.body or new.created_at is distinct from old.created_at then
    raise exception 'A Fetch message cannot be edited' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists fetch_messages_immutable on public.fetch_messages;
create trigger fetch_messages_immutable before update on public.fetch_messages
  for each row execute function public.tg_fetch_message_immutable();

-- ── problems, cannot-deliver and disputes (P0-12, P0-15) ───────────────────────────────────────────────────────────────────
create table if not exists public.fetch_issues (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null references public.delivery_requests (id) on delete cascade,
  reporter_id   uuid references public.profiles (id) on delete set null,
  reporter_role text not null check (reporter_role in ('requester', 'driver', 'admin', 'system')),
  kind          text not null check (kind in ('not_delivered', 'damaged', 'wrong_item', 'driver_conduct', 'requester_conduct',
                                              'payment', 'safety', 'cancellation', 'return', 'other')),
  detail        text check (detail is null or char_length(detail) <= 2000),
  status        text not null default 'open' check (status in ('open', 'resolved')),
  resolution    text check (resolution is null or char_length(btrim(resolution)) between 3 and 2000),
  resolved_by   uuid references public.profiles (id) on delete set null,
  resolved_at   timestamptz,
  created_at    timestamptz not null default now(),
  check ((status = 'resolved') = (resolution is not null and resolved_at is not null))
);
create index if not exists fetch_issues_request_idx on public.fetch_issues (request_id);
create index if not exists fetch_issues_open_idx on public.fetch_issues (created_at) where status = 'open';

create or replace function public.tg_fetch_issue_report_immutable() returns trigger
  language plpgsql set search_path = public, pg_temp
as $$
begin
  if new.request_id is distinct from old.request_id or new.reporter_role is distinct from old.reporter_role
     or new.kind is distinct from old.kind or new.detail is distinct from old.detail or new.created_at is distinct from old.created_at
     or (new.reporter_id is distinct from old.reporter_id and new.reporter_id is not null) then
    raise exception 'A reported problem cannot be rewritten' using errcode = '42501';
  end if;
  if old.status = 'resolved' and (new.status <> 'resolved' or new.resolution is distinct from old.resolution) then
    raise exception 'A resolved problem stays resolved' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists fetch_issues_report_immutable on public.fetch_issues;
create trigger fetch_issues_report_immutable before update on public.fetch_issues
  for each row execute function public.tg_fetch_issue_report_immutable();

-- ── photos and evidence (P0-1, P0-8) ────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.fetch_request_photos (
  id             uuid primary key default gen_random_uuid(),
  request_id     uuid not null references public.delivery_requests (id) on delete cascade,
  issue_id       uuid references public.fetch_issues (id) on delete set null,
  kind           text not null check (kind in ('item', 'collection', 'delivery', 'return', 'issue')),
  storage_path   text not null unique,
  created_by     uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  removed_at     timestamptz,
  removed_by     uuid references public.profiles (id) on delete set null,
  removed_reason text check (removed_reason is null or char_length(btrim(removed_reason)) between 3 and 500),
  -- requests/<request id>/<kind>/<uuid>.<ext> in the private fetch-photos bucket
  check (storage_path ~ ('^requests/' || request_id::text || '/' || kind || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|heic|heif)$')),
  check ((kind = 'issue') = (issue_id is not null)),
  check ((removed_at is null) = (removed_reason is null))
);
create index if not exists fetch_request_photos_request_idx on public.fetch_request_photos (request_id, kind);

create or replace function public.tg_fetch_photo_write_once() returns trigger
  language plpgsql set search_path = public, pg_temp
as $$
begin
  if new.request_id is distinct from old.request_id or new.kind is distinct from old.kind or new.storage_path is distinct from old.storage_path
     or new.created_at is distinct from old.created_at or (new.created_by is distinct from old.created_by and new.created_by is not null) then
    raise exception 'A Fetch photo record cannot be rewritten' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists fetch_request_photos_write_once on public.fetch_request_photos;
create trigger fetch_request_photos_write_once before update on public.fetch_request_photos
  for each row execute function public.tg_fetch_photo_write_once();

-- ── requester behaviour counters (G.5) — the evidence for any future cancellation fee; admin-only ─────────────────────────
create table if not exists public.fetch_member_stats (
  user_id                       uuid primary key references public.profiles (id) on delete cascade,
  requests_created              integer not null default 0 check (requests_created >= 0),
  cancels_before_accept         integer not null default 0 check (cancels_before_accept >= 0),
  cancel_requests_after_accept  integer not null default 0 check (cancel_requests_after_accept >= 0),
  fault_returns_requester_side  integer not null default 0 check (fault_returns_requester_side >= 0),
  updated_at                    timestamptz not null default now()
);

-- ── driver verification (P0-14, S.18, S.19) ────────────────────────────────────────────────────────────────────────────────
-- What evidence a driver must provide is DATA: broker/legal advice changes rows here, not the design.
create table if not exists public.driver_verification_requirements (
  id            uuid primary key default gen_random_uuid(),
  vehicle_class text not null check (vehicle_class in ('on_foot', 'bicycle', 'car', 'estate', 'van', 'pickup', 'car_with_trailer')),
  evidence_kind text not null check (evidence_kind ~ '^[a-z][a-z_]{1,40}$'),
  required      boolean not null default true,
  needs_expiry  boolean not null default false,
  guidance_text text not null check (char_length(btrim(guidance_text)) between 3 and 1000),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (vehicle_class, evidence_kind)
);

-- The audit record of each piece of evidence. Survives deletion of its file.
create table if not exists public.driver_verification_items (
  id                   uuid primary key default gen_random_uuid(),
  driver_id            uuid not null references public.profiles (id) on delete cascade,
  kind                 text not null check (kind ~ '^[a-z][a-z_]{1,40}$'),
  details              jsonb not null default '{}' check (jsonb_typeof(details) = 'object'),
  status               text not null default 'submitted' check (status in ('submitted', 'verified', 'rejected', 'expired', 'superseded')),
  submitted_at         timestamptz not null default now(),
  verified_by          uuid references public.profiles (id) on delete set null,
  verified_at          timestamptz,
  expires_at           timestamptz,
  decision_note        text check (decision_note is null or char_length(decision_note) <= 1000),
  file_deleted_at      timestamptz,
  file_deleted_by      uuid references public.profiles (id) on delete set null,
  file_deletion_reason text check (file_deletion_reason is null or char_length(btrim(file_deletion_reason)) between 3 and 500),
  check (status not in ('verified', 'rejected') or (verified_by is not null and verified_at is not null))
);
create index if not exists driver_verification_items_driver_idx on public.driver_verification_items (driver_id, kind);

-- The private file, separate from the record so it can be deleted (retention, request) while the record and approval history remain.
create table if not exists public.driver_verification_files (
  id           uuid primary key default gen_random_uuid(),
  item_id      uuid not null references public.driver_verification_items (id) on delete cascade,
  storage_path text not null unique,
  mime_type    text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf')),
  size_bytes   integer not null check (size_bytes between 1 and 10485760),
  uploaded_at  timestamptz not null default now(),
  -- drivers/<driver id>/<item id>/<uuid>.<ext> in the private fetch-driver-verification bucket
  check (storage_path ~ ('^drivers/[0-9a-f-]{36}/' || item_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|heic|heif|pdf)$'))
);
create index if not exists driver_verification_files_item_idx on public.driver_verification_files (item_id);

-- When the last file of an item goes, the item records that its evidence was deleted (who and why come from the deleting RPC).
create or replace function public.tg_driver_verification_file_deleted() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  update public.driver_verification_items i
     set file_deleted_at = coalesce(i.file_deleted_at, now())
   where i.id = old.item_id
     and not exists (select 1 from public.driver_verification_files f where f.item_id = old.item_id);
  return old;
end;
$$;
drop trigger if exists driver_verification_files_deleted on public.driver_verification_files;
create trigger driver_verification_files_deleted after delete on public.driver_verification_files
  for each row execute function public.tg_driver_verification_file_deleted();

insert into public.driver_verification_requirements (vehicle_class, evidence_kind, required, needs_expiry, guidance_text)
select v.cls, e.kind, true, e.exp, e.guide
  from unnest(array['car', 'estate', 'van', 'pickup', 'car_with_trailer']) v(cls)
  cross join (values
    ('identity_check', false, 'Your OneShetland account name must match your driving licence and your Stripe payout details.'),
    ('licence',        true,  'A photo of your current full driving licence (photocard), showing its expiry date.'),
    ('vehicle',        false, 'The vehicle you will use: make, model and registration, and what size of item it can carry.'),
    ('insurance',      true,  'Evidence that your motor insurance covers carrying other people''s goods for payment through Fetch. The exact cover required is being confirmed before driver sign-ups open.')
  ) e(kind, exp, guide)
union all
select v.cls, 'identity_check', true, false, 'Your OneShetland account name must match your Stripe payout details.'
  from unnest(array['on_foot', 'bicycle']) v(cls)
on conflict (vehicle_class, evidence_kind) do nothing;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 5. Row-level security and grants for the new tables (least privilege)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

alter table public.fetch_request_events             enable row level security;
alter table public.fetch_messages                   enable row level security;
alter table public.fetch_issues                     enable row level security;
alter table public.fetch_request_photos             enable row level security;
alter table public.fetch_member_stats               enable row level security;
alter table public.driver_verification_requirements enable row level security;
alter table public.driver_verification_items        enable row level security;
alter table public.driver_verification_files        enable row level security;

revoke all on public.fetch_request_events, public.fetch_messages, public.fetch_issues, public.fetch_request_photos,
              public.fetch_member_stats, public.driver_verification_requirements, public.driver_verification_items,
              public.driver_verification_files
  from public, anon, authenticated;
grant select on public.fetch_request_events, public.fetch_messages, public.fetch_issues, public.fetch_request_photos,
                public.fetch_member_stats, public.driver_verification_requirements, public.driver_verification_items,
                public.driver_verification_files
  to authenticated;
grant select on public.driver_verification_requirements to anon;
grant all on public.fetch_request_events, public.fetch_messages, public.fetch_issues, public.fetch_request_photos,
             public.fetch_member_stats, public.driver_verification_requirements, public.driver_verification_items,
             public.driver_verification_files
  to service_role;
grant usage on sequence public.fetch_request_events_id_seq to service_role;

drop policy if exists "Fetch events: parties and admins" on public.fetch_request_events;
create policy "Fetch events: parties and admins" on public.fetch_request_events for select to authenticated
  using (public.fetch_v2_is_party(request_id));

drop policy if exists "Fetch messages: parties and admins" on public.fetch_messages;
create policy "Fetch messages: parties and admins" on public.fetch_messages for select to authenticated
  using (public.is_admin() or (hidden_at is null and public.fetch_v2_is_party(request_id)));

drop policy if exists "Fetch issues: reporter and admins" on public.fetch_issues;
create policy "Fetch issues: reporter and admins" on public.fetch_issues for select to authenticated
  using (public.is_admin() or (reporter_id = auth.uid() and public.fetch_v2_is_party(request_id)));

drop policy if exists "Fetch photos: parties and admins" on public.fetch_request_photos;
create policy "Fetch photos: parties and admins" on public.fetch_request_photos for select to authenticated
  using (public.is_admin() or (removed_at is null and public.fetch_v2_is_party(request_id)));

drop policy if exists "Fetch member stats: admins" on public.fetch_member_stats;
create policy "Fetch member stats: admins" on public.fetch_member_stats for select to authenticated
  using (public.is_admin());

drop policy if exists "Verification requirements: active are public" on public.driver_verification_requirements;
create policy "Verification requirements: active are public" on public.driver_verification_requirements for select to anon, authenticated
  using (active or public.is_admin());

drop policy if exists "Verification items: owner and admins" on public.driver_verification_items;
create policy "Verification items: owner and admins" on public.driver_verification_items for select to authenticated
  using (driver_id = auth.uid() or public.is_admin());

drop policy if exists "Verification files: admins only" on public.driver_verification_files;
create policy "Verification files: admins only" on public.driver_verification_files for select to authenticated
  using (public.is_admin());

revoke all on function public.fetch_v2_timeout_secs(text), public.fetch_v2_is_party(uuid), public.fetch_request_is_v1(uuid) from public, anon;
grant execute on function public.fetch_v2_timeout_secs(text), public.fetch_v2_is_party(uuid), public.fetch_request_is_v1(uuid)
  to authenticated, service_role;
-- anon reaches the restrictive delivery_requests SELECT policy (and must be refused there, not erred); it needs the timeout lookup.
grant execute on function public.fetch_v2_timeout_secs(text) to anon;
revoke all on function public.tg_driver_verification_file_deleted() from public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 6. Private storage
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('fetch-photos', 'fetch-photos', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']),
  ('fetch-driver-verification', 'fetch-driver-verification', false, 10485760,
   array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.fetch_v2_photo_object_readable(p_name text) returns boolean
  language sql stable security definer set search_path = public, pg_temp
as $$
  select public.is_admin() or exists (
    select 1 from public.fetch_request_photos p
     where p.storage_path = p_name and p.removed_at is null and public.fetch_v2_is_party(p.request_id)
  );
$$;
revoke all on function public.fetch_v2_photo_object_readable(text) from public, anon;
grant execute on function public.fetch_v2_photo_object_readable(text) to authenticated, service_role;

-- Uploads arrive through server-issued signed URLs (no client INSERT policy); nobody overwrites; only admins delete.
drop policy if exists "fetch-photos read" on storage.objects;
create policy "fetch-photos read" on storage.objects for select to authenticated
  using (bucket_id = 'fetch-photos' and public.fetch_v2_photo_object_readable(objects.name));
drop policy if exists "fetch-photos update" on storage.objects;
create policy "fetch-photos update" on storage.objects for update to authenticated
  using (bucket_id = 'fetch-photos' and false) with check (bucket_id = 'fetch-photos' and false);
drop policy if exists "fetch-photos delete" on storage.objects;
create policy "fetch-photos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'fetch-photos' and public.is_admin());

-- Driver verification files: administrators only — not even the driver reads them back.
drop policy if exists "fetch-driver-verification read" on storage.objects;
create policy "fetch-driver-verification read" on storage.objects for select to authenticated
  using (bucket_id = 'fetch-driver-verification' and public.is_admin());
drop policy if exists "fetch-driver-verification update" on storage.objects;
create policy "fetch-driver-verification update" on storage.objects for update to authenticated
  using (bucket_id = 'fetch-driver-verification' and false) with check (bucket_id = 'fetch-driver-verification' and false);
drop policy if exists "fetch-driver-verification delete" on storage.objects;
create policy "fetch-driver-verification delete" on storage.objects for delete to authenticated
  using (bucket_id = 'fetch-driver-verification' and public.is_admin());

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 7. End-state assertions
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_t text;
begin
  if (select count(*) from public.delivery_pricing_config where bulky_min_fee_pence = 800 and ferry_supplement_pence = 200)
     <> (select count(*) from public.delivery_pricing_config) then
    raise exception 'pricing defaults not applied';
  end if;
  foreach v_t in array array['fetch_request_events', 'fetch_messages', 'fetch_issues', 'fetch_request_photos', 'fetch_member_stats',
                             'driver_verification_requirements', 'driver_verification_items', 'driver_verification_files'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || v_t)::regclass) then
      raise exception '% must have RLS enabled', v_t;
    end if;
    if has_table_privilege('authenticated', 'public.' || v_t, 'insert') or has_table_privilege('authenticated', 'public.' || v_t, 'update')
       or has_table_privilege('authenticated', 'public.' || v_t, 'delete') or has_table_privilege('anon', 'public.' || v_t, 'insert') then
      raise exception '% must not be client-writable', v_t;
    end if;
  end loop;
  if exists (select 1 from storage.buckets where id in ('fetch-photos', 'fetch-driver-verification') and public) then
    raise exception 'Fetch buckets must be private';
  end if;
end $$;

commit;
