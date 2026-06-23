-- ── Service capacity + public bookings access ────────────────────────────────
-- Adds two things needed for proper booking UX:
--
-- 1. capacity on book_services — how many parallel bookings of this service
--    can run at the same time. 1 by default (current behaviour). A cafe with
--    5 tables would set its "Table for 2" service to capacity=5. A salon's
--    haircut service should match the number of stylists working.
--
-- 2. get_public_booking_load(business_id, from, to) — a SECURITY DEFINER
--    function returning only the non-PII slot fields. Lets the customer-facing
--    booking screen show which slots are partially or fully taken without
--    leaking customer names or notes. Without this the booking screen
--    sends an empty array for bookings, so a customer sees all slots as
--    open even when half of them are full — bad UX, and they only discover
--    the conflict server-side when they try to confirm.

-- ── 1. Capacity column ──────────────────────────────────────────────────────
ALTER TABLE public.book_services
  ADD COLUMN IF NOT EXISTS capacity INT NOT NULL DEFAULT 1
  CHECK (capacity BETWEEN 1 AND 999);

COMMENT ON COLUMN public.book_services.capacity IS
  'How many simultaneous bookings of this service the business can serve. '
  '1 = single-resource (one room/table/chair). >1 = multi-resource (e.g. 5 '
  'tables, 3 stylists). Slot is Full when count(overlapping bookings) >= capacity.';

-- ── 2. Public booking-load function ──────────────────────────────────────────
-- SECURITY DEFINER means the function runs as its owner (the migration role),
-- bypassing the row-level security on book_bookings. We only expose the four
-- non-PII fields and only for active bookings, so this is safe.
--
-- Call signature is friendly for PostgREST: it'll appear as an RPC.

CREATE OR REPLACE FUNCTION public.get_public_booking_load(
  p_business_id UUID,
  p_from        TIMESTAMPTZ DEFAULT NULL,
  p_to          TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE(
  id          UUID,
  service_id  UUID,
  starts_at   TIMESTAMPTZ,
  ends_at     TIMESTAMPTZ,
  status      TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT b.id, b.service_id, b.starts_at, b.ends_at, b.status
  FROM public.book_bookings b
  WHERE b.business_id = p_business_id
    AND b.status IN ('confirmed', 'pending_payment')
    AND (p_from IS NULL OR b.ends_at   >  p_from)
    AND (p_to   IS NULL OR b.starts_at <  p_to);
$$;

GRANT EXECUTE ON FUNCTION public.get_public_booking_load(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
  TO anon, authenticated;
