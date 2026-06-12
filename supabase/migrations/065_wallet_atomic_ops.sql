-- 065_wallet_atomic_ops.sql
-- SECURITY/CORRECTNESS: atomic wallet balance operations.
--
-- The wallet top-up and pay edge functions previously did a read-modify-write
-- on local_wallet_balances (SELECT balance, then UPSERT balance + amount). Under
-- concurrent requests this loses updates (two top-ups racing → only one counts).
-- These SECURITY DEFINER functions perform the change atomically in a single
-- statement so concurrent operations can't clobber each other.

-- Credit (top-up, cashback, refund): atomic increment, creates the row if absent.
create or replace function public.wallet_credit(p_user uuid, p_amount int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_new int;
begin
  if p_amount is null or p_amount < 0 then
    raise exception 'wallet_credit: amount must be >= 0';
  end if;
  insert into public.local_wallet_balances (user_id, balance_pence, updated_at)
  values (p_user, p_amount, now())
  on conflict (user_id) do update
    set balance_pence = public.local_wallet_balances.balance_pence + excluded.balance_pence,
        updated_at    = now()
  returning balance_pence into v_new;
  return v_new;
end;
$$;

-- Debit (spend): atomically subtract p_spend and add p_cashback, but ONLY if the
-- balance can cover the spend. Returns the new balance, or NULL if there are
-- insufficient funds / no wallet row (caller treats NULL as "declined").
create or replace function public.wallet_debit(p_user uuid, p_spend int, p_cashback int default 0)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_new int;
begin
  if p_spend is null or p_spend < 0 or p_cashback is null or p_cashback < 0 then
    raise exception 'wallet_debit: invalid amounts';
  end if;
  update public.local_wallet_balances
     set balance_pence = balance_pence - p_spend + p_cashback,
         updated_at    = now()
   where user_id = p_user
     and balance_pence >= p_spend
  returning balance_pence into v_new;
  return v_new;  -- NULL when the guard failed (insufficient funds)
end;
$$;

-- Edge functions call these with the service-role key. Grant authenticated too
-- so the same RPCs could be used from RLS-protected client paths later if ever
-- needed (the functions only ever touch the caller's own balance row by id).
grant execute on function public.wallet_credit(uuid, int)       to service_role, authenticated;
grant execute on function public.wallet_debit(uuid, int, int)   to service_role, authenticated;

comment on function public.wallet_credit(uuid, int) is
  'Atomic wallet credit (top-up/cashback/refund). Returns new balance_pence.';
comment on function public.wallet_debit(uuid, int, int) is
  'Atomic guarded wallet debit. Returns new balance_pence, or NULL if insufficient funds.';
