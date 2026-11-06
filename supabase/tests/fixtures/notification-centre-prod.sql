-- Production's Notification Centre pieces, as deployed (read 6 Nov 2026), for the isolated tests. Nothing here is applied anywhere.

CREATE OR REPLACE FUNCTION public.should_notify(p_user_id uuid, p_module text, p_urgent boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.notification_log_classify_skip()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  prefs record;
  module_on boolean;
begin
  if new.status is distinct from 'skipped_pref' then return new; end if;

  select * into prefs from public.notification_preferences where user_id = new.user_id;
  if not found or not prefs.enabled then return new;   -- master switch off: a genuine opt-out
  end if;

  module_on := case split_part(new.category, '.', 1)
    when 'bookings'  then prefs.bookings_enabled
    when 'shifts'    then prefs.shifts_enabled
    when 'fetch'     then prefs.fetch_enabled
    when 'loyalty'   then prefs.loyalty_enabled
    when 'offers'    then prefs.offers_enabled
    when 'spik'      then prefs.spik_enabled
    when 'games'     then prefs.games_enabled
    when 'jobs'      then prefs.jobs_enabled
    when 'events'    then prefs.events_enabled
    when 'cruise'    then prefs.cruise_enabled
    when 'wallet'    then prefs.wallet_enabled
    when 'hubs'      then prefs.hubs_enabled
    when 'community' then prefs.community_enabled
    when 'notices'   then prefs.notices_enabled
    when 'business'  then prefs.business_enabled
    else true
  end;
  if not coalesce(module_on, true) then return new;    -- muted module: a genuine opt-out
  end if;

  new.status := 'skipped_quiet';                        -- the only reason left is quiet hours
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.unread_notification_count()
 RETURNS integer
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COUNT(*)::int
    FROM public.notification_log
   WHERE user_id = auth.uid()
     AND read_at IS NULL
     AND status IN ('sent', 'no_token', 'skipped_quiet');
$function$;

CREATE OR REPLACE FUNCTION public.mark_notifications_read(p_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.notification_log
     SET read_at = now()
   WHERE user_id = auth.uid()
     AND read_at IS NULL
     AND (p_ids IS NULL OR id = ANY(p_ids));
END;
$function$;

-- notification_preferences columns in production: user_id, enabled, bookings_enabled, shifts_enabled, fetch_enabled, loyalty_enabled, offers_enabled, spik_enabled, games_enabled, quiet_hours_start, quiet_hours_end, updated_at, jobs_enabled, events_enabled, cruise_enabled, wallet_enabled, hubs_enabled, community_enabled, notices_enabled, business_enabled
