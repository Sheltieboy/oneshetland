-- ═══════════════════════════════════════════════════════════════════════════
-- The terms a customer authorised are the terms they are charged under
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Fix 4 made the HOLD big enough to cover a waiting fee. It did not stop the
-- capture from being computed under different rules to the hold.
--
-- Both the service fee and every waiting term were re-read from mutable global
-- configuration at capture time:
--
--     capture: getCommissionConfig(supabase, 'fetch')      -- admin_config
--              fetch_waiting_fee_pence()                   -- delivery_pricing_config
--
-- so raising the platform fee, the waiting rate or the waiting cap while a
-- delivery was in flight enlarged a charge the customer had already agreed to.
-- Measured against production configuration: a delivery authorised at £11.50
-- would have had £19.00 attempted at capture. The clamp would have caught it —
-- as silent lost revenue for the driver, which is not a fix.
--
-- The commercial terms are therefore frozen onto the attempt when the hold is
-- placed. The waiting MINUTES are still discovered later, as they must be; the
-- rules that turn minutes into money are the ones the customer authorised.
-- A pricing change applies to the next Fetch, not to one already held.

alter table public.fetch_authorisation_attempts
  add column if not exists base_fee_pence    integer,
  add column if not exists service_fee_pence integer,
  add column if not exists wait_grace_secs   integer,
  add column if not exists wait_period_secs  integer,
  add column if not exists wait_period_pence integer,
  add column if not exists wait_max_pence    integer;

comment on column public.fetch_authorisation_attempts.service_fee_pence is
  'The platform fee as it stood when the hold was placed. Frozen: a later fee change must not enlarge a charge the customer has already authorised.';
comment on column public.fetch_authorisation_attempts.wait_max_pence is
  'The waiting terms as they stood when the hold was placed. The minutes are measured later; these rules are not.';

-- ── Claim, now carrying the terms ──────────────────────────────────────────
--
-- The old four-argument form is dropped rather than left beside this one:
-- `create or replace` with new parameters makes an OVERLOAD, and the stale
-- signature would still be callable — which is how a superseded rule survived
-- in the subscription work.
drop function if exists public.claim_fetch_authorisation(uuid, uuid, uuid, integer);

create or replace function public.claim_fetch_authorisation(
  p_request  uuid,
  p_customer uuid,
  p_driver   uuid,
  p_amount   integer default null,
  p_base     integer default null,
  p_service  integer default null,
  p_grace    integer default null,
  p_period   integer default null,
  p_rate     integer default null,
  p_cap      integer default null
) returns table (
  outcome                  text,
  status                   text,
  stripe_payment_intent_id text,
  result                   jsonb
)
language plpgsql security definer set search_path = public
as $$
declare v_row public.fetch_authorisation_attempts%rowtype;
begin
  if p_request is null or p_customer is null then
    raise exception 'claim_fetch_authorisation: a request and a customer are required' using errcode = '22023';
  end if;

  insert into public.fetch_authorisation_attempts
    (delivery_request_id, customer_id, driver_id, amount_pence,
     base_fee_pence, service_fee_pence, wait_grace_secs, wait_period_secs, wait_period_pence, wait_max_pence,
     status, updated_at)
  values
    (p_request, p_customer, p_driver, p_amount,
     p_base, p_service, p_grace, p_period, p_rate, p_cap,
     'in_flight', now())
  on conflict (delivery_request_id) do nothing
  returning * into v_row;

  if found then
    return query select 'claimed'::text, 'in_flight'::text, null::text, null::jsonb;
    return;
  end if;

  select * into v_row from public.fetch_authorisation_attempts
   where delivery_request_id = p_request for update;
  if not found then
    return query select 'in_flight'::text, 'in_flight'::text, null::text, null::jsonb;
    return;
  end if;
  if v_row.customer_id is distinct from p_customer then
    return query select 'conflict'::text, v_row.status, null::text, null::jsonb;
    return;
  end if;
  if v_row.status = 'terminal' then
    return query select 'terminal'::text, v_row.status, v_row.stripe_payment_intent_id, v_row.result;
    return;
  end if;
  if v_row.stripe_payment_intent_id is not null then
    return query select 'resume'::text, v_row.status, v_row.stripe_payment_intent_id, v_row.result;
    return;
  end if;
  return query select 'in_flight'::text, v_row.status, null::text, v_row.result;
