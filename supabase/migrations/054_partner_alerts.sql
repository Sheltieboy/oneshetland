-- ─────────────────────────────────────────────────────────────────────────────
-- 054 · Partner Alert System
--
-- Businesses can request the ability to send urgent in-app alerts.
-- Darren (platform owner) approves each request manually.
-- Once approved the business pays £10/month (Stripe) and gains access.
-- Active alerts surface across the whole app in real-time.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Add platform-owner flag to profiles (must exist before RLS policies) ──
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_platform_owner boolean NOT NULL DEFAULT false;

-- ── 2. Alert access per business ────────────────────────────────────────────
CREATE TABLE business_alert_access (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES local_businesses(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'requested'
                    CHECK (status IN ('requested','approved','active','rejected','suspended')),
  requested_at    timestamptz NOT NULL DEFAULT now(),
  reviewed_at     timestamptz,
  reviewed_by     uuid REFERENCES auth.users(id),
  reviewer_notes  text,
  -- Stripe subscription for the £10/month add-on
  stripe_subscription_id text,
  activated_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id)
);

ALTER TABLE business_alert_access ENABLE ROW LEVEL SECURITY;

-- Business owners can read their own access record
CREATE POLICY "business_alert_access_owner_read"
  ON business_alert_access FOR SELECT
  USING (
    business_id IN (
      SELECT id FROM local_businesses WHERE owner_id = auth.uid()
    )
  );

-- Business owners can insert a request (once, enforced by UNIQUE)
CREATE POLICY "business_alert_access_owner_insert"
  ON business_alert_access FOR INSERT
  WITH CHECK (
    business_id IN (
      SELECT id FROM local_businesses WHERE owner_id = auth.uid()
    )
    AND status = 'requested'
  );

-- Platform admin can read all (checked via profiles.is_platform_owner)
CREATE POLICY "business_alert_access_admin_all"
  ON business_alert_access FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_owner = true
    )
  );

-- ── 3. Active alerts ─────────────────────────────────────────────────────────
CREATE TABLE partner_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES local_businesses(id) ON DELETE CASCADE,
  business_name   text NOT NULL,           -- denormalised for fast display
  message         text NOT NULL,
  type            text NOT NULL DEFAULT 'info'
                    CHECK (type IN ('emergency','disruption','info')),
  is_active       boolean NOT NULL DEFAULT true,
  starts_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,             -- null = manual cancel only
  created_by      uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE partner_alerts ENABLE ROW LEVEL SECURITY;

-- Everyone can read active, non-expired alerts (shown in the app)
CREATE POLICY "partner_alerts_public_read"
  ON partner_alerts FOR SELECT
  USING (
    is_active = true
    AND (expires_at IS NULL OR expires_at > now())
  );

-- Business owners can insert/update their own alerts (must have active access)
CREATE POLICY "partner_alerts_owner_write"
  ON partner_alerts FOR INSERT
  WITH CHECK (
    business_id IN (
      SELECT id FROM local_businesses WHERE owner_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1 FROM business_alert_access
      WHERE business_id = partner_alerts.business_id
      AND status = 'active'
    )
  );

CREATE POLICY "partner_alerts_owner_update"
  ON partner_alerts FOR UPDATE
  USING (
    business_id IN (
      SELECT id FROM local_businesses WHERE owner_id = auth.uid()
    )
  );

-- Platform admin can do anything
CREATE POLICY "partner_alerts_admin_all"
  ON partner_alerts FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM profiles WHERE id = auth.uid() AND is_platform_owner = true
    )
  );

-- ── 4. Enable Realtime on partner_alerts ─────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE partner_alerts;

-- ── 5. Helper index ───────────────────────────────────────────────────────────
CREATE INDEX partner_alerts_active_idx
  ON partner_alerts (is_active, expires_at)
  WHERE is_active = true;
