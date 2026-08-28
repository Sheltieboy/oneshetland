-- ═══════════════════════════════════════════════════════════════════════════
-- One Fetch delivery, one hold
-- ═══════════════════════════════════════════════════════════════════════════
--
-- authorise-payment decided whether to create a PaymentIntent by reading a
-- column and finding it empty:
--
--     if (request.payment_intent_id && request.payment_status === 'authorised')
--       return already_authorised
--     … create the PaymentIntent …
--     await supabase.from('delivery_requests').update({ payment_intent_id: pi.id })
--
-- A read, then a decision, then a write, with nothing holding the gap. Two
-- concurrent accepts both read null, both create a manual-capture intent, and
-- the customer gets TWO holds on their card. The second id overwrites the
-- first, so the first hold is orphaned: nothing points at it, so nothing will
-- ever capture or cancel it, and it sits there until Stripe expires it.
--
-- ── Why the key is the delivery request ───────────────────────────────────
--
-- Wallet and subscription attempts are keyed on a client_request_id, because
-- there the economic operation is "this checkout" and a customer may
-- legitimately buy the same thing twice.
--
-- Fetch is not like that. The operation is "authorise THIS delivery", and a
-- delivery has exactly one authorisation for its whole life. A browser UUID
-- cannot express that: it is lost on reload, differs between the driver's
-- phone and their laptop, and a second driver-app invocation would mint a new
-- one and be allowed to create a second hold. The request id is the identity
-- that actually survives, so it IS the primary key — nothing weaker sits
-- underneath it.

