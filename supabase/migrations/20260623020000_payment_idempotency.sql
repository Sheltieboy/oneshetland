-- =============================================================================
-- 20260623020000_payment_idempotency.sql
--
-- Hardens idempotency in three payment paths so a double-tap or concurrent
-- call cannot double-credit / double-issue:
--
--   1. activate_hub_membership  -> gate paid_until extension on the payment
--                                  intent so a repeated call is a no-op.
--   2. local-wallet-confirm-topup -> UNIQUE on the dedupe (ledger) row so the
--                                  ledger-first reorder in the edge function
--                                  has a hard guarantee.
--   3. confirm-unit-purchase    -> UNIQUE on the purchase PI so the racy
--                                  check-then-act becomes a safe insert.
--
-- Re-runnable: every statement uses IF NOT EXISTS / DROP ... IF EXISTS /
-- CREATE OR REPLACE, and the unique indexes are partial (PI IS NOT NULL) so
-- existing NULL-PI rows (gifts, refunds, spends) are unaffected.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. hub_members.stripe_payment_intent_id  (column already exists)
--    Partial unique index so the same PaymentIntent can never activate two
--    memberships. NULL PIs (free / legacy memberships) are excluded.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS hub_members_stripe_payment_intent_id_key
  ON public.hub_members (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. local_wallet_transactions.stripe_payment_intent_id  (column already exists)
--    Partial unique index so the ledger insert is the single source of truth
--    for "this top-up was already credited". NULL PIs (spend/refund/cashback
--    rows that carry no Stripe PI) are excluded.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS local_wallet_transactions_stripe_payment_intent_id_key
  ON public.local_wallet_transactions (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 3. book_unit_purchases.payment_intent_id  (column already exists)
--    Partial unique index so a second confirm for the same PaymentIntent hits
--    a unique violation instead of issuing a second purchase. NULL PIs (gifted
--    units, which carry gift_id and no PI) are excluded.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS book_unit_purchases_payment_intent_id_key
  ON public.book_unit_purchases (payment_intent_id)
  WHERE payment_intent_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 1 (cont). activate_hub_membership — make idempotent on the payment intent.
--
-- Before: every call unconditionally recomputed paid_until from
-- greatest(now(), existing.paid_until) and extended by the period, so calling
-- twice for ONE payment granted a free extra period.
--
-- After: if the existing row already records THIS p_pi, the function returns
-- the current state unchanged (no extension, no re-stamp). First-time
-- behaviour for a new PI is preserved exactly.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.activate_hub_membership(
  p_hub uuid, p_user uuid, p_type uuid, p_period text, p_payment_pence integer, p_pi text
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_existing   public.hub_members%rowtype;
  v_base       timestamptz;
  v_paid_until timestamptz;
  v_member_no  text;
begin
  select * into v_existing from public.hub_members
    where hub_id = p_hub and user_id = p_user
    for update;

  -- Idempotency guard: if this exact payment intent has already been applied
  -- to this membership, do nothing and return the current state. This stops a
  -- double-tap / concurrent retry from granting a second period.
  if p_pi is not null
     and v_existing.user_id is not null
     and v_existing.stripe_payment_intent_id is not distinct from p_pi then
    return jsonb_build_object(
      'member_no',  v_existing.member_no,
      'paid_until', v_existing.paid_until
    );
  end if;

  -- Expiry date
  if p_period = 'once' then
    v_paid_until := null;                                  -- lifetime
  else
    v_base := greatest(now(), coalesce(v_existing.paid_until, now()));
    v_paid_until := case p_period
      when 'year'  then v_base + interval '1 year'
      when 'month' then v_base + interval '1 month'
      else null
    end;
  end if;

  -- Member number: keep existing, else next sequential numeric for this hub.
  if v_existing.member_no is not null then
    v_member_no := v_existing.member_no;
  else
    select (coalesce(max(member_no::int), 0) + 1)::text
      into v_member_no
      from public.hub_members
      where hub_id = p_hub and member_no ~ '^[0-9]+$';
  end if;

  -- Create the row if new (status set by the join trigger here), then force the
  -- final paid state in a follow-up UPDATE the trigger can't touch.
  insert into public.hub_members
    (hub_id, user_id, role, status, membership_type_id, paid_until, last_payment_pence, stripe_payment_intent_id, member_no)
  values
    (p_hub, p_user, 'member', 'active', p_type, v_paid_until, p_payment_pence, p_pi, v_member_no)
  on conflict (hub_id, user_id) do nothing;

  update public.hub_members set
    status                   = 'active',
    membership_type_id       = p_type,
    paid_until               = v_paid_until,
    last_payment_pence       = p_payment_pence,
    stripe_payment_intent_id = p_pi,
    member_no                = coalesce(member_no, v_member_no)
  where hub_id = p_hub and user_id = p_user;

  return jsonb_build_object('member_no', v_member_no, 'paid_until', v_paid_until);
end;
$_$;
