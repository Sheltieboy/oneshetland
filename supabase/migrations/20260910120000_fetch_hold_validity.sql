-- ═══════════════════════════════════════════════════════════════════════════
-- A hold is only a hold while Stripe still says so
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Fixes 2–4 made the WRITING of `payment_status = 'authorised'` honest: only a
-- PaymentIntent in requires_capture earns it. Nothing made the READING of it
-- honest afterwards. It is a note of a past conversation, and a card
-- authorisation is not permanent — Stripe releases an uncaptured one after a
-- few days (Visa merchant-initiated: 4 days 18 hours; most others 7), and the
-- PaymentIntent goes to `canceled`. Our row still said authorised.
--
-- ── The two holes, both measured against the live database ────────────────
--
-- 1. fetch_mark_collected is SECURITY DEFINER, so inside it current_user is
--    the function owner, so tg_is_trusted_writer() answers true, so the
--    payment gate added by 20260906120000 returns early and never runs. The
--    gate protects a driver's direct PATCH — which is refused, measured — and
--    not the RPC the web app actually calls.
--
--    Probed in a rolled-back transaction: a driver called
--    fetch_mark_collected on a delivery whose payment_status was 'unpaid',
--    with no PaymentIntent at all, and the row moved to 'collected'. They
--    collected an entirely unfunded delivery.
--
-- 2. Even with payment_status = 'authorised', nothing asked Stripe whether the
--    hold was still there. A delivery accepted on Monday and collected on the
--    following Tuesday would be collected against money that had been released
--    days earlier, and capture-payment would discover it on the doorstep.
--
-- ── What Stripe actually tells us ─────────────────────────────────────────
--
-- The deadline is not a constant and must not be computed here. Stripe puts it
-- on the CHARGE, at payment_method_details.card.capture_before, reachable from
-- the PaymentIntent with expand[]=latest_charge. When it passes, the funds are
-- released and the PaymentIntent's status becomes `canceled`. So this
-- migration stores the deadline Stripe gives and NEVER invents one: a delivery
-- with no recorded deadline falls back to status reconciliation, which is the
-- authority in either case.
--
-- ── The shape of the fix ──────────────────────────────────────────────────
--
-- The server records what Stripe said and when it asked; the database decides
-- whether that is good enough to collect against. A client cannot write any of
-- it, and a driver cannot make the answer 'yes' by tapping again.

-- ── 1. Local states that can tell the reasons apart ───────────────────────
--
-- Operations must distinguish a decline from an expiry from a cancellation
-- from an unknown. 'failed' is not stretched to cover a hold that simply ran
-- out of time: nobody did anything wrong, and the customer can re-authorise.
alter table public.delivery_requests
  drop constraint if exists delivery_requests_payment_status_check;

alter table public.delivery_requests
  add constraint delivery_requests_payment_status_check check (
    payment_status = any (array[
      'unpaid',
      'requires_action',
      'requires_payment_method',
      'processing',
      'authorised',
      'expired',                   -- the hold was released before capture
      'captured',
      'refunded',
      'partially_refunded',
      'failed'                     -- the card was refused
    ])
  );

comment on column public.delivery_requests.payment_status is
  'Only ''authorised'' means a Stripe hold exists (PaymentIntent requires_capture), and only while it is still current — see fetch_hold_is_fulfillable. ''expired'' is a hold that was released before capture: distinct from ''failed'' (refused) and from a cancelled request.';

alter table public.fetch_authorisation_attempts
  drop constraint if exists fetch_authorisation_attempts_status_check;
alter table public.fetch_authorisation_attempts
  add constraint fetch_authorisation_attempts_status_check check (
    status in ('in_flight', 'authorised', 'awaiting_customer', 'unresolved',
               'captured', 'expired', 'terminal'));

-- ── 2. What Stripe last said about this hold ──────────────────────────────
alter table public.fetch_authorisation_attempts
  -- Stripe's own deadline (charge.payment_method_details.card.capture_before).
  -- Null when Stripe did not give one; never manufactured here.
  add column if not exists authorisation_expires_at timestamptz,
  add column if not exists hold_state  text not null default 'unknown'
    check (hold_state in ('unknown', 'valid', 'expiring_soon', 'expired',
                          'customer_action_required', 'unresolved', 'captured')),
  add column if not exists hold_checked_at timestamptz,
  add column if not exists hold_detail     text,
  add column if not exists expired_at      timestamptz,
  -- A canceled PaymentIntent cannot be revived, so a re-authorisation is a NEW
  -- intent. This counts them. One row per delivery still: the superseded
  -- generation is archived, so the primary key goes on being the whole
  -- guarantee that only one authorisation is live at a time.
  add column if not exists authorisation_generation integer not null default 1;

