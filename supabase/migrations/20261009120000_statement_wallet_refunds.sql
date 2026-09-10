/**
 * Money & transactions: account for Wallet refunds.
 *
 * A real £3 Anderson & Co payment was refunded in full -- the customer got
 * £3.00 back and the merchant's £2.85 transfer was reversed -- and the
 * statement went on reporting it as earned: Money in £24.77, Fees £5.97, Net
 * £18.80, with no refund anywhere in the history.
 *
 * The cause is the same one that hid it from the receipts list. Branch 1 reads
 * `t.type = 'spend'`; the reversal is a `type = 'refund'` row, so the filter
 * dropped it. Nothing was wrong with the money -- the ledger, the transfer
 * reversal and the balances were all correct -- it was never reported.
 *
 * A refunded sale now contributes the exact mirror of itself:
 *
 *     sale     gross +300   fee +15   cashback +0   net +285
 *     refund   gross -300   fee -15   cashback -0   net -285
 *                    ----        ---            --       ----
 *                       0          0             0          0
 *
 * so Money in still shows the sale that genuinely happened, Refunds shows what
 * went back, the fee nets to nothing, and the merchant's net contribution for
 * the pair is zero. The merchant loses the £2.85 they were credited -- not the
 * £3.00 the customer received, and not the 15p fee they never paid.
 *
 * It also closes a double-count found while proving this: a wallet-funded shop
 * order wrote both a wallet spend and a product_orders row, and the statement
 * reported both. The wallet ledger wins -- see the note on branch 1 -- and
 * branch 6 now covers card-funded orders only.
 *
 * `direction` gains a third value, 'refund'. Existing 'in' and 'out' rows are
 * untouched, every other branch is byte-identical, and no financial table,
 * function or balance is altered: this is a read path.
 *
 * DEPLOY THE CLIENTS FIRST. A client that has not learned 'refund' falls into
 * its `else` branch and treats the row as a cost with a negative gross, adding
 * £3 to Net instead of subtracting £2.85. A new client against the old backend
 * simply sees no refund rows, which is today's behaviour and harmless.
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
           CASE WHEN t.idempotency_key LIKE 'product-order-%'
                THEN 'product_sale' ELSE 'wallet_payment' END::text AS kind,
           CASE WHEN t.idempotency_key LIKE 'product-order-%'
                THEN 'Shop order' ELSE 'Wallet payment' END::text AS description,
           t.user_id AS counterparty_id,
           abs(t.amount_pence) AS gross_pence, coalesce(t.platform_fee_pence, 0) AS fee_pence,
           coalesce(t.cashback_pence, 0) AS cashback_pence,
           abs(t.amount_pence) - coalesce(t.platform_fee_pence, 0) - coalesce(t.cashback_pence, 0) AS net_pence,
           'paid'::text AS status,
           -- Branch 6 has no reference to give for these: the wallet path never
           -- creates a payment intent, so its payment_intent_id is NULL. The
           -- order id is the reference that reconciles.
           CASE WHEN t.idempotency_key LIKE 'product-order-%'
                THEN substring(t.idempotency_key from length('product-order-') + 1)
                ELSE t.stripe_transfer_id END AS reference
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


-- Unchanged from the function's own migration; restated so the grant travels
-- with the definition.
REVOKE ALL ON FUNCTION public.get_business_transactions(uuid, timestamptz, timestamptz, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_business_transactions(uuid, timestamptz, timestamptz, integer) TO authenticated, service_role;
