-- ============================================================================
-- Notifications spine (Jun 2026)
--
-- Foundation for app+web-wide notifications. This migration:
--   1. Expands the notification module set from 7 → 15 (every section now has
--      an honest toggle). New per-module columns on notification_preferences.
--   2. Rewrites should_notify() to cover all 15 modules AND to apply quiet
--      hours to unknown modules too (the old ELSE branch delivered unknown
--      modules while skipping quiet hours).
--   3. Adds a push_tokens child table so a user can receive on more than one
--      device (the single profiles.push_token column = one device only).
--   4. Adds notification_log.read_at + an unread index + mark-read / count
--      RPCs so the log can back an in-app notification inbox (it was
--      write-only before).
--   5. Adds idempotency "sent" flags for the time-based reminder runner
--      (booking + event reminders). The actual schedule (pg_cron → reminder
--      edge function) is wired as a deploy step — see DEPLOY-NOTIFICATIONS.md.
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- ── 1. New module preference columns ────────────────────────────────────────
-- Defaults: opted-in to everything EXCEPT cruise (a niche interest — opt-in).
ALTER TABLE public.notification_preferences
  ADD COLUMN IF NOT EXISTS jobs_enabled      boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS events_enabled    boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS cruise_enabled    boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS wallet_enabled    boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS hubs_enabled      boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS community_enabled boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS notices_enabled   boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS business_enabled  boolean DEFAULT true;

-- ── 2. should_notify: all 15 modules; quiet hours applied to every path ──────
CREATE OR REPLACE FUNCTION public.should_notify(p_user_id uuid, p_module text, p_urgent boolean DEFAULT false)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  prefs RECORD;
  now_local TIME;
  module_on BOOLEAN;
BEGIN
  -- No preferences row → treat as opted-in (defaults apply, no quiet hours).
  SELECT * INTO prefs
    FROM public.notification_preferences
   WHERE user_id = p_user_id;

  IF NOT FOUND THEN RETURN TRUE; END IF;

  -- Master kill-switch.
  IF NOT prefs.enabled THEN RETURN FALSE; END IF;

  -- Per-module switch. Unknown modules default ON (so a newly-shipped module
  -- isn't silently dropped before its column exists) but STILL pass through the
  -- quiet-hours check below.
  module_on := CASE p_module
    WHEN 'bookings'  THEN prefs.bookings_enabled
    WHEN 'shifts'    THEN prefs.shifts_enabled
    WHEN 'fetch'     THEN prefs.fetch_enabled
    WHEN 'loyalty'   THEN prefs.loyalty_enabled
    WHEN 'offers'    THEN prefs.offers_enabled
    WHEN 'spik'      THEN prefs.spik_enabled
    WHEN 'games'     THEN prefs.games_enabled
    WHEN 'jobs'      THEN prefs.jobs_enabled
    WHEN 'events'    THEN prefs.events_enabled
    WHEN 'cruise'    THEN prefs.cruise_enabled
    WHEN 'wallet'    THEN prefs.wallet_enabled
    WHEN 'hubs'      THEN prefs.hubs_enabled
    WHEN 'community' THEN prefs.community_enabled
    WHEN 'notices'   THEN prefs.notices_enabled
    WHEN 'business'  THEN prefs.business_enabled
    ELSE TRUE
  END;

  -- COALESCE: a NULL column (older row created before the column existed)
  -- counts as opted-in, matching the column defaults.
  IF NOT COALESCE(module_on, TRUE) THEN RETURN FALSE; END IF;

  -- Urgent sends bypass quiet hours (e.g. a safety notice, a job offer).
  IF p_urgent THEN RETURN TRUE; END IF;

  -- Quiet hours. Window wraps across midnight when start > end.
  IF prefs.quiet_hours_start IS NOT NULL AND prefs.quiet_hours_end IS NOT NULL THEN
    now_local := (NOW() AT TIME ZONE 'Europe/London')::TIME;
    IF prefs.quiet_hours_start <= prefs.quiet_hours_end THEN
      IF now_local >= prefs.quiet_hours_start AND now_local < prefs.quiet_hours_end THEN
        RETURN FALSE;
      END IF;
    ELSE
      IF now_local >= prefs.quiet_hours_start OR now_local < prefs.quiet_hours_end THEN
        RETURN FALSE;
      END IF;
    END IF;
  END IF;

  RETURN TRUE;
END;
$$;

-- ── 3. Multi-device push tokens ─────────────────────────────────────────────
-- profiles.push_token is kept for back-compat; this table lets a user receive
-- on several devices. The send helper reads every active token for a user.
CREATE TABLE IF NOT EXISTS public.push_tokens (
  id           uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  token        text NOT NULL UNIQUE,
  platform     text,
  device_name  text,
  last_seen_at timestamptz DEFAULT now(),
  created_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_tokens_user_id_idx ON public.push_tokens (user_id);

ALTER TABLE public.push_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their own push tokens" ON public.push_tokens;
CREATE POLICY "Users manage their own push tokens"
  ON public.push_tokens
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ── 4. notification_log → in-app inbox ──────────────────────────────────────
ALTER TABLE public.notification_log
  ADD COLUMN IF NOT EXISTS read_at timestamptz;

-- Feed + unread queries.
CREATE INDEX IF NOT EXISTS notification_log_user_created_idx
  ON public.notification_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notification_log_user_unread_idx
  ON public.notification_log (user_id) WHERE read_at IS NULL;

-- Mark a set of the caller's own notifications as read (NULL ids = mark all).
CREATE OR REPLACE FUNCTION public.mark_notifications_read(p_ids uuid[] DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.notification_log
     SET read_at = now()
   WHERE user_id = auth.uid()
     AND read_at IS NULL
     AND (p_ids IS NULL OR id = ANY(p_ids));
END;
$$;

-- Unread count for the badge. Only statuses a user could actually have seen
-- (delivered, or undeliverable-but-still-relevant) count — opt-outs/errors don't.
CREATE OR REPLACE FUNCTION public.unread_notification_count()
RETURNS integer
LANGUAGE sql SECURITY DEFINER
AS $$
  SELECT COUNT(*)::int
    FROM public.notification_log
   WHERE user_id = auth.uid()
     AND read_at IS NULL
     AND status IN ('sent', 'no_token', 'skipped_quiet');
$$;

-- ── 5. Reminder idempotency flags (time-based notifications) ─────────────────
-- The reminder runner stamps these so a given reminder fires at most once.
ALTER TABLE public.book_bookings
  ADD COLUMN IF NOT EXISTS reminder_24h_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_1h_sent_at  timestamptz;

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz;
