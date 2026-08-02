-- Money & transactions: include Shop Shetland product sales in the business
-- statement (they were invisible to the accountant export). Full function
-- reproduced from 20260729040000 with the new product_sale branch added.

CREATE OR REPLACE FUNCTION public.get_business_transactions(
  p_business_id uuid,
  p_from        timestamptz DEFAULT NULL,
  p_to          timestamptz DEFAULT NULL,
  p_limit       integer     DEFAULT 500
) RETURNS TABLE (
  occurred_at    timestamptz,
  direction      text,
  kind           text,
  description    text,
  counterparty   text,
  gross_pence    integer,
  fee_pence      integer,
  cashback_pence integer,
  net_pence      integer,
  status         text,
  reference      text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.local_businesses b WHERE b.id = p_business_id AND b.owner_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not your business';
  END IF;

  RETURN QUERY
  WITH ev AS (
    -- 1. Wallet payments received (customer 'spend' rows carry the fee + cashback)
    SELECT t.created_at AS occurred_at, 'in'::text AS direction, 'wallet_payment'::text AS kind,
           'Wallet payment'::text AS description, t.user_id AS counterparty_id,
           abs(t.amount_pence) AS gross_pence, coalesce(t.platform_fee_pence, 0) AS fee_pence,
           coalesce(t.cashback_pence, 0) AS cashback_pence,
           abs(t.amount_pence) - coalesce(t.platform_fee_pence, 0) - coalesce(t.cashback_pence, 0) AS net_pence,
           'paid'::text AS status, t.stripe_transfer_id AS reference
    FROM public.local_wallet_transactions t
    WHERE t.business_id = p_business_id AND t.type = 'spend'

    UNION ALL
    -- 2. Pass / class-pack sales (exclude gift-funded so the gift isn't double-counted)
    SELECT p.created_at, 'in', 'pass_sale',
           coalesce(i.name, 'Pass / class pack'), p.owner_id,
           p.paid_amount_pence, 0, 0, p.paid_amount_pence,
           'paid', p.payment_intent_id
    FROM public.book_unit_purchases p
    LEFT JOIN public.book_unit_items i ON i.id = p.item_id
    WHERE p.business_id = p_business_id AND p.gift_id IS NULL

    UNION ALL
    -- 3. Gift sales (paid ones only)
    SELECT g.created_at, 'in', 'gift_sale',
           'Gift purchase', g.purchaser_id,
           g.price_paid_pence, 0, 0, g.price_paid_pence,
           g.status, g.code
    FROM public.book_gifts g
    WHERE g.business_id = p_business_id AND g.status IN ('sent', 'claimed', 'used')

    UNION ALL
    -- 4. Booking deposits taken through the platform
    SELECT coalesce(b.deposit_paid_at, b.created_at), 'in', 'booking_deposit',
           coalesce(s.name, 'Booking deposit'), b.customer_id,
           b.deposit_pence, 0, 0, b.deposit_pence,
           b.status, b.deposit_payment_intent_id
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
           'paid', o.stripe_payment_intent_id
    FROM public.event_ticket_orders o
    JOIN public.events e ON e.id = o.event_id
    WHERE e.organiser_business_id = p_business_id AND o.status = 'paid'

    UNION ALL
    -- 6. Shop Shetland product sales (gross incl. postage; fee = 5% commission
    --    on goods; postage passes through uncharged)
    SELECT po.paid_at, 'in', 'product_sale',
           (SELECT string_agg(oi.qty || '× ' || oi.title, ', ')
              FROM public.product_order_items oi WHERE oi.order_id = po.id),
           po.buyer_id,
           po.total_pence, po.commission_pence, 0,
           po.total_pence - po.commission_pence,
           po.status, po.payment_intent_id
    FROM public.product_orders po
    WHERE po.business_id = p_business_id
      AND po.paid_at IS NOT NULL
      AND po.status NOT IN ('pending', 'expired', 'cancelled', 'refunded')

    UNION ALL
    -- 7. Boosts paid (a cost to the business)
    SELECT bp.created_at, 'out', 'boost',
           bp.weeks || ' week listing boost', NULL::uuid,
           bp.amount_pence, 0, 0, -bp.amount_pence,
           bp.status, bp.stripe_payment_intent_id
    FROM public.local_boost_purchases bp
    WHERE bp.business_id = p_business_id AND bp.status = 'succeeded'
  )
  SELECT ev.occurred_at, ev.direction, ev.kind, ev.description,
         coalesce(pr.display_name, pr.full_name,
                  CASE WHEN ev.counterparty_id IS NULL THEN 'OneShetland' ELSE 'Customer' END) AS counterparty,
         ev.gross_pence, ev.fee_pence, ev.cashback_pence, ev.net_pence, ev.status, ev.reference
  FROM ev
  LEFT JOIN public.profiles pr ON pr.id = ev.counterparty_id
  WHERE (p_from IS NULL OR ev.occurred_at >= p_from)
    AND (p_to   IS NULL OR ev.occurred_at <  p_to)
  ORDER BY ev.occurred_at DESC
  LIMIT greatest(1, least(coalesce(p_limit, 500), 5000));
END;
$$;
