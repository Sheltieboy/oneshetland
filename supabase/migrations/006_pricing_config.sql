-- ─────────────────────────────────────────────────────────────────────────────
-- 006_pricing_config.sql
--
-- Replaces per-category flat fees with distance-based pricing.
-- A single config row controls price-per-mile, minimum fee, and road correction.
-- Admins update this row; the calculate-fee Edge Function reads it.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.delivery_pricing_config (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  price_per_mile_pence    INTEGER NOT NULL DEFAULT 95,   -- 95p per mile
  min_fee_pence           INTEGER NOT NULL DEFAULT 400,  -- £4.00 minimum
  road_correction_factor  NUMERIC(4,2) NOT NULL DEFAULT 1.40, -- straight-line × 1.4 ≈ road distance
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.delivery_pricing_config ENABLE ROW LEVEL SECURITY;

-- Anyone can read pricing (customers need to see fees)
CREATE POLICY "Pricing config is publicly readable"
  ON public.delivery_pricing_config FOR SELECT
  USING (TRUE);

-- Only admins can update
CREATE POLICY "Admins can manage pricing config"
  ON public.delivery_pricing_config FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- Seed the single config row
INSERT INTO public.delivery_pricing_config (price_per_mile_pence, min_fee_pence, road_correction_factor)
VALUES (95, 400, 1.40)
ON CONFLICT DO NOTHING;
