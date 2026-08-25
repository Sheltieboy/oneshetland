-- Paygate 7 — qualify the columns the OUT parameters were shadowing.
--
-- wallet_recover_topup and wallet_topup both declare OUT parameters named
-- balance_pence and deficit_pence, which are also the column names they update.
-- Inside plpgsql the parameter wins, so
--
--     set balance_pence = balance_pence - v_take
--
-- is ambiguous and Postgres refuses it (42702) at RUN time, not at create time —
-- which is why the functions installed cleanly and then failed on first use.
-- Caught by exercising them against production in a rolled-back transaction
-- before any of this reached a caller.
--
-- Same bodies, every column reference qualified.

begin;

create or replace function public.wallet_recover_topup(
  p_pi         text,
  p_kind       text,
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

  select * into v_topup from public.local_wallet_transactions t
   where t.stripe_payment_intent_id = p_pi and t.type = 'topup';
  if not found then
    return query select 0, 0, 0, 0, false, 'not_a_topup';
    return;
  end if;

  insert into public.local_wallet_topup_recovery (payment_intent_id, user_id, topup_pence)
  values (p_pi, v_topup.user_id, v_topup.amount_pence)
  on conflict (payment_intent_id) do nothing;

  select * into r from public.local_wallet_topup_recovery rr
   where rr.payment_intent_id = p_pi for update;

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
    update public.local_wallet_topup_recovery rr
       set refunded_pence     = r.refunded_pence,
           dispute_lost_pence = r.dispute_lost_pence,
           dispute_state      = r.dispute_state,
           dispute_id         = r.dispute_id,
           updated_at         = now()
     where rr.payment_intent_id = p_pi;
    select coalesce(b.balance_pence, 0), coalesce(b.deficit_pence, 0) into v_bal, v_def
      from public.local_wallet_balances b where b.user_id = r.user_id;
    return query select 0, 0, coalesce(v_def, 0), coalesce(v_bal, 0), true, 'no_change';
    return;
  end if;

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

  update public.local_wallet_balances b
     set balance_pence = b.balance_pence - v_take,
         deficit_pence = b.deficit_pence + (v_delta - v_take),
         updated_at    = now()
   where b.user_id = r.user_id
  returning b.balance_pence, b.deficit_pence into v_bal, v_def;

  update public.local_wallet_topup_recovery rr
     set refunded_pence     = r.refunded_pence,
         dispute_lost_pence = r.dispute_lost_pence,
         dispute_state      = r.dispute_state,
         dispute_id         = r.dispute_id,
         recovered_pence    = v_target,
         updated_at         = now()
   where rr.payment_intent_id = p_pi;

  return query select v_delta, v_take, v_def, v_bal, false,
                      case when v_delta > v_take then 'partial_deficit' else 'recovered' end;
end;
$$;

revoke all on function public.wallet_recover_topup(text, text, integer, text) from public, anon, authenticated;
grant execute on function public.wallet_recover_topup(text, text, integer, text) to service_role;

create or replace function public.wallet_topup(
  p_user   uuid,
  p_amount integer,
  p_pi     text
) returns table (balance_pence integer, already_credited boolean, deficit_repaid_pence integer)
  language plpgsql
  security definer
  set search_path to 'public'
as $$
declare
  v_new   int;
  v_def   int;
  v_repay int;
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

    update public.local_wallet_balances b
       set balance_pence = b.balance_pence - v_repay,
           deficit_pence = b.deficit_pence - v_repay,
           updated_at    = now()
     where b.user_id = p_user
    returning b.balance_pence into v_new;
  end if;

  return query select v_new, false, v_repay;
end;
$$;

revoke all on function public.wallet_topup(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.wallet_topup(uuid, integer, text) to service_role;

commit;
