-- Reverses supabase/migrations/20261202000000_fetch_v2_payments.sql exactly (proved by supabase/tests/fetch-v2-payments.node.test.ts).
-- Replaced functions are restored verbatim: fetch_v2_timeout_secs (Step 2), fetch_v2_mark_collected and fetch_v2_release_unpaid_due
-- (Step 3), fetch_v2_claim_authorisation (Step 4).
--
-- NOT a migration: it lives outside supabase/migrations so no tool applies it by accident. Run by hand only with Darren's approval.
-- It refuses while any Stripe state has been recorded for a Fetch v2 hold, because dropping those columns would lose payment history.

begin;

do $$
begin
  if exists (select 1 from public.fetch_authorisation_attempts where stripe_status is not null or amount_capturable_pence is not null) then
    raise exception 'Fetch v2 payment state is recorded; refusing to roll back the payment layer';
  end if;
end $$;

delete from public.rate_limit_policies where action in ('fetch_v2_accept', 'fetch_v2_payment', 'fetch_v2_driver', 'fetch_v2_admin');
delete from public.admin_config where key in ('fetch.timeouts.collect_min_hold_secs', 'fetch.timeouts.hold_expiry_margin_secs');

drop function if exists public.fetch_v2_delivery_precheck(uuid, uuid, boolean);
drop function if exists public.fetch_v2_release_after_payment_failure(uuid, text);
drop function if exists public.fetch_v2_payment_work();
drop function if exists public.fetch_v2_escalate_payment(uuid, text);
drop function if exists public.fetch_v2_capture_amount(uuid);
drop function if exists public.fetch_v2_payment_context(uuid);
drop function if exists public.fetch_v2_rotate_authorisation(uuid, text);
drop function if exists public.fetch_v2_hold_ready(uuid);
drop function if exists public.fetch_v2_apply_payment_state(uuid, text, integer, text, integer, integer, timestamptz, text);

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

  -- PAYMENT HOOK: the Paygate hold must be genuinely fulfillable (placed, unexpired, recently confirmed with Stripe).
  select * into v_hold from public.fetch_hold_is_fulfillable(r.id);
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

create or replace function public.fetch_v2_claim_authorisation(p_driver uuid, p_request uuid)
  returns table (outcome text, status text, stripe_payment_intent_id text, generation integer, amount_pence integer, idempotency_key text)
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r      public.delivery_requests;
  t      public.fetch_v2_terms;
  c      record;
  v_gen  integer;
begin
  perform public.fetch_v2_service_actor(p_driver);
  r := public.fetch_v2_lock(p_request);
  if r.driver_id is distinct from p_driver or r.status <> 'matched' then
    raise exception 'Fetch request not found' using errcode = 'P0002';
  end if;
  select * into t from public.fetch_v2_terms where request_id = r.id;
  if t.request_id is null then raise exception 'Fetch terms missing for %', r.id; end if;

  select * into c from public.claim_fetch_authorisation(
    r.id, r.customer_id, p_driver, t.max_hold_pence,
    t.delivery_fee_pence + t.ferry_supplement_pence,      -- the driver's part: delivery fee and ferry supplement, whole
    t.service_fee_pence,                                 -- OneShetland's part: the application fee
    t.wait_grace_secs, t.wait_period_secs, t.wait_period_pence, t.wait_max_pence);

  if c.outcome = 'claimed' then
    select coalesce(max(g.generation), 0) + 1 into v_gen from public.fetch_authorisation_generations g where g.delivery_request_id = r.id;
    update public.fetch_authorisation_attempts a set authorisation_generation = v_gen where a.delivery_request_id = r.id;
  end if;
  select a.authorisation_generation into v_gen from public.fetch_authorisation_attempts a where a.delivery_request_id = r.id;

  return query select c.outcome, c.status, c.stripe_payment_intent_id, v_gen, t.max_hold_pence,
    case when coalesce(v_gen, 1) <= 1 then 'fetch-auth-' || r.id::text else 'fetch-auth-' || r.id::text || '-g' || v_gen end;
end;
$$;

create or replace function public.fetch_v2_release_unpaid_due() returns table (request_id uuid, payment_intent_id text)
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id uuid; v_res jsonb;
begin
  for v_id in select d.id from public.delivery_requests d
               where d.fetch_version = 2 and d.status = 'matched' and d.payment_status not in ('authorised', 'captured')
                 and d.claimed_at <= now() - make_interval(secs => public.fetch_v2_timeout_secs('payment_needed_secs'))
               for update skip locked loop
    v_res := public.fetch_v2_release_internal(v_id, null, 'system', 'payment_timeout', null);
    if (v_res ->> 'ok')::boolean then
      request_id := v_id; payment_intent_id := v_res -> 'payment' ->> 'payment_intent_id'; return next;
    end if;
  end loop;
end;
$$;

alter table public.fetch_authorisation_attempts
  drop column if exists amount_capturable_pence, drop column if exists stripe_status, drop column if exists stripe_status_at;

commit;
