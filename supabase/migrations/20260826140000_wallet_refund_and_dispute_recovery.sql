-- Paygate 7 — money that comes back out of a card comes back out of the wallet.
--
-- THE HOLE
--
-- A card top-up credited spendable stored value, and nothing in OneShetland
-- ever looked at that charge again. charge.refunded touched delivery requests
-- and event tickets and never the wallet; charge.dispute.created was not a
-- handled event at all. So:
--
--   top up £100  →  spend £100 at a business (transferred to their account)
--   →  refund or charge back the card  →  wallet unchanged, money gone.
--
-- The platform absorbed it, silently, with nothing recorded and nobody told.
--
-- WHAT IS ADDED, AND WHY IT IS THIS SMALL
--
--   · one column, local_wallet_balances.deficit_pence — what a customer owes
--     the wallet after a reversal it could not fully fund;
--   · one table, local_wallet_topup_recovery — one row per topped-up
--     PaymentIntent, holding what Stripe has cumulatively taken back and what
--     we have cumulatively recovered;
--   · three functions — recover, dispute-state, and the deficit-aware credit.
--
-- No generic finance system. The wallet's existing atomic credit and debit are
-- not redesigned; they are extended to know about a deficit.
--
-- WHY CUMULATIVE, NOT PER-EVENT
--
-- Stripe's charge.refunded carries amount_refunded — the running total, not the
-- delta — and delivers events more than once. A dispute lost for the same
-- charge may arrive alongside refund accounting for the same money. Keying on
-- event ids would make every one of those a separate subtraction.
--
-- So each row stores the cumulative figure per SOURCE and recovers only
--
--     greatest(refunded, dispute_lost)  −  already recovered
--
-- which is monotonic, never negative, capped at the original top-up, and cannot
-- take the same £100 twice however many events describe it.
--
-- WHY THE DEFICIT IS NOT IN THE LEDGER
--
-- The ledger records money that moved. A deficit is money that did not — the
-- customer had already spent it. Every recovery writes a ledger row for the
-- part it could actually take, so balance still equals the sum of the ledger
-- and wallet_reconciliation() stays exact. The unfunded remainder is carried in
-- deficit_pence and repaid, with its own ledger row, by the next top-up.

begin;

-- ── What a wallet owes ──────────────────────────────────────────────────────
alter table public.local_wallet_balances
  add column if not exists deficit_pence integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'local_wallet_balances_deficit_check') then
    alter table public.local_wallet_balances
      add constraint local_wallet_balances_deficit_check check (deficit_pence >= 0);
  end if;
end $$;

comment on column public.local_wallet_balances.deficit_pence is
  'What this wallet owes after a refund or lost dispute it could not fully fund from the available balance. Spending is refused while it is above zero, and the next top-up repays it before anything becomes spendable. Deliberately NOT a negative balance: the ledger records money that moved, and this is money that did not.';

