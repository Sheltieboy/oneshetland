-- ── admin_config ─────────────────────────────────────────────────────────────
-- Key/value config the app owner can edit from an in-app admin screen instead
-- of via the Supabase CLI / env vars. Only non-secret values belong here —
-- things like Stripe price IDs, default fees, feature flags. True secrets
-- (STRIPE_SECRET_KEY, SERVICE_ROLE_KEY) stay in env vars.
--
-- Keys follow a "module.subkey" convention:
--   stripe.price.local_pro
--   stripe.price.local_premium
--   fees.fetch.base_pence
--   limits.bookings.advance_days
--   ...

CREATE TABLE IF NOT EXISTS public.admin_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  description TEXT,             -- shown as the label in the admin UI
  category    TEXT NOT NULL,    -- groups rows in the UI ('stripe' / 'fees' / etc.)
  is_secret   BOOLEAN DEFAULT FALSE,  -- if true, UI masks the value as a password
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  UUID REFERENCES public.profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_admin_config_category
  ON public.admin_config(category);

ALTER TABLE public.admin_config ENABLE ROW LEVEL SECURITY;

-- Only admins can read or write
CREATE POLICY "Admins read config"
  ON public.admin_config FOR SELECT
  USING ((SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin');

CREATE POLICY "Admins manage config"
  ON public.admin_config FOR ALL
  USING ((SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin')
  WITH CHECK ((SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin');

-- Edge functions read via the service role which bypasses RLS — no
-- additional policy needed for them.

-- ── Trigger: keep updated_at fresh ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_config_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS admin_config_touch_updated_at ON public.admin_config;
CREATE TRIGGER admin_config_touch_updated_at
  BEFORE UPDATE ON public.admin_config
  FOR EACH ROW EXECUTE FUNCTION public.admin_config_touch_updated_at();

-- ── Seed: the two Stripe price IDs ───────────────────────────────────────────
-- Empty values; admin fills them in from the in-app config screen.
INSERT INTO public.admin_config (key, value, description, category) VALUES
  ('stripe.price.local_pro',
   '',
   'Stripe Price ID for Local Pro tier (£19.99/mo). Starts with "price_".',
   'stripe'),
  ('stripe.price.local_premium',
   '',
   'Stripe Price ID for Local Premium tier (£49.99/mo). Starts with "price_".',
   'stripe')
ON CONFLICT (key) DO NOTHING;
