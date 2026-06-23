-- Migration 005: Driver Stripe Connect onboarding + delivery pricing
-- Adds Stripe Connect fields to driver_profiles and a delivery_fees table
-- for platform-set rates per category.

-- ─────────────────────────────────────────────
-- DRIVER STRIPE CONNECT
-- ─────────────────────────────────────────────
ALTER TABLE driver_profiles
  ADD COLUMN IF NOT EXISTS stripe_account_id        TEXT,        -- Stripe Connect account ID (acct_...)
  ADD COLUMN IF NOT EXISTS stripe_onboarding_complete BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stripe_payouts_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stripe_charges_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS dispute_count            INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS flagged_for_review       BOOLEAN NOT NULL DEFAULT FALSE;

-- ─────────────────────────────────────────────
-- DELIVERY FEES
-- Platform-set base fees per category + waiting fee config.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.delivery_fees (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_slug         TEXT NOT NULL UNIQUE REFERENCES public.delivery_categories(slug) ON DELETE CASCADE,
  base_fee_pence        INTEGER NOT NULL,          -- base fee in pence (e.g. 500 = £5.00)
  waiting_grace_mins    INTEGER NOT NULL DEFAULT 5, -- grace period before waiting fee kicks in
  waiting_fee_pence     INTEGER NOT NULL DEFAULT 150, -- fee per period (e.g. 150 = £1.50)
  waiting_period_mins   INTEGER NOT NULL DEFAULT 5,   -- period length in minutes
  waiting_max_pence     INTEGER NOT NULL DEFAULT 600, -- cap (e.g. 600 = £6.00)
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.delivery_fees ENABLE ROW LEVEL SECURITY;

-- Anyone can read fees (customers need to see prices)
CREATE POLICY "Delivery fees are publicly readable"
  ON public.delivery_fees FOR SELECT
  USING (TRUE);

-- Only admins can manage fees
CREATE POLICY "Admins can manage delivery fees"
  ON public.delivery_fees FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

CREATE TRIGGER delivery_fees_updated_at
  BEFORE UPDATE ON public.delivery_fees
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────
-- SEED DEFAULT FEES
-- ─────────────────────────────────────────────
INSERT INTO public.delivery_fees (category_slug, base_fee_pence) VALUES
  ('takeaway',                  400),  -- £4.00
  ('pharmacy',                  500),  -- £5.00
  ('small-parcel',              500),  -- £5.00
  ('shop-collection',           500),  -- £5.00
  ('supermarket-click-collect', 600),  -- £6.00
  ('other',                     500)   -- £5.00
ON CONFLICT (category_slug) DO NOTHING;

-- ─────────────────────────────────────────────
-- WAITING FEE EVENTS
-- Records when a driver taps "I've arrived" and when collection actually happened.
-- Used to calculate waiting fees and detect abuse.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.waiting_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id          UUID NOT NULL REFERENCES public.delivery_requests(id) ON DELETE CASCADE,
  driver_id           UUID NOT NULL REFERENCES public.profiles(id),
  arrived_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  collected_at        TIMESTAMPTZ,
  waiting_fee_pence   INTEGER NOT NULL DEFAULT 0,   -- calculated fee (0 if within grace)
  customer_confirmed  BOOLEAN,                       -- NULL = pending, TRUE = confirmed, FALSE = disputed
  dispute_raised      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.waiting_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Drivers can insert their own waiting events"
  ON public.waiting_events FOR INSERT
  WITH CHECK (auth.uid() = driver_id);

CREATE POLICY "Drivers can update their own waiting events"
  ON public.waiting_events FOR UPDATE
  USING (auth.uid() = driver_id);

CREATE POLICY "Customers can view waiting events for their requests"
  ON public.waiting_events FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.delivery_requests dr
      WHERE dr.id = request_id AND dr.customer_id = auth.uid()
    )
  );

CREATE POLICY "Admins can manage all waiting events"
  ON public.waiting_events FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- Note: run this in the Supabase SQL Editor for the nkrtmakxygkvxuxriiil project
