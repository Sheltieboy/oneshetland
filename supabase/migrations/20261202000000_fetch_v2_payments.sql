-- Fetch v2 — the payment state machine behind the edge payment layer (docs/FETCH_V2_IMPLEMENTATION.md, Step 5).
--
-- Stripe is the source of truth for money; this is where its answers become Fetch state. ONE function,
-- fetch_v2_apply_payment_state, takes a PaymentIntent's status (from the accept call, a hold refresh, a sweep or the webhook) and:
--   · applies it only to the job's CURRENT authorisation (same PaymentIntent, or the in-flight generation it was created for);
--     a retired generation's intent is recorded as ignored, an unrelated one cannot touch anything;
--   · never moves backwards (captured is final; a cancelled hold is not revived by a late "capturable" event);
--   · stores Stripe's own capture deadline (charge.payment_method_details.card.capture_before) — never a guessed number of days;
--   · writes an event only when something actually changed, so replays are silent.
--
-- The collection gate (fetch_v2_hold_ready) adds two v2 checks to Paygate's fetch_hold_is_fulfillable: the capturable amount covers
-- the normal total plus the waiting cap, and the hold lasts long enough for the delivery (fetch.timeouts.collect_min_hold_secs).
-- Holds nearing their deadline are rotated before collection (void → archive → new generation) or escalated after it, never doubled.
--
-- NOT APPLIED to production. Held until iOS Build 148 has cleared App Review and Darren approves (plan S.1).
-- Reversal: supabase/rollbacks/20261202000000_fetch_v2_payments.down.sql (proved by the isolated suite).

begin;

alter table public.fetch_authorisation_attempts
  add column if not exists amount_capturable_pence integer check (amount_capturable_pence is null or amount_capturable_pence >= 0),
  add column if not exists stripe_status           text,
  add column if not exists stripe_status_at        timestamptz;

insert into public.admin_config (key, value, category, description, is_secret) values
  ('fetch.timeouts.collect_min_hold_secs',    '86400',  'fetch', 'Fetch v2: a driver may only collect if the card hold lasts at least this much longer (so the delivery can finish inside it).', false),
  ('fetch.timeouts.hold_expiry_margin_secs',  '172800', 'fetch', 'Fetch v2: the runner rotates (before collection) or escalates (after) a hold whose Stripe deadline is within this window.', false)
on conflict (key) do nothing;

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

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. Stripe → Fetch, one way in
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_apply_payment_state(
  p_request uuid, p_pi text, p_generation integer, p_state text,
  p_amount_capturable integer default null, p_amount_received integer default null,
  p_capture_before timestamptz default null, p_source text default 'api') returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r        public.delivery_requests;
  a        public.fetch_authorisation_attempts;
  v_pay    text;
  v_att    text;
  v_hold   text;
  v_old    text;
