-- ── Points that are earned when the purchase is, and given back when it is not ──
--
-- tg_loyalty_earn_points has never fired. Not once. It required
-- amount_pence > 0 on a table where spends are stored negative — and they were
-- already negative before it was written: the three July spend rows predate its
-- own migration, and the archived wallet views beside it already read
-- ABS(amount_pence). It was born dead.
--
-- It is retired rather than corrected, because its sign was not its only
-- problem:
--
--   it fired AFTER INSERT on the debit, when transfer_state is still 'pending'
--   — before the merchant was paid and before the purchase existed. Three later
--   events can undo that spend (a rejected transfer, a failed fulfilment, an
--   operator refund) and none of them could give the points back;
--
--   it awarded on the GROSS wallet debit, so a business funded a reward on a
--   platform fee it never received;
--
--   its ledger row recorded no link to the spend that caused it, so nothing
--   could ever be reversed exactly;
--
--   its card get-or-create was a SELECT then an INSERT, and it ran inside the
--   payment's own transaction — two simultaneous qualifying spends would have
--   raised a unique violation and rolled back a customer's payment.
--
-- Retiring it is provably inert: production holds zero points_earn rows, zero
-- points programmes, and one single business-linked wallet spend. Triggers do
-- not fire retroactively, so nothing is backfilled and no historical points are
-- created.

-- ── 1. Retire the dead trigger ──────────────────────────────────────────────
drop trigger if exists loyalty_earn_points on public.local_wallet_transactions;
drop function if exists public.tg_loyalty_earn_points();


-- ── 2. Durable source linkage ───────────────────────────────────────────────
--
-- A points row must be able to name the wallet spend that funded it. The old
-- one wrote the free text 'Earned on spend' — identical for every award, which
-- is not a link.
alter table public.local_loyalty_transactions
  add column if not exists source_transaction_id uuid,
  add column if not exists source_type text;

comment on column public.local_loyalty_transactions.source_transaction_id is
  'The row in another ledger that caused this loyalty movement — for wallet-funded points, local_wallet_transactions.id. The basis for reversing exactly what was earned.';
comment on column public.local_loyalty_transactions.source_type is
  'Which ledger source_transaction_id points into. ''wallet'' is the only value today.';

-- One award and one reversal per source, enforced by the database rather than
-- by whichever caller remembered. A repeated fulfilment callback cannot
-- double-award, and a repeated refund cannot deficit twice.
create unique index if not exists local_loyalty_tx_one_per_source_and_type
  on public.local_loyalty_transactions (source_transaction_id, type)
  where source_transaction_id is not null;


-- ── 3. Loyalty deficit ──────────────────────────────────────────────────────
--
-- A refund is never blocked by loyalty. When the points a refund claws back
-- have already been spent, the shortfall becomes a debt against future
-- earnings rather than a negative balance: 'you have none' and 'you owe some'
-- are different facts, and only one of them is a spendable balance.
alter table public.local_loyalty_cards
  add column if not exists points_deficit integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.local_loyalty_cards'::regclass
                    and conname = 'local_loyalty_cards_points_deficit_check') then
    alter table public.local_loyalty_cards
      add constraint local_loyalty_cards_points_deficit_check check (points_deficit >= 0);
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.local_loyalty_cards'::regclass
                    and conname = 'local_loyalty_cards_points_balance_check') then
    alter table public.local_loyalty_cards
      add constraint local_loyalty_cards_points_balance_check
      check (points_balance is null or points_balance >= 0);
  end if;
end $$;

comment on column public.local_loyalty_cards.points_deficit is
  'Points owed back after a refund clawed back more than the card still held. Future earnings pay this down before they become spendable. Never negative.';


-- ── 4. Ledger vocabulary ────────────────────────────────────────────────────
--
-- Append-only. A reversal never edits or deletes the points_earn row it
-- reverses; it is recorded beside it, and the split between what came off the
-- balance and what became debt is two rows because they are two facts.
alter table public.local_loyalty_transactions
  drop constraint if exists local_loyalty_transactions_type_check;
alter table public.local_loyalty_transactions
  add constraint local_loyalty_transactions_type_check
  check (type = any (array[
    'stamp', 'points_earn', 'redeem', 'reward',
    'points_reverse',      -- clawback taken off the spendable balance
    'points_deficit',      -- clawback that could not be taken, and became debt
    'points_deficit_paid'  -- a later earning that cleared debt instead of crediting
  ]));


