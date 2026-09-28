-- ============================================================================
-- Business Wallet refunds.
--
-- Four rails take money from a customer's wallet on behalf of a LOCAL BUSINESS
-- (local-wallet-pay, wallet-charge-approve, wallet-checkout unit_purchase,
-- create-product-order-intent). Until now none of them could be refunded: the
-- only caller wired to wallet_reverse_debit was refund-payment, which resolves
-- hub memberships, and a hub is not a business — its wallet rows carry
-- business_id = NULL. So the refundable set and the business set were disjoint,
-- and the platform took money it had no supported way to give back.
--
-- This adds the missing boundary. wallet_reverse_debit is NOT touched: it is
-- called, unchanged, from inside the finalisation function below, which is what
-- keeps the merchant transfer verdict model and the Loyalty reversal exactly as
-- they already are.
--
-- THE SHAPE OF THE THING
--
--   1  claim     source none -> pending          (locks, verifies, freezes)
--   2  Stripe    reverse the destination transfer   (external, in the caller)
--   3  finalise  wallet_reverse_debit + source pending -> refunded + stock
--                                                    (one transaction)
--
-- Why a pending state at all. The obvious implementation writes "refunded" onto
-- the purchase first and then moves the money. Every failure after that point
-- leaves a purchase asserting a refund the customer never received while the
-- merchant still holds the funds — a lie, in the customer's own history. The
-- pending state is the honest intermediate: the pass is frozen, nothing claims
-- to have happened yet, and the money has not moved. Failure at ANY boundary
-- lands on the conservative side, and every boundary is retryable.
--
-- Why uses_remaining is never zeroed. Zeroing it makes a refunded pass
-- indistinguishable from an exhausted one — local-redeem-start says "No uses
-- left", the customer's list shows a spent pass. A refunded pass keeps its
-- uses: "three uses were bought, none used, refunded" is the truth, and
-- refund_state is what stops it being redeemed.
-- ============================================================================

-- ── 1. Source refund metadata ───────────────────────────────────────────────

alter table public.book_unit_purchases
  add column if not exists refund_state text not null default 'none',
  add column if not exists refunded_at timestamptz,
  add column if not exists refund_transaction_id uuid
    references public.local_wallet_transactions(id);

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.book_unit_purchases'::regclass
                    and conname  = 'book_unit_purchases_refund_state_check') then
    alter table public.book_unit_purchases
      add constraint book_unit_purchases_refund_state_check
      check (refund_state in ('none', 'pending', 'refunded'));
  end if;
end $$;

alter table public.product_orders
  add column if not exists refund_state text not null default 'none',
  add column if not exists refunded_at timestamptz,
  add column if not exists refund_transaction_id uuid
    references public.local_wallet_transactions(id);

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.product_orders'::regclass
                    and conname  = 'product_orders_refund_state_check') then
    alter table public.product_orders
      add constraint product_orders_refund_state_check
      check (refund_state in ('none', 'pending', 'refunded'));
  end if;
end $$;

-- Every historical row is 'none' by default, which is true of all of them:
-- nothing has ever been refunded on either table. No backfill.

comment on column public.book_unit_purchases.refund_state is
  'none | pending | refunded. Server-managed: see tg_lock_pass_refund_columns. A pending or refunded pass is not redeemable, and uses_remaining is left historically truthful rather than zeroed.';
comment on column public.product_orders.refund_state is
  'none | pending | refunded. Server-managed: see tg_lock_order_refund_columns. While pending, a client cannot advance fulfilment.';

create index if not exists book_unit_purchases_refund_pending
  on public.book_unit_purchases (refund_state)
  where refund_state = 'pending';
create index if not exists product_orders_refund_pending
  on public.product_orders (refund_state)
  where refund_state = 'pending';

-- ── 2. Who may write server-managed columns ─────────────────────────────────
--
-- tg_is_trusted_writer() already exists and does nearly this job, but it ends
-- with `return public.is_admin()` so a platform admin writing from a browser
-- passes. That is right for entitlement fields operated from admin screens. It
-- is wrong here: it would let an admin stamp refunded_at with no money moving.
-- Refund metadata gets the strict form, with no admin escape hatch.

