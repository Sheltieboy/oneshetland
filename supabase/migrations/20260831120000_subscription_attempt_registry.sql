-- Paygate 10 — one deliberate subscription checkout, one Stripe subscription.
--
-- THE DEFECT
--
-- local-subscription-intent creates a recurring subscription and, when a card is
-- already saved, confirms the first payment in the same request. It carried no
-- attempt reference and no Stripe idempotency key, and its only guard read
-- local_businesses.stripe_subscription_id — a column written asynchronously by
-- the WEBHOOK, so during the seconds a double-click spans it is still null.
--
-- Two clicks therefore produced two subscriptions, two first charges, and two
-- monthly renewals. A browser timeout was worse: the work had succeeded, the
-- customer saw nothing, and clicking again bought it a second time. Nothing in
-- the system could tell the two apart afterwards.
--
-- THE FIX
--
-- The same registry the wallet uses (wallet_payment_claims / claim_wallet_
-- attempt). The primary key decides concurrent duplicates, the fingerprint stops
-- one reference being reused for a different purchase, and an attempt that
-- already reached Stripe returns the subscription it created so the retry
-- RESUMES it rather than creating another.
--
-- Deliberately NOT stored: the PaymentIntent client secret. A resumed attempt
-- re-reads the subscription from Stripe and hands back that same intent, so the
-- secret lives exactly one place — Stripe — and recovery cannot serve a stale one.

begin;

