-- ============================================================================
-- Wallet balance and wallet ledger stop being two separate commits.
--
-- WHAT WAS WRONG
--
-- Every wallet debit in the system followed the same three-step shape:
--
--     rpc('wallet_debit')                  -- commits the balance change
--     fetch('https://api.stripe.com/...')  -- moves the money
--     .from('local_wallet_transactions')   -- SEPARATE commit, result unchecked
--       .insert({...})                     -- no .select(), no error branch
--
-- The balance mutation itself was never the problem. wallet_debit is a single
-- guarded UPDATE — it cannot overdraw and it cannot lose a concurrent race. The
-- problem is that the accounting entry lived outside it, in TypeScript, after a
-- network call, and nobody looked at whether it worked.
--
-- Seven call sites shared that shape:
--   _shared/wallet-pay.ts        (local-wallet-pay, wallet-charge-approve,
--                                 create-product-order-intent)
--   wallet-checkout              (hub donation, hub membership, unit purchase,
--                                 shift boost)
--   create-event-ticket-intent   (wallet ticket purchase)
--   create-gift-intent           (wallet gift purchase)
--
-- The ticket path shows how it actually bites: the ledger insert sits after
-- sendTicketReceipt(). If sending the receipt throws, the wallet is already
-- down, the order is already 'paid', and the accounting entry never happens.
--
-- THE EVIDENCE IS IN PRODUCTION
--
-- Three wallet accounts hold £127.86 between them. Their ledgers say they
-- should hold £361.31 — every one of them is BELOW its ledger, by £233.45 in
-- total. Money is missing from balances, not minted into them, which is exactly
-- the signature of debits that committed without an accounting entry.
--
-- One account reconciles perfectly once you account for the gap: a £8.95 wallet
-- ticket order and two wallet shop orders totalling £57.00 have no ledger rows
-- at all — 895 + 5700 = 6595p, its exact discrepancy to the penny.
--
-- WHAT REPLACES IT
--
-- One primitive that does the balance and the ledger in a single PostgreSQL
-- transaction, and cannot do one without the other. It follows the shape
-- wallet_topup already proved on the credit side: claim the accounting row, and
-- only then move the money.
--
-- Stripe is deliberately NOT inside that transaction. Holding database locks
-- across a network call to another company is how you turn a slow API into a
-- site-wide outage. Instead the ledger row carries its own transfer state, so
-- the gap between "we took the money" and "we sent the money" is a durable,
-- inspectable fact rather than a hope.
-- ============================================================================


-- ── The ledger learns to identify and track its own rows ────────────────────

alter table public.local_wallet_transactions
  add column if not exists idempotency_key text,
  add column if not exists transfer_state   text,
  add column if not exists reverses_transaction_id uuid
    references public.local_wallet_transactions(id);

-- Partial, because the 20 historical rows predate the column and must not
-- collide with each other on NULL.
create unique index if not exists local_wallet_transactions_idempotency_key
  on public.local_wallet_transactions (idempotency_key)
  where idempotency_key is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.local_wallet_transactions'::regclass
       and conname  = 'local_wallet_transactions_transfer_state_check'
  ) then
    alter table public.local_wallet_transactions
      add constraint local_wallet_transactions_transfer_state_check
      check (transfer_state is null or transfer_state in ('none','pending','sent','failed','unresolved'));
  end if;
end $$;

comment on column public.local_wallet_transactions.idempotency_key is
  'Stable identity for one logical wallet operation. UNIQUE where present, so a retry of the same operation cannot produce a second accounting entry.';
comment on column public.local_wallet_transactions.transfer_state is
  'Where the external Stripe transfer for this row got to: none (no transfer needed), pending, sent, failed, or unresolved. "unresolved" means Stripe may or may not have moved the money and a human or a retry must settle it — it is deliberately not treated as failure.';
comment on column public.local_wallet_transactions.reverses_transaction_id is
  'For a refund row, the debit it reverses. Reversals are appended; the original debit is never deleted or edited.';

