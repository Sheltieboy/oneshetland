-- ═══════════════════════════════════════════════════════════════════════════
-- One OneShetland user, one Stripe Customer
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Fix 5 turned up a dead end at the very start of the Fetch payment rail:
--
--     if (!customerProfile?.stripe_customer_id) return 400
--
-- A customer who had never paid for anything had no Stripe Customer, so a
-- driver's accept answered 400 BEFORE any PaymentIntent existed. That left a
-- matched delivery with no attempt, no intent and — since Fix 2's cardless
-- recovery continues an intent that must already exist — no way back for the
-- customer at all. Measured on this database: 179 of 186 profiles have no
-- Stripe Customer, so it was the ordinary case, not an edge one.
--
-- ── Why a registry, and not just "create it if it is missing" ─────────────
--
-- The only place in the product that has ever created a Customer is
-- create-setup-intent, and it does it the way that looks obvious:
--
--     read profiles.stripe_customer_id  →  null
--     POST /v1/customers
--     write profiles.stripe_customer_id
--
-- A read, a decision and a write with nothing holding the gap. Two concurrent
-- calls both read null, both create, and one Customer is orphaned for ever —
-- the same shape as the double Fetch hold that 20260907120000 exists to
-- prevent. Adding a second copy of that pattern for Fetch would have doubled
-- the defect rather than fixed it, so this is the ONE mechanism and
-- create-setup-intent is moved onto it.
--
-- ── Recovering a Customer created by a process that then died ─────────────
--
-- Three layers, strongest first:
--
--   1. profiles.stripe_customer_id — the existing binding always wins.
--   2. THIS registry — durable, claimed under the primary key, so a retry
--      finds what the first attempt got as soon as it settled.
--   3. (in the server) Stripe's own metadata['supabase_user_id'] search, plus
--      a deterministic idempotency key on the create.
--
-- Layer 3 is deliberately last: Stripe documents search as unsuitable for
-- read-after-write and normally under a minute behind, so it recovers an
-- orphan but must never BE the identity. This table is the durable boundary.