comment on column public.fetch_authorisation_attempts.authorisation_expires_at is
  'Stripe''s capture deadline for this hold, from charge.payment_method_details.card.capture_before. Null means Stripe gave none — fall back to reconciling the PaymentIntent status, never to a guessed duration.';
comment on column public.fetch_authorisation_attempts.hold_checked_at is
  'When the server last asked Stripe about this hold. A stale answer is not evidence that money is still held, so collection requires a recent one.';

-- ── 3. Superseded generations are kept, not overwritten ───────────────────
create table if not exists public.fetch_authorisation_generations (
  id                       bigserial primary key,
  delivery_request_id      uuid not null references public.delivery_requests(id) on delete cascade,
  generation               integer not null,
  stripe_payment_intent_id text,
  status                   text,
  amount_pence             integer,
  base_fee_pence           integer,
  service_fee_pence        integer,
  wait_grace_secs          integer,
  wait_period_secs         integer,
  wait_period_pence        integer,
  wait_max_pence           integer,
  authorisation_expires_at timestamptz,
  hold_state               text,
  hold_detail              text,
  retired_at               timestamptz not null default now(),
  unique (delivery_request_id, generation)
);

comment on table public.fetch_authorisation_generations is
  'Retired Fetch authorisations. A hold that expires cannot be revived, so re-authorising means a second PaymentIntent; the old one is archived here rather than overwritten, so the evidence of what was held, and under what terms, survives.';

alter table public.fetch_authorisation_generations enable row level security;
revoke all on public.fetch_authorisation_generations from anon, authenticated;
grant select, insert on public.fetch_authorisation_generations to service_role;
grant usage, select on sequence public.fetch_authorisation_generations_id_seq to service_role;

