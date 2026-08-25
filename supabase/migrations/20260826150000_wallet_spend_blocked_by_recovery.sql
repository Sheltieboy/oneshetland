-- Paygate 7 — a wallet that owes money stops spending.
--
-- The deficit and the dispute lock are only worth having if the DEBIT refuses,
-- not the button. wallet_debit_with_ledger is the one door every wallet spend
-- goes through — wallet-checkout, local-wallet-pay, gifts, tickets, the till —
-- so the check goes there and nowhere else.
--
-- The existing return gains one column rather than changing the others: callers
-- read named fields, so `blocked` is invisible to anything that does not look
-- for it, and the insufficient-funds path is untouched.

begin;

drop function if exists public.wallet_debit_with_ledger(uuid, integer, integer, text, uuid, text, text, integer, boolean);

create function public.wallet_debit_with_ledger(
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
  insufficient    boolean,
  blocked         boolean,
  block_reason    text
)
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_new   integer;
  v_txn   uuid;
  v_prior public.local_wallet_transactions%rowtype;
  v_block record;
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
  if p_cashback > p_spend then
    raise exception 'wallet_debit_with_ledger: cashback cannot exceed the spend' using errcode = '22023';
  end if;

  -- ── A wallet under recovery does not spend ──────────────────────────────
  --
  -- Checked BEFORE the idempotency claim, so a blocked attempt leaves nothing
  -- behind and can simply be made again once the deficit is cleared or the
  -- dispute is won.
  select * into v_block from public.wallet_spend_block(p_user);
  if v_block.blocked then
    return query select
      coalesce((select b.balance_pence from public.local_wallet_balances b where b.user_id = p_user), 0),
      null::uuid, false, false, true, v_block.reason;
    return;
  end if;

  begin
    update public.local_wallet_balances b
       set balance_pence = b.balance_pence - p_spend + p_cashback,
           updated_at    = now()
     where b.user_id = p_user
       and b.balance_pence >= p_spend
    returning b.balance_pence into v_new;

    if not found then
      return query select
        coalesce((select b.balance_pence from public.local_wallet_balances b where b.user_id = p_user), 0),
        null::uuid, false, true, false, null::text;
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
         'none')
      on conflict (idempotency_key) where idempotency_key is not null do nothing;
    end if;

    return query select v_new, v_txn, false, false, false, null::text;
    return;

  exception when sqlstate '40001' then
    select * into v_prior from public.local_wallet_transactions
     where idempotency_key = p_idempotency_key;
    return query select
      coalesce((select b.balance_pence from public.local_wallet_balances b where b.user_id = p_user), 0),
      v_prior.id, true, false, false, null::text;
    return;
  end;
end;
$$;

comment on function public.wallet_debit_with_ledger(uuid, integer, integer, text, uuid, text, text, integer, boolean) is
  'The one door every wallet spend goes through. Balance and ledger move in ONE transaction, the balance can never go below zero, and a wallet carrying a refund deficit or an open dispute is refused before anything is claimed. Returns (balance, transaction, already_applied, insufficient, blocked, block_reason).';

revoke all on function public.wallet_debit_with_ledger(uuid, integer, integer, text, uuid, text, text, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.wallet_debit_with_ledger(uuid, integer, integer, text, uuid, text, text, integer, boolean)
  to service_role;

-- ── Reconciliation now reports the deficit too ──────────────────────────────
--
-- delta stays exactly what it was — stored balance minus ledger sum — because
-- every recovery writes a ledger row for the part it actually took. The deficit
-- is money that did NOT move and so is not in the ledger; it is reported
-- alongside rather than folded into the equation, which would hide it.

drop function if exists public.wallet_reconciliation();

create function public.wallet_reconciliation()
returns table (
  user_id        uuid,
  balance_pence  integer,
  ledger_pence   integer,
  delta_pence    integer,
  ledger_rows    integer,
  deficit_pence  integer
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
         coalesce(l.n, 0),
         coalesce(b.deficit_pence, 0)
    from public.local_wallet_balances b
    left join (
      select t.user_id, sum(t.amount_pence)::int as total, count(*)::int as n
        from public.local_wallet_transactions t
       group by t.user_id
    ) l on l.user_id = b.user_id;
$$;

comment on function public.wallet_reconciliation() is
  'Every wallet account with its stored balance, its ledger-derived balance and any outstanding recovery deficit. balance and ledger must agree — delta 0 — for anything written after atomic ledgering. The deficit is reported separately on purpose: it is money that did not move, so folding it into the equation would conceal it.';

revoke all on function public.wallet_reconciliation() from public, anon, authenticated;
grant execute on function public.wallet_reconciliation() to service_role;

-- ── The trap ────────────────────────────────────────────────────────────────
do $$
begin
  if has_function_privilege('anon','public.wallet_recover_topup(text,text,integer,text)','execute')
     or has_function_privilege('authenticated','public.wallet_recover_topup(text,text,integer,text)','execute')
     or has_function_privilege('anon','public.wallet_debit_with_ledger(uuid,integer,integer,text,uuid,text,text,integer,boolean)','execute')
     or has_function_privilege('authenticated','public.wallet_debit_with_ledger(uuid,integer,integer,text,uuid,text,text,integer,boolean)','execute')
     or has_function_privilege('anon','public.wallet_topup(uuid,integer,text)','execute')
     or has_function_privilege('authenticated','public.wallet_topup(uuid,integer,text)','execute') then
    raise exception 'Paygate 7: a wallet money function became client-callable';
  end if;
end $$;

commit;
