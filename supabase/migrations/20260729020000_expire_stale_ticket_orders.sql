-- Release ticket capacity held by abandoned (never-paid) orders.
--
-- reserve_ticket_slots() bumps event_ticket_types.quantity_sold the moment an
-- order is created, before payment. If the buyer abandons the PaymentSheet the
-- order stays 'pending' forever and those seats are never given back — a slow
-- capacity leak that can make a popular event look sold out.
--
-- This SECURITY DEFINER function, called each pass of reminder-runner, finds
-- pending orders older than a conservative window, gives their reserved seats
-- back (per ticket type, floored at 0), voids the unpaid tickets, and cancels
-- the orders. Returns the number of orders expired.
--
-- SAFE with the stripe-webhook fulfilment safety-net: Stripe fires
-- payment_intent.succeeded within seconds of a successful charge, so any
-- genuinely-paid order is already flipped to 'paid' long before the window
-- elapses. Only truly-dead orders remain 'pending' by then. The stale orders
-- are locked FOR UPDATE up front so a late confirm can't race the release.

CREATE OR REPLACE FUNCTION public.expire_stale_ticket_orders(p_older_than_minutes integer DEFAULT 60)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cutoff timestamptz := now() - make_interval(mins => p_older_than_minutes);
  v_count  integer := 0;
BEGIN
  -- Lock the stale, still-pending orders up front. Holding the row locks for the
  -- whole function stops a concurrent confirm flipping one to 'paid' between us
  -- releasing its slots and cancelling it. SKIP LOCKED avoids fighting an
  -- in-flight confirm — that order simply waits for the next run.
  CREATE TEMP TABLE _stale_orders ON COMMIT DROP AS
    SELECT id
    FROM public.event_ticket_orders
    WHERE status = 'pending'
      AND created_at < v_cutoff
    FOR UPDATE SKIP LOCKED;

  IF NOT EXISTS (SELECT 1 FROM _stale_orders) THEN
    RETURN 0;
  END IF;

  -- 1) Give the reserved capacity back, summed per ticket type.
  UPDATE public.event_ticket_types tt
  SET quantity_sold = GREATEST(0, tt.quantity_sold - f.qty)
  FROM (
    SELECT t.ticket_type_id, count(*)::int AS qty
    FROM public.event_tickets t
    JOIN _stale_orders s ON s.id = t.order_id
    WHERE t.status = 'pending_payment'
    GROUP BY t.ticket_type_id
  ) f
  WHERE tt.id = f.ticket_type_id;

  -- 2) Void the unpaid tickets.
  UPDATE public.event_tickets t
  SET status = 'cancelled'
  FROM _stale_orders s
  WHERE t.order_id = s.id
    AND t.status = 'pending_payment';

  -- 3) Cancel the orders.
  UPDATE public.event_ticket_orders o
  SET status = 'cancelled', cancelled_at = now()
  FROM _stale_orders s
  WHERE o.id = s.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN v_count;
END;
$$;

-- Only the service role (reminder-runner) should ever run this.
REVOKE ALL ON FUNCTION public.expire_stale_ticket_orders(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_stale_ticket_orders(integer) FROM anon;
REVOKE ALL ON FUNCTION public.expire_stale_ticket_orders(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_ticket_orders(integer) TO service_role;
