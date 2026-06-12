-- ─────────────────────────────────────────────────────────────────────────────
-- 057 · Scheduled partner alerts
--
-- Allows businesses to schedule an alert for a future date/time.
-- Scheduled alerts are stored with is_active = false and a starts_at in the future.
-- A pg_cron job runs every minute and activates any alerts whose starts_at has passed.
-- ─────────────────────────────────────────────────────────────────────────────

-- Enable pg_cron extension (safe to run if already enabled)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Schedule the activation job: every minute, flip pending scheduled alerts to active
SELECT cron.schedule(
  'activate-scheduled-alerts',   -- job name (unique)
  '* * * * *',                   -- every minute
  $$
    UPDATE partner_alerts
    SET is_active = true
    WHERE is_active = false
      AND starts_at IS NOT NULL
      AND starts_at <= now()
      AND (expires_at IS NULL OR expires_at > now());
  $$
);
