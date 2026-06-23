-- Subscription tiers for local businesses
-- Gates which businesses can be featured on the homepage + which features they unlock.
--
-- Tiers:
--   free    — directory listing only (default)
--   pro     — adds loyalty programmes, offers, wallet payments
--   premium — adds homepage featuring + priority in directory
--
-- Billing is not yet wired (Stripe Subscriptions coming later).
-- For now, set tiers manually:
--   UPDATE local_businesses SET subscription_tier = 'premium',
--          subscription_until = NOW() + interval '30 days'
--    WHERE id = '...';

ALTER TABLE public.local_businesses
  ADD COLUMN IF NOT EXISTS subscription_tier  TEXT NOT NULL DEFAULT 'free'
    CHECK (subscription_tier IN ('free', 'pro', 'premium')),
  ADD COLUMN IF NOT EXISTS subscription_until TIMESTAMPTZ;

-- Fast lookup of premium businesses for the homepage feature
CREATE INDEX IF NOT EXISTS idx_local_businesses_premium
  ON public.local_businesses(subscription_tier, subscription_until)
  WHERE subscription_tier = 'premium' AND is_active = TRUE;