create or replace function public.tg_is_server_write() returns boolean
  language plpgsql
  stable
  -- SECURITY INVOKER on purpose: current_user must stay the role that is
  -- actually writing. SECURITY DEFINER would rebind it to the owner and this
  -- would return true for everyone, including the merchant it exists to stop.
  set search_path = public
as $$
begin
  --   direct write as authenticated  -> current_user = 'authenticated'  refuse
  --   direct write as anon           -> current_user = 'anon'           refuse
  --   edge function w/ service key   -> current_user = 'service_role'   allow
  --   inside a SECURITY DEFINER fn   -> current_user = the owner         allow
  --   migration / psql               -> current_user = 'postgres'        allow
  return current_user not in ('authenticated', 'anon');
end;
$$;

comment on function public.tg_is_server_write() is
  'True when the write is NOT a direct PostgREST call from a client role. Deliberately stricter than tg_is_trusted_writer(): no platform-admin exemption, because refund metadata must only ever be written by the refund functions that actually move the money.';

-- ── 3. Write protection: passes ─────────────────────────────────────────────
--
-- authenticated holds table-level UPDATE on every column of this table and the
-- RLS policy "Businesses redeem uses on their items" is a row predicate only,
-- so without this a merchant could mark a pass refunded from the client without
-- returning a penny, or clear pending and carry on redeeming.
--
-- uses_remaining and fully_used_at are locked too. A repo-wide search of both
-- repositories found no direct client mutation of either: every write comes
-- from redeem_pass_atomic (SECURITY DEFINER) or a service-role insert. They
-- were writable by any merchant only by omission.

create or replace function public.tg_lock_pass_refund_columns() returns trigger
  language plpgsql
  -- SECURITY INVOKER on purpose. See tg_is_server_write().
  set search_path = public
as $$
begin
  if public.tg_is_server_write() then return new; end if;

  if tg_op = 'INSERT' then
    new.refund_state          := 'none';
    new.refunded_at           := null;
    new.refund_transaction_id := null;
    return new;
  end if;

  if new.refund_state          is distinct from old.refund_state
  or new.refunded_at           is distinct from old.refunded_at
  or new.refund_transaction_id is distinct from old.refund_transaction_id then
    raise exception 'pass refund state is server-managed' using errcode = '42501';
  end if;

  if new.uses_remaining is distinct from old.uses_remaining
  or new.fully_used_at  is distinct from old.fully_used_at then
    raise exception 'pass use balance is server-managed' using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists tg_zz_lock_pass_refund_columns on public.book_unit_purchases;
create trigger tg_zz_lock_pass_refund_columns
  before insert or update on public.book_unit_purchases
  for each row execute function public.tg_lock_pass_refund_columns();

-- ── 4. Write protection: product orders ─────────────────────────────────────
--
-- Order fulfilment is advanced by a DIRECT client UPDATE (web OrdersInbox does
-- `from("product_orders").update({status})`), so a refund_state column on its
-- own would stop nothing: the merchant would simply write over it. The status
-- rules therefore live here, where a client cannot reach around them, and the
-- claim/finalisation functions pass straight through the first line.

create or replace function public.tg_lock_order_refund_columns() returns trigger
  language plpgsql
  -- SECURITY INVOKER on purpose. See tg_is_server_write().
  set search_path = public
as $$
begin
  if public.tg_is_server_write() then return new; end if;

  if tg_op = 'INSERT' then
    new.refund_state          := 'none';
    new.refunded_at           := null;
    new.refund_transaction_id := null;
    return new;
  end if;

  if new.refund_state          is distinct from old.refund_state
  or new.refunded_at           is distinct from old.refunded_at
  or new.refund_transaction_id is distinct from old.refund_transaction_id then
    raise exception 'order refund state is server-managed' using errcode = '42501';
  end if;

  -- A refund is in flight. The goods must not move while the money is moving.
  if old.refund_state = 'pending' and new.status is distinct from old.status then
    raise exception 'order_refund_in_progress' using errcode = '22023';
  end if;

  -- Refunded is terminal for a client. Reopening it would put a paid-for
  -- fulfilment state back on an order whose money has gone home.
  if old.refund_state = 'refunded' and new.status is distinct from old.status then
    raise exception 'order_refunded' using errcode = '22023';
  end if;

  return new;
