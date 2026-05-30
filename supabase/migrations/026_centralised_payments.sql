-- ── 026_centralised_payments.sql ─────────────────────────────────────────────
--
-- Centralises payment + payout setup at the user level, with optional
-- per-business overrides.
--
-- USER LEVEL (profiles):
--   Every OneShetland user gets a single central payment card (stripe_customer_id
--   already exists) and a single central payout bank account (Stripe Connect).
--   The Connect fields move here from driver_profiles so any user — driver,
--   employer, business owner — can receive money without being a driver.
--
-- BUSINESS LEVEL (local_businesses):
--   Two optional overrides per business, both off by default:
--     use_business_payment  → use a business-specific card instead of the central one
--     use_business_payout   → use a business-specific bank account instead of the central one
--
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. User-level payout account (central bank) ───────────────────────────────
-- Stripe Connect fields on profiles so they're role-agnostic.
-- Backfill from driver_profiles so existing drivers lose nothing.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS stripe_account_id              TEXT,
  ADD COLUMN IF NOT EXISTS stripe_onboarding_complete     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stripe_payouts_enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stripe_charges_enabled         BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill existing driver Connect data into profiles
UPDATE public.profiles p
SET
  stripe_account_id          = dp.stripe_account_id,
  stripe_onboarding_complete = dp.stripe_onboarding_complete,
  stripe_payouts_enabled     = dp.stripe_payouts_enabled,
  stripe_charges_enabled     = dp.stripe_charges_enabled
FROM public.driver_profiles dp
WHERE dp.id = p.id
  AND dp.stripe_account_id IS NOT NULL;

-- ── 2. Business-level payment + payout overrides ──────────────────────────────

ALTER TABLE public.local_businesses
  -- Payment override (card on file)
  ADD COLUMN IF NOT EXISTS use_business_payment           BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS business_stripe_customer_id    TEXT,
  ADD COLUMN IF NOT EXISTS has_business_payment_method    BOOLEAN NOT NULL DEFAULT FALSE,
  -- Payout override (bank account / Stripe Connect)
  ADD COLUMN IF NOT EXISTS use_business_payout            BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS business_stripe_account_id     TEXT,
  ADD COLUMN IF NOT EXISTS business_stripe_onboarding_complete BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS business_stripe_payouts_enabled     BOOLEAN NOT NULL DEFAULT FALSE;

-- ── 3. Indexes ────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_profiles_stripe_account
  ON public.profiles(stripe_account_id)
  WHERE stripe_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_local_businesses_biz_stripe
  ON public.local_businesses(business_stripe_account_id)
  WHERE business_stripe_account_id IS NOT NULL;

-- ── 4. Grants ────────────────────────────────────────────────────────────────
-- profiles already has grants from 025; new columns are covered automatically.
-- local_businesses already has grants too.
-- No extra grant statements needed.

-- ── NOTE ─────────────────────────────────────────────────────────────────────
-- driver_profiles keeps its stripe_* columns for backward compatibility with
-- the existing driver Connect flow. The connect-bank screen now writes to BOTH
-- profiles (source of truth) and driver_profiles (so driver dashboards keep
-- working during the transition). A future cleanup migration can remove the
-- duplicate columns from driver_profiles once all screens read from profiles.