-- Supports the "has this already been reversed?" check without a table scan.
create index if not exists idx_local_wallet_tx_reverses
  on public.local_wallet_transactions (reverses_transaction_id)
  where reverses_transaction_id is not null;


-- ── Debit and ledger, or neither ────────────────────────────────────────────
--
-- Ordering matters and is not arbitrary. The balance moves first under its
-- guard, then the accounting row is claimed. If the claim loses to a concurrent
-- retry, the function raises inside a sub-block — which rolls the balance change
-- back with it — and the handler returns the original outcome. That is why the
-- guard and the claim can be in either order and still be safe here: they are in
-- ONE transaction, so "both or neither" is enforced by Postgres rather than by
-- getting the sequence right.
create or replace function public.wallet_debit_with_ledger(
  p_user            uuid,
  p_spend           integer,
  p_cashback        integer default 0,
  p_type            text    default 'spend',
  p_business        uuid    default null,
  p_description     text    default null,
  p_idempotency_key text    default null,
  p_platform_fee    integer default null,
  p_needs_transfer  boolean default false
) returns table (
  balance_pence   integer,
  transaction_id  uuid,
  already_applied boolean,
  insufficient    boolean
)
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_new  integer;
  v_txn  uuid;
  v_prior public.local_wallet_transactions%rowtype;
begin
  -- ── Money is integer pence. Nothing else is money. ──────────────────────
  if p_user is null then
    raise exception 'wallet_debit_with_ledger: a user is required' using errcode = '22023';
  end if;
  if p_spend is null or p_spend < 0 or p_cashback is null or p_cashback < 0 then
    raise exception 'wallet_debit_with_ledger: amounts must be non-negative integers' using errcode = '22023';
  end if;
  if p_spend = 0 and p_cashback = 0 then
    raise exception 'wallet_debit_with_ledger: nothing to do' using errcode = '22023';
  end if;
  if p_platform_fee is not null and p_platform_fee < 0 then
    raise exception 'wallet_debit_with_ledger: platform fee must be non-negative' using errcode = '22023';
  end if;
  if p_type is null or p_type not in ('spend') then
    raise exception 'wallet_debit_with_ledger: a debit must be recorded as a spend' using errcode = '22023';
  end if;
  -- Cashback funded by a merchant can never exceed what the customer paid; if
  -- it could, this would mint money into the wallet.
  if p_cashback > p_spend then
    raise exception 'wallet_debit_with_ledger: cashback cannot exceed the spend' using errcode = '22023';
  end if;

  begin
    -- The guard is the overdraft protection AND the concurrency control. Two
    -- simultaneous spends contend on this row; the second re-tests the balance
    -- against the committed value and matches nothing if it can no longer pay.
    -- Every column reference is qualified: this function RETURNS TABLE
    -- (balance_pence …), which makes balance_pence a plpgsql variable that would
    -- otherwise shadow the column and raise "column reference is ambiguous" at
    -- runtime — a class of error CREATE FUNCTION does not catch.
    update public.local_wallet_balances b
       set balance_pence = b.balance_pence - p_spend + p_cashback,
           updated_at    = now()
     where b.user_id = p_user
       and b.balance_pence >= p_spend
    returning b.balance_pence into v_new;

    if not found then
      return query select
        coalesce((select b.balance_pence from public.local_wallet_balances b where b.user_id = p_user), 0),
        null::uuid, false, true;
      return;
    end if;

    -- The accounting entry. Same transaction, so it cannot be skipped, cannot
    -- fail silently, and cannot be lost to a crash between two commits.
    insert into public.local_wallet_transactions
      (user_id, business_id, type, amount_pence, platform_fee_pence, cashback_pence,
       description, idempotency_key, transfer_state)
    values
      (p_user, p_business, p_type, -p_spend, p_platform_fee, nullif(p_cashback, 0),
       p_description, p_idempotency_key,
       case when p_needs_transfer then 'pending' else 'none' end)
    on conflict (idempotency_key) where idempotency_key is not null
    do nothing
    returning id into v_txn;

    if v_txn is null then
      -- A concurrent call already owns this operation. Undo our balance change
      -- by unwinding this sub-block, then report theirs.
      raise exception 'WALLET_ALREADY_APPLIED' using errcode = '40001';
    end if;

    -- Cashback is a separate, positive entry so the ledger reads as what it is:
    -- the customer spent X and was given Y back, not "spent X minus Y".
    if p_cashback > 0 then
      insert into public.local_wallet_transactions
        (user_id, business_id, type, amount_pence, description, idempotency_key, transfer_state)
      values
        (p_user, p_business, 'cashback', p_cashback,
         coalesce(p_description, 'Cashback'),
         case when p_idempotency_key is null then null else p_idempotency_key || ':cashback' end,
         'none');
    end if;

    return query select v_new, v_txn, false, false;
    return;

  exception when sqlstate '40001' then
    -- The sub-block rolled back, so the balance is untouched. Hand back the
    -- result the winner produced.
    select * into v_prior from public.local_wallet_transactions
     where idempotency_key = p_idempotency_key;
    return query select
      coalesce((select b.balance_pence from public.local_wallet_balances b where b.user_id = p_user), 0),
      v_prior.id, true, false;
    return;
  end;