create table if not exists public.stripe_customer_claims (
  -- One row per user, for ever. The primary key is the whole guarantee.
  user_id            uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text unique,
  status             text not null default 'in_flight'
    check (status in ('in_flight', 'bound', 'failed')),
  attempts           integer not null default 1,
  last_error         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.stripe_customer_claims is
  'One Stripe Customer per OneShetland user, decided by the primary key. Holds the customer id from the moment Stripe returns it, so a retry after a lost response finds the same Customer instead of creating a second, orphaned one.';

alter table public.stripe_customer_claims enable row level security;

-- Server-only. No policy deliberately: with RLS on and no policy, anon and
-- authenticated match nothing, and the grants say so as well.
revoke all on public.stripe_customer_claims from anon, authenticated;
grant select, insert, update on public.stripe_customer_claims to service_role;

-- A Stripe Customer belongs to exactly one person. Nothing enforced this
-- before; the 7 existing bindings on this database are already distinct, so it
-- costs nothing and closes a way for a mis-write to point two accounts at one
-- payment method.
create unique index if not exists profiles_stripe_customer_id_key
  on public.profiles (stripe_customer_id)
  where stripe_customer_id is not null;

-- ── Seed from what is already bound ────────────────────────────────────────
--
-- The registry has to be authoritative from its first moment, or an existing
-- customer's next call would "claim" creation and make them a second Customer.
insert into public.stripe_customer_claims (user_id, stripe_customer_id, status, attempts)
select p.id, p.stripe_customer_id, 'bound', 1
  from public.profiles p
 where p.stripe_customer_id is not null
on conflict (user_id) do nothing;

-- ── Claim the one Customer for this user ───────────────────────────────────
--
-- The race is decided by the insert, not by a preceding select. Twenty
-- simultaneous callers all try; the primary key lets exactly one through.
create or replace function public.claim_stripe_customer(p_user uuid)
  returns table (outcome text, stripe_customer_id text)
  language plpgsql security definer set search_path = public
as $$
declare
  v_row      public.stripe_customer_claims%rowtype;
  v_existing text;
begin
  if p_user is null then
    raise exception 'claim_stripe_customer: a user is required' using errcode = '22023';
  end if;

  -- An existing binding always wins, and is adopted into the registry rather
  -- than raced against.
  select p.stripe_customer_id into v_existing from public.profiles p where p.id = p_user;
  if v_existing is not null then
    insert into public.stripe_customer_claims (user_id, stripe_customer_id, status)
    values (p_user, v_existing, 'bound')
    on conflict (user_id) do update
      set stripe_customer_id = coalesce(public.stripe_customer_claims.stripe_customer_id, excluded.stripe_customer_id),
          status = 'bound', updated_at = now();
    return query select 'bound'::text, v_existing;
    return;
  end if;

  insert into public.stripe_customer_claims (user_id, status, updated_at)
  values (p_user, 'in_flight', now())
  on conflict (user_id) do nothing
  returning * into v_row;

  if found then
    -- This caller owns creation. Nobody else will.
    return query select 'claimed'::text, null::text;
    return;
  end if;

  -- Somebody holds it. Lock the row so two retries cannot both decide.
  select * into v_row from public.stripe_customer_claims
   where user_id = p_user for update;
  if not found then
    return query select 'in_flight'::text, null::text;
    return;
  end if;

  if v_row.stripe_customer_id is not null then
    return query select 'bound'::text, v_row.stripe_customer_id;
    return;
  end if;

  -- Another call is inside Stripe right now. Racing it is what makes two
  -- Customers; the caller is asked to come back instead.
  if v_row.status = 'in_flight' and v_row.updated_at > now() - interval '90 seconds' then
    return query select 'in_flight'::text, null::text;
    return;
  end if;

  -- A stale in_flight or a previous failure. Creation may be retried — the
  -- server's idempotency key and metadata lookup are what stop that retry
  -- becoming a second Customer.
  update public.stripe_customer_claims
     set status = 'in_flight', attempts = attempts + 1, updated_at = now()
   where user_id = p_user;
  return query select 'claimed'::text, null::text;
end;
$$;

-- ── Record the Customer the moment Stripe names it ─────────────────────────
--
-- Written once and never changed. A second, different id means two Customers
-- exist for one user, which is the bug this table prevents — so it refuses
-- rather than picking one and orphaning the other.
create or replace function public.settle_stripe_customer(
  p_user     uuid,
  p_customer text default null,
  p_error    text default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare v_row public.stripe_customer_claims%rowtype;
begin
  select * into v_row from public.stripe_customer_claims where user_id = p_user for update;
  if not found then
    raise exception 'settle_stripe_customer: no claim for this user' using errcode = '22023';
  end if;

  if p_customer is not null
     and v_row.stripe_customer_id is not null
     and v_row.stripe_customer_id <> p_customer then
    raise exception 'settle_stripe_customer: this user already holds a different Stripe Customer'
      using errcode = '23505';
  end if;

  update public.stripe_customer_claims set
    -- coalesce, never overwrite: a later settle without an id must not erase
    -- the one that makes recovery possible.
    stripe_customer_id = coalesce(p_customer, stripe_customer_id),
    status     = case when coalesce(p_customer, stripe_customer_id) is not null then 'bound'
                      when p_error is not null then 'failed'
                      else status end,
    last_error = p_error,
    updated_at = now()
  where user_id = p_user
  returning * into v_row;

  -- The profile is the read path the rest of the product already uses, so it
  -- is kept in step — but never overwritten. If a binding is somehow already
  -- there it outranks anything arriving now.
  if v_row.stripe_customer_id is not null then
    update public.profiles
       set stripe_customer_id = v_row.stripe_customer_id
     where id = p_user and stripe_customer_id is null;
  end if;

  return jsonb_build_object('ok', true, 'status', v_row.status,
                            'stripe_customer_id', v_row.stripe_customer_id);
end;
$$;

revoke execute on function public.claim_stripe_customer(uuid)               from anon, authenticated, public;
revoke execute on function public.settle_stripe_customer(uuid, text, text)  from anon, authenticated, public;
grant  execute on function public.claim_stripe_customer(uuid)               to service_role;
grant  execute on function public.settle_stripe_customer(uuid, text, text)  to service_role;
