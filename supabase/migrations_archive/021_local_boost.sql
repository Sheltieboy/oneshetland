-- ── OneShetland Local — Boost ────────────────────────────────────────────────
-- Lets a business pay for a short, one-off block of Pro features (1, 2 or 3
-- weeks) without committing to a monthly subscription. Perfect for pop-ups,
-- Christmas markets, seasonal businesses, or "try before you buy" trials.
--
-- Model:
--   • One-time Stripe PaymentIntent (NOT a subscription)
--   • On payment success → set subscription_tier='pro' + subscription_until=now+N weeks
--   • stripe_subscription_id stays NULL → that's how we tell a boost apart
--     from a monthly subscription
--   • Subsequent boosts EXTEND subscription_until (stacking is OK)

-- ── Purchase log ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.local_boost_purchases (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id              UUID NOT NULL REFERENCES public.local_businesses(id) ON DELETE CASCADE,
  owner_id                 UUID NOT NULL REFERENCES public.profiles(id),
  weeks                    INT  NOT NULL CHECK (weeks BETWEEN 1 AND 4),
  amount_pence             INT  NOT NULL,
  stripe_payment_intent_id TEXT UNIQUE,
  status                   TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded')),
  expires_at               TIMESTAMPTZ,        -- mirrors subscription_until when granted
  created_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_local_boost_purchases_business
  ON public.local_boost_purchases(business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_local_boost_purchases_payment_intent
  ON public.local_boost_purchases(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

ALTER TABLE public.local_boost_purchases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners see their own boost purchases"
  ON public.local_boost_purchases FOR SELECT
  USING (owner_id = auth.uid());

-- Writes happen via service-role edge functions only.

-- ── admin_config seeds ───────────────────────────────────────────────────────
-- Prices stored in PENCE so there's no floating-point ambiguity.
-- Admin can change them from the in-app config screen.
INSERT INTO public.admin_config (key, value, description, category) VALUES
  ('boost.price.1_week_pence',
   '700',
   'Boost: 1 week of Pro features (in pence — 700 = £7.00).',
   'stripe'),
  ('boost.price.2_week_pence',
   '1200',
   'Boost: 2 weeks of Pro features (in pence — 1200 = £12.00).',
   'stripe'),
  ('boost.price.3_week_pence',
   '1500',
   'Boost: 3 weeks of Pro features (in pence — 1500 = £15.00).',
   'stripe')
ON CONFLICT (key) DO NOTHING;