begin
  if p_state not in ('requires_capture', 'requires_action', 'requires_payment_method', 'processing', 'canceled', 'succeeded', 'failed') then
    return public.fetch_v2_refuse('invalid_request');
  end if;
  select * into r from public.delivery_requests where id = p_request and fetch_version = 2 for update;
  if not found then return jsonb_build_object('ok', true, 'ignored', 'not_fetch_v2'); end if;
  select * into a from public.fetch_authorisation_attempts where delivery_request_id = r.id for update;

  -- Scope: only this job's current hold. A retired generation's intent is history; anything else is not ours.
  if a.delivery_request_id is null or (a.stripe_payment_intent_id is not null and a.stripe_payment_intent_id <> p_pi) then
    if exists (select 1 from public.fetch_authorisation_generations g where g.delivery_request_id = r.id and g.stripe_payment_intent_id = p_pi) then
      return jsonb_build_object('ok', true, 'ignored', 'retired_generation');
    end if;
    return jsonb_build_object('ok', true, 'ignored', 'not_current_hold');
  end if;
  if a.stripe_payment_intent_id is null then
    -- The intent this in-flight generation was created for (the webhook can beat the creating call back).
    if p_generation is distinct from coalesce(a.authorisation_generation, 1) then
      return jsonb_build_object('ok', true, 'ignored', 'not_current_hold');
    end if;
    update public.fetch_authorisation_attempts set stripe_payment_intent_id = p_pi where delivery_request_id = r.id;
    a.stripe_payment_intent_id := p_pi;
  end if;

  -- Never backwards.
  if (a.status = 'captured' or a.capture_state = 'captured') and p_state <> 'succeeded' then
    return jsonb_build_object('ok', true, 'ignored', 'already_captured', 'payment_status', r.payment_status);
  end if;
  if a.status = 'terminal' and p_state not in ('canceled') then
    return jsonb_build_object('ok', true, 'ignored', 'already_terminal', 'payment_status', r.payment_status);
  end if;

  v_pay := case p_state
    when 'requires_capture'        then 'authorised'
    when 'requires_action'         then 'requires_action'
    when 'requires_payment_method' then 'requires_payment_method'
    when 'processing'              then 'processing'
    when 'succeeded'               then 'captured'
    when 'failed'                  then 'failed'
    when 'canceled'                then case when r.status in ('pending', 'cancelled', 'expired') then 'unpaid' else 'expired' end
  end;
  v_att := case p_state
    when 'requires_capture' then 'authorised' when 'succeeded' then 'captured' when 'canceled' then 'terminal'
    when 'processing' then 'unresolved' else 'awaiting_customer' end;
  v_hold := case p_state
    when 'requires_capture' then case when p_capture_before is not null
                                       and p_capture_before < now() + make_interval(secs => public.fetch_v2_timeout_secs('hold_expiry_margin_secs'))
                                      then 'expiring_soon' else 'valid' end
    when 'canceled' then 'expired' when 'succeeded' then 'valid' else 'unknown' end;

  v_old := r.payment_status;
  update public.fetch_authorisation_attempts set
    status                   = v_att,
    capture_state            = case when p_state = 'succeeded' then 'captured' else capture_state end,
    hold_state               = v_hold,
    hold_checked_at          = now(),
    authorisation_expires_at = coalesce(p_capture_before, authorisation_expires_at),
    amount_capturable_pence  = coalesce(p_amount_capturable, amount_capturable_pence),
    capture_amount_pence     = case when p_state = 'succeeded' then coalesce(p_amount_received, capture_amount_pence) else capture_amount_pence end,
    stripe_status            = p_state,
    stripe_status_at         = now(),
    updated_at               = now()
   where delivery_request_id = r.id;
  update public.delivery_requests set payment_status = v_pay,
         payment_intent_id = case when p_state = 'canceled' then null else p_pi end
   where id = r.id;

  if v_old is distinct from v_pay then
    perform public.fetch_v2_log(r.id, null, 'system', 'payment_' || v_pay, r.status, r.status, null, null,
      jsonb_build_object('stripe_status', p_state, 'source', left(p_source, 60), 'generation', coalesce(a.authorisation_generation, 1),
                         'capture_before', p_capture_before, 'amount_capturable_pence', p_amount_capturable));
  end if;
  return jsonb_build_object('ok', true, 'changed', v_old is distinct from v_pay, 'payment_status', v_pay, 'hold_state', v_hold);
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. The collection gate
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_hold_ready(p_request uuid) returns table (ok boolean, reason text)
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v record; a public.fetch_authorisation_attempts; t public.fetch_v2_terms;
begin
  select * into v from public.fetch_hold_is_fulfillable(p_request);
  if not coalesce(v.ok, false) then return query select false, coalesce(v.reason, 'not_authorised'); return; end if;
  select * into a from public.fetch_authorisation_attempts where delivery_request_id = p_request;
  select * into t from public.fetch_v2_terms where request_id = p_request;
  if t.request_id is null or coalesce(a.amount_capturable_pence, 0) < t.total_pence + t.wait_max_pence then
    return query select false, 'insufficient_hold'; return;
  end if;
  if a.authorisation_expires_at is null
     or a.authorisation_expires_at < now() + make_interval(secs => public.fetch_v2_timeout_secs('collect_min_hold_secs')) then
    return query select false, 'hold_expiring'; return;
  end if;
  return query select true, 'valid';
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
-- 3. Holds: never resume another driver's; rotate a dying one before collection
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_claim_authorisation(p_driver uuid, p_request uuid)
  returns table (outcome text, status text, stripe_payment_intent_id text, generation integer, amount_pence integer, idempotency_key text)
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r      public.delivery_requests;
  t      public.fetch_v2_terms;
  c      record;
  v_gen  integer;
  v_prev uuid;
