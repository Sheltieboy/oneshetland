-- Wallet statement: distinguish "paid, then refunded" from "transfer failed,
-- never reached the merchant", 1 Oct 2026.
--
-- A real £5.00 Premium Wallet payment was correctly debited, the merchant
-- transfer was then REJECTED by Stripe (insufficient platform funds), and
-- the customer was automatically refunded. The merchant NEVER received a
-- penny and the platform retained no fee. The business dashboard and the
-- full ledger both showed this exactly like a genuine sale that was later
-- refunded: "£5.00 paid · £4.95 to you · £0.05 fee", then "Refunded" — which
-- is a materially false claim about what happened to the merchant's money.
--
-- This was already distinguishable server-side, just never surfaced:
-- local_wallet_transactions.transfer_state on the ORIGINAL spend row reads
-- 'failed' when debitAndTransfer's Stripe call was rejected outright and
-- the automatic reversal ran in the SAME request (wallet-ledger.ts,
-- outcome.kind === 'rejected'), and 'reversed' when the transfer genuinely
-- reached the merchant ('sent') before a later, separate refund clawed it
-- back. This surfaces that literal column — not a collapsed yes/no, the
-- actual stored value — so the client can tell 'failed' (the only state
-- that is EVER synchronously paired with an automatic reversal) apart from
-- 'pending'/'unresolved' (awaiting resolution, never auto-reversed) without
-- guessing from amounts or display text.
--
-- transfer_state is null for every non-Wallet rail (gift/pass/product/
-- ticket/booking/boost): those settle through Stripe's destination-charge
-- mechanism the instant their own charge succeeds, and the concept simply
-- does not apply to them.
--
-- Nothing about amounts, signs, dates, kind, or any other column changes,
-- and nothing about the payment/transfer/refund/preflight code paths is
-- touched — this is additive, read-only reporting.

drop function if exists public.get_business_wallet_receipts(uuid, integer);

create function public.get_business_wallet_receipts(p_business_id uuid, p_limit integer DEFAULT 20)
 returns table(id uuid, created_at timestamp with time zone, gross_pence integer, fee_pence integer, cashback_pence integer, net_pence integer, customer_first_name text, stripe_transfer_id text, refund_state text, refunded_at timestamp with time zone, refund_transaction_id uuid, transfer_state text)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
#variable_conflict use_column
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'auth_required';
  end if;

  if not exists (
    select 1 from public.local_businesses
     where id = p_business_id and owner_id = v_user_id
  ) then
    raise exception 'not_business_owner';
  end if;

  return query
    select
      t.id,
      t.created_at,
      abs(t.amount_pence)                                       as gross_pence,
      t.platform_fee_pence                                      as fee_pence,
      t.cashback_pence                                          as cashback_pence,
      case when t.platform_fee_pence is null
           then null
           else abs(t.amount_pence) - t.platform_fee_pence - coalesce(t.cashback_pence, 0)
      end                                                       as net_pence,
      nullif(split_part(coalesce(p.full_name, ''), ' ', 1), '') as customer_first_name,
      t.stripe_transfer_id,
      -- Refunded means the money went back, and the ledger is the only thing
      -- that knows. A row that merely claimed its source has not credited
      -- anyone yet and is still 'none'.
      case when rev.id is null then 'none' else 'refunded' end  as refund_state,
      rev.created_at                                            as refunded_at,
      rev.id                                                    as refund_transaction_id,
      t.transfer_state
    from public.local_wallet_transactions t
    left join public.profiles p on p.id = t.user_id
    -- The reversal that names THIS spend. reverses_transaction_id is the link
    -- wallet_reverse_debit writes, so one receipt can never pick up another
    -- receipt's refund.
    left join lateral (
      select r.id, r.created_at
        from public.local_wallet_transactions r
       where r.reverses_transaction_id = t.id
         and r.type = 'refund'
       order by r.created_at
       limit 1
    ) rev on true
    where t.business_id = p_business_id
      and t.type        = 'spend'
    order by t.created_at desc
    limit greatest(1, least(p_limit, 100));
end;
$function$;

revoke all on function public.get_business_wallet_receipts(uuid, integer) from public;
grant execute on function public.get_business_wallet_receipts(uuid, integer) to anon, authenticated, service_role;

