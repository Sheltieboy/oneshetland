-- Paygate 5 — a shift boost leaves a receipt.
--
-- WHAT WAS MISSING
--
-- A card-paid boost left three things, none of them a purchase record the buyer
-- could look at:
--
--   · Stripe's own row, outside OneShetland
--   · consumed_payment_intents — an internal replay guard: a PaymentIntent id, a
--     purpose and a user. No shift, no amount, no title. Nothing to render.
--   · shifts.boosted_until — an entitlement, and a temporary one. Twenty-four
--     hours later the only trace of the £2.99 inside the product was gone.
--
-- A wallet-paid boost at least produced a wallet transaction, so the same
-- purchase was durable or not depending on how it was paid for. That is not a
-- difference a customer should be able to feel.
--
-- WHY A TABLE, AND WHY THIS ONE
--
-- The smallest thing that could work was considered first and rejected on the
-- evidence:
--
--   · A read-time view, in the shape of get_business_transactions, cannot work
--     here. That function UNIONs source rows that already hold the money facts.
--     For a card boost there is no such row: the amount and the shift live only
--     in Stripe metadata.
--   · Joining shifts for the title would make old receipts change when the shift
--     is edited, and vanish when it is deleted. A receipt that rewrites itself
--     is not a receipt.
--   · local_wallet_transactions is the wallet BALANCE ledger. A card payment
--     never touched the wallet, so a row there would misstate the balance.
--   · local_boost_purchases belongs to Local business Pro — a different product
--     with different durations and prices that happens to share a word.
--
-- So: one narrow table, written by the authoritative fulfilment path, holding
-- what a receipt needs and nothing else.
--
-- WHAT IT DELIBERATELY DOES NOT HOLD
--
-- No Stripe customer id, no payment-method id, no card fingerprint, no
-- applicant or worker data. payment_intent_id is stored because it is the
-- idempotency key that makes one payment one row — and it is never selected by
-- any UI query.

begin;

create table if not exists public.shift_boost_purchases (
  id             uuid primary key default gen_random_uuid(),

  -- The purchaser. employer_id is the authority everywhere else in this
  -- paygate, so it is the authority here too.
  employer_id    uuid        not null references auth.users(id) on delete cascade,

  -- The shift is a convenience link, not the source of the receipt. ON DELETE
  -- SET NULL: if the listing goes, the purchase stays.
  shift_id       uuid        references public.shifts(id) on delete set null,
  shift_title    text        not null,

  -- Business context if it was posted as one. Display only — it confers no
  -- authority, and owning the business does not make its shifts yours.
  business_id    uuid        references public.local_businesses(id) on delete set null,
  business_name  text,

  amount_pence   integer     not null check (amount_pence > 0),
  duration_hours integer     not null check (duration_hours > 0),
  method         text        not null check (method in ('card', 'wallet')),
  status         text        not null default 'completed' check (status in ('completed')),

  -- Exactly one of these, and each is unique: one payment, one row.
  payment_intent_id  text,
  wallet_request_id  text,

  boosted_until  timestamptz not null,
  purchased_at   timestamptz not null default now(),

  constraint shift_boost_purchases_one_reference check (
    (payment_intent_id is not null and wallet_request_id is null) or
    (payment_intent_id is null and wallet_request_id is not null)
  )
);

-- The idempotency guarantees, as constraints rather than as care.
create unique index if not exists shift_boost_purchases_pi_key
  on public.shift_boost_purchases (payment_intent_id)
  where payment_intent_id is not null;
create unique index if not exists shift_boost_purchases_wallet_key
  on public.shift_boost_purchases (wallet_request_id)
  where wallet_request_id is not null;

create index if not exists shift_boost_purchases_employer_idx
  on public.shift_boost_purchases (employer_id, purchased_at desc);

comment on table public.shift_boost_purchases is
  'Durable receipt for a paid shift boost, card or wallet. Written only by the authoritative fulfilment path, in the same transaction as the boost grant. Survives boost expiry, shift cancellation and shift deletion — it is purchase history, not entitlement state.';

