-- ============================================================================
-- A launch reset that explains itself instead of tidying the number away.
--
-- WHAT NEEDS RECONCILING
--
-- Three wallets exist, all created before the Step 6 atomic ledger. Every one
-- of their twenty transactions predates it: zero have an idempotency_key, zero
-- a transfer_state, zero a reversal reference. They are the output of the old
-- non-atomic path, which moved the balance and wrote the ledger row as two
-- separate operations.
--
-- So the stored balance and the ledger disagree, in the same direction every
-- time — the balance is LOWER than the sum of the rows:
--
--   stored £127.86     ledger £361.31     variance -£233.45
--
-- Money left the balances that no row records.
--
-- WHY ONE ADJUSTMENT CANNOT DO THIS HONESTLY
--
-- To zero the stored balance takes -(balance). To zero the ledger takes
-- -(ledger total). Those are different numbers, and picking either one leaves
-- the other wrong — or worse, quietly hides the difference inside a single
-- figure that looks tidy and explains nothing.
--
-- So each wallet gets TWO rows, because two different things are true:
--
--   1. a VARIANCE row, amount = stored - ledger. This records spending that
--      really did leave the balance and was never written down. It does NOT
--      touch the balance, because the balance already reflects it. It exists so
--      the ledger finally tells the truth about what happened.
--
--   2. a RESET row, amount = -(stored balance). This is the launch reset
--      itself, and it does move the balance, to zero.
--
-- After both: ledger sum = 0 AND stored balance = 0, with the historical
-- discrepancy visible as its own line rather than absorbed into one.
--
-- WHAT THIS DOES NOT DO
--
-- Nothing historical is deleted or edited. No amount is rewritten. No Stripe
-- reference is removed. Every original row stays exactly as the old code left
-- it — they are the evidence of what happened, and a launch tidy-up is not a
-- reason to lose them.
--
-- REFUSES RATHER THAN GUESSES
--
-- If a wallet has any unresolved external money movement — a transfer that is
-- pending or unresolved, an open payment claim, a pending charge request — the
-- function refuses that wallet. Zeroing a balance while money is still moving
-- outside the database is how a reconciliation becomes a loss.
--
-- NO ACCOUNT IDS LIVE HERE
--
-- The target is a parameter. Which accounts are reset is decided at call time
-- by an operator who has just verified them, not by a list committed to git.
-- Every application writes its own audit rows, so what was done is recorded in
-- the ledger itself rather than in a script nobody keeps.
-- ============================================================================


-- ── An honest name for the row ──────────────────────────────────────────────
--
-- type was constrained to topup/spend/refund/cashback. Reusing one of those
-- would disguise a reconciliation as ordinary trading, which is the opposite of
-- the point, so the vocabulary gains a word rather than borrowing one.
alter table public.local_wallet_transactions
  drop constraint if exists local_wallet_transactions_type_check;

alter table public.local_wallet_transactions
  add constraint local_wallet_transactions_type_check
  check (type = any (array['topup','spend','refund','cashback','reconciliation']));


create or replace function public.wallet_launch_reconciliation(
  p_user   uuid,
  p_reason text default 'launch-reset-2026'
)
returns table (
  status            text,
  stored_before     integer,
  ledger_before     integer,
  variance          integer,
  variance_txn_id   uuid,
  reset_txn_id      uuid,
  stored_after      integer,
  ledger_after      integer
)
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_stored    integer;
  v_ledger    integer;
  v_variance  integer;
  v_var_key   text := p_reason || ':variance:' || p_user::text;
  v_reset_key text := p_reason || ':reset:'    || p_user::text;
  v_var_id    uuid;
  v_reset_id  uuid;
  v_blockers  integer;
