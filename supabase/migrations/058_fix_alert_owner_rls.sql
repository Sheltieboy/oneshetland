-- ─────────────────────────────────────────────────────────────────────────────
-- 058 · Fix partner_alerts owner read policy
--
-- The public SELECT policy only shows is_active = true rows, which means:
--   1. Business owners can't see their own ended/cancelled alerts (history broken)
--   2. After cancelling an alert the homepage realtime refetch doesn't pick up
--      the change because the row disappears from the result set mid-flight
--
-- Fix: add a separate policy so business owners can always read ALL their own
-- alerts regardless of is_active / expires_at status.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE POLICY "partner_alerts_owner_read_all"
  ON partner_alerts FOR SELECT
  USING (
    business_id IN (
      SELECT id FROM local_businesses WHERE owner_id = auth.uid()
    )
  );