end;
$$;

drop trigger if exists tg_zz_lock_order_refund_columns on public.product_orders;
create trigger tg_zz_lock_order_refund_columns
  before insert or update on public.product_orders
  for each row execute function public.tg_lock_order_refund_columns();

-- ── 5. A refunded pass cannot be redeemed ───────────────────────────────────
--
-- Byte-identical to the deployed function except for the refund_state refusal,
-- which is placed AFTER the existing SELECT ... FOR UPDATE on the purchase.
-- That position is the whole safety property: the claim below locks the same
-- row, so whichever transaction takes the lock first decides, and the other
-- sees its committed result rather than a stale snapshot.

CREATE OR REPLACE FUNCTION public.redeem_pass_atomic(p_verifier uuid, p_code text DEFAULT NULL::text, p_token text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_red      public.local_redemptions%rowtype;
  v_purchase public.book_unit_purchases%rowtype;
  v_left     integer;
  v_token    uuid;
begin
  if p_verifier is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;
  if coalesce(p_code, p_token) is null then
    raise exception 'code_required' using errcode = '22023';
  end if;

  -- A malformed token is "no such code", not a crash.
  if p_token is not null then
    begin
      v_token := p_token::uuid;
    exception when invalid_text_representation then
      return jsonb_build_object('ok', false, 'error', 'not_found');
    end;
  end if;

  -- Serialise on the redemption itself. Everyone presenting this code queues
  -- here; only the first finds it pending.
  select * into v_red
    from public.local_redemptions
   where (v_token is not null and token = v_token)
      or (v_token is null and code = upper(btrim(p_code)))
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_red.kind <> 'pass' then
    return jsonb_build_object('ok', false, 'error', 'wrong_kind');
  end if;
  if v_red.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'already_used');
  end if;
  if v_red.expires_at is not null and v_red.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  if not exists (
    select 1 from public.local_businesses b
     where b.id = v_red.business_id and b.owner_id = p_verifier
  ) then
    return jsonb_build_object('ok', false, 'error', 'not_your_business');
  end if;

  select * into v_purchase
    from public.book_unit_purchases
   where id = v_red.ref_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'pass_not_found');
  end if;
  if v_purchase.business_id <> v_red.business_id then
    return jsonb_build_object('ok', false, 'error', 'wrong_business');
  end if;
  -- Refund claimed or completed. Evaluated under the same row lock the refund
  -- claim takes, so a first use and a refund claim cannot both win.
  if coalesce(v_purchase.refund_state, 'none') <> 'none' then
    return jsonb_build_object('ok', false, 'error', 'pass_refunded');
  end if;
  if v_purchase.expires_at is not null and v_purchase.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'pass_expired');
  end if;
  if coalesce(v_purchase.uses_remaining, 0) <= 0 then
    return jsonb_build_object('ok', false, 'error', 'no_uses_left');
  end if;

  v_left := v_purchase.uses_remaining - 1;

  update public.book_unit_purchases
     set uses_remaining = v_left,
         fully_used_at  = case when v_left = 0 then now() else fully_used_at end
   where id = v_purchase.id;

  update public.local_redemptions
     set status = 'consumed', consumed_at = now(), consumed_by = p_verifier
   where id = v_red.id;

  return jsonb_build_object(
    'ok', true,
    'uses_remaining', v_left,
    'fully_used', v_left = 0,
    'purchase_id', v_purchase.id
  );
end;
$function$;

-- ── 6. Which purchase does this debit fund? ─────────────────────────────────
--
-- Resolved from OUR OWN rows, never from anything a caller sent. The four rails
-- link differently and only one of them stores a reference on the purchase:
--
--   unit purchase  book_unit_purchases.payment_intent_id = 'wallet_<txid>'
--   product order  debit.idempotency_key = 'product-order-<order id>'
--   charge by scan debit.idempotency_key = 'charge-<request id>'
--   wallet pay     no purchase object at all; the ledger row is the record