create table if not exists public.fetch_authorisation_attempts (
  -- One row per delivery, for ever. The primary key is the whole guarantee.
  delivery_request_id      uuid primary key references public.delivery_requests(id) on delete cascade,
  customer_id              uuid not null references public.profiles(id),
  driver_id                uuid          references public.profiles(id),
  stripe_payment_intent_id text unique,
  status                   text not null default 'in_flight'
    check (status in ('in_flight', 'authorised', 'awaiting_customer', 'unresolved', 'captured', 'terminal')),
  amount_pence             integer,
  result                   jsonb,
  last_error               text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

comment on table public.fetch_authorisation_attempts is
  'One authorisation per delivery request, decided by the primary key. Holds the PaymentIntent id from the moment Stripe returns it, so a retry after a lost response finds the same intent instead of creating a second hold.';

alter table public.fetch_authorisation_attempts enable row level security;

-- Server-only. No policy is created deliberately: with RLS on and no policy,
-- anon and authenticated match nothing, and the grants below say so as well.
revoke all on public.fetch_authorisation_attempts from anon, authenticated;
grant select, insert, update on public.fetch_authorisation_attempts to service_role;

-- ── Claim the one authorisation for this delivery ──────────────────────────
--
-- The race is decided by the insert, not by a preceding select. Twenty
-- simultaneous callers all try; the primary key lets exactly one through.
create or replace function public.claim_fetch_authorisation(
  p_request  uuid,
  p_customer uuid,
  p_driver   uuid,
  p_amount   integer default null
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
    (delivery_request_id, customer_id, driver_id, amount_pence, status, updated_at)
  values
    (p_request, p_customer, p_driver, p_amount, 'in_flight', now())
  on conflict (delivery_request_id) do nothing
  returning * into v_row;

  if found then
    -- This caller owns creation. Nobody else will.
    return query select 'claimed'::text, 'in_flight'::text, null::text, null::jsonb;
    return;
  end if;

  -- Somebody holds it. Lock the row so two retries cannot both decide.
  select * into v_row from public.fetch_authorisation_attempts
   where delivery_request_id = p_request
     for update;
  if not found then
    -- Deleted between the insert and the select. Nothing to resume; the
    -- caller retries and takes the claim properly.
    return query select 'in_flight'::text, 'in_flight'::text, null::text, null::jsonb;
    return;
  end if;

  -- An authorisation belongs to the delivery, and the delivery to one
  -- customer. A different customer arriving here means something is wrong
  -- upstream; refuse rather than hand them somebody else's payment.
  if v_row.customer_id is distinct from p_customer then
    return query select 'conflict'::text, v_row.status, null::text, null::jsonb;
    return;
  end if;

  if v_row.status = 'terminal' then
    return query select 'terminal'::text, v_row.status, v_row.stripe_payment_intent_id, v_row.result;
    return;
  end if;

  -- Already reached Stripe: resume THAT intent. Never make another.
  if v_row.stripe_payment_intent_id is not null then
    return query select 'resume'::text, v_row.status, v_row.stripe_payment_intent_id, v_row.result;
    return;
  end if;

  -- Claimed but no intent yet — another call is inside Stripe right now.
  return query select 'in_flight'::text, v_row.status, null::text, v_row.result;
end;
$$;

-- ── Record the intent the moment Stripe names it ───────────────────────────
--
-- Called BEFORE anything that can fail or need the customer. Paygate 10 proved
-- the cost of leaving this to the end: a function that dies after Stripe has
-- created the intent leaves a live hold nothing points at.
--
-- The intent is written once and never changed. A second, different id means
-- two intents exist for one delivery, which is the bug this table prevents —
-- so it refuses rather than picking one and orphaning the other.
create or replace function public.settle_fetch_authorisation(
  p_request uuid,
  p_status  text,
  p_pi      text default null,
  p_result  jsonb default null,
  p_error   text default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare v_row public.fetch_authorisation_attempts%rowtype;
begin
  select * into v_row from public.fetch_authorisation_attempts
   where delivery_request_id = p_request for update;
  if not found then
    raise exception 'settle_fetch_authorisation: no attempt for this delivery' using errcode = '22023';
  end if;

  if p_pi is not null
     and v_row.stripe_payment_intent_id is not null
     and v_row.stripe_payment_intent_id <> p_pi then
    raise exception 'settle_fetch_authorisation: this delivery already holds a different PaymentIntent'
      using errcode = '23505';
  end if;

  update public.fetch_authorisation_attempts set
    status                   = p_status,
    -- coalesce, never overwrite: a later settle without an id must not erase
    -- the one that makes recovery possible.
    stripe_payment_intent_id = coalesce(p_pi, stripe_payment_intent_id),
    result                   = coalesce(p_result, result),
    last_error               = p_error,
    updated_at               = now()
  where delivery_request_id = p_request
  returning * into v_row;

  return jsonb_build_object('ok', true, 'status', v_row.status,
                            'stripe_payment_intent_id', v_row.stripe_payment_intent_id);
end;
$$;

-- ── The request row and the attempt must agree ─────────────────────────────
--
-- delivery_requests.payment_intent_id is written by the same trusted code, but
-- if the two ever diverged one intent would be silently orphaned. Fail closed
-- and say so instead of choosing.
create or replace function public.tg_fetch_pi_matches_attempt()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare v_pi text;
begin
  if new.payment_intent_id is null then return new; end if;
  if new.payment_intent_id is not distinct from old.payment_intent_id then return new; end if;

  select stripe_payment_intent_id into v_pi
    from public.fetch_authorisation_attempts
   where delivery_request_id = new.id;

  if v_pi is not null and v_pi <> new.payment_intent_id then
    raise exception 'This delivery already has a different PaymentIntent recorded — refusing to orphan one'
      using errcode = '23505';
  end if;
  return new;
end;
$$;

drop trigger if exists delivery_requests_pi_matches_attempt on public.delivery_requests;
create trigger delivery_requests_pi_matches_attempt
  before update on public.delivery_requests
  for each row execute function public.tg_fetch_pi_matches_attempt();

revoke execute on function public.claim_fetch_authorisation(uuid, uuid, uuid, integer)      from anon, authenticated, public;
revoke execute on function public.settle_fetch_authorisation(uuid, text, text, jsonb, text)  from anon, authenticated, public;
grant  execute on function public.claim_fetch_authorisation(uuid, uuid, uuid, integer)       to service_role;
grant  execute on function public.settle_fetch_authorisation(uuid, text, text, jsonb, text)  to service_role;
