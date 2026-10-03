-- Quiet hours were silently erasing notifications.
--
-- should_notify() answers false for two different reasons — the user MUTED the module, or the user is in
-- QUIET HOURS — and the push sender logs both as 'skipped_pref'. The inbox hides 'skipped_pref' (an
-- opt-out is "things you chose not to hear about"), and it shows 'skipped_quiet' (a push held back while
-- you slept is still "something that happened for you"). But nothing ever wrote 'skipped_quiet', so a
-- refund, a booking cancellation or a ticket confirmation that arrived at 23:00 for someone with quiet
-- hours was neither pushed nor recorded: gone.
--
-- This reclassifies at the door. A row arriving as 'skipped_pref' is relabelled 'skipped_quiet' when the
-- user's master switch is on and the module is on: should_notify has no other reason left to refuse, so
-- it can only have been quiet hours. A muted module or a master-off user stays 'skipped_pref' (hidden).
-- Done as a trigger so it takes effect for every sender at once — about forty edge functions bundle the
-- push sender and none of them needs redeploying. Module = the category's prefix (verified for every
-- sender: module and category prefix agree at all 73 call sites).

create or replace function public.notification_log_classify_skip()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
$$;

revoke execute on function public.notification_log_classify_skip() from public, anon, authenticated;

drop trigger if exists notification_log_classify_skip on public.notification_log;
create trigger notification_log_classify_skip
  before insert on public.notification_log
  for each row execute function public.notification_log_classify_skip();