end;
$$;

comment on function public.wallet_debit_with_ledger(uuid, integer, integer, text, uuid, text, text, integer, boolean) is
  'The only safe way to take money out of a wallet. Moves the balance and writes the accounting entry in ONE transaction, so neither can happen without the other. Overdraft-proof by a guarded UPDATE, idempotent on p_idempotency_key, and records a separate positive cashback entry when one applies. service_role only.';


-- ── Credit and ledger, or neither ───────────────────────────────────────────
create or replace function public.wallet_credit_with_ledger(
  p_user            uuid,
  p_amount          integer,
  p_type            text    default 'refund',
  p_business        uuid    default null,
  p_description     text    default null,
  p_idempotency_key text    default null,
  p_reverses        uuid    default null
) returns table (
  balance_pence   integer,
  transaction_id  uuid,
  already_applied boolean
)
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_new integer;
  v_txn uuid;
  v_prior public.local_wallet_transactions%rowtype;
begin
  if p_user is null then
    raise exception 'wallet_credit_with_ledger: a user is required' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'wallet_credit_with_ledger: amount must be a positive integer' using errcode = '22023';
  end if;
  if p_type is null or p_type not in ('refund', 'topup', 'cashback') then
    raise exception 'wallet_credit_with_ledger: unsupported credit type %', p_type using errcode = '22023';
  end if;

  begin
    insert into public.local_wallet_transactions
      (user_id, business_id, type, amount_pence, description, idempotency_key,
       transfer_state, reverses_transaction_id)
    values
      (p_user, p_business, p_type, p_amount, p_description, p_idempotency_key, 'none', p_reverses)
    on conflict (idempotency_key) where idempotency_key is not null
    do nothing
    returning id into v_txn;

    if v_txn is null then
      raise exception 'WALLET_ALREADY_APPLIED' using errcode = '40001';
    end if;

    insert into public.local_wallet_balances (user_id, balance_pence, updated_at)
    values (p_user, p_amount, now())
    on conflict (user_id) do update
      set balance_pence = public.local_wallet_balances.balance_pence + excluded.balance_pence,
          updated_at    = now()
    returning public.local_wallet_balances.balance_pence into v_new;

    return query select v_new, v_txn, false;
    return;

  exception when sqlstate '40001' then
    select * into v_prior from public.local_wallet_transactions
     where idempotency_key = p_idempotency_key;
    return query select
      coalesce((select b.balance_pence from public.local_wallet_balances b where b.user_id = p_user), 0),
      v_prior.id, true;
    return;
  end;
end;
$$;

comment on function public.wallet_credit_with_ledger(uuid, integer, text, uuid, text, text, uuid) is
  'The only safe way to put money into a wallet. Balance and accounting entry in ONE transaction, idempotent on p_idempotency_key. service_role only.';