begin
  -- Lock the balance row for the whole operation: the read, both inserts and
  -- the write are one atomic step, so a concurrent reset cannot interleave.
  select coalesce(b.balance_pence, 0) into v_stored
    from public.local_wallet_balances b
   where b.user_id = p_user
   for update;

  if not found then
    return query select 'no_wallet'::text, null::int, null::int, null::int, null::uuid, null::uuid, null::int, null::int;
    return;
  end if;

  -- Idempotency: the keys are derived from the wallet and the reason, so a
  -- second run finds its own previous work and changes nothing.
  if exists (select 1 from public.local_wallet_transactions t
              where t.user_id = p_user and t.idempotency_key = v_reset_key) then
    select coalesce(sum(t.amount_pence), 0)::int into v_ledger
      from public.local_wallet_transactions t where t.user_id = p_user;
    return query select 'already_applied'::text, v_stored, v_ledger, 0, null::uuid, null::uuid, v_stored, v_ledger;
    return;
  end if;

  -- Refuse while anything is still in flight outside the database.
  select
    (select count(*) from public.local_wallet_transactions t
      where t.user_id = p_user
        and t.transfer_state is not null
        and t.transfer_state not in ('none','sent','reversed'))
  + (select count(*) from public.wallet_payment_claims c
      where c.user_id = p_user and c.status is distinct from 'completed')
  + (select count(*) from public.wallet_charge_requests r
      where r.customer_id = p_user and r.status = 'pending')
    into v_blockers;

  if v_blockers > 0 then
    return query select 'refused_unresolved_movement'::text, v_stored, null::int, null::int, null::uuid, null::uuid, v_stored, null::int;
    return;
  end if;

  select coalesce(sum(t.amount_pence), 0)::int into v_ledger
    from public.local_wallet_transactions t where t.user_id = p_user;

  v_variance := v_stored - v_ledger;

  -- 1. The variance, recorded but NOT applied: the balance already reflects it.
  if v_variance <> 0 then
    insert into public.local_wallet_transactions
      (user_id, type, amount_pence, description, idempotency_key)
    values
      (p_user, 'reconciliation', v_variance,
       'Pre-launch reconciliation: historical balance movement never written to the ledger (pre-Step-6 non-atomic wallet path). Recorded, not re-charged.',
       v_var_key)
    returning id into v_var_id;
  end if;

  -- 2. The reset itself, which does move the balance.
  if v_stored <> 0 then
    insert into public.local_wallet_transactions
      (user_id, type, amount_pence, description, idempotency_key)
    values
      (p_user, 'reconciliation', -v_stored,
       'Pre-launch reset of a development/test wallet to a zero opening balance. No Stripe operation performed.',
       v_reset_key)
    returning id into v_reset_id;

    update public.local_wallet_balances b
       set balance_pence = 0, updated_at = now()
     where b.user_id = p_user;
  else
    -- A wallet already at zero still gets its marker, so a second run is
    -- recognised as already applied rather than repeating the work.
    insert into public.local_wallet_transactions
      (user_id, type, amount_pence, description, idempotency_key)
    values
      (p_user, 'reconciliation', 0,
       'Pre-launch reset of a development/test wallet: balance was already zero.',
       v_reset_key)
    returning id into v_reset_id;
  end if;

  return query
    select 'reconciled'::text, v_stored, v_ledger, v_variance, v_var_id, v_reset_id,
           (select coalesce(b.balance_pence,0)::int from public.local_wallet_balances b where b.user_id = p_user),
           (select coalesce(sum(t.amount_pence),0)::int from public.local_wallet_transactions t where t.user_id = p_user);
end $$;

comment on function public.wallet_launch_reconciliation(uuid, text) is
  'Reconciles ONE development/test wallet to a zero opening balance for launch. Writes a variance row (recording historical balance movement the old non-atomic path never logged) and a reset row, atomically, leaving both stored balance and ledger sum at zero. Refuses any wallet with unresolved external money movement. Idempotent per (wallet, reason). Deletes and rewrites nothing.';


-- Steps 1/1B: a revoke naming fewer than {public, anon, authenticated} leaves a
-- door open. This one moves money, so all three are named explicitly.
do $$
declare fn text := 'public.wallet_launch_reconciliation(uuid, text)';
begin
  execute format('revoke all on function %s from public', fn);
  execute format('revoke all on function %s from anon', fn);
  execute format('revoke all on function %s from authenticated', fn);
  execute format('grant execute on function %s to service_role', fn);
end $$;

do $$
begin
  if has_function_privilege('anon', 'public.wallet_launch_reconciliation(uuid, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.wallet_launch_reconciliation(uuid, text)', 'EXECUTE') then
    raise exception 'a client role can execute the wallet reconciliation function';
  end if;
end $$;