-- ── 4. Recording what Stripe said ─────────────────────────────────────────
--
-- The only way any of these fields is written. Service-role only: a client
-- that could set hold_state = 'valid' could walk past every gate below.
create or replace function public.record_fetch_hold_state(
  p_request        uuid,
  p_state          text,
  p_detail         text        default null,
  p_expires_at     timestamptz default null,
  p_payment_status text        default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare v_row public.fetch_authorisation_attempts%rowtype;
begin
  -- The request row is corrected FIRST and independently of the attempt.
  -- Deliveries authorised before the attempt registry existed still have a
  -- payment_status that can go stale, and a webhook arriving for one of those
  -- must still be able to stop it reading 'authorised'.
  if p_payment_status is not null then
    update public.delivery_requests
       set payment_status = p_payment_status
     where id = p_request
       and payment_status is distinct from 'captured';   -- never walk a capture backwards
  end if;

  update public.fetch_authorisation_attempts set
    hold_state      = p_state,
    hold_checked_at = now(),
    hold_detail     = p_detail,
    -- A deadline, once Stripe has given one, is not unlearned by a later read
    -- that omits it.
    authorisation_expires_at = coalesce(p_expires_at, authorisation_expires_at),
    -- Money already taken outranks anything said about the hold afterwards,
    -- and a hold the CUSTOMER cancelled stays 'terminal': operations must be
    -- able to tell a deliberate cancellation from one that simply lapsed.
    status = case
      when status in ('captured', 'terminal') then status
      when p_state = 'expired'                then 'expired'
      else status end,
    expired_at = case when p_state = 'expired' then coalesce(expired_at, now()) else expired_at end,
    updated_at = now()
  where delivery_request_id = p_request
  returning * into v_row;

  if not found then
    return jsonb_build_object('ok', true, 'attempt', false, 'reason', 'no_attempt');
  end if;

  return jsonb_build_object('ok', true, 'attempt', true, 'hold_state', v_row.hold_state,
                            'status', v_row.status,
                            'generation', v_row.authorisation_generation);
end;
$$;

-- ── 5. The one question the driver's progression may ask ──────────────────
--
-- "Is this Fetch authorisation still safe to fulfil?" Answered from
-- server-owned state only. A local timestamp never outranks a contradictory
-- Stripe status, because a contradictory Stripe status is recorded by
-- record_fetch_hold_state before this is ever consulted.
create or replace function public.fetch_hold_is_fulfillable(p_request uuid)
  returns table (ok boolean, reason text, detail text)
  language plpgsql stable security definer set search_path = public
as $$
declare
  a public.fetch_authorisation_attempts%rowtype;
  d public.delivery_requests%rowtype;
  -- How old a Stripe answer may be and still release a driver. The deadline
  -- above does the expiry work; this only bounds how long we go on trusting a
  -- reading of everything else — a customer cancellation, a bank reversal.
  -- Long enough that a driver waiting outside a shop is not interrupted.
  v_freshness constant interval := interval '2 hours';
begin
  select * into d from public.delivery_requests where id = p_request;
  if not found then
    return query select false, 'not_found'::text, null::text; return;
  end if;

  select * into a from public.fetch_authorisation_attempts where delivery_request_id = p_request;

  -- Already paid for. Nothing left that can expire.
  if d.payment_status = 'captured' or a.capture_state = 'captured' or a.status = 'captured' then
    return query select true, 'captured'::text, null::text; return;
  end if;

  if a.delivery_request_id is null then
    -- No authorisation was ever registered. Before 20260907120000 that was
    -- normal; since then it means the hold was never placed, and a driver
    -- collecting here is working for nothing.
    return query select false, 'not_authorised'::text,
      coalesce(d.payment_status, 'unpaid')::text; return;
  end if;

  if a.status = 'expired' or d.payment_status = 'expired' then
    return query select false, 'expired'::text, a.hold_detail; return;
  end if;
  if a.status = 'terminal' then
    return query select false, 'cancelled'::text, a.hold_detail; return;
  end if;
  if d.payment_status is distinct from 'authorised' then
    return query select false, 'not_authorised'::text, coalesce(d.payment_status, 'unpaid')::text; return;
  end if;

  -- Stripe's own deadline, when it gave one. Past it, the money is gone
  -- whatever anything here says.
  if a.authorisation_expires_at is not null and a.authorisation_expires_at <= now() then
    return query select false, 'expired'::text, 'the authorisation deadline has passed'::text; return;
  end if;

  if a.hold_state not in ('valid', 'expiring_soon') then
    return query select false, 'unverified'::text, a.hold_state; return;
  end if;
  if a.hold_checked_at is null or a.hold_checked_at < now() - v_freshness then
    return query select false, 'stale'::text, 'the hold has not been confirmed with Stripe recently'::text; return;
  end if;

  return query select true, 'valid'::text, null::text;
end;
$$;

comment on function public.fetch_hold_is_fulfillable(uuid) is
  'Whether this Fetch delivery may be progressed into physical fulfilment. Requires a live authorisation attempt, a payment_status of authorised, a Stripe deadline that has not passed, and a recent confirmation from Stripe. Fails closed: an unknown or unreadable hold is not a hold.';

-- ── 6. Collection stops being a matter of local memory ────────────────────
--
-- The gate goes HERE because this is the narrowest safe point: arriving costs
-- nothing, delivering is too late, and collecting is the moment the driver
-- takes possession and commits. Capture already re-reads the intent
-- immediately before taking money (20260908120000), so the two ends are
-- covered without a Stripe call at every tap.
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
  v_hold   record;
begin
  -- The caller must be the driver on this delivery's run. Same rule the
  -- authorise/capture endpoints enforce, applied at the database instead of
  -- in one more Edge Function that could forget it.
  select r.driver_id into v_driver
    from public.delivery_requests d join public.runs r on r.id = d.run_id
   where d.id = p_request;
  if v_driver is null or v_driver <> auth.uid() then
    raise exception 'Not the assigned driver for this delivery' using errcode = '42501';
  end if;

  -- Is the money still there? This function is SECURITY DEFINER, so
  -- tg_is_trusted_writer() answers true inside it and the payment gate on
  -- delivery_requests returns early — measured, not assumed. Without the check
  -- here a driver could collect an unfunded or long-expired delivery through
  -- the ordinary button.
  select * into v_hold from public.fetch_hold_is_fulfillable(p_request);
  if not v_hold.ok then
    if v_hold.reason = 'expired' then
      raise exception 'The customer''s payment authorisation has expired. Wait for them to re-authorise before collecting.'
        using errcode = '42501';
    elsif v_hold.reason in ('stale', 'unverified') then
      raise exception 'We could not confirm the customer''s payment hold just now. Refresh this delivery before collecting.'
        using errcode = '42501';
    elsif v_hold.reason = 'cancelled' then
      raise exception 'This delivery''s payment was cancelled. Please don''t collect.'
        using errcode = '42501';
    else
      raise exception 'This delivery is not authorised yet, so please don''t collect it.'
        using errcode = '42501';
    end if;
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

-- ── 7. Re-authorisation: the one legitimate second PaymentIntent ──────────
--
-- Stripe cannot revive a canceled intent, so an expired hold can only be
-- replaced. That is the single exception to "one delivery, one PaymentIntent",
-- and it is made deliberately narrow:
--
--   * the previous generation must already be recorded 'expired', which only
--     record_fetch_hold_state writes, and only from a Stripe reading. A
--     retry, a driver tap or a client cannot manufacture it.
--   * the row is LOCKED and the precondition re-checked inside the lock, so
--     twenty simultaneous attempts produce exactly one new generation.
--   * the frozen commercial terms are carried across untouched. The customer
--     agreed a price for this delivery; waiting for a hold to lapse is not a
--     reason to re-price it.
create or replace function public.reauthorise_fetch_delivery(
  p_request  uuid,
  p_customer uuid
) returns table (outcome text, new_generation integer, frozen_amount_pence integer)
-- The output columns are deliberately NOT called `generation` / `amount_pence`:
-- plpgsql would then treat those names as variables inside the archive INSERT
-- below, where they are also column names, and refuse the statement as
-- ambiguous. Naming them apart is clearer than a #variable_conflict pragma.
language plpgsql security definer set search_path = public
as $$
declare v_row public.fetch_authorisation_attempts%rowtype;
begin
  select * into v_row from public.fetch_authorisation_attempts
   where delivery_request_id = p_request for update;

  if not found then
    return query select 'no_attempt'::text, null::integer, null::integer; return;
  end if;
  if v_row.customer_id is distinct from p_customer then
    return query select 'forbidden'::text, null::integer, null::integer; return;
  end if;
  if v_row.status = 'captured' or v_row.capture_state = 'captured' then
    return query select 'captured'::text, v_row.authorisation_generation, v_row.amount_pence; return;
  end if;
  if v_row.status is distinct from 'expired' then
    -- Includes the live case. Nothing may replace a hold that still exists:
    -- that is how a customer ends up with two.
    return query select 'not_expired'::text, v_row.authorisation_generation, v_row.amount_pence; return;
  end if;

  insert into public.fetch_authorisation_generations
    (delivery_request_id, generation, stripe_payment_intent_id, status, amount_pence,
     base_fee_pence, service_fee_pence, wait_grace_secs, wait_period_secs,
     wait_period_pence, wait_max_pence, authorisation_expires_at, hold_state, hold_detail)
  values
    (v_row.delivery_request_id, v_row.authorisation_generation, v_row.stripe_payment_intent_id,
     v_row.status, v_row.amount_pence, v_row.base_fee_pence, v_row.service_fee_pence,
     v_row.wait_grace_secs, v_row.wait_period_secs, v_row.wait_period_pence,
     v_row.wait_max_pence, v_row.authorisation_expires_at, v_row.hold_state, v_row.hold_detail)
  on conflict (delivery_request_id, generation) do nothing;

  update public.fetch_authorisation_attempts set
    authorisation_generation = authorisation_generation + 1,
    stripe_payment_intent_id = null,
    status                   = 'in_flight',
    result                   = null,
    last_error               = null,
    hold_state               = 'unknown',
    hold_checked_at          = null,
    hold_detail              = null,
    authorisation_expires_at = null,
    expired_at               = null,
    capture_state            = 'none',
    capture_last_error       = null,
    capture_started_at       = null,
    -- base_fee_pence, service_fee_pence and every wait_* term are deliberately
    -- NOT touched. Same delivery, same agreed terms.
    updated_at               = now()
  where delivery_request_id = p_request
  returning * into v_row;

  -- The dead intent stops being this delivery's intent, so nothing can try to
  -- capture it and the new one is not refused as "a different PaymentIntent".
  update public.delivery_requests
     set payment_intent_id = null
   where id = p_request;

  return query select 'claimed'::text, v_row.authorisation_generation, v_row.amount_pence;
end;
$$;

revoke execute on function public.record_fetch_hold_state(uuid, text, text, timestamptz, text) from anon, authenticated, public;
revoke execute on function public.fetch_hold_is_fulfillable(uuid)                               from anon, authenticated, public;
revoke execute on function public.reauthorise_fetch_delivery(uuid, uuid)                        from anon, authenticated, public;
grant  execute on function public.record_fetch_hold_state(uuid, text, text, timestamptz, text) to service_role;
grant  execute on function public.fetch_hold_is_fulfillable(uuid)                               to service_role;
grant  execute on function public.reauthorise_fetch_delivery(uuid, uuid)                        to service_role;

-- A ceiling on the new hold-check endpoint: every call retrieves a
-- PaymentIntent from Stripe. Generous for the same reason fetch-authorise is —
-- a driver refused at a shop door is a worse failure than the abuse.
insert into public.rate_limit_policies (action, window_seconds, max_count, note) values
  ('fetch_hold_check',     3600,  180, 'each call retrieves a PaymentIntent from Stripe'),
  ('fetch_hold_check_day', 86400, 900, 'daily ceiling so the hourly limit cannot be farmed round the clock')
on conflict (action) do update
  set window_seconds = excluded.window_seconds,
      max_count      = excluded.max_count,
      note           = excluded.note;