-- ── Reversing a debit, without pretending it never happened ─────────────────
--
-- Accounting is append-only here. A failed payment produces a DEBIT and a
-- REFUND, not an absence. That is both honest and useful: "this went wrong and
-- we put it back" is a materially different fact from "nothing occurred", and
-- only one of them can be audited.
create or replace function public.wallet_reverse_debit(
  p_transaction_id uuid,
  p_reason         text default null
) returns table (
  balance_pence     integer,
  reversal_id       uuid,
  already_reversed  boolean
)
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_orig     public.local_wallet_transactions%rowtype;
  v_cashback integer := 0;
  v_amount   integer;
  v_existing uuid;
  v_res      record;
begin
  if p_transaction_id is null then
    raise exception 'wallet_reverse_debit: a transaction id is required' using errcode = '22023';
  end if;

  select * into v_orig from public.local_wallet_transactions
   where id = p_transaction_id
     for update;
  if not found then
    raise exception 'wallet_reverse_debit: no such transaction' using errcode = '22023';
  end if;
  if v_orig.type <> 'spend' then
    raise exception 'wallet_reverse_debit: only a spend can be reversed' using errcode = '22023';
  end if;

  select id into v_existing from public.local_wallet_transactions
   where reverses_transaction_id = p_transaction_id
   limit 1;
  if v_existing is not null then
    return query select
      coalesce((select b.balance_pence from public.local_wallet_balances b where b.user_id = v_orig.user_id), 0),
      v_existing, true;
    return;
  end if;

  -- Give back exactly what was taken: the spend, less any cashback that was
  -- handed out at the same time and is being taken back with it.
  v_cashback := coalesce(v_orig.cashback_pence, 0);
  v_amount   := abs(v_orig.amount_pence) - v_cashback;
  if v_amount <= 0 then
    raise exception 'wallet_reverse_debit: nothing to return' using errcode = '22023';
  end if;

  select * into v_res from public.wallet_credit_with_ledger(
    v_orig.user_id,
    v_amount,
    'refund',
    v_orig.business_id,
    coalesce(p_reason, 'Reversal of ' || coalesce(v_orig.description, 'a wallet payment')),
    case when v_orig.idempotency_key is null then null else v_orig.idempotency_key || ':reversal' end,
    p_transaction_id
  );

  -- The original stands, annotated. It is not edited away.
  update public.local_wallet_transactions
     set transfer_state = 'failed'
   where id = p_transaction_id;

  return query select v_res.balance_pence, v_res.transaction_id, false;
end;
$$;

comment on function public.wallet_reverse_debit(uuid, text) is
  'Reverses a wallet debit by APPENDING a refund entry linked to it, never by deleting or editing the original. Idempotent: a second call returns the existing reversal. service_role only.';


-- ── Recording where the external transfer got to ────────────────────────────
--
-- Called after Stripe answers — outside the money transaction, because Stripe
-- is outside the money transaction. 'unresolved' exists because a timeout is
-- not a failure: Stripe may well have moved the money and lost the reply, and
-- refunding on that assumption pays twice.
create or replace function public.wallet_mark_transfer(
  p_transaction_id uuid,
  p_state          text,
  p_transfer_id    text default null
) returns boolean
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  if p_state not in ('none','pending','sent','failed','unresolved') then
    raise exception 'wallet_mark_transfer: unknown state %', p_state using errcode = '22023';
  end if;
  update public.local_wallet_transactions
     set transfer_state     = p_state,
         stripe_transfer_id = coalesce(p_transfer_id, stripe_transfer_id)
   where id = p_transaction_id;
  return found;
end;
$$;

comment on function public.wallet_mark_transfer(uuid, text, text) is
  'Records the outcome of the external Stripe transfer for a wallet ledger row. Never invents a transfer id and never clears one already recorded.';


-- ── The old primitives become safe, rather than being removed ───────────────
--
-- Every caller is being migrated, but a function that silently moved a balance
-- with no accounting entry should not remain callable in that form even if the
-- migration were incomplete. These now delegate, so the worst case for a path
-- nobody found is a correctly-ledgered entry with a generic description — which
-- is visible in the ledger and reconciles — rather than money vanishing.
--
-- Retiring them by raising was the alternative. Delegating is better: a missed
-- caller then fails safe instead of failing loud in production.
-- The existing signature carries `p_cashback integer DEFAULT 0`, and
-- CREATE OR REPLACE cannot drop a parameter default (42P13). Keeping the
-- default preserves the contract for any caller relying on it.
create or replace function public.wallet_debit(
  p_user uuid, p_spend integer, p_cashback integer default 0
) returns integer
  language plpgsql
  security definer
  set search_path = public
