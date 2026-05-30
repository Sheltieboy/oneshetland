-- ── Notifications foundation ─────────────────────────────────────────────────
-- 1. notification_preferences — per-user, per-module mute toggles + quiet hours.
-- 2. notification_log         — a record of every push attempt for debug + audit.
--
-- These tables sit underneath ALL future per-module senders. Every sender
-- should:
--   a) read notification_preferences to check the user opted-in for that module
--   b) respect quiet hours (unless the notification is flagged "urgent")
--   c) write the attempt to notification_log
--
-- Categories are namespaced "module.event" — e.g.:
--   bookings.new          bookings.reminder      bookings.cancelled
--   shifts.new_match      shifts.application_update
--   fetch.new_request     fetch.status_update
--   spik.daily_wird       loyalty.stamp           loyalty.reward

-- ── 1. Preferences ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.notification_preferences (
  user_id            UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,

  -- Master kill-switch
  enabled            BOOLEAN DEFAULT TRUE,

  -- Per-module toggles. Default ON for every module — users mute what they
  -- don't want. Urgent notifications (e.g. booking starting in 10 min) bypass
  -- module mute by design.
  bookings_enabled   BOOLEAN DEFAULT TRUE,
  shifts_enabled     BOOLEAN DEFAULT TRUE,
  fetch_enabled      BOOLEAN DEFAULT TRUE,
  loyalty_enabled    BOOLEAN DEFAULT TRUE,
  offers_enabled     BOOLEAN DEFAULT TRUE,
  spik_enabled       BOOLEAN DEFAULT TRUE,
  games_enabled      BOOLEAN DEFAULT TRUE,

  -- Quiet hours window. NULLs mean no quiet hours configured.
  -- Stored as local-time TIMEs; the device's timezone is applied client-side.
  -- Urgent notifications still fire during quiet hours.
  quiet_hours_start  TIME,
  quiet_hours_end    TIME,

  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see their own notification preferences"
  ON public.notification_preferences FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users manage their own notification preferences"
  ON public.notification_preferences FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ── 2. Log ───────────────────────────────────────────────────────────────────
-- Every sender writes one row per attempt. Lets us debug deliverability,
-- show "recent notifications" in-app later, and audit message volume per user.

CREATE TABLE IF NOT EXISTS public.notification_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  category    TEXT NOT NULL,             -- "module.event" e.g. "bookings.new"
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  data        JSONB,                     -- deep-link payload
  status      TEXT NOT NULL CHECK (status IN ('sent', 'skipped_pref', 'skipped_quiet', 'no_token', 'error')),
  error       TEXT,                      -- only populated when status = 'error'
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_log_user_recent
  ON public.notification_log(user_id, created_at DESC);

ALTER TABLE public.notification_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see their own notification log"
  ON public.notification_log FOR SELECT
  USING (user_id = auth.uid());

-- Writes happen via service-role edge functions, no INSERT policy for users.

-- ── 3. Helper view: current_should_notify ────────────────────────────────────
-- Convenience for senders: returns TRUE if the user should receive a push
-- for the given module right now (respects master switch, module toggle, and
-- quiet hours). Always returns TRUE for "urgent" sends — caller decides.

CREATE OR REPLACE FUNCTION public.should_notify(
  p_user_id  UUID,
  p_module   TEXT,                -- 'bookings' | 'shifts' | 'fetch' | 'loyalty' | 'offers' | 'spik' | 'games'
  p_urgent   BOOLEAN DEFAULT FALSE
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  prefs RECORD;
  now_local TIME;
BEGIN
  -- If user has no preferences row, treat as opted-in (defaults apply)
  SELECT * INTO prefs
    FROM public.notification_preferences
   WHERE user_id = p_user_id;

  IF NOT FOUND THEN RETURN TRUE; END IF;

  -- Master kill-switch
  IF NOT prefs.enabled THEN RETURN FALSE; END IF;

  -- Per-module
  CASE p_module
    WHEN 'bookings' THEN IF NOT prefs.bookings_enabled THEN RETURN FALSE; END IF;
    WHEN 'shifts'   THEN IF NOT prefs.shifts_enabled   THEN RETURN FALSE; END IF;
    WHEN 'fetch'    THEN IF NOT prefs.fetch_enabled    THEN RETURN FALSE; END IF;
    WHEN 'loyalty'  THEN IF NOT prefs.loyalty_enabled  THEN RETURN FALSE; END IF;
    WHEN 'offers'   THEN IF NOT prefs.offers_enabled   THEN RETURN FALSE; END IF;
    WHEN 'spik'     THEN IF NOT prefs.spik_enabled     THEN RETURN FALSE; END IF;
    WHEN 'games'    THEN IF NOT prefs.games_enabled    THEN RETURN FALSE; END IF;
    ELSE RETURN TRUE; -- unknown module, default allow
  END CASE;

  -- Urgent sends bypass quiet hours
  IF p_urgent THEN RETURN TRUE; END IF;

  -- Quiet hours check. Window wraps across midnight if start > end.
  IF prefs.quiet_hours_start IS NOT NULL AND prefs.quiet_hours_end IS NOT NULL THEN
    now_local := (NOW() AT TIME ZONE 'Europe/London')::TIME;
    IF prefs.quiet_hours_start <= prefs.quiet_hours_end THEN
      IF now_local >= prefs.quiet_hours_start AND now_local < prefs.quiet_hours_end THEN
        RETURN FALSE;
      END IF;
    ELSE
      -- wraps midnight: e.g. 22:00 → 07:00
      IF now_local >= prefs.quiet_hours_start OR now_local < prefs.quiet_hours_end THEN
        RETURN FALSE;
      END IF;
    END IF;
  END IF;

  RETURN TRUE;
END;
$$;
