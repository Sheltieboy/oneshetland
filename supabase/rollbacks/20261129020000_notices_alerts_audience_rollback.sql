-- Rollback of 20261129020000_notices_alerts_audience. Destroys member area choices, notice notification opt-ins and dispatch/delivery history. The edge functions
-- notify-notice-audience / notify-funeral-notice / the R2 branch of notify-hub-content call these functions: roll those back FIRST (redeploy the previous bundles).
begin;
drop function if exists public.admin_notice_dispatch_history(uuid), public.notice_fail_dispatch(uuid, text), public.notice_complete_dispatch(uuid), public.notice_record_delivery(uuid, uuid, text, text, text),
  public.notice_dispatch_recipients(uuid, text, integer), public.notice_claim_dispatch(uuid, text, uuid), public.can_dispatch_notice(uuid, uuid, text), public.notice_dispatchable(uuid, text),
  public.my_notice_prefs(), public.set_my_notice_prefs(boolean, boolean, boolean, text[], boolean, boolean), public.my_notice_areas(), public.set_my_notice_areas(text[]);
drop table if exists public.notice_deliveries, public.notice_dispatches, public.notice_notification_prefs, public.member_areas;
drop function if exists public.tg_notice_deliveries_silence_imports();
commit;
