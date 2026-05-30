-- Stripe Subscription wiring for local businesses.
-- The actual tier values live on local_businesses (added in migration 012);
-- these columns store the Stripe IDs needed to manage the subscription lifecycle.

ALTER TABLE public.local_businesses
  ADD COLUMN IF NOT EXISTS stripe_customer_id     TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;

CREATE INDEX IF NOT EXISTS idx_local_businesses_stripe_sub
  ON public.local_businesses(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;
