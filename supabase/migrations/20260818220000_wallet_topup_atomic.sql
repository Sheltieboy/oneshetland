-- ============================================================================
-- A top-up could take the customer's money and never credit their wallet.
--
-- Both top-up paths — local-wallet-confirm-topup (client) and fulfilWalletTopup
-- (Stripe webhook) — claim the payment by inserting the ledger row first,
-- relying on the partial unique index on stripe_payment_intent_id, and THEN
-- call wallet_credit to move the balance. Two statements on the service role,
-- so two separate transactions.
--
-- If the second one fails — RPC error, isolate killed, timeout between them —
-- the ledger row is already committed. The payment intent is now claimed
-- forever: every retry, from either path, hits 23505 and returns "already
-- credited". The balance never moves. The customer has paid Stripe, the ledger
-- agrees they topped up, and nothing will ever reconcile it, because the two
-- sides live in different tables (local_wallet_transactions vs
-- local_wallet_balances) with no link between a ledger row and the credit it
-- was supposed to produce.
--
-- The idempotency design is right; it just needs to be one transaction. A
-- plpgsql function is exactly that — if the credit raises, the claiming insert
-- rolls back with it and the retry genuinely retries.
--
-- Returns the balance and whether this call was a repeat, so callers can still
-- answer "already done" without guessing.
-- ============================================================================

create or replace function public.wallet_topup(
  p_user   uuid,
  p_amount integer,
  p_pi     text
) returns table (balance_pence integer, already_credited boolean)
  language plpgsql
  security definer
  set search_path to 'public'
as $$
declare
  v_new int;
begin
  if p_amount is null or p_amount < 0 then
    raise exception 'wallet_topup: amount must be >= 0';
  end if;
  if p_pi is null or p_pi = '' then
    raise exception 'wallet_topup: payment intent id is required';
  end if;

  -- Claim the payment. The partial unique index is the single source of truth
  -- for "already credited", so the conflict target must carry its predicate.
  insert into public.local_wallet_transactions
    (user_id, type, amount_pence, stripe_payment_intent_id, description)
  values
    (p_user, 'topup', p_amount, p_pi, 'Wallet top-up')
  on conflict (stripe_payment_intent_id)
    where stripe_payment_intent_id is not null
    do nothing;

  if not found then
    -- Someone already claimed this PI and, because this is one transaction,
    -- they also credited it. Hand back the current balance.
    select b.balance_pence into v_new
      from public.local_wallet_balances b
     where b.user_id = p_user;
    return query select coalesce(v_new, 0), true;
    return;
  end if;

  -- Same upsert wallet_credit performs, inlined so it shares this transaction.
  insert into public.local_wallet_balances (user_id, balance_pence, updated_at)
  values (p_user, p_amount, now())
  on conflict (user_id) do update
    set balance_pence = public.local_wallet_balances.balance_pence + excluded.balance_pence,
        updated_at    = now()
  returning public.local_wallet_balances.balance_pence into v_new;

  return query select v_new, false;
end;
$$;

comment on function public.wallet_topup(uuid, integer, text) is
  'Atomic wallet top-up: claims the payment intent in the ledger and credits the balance in ONE transaction, so a failure between the two cannot leave a paid-but-uncredited top-up. Returns (balance_pence, already_credited).';

revoke all on function public.wallet_topup(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.wallet_topup(uuid, integer, text) to service_role;
