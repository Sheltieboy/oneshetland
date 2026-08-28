-- ═══════════════════════════════════════════════════════════════════════════
-- Fetch pricing becomes the server's business
-- ═══════════════════════════════════════════════════════════════════════════
--
-- What a Fetch delivery costs was decided in the customer's browser and then
-- written straight into the row:
--
--     estimateFee(pickup, dest)                 -- lib/fetch-data.ts
--     sb.from("delivery_requests").insert({ base_fee_pence: feePence, … })
--
-- authorise-payment then read that column and pre-authorised exactly it. So a
-- customer could post a twelve-mile delivery priced at 1p, and the driver who
-- accepted it would make the trip for a penny — the loss lands on the driver,
-- who has already burnt the fuel.
--
-- The same held for waiting time. The DRIVER's browser computed
-- waiting_fee_pence and wrote it to the row, and capture-payment added it to
-- amount_to_capture — so a driver could charge a customer any sum they liked.
--
-- Neither is an RLS failure: the row belonged to the person writing it. RLS
-- decides WHICH ROWS you may touch, never WHICH COLUMNS, and `authenticated`
-- held UPDATE on every one of these money fields.
--
-- Three parts:
--   1. every money constant moves into delivery_pricing_config
--   2. waiting time is DERIVED from timestamps, never submitted as an amount
--   3. a trigger makes the monetary columns server-managed, in the same shape
--      as 20260819180000_lock_server_managed_columns.sql
--
-- The distance itself still comes from Google, but from a SERVER key in
-- fetch-quote — the browser's number is now only ever a preview.

-- ── 1. All the money lives in one configurable row ─────────────────────────
--
-- The waiting-fee policy was four hard-coded constants in a browser bundle
-- (5-minute grace, £1.50 per 5 minutes, £6.00 cap). Money the platform charges
-- should be configurable by the platform, not by shipping a new build.
alter table public.delivery_pricing_config
  add column if not exists wait_grace_secs  integer not null default 300,
  add column if not exists wait_period_secs integer not null default 300,
  add column if not exists wait_period_pence integer not null default 150,
  add column if not exists wait_max_pence   integer not null default 600;

alter table public.delivery_pricing_config
  drop constraint if exists delivery_pricing_config_sane,
  add constraint delivery_pricing_config_sane check (
    min_fee_pence >= 0 and price_per_mile_pence >= 0
    and road_correction_factor >= 1
    and wait_grace_secs >= 0 and wait_period_secs > 0
    and wait_period_pence >= 0 and wait_max_pence >= 0
  );

-- Nobody but an admin sets the prices. It was already publicly READABLE, which
-- is fine and wanted — the quote has to be shown before anyone commits.
revoke insert, update, delete on public.delivery_pricing_config from anon, authenticated;

-- ── 2. The price of a delivery, in one place ───────────────────────────────
--
-- Pure. Takes miles the SERVER measured; returns pence. The road correction
-- turns straight-line miles into something closer to the road distance, which
-- is what the customer is actually driven.
create or replace function public.fetch_base_fee_pence(p_straight_miles numeric)
  returns integer
  language sql
  stable
  set search_path = public
as $$
  select greatest(
    c.min_fee_pence,
    (round(p_straight_miles * c.road_correction_factor * c.price_per_mile_pence))::integer
  )
  from public.delivery_pricing_config c
  limit 1;
$$;

comment on function public.fetch_base_fee_pence(numeric) is
  'What a Fetch delivery of this many straight-line miles costs, in pence. Reads delivery_pricing_config — the one place the rate lives. The service fee is separate and comes from admin_config fees.fetch.*.';

-- ── 3. Waiting time is measured, not claimed ───────────────────────────────
--
-- Derived wholly from waiting_events timestamps. The driver taps "Arrived" and
-- "Collected"; the database stamps both and works out the money. There is no
-- amount for anyone to submit.
--
-- Only charged when the customer said the item was ready for collection — a
-- driver arriving early at a shop that has not packed the order yet is not the
-- customer's fault, which is what ready_for_collection has always meant.
create or replace function public.fetch_waiting_fee_pence(p_request uuid)
  returns integer
  language plpgsql
  stable
  set search_path = public
as $$
declare
  c        public.delivery_pricing_config%rowtype;
  v_ready  boolean;
  v_from   timestamptz;
  v_to     timestamptz;
  v_secs   numeric;
  v_periods integer;
begin
  select ready_for_collection into v_ready from public.delivery_requests where id = p_request;
  if not coalesce(v_ready, false) then return 0; end if;

  -- The FIRST arrival for this request. A second waiting_events row cannot
  -- start the clock again and bill the customer twice for one collection.
  select arrived_at, collected_at into v_from, v_to
    from public.waiting_events
   where request_id = p_request and arrived_at is not null
   order by arrived_at
   limit 1;
  if v_from is null or v_to is null then return 0; end if;

  select * into c from public.delivery_pricing_config limit 1;
  if not found then return 0; end if;

  v_secs := extract(epoch from (v_to - v_from)) - c.wait_grace_secs;
  if v_secs <= 0 then return 0; end if;

  v_periods := floor(v_secs / c.wait_period_secs)::integer;
  return least(v_periods * c.wait_period_pence, c.wait_max_pence);
