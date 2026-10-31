-- should-notify-fixture.sql — TEST SUPPORT ONLY (isolated / acceptance databases). Gives the local notification_preferences table the production columns and installs
-- the production should_notify() EXACTLY as defined in supabase/migrations/20260627000000_notifications_spine.sql (copied verbatim by a script), so quiet hours,
-- the master switch and module switches are exercised by the REAL function. The service-only grant mirrors 20261031000000_should_notify_service_only.sql.
alter table notification_preferences
  add column if not exists bookings_enabled boolean default true,
  add column if not exists business_enabled boolean default true,
  add column if not exists community_enabled boolean default true,
  add column if not exists events_enabled boolean default true,
  add column if not exists fetch_enabled boolean default true,
  add column if not exists games_enabled boolean default true,
  add column if not exists hubs_enabled boolean default true,
  add column if not exists jobs_enabled boolean default true,
  add column if not exists loyalty_enabled boolean default true,
  add column if not exists notices_enabled boolean default true,
  add column if not exists offers_enabled boolean default true,
  add column if not exists shifts_enabled boolean default true,
  add column if not exists spik_enabled boolean default true,
  add column if not exists wallet_enabled boolean default true,
  add column if not exists cruise_enabled boolean default false,
  add column if not exists quiet_hours_start time,
  add column if not exists quiet_hours_end time,
  add column if not exists enabled boolean default true;
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
revoke execute on function public.should_notify(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.should_notify(uuid, text, boolean) to service_role;