as $$
declare v_res record;
begin
  select * into v_res from public.wallet_debit_with_ledger(
    p_user, p_spend, coalesce(p_cashback, 0), 'spend', null,
    'Wallet debit (legacy path — no description supplied)', null, null, false
  );
  if v_res.insufficient then
    return null;                       -- unchanged contract: NULL means no funds
  end if;
  return v_res.balance_pence;
end;
$$;

comment on function public.wallet_debit(uuid, integer, integer) is
  'LEGACY SHIM. Delegates to wallet_debit_with_ledger so a balance can never move without an accounting entry. New code should call wallet_debit_with_ledger directly and pass a description and an idempotency key.';

create or replace function public.wallet_credit(
  p_user uuid, p_amount integer
) returns integer
  language plpgsql
  security definer
  set search_path = public
as $$
declare v_res record;
begin
  if p_amount = 0 then
    return (select balance_pence from public.local_wallet_balances where user_id = p_user);
  end if;
  select * into v_res from public.wallet_credit_with_ledger(
    p_user, p_amount, 'refund', null,
    'Wallet credit (legacy path — no description supplied)', null, null
  );
  return v_res.balance_pence;
end;
$$;

comment on function public.wallet_credit(uuid, integer) is
  'LEGACY SHIM. Delegates to wallet_credit_with_ledger so a balance can never move without an accounting entry.';


-- ── Reconciliation, as a first-class thing you can ask for ──────────────────
create or replace function public.wallet_reconciliation()
returns table (
  user_id        uuid,
  balance_pence  integer,
  ledger_pence   integer,
  delta_pence    integer,
  ledger_rows    integer
)
  language sql
  stable
  security definer
  set search_path = public
as $$
  select b.user_id,
         coalesce(b.balance_pence, 0),
         coalesce(l.total, 0),
         coalesce(b.balance_pence, 0) - coalesce(l.total, 0),
         coalesce(l.n, 0)
    from public.local_wallet_balances b
    left join (
      select t.user_id, sum(t.amount_pence)::int as total, count(*)::int as n
        from public.local_wallet_transactions t
       group by t.user_id
    ) l on l.user_id = b.user_id;
$$;

comment on function public.wallet_reconciliation() is
  'Every wallet account with its stored balance and its ledger-derived balance. For anything written after this migration the two must agree; historical rows predate atomic ledgering and carry a known, documented discrepancy.';


-- ── Privileges ──────────────────────────────────────────────────────────────
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.wallet_debit_with_ledger(uuid, integer, integer, text, uuid, text, text, integer, boolean)',
    'public.wallet_credit_with_ledger(uuid, integer, text, uuid, text, text, uuid)',
    'public.wallet_reverse_debit(uuid, text)',
    'public.wallet_mark_transfer(uuid, text, text)',
    'public.wallet_reconciliation()',
    'public.wallet_debit(uuid, integer, integer)',
    'public.wallet_credit(uuid, integer)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;

-- ── The money tables stop being writable in principle ───────────────────────
--
-- Both carried GRANT ALL to anon and authenticated. Nothing could actually be
-- written, because RLS has only SELECT policies and a command with no policy
-- affects no rows — verified against production, as anon and as an
-- authenticated user updating their OWN balance: zero rows, balance unchanged.
--
-- But the only thing standing between the public anon key and minting money was
-- the absence of a policy. One permissive INSERT policy added later, for some
-- unrelated feature, and the wallet is writable. Reads stay; writes go.
revoke insert, update, delete, truncate on table public.local_wallet_balances from anon, authenticated;
revoke insert, update, delete, truncate on table public.local_wallet_transactions from anon, authenticated;
revoke all on table public.wallet_payment_claims from anon, authenticated;
