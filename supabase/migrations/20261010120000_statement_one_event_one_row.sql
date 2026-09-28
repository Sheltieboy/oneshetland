/**
 * One commercial event, one statement row.
 *
 * The Wallet refund fix exposed the rest of the pattern. Anderson & Co's live
 * statement showed the same £3 purchase twice on 06 Sep:
 *
 *     pass_sale       DEMO — 3 Session Pass   gross 300  fee  0  net 300
 *     wallet_payment  Wallet payment          gross 300  fee 15  net 285
 *
 * and the pass row's reference gave it away: `wallet_a119afc0-…`, the very
 * transaction the row beside it reports. Money in counted £6.00 for a £3 sale.
 *
 * Every rail that can be paid from the Wallet does this, not just shop orders:
 *
 *     passes    wallet-checkout             book_unit_purchases.payment_intent_id
 *     gifts     create-gift-intent          book_gifts.payment_intent_id
 *     tickets   create-event-ticket-intent  event_ticket_orders.stripe_payment_intent_id
 *     orders    create-product-order-intent wallet idempotency_key (already fixed)
 *
 * all stamped by the writer as 'wallet_' || <wallet transaction id>. That is the
 * linkage used here -- a stable id the writer created, never a description or a
 * date. Bookings and boosts have no Wallet rail at all; their branches are
 * untouched.
 *
 * The ledger row wins, for the same reasons it won for shop orders and one more
 * that is decisive. The domain branches report passes and gifts with fee 0 and
 * net = gross, so Anderson's pass claimed the merchant earned £3.00 when the
 * money they actually received was £2.85. Worse, a refund mirrors the LEDGER
 * row: sale +300/0/+300 against refund -300/-15/-285 would leave 15p of invented
 * profit behind for ever. Reported from the ledger, the pair nets to nothing.
 *
 * So the wallet row wears whatever it bought -- pass_sale, gift_sale,
 * ticket_sale, product_sale -- and the domain branch stands down for it. A
 * Wallet payment that bought nothing else stays 'wallet_payment'. Card-funded
 * sales are untouched in every branch.
 *
 * Read path only. No financial table, function or balance is altered, and the
 * clients need no change: every kind emitted here is one they already label.
 */

CREATE OR REPLACE FUNCTION public.get_business_transactions(p_business_id uuid, p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 500)
 RETURNS TABLE(occurred_at timestamp with time zone, direction text, kind text, description text, counterparty text, gross_pence integer, fee_pence integer, cashback_pence integer, net_pence integer, status text, reference text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
           coalesce(funded.reference, t.stripe_transfer_id) AS reference
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
           'paid', p.payment_intent_id
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
           g.status, g.code
    FROM public.book_gifts g
    WHERE g.business_id = p_business_id AND g.status IN ('sent', 'claimed', 'used')
      AND coalesce(g.payment_intent_id, '') NOT LIKE 'wallet\_%'

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
           po.status, po.payment_intent_id
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
           bp.status, bp.stripe_payment_intent_id
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
    SELECT r.created_at, 'refund', 'wallet_refund',
           'Refund', r.user_id,
           -abs(o.amount_pence),
           -coalesce(o.platform_fee_pence, 0),
           -coalesce(o.cashback_pence, 0),
           -(abs(o.amount_pence) - coalesce(o.platform_fee_pence, 0) - coalesce(o.cashback_pence, 0)),
           'refunded', o.id::text
    FROM public.local_wallet_transactions r
    JOIN public.local_wallet_transactions o ON o.id = r.reverses_transaction_id
    WHERE r.type = 'refund'
      AND o.type = 'spend'
      -- Anchored on the ORIGINAL row's business, so one merchant's refund can
      -- never surface on another's statement.
      AND o.business_id = p_business_id
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
$function$;

REVOKE ALL ON FUNCTION public.get_business_transactions(uuid, timestamptz, timestamptz, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_business_transactions(uuid, timestamptz, timestamptz, integer) TO authenticated, service_role;
