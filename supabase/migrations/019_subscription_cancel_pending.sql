-- ── Subscription cancel-pending flag ────────────────────────────────────────
-- When a business cancels their subscription via Stripe Customer Portal,
-- Stripe sets cancel_at_period_end = true on the subscription but keeps
-- status = 'active' until the current period ends. We mirror that flag
-- locally so the UI can show "Cancels on [date]" without re-querying Stripe.

ALTER TABLE public.local_businesses
  ADD COLUMN IF NOT EXISTS subscription_cancel_at_period_end BOOLEAN DEFAULT FALSE;