create or replace function public._business_refund_source(p_wallet_txn uuid)
  returns table (source_type text, source_id uuid)
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_txn public.local_wallet_transactions%rowtype;
  v_id  uuid;
begin
  select * into v_txn from public.local_wallet_transactions where id = p_wallet_txn;
  if not found then return; end if;

  select p.id into v_id
    from public.book_unit_purchases p
   where p.payment_intent_id = 'wallet_' || p_wallet_txn::text
   limit 1;
  if v_id is not null then
    return query select 'pass'::text, v_id;
    return;
  end if;

  if v_txn.idempotency_key like 'product-order-%' then
    begin
      v_id := substring(v_txn.idempotency_key from 15)::uuid;
    exception when invalid_text_representation then
      v_id := null;
    end;
    if v_id is not null and exists (select 1 from public.product_orders o where o.id = v_id) then
      return query select 'order'::text, v_id;
      return;
    end if;
  end if;

  if v_txn.idempotency_key like 'charge-%' then
    return query select 'charge'::text, null::uuid;
    return;
  end if;

  -- local-wallet-pay and anything else business-linked: nothing to freeze.
  return query select 'none'::text, null::uuid;
end;
$$;

-- ── 7. Claim ────────────────────────────────────────────────────────────────
--
-- The zero-uses test MUST run after the row lock, inside this function. Run as
-- a client-side pre-check it proves nothing: a redemption committing between
-- the check and the update would refund a pass whose use was already spent.

