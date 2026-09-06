-- ── A reversed transfer is not a failed one ─────────────────────────────────
--
-- wallet_reverse_debit marked the original spend transfer_state = 'failed'
-- whatever had happened to the merchant transfer. That conflated two different
-- facts:
--
--   failed    the transfer was attempted and Stripe refused it. The merchant
--             was never paid, so putting the wallet back costs them nothing.
--   reversed  the transfer succeeded, the merchant WAS paid, and we have since
--             clawed it back to fund a refund.
--
-- Three things went wrong because of that.
--
-- 1. 'reversed' was never a legal value, so the branch in
--    wallet_launch_reconciliation that deliberately tolerates it
--    (transfer_state not in ('none','sent','reversed')) could never match.
--    Every successful reversal therefore left the row looking like unresolved
--    external movement, and reconciliation refused that wallet FOR EVER.
--
-- 2. A replay of the same wallet attempt reads the state to decide whether an
--    unfinished transfer still needs sending. 'failed' is not in its terminal
--    set, so a refunded payment would resume: Stripe returns the original
--    (already reversed) transfer for the stable idempotency key, the row is
--    marked 'sent' again, and the reversal record is overwritten.
--
-- 3. An operator reading the ledger could not tell a payment that never
--    reached the merchant from one that was refunded out of their account.
--
-- Narrow by construction. 'failed' is written today by exactly one statement —
-- the one below — because wallet_mark_transfer is only ever called with 'none',
-- 'sent' or 'unresolved'. So the ONLY rows that change value are ones whose
-- transfer had genuinely been sent, which are precisely the mislabelled ones.
-- Nothing that legitimately reads 'sent', 'failed' or 'unresolved' today sees a
-- different answer tomorrow.
--
-- No backfill: production has never produced a reversal row.

-- ── 1. 'reversed' becomes representable ─────────────────────────────────────
alter table public.local_wallet_transactions
  drop constraint if exists local_wallet_transactions_transfer_state_check;

alter table public.local_wallet_transactions
  add constraint local_wallet_transactions_transfer_state_check
  check (transfer_state is null or transfer_state in
         ('none','pending','sent','failed','unresolved','reversed'));

comment on column public.local_wallet_transactions.transfer_state is
  'Where the external Stripe transfer for this ledger row got to. none = none was needed; pending = about to be sent; sent = the merchant was paid; reversed = a sent transfer was clawed back to fund a refund; failed = the attempt was refused and no money reached the merchant; unresolved = Stripe never told us, so it may or may not have moved.';


-- ── 2. wallet_mark_transfer understands it ──────────────────────────────────
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
  if p_state not in ('none','pending','sent','failed','unresolved','reversed') then
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


-- ── 3. The reversal records which of the two things happened ────────────────
--
-- Identical to the applied version in every other respect: same lock, same
-- idempotency, same arithmetic, same linked refund row, same refusal to touch
-- anything that is not a spend.
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
  v_state    text;
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
  --
  -- Which annotation depends on what actually happened to the merchant. A
  -- transfer that had been SENT has now been clawed back: that is 'reversed',
  -- a settled outcome reconciliation accepts and a replay must not resume.
  -- Anything else — pending, none, unresolved, unknown — never reached the
  -- merchant, so the attempt itself is what failed.
  v_state := case when v_orig.transfer_state = 'sent' then 'reversed' else 'failed' end;

  update public.local_wallet_transactions
     set transfer_state = v_state
   where id = p_transaction_id;

  return query select v_res.balance_pence, v_res.transaction_id, false;
end;
$$;

comment on function public.wallet_reverse_debit(uuid, text) is
  'Reverses a wallet debit by APPENDING a refund entry linked to it, never by deleting or editing the original. Marks the original ''reversed'' when its transfer had been sent and has now been clawed back, ''failed'' when no money ever reached the merchant. Idempotent: a second call returns the existing reversal. service_role only.';


-- ── 4. Privileges, restated ─────────────────────────────────────────────────
-- create or replace keeps existing grants, but a function that moves money
-- should not depend on that being remembered.
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.wallet_reverse_debit(uuid, text)',
    'public.wallet_mark_transfer(uuid, text, text)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;
