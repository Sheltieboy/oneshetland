-- ─────────────────────────────────────────────────────────────────────────────
-- 055 · Fix alert RLS policies
--
-- Migration 054 gated admin access via `is_platform_owner = true` but the app
-- uses `profile.role = 'admin'` for all admin gating. This migration replaces
-- the `is_platform_owner` check with the `role = 'admin'` check everywhere so
-- that Darren's admin account can read/manage alert access requests.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── business_alert_access ────────────────────────────────────────────────────

DROP POLICY IF EXISTS "business_alert_access_admin_all" ON business_alert_access;

CREATE POLICY "business_alert_access_admin_all"
  ON business_alert_access FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- ── Admin config slot for the alert add-on Stripe price ID ─────────────────
-- Admins fill this in via Admin → Config once the Stripe product is created.
INSERT INTO admin_config (key, value, description)
VALUES (
  'stripe.price.alert_addon',
  '',
  'Stripe Price ID for the £10/month Urgent Alerts add-on (e.g. price_xxx). Create it in Stripe Dashboard first.'
)
ON CONFLICT (key) DO NOTHING;

-- ── partner_alerts ───────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "partner_alerts_admin_all" ON partner_alerts;

CREATE POLICY "partner_alerts_admin_all"
  ON partner_alerts FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
    )
  );