drop function if exists public.get_business_transactions(uuid, timestamp with time zone, timestamp with time zone, integer);

create function public.get_business_transactions(p_business_id uuid, p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 500)
 returns table(occurred_at timestamp with time zone, direction text, kind text, description text, counterparty text, gross_pence integer, fee_pence integer, cashback_pence integer, net_pence integer, status text, reference text, transfer_state text)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.local_businesses b WHERE b.id = p_business_id AND b.owner_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not your business';
  END IF;

  RETURN QUERY
  WITH ev AS (
    -- 1. Wallet payments received (customer 'spend' rows carry the fee + cashback)
    --    A shop order paid from the Wallet writes BOTH a wallet spend (this
    --    branch) and a product_orders row (branch 6), so it was reported twice
    --    and the merchant's income was double-counted. The wallet ledger is the
    --    authority: it is what the money actually did, it carries the cashback
    --    branch 6 hard-codes to zero, it survives a refund where branch 6's row
    --    disappears on status = 'refunded', and it is the row a refund mirrors —
    --    so sale and reversal net to zero by construction. Branch 6 now stands
    --    down for these, and this row wears the order's clothes instead, which
    --    both clients already label "Shop order".
    SELECT t.created_at AS occurred_at, 'in'::text AS direction,
           coalesce(funded.kind, 'wallet_payment')::text AS kind,
           coalesce(funded.description, 'Wallet payment')::text AS description,
           t.user_id AS counterparty_id,
           abs(t.amount_pence) AS gross_pence, coalesce(t.platform_fee_pence, 0) AS fee_pence,
           coalesce(t.cashback_pence, 0) AS cashback_pence,
           abs(t.amount_pence) - coalesce(t.platform_fee_pence, 0) - coalesce(t.cashback_pence, 0) AS net_pence,
           'paid'::text AS status,
           coalesce(funded.reference, t.stripe_transfer_id) AS reference,
           -- The literal stored state, not a collapsed yes/no. 'failed' is
           -- the only value EVER synchronously paired with an automatic
           -- reversal in the same request (wallet-ledger.ts) — 'pending' and
           -- 'unresolved' are awaiting resolution and must not be read the
           -- same way.
           t.transfer_state AS transfer_state
    FROM public.local_wallet_transactions t
    -- What this payment bought, resolved by the reference the WRITER stamped on
    -- the domain row -- never by description or date. wallet-checkout,
    -- create-gift-intent and create-event-ticket-intent all write
    -- 'wallet_' || <wallet transaction id>; create-product-order-intent pays with
    -- idempotency key 'product-order-' || <order id>. Exactly one can match.
    LEFT JOIN LATERAL (
      SELECT 'product_sale'::text AS kind, 'Shop order'::text AS description,
             substring(t.idempotency_key from length('product-order-') + 1) AS reference
       WHERE t.idempotency_key LIKE 'product-order-%'
      UNION ALL
      SELECT 'pass_sale', coalesce(i.name, 'Pass / class pack'), p.id::text
        FROM public.book_unit_purchases p
        LEFT JOIN public.book_unit_items i ON i.id = p.item_id
       WHERE p.payment_intent_id = 'wallet_' || t.id::text
      UNION ALL
      SELECT 'gift_sale', 'Gift purchase', g.code
        FROM public.book_gifts g
       WHERE g.payment_intent_id = 'wallet_' || t.id::text
      UNION ALL
      SELECT 'ticket_sale', coalesce(e.title, 'Event tickets'), o.id::text
        FROM public.event_ticket_orders o
        JOIN public.events e ON e.id = o.event_id
       WHERE o.stripe_payment_intent_id = 'wallet_' || t.id::text
      LIMIT 1
    ) funded ON true
    WHERE t.business_id = p_business_id AND t.type = 'spend'

    UNION ALL
    -- 2. Pass / class-pack sales (exclude gift-funded so the gift isn't double-counted)
    SELECT p.created_at, 'in', 'pass_sale',
           coalesce(i.name, 'Pass / class pack'), p.owner_id,
           p.paid_amount_pence, 0, 0, p.paid_amount_pence,
           'paid', p.payment_intent_id,
           null::text
    FROM public.book_unit_purchases p
    LEFT JOIN public.book_unit_items i ON i.id = p.item_id
    WHERE p.business_id = p_business_id AND p.gift_id IS NULL
      -- Card-funded only: a wallet-funded pass is already reported by branch 1
      -- from the ledger row that actually moved the money.
      AND coalesce(p.payment_intent_id, '') NOT LIKE 'wallet\_%'

    UNION ALL
    -- 3. Gift sales (paid ones only)
    SELECT g.created_at, 'in', 'gift_sale',
           'Gift purchase', g.purchaser_id,
           g.price_paid_pence, 0, 0, g.price_paid_pence,
           g.status, g.code,
           null::text
    FROM public.book_gifts g
    WHERE g.business_id = p_business_id AND g.status IN ('sent', 'claimed', 'used')
      AND coalesce(g.payment_intent_id, '') NOT LIKE 'wallet\_%'

    UNION ALL
    -- 4. Booking deposits taken through the platform
    SELECT coalesce(b.deposit_paid_at, b.created_at), 'in', 'booking_deposit',
           coalesce(s.name, 'Booking deposit'), b.customer_id,
           b.deposit_pence, 0, 0, b.deposit_pence,
           b.status, b.deposit_payment_intent_id,
           null::text
    FROM public.book_bookings b
    LEFT JOIN public.book_services s ON s.id = b.service_id
    WHERE b.business_id = p_business_id AND coalesce(b.deposit_pence, 0) > 0
      AND b.deposit_paid_at IS NOT NULL AND b.gift_id IS NULL

    UNION ALL
    -- 5. Event ticket sales (this business is the organiser)
    SELECT o.paid_at, 'in', 'ticket_sale',
           coalesce(e.title, 'Event tickets'), o.buyer_id,
           o.total_pence, coalesce(o.platform_fee_pence, 0), 0,
           o.total_pence - coalesce(o.platform_fee_pence, 0),
           'paid', o.stripe_payment_intent_id,
           null::text
    FROM public.event_ticket_orders o
    JOIN public.events e ON e.id = o.event_id
    WHERE e.organiser_business_id = p_business_id AND o.status = 'paid'
      AND coalesce(o.stripe_payment_intent_id, '') NOT LIKE 'wallet\_%'

    UNION ALL
    -- 6. Shop Shetland product sales (gross incl. postage; fee = 5% commission
    --    on goods; postage passes through uncharged)
    SELECT po.paid_at, 'in', 'product_sale',
           (SELECT string_agg(oi.qty || '× ' || oi.title, ', ')
              FROM public.product_order_items oi WHERE oi.order_id = po.id),
           po.buyer_id,
           po.total_pence, po.commission_pence, 0,
           po.total_pence - po.commission_pence,
           po.status, po.payment_intent_id,
           null::text
    FROM public.product_orders po
    WHERE po.business_id = p_business_id
      AND po.paid_at IS NOT NULL
      AND po.status NOT IN ('pending', 'expired', 'cancelled', 'refunded')
      -- Card-funded orders only. A wallet-funded order is already reported by
      -- branch 1 from the ledger row executeWalletPayment wrote against this
      -- exact key, and reporting it here as well was the double-count. Matched
      -- on the id-based idempotency key -- the same link _business_refund_source
      -- resolves refunds by -- never on description text.
      AND NOT EXISTS (
        SELECT 1 FROM public.local_wallet_transactions w
         WHERE w.type = 'spend'
           AND w.idempotency_key = 'product-order-' || po.id::text
      )

    UNION ALL
    -- 7. Boosts paid (a cost to the business)
    SELECT bp.created_at, 'out', 'boost',
           bp.weeks || ' week listing boost', NULL::uuid,
           bp.amount_pence, 0, 0, -bp.amount_pence,
           bp.status, bp.stripe_payment_intent_id,
           null::text
    FROM public.local_boost_purchases bp
    WHERE bp.business_id = p_business_id AND bp.status = 'succeeded'

    UNION ALL
    -- 8. Wallet refunds. Branch 1 selects type = 'spend', so the reversal --
    --    written as its own type = 'refund' row -- was excluded outright, and a
    --    refunded payment went on being reported as earned for ever.
    --
    --    The sale is NOT rewritten. It stays in its own period exactly as it was
    --    earned, and the reversal lands on the date the money actually went
    --    back, so August keeps its August and September carries the refund.
    --
    --    Signs are the mirror of the sale, and every figure is taken from the
    --    ORIGINAL row because the refund row carries no fee or cashback of its
    --    own (wallet_reverse_debit writes only the amount). Reversing the fee is
    --    not generosity: the merchant's transfer of gross - fee - cashback is
    --    clawed back in full, so they never bore the fee, and charging them for
    --    it here would invent a loss the money never made.
    --
    --    kind is resolved against the ORIGINAL transaction `o` the exact same
    --    way branch 1 resolves it against `t` -- so a refund of a genuine
    --    till payment is 'wallet_payment_refund', and a refund of a
    --    wallet-funded gift/pass/product/ticket purchase is
    --    '<that rail>_refund'. Both read as "Refund" in KIND_LABEL on both
    --    clients; only a savings calculator that matches on kind can tell
    --    them apart, which is the whole point -- it must net a genuine
    --    Wallet payment's refund against its sale, and must NOT net a
    --    refund it never counted as a Wallet saving in the first place.
    --
    --    transfer_state mirrors the ORIGINAL's own final state: a refund of
    --    a transfer that was genuinely 'sent' then clawed back reports
    --    'reversed' (merchant had the money); a refund of a transfer that
    --    was rejected outright and never sent reports 'failed' (merchant
    --    never had the money this row is reversing) — the SAME value
    --    branch 1 already wrote for this exact spend, just read back.
    SELECT r.created_at, 'refund'::text,
           (coalesce(funded.kind, 'wallet_payment') || '_refund')::text,
           'Refund'::text, r.user_id,
           -abs(o.amount_pence),
           -coalesce(o.platform_fee_pence, 0),
           -coalesce(o.cashback_pence, 0),
           -(abs(o.amount_pence) - coalesce(o.platform_fee_pence, 0) - coalesce(o.cashback_pence, 0)),
           'refunded'::text, o.id::text,
           o.transfer_state
    FROM public.local_wallet_transactions r
    JOIN public.local_wallet_transactions o ON o.id = r.reverses_transaction_id
    LEFT JOIN LATERAL (
      SELECT 'product_sale'::text AS kind
       WHERE o.idempotency_key LIKE 'product-order-%'
      UNION ALL
      SELECT 'pass_sale' FROM public.book_unit_purchases p WHERE p.payment_intent_id = 'wallet_' || o.id::text
      UNION ALL
      SELECT 'gift_sale' FROM public.book_gifts g WHERE g.payment_intent_id = 'wallet_' || o.id::text
      UNION ALL
      SELECT 'ticket_sale' FROM public.event_ticket_orders eto WHERE eto.stripe_payment_intent_id = 'wallet_' || o.id::text
      LIMIT 1
    ) funded ON true
    WHERE r.type = 'refund'
      AND o.type = 'spend'
      -- Anchored on the ORIGINAL row's business, so one merchant's refund can
      -- never surface on another's statement.
      AND o.business_id = p_business_id
  )
  SELECT ev.occurred_at, ev.direction, ev.kind, ev.description,
         coalesce(pr.display_name, pr.full_name,
                  CASE WHEN ev.counterparty_id IS NULL THEN 'OneShetland' ELSE 'Customer' END) AS counterparty,
         ev.gross_pence, ev.fee_pence, ev.cashback_pence, ev.net_pence, ev.status, ev.reference,
         ev.transfer_state
  FROM ev
  LEFT JOIN public.profiles pr ON pr.id = ev.counterparty_id
  WHERE (p_from IS NULL OR ev.occurred_at >= p_from)
    AND (p_to   IS NULL OR ev.occurred_at <  p_to)
  ORDER BY ev.occurred_at DESC
  LIMIT greatest(1, least(coalesce(p_limit, 500), 5000));
END;
$function$;

revoke all on function public.get_business_transactions(uuid, timestamp with time zone, timestamp with time zone, integer) from public, anon;
grant execute on function public.get_business_transactions(uuid, timestamp with time zone, timestamp with time zone, integer) to authenticated, service_role;
