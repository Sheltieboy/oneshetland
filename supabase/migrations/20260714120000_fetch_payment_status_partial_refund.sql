-- Fetch payment fix: allow 'partially_refunded' as a delivery_requests.payment_status.
--
-- The refund-payment edge function writes payment_status='partially_refunded'
-- for a partial refund, but the original CHECK constraint only permitted
-- unpaid/authorised/captured/refunded/failed. A partial Fetch refund therefore
-- succeeded at Stripe but threw a constraint violation on the DB update, leaving
-- the app's record and Stripe silently out of sync.
--
-- Additive + idempotent: widen the allowed set to include 'partially_refunded'.

ALTER TABLE public.delivery_requests
  DROP CONSTRAINT IF EXISTS delivery_requests_payment_status_check;

ALTER TABLE public.delivery_requests
  ADD CONSTRAINT delivery_requests_payment_status_check
  CHECK (payment_status = ANY (ARRAY[
    'unpaid'::text,
    'authorised'::text,
    'captured'::text,
    'refunded'::text,
    'partially_refunded'::text,
    'failed'::text
  ]));