create table if not exists public.local_subscription_attempts (
  client_request_id      text primary key,
  user_id                uuid not null references public.profiles(id),
  business_id            uuid not null references public.local_businesses(id) on delete cascade,
  tier                   text not null,
  period                 text not null,
  -- user + business + tier + period. The same reference must mean the same
  -- purchase; reused for a different one it is a bug or an attack, and either
  -- way it must not execute.
  payload_fingerprint    text not null,
  -- Written as soon as Stripe returns it, BEFORE the first payment is
  -- confirmed, so a crash mid-confirm still leaves the subscription findable.
  stripe_subscription_id text,
  status                 text not null default 'in_flight',
  result                 jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'local_subscription_attempts_status_check') then
    alter table public.local_subscription_attempts
      add constraint local_subscription_attempts_status_check
      check (status in ('in_flight', 'completed', 'failed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'local_subscription_attempts_tier_check') then
    alter table public.local_subscription_attempts
      add constraint local_subscription_attempts_tier_check check (tier in ('pro', 'premium'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'local_subscription_attempts_period_check') then
    alter table public.local_subscription_attempts
      add constraint local_subscription_attempts_period_check check (period in ('monthly', 'annual'));
  end if;
end $$;

create index if not exists idx_local_subscription_attempts_business
  on public.local_subscription_attempts (business_id, created_at desc);

-- Nothing holding an anon key or a user's token touches this. It is a server
-- bookkeeping ledger, not user-facing data, and it holds Stripe ids.
alter table public.local_subscription_attempts enable row level security;
revoke all on public.local_subscription_attempts from anon, authenticated;
grant select, insert, update on public.local_subscription_attempts to service_role;

-- ── Claiming one deliberate attempt ─────────────────────────────────────────
--
--   claimed   nobody held it — this call does the work
--   resume    it reached Stripe already; reuse THAT subscription
--   replay    it finished; return the recorded outcome
--   in_flight another delivery is mid-flight and has not reached Stripe yet
--   conflict  same reference, different person or different purchase

create or replace function public.claim_subscription_attempt(
  p_request_id  text,
  p_user        uuid,
  p_business    uuid,
  p_tier        text,
  p_period      text,
  p_fingerprint text
) returns table (
  outcome                text,
  status                 text,
  stripe_subscription_id text,
  result                 jsonb
)
language plpgsql security definer set search_path = public
as $function$
declare
  v_row public.local_subscription_attempts%rowtype;
begin
  if p_request_id is null or btrim(p_request_id) = '' then
    raise exception 'claim_subscription_attempt: a checkout reference is required' using errcode = '22023';
  end if;
  if length(p_request_id) > 128 then
    raise exception 'claim_subscription_attempt: the checkout reference is too long' using errcode = '22023';
  end if;
  if p_user is null or p_business is null then
    raise exception 'claim_subscription_attempt: a user and a business are required' using errcode = '22023';
  end if;

  -- The race is decided here. Concurrent identical requests all attempt the
  -- insert; the primary key lets exactly one through.
  insert into public.local_subscription_attempts
    (client_request_id, user_id, business_id, tier, period, payload_fingerprint, status, updated_at)
  values
    (p_request_id, p_user, p_business, p_tier, p_period, p_fingerprint, 'in_flight', now())
  on conflict (client_request_id) do nothing
  returning * into v_row;

  if found then
    return query select 'claimed'::text, 'in_flight'::text, null::text, null::jsonb;
    return;
  end if;

  -- Someone holds it. Lock the row so two retries cannot both decide to resume.
  select * into v_row from public.local_subscription_attempts
   where client_request_id = p_request_id
     for update;

  if not found then
    return query select 'in_flight'::text, 'in_flight'::text, null::text, null::jsonb;
    return;
  end if;

  -- A claim belongs to whoever took it. Never hand one person another's
  -- subscription, and never let one person's retry act on another's business.
  if v_row.user_id is distinct from p_user then
    return query select 'conflict'::text, v_row.status, null::text, null::jsonb;
    return;
  end if;

  if v_row.payload_fingerprint is distinct from p_fingerprint then
    return query select 'conflict'::text, v_row.status, null::text, null::jsonb;
    return;
  end if;

  if v_row.status in ('completed', 'failed') then
    return query select 'replay'::text, v_row.status, v_row.stripe_subscription_id, v_row.result;
    return;
  end if;

  -- in_flight. If it already reached Stripe, the retry must pick up THAT
  -- subscription — this is the whole point of recording the id before
  -- confirming. Otherwise a genuinely concurrent duplicate is told to wait.
  if v_row.stripe_subscription_id is not null then
    return query select 'resume'::text, v_row.status, v_row.stripe_subscription_id, v_row.result;
    return;
  end if;

  return query select 'in_flight'::text, v_row.status, null::text, null::jsonb;
end;
$function$;

comment on function public.claim_subscription_attempt(text, uuid, uuid, text, text, text) is
  'Claims one deliberate subscription checkout. Returns claimed / resume / replay / in_flight / conflict. The primary key decides concurrent duplicates; the fingerprint stops one reference buying a different plan or business; an attempt that already reached Stripe returns resume so the retry reuses the SAME subscription. service_role only.';

-- ── Recording where an attempt got to ───────────────────────────────────────
create or replace function public.settle_subscription_attempt(
  p_request_id text,
  p_status     text,
  p_sub_id     text  default null,
  p_result     jsonb default null
) returns boolean
language plpgsql security definer set search_path = public
as $function$
begin
  if p_status not in ('in_flight', 'completed', 'failed') then
    raise exception 'settle_subscription_attempt: unknown status %', p_status using errcode = '22023';
  end if;

  update public.local_subscription_attempts set
    -- Never unset a subscription id once known: that id is how a later retry
    -- finds the thing Stripe already created.
    stripe_subscription_id = coalesce(p_sub_id, stripe_subscription_id),
    status                 = p_status,
    result                 = coalesce(p_result, result),
    updated_at             = now()
  where client_request_id = p_request_id;

  return found;
end;
$function$;

revoke execute on function public.claim_subscription_attempt(text, uuid, uuid, text, text, text) from anon, authenticated, public;
revoke execute on function public.settle_subscription_attempt(text, text, text, jsonb)             from anon, authenticated, public;
grant  execute on function public.claim_subscription_attempt(text, uuid, uuid, text, text, text) to service_role;
grant  execute on function public.settle_subscription_attempt(text, text, text, jsonb)             to service_role;

commit;