end;
$$;

-- ── Waiting time, priced under the frozen rules ────────────────────────────
--
-- Falls back to current configuration only for a delivery with no frozen
-- terms — the ones authorised before this migration. New work always has them.
create or replace function public.fetch_waiting_fee_pence(p_request uuid)
  returns integer
  language plpgsql
  stable
  set search_path = public
as $$
declare
  a         public.fetch_authorisation_attempts%rowtype;
  c         public.delivery_pricing_config%rowtype;
  v_ready   boolean;
  v_from    timestamptz;
  v_to      timestamptz;
  v_secs    numeric;
  v_grace   integer;
  v_period  integer;
  v_rate    integer;
  v_cap     integer;
  v_periods integer;
begin
  select ready_for_collection into v_ready from public.delivery_requests where id = p_request;
  if not coalesce(v_ready, false) then return 0; end if;

  select arrived_at, collected_at into v_from, v_to
    from public.waiting_events
   where request_id = p_request and arrived_at is not null
   order by arrived_at
   limit 1;
  if v_from is null or v_to is null then return 0; end if;

  select * into a from public.fetch_authorisation_attempts where delivery_request_id = p_request;
  select * into c from public.delivery_pricing_config limit 1;

  -- Frozen terms win. Live configuration is the legacy fallback only.
  v_grace  := coalesce(a.wait_grace_secs,   c.wait_grace_secs,   300);
  v_period := coalesce(a.wait_period_secs,  c.wait_period_secs,  300);
  v_rate   := coalesce(a.wait_period_pence, c.wait_period_pence, 150);
  v_cap    := coalesce(a.wait_max_pence,    c.wait_max_pence,    600);
  if v_period <= 0 then return 0; end if;

  v_secs := extract(epoch from (v_to - v_from)) - v_grace;
  if v_secs <= 0 then return 0; end if;

  v_periods := floor(v_secs / v_period)::integer;
  return least(v_periods * v_rate, v_cap);
end;
$$;

comment on function public.fetch_waiting_fee_pence(uuid) is
  'Waiting fee in pence. The minutes are measured from the waiting_events timestamps; the rules pricing them are the ones frozen onto the authorisation attempt, falling back to current configuration only for deliveries authorised before those terms were captured.';

-- ── What this delivery may be charged, under its own terms ─────────────────
create or replace function public.fetch_capture_total_pence(p_request uuid)
  returns table (total_pence integer, authorised_pence integer, terms_frozen boolean)
  language plpgsql stable set search_path = public
as $$
declare a public.fetch_authorisation_attempts%rowtype; v_base integer; v_svc integer;
begin
  select * into a from public.fetch_authorisation_attempts where delivery_request_id = p_request;
  select coalesce(a.base_fee_pence, d.base_fee_pence, 0) into v_base
    from public.delivery_requests d where d.id = p_request;
  v_svc := a.service_fee_pence;   -- null on legacy rows; the caller falls back
  return query select
    (v_base + coalesce(v_svc, 0) + public.fetch_waiting_fee_pence(p_request))::integer,
    a.amount_pence,
    (a.service_fee_pence is not null and a.wait_max_pence is not null);
end;
$$;

revoke execute on function public.claim_fetch_authorisation(uuid, uuid, uuid, integer, integer, integer, integer, integer, integer, integer) from anon, authenticated, public;
revoke execute on function public.fetch_capture_total_pence(uuid) from anon, authenticated, public;
grant  execute on function public.claim_fetch_authorisation(uuid, uuid, uuid, integer, integer, integer, integer, integer, integer, integer) to service_role;
grant  execute on function public.fetch_capture_total_pence(uuid) to service_role;
