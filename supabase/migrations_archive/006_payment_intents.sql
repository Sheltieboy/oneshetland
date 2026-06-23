-- Migration 006: Payment intent tracking on delivery_requests
-- Adds Stripe PaymentIntent fields so we can pre-authorise on match
-- and capture on delivery completion.

ALTER TABLE public.delivery_requests
  ADD COLUMN IF NOT EXISTS payment_intent_id  TEXT,         -- Stripe PaymentIntent ID (pi_...)
  ADD COLUMN IF NOT EXISTS base_fee_pence      INTEGER,      -- fee at time of booking
  ADD COLUMN IF NOT EXISTS waiting_fee_pence   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_fee_pence     INTEGER,      -- final captured amount
  ADD COLUMN IF NOT EXISTS payment_status      TEXT NOT NULL DEFAULT 'unpaid'
    CHECK (payment_status IN (
      'unpaid',        -- not yet pre-authorised
      'authorised',    -- card pre-authorised, not yet captured
      'captured',      -- payment taken
      'refunded',      -- refunded (cancelled delivery)
      'failed'         -- payment failed
    ));

-- Index for webhook lookups by payment_intent_id
CREATE INDEX IF NOT EXISTS delivery_requests_payment_intent_idx
  ON public.delivery_requests (payment_intent_id);

-- Note: run this in the Supabase SQL Editor for the nkrtmakxygkvxuxriiil project