-- ── who may read it ─────────────────────────────────────────────────────────
--
-- The purchaser, and nobody else. Not the business owner (owning the business
-- named on an advert is not owning somebody else's payment), not the workers,
-- not anon. Writes are service-role only: there is no client INSERT policy, so
-- the only way a row appears is through fulfilment.

alter table public.shift_boost_purchases enable row level security;

drop policy if exists "Purchasers see their own boost purchases" on public.shift_boost_purchases;
create policy "Purchasers see their own boost purchases"
  on public.shift_boost_purchases
  for select
  using (employer_id = auth.uid());

revoke all on public.shift_boost_purchases from anon, authenticated;
grant select on public.shift_boost_purchases to authenticated;
grant all    on public.shift_boost_purchases to service_role;

-- ── card: the receipt joins the transaction that grants the boost ───────────
--
-- fulfil_shift_boost already claims the PaymentIntent and writes boosted_until
-- together, so a failure cannot leave one without the other. The receipt goes
-- inside the same transaction for the same reason: the alternative is a system
-- that believes fulfilment is complete while the customer's history is missing,
-- with the claim already taken so no retry can fix it.

create or replace function public.fulfil_shift_boost(
  p_pi       text,
  p_shift    uuid,
  p_employer uuid
)
returns table (
  granted       boolean,
  already       boolean,
  boosted_until timestamptz,
  eligible      boolean,
  reason        text
)
  language plpgsql
  security definer
  set search_path to 'public'
as $$
declare
  s        public.shifts%rowtype;
  v_elig   boolean;
  v_reason text;
  v_until  timestamptz;
  v_amount integer := 299;
  v_bizname text;
begin
  if p_pi is null or btrim(p_pi) = '' then
    raise exception 'fulfil_shift_boost: payment intent id is required';
  end if;
  if p_shift is null or p_employer is null then
    raise exception 'fulfil_shift_boost: shift and employer are required';
  end if;

  select * into s from public.shifts where id = p_shift for update;
  if not found then
    return query select false, false, null::timestamptz, false, 'shift_not_found';
    return;
  end if;

  if s.employer_id <> p_employer then
    return query select false, false, s.boosted_until, false, 'not_owner';
    return;
  end if;

  insert into public.consumed_payment_intents (payment_intent_id, purpose, user_id)
  values (p_pi, 'shift_boost', p_employer)
  on conflict (payment_intent_id) do nothing;

  if not found then
    return query select false, true, s.boosted_until, true, 'already_fulfilled';
    return;
  end if;

  select e.eligible, e.reason into v_elig, v_reason
    from public.shift_boost_eligibility(p_shift) e;

  update public.shifts
     set boosted_until = now() + interval '24 hours'
   where id = p_shift
  returning shifts.boosted_until into v_until;

  select b.name into v_bizname
    from public.local_businesses b
   where b.id = s.posted_as_business_id;

  -- The title and the business name are SNAPSHOTS. Editing the shift later
  -- must not rewrite what somebody was charged for.
  insert into public.shift_boost_purchases
    (employer_id, shift_id, shift_title, business_id, business_name,
     amount_pence, duration_hours, method, payment_intent_id, boosted_until)
  values
    (p_employer, p_shift, s.title, s.posted_as_business_id, v_bizname,
     v_amount, 24, 'card', p_pi, v_until)
  on conflict (payment_intent_id) where payment_intent_id is not null do nothing;

  return query select true, false, v_until, coalesce(v_elig, false),
                      case when coalesce(v_elig, false) then 'boosted' else 'boosted_ineligible' end;
end;
$$;

comment on function public.fulfil_shift_boost(text, uuid, uuid) is
  'Atomic shift-boost fulfilment: locks the shift, verifies ownership, claims the PaymentIntent, sets boosted_until = now() + 24h and writes the durable receipt — all in ONE transaction. Idempotent on payment_intent_id, so webhook and client confirm together produce one boost and one receipt. Returns (granted, already, boosted_until, eligible, reason).';

revoke all on function public.fulfil_shift_boost(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fulfil_shift_boost(text, uuid, uuid) to service_role;

-- ── wallet: the same two writes, the same transaction ───────────────────────
--
-- The wallet's debit and reversal are NOT touched. wallet-checkout still debits
-- first and still reverses if the entitlement cannot be granted. All that
-- changes is that granting the entitlement now also records the receipt, and
-- does both at once — so the reversal path still means exactly what it meant.

create or replace function public.grant_wallet_shift_boost(
  p_shift    uuid,
  p_employer uuid,
  p_rid      text,
  p_amount   integer
)
returns table (boosted_until timestamptz, already boolean)
  language plpgsql
  security definer
  set search_path to 'public'
as $$
declare
  s         public.shifts%rowtype;
  v_until   timestamptz;
  v_bizname text;
  v_existing timestamptz;
begin
  if p_shift is null or p_employer is null or p_rid is null or btrim(p_rid) = '' then
    raise exception 'grant_wallet_shift_boost: shift, employer and request id are required';
  end if;

  select * into s from public.shifts where id = p_shift for update;
  if not found then
    raise exception 'grant_wallet_shift_boost: shift not found';
  end if;
  if s.employer_id <> p_employer then
    raise exception 'grant_wallet_shift_boost: not the employer for this shift';
  end if;

  -- A retried attempt resolves to the receipt it already wrote rather than
  -- buying a second 24 hours.
  select p.boosted_until into v_existing
    from public.shift_boost_purchases p
   where p.wallet_request_id = p_rid;
  if found then
    return query select v_existing, true;
    return;
  end if;

  update public.shifts
     set boosted_until = now() + interval '24 hours'
   where id = p_shift
  returning shifts.boosted_until into v_until;

  select b.name into v_bizname
    from public.local_businesses b
   where b.id = s.posted_as_business_id;

  insert into public.shift_boost_purchases
    (employer_id, shift_id, shift_title, business_id, business_name,
     amount_pence, duration_hours, method, wallet_request_id, boosted_until)
  values
    (p_employer, p_shift, s.title, s.posted_as_business_id, v_bizname,
     p_amount, 24, 'wallet', p_rid, v_until);

  return query select v_until, false;
end;
$$;

comment on function public.grant_wallet_shift_boost(uuid, uuid, text, integer) is
  'Wallet shift-boost entitlement + receipt in ONE transaction, idempotent on the wallet attempt reference. The wallet debit and its reversal are unchanged and still owned by wallet-checkout; this only replaces the bare boosted_until update so the grant and its receipt cannot come apart.';

revoke all on function public.grant_wallet_shift_boost(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.grant_wallet_shift_boost(uuid, uuid, text, integer) to service_role;

-- ── the trap ────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'shifts' and t.tgname = 'lock_shift_columns' and not t.tgisinternal
  ) then
    raise exception 'Paygate 5: the F2 lock on shifts is missing — boosted_until would be client-writable';
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'shift_boost_purchases'
      and cmd in ('INSERT', 'UPDATE', 'DELETE')
  ) then
    raise exception 'Paygate 5: shift_boost_purchases has a client write policy — receipts must only come from fulfilment';
  end if;
end $$;

commit;