create or replace function public.business_refund_claim(p_wallet_txn uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_txn      public.local_wallet_transactions%rowtype;
  v_src      record;
  v_purchase public.book_unit_purchases%rowtype;
  v_order    public.product_orders%rowtype;
  v_used     integer;
begin
  if p_wallet_txn is null then
    return jsonb_build_object('ok', false, 'outcome', 'not_found');
  end if;

  select * into v_txn from public.local_wallet_transactions where id = p_wallet_txn;
  if not found then return jsonb_build_object('ok', false, 'outcome', 'not_found'); end if;
  if v_txn.type <> 'spend' then
    return jsonb_build_object('ok', false, 'outcome', 'not_a_spend');
  end if;
  if v_txn.business_id is null then
    return jsonb_build_object('ok', false, 'outcome', 'not_a_business_spend');
  end if;

  select * into v_src from public._business_refund_source(p_wallet_txn);

  if v_src.source_type = 'pass' then
    select * into v_purchase from public.book_unit_purchases
     where id = v_src.source_id for update;
    if not found then
      return jsonb_build_object('ok', false, 'outcome', 'not_found');
    end if;

    -- Linkage, from our rows. Stops a caller reversing transaction X while
    -- voiding purchase Y.
    if v_purchase.payment_intent_id is distinct from 'wallet_' || p_wallet_txn::text
    or v_purchase.business_id <> v_txn.business_id
    or v_purchase.owner_id    <> v_txn.user_id then
      return jsonb_build_object('ok', false, 'outcome', 'not_linked');
    end if;

    if v_purchase.refund_state = 'refunded' then
      return jsonb_build_object('ok', true, 'outcome', 'already_refunded',
                                'source_type', 'pass', 'source_id', v_purchase.id);
    end if;
    if v_purchase.refund_state = 'pending' then
      return jsonb_build_object('ok', true, 'outcome', 'already_pending',
                                'source_type', 'pass', 'source_id', v_purchase.id);
    end if;

    -- Launch policy: a pass is refundable only while nothing has been consumed.
    -- Counted from the redemption trail, not from uses_remaining against the
    -- catalogue: the original allowance is never snapshotted on the purchase,
    -- so a merchant editing uses_per_purchase would corrupt that comparison for
    -- every historical row.
    select count(*) into v_used
      from public.local_redemptions r
     where r.kind = 'pass' and r.ref_id = v_purchase.id and r.status = 'consumed';
    if v_used > 0 then
      return jsonb_build_object('ok', false, 'outcome', 'pass_used', 'uses_consumed', v_used);
    end if;

    update public.book_unit_purchases
       set refund_state = 'pending'
     where id = v_purchase.id;

    return jsonb_build_object('ok', true, 'outcome', 'claimed',
                              'source_type', 'pass', 'source_id', v_purchase.id);

  elsif v_src.source_type = 'order' then
    select * into v_order from public.product_orders
     where id = v_src.source_id for update;
    if not found then
      return jsonb_build_object('ok', false, 'outcome', 'not_found');
    end if;
    if v_order.business_id <> v_txn.business_id or v_order.buyer_id <> v_txn.user_id then
      return jsonb_build_object('ok', false, 'outcome', 'not_linked');
    end if;

    if v_order.refund_state = 'refunded' then
      return jsonb_build_object('ok', true, 'outcome', 'already_refunded',
                                'source_type', 'order', 'source_id', v_order.id);
    end if;
    if v_order.refund_state = 'pending' then
      return jsonb_build_object('ok', true, 'outcome', 'already_pending',
                                'source_type', 'order', 'source_id', v_order.id);
    end if;

    -- Launch policy: before anything has left the merchant.
    if v_order.status not in ('paid', 'accepted') then
      return jsonb_build_object('ok', false, 'outcome', 'order_not_refundable',
                                'status', v_order.status);
    end if;

    update public.product_orders
       set refund_state = 'pending'
     where id = v_order.id;

    return jsonb_build_object('ok', true, 'outcome', 'claimed',
                              'source_type', 'order', 'source_id', v_order.id);
  end if;

  -- local-wallet-pay and charge-by-scan: the ledger row is the whole record,
  -- so there is nothing to freeze and nothing that could be double-spent.
  return jsonb_build_object('ok', true, 'outcome', 'claimed',
                            'source_type', coalesce(v_src.source_type, 'none'),
                            'source_id', null);
end;
$$;

-- ── 8. Finalise ─────────────────────────────────────────────────────────────
--
-- One transaction: the money comes back, the source becomes refunded, the stock
-- comes back. If the terminal half fails the whole thing rolls back INCLUDING
-- wallet_reverse_debit and the Loyalty reversal nested inside it, returning to
-- "source pending, transfer clawed back" — a state the caller already knows how
-- to retry. That is why nothing here is allowed to be best-effort.

create or replace function public.business_refund_finalise(
  p_wallet_txn uuid,
  p_reason     text,
  p_merchant   text
) returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_txn      public.local_wallet_transactions%rowtype;
  v_src      record;
  v_purchase public.book_unit_purchases%rowtype;
  v_order    public.product_orders%rowtype;
  v_rev      record;
  v_item     record;
begin
  if p_wallet_txn is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  select * into v_txn from public.local_wallet_transactions where id = p_wallet_txn;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_txn.type <> 'spend' then
    return jsonb_build_object('ok', false, 'error', 'not_a_spend');
  end if;
  if v_txn.business_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_business_spend');
  end if;

  select * into v_src from public._business_refund_source(p_wallet_txn);

  -- Re-verify the source under lock. The claim proved it once; a lot can
  -- happen between a claim and a Stripe round trip.
  if v_src.source_type = 'pass' then
    select * into v_purchase from public.book_unit_purchases
     where id = v_src.source_id for update;
    if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    if v_purchase.payment_intent_id is distinct from 'wallet_' || p_wallet_txn::text then
      return jsonb_build_object('ok', false, 'error', 'not_linked');
    end if;
    if v_purchase.refund_state = 'none' then
      return jsonb_build_object('ok', false, 'error', 'not_claimed');
    end if;
  elsif v_src.source_type = 'order' then
    select * into v_order from public.product_orders
     where id = v_src.source_id for update;
    if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    if v_order.business_id <> v_txn.business_id then
      return jsonb_build_object('ok', false, 'error', 'not_linked');
    end if;
    if v_order.refund_state = 'none' then
      return jsonb_build_object('ok', false, 'error', 'not_claimed');
    end if;
  end if;

  -- The money. Unchanged, and still the authority on the merchant transfer
  -- verdict; the Loyalty reversal runs inside its own guard in there.
  select * into v_rev from public.wallet_reverse_debit(p_wallet_txn, p_reason, p_merchant);

  -- Already fully done: leave every counter alone and say so.
  if v_src.source_type = 'pass' and v_purchase.refund_state = 'refunded' then
    return jsonb_build_object('ok', true, 'already_complete', true,
                              'balance_pence', v_rev.balance_pence);
  end if;
  if v_src.source_type = 'order' and v_order.refund_state = 'refunded' then
    return jsonb_build_object('ok', true, 'already_complete', true,
                              'balance_pence', v_rev.balance_pence);
  end if;

  if v_src.source_type = 'pass' then
    update public.book_unit_purchases
       set refund_state          = 'refunded',
           refunded_at           = now(),
           refund_transaction_id = v_rev.reversal_id
     where id = v_purchase.id
       and refund_state = 'pending';
    if not found then
      return jsonb_build_object('ok', false, 'error', 'not_claimed');
    end if;

    -- One purchase consumed exactly one inventory unit at insert
    -- (tg_decrement_unit_stock), whatever its use allowance, so exactly one
    -- comes back. Untracked items (stock IS NULL) are left alone.
    update public.book_unit_items
       set stock = stock + 1
     where id = v_purchase.item_id
       and stock is not null;

  elsif v_src.source_type = 'order' then
    update public.product_orders
       set refund_state          = 'refunded',
           refunded_at           = now(),
           refund_transaction_id = v_rev.reversal_id,
           status                = 'refunded'
     where id = v_order.id
       and refund_state = 'pending';
    if not found then
      return jsonb_build_object('ok', false, 'error', 'not_claimed');
    end if;

    -- The exact inverse of commit_product_stock, per line. `reserved` is NOT
    -- touched: commit already released it and the reservation is long gone.
    -- Incrementing it here would quietly withhold inventory forever.
    for v_item in
      select product_id, variant_id, qty from public.product_order_items
       where order_id = v_order.id
    loop
      update public.products
         set stock     = case when stock_mode = 'tracked' and stock is not null
                              then stock + v_item.qty else stock end,
             sold_at   = case when stock_mode = 'one_off' then null else sold_at end,
             is_active = case when stock_mode = 'one_off' then true else is_active end
       where id = v_item.product_id;

      if v_item.variant_id is not null then
        update public.product_variants
           set stock = case when stock is not null then stock + v_item.qty else stock end
         where id = v_item.variant_id;
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'ok', true,
    'balance_pence',   v_rev.balance_pence,
    'reversal_id',     v_rev.reversal_id,
    'already_reversed', v_rev.already_reversed,
    'source_type',     v_src.source_type
  );