-- ── 5. Award, at fulfilment ─────────────────────────────────────────────────
--
-- Takes only the wallet transaction id. Every figure — the business, the
-- amount, the fee, the cashback — is read from the ledger row itself, so a
-- caller cannot inflate an award by describing it differently.
--
-- The earning basis is the BUSINESS PROCEEDS, not the gross debit: the same
-- arithmetic the wallet rail already uses to decide what to transfer, which is
-- amount less the platform fee less business-funded cashback. A business
-- should not fund a reward on money it never received.
create or replace function public.loyalty_award_for_wallet_spend(p_wallet_txn uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_txn      public.local_wallet_transactions%rowtype;
  v_prog     public.local_loyalty_programs%rowtype;
  v_card     public.local_loyalty_cards%rowtype;
  v_proceeds integer;
  v_gross    integer;
  v_paid     integer;
  v_credit   integer;
begin
  if p_wallet_txn is null then
    return jsonb_build_object('ok', false, 'error', 'bad_request');
  end if;

  -- FOR UPDATE, because wallet_reverse_debit locks this same row first. Without
  -- it an award and a refund of the same spend can pass each other in the dark:
  -- the refund looks for a points_earn row the award has not committed yet,
  -- finds none, and 28 points survive a purchase that was refunded. Reproduced
  -- before this line existed.
  select * into v_txn from public.local_wallet_transactions
   where id = p_wallet_txn
     for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_such_spend'); end if;
  if v_txn.type <> 'spend' then return jsonb_build_object('ok', false, 'error', 'not_a_spend'); end if;

  -- And the other way round: if the refund got here first, there is nothing to
  -- earn on. A reversed spend bought nothing.
  if exists (select 1 from public.local_wallet_transactions
              where reverses_transaction_id = p_wallet_txn) then
    return jsonb_build_object('ok', false, 'error', 'spend_already_reversed');
  end if;

  -- A caller may only award on a settled spend. Every qualifying rail reaches
  -- its fulfilment point with the transfer already marked 'sent' — walletPay
  -- marks it before it returns ok, and it returns ok on nothing else. 'none'
  -- is settled too: it means no transfer was ever needed. Everything else —
  -- pending, failed, unresolved — is money still in motion, and a service-role
  -- caller invoking this too early must not mint points against it.
  if coalesce(v_txn.transfer_state, 'none') not in ('sent', 'none') then
    return jsonb_build_object('ok', false, 'error', 'spend_not_settled',
                              'transfer_state', v_txn.transfer_state);
  end if;

  -- Hub donations, hub memberships, event tickets and shift boosts carry no
  -- business_id — a hub is not a local business — so they are ineligible by
  -- construction rather than by a rule someone has to remember.
  if v_txn.business_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_business_spend');
  end if;
  if not public.business_meets_tier(v_txn.business_id, 'pro') then
    return jsonb_build_object('ok', false, 'error', 'business_not_pro');
  end if;

  select * into v_prog from public.local_loyalty_programs
   where business_id = v_txn.business_id and is_active = true and type = 'points'
   limit 1;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_points_program'); end if;

  v_proceeds := abs(coalesce(v_txn.amount_pence, 0))
              - coalesce(v_txn.platform_fee_pence, 0)
              - coalesce(v_txn.cashback_pence, 0);
  v_gross := floor((v_proceeds / 100.0) * coalesce(v_prog.points_per_pound, 0))::int;
  if v_gross <= 0 then
    return jsonb_build_object('ok', false, 'error', 'no_points', 'proceeds_pence', v_proceeds);
  end if;

  -- Create-or-lock, so two fulfilment callbacks for one spend serialise here.
  insert into public.local_loyalty_cards (user_id, program_id, business_id, stamps_collected, points_balance)
  values (v_txn.user_id, v_prog.id, v_txn.business_id, 0, 0)
  on conflict (user_id, program_id)
    do update set business_id = public.local_loyalty_cards.business_id
  returning * into v_card;

  if exists (select 1 from public.local_loyalty_transactions
              where source_transaction_id = p_wallet_txn and type = 'points_earn') then
    return jsonb_build_object('ok', true, 'already_awarded', true,
                              'points_balance', v_card.points_balance,
                              'points_deficit', v_card.points_deficit);
  end if;

  -- Debt first. A card that owes 30 and earns 50 clears the debt and banks 20.
  v_paid   := least(coalesce(v_card.points_deficit, 0), v_gross);
  v_credit := v_gross - v_paid;

  update public.local_loyalty_cards
     set points_balance = coalesce(points_balance, 0) + v_credit,
         points_deficit = coalesce(points_deficit, 0) - v_paid,
         last_stamp_at  = now()
   where id = v_card.id;

  insert into public.local_loyalty_transactions
    (card_id, user_id, business_id, type, amount, note, source_transaction_id, source_type)
  values (v_card.id, v_txn.user_id, v_txn.business_id, 'points_earn', v_gross,
          'Earned on business proceeds', p_wallet_txn, 'wallet');

  if v_paid > 0 then
    insert into public.local_loyalty_transactions
      (card_id, user_id, business_id, type, amount, note, source_transaction_id, source_type)
    values (v_card.id, v_txn.user_id, v_txn.business_id, 'points_deficit_paid', v_paid,
            'Cleared points owed from a refunded purchase', p_wallet_txn, 'wallet');
  end if;

  return jsonb_build_object('ok', true, 'card_id', v_card.id,
    'proceeds_pence', v_proceeds, 'points_earned', v_gross,
    'deficit_cleared', v_paid, 'points_credited', v_credit,
    'points_balance', coalesce(v_card.points_balance, 0) + v_credit,
    'points_deficit', coalesce(v_card.points_deficit, 0) - v_paid);
end;
$$;


-- ── 6. Reversal, keyed on the spend that funded it ──────────────────────────
--
-- Never raises. It is called from inside the wallet reversal, and a customer's
-- refund must not fail because of a loyalty balance.
create or replace function public.loyalty_reverse_for_wallet_spend(p_wallet_txn uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_earn    public.local_loyalty_transactions%rowtype;
  v_card    public.local_loyalty_cards%rowtype;
  v_claw    integer;
  v_taken   integer;
  v_owed    integer;
begin
  if p_wallet_txn is null then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;

  select * into v_earn from public.local_loyalty_transactions
   where source_transaction_id = p_wallet_txn and type = 'points_earn' limit 1;
  if not found then return jsonb_build_object('ok', true, 'nothing_to_reverse', true); end if;

  select * into v_card from public.local_loyalty_cards where id = v_earn.card_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'card_not_found'); end if;

  if exists (select 1 from public.local_loyalty_transactions
              where source_transaction_id = p_wallet_txn
                and type in ('points_reverse', 'points_deficit')) then
    return jsonb_build_object('ok', true, 'already_reversed', true,
                              'points_balance', v_card.points_balance,
                              'points_deficit', v_card.points_deficit);
  end if;

  -- What was earned from THIS spend, never more — even if the card now holds
  -- points from elsewhere.
  v_claw  := v_earn.amount;
  v_taken := least(coalesce(v_card.points_balance, 0), v_claw);
  v_owed  := v_claw - v_taken;

  update public.local_loyalty_cards
     set points_balance = coalesce(points_balance, 0) - v_taken,
         points_deficit = coalesce(points_deficit, 0) + v_owed
   where id = v_card.id;

  if v_taken > 0 then
    insert into public.local_loyalty_transactions
      (card_id, user_id, business_id, type, amount, note, source_transaction_id, source_type)
    values (v_card.id, v_earn.user_id, v_earn.business_id, 'points_reverse', v_taken,
            'Reversed — the purchase was refunded', p_wallet_txn, 'wallet');
  end if;
  if v_owed > 0 then
    insert into public.local_loyalty_transactions
      (card_id, user_id, business_id, type, amount, note, source_transaction_id, source_type)
    values (v_card.id, v_earn.user_id, v_earn.business_id, 'points_deficit', v_owed,
            'Owed back — those points had already been spent', p_wallet_txn, 'wallet');
  end if;

  return jsonb_build_object('ok', true, 'clawed_back', v_claw,
    'taken_from_balance', v_taken, 'added_to_deficit', v_owed,
    'points_balance', coalesce(v_card.points_balance, 0) - v_taken,
    'points_deficit', coalesce(v_card.points_deficit, 0) + v_owed);
end;
$$;


-- ── 7. The wallet reversal gives the points back too ────────────────────────
--
-- Identical to 20261002120000 in every other respect — same lock, same
-- idempotency, same arithmetic, same linked refund row, same merchant verdict.
-- The one addition is the loyalty call, wrapped so that it CANNOT fail the
-- refund: a customer's money is never held back over a loyalty balance, which
-- is what the deficit exists to make possible.
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

  select id into v_existing from public.local_wallet_transactions
   where reverses_transaction_id = p_transaction_id
   limit 1;
  if v_existing is not null then
    return query select
      coalesce((select b.balance_pence from public.local_wallet_balances b where b.user_id = v_orig.user_id), 0),
      v_existing, true;
    return;
  end if;

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

  v_state := case when v_orig.transfer_state = 'sent' then 'reversed' else 'failed' end;

  update public.local_wallet_transactions
     set transfer_state = v_state
   where id = p_transaction_id;

  -- Loyalty last, and it cannot fail the refund. Anything raised here is
  -- swallowed deliberately: the money going back is not negotiable, and an
  -- unreversed award is recoverable afterwards from source_transaction_id.
  begin
    perform public.loyalty_reverse_for_wallet_spend(p_transaction_id);
  exception when others then
    raise warning 'wallet_reverse_debit: loyalty reversal failed for % (%), refund unaffected',
      p_transaction_id, sqlerrm;
  end;

  return query select v_res.balance_pence, v_res.transaction_id, false;
end;
$$;

comment on function public.loyalty_award_for_wallet_spend(uuid) is
  'Awards loyalty points for a completed business wallet purchase, reading every figure from the wallet ledger row itself. Earns on BUSINESS PROCEEDS (amount less platform fee less business-funded cashback), clears any points deficit before crediting, and records the award against its source so it can be reversed exactly. At most one award per wallet spend. service_role only.';
comment on function public.loyalty_reverse_for_wallet_spend(uuid) is
  'Reverses the points earned from one wallet spend: takes what the card still holds and records the rest as a deficit against future earnings. Never raises, never blocks a refund, and never reverses twice. service_role only.';
comment on function public.wallet_reverse_debit(uuid, text, text) is
  'Reverses a wallet debit by APPENDING a refund entry linked to it, never by deleting or editing the original. Marks the original ''reversed'' when its transfer had been sent and has now been clawed back, ''failed'' when no money ever reached the merchant. Also reverses any loyalty points that spend earned, in a way that cannot fail the refund. Idempotent: a second call returns the existing reversal. service_role only.';



-- ── 7a. When the loyalty half fails, it must not disappear ──────────────────
--
-- The guard above is a SUBTRANSACTION. If the loyalty reversal raises,
-- everything it did is rolled back and the refund commits alone — which is the
-- right trade, but it leaves points on a card for a purchase that was refunded,
-- and a WARNING in a log nobody reads.
--
-- Executed, not assumed: with the loyalty ledger insert forced to fail, the
-- refund completed (transfer_state 'reversed', balance restored) and 28 points
-- survived with no reverse row, no deficit row and no marker of any kind.
--
-- No recovery table is added, because the state does not need recording — it is
-- already written down. Three immutable, append-only facts derive it exactly:
-- the wallet refund row that points at the spend, the points_earn row that
-- points at the same spend, and the absence of any reversal row for it. A
-- recovery table would be a fourth copy of something the ledgers already say.
create or replace function public.loyalty_reversals_outstanding()
  returns table (
    wallet_transaction_id uuid,
    card_id               uuid,
    user_id               uuid,
    business_id           uuid,
    points_earned         integer,
    earned_at             timestamptz
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select e.source_transaction_id, e.card_id, e.user_id, e.business_id, e.amount, e.created_at
    from public.local_loyalty_transactions e
   where e.type = 'points_earn'
     and e.source_type = 'wallet'
     and e.source_transaction_id is not null
     -- the funding spend was reversed …
     and exists (select 1 from public.local_wallet_transactions r
                  where r.reverses_transaction_id = e.source_transaction_id)
     -- … and nothing ever took the points back
     and not exists (select 1 from public.local_loyalty_transactions x
                      where x.source_transaction_id = e.source_transaction_id
                        and x.type in ('points_reverse', 'points_deficit'))
   order by e.created_at;
$$;

-- Retry, keyed by the spend, idempotent by the same guards the first attempt
-- used. Safe to run twice, safe to run concurrently, and it needs no state of
-- its own: it asks the ledgers what is outstanding and does that.
create or replace function public.loyalty_recover_outstanding_reversals(p_limit integer default 100)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_row       record;
  v_res       jsonb;
  v_recovered integer := 0;
  v_failed    integer := 0;
begin
  for v_row in
    select * from public.loyalty_reversals_outstanding() limit greatest(coalesce(p_limit, 100), 1)
  loop
    begin
      v_res := public.loyalty_reverse_for_wallet_spend(v_row.wallet_transaction_id);
      if coalesce((v_res->>'ok')::boolean, false) then
        v_recovered := v_recovered + 1;
      else
        v_failed := v_failed + 1;
      end if;
    exception when others then
      -- One stubborn row must not stop the rest.
      v_failed := v_failed + 1;
      raise warning 'loyalty recovery failed for % (%)', v_row.wallet_transaction_id, sqlerrm;
    end;
  end loop;
  return jsonb_build_object('ok', true, 'recovered', v_recovered, 'failed', v_failed);
end;
$$;

comment on function public.loyalty_reversals_outstanding() is
  'Wallet spends that were refunded, earned loyalty points, and never had those points reversed — derived from the ledgers themselves rather than from a status column, because all three facts are append-only. The detection half of the recovery for a loyalty reversal that failed inside a refund.';
comment on function public.loyalty_recover_outstanding_reversals(integer) is
  'Retries every outstanding loyalty reversal, keyed by the wallet spend that funded it. Idempotent and safe to run concurrently: each retry re-enters the same guards the first attempt used. service_role only.';


-- ── 8. Privileges ───────────────────────────────────────────────────────────
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.loyalty_award_for_wallet_spend(uuid)',
    'public.loyalty_reverse_for_wallet_spend(uuid)',
    'public.wallet_reverse_debit(uuid, text, text)',
    'public.loyalty_reversals_outstanding()',
    'public.loyalty_recover_outstanding_reversals(integer)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;
