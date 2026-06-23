-- OneShetland Delivers — Initial Schema
-- Run this in your Supabase project: SQL Editor → New query → paste → Run.

-- ─────────────────────────────────────────────
-- ENUMS (stored as TEXT with CHECK constraints for flexibility)
-- ─────────────────────────────────────────────

-- ─────────────────────────────────────────────
-- PROFILES
-- One row per auth.users entry. Created automatically by trigger below.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'customer'
                CHECK (role IN ('customer', 'driver', 'admin')),
  full_name   TEXT,
  phone       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update their own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- Admins can read all profiles
CREATE POLICY "Admins can read all profiles"
  ON public.profiles FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

-- Trigger: create profile row when a new user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, role, full_name)
  VALUES (
    NEW.id,
    'customer',
    COALESCE(NEW.raw_user_meta_data->>'full_name', '')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ─────────────────────────────────────────────
-- DRIVER PROFILES
-- Extended data for users with role = 'driver'.
-- Created when a driver submits an application.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.driver_profiles (
  id             UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  driver_status  TEXT NOT NULL DEFAULT 'not_applied'
                   CHECK (driver_status IN ('not_applied', 'pending', 'approved', 'rejected', 'suspended')),
  vehicle_type   TEXT,
  vehicle_reg    TEXT,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.driver_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Drivers can read their own driver profile"
  ON public.driver_profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Drivers can update their own driver profile"
  ON public.driver_profiles FOR UPDATE
  USING (auth.uid() = id);

-- Admins can read and update all driver profiles (for approvals)
CREATE POLICY "Admins can read all driver profiles"
  ON public.driver_profiles FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

CREATE POLICY "Admins can update all driver profiles"
  ON public.driver_profiles FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- ─────────────────────────────────────────────
-- REGIONS
-- Shetland delivery regions. Seeded via seed.sql.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.regions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.regions ENABLE ROW LEVEL SECURITY;

-- Regions are publicly readable (customers and visitors need them for forms)
CREATE POLICY "Regions are publicly readable"
  ON public.regions FOR SELECT
  USING (true);

CREATE POLICY "Admins can manage regions"
  ON public.regions FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- ─────────────────────────────────────────────
-- DELIVERY CATEGORIES
-- Seeded via seed.sql.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.delivery_categories (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  icon       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.delivery_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Delivery categories are publicly readable"
  ON public.delivery_categories FOR SELECT
  USING (true);

CREATE POLICY "Admins can manage delivery categories"
  ON public.delivery_categories FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- ─────────────────────────────────────────────
-- RUNS
-- Created by approved drivers. Publicly visible when status = 'open'.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.runs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id             UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  origin_region_id      UUID REFERENCES public.regions(id),
  destination_region_id UUID REFERENCES public.regions(id),
  destination_area      TEXT,
  departure_start       TIMESTAMPTZ NOT NULL,
  departure_end         TIMESTAMPTZ NOT NULL,
  categories_accepted   TEXT[] NOT NULL DEFAULT '{}',
  ferry_crossing        BOOLEAN NOT NULL DEFAULT FALSE,
  notes                 TEXT,
  status                TEXT NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'full', 'completed', 'cancelled')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.runs ENABLE ROW LEVEL SECURITY;

-- Anyone (including anonymous) can view open runs on the public landing page
CREATE POLICY "Open runs are publicly readable"
  ON public.runs FOR SELECT
  USING (status = 'open');

-- Drivers can read their own runs regardless of status
CREATE POLICY "Drivers can read their own runs"
  ON public.runs FOR SELECT
  USING (auth.uid() = driver_id);

-- Only approved drivers may insert runs
-- TODO: Tighten this to check driver_profiles.driver_status = 'approved'
CREATE POLICY "Approved drivers can create runs"
  ON public.runs FOR INSERT
  WITH CHECK (
    auth.uid() = driver_id
    AND EXISTS (
      SELECT 1 FROM public.driver_profiles dp
      WHERE dp.id = auth.uid() AND dp.driver_status = 'approved'
    )
  );

-- Drivers can update their own runs
CREATE POLICY "Drivers can update their own runs"
  ON public.runs FOR UPDATE
  USING (auth.uid() = driver_id);

-- Admins can do anything
CREATE POLICY "Admins can manage all runs"
  ON public.runs FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- ─────────────────────────────────────────────
-- DELIVERY REQUESTS
-- Created by customers. Matched to a run by the matching engine (future).
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.delivery_requests (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id           UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  run_id                UUID REFERENCES public.runs(id),
  category_slug         TEXT,
  pickup_name           TEXT NOT NULL,
  pickup_location       TEXT NOT NULL,
  pickup_notes          TEXT,
  already_paid          BOOLEAN NOT NULL DEFAULT FALSE,
  ready_for_collection  BOOLEAN NOT NULL DEFAULT FALSE,
  destination_region_id UUID REFERENCES public.regions(id),
  destination_area      TEXT,
  destination_address   TEXT NOT NULL,
  delivery_notes        TEXT,
  liability_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'matched', 'collected', 'delivered', 'cancelled')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.delivery_requests ENABLE ROW LEVEL SECURITY;

-- Customers can read and create their own requests
CREATE POLICY "Customers can read their own requests"
  ON public.delivery_requests FOR SELECT
  USING (auth.uid() = customer_id);

CREATE POLICY "Authenticated users can create requests"
  ON public.delivery_requests FOR INSERT
  WITH CHECK (auth.uid() = customer_id);

-- Drivers can read requests matched to their runs
-- TODO: Expand once run matching logic is built
CREATE POLICY "Drivers can read requests on their runs"
  ON public.delivery_requests FOR SELECT
  USING (
    run_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.runs r
      WHERE r.id = delivery_requests.run_id AND r.driver_id = auth.uid()
    )
  );

-- Admins can manage everything
CREATE POLICY "Admins can manage all requests"
  ON public.delivery_requests FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- ─────────────────────────────────────────────
-- UPDATED_AT helper trigger
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER driver_profiles_updated_at
  BEFORE UPDATE ON public.driver_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER runs_updated_at
  BEFORE UPDATE ON public.runs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER delivery_requests_updated_at
  BEFORE UPDATE ON public.delivery_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────
-- FUTURE TABLES (placeholders — not yet implemented)
-- ─────────────────────────────────────────────
-- payments        — Stripe payment intents, driver payouts
-- notifications   — push notification log
-- disputes        — customer/driver issue reports
-- saved_addresses — customer saved delivery addresses
-- ─────────────────────────────────────────────
