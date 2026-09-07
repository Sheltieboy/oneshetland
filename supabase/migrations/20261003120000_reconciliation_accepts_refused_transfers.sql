-- ── A refused transfer is settled, and reconciliation should say so ─────────
--
-- wallet_launch_reconciliation refuses a wallet with "unresolved external money
-- movement" before it will zero a balance. The list it refuses on was:
--
--     transfer_state not in ('none','sent','reversed')
--
-- which blocks on 'failed'. Under the state model settled by 20261002120000
-- that is wrong: 'failed' now means the caller ASSERTED that Stripe refused the
-- transfer — p_merchant = 'never_paid' — so the merchant was definitively never
-- paid, the customer was credited back in the same transaction that wrote the
-- state, and there is nothing outstanding outside the database. It is the one
-- terminal state that says with certainty that no money moved.
--
-- The refusal exists to stop a balance being zeroed while money is still moving
-- where the database cannot see it. 'pending' and 'unresolved' are exactly that
-- and keep blocking, unchanged. 'failed' is the opposite of it.
--
-- Nothing else moves. The meanings of failed, pending and unresolved are
-- untouched; only the blocker set is corrected to mean what it says.
--
-- SCOPE, HONESTLY
--
-- This function has no application caller in either repository. It is a
-- one-shot pre-launch reset an operator runs by hand, it has already been run
-- (six reconciliation rows across three wallets), and production holds zero
-- rows in 'failed'. So this fixes no live breakage — it stops the state model
-- and the tool that reads it from disagreeing the first time a refused transfer
-- ever happens, which is a cheap thing to fix now and an obscure one to
-- diagnose later.
--
-- The function is restated in full because PL/pgSQL has no way to replace one
-- predicate. Every other line is identical to 20260821210000.

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
        and t.transfer_state not in ('none','sent','reversed','failed'))
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
  'Reconciles ONE development/test wallet to a zero opening balance for launch. Writes a variance row (recording historical balance movement the old non-atomic path never logged) and a reset row, atomically, leaving both stored balance and ledger sum at zero. Refuses any wallet whose external money movement may still be outstanding or unknown — a transfer pending or unresolved, an open payment claim, a pending charge request. A refused transfer is settled and does not block. Idempotent per (wallet, reason). Deletes and rewrites nothing.';

-- A revoke naming fewer than {public, anon, authenticated} leaves a door open.
-- This one moves money, so all three are named explicitly.
do $$
declare fn text := 'public.wallet_launch_reconciliation(uuid, text)';
begin
  execute format('revoke all on function %s from public', fn);
  execute format('revoke all on function %s from anon', fn);
  execute format('revoke all on function %s from authenticated', fn);
  execute format('grant execute on function %s to service_role', fn);
end $$;