end;
$$;

comment on function public.fetch_waiting_fee_pence(uuid) is
  'Waiting fee in pence, measured from the waiting_events timestamps and priced from delivery_pricing_config. Nobody submits an amount. Zero unless the customer marked the item ready for collection.';

-- ── 4. Marking a collection is a server transition ─────────────────────────
--
-- Replaces the driver''s browser writing collected_at, a fee it calculated
-- itself, and the request status. now() is the database clock, so a device
-- with a wound-back clock cannot manufacture waiting time.
create or replace function public.fetch_mark_collected(p_request uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_driver uuid;
  v_event  uuid;
  v_fee    integer;
begin
  -- The caller must be the driver on this delivery''s run. Same rule the
  -- authorise/capture endpoints enforce, applied at the database instead of
  -- in one more Edge Function that could forget it.
  select r.driver_id into v_driver
    from public.delivery_requests d join public.runs r on r.id = d.run_id
   where d.id = p_request;
  if v_driver is null or v_driver <> auth.uid() then
    raise exception 'Not the assigned driver for this delivery' using errcode = '42501';
  end if;

  select id into v_event from public.waiting_events
   where request_id = p_request and collected_at is null
   order by arrived_at limit 1;

  if v_event is not null then
    update public.waiting_events set collected_at = now() where id = v_event;
  end if;

  v_fee := public.fetch_waiting_fee_pence(p_request);

  update public.waiting_events set waiting_fee_pence = v_fee where id = v_event;
  update public.delivery_requests
     set status = 'collected', waiting_fee_pence = v_fee
   where id = p_request and status = 'matched';

  return jsonb_build_object('ok', true, 'waiting_fee_pence', v_fee);
end;
$$;

revoke execute on function public.fetch_mark_collected(uuid) from anon, public;
grant  execute on function public.fetch_mark_collected(uuid) to authenticated, service_role;
grant  execute on function public.fetch_base_fee_pence(numeric)  to authenticated, anon, service_role;
grant  execute on function public.fetch_waiting_fee_pence(uuid)  to authenticated, service_role;

-- ── 5. The monetary columns stop taking dictation ──────────────────────────
--
-- Same mechanism as lock_server_managed_columns: a BEFORE trigger that puts
-- the value back rather than raising. A client that sends one is ignored, not
-- broken — the request is still created, just at the price the server says.
create or replace function public.tg_fetch_money_is_server_managed()
  returns trigger
  language plpgsql
  -- SECURITY INVOKER, deliberately: tg_is_trusted_writer() reads current_user,
  -- and DEFINER would rebind it to the owner so every caller looked trusted.
  set search_path = public
as $$
begin
  if public.tg_is_trusted_writer() then return new; end if;

  if tg_op = 'INSERT' then
    -- Priced by fetch-quote once the addresses are stored, never by whoever
    -- submitted the form.
    new.base_fee_pence   := null;
    new.total_fee_pence  := null;
    new.waiting_fee_pence := 0;
  else
    new.base_fee_pence    := old.base_fee_pence;
    new.total_fee_pence   := old.total_fee_pence;
    new.waiting_fee_pence := old.waiting_fee_pence;
  end if;
  return new;
end;
$$;

drop trigger if exists delivery_requests_money_server_managed on public.delivery_requests;
create trigger delivery_requests_money_server_managed
  before insert or update on public.delivery_requests
  for each row execute function public.tg_fetch_money_is_server_managed();

-- The waiting event carries the same money, so it gets the same treatment —
-- otherwise a driver writes the fee there and fetch_waiting_fee_pence is the
-- only honest number in the building.
create or replace function public.tg_waiting_money_is_server_managed()
  returns trigger
  language plpgsql
  set search_path = public
as $$
begin
  if public.tg_is_trusted_writer() then return new; end if;
  if tg_op = 'INSERT' then
    new.waiting_fee_pence := 0;
    new.arrived_at        := coalesce(new.arrived_at, now());
    new.collected_at      := null;   -- only fetch_mark_collected stops the clock
  else
    new.waiting_fee_pence := old.waiting_fee_pence;
    new.arrived_at        := old.arrived_at;
    new.collected_at      := old.collected_at;
  end if;
  return new;
end;
$$;

drop trigger if exists waiting_events_money_server_managed on public.waiting_events;
create trigger waiting_events_money_server_managed
  before insert or update on public.waiting_events
  for each row execute function public.tg_waiting_money_is_server_managed();

comment on function public.tg_fetch_money_is_server_managed() is
  'Fetch monetary columns are the server''s. A client INSERT that carries base_fee_pence has it ignored; a client UPDATE has the stored value put back. RLS decides which rows you may write; this decides which columns.';