begin
  perform public.fetch_v2_service_actor(p_driver);
  r := public.fetch_v2_lock(p_request);
  if r.driver_id is distinct from p_driver or r.status <> 'matched' then
    raise exception 'Fetch request not found' using errcode = 'P0002';
  end if;
  select * into t from public.fetch_v2_terms where request_id = r.id;
  if t.request_id is null then raise exception 'Fetch terms missing for %', r.id; end if;
  -- A previous driver's hold is never resumed or reused: it must be voided and retired first.
  select a.driver_id into v_prev from public.fetch_authorisation_attempts a where a.delivery_request_id = r.id;
  if found and v_prev is distinct from p_driver then
    return query select 'previous_hold_not_retired'::text, null::text, null::text, null::integer, t.max_hold_pence, null::text;
    return;
  end if;

  select * into c from public.claim_fetch_authorisation(
    r.id, r.customer_id, p_driver, t.max_hold_pence,
    t.delivery_fee_pence + t.ferry_supplement_pence,
    t.service_fee_pence,
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

-- Before collection, a hold that died or is dying is replaced: AFTER the old one is voided at Stripe (terminal), it is archived and
-- the job's payment returns to unpaid; fetch_v2_claim_authorisation then opens the next generation for the same driver.
create or replace function public.fetch_v2_rotate_authorisation(p_request uuid, p_reason text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.delivery_requests; a public.fetch_authorisation_attempts;
begin
  r := public.fetch_v2_lock(p_request);
  select * into a from public.fetch_authorisation_attempts where delivery_request_id = r.id for update;
  if not found then return jsonb_build_object('ok', true, 'already', true); end if;
  if r.status <> 'matched' then return public.fetch_v2_refuse('not_rotatable'); end if;
  if a.status = 'captured' or a.capture_state = 'captured' then return public.fetch_v2_refuse('hold_already_captured'); end if;
  if a.stripe_payment_intent_id is not null and a.status <> 'terminal' then return public.fetch_v2_refuse('hold_still_live'); end if;
  insert into public.fetch_authorisation_generations
    (delivery_request_id, generation, stripe_payment_intent_id, status, amount_pence, base_fee_pence, service_fee_pence,
     wait_grace_secs, wait_period_secs, wait_period_pence, wait_max_pence, authorisation_expires_at, hold_state, hold_detail)
  values (a.delivery_request_id, coalesce(a.authorisation_generation, 1), a.stripe_payment_intent_id, a.status, a.amount_pence,
          a.base_fee_pence, a.service_fee_pence, a.wait_grace_secs, a.wait_period_secs, a.wait_period_pence, a.wait_max_pence,
          a.authorisation_expires_at, a.hold_state, left(p_reason, 200))
  on conflict (delivery_request_id, generation) do nothing;
  delete from public.fetch_authorisation_attempts where delivery_request_id = r.id;
  update public.delivery_requests set payment_status = 'unpaid', payment_intent_id = null where id = r.id;
  perform public.fetch_v2_log(r.id, null, 'system', 'authorisation_rotated', r.status, r.status, p_reason, null,
    jsonb_build_object('retired_generation', coalesce(a.authorisation_generation, 1)));
  return jsonb_build_object('ok', true, 'already', false, 'retired_generation', coalesce(a.authorisation_generation, 1));
end;
$$;

-- Payment not completed within the window: measured from the CURRENT authorisation (a rotation restarts the clock), not the claim.
create or replace function public.fetch_v2_release_unpaid_due() returns table (request_id uuid, payment_intent_id text)
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id uuid; v_res jsonb;
begin
  for v_id in select d.id from public.delivery_requests d
               left join public.fetch_authorisation_attempts a on a.delivery_request_id = d.id
               where d.fetch_version = 2 and d.status = 'matched' and d.payment_status not in ('authorised', 'captured')
                 and greatest(d.claimed_at, coalesce(a.created_at, d.claimed_at))
                     <= now() - make_interval(secs => public.fetch_v2_timeout_secs('payment_needed_secs'))
               for update of d skip locked loop
    v_res := public.fetch_v2_release_internal(v_id, null, 'system', 'payment_timeout', null);
    if (v_res ->> 'ok')::boolean then
      request_id := v_id;
      payment_intent_id := coalesce(v_res -> 'payment' ->> 'payment_intent_id',
                                    (select a2.stripe_payment_intent_id from public.fetch_authorisation_attempts a2 where a2.delivery_request_id = v_id));
      return next;
    end if;
  end loop;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. What the payment layer needs to know, and what the runner should do
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.fetch_v2_payment_context(p_request uuid) returns jsonb
  language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'request_id', r.id, 'status', r.status, 'payment_status', r.payment_status, 'customer_id', r.customer_id, 'driver_id', r.driver_id,
    'payment_intent_id', coalesce(a.stripe_payment_intent_id, r.payment_intent_id), 'attempt_status', a.status,
    'attempt_driver_id', a.driver_id, 'generation', a.authorisation_generation, 'amount_capturable_pence', a.amount_capturable_pence,
    'authorisation_expires_at', a.authorisation_expires_at, 'capture_state', a.capture_state,
    'driver_stripe_account_id', dp.stripe_account_id, 'driver_payouts_enabled', coalesce(dp.stripe_payouts_enabled, false),
    'max_hold_pence', t.max_hold_pence, 'service_fee_pence', t.service_fee_pence, 'total_pence', t.total_pence,
    'category_slug', r.category_slug)
  from public.delivery_requests r
  left join public.fetch_authorisation_attempts a on a.delivery_request_id = r.id
  left join public.driver_profiles dp on dp.id = coalesce(a.driver_id, r.driver_id)
  left join public.fetch_v2_terms t on t.request_id = r.id
  where r.id = p_request and r.fetch_version = 2;
$$;

-- The amount to capture now, and OneShetland's part of it (the frozen service fee, once, never more than the amount).
create or replace function public.fetch_v2_capture_amount(p_request uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare r public.delivery_requests; t public.fetch_v2_terms; v_total integer;
begin
  select * into r from public.delivery_requests where id = p_request and fetch_version = 2;
  select * into t from public.fetch_v2_terms where request_id = p_request;
  if r.id is null or t.request_id is null then return public.fetch_v2_refuse('terms_missing'); end if;
  if r.status = 'returned' then
    v_total := coalesce(r.resolution_capture_pence, 0);
  elsif r.status in ('collected', 'undeliverable', 'delivered') then
    v_total := t.total_pence + coalesce(r.waiting_fee_pence, 0);
  else
    return public.fetch_v2_refuse('not_capturable');
  end if;
  return jsonb_build_object('ok', true, 'amount_pence', v_total, 'application_fee_pence', least(t.service_fee_pence, v_total),
    'driver_pence', v_total - least(t.service_fee_pence, v_total));
end;
$$;

-- One payment problem, one admin issue (repeat-safe).
create or replace function public.fetch_v2_escalate_payment(p_request uuid, p_reason text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.delivery_requests;
begin
  r := public.fetch_v2_lock(p_request);
  if exists (select 1 from public.fetch_issues where request_id = r.id and kind = 'payment' and status = 'open') then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  insert into public.fetch_issues (request_id, reporter_role, kind, detail) values (r.id, 'system', 'payment', left(p_reason, 2000));
  perform public.fetch_v2_log(r.id, null, 'system', 'payment_escalated', r.status, r.status, p_reason);
  return jsonb_build_object('ok', true, 'already', false);
end;
$$;

create or replace function public.fetch_v2_payment_work() returns table (request_id uuid, action text, payment_intent_id text, driver_id uuid)
  language sql stable security definer set search_path = public, pg_temp
as $$
  with margin as (select now() + make_interval(secs => public.fetch_v2_timeout_secs('hold_expiry_margin_secs')) as edge)
  -- a hold still live on a job nobody holds any more (a void that did not complete): void it, then retire
  select d.id, 'void_orphan', a.stripe_payment_intent_id, a.driver_id
    from public.delivery_requests d join public.fetch_authorisation_attempts a on a.delivery_request_id = d.id
   where d.fetch_version = 2 and (d.status in ('pending', 'cancelled', 'expired') or a.driver_id is distinct from d.driver_id)
     and a.status not in ('terminal', 'captured') and a.stripe_payment_intent_id is not null
  union all
  -- voided, but not yet archived
  select d.id, 'retire', a.stripe_payment_intent_id, a.driver_id
    from public.delivery_requests d join public.fetch_authorisation_attempts a on a.delivery_request_id = d.id
   where d.fetch_version = 2 and (d.status in ('pending', 'cancelled', 'expired') or a.driver_id is distinct from d.driver_id)
     and (a.status = 'terminal' or a.stripe_payment_intent_id is null)
  union all
  -- before collection: expired or dying holds are replaced
  select d.id, 'rotate', a.stripe_payment_intent_id, d.driver_id
    from public.delivery_requests d join public.fetch_authorisation_attempts a on a.delivery_request_id = d.id, margin m
   where d.fetch_version = 2 and d.status = 'matched' and a.driver_id = d.driver_id
     and (d.payment_status = 'expired' or (d.payment_status = 'authorised' and a.authorisation_expires_at < m.edge))
  union all
  -- after collection: never two holds and never none — a person decides
  select d.id, 'escalate', a.stripe_payment_intent_id, d.driver_id
    from public.delivery_requests d join public.fetch_authorisation_attempts a on a.delivery_request_id = d.id, margin m
   where d.fetch_version = 2 and d.status in ('collected', 'undeliverable') and a.status <> 'captured'
     and (d.payment_status = 'expired' or a.authorisation_expires_at < m.edge)
     and not exists (select 1 from public.fetch_issues i where i.request_id = d.id and i.kind = 'payment' and i.status = 'open')
  union all
  -- a returned job whose resolution has not been captured yet
  select d.id, 'capture_return', a.stripe_payment_intent_id, d.driver_id
    from public.delivery_requests d join public.fetch_authorisation_attempts a on a.delivery_request_id = d.id
   where d.fetch_version = 2 and d.status = 'returned' and a.status = 'authorised' and coalesce(d.resolution_capture_pence, 0) > 0
  union all
  -- confirmations older than an hour on live jobs are refreshed from Stripe
  select d.id, 'refresh', a.stripe_payment_intent_id, d.driver_id
    from public.delivery_requests d join public.fetch_authorisation_attempts a on a.delivery_request_id = d.id
   where d.fetch_version = 2 and d.status in ('matched', 'collected', 'undeliverable') and a.stripe_payment_intent_id is not null
     and a.status not in ('terminal', 'captured') and (a.hold_checked_at is null or a.hold_checked_at < now() - interval '1 hour');
$$;

-- A hold that cannot be started for a reason that is nobody's fault on this job (e.g. the driver's payout account was refused):
-- back to the board, not counted against the driver.
create or replace function public.fetch_v2_release_after_payment_failure(p_request uuid, p_reason text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp
as $$ begin return public.fetch_v2_release_internal(p_request, null, 'system', 'payment_failed', left(p_reason, 200)); end; $$;

-- Everything delivery needs that does NOT involve money, checked BEFORE capture — so a capture is never followed by a refusal.
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

insert into public.rate_limit_policies (action, window_seconds, max_count, note) values
  ('fetch_v2_accept',  3600,  30, 'Fetch v2 accepts per driver per hour (each can start a card hold)'),
  ('fetch_v2_payment', 3600,  60, 'Fetch v2 requester payment completions per hour'),
  ('fetch_v2_driver',  3600, 120, 'Fetch v2 driver payment actions per hour'),
  ('fetch_v2_admin',   3600, 300, 'Fetch v2 admin payment actions per hour')
on conflict (action) do nothing;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 5. Grants
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
revoke all on function public.fetch_v2_apply_payment_state(uuid, text, integer, text, integer, integer, timestamptz, text),
  public.fetch_v2_hold_ready(uuid), public.fetch_v2_rotate_authorisation(uuid, text), public.fetch_v2_payment_context(uuid),
  public.fetch_v2_capture_amount(uuid), public.fetch_v2_escalate_payment(uuid, text), public.fetch_v2_payment_work(),
  public.fetch_v2_release_after_payment_failure(uuid, text), public.fetch_v2_delivery_precheck(uuid, uuid, boolean)
from public, anon, authenticated;
grant execute on function public.fetch_v2_apply_payment_state(uuid, text, integer, text, integer, integer, timestamptz, text),
  public.fetch_v2_hold_ready(uuid), public.fetch_v2_rotate_authorisation(uuid, text), public.fetch_v2_payment_context(uuid),
  public.fetch_v2_capture_amount(uuid), public.fetch_v2_escalate_payment(uuid, text), public.fetch_v2_payment_work(),
  public.fetch_v2_release_after_payment_failure(uuid, text), public.fetch_v2_delivery_precheck(uuid, uuid, boolean)
to service_role;

do $$
begin
  if has_function_privilege('authenticated', 'public.fetch_v2_apply_payment_state(uuid, text, integer, text, integer, integer, timestamptz, text)', 'execute')
     or has_function_privilege('authenticated', 'public.fetch_v2_payment_context(uuid)', 'execute') then
    raise exception 'a Fetch payment function is reachable by a client';
  end if;
end $$;

commit;
