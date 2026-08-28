-- ═══════════════════════════════════════════════════════════════════════════
-- Capture is an operation with a memory
-- ═══════════════════════════════════════════════════════════════════════════
--
-- capture-payment called Stripe and believed the HTTP result:
--
--     const captured = await captureRes.json();
--     if (!captureRes.ok) throw new Error(`Capture failed: …`);
--
-- A lost response, a timeout or a 5xx AFTER Stripe has taken the money reads
-- exactly like a failure. The function threw a 500, the delivery was never
-- marked delivered, and the driver — standing on a doorstep with an empty
-- bag — tapped again. The local guard was `payment_status === 'captured'`,
-- read then written with nothing holding the gap, so two taps could both get
-- past it.
--
-- Capture state lives on the existing authorisation attempt rather than in a
-- second registry: it is the same delivery, the same PaymentIntent, and the
-- same row already carries the identity everything else keys on.

alter table public.fetch_authorisation_attempts
  add column if not exists capture_state      text not null default 'none'
    check (capture_state in ('none', 'in_flight', 'captured', 'failed', 'unresolved')),
  add column if not exists capture_amount_pence integer,
  add column if not exists capture_last_error   text,
  add column if not exists capture_started_at   timestamptz,
  add column if not exists captured_at          timestamptz,
  -- Physical delivery is a thing a driver does, not a thing Stripe says.
  -- A payment_intent.succeeded arriving from anywhere must never be read as
  -- "the item arrived"; only a driver asking to complete the delivery sets
  -- this, and only then may a captured payment finish the job.
  add column if not exists completion_requested_at timestamptz;

comment on column public.fetch_authorisation_attempts.capture_state is
  'none → in_flight → captured | failed | unresolved. ''unresolved'' means we could not determine what Stripe did and must not guess; ''failed'' means Stripe told us it did not happen.';
comment on column public.fetch_authorisation_attempts.completion_requested_at is
  'When the assigned driver asked to complete this delivery. Stripe saying a payment succeeded is not evidence that an item was handed over.';

-- ── Claim the capture ──────────────────────────────────────────────────────
--
-- The race is decided by a conditional UPDATE, not by a preceding select.
-- Twenty simultaneous taps contend on the row; exactly one moves
-- capture_state from a startable value into 'in_flight'.
create or replace function public.claim_fetch_capture(
  p_request uuid,
  p_driver  uuid,
  p_amount  integer
) returns table (
  outcome                  text,
  capture_state            text,
  stripe_payment_intent_id text
)
language plpgsql security definer set search_path = public
as $$
declare v_row public.fetch_authorisation_attempts%rowtype;
begin
  select * into v_row from public.fetch_authorisation_attempts
   where delivery_request_id = p_request for update;
  if not found then
    return query select 'no_attempt'::text, null::text, null::text;
    return;
  end if;
  if v_row.stripe_payment_intent_id is null then
    return query select 'no_intent'::text, v_row.capture_state, null::text;
    return;
  end if;
  if v_row.driver_id is distinct from p_driver then
    return query select 'wrong_driver'::text, v_row.capture_state, null::text;
    return;
  end if;

  -- Already done. The driver's second tap gets a success, not a Stripe error.
  if v_row.capture_state = 'captured' then
    return query select 'already_captured'::text, v_row.capture_state, v_row.stripe_payment_intent_id;
    return;
  end if;

  -- Another call is inside Stripe. Racing it is what takes money twice.
  if v_row.capture_state = 'in_flight'
     and v_row.capture_started_at > now() - interval '90 seconds' then
    return query select 'in_flight'::text, v_row.capture_state, v_row.stripe_payment_intent_id;
    return;
  end if;

  -- 'unresolved', a stale 'in_flight', 'failed' or 'none' all reach Stripe —
  -- but the caller must RETRIEVE first, never capture blind. That is the
  -- endpoint's job; the claim only says who may go.
  update public.fetch_authorisation_attempts set
    capture_state        = 'in_flight',
    capture_amount_pence = p_amount,
    capture_started_at   = now(),
    completion_requested_at = coalesce(completion_requested_at, now()),
    updated_at           = now()
  where delivery_request_id = p_request
  returning * into v_row;

  return query select 'claimed'::text, v_row.capture_state, v_row.stripe_payment_intent_id;
end;
$$;

create or replace function public.settle_fetch_capture(
  p_request uuid,
  p_state   text,
  p_amount  integer default null,
  p_error   text default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare v_row public.fetch_authorisation_attempts%rowtype;
begin
  update public.fetch_authorisation_attempts set
    capture_state        = p_state,
    capture_amount_pence = coalesce(p_amount, capture_amount_pence),
    capture_last_error   = p_error,
    captured_at          = case when p_state = 'captured' then coalesce(captured_at, now()) else captured_at end,
    status               = case when p_state = 'captured' then 'captured' else status end,
    updated_at           = now()
  where delivery_request_id = p_request
  returning * into v_row;
  if not found then
    raise exception 'settle_fetch_capture: no attempt for this delivery' using errcode = '22023';
  end if;
  return jsonb_build_object('ok', true, 'capture_state', v_row.capture_state);
end;
$$;

revoke execute on function public.claim_fetch_capture(uuid, uuid, integer)        from anon, authenticated, public;
revoke execute on function public.settle_fetch_capture(uuid, text, integer, text) from anon, authenticated, public;
grant  execute on function public.claim_fetch_capture(uuid, uuid, integer)        to service_role;
grant  execute on function public.settle_fetch_capture(uuid, text, integer, text) to service_role;
