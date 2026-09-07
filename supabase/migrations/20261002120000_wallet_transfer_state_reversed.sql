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
-- 'failed' is written today by exactly one statement — the reversal below —
-- because wallet_mark_transfer is only ever called with 'none', 'sent' or
-- 'unresolved'. So this migration is the whole of what writes it, and section 3
-- is where the decision now lives.
--
-- What it decides from changed after the four callers were traced: see the note
-- above section 3. The short version is that the row alone cannot say what
-- became of the merchant's money, so the caller says, and anything unconfirmed
-- settles as 'unresolved' rather than as a reversal nobody witnessed.
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


-- ── 3. The reversal records what actually happened to the merchant ─────────
--
-- The first draft of this decided from the row alone:
--
--     case when transfer_state = 'sent' then 'reversed' else 'failed' end
--
-- Tracing the four real callers showed that is not safe, and that the row does
-- not carry enough to decide it.
--
--   refund-payment / refundWalletMembership
--       reverses the transfer first and returns 502 if that fails, so it
--       arrives having clawed the money back — but only when the membership
--       row carried a transfer id. A wallet membership whose transfer ended
--       'unresolved' has NO transfer id, so no reversal is attempted, and the
--       wallet would be credited while Stripe may well have paid the hub.
--
--   wallet-checkout / refundUnfulfilled
--       reverses the transfer inside a try/catch that LOGS AND CONTINUES. When
--       the claw-back fails the customer is still refunded — correctly, they
--       got nothing — but the merchant still holds the money. Writing
--       'reversed' there would record a settlement that never happened.
--
--   wallet-checkout / shift boost
--       is platform-funded and omits the transfer entirely, so its row is
--       'none'. Rewriting that to 'failed' would invent a failed transfer that
--       was never attempted.
--
--   wallet-ledger / transfer rejected
--       arrives on 'pending', because the row is marked at the debit and the
--       rejection is what stops it becoming 'sent'. Only the CALLER knows
--       Stripe refused; the row cannot tell that apart from a process that
--       died mid-transfer, where Stripe may hold a transfer we never recorded.
--
-- So the caller states what happened to the merchant and the RPC checks that
-- against the row, rather than guessing. Where the two disagree, or where the
-- caller cannot say, it fails closed: the customer is still made whole, and
-- the row is marked 'unresolved' — which is true, blocks reconciliation, and
-- leaves a human to settle it. Nothing is ever recorded as reversed on the
-- strength of an assumption.
--
-- 'unresolved' on arrival is refused outright. That is the one state where
-- crediting the wallet may pay a second time, and no caller currently knows
-- enough to overrule it.
--
-- The two-argument form is DROPPED rather than left beside this one. Two
-- overloads would let an un-updated caller keep reaching the old guessing
-- version, which is exactly the trap a defaulted third parameter avoids.
drop function if exists public.wallet_reverse_debit(uuid, text);

create or replace function public.wallet_reverse_debit(
  p_transaction_id uuid,
  p_reason         text default null,
  p_merchant       text default null
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
  if p_merchant is not null and p_merchant not in ('clawed_back','never_paid','no_transfer') then
    raise exception 'wallet_reverse_debit: unknown merchant outcome %', p_merchant using errcode = '22023';
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

  -- Idempotency comes first, so a repeat of work already done never reaches a
  -- gate below and is never refused for a state its own reversal produced.
  select id into v_existing from public.local_wallet_transactions
   where reverses_transaction_id = p_transaction_id
   limit 1;
  if v_existing is not null then
    return query select
      coalesce((select b.balance_pence from public.local_wallet_balances b where b.user_id = v_orig.user_id), 0),
      v_existing, true;
    return;
  end if;

  -- ── The gates ────────────────────────────────────────────────────────────
  if v_orig.transfer_state = 'unresolved' then
    raise exception 'wallet_reverse_debit: the merchant transfer is unresolved — settle it at Stripe before refunding'
      using errcode = '22023';
  end if;
  if v_orig.transfer_state = 'reversed' then
    raise exception 'wallet_reverse_debit: marked reversed with no reversal recorded'
      using errcode = '22023';
  end if;
  if v_orig.transfer_state = 'sent' and p_merchant = 'never_paid' then
    raise exception 'wallet_reverse_debit: the transfer was sent, so it cannot be reported unpaid'
      using errcode = '22023';
  end if;
  if v_orig.transfer_state is distinct from 'sent' and p_merchant = 'clawed_back' then
    raise exception 'wallet_reverse_debit: nothing was sent, so nothing can have been clawed back'
      using errcode = '22023';
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

  -- The original stands, annotated with what became of the merchant's money.
  --
  --   sent    + clawed back  -> reversed   the money came back
  --   sent    + not told     -> unresolved the merchant may still hold it
  --   pending + never paid   -> failed     the attempt was refused
  --   pending + not told     -> unresolved a transfer may exist we never saw
  --   none                   -> none       there was never a transfer
  --   failed                 -> failed     it already failed
  v_state := case
               when v_orig.transfer_state = 'sent'
                 then case when p_merchant = 'clawed_back' then 'reversed' else 'unresolved' end
               when v_orig.transfer_state = 'pending'
                 then case when p_merchant = 'never_paid' then 'failed' else 'unresolved' end
               else v_orig.transfer_state
             end;

  update public.local_wallet_transactions
     set transfer_state = v_state
   where id = p_transaction_id;

  return query select v_res.balance_pence, v_res.transaction_id, false;
end;
$$;

comment on function public.wallet_reverse_debit(uuid, text, text) is
  'Reverses a wallet debit by APPENDING a refund entry linked to it, never by deleting or editing the original. p_merchant is what the CALLER knows became of the merchant transfer (clawed_back / never_paid / no_transfer); the row is marked from that, checked against its own transfer_state, and falls back to ''unresolved'' rather than claiming a settlement nobody confirmed. Refuses outright when the transfer was already unresolved. Idempotent: a second call returns the existing reversal. service_role only.';


-- ── 4. Privileges, restated ─────────────────────────────────────────────────
-- create or replace keeps existing grants, but a function that moves money
-- should not depend on that being remembered.
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.wallet_reverse_debit(uuid, text, text)',
    'public.wallet_mark_transfer(uuid, text, text)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;