end;
$$;

-- ── 9. Rate-limit policy ────────────────────────────────────────────────────
--
-- enforceRateLimit denies an action nobody has classified, so the route cannot
-- work without this row. Deliberately tight: a refund is a deliberate act by a
-- merchant standing in front of a customer, not something anyone does in bulk.

insert into public.rate_limit_policies (action, window_seconds, max_count, note)
values ('business_refund', 3600, 20,
        'business Wallet refunds a merchant may issue per hour — each one calls Stripe and moves real money back')
on conflict (action) do nothing;

-- ── 10. Grants ──────────────────────────────────────────────────────────────
--
-- Server-side only. These functions move money and rewrite inventory; nothing
-- holding a customer's or a merchant's JWT may call them directly.

revoke all on function public._business_refund_source(uuid)            from public, anon, authenticated;
revoke all on function public.business_refund_claim(uuid)              from public, anon, authenticated;
revoke all on function public.business_refund_finalise(uuid, text, text) from public, anon, authenticated;

grant execute on function public._business_refund_source(uuid)             to service_role;
grant execute on function public.business_refund_claim(uuid)               to service_role;
grant execute on function public.business_refund_finalise(uuid, text, text) to service_role;

comment on function public.business_refund_claim(uuid) is
  'Freezes the source of a business wallet spend as refund_state=pending. Takes the purchase row lock BEFORE counting consumed pass uses, so a first redemption and a refund claim serialise: whichever wins the lock decides and the other refuses.';
comment on function public.business_refund_finalise(uuid, text, text) is
  'Terminal half of a business wallet refund: wallet_reverse_debit (unchanged, Loyalty reversal included), source pending -> refunded, stock restored, in ONE transaction. A failure anywhere rolls the money back too and leaves the source pending for retry.';