-- ── One row per topped-up payment, tracking what Stripe took back ───────────
create table if not exists public.local_wallet_topup_recovery (
  payment_intent_id  text        primary key,
  user_id            uuid        not null references auth.users(id) on delete cascade,
  topup_pence        integer     not null check (topup_pence > 0),

  -- Cumulative figures, each from its own Stripe source. The recovery target is
  -- the greater of the two, so a lost dispute and a refund describing the same
  -- money cannot be charged for twice.
  refunded_pence     integer     not null default 0 check (refunded_pence     >= 0),
  dispute_lost_pence integer     not null default 0 check (dispute_lost_pence >= 0),
  recovered_pence    integer     not null default 0 check (recovered_pence    >= 0),

  dispute_id         text,
  dispute_state      text        check (dispute_state is null or dispute_state in ('open', 'won', 'lost')),

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists local_wallet_topup_recovery_user_idx
  on public.local_wallet_topup_recovery (user_id);
create index if not exists local_wallet_topup_recovery_open_dispute_idx
  on public.local_wallet_topup_recovery (user_id) where dispute_state = 'open';

comment on table public.local_wallet_topup_recovery is
  'One row per wallet top-up PaymentIntent that Stripe has reversed or disputed. Holds the cumulative refunded and dispute-lost amounts and how much has actually been recovered, so repeated and overlapping webhook events settle to exactly one economic recovery.';

-- Service role only. It names payment intents and dispute ids; a customer sees
-- the consequences through their balance and their wallet history, not this.
alter table public.local_wallet_topup_recovery enable row level security;
revoke all on public.local_wallet_topup_recovery from anon, authenticated;
grant all on public.local_wallet_topup_recovery to service_role;

-- ── Is this wallet allowed to spend? ────────────────────────────────────────
create or replace function public.wallet_spend_block(p_user uuid)
returns table (blocked boolean, reason text, deficit_pence integer)
  language sql
  stable
  security definer
  set search_path to 'public'
as $$
  select
    coalesce(b.deficit_pence, 0) > 0
      or exists (select 1 from public.local_wallet_topup_recovery r
                  where r.user_id = p_user and r.dispute_state = 'open'),
    case
      when coalesce(b.deficit_pence, 0) > 0 then 'deficit'
      when exists (select 1 from public.local_wallet_topup_recovery r
                    where r.user_id = p_user and r.dispute_state = 'open') then 'dispute'
      else null
    end,
    coalesce(b.deficit_pence, 0)
  from (select p_user as user_id) k
  left join public.local_wallet_balances b on b.user_id = k.user_id;
$$;

comment on function public.wallet_spend_block(uuid) is
  'Whether this wallet may spend: refused while a recovery deficit is outstanding, or while a dispute on one of its top-ups is still open. Read by the debit primitive itself, not merely by a screen.';

revoke all on function public.wallet_spend_block(uuid) from public, anon, authenticated;
grant execute on function public.wallet_spend_block(uuid) to service_role;

-- ── Recovery ────────────────────────────────────────────────────────────────
--
-- p_cumulative is the RUNNING TOTAL Stripe reports for this source, not a
-- delta: charge.amount_refunded for a refund, dispute.amount for a lost
-- dispute. Called again with the same figure, this does nothing.

create or replace function public.wallet_recover_topup(
  p_pi         text,
  p_kind       text,        -- 'refund' | 'dispute_lost'
  p_cumulative integer,
  p_dispute_id text default null
)
returns table (
  recovered_now_pence integer,
  taken_pence         integer,
  deficit_pence       integer,
  balance_pence       integer,
  already             boolean,
  reason              text
)
  language plpgsql
  security definer
  set search_path to 'public'
as $$
declare
  r        public.local_wallet_topup_recovery%rowtype;
  v_topup  public.local_wallet_transactions%rowtype;
  v_target integer;
  v_delta  integer;
  v_take   integer;
  v_bal    integer;
  v_def    integer;
begin
  if p_pi is null or btrim(p_pi) = '' then
    raise exception 'wallet_recover_topup: payment intent id is required' using errcode = '22023';
  end if;
  if p_kind not in ('refund', 'dispute_lost') then
    raise exception 'wallet_recover_topup: unknown kind %', p_kind using errcode = '22023';
  end if;
  if p_cumulative is null or p_cumulative < 0 then
    raise exception 'wallet_recover_topup: cumulative amount must be non-negative' using errcode = '22023';
  end if;

  -- The top-up this payment funded. If there is none, this charge was not a
  -- wallet top-up and nothing here applies.
  select * into v_topup from public.local_wallet_transactions
   where stripe_payment_intent_id = p_pi and type = 'topup';
  if not found then
    return query select 0, 0, 0, 0, false, 'not_a_topup';
    return;
  end if;

  insert into public.local_wallet_topup_recovery (payment_intent_id, user_id, topup_pence)
  values (p_pi, v_topup.user_id, v_topup.amount_pence)
  on conflict (payment_intent_id) do nothing;

  select * into r from public.local_wallet_topup_recovery
   where payment_intent_id = p_pi for update;

  if p_kind = 'refund' then
    r.refunded_pence := greatest(r.refunded_pence, p_cumulative);
  else
    r.dispute_lost_pence := greatest(r.dispute_lost_pence, p_cumulative);
    r.dispute_state := 'lost';
    r.dispute_id := coalesce(p_dispute_id, r.dispute_id);
  end if;

  -- Never take back more than was ever credited, and never twice.
  v_target := least(greatest(r.refunded_pence, r.dispute_lost_pence), r.topup_pence);
  v_delta  := v_target - r.recovered_pence;

  if v_delta <= 0 then
    update public.local_wallet_topup_recovery
       set refunded_pence     = r.refunded_pence,
           dispute_lost_pence = r.dispute_lost_pence,
           dispute_state      = r.dispute_state,
           dispute_id         = r.dispute_id,
           updated_at         = now()
     where payment_intent_id = p_pi;
    select coalesce(b.balance_pence,0), coalesce(b.deficit_pence,0) into v_bal, v_def
      from public.local_wallet_balances b where b.user_id = r.user_id;
    return query select 0, 0, coalesce(v_def,0), coalesce(v_bal,0), true, 'no_change';
    return;
  end if;

  -- Lock the balance row, then take what is actually there.
  insert into public.local_wallet_balances (user_id, balance_pence, updated_at)
  values (r.user_id, 0, now()) on conflict (user_id) do nothing;

  select b.balance_pence, b.deficit_pence into v_bal, v_def
    from public.local_wallet_balances b where b.user_id = r.user_id for update;

  v_take := least(v_delta, greatest(coalesce(v_bal, 0), 0));

  -- The ledger records money that moved: only the part actually taken.
  if v_take > 0 then
    insert into public.local_wallet_transactions
      (user_id, type, amount_pence, description, idempotency_key,
       stripe_payment_intent_id, transfer_state)
    values
      (r.user_id, 'refund', -v_take,
       case when p_kind = 'refund' then 'Top-up refunded' else 'Top-up charged back' end,
       'recovery:' || p_pi || ':' || v_target::text, null, 'none')
    on conflict (idempotency_key) where idempotency_key is not null do nothing;
  end if;

  update public.local_wallet_balances
     set balance_pence = balance_pence - v_take,
         deficit_pence = deficit_pence + (v_delta - v_take),
         updated_at    = now()
   where user_id = r.user_id
  returning balance_pence, deficit_pence into v_bal, v_def;

  update public.local_wallet_topup_recovery
     set refunded_pence     = r.refunded_pence,
         dispute_lost_pence = r.dispute_lost_pence,
         dispute_state      = r.dispute_state,
         dispute_id         = r.dispute_id,
         recovered_pence    = v_target,
         updated_at         = now()
   where payment_intent_id = p_pi;

  return query select v_delta, v_take, v_def, v_bal, false,
                      case when v_delta > v_take then 'partial_deficit' else 'recovered' end;
end;
$$;

comment on function public.wallet_recover_topup(text, text, integer, text) is
  'Takes back a reversed wallet top-up. p_cumulative is Stripe''s RUNNING TOTAL for that source, so repeated and partial events settle to exactly one economic recovery, and a lost dispute plus a refund for the same money cannot both be charged. Available balance is recovered first; any shortfall becomes a deficit that blocks spending and is repaid by the next top-up. One transaction.';

revoke all on function public.wallet_recover_topup(text, text, integer, text) from public, anon, authenticated;
grant execute on function public.wallet_recover_topup(text, text, integer, text) to service_role;

-- ── Dispute state ───────────────────────────────────────────────────────────
--
-- Opening a dispute is not yet a loss, so nothing is reversed — but the wallet
-- stops spending, because every pound spent while a chargeback is in flight is
-- a pound the platform may end up funding twice.

create or replace function public.wallet_set_dispute_state(
  p_pi         text,
  p_dispute_id text,
  p_state      text
)
returns table (state text, blocked boolean, reason text)
  language plpgsql
  security definer
  set search_path to 'public'
as $$
declare
  v_topup public.local_wallet_transactions%rowtype;
  v_block record;
begin
  if p_state not in ('open', 'won', 'lost') then
    raise exception 'wallet_set_dispute_state: unknown state %', p_state using errcode = '22023';
  end if;

  select * into v_topup from public.local_wallet_transactions
   where stripe_payment_intent_id = p_pi and type = 'topup';
  if not found then
    return query select null::text, false, 'not_a_topup';
    return;
  end if;

  insert into public.local_wallet_topup_recovery (payment_intent_id, user_id, topup_pence)
  values (p_pi, v_topup.user_id, v_topup.amount_pence)
  on conflict (payment_intent_id) do nothing;

  -- Idempotent: repeating the same state changes nothing, and a dispute already
  -- resolved is not reopened by a redelivered "created".
  update public.local_wallet_topup_recovery
     set dispute_id    = coalesce(p_dispute_id, dispute_id),
         dispute_state = case
                           when dispute_state in ('won', 'lost') and p_state = 'open' then dispute_state
                           else p_state
                         end,
         updated_at    = now()
   where payment_intent_id = p_pi;

  select * into v_block from public.wallet_spend_block(v_topup.user_id);
  return query select
    (select dispute_state from public.local_wallet_topup_recovery where payment_intent_id = p_pi),
    v_block.blocked, coalesce(v_block.reason, 'none');
end;
$$;

comment on function public.wallet_set_dispute_state(text, text, text) is
  'Records where a dispute on a wallet top-up has got to. Opening one locks the wallet without reversing anything — a dispute is not yet a loss. Winning clears the lock and creates no debt. Losing is handled by wallet_recover_topup, which takes the money back exactly once. Idempotent on redelivery, and a redelivered "created" never reopens a resolved dispute.';

revoke all on function public.wallet_set_dispute_state(text, text, text) from public, anon, authenticated;
grant execute on function public.wallet_set_dispute_state(text, text, text) to service_role;

-- ── Top-up, now aware of what the wallet owes ───────────────────────────────
--
-- Unchanged in every way that mattered: the ledger claim on the PaymentIntent
-- is still the single source of truth for "already credited", and the claim and
-- the credit are still one transaction. What is new is that a wallet carrying a
-- deficit repays it FIRST, so somebody cannot be reversed £80 and then top up
-- £100 and immediately spend all of it.

-- Postgres will not widen an existing function's return type in place, and the
-- extra column is how a caller learns a deficit was repaid. Dropped and
-- recreated inside this transaction, so no caller ever sees it missing.
drop function if exists public.wallet_topup(uuid, integer, text);

create function public.wallet_topup(
  p_user   uuid,
  p_amount integer,
  p_pi     text
) returns table (balance_pence integer, already_credited boolean, deficit_repaid_pence integer)
  language plpgsql
  security definer
  set search_path to 'public'
as $$
declare
  v_new    int;
  v_def    int;
  v_repay  int;
begin
  if p_amount is null or p_amount < 0 then
    raise exception 'wallet_topup: amount must be >= 0';
  end if;
  if p_pi is null or p_pi = '' then
    raise exception 'wallet_topup: payment intent id is required';
  end if;

  insert into public.local_wallet_transactions
    (user_id, type, amount_pence, stripe_payment_intent_id, description)
  values
    (p_user, 'topup', p_amount, p_pi, 'Wallet top-up')
  on conflict (stripe_payment_intent_id)
    where stripe_payment_intent_id is not null
    do nothing;

  if not found then
    select b.balance_pence into v_new
      from public.local_wallet_balances b
     where b.user_id = p_user;
    return query select coalesce(v_new, 0), true, 0;
    return;
  end if;

  insert into public.local_wallet_balances (user_id, balance_pence, updated_at)
  values (p_user, p_amount, now())
  on conflict (user_id) do update
    set balance_pence = public.local_wallet_balances.balance_pence + excluded.balance_pence,
        updated_at    = now()
  returning public.local_wallet_balances.balance_pence, public.local_wallet_balances.deficit_pence
       into v_new, v_def;

  -- Repay what is owed before anything becomes spendable. Its own ledger row,
  -- so the balance still equals the sum of the ledger and the history reads as
  -- what happened rather than as a smaller top-up.
  v_repay := least(coalesce(v_def, 0), p_amount);
  if v_repay > 0 then
    insert into public.local_wallet_transactions
      (user_id, type, amount_pence, description, idempotency_key, transfer_state)
    values
      (p_user, 'refund', -v_repay, 'Top-up reversal repaid', 'deficit-repay:' || p_pi, 'none')
    on conflict (idempotency_key) where idempotency_key is not null do nothing;

    update public.local_wallet_balances
       set balance_pence = balance_pence - v_repay,
           deficit_pence = deficit_pence - v_repay,
           updated_at    = now()
     where user_id = p_user
    returning balance_pence into v_new;
  end if;

  return query select v_new, false, v_repay;
end;
$$;

revoke all on function public.wallet_topup(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.wallet_topup(uuid, integer, text) to service_role;

commit;
