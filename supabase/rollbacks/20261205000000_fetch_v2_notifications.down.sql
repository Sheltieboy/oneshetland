-- Rollback of 20261205000000_fetch_v2_notifications.sql (Fetch v2 Step 8: notifications).
-- Step 8 redefines no earlier object: this removes its triggers, functions, table and configuration, restoring the catalogue exactly.
-- Refuses while the outbox holds anything (it is the record of what members were told; inbox rows it wrote stay in notification_log).
begin;

do $$
begin
  if exists (select 1 from public.fetch_notifications) then
    raise exception 'refusing to roll back Fetch notifications: the outbox is not empty';
  end if;
end $$;

drop trigger if exists fetch_v2_notice_from_match on public.fetch_match_notifications;
drop trigger if exists fetch_v2_notice_from_event on public.fetch_request_events;
drop trigger if exists fetch_v2_notice_from_verification on public.driver_verification_events;
drop trigger if exists fetch_v2_notice_from_issue on public.fetch_issues;

drop function if exists
  public.fetch_v2_notification_diagnostics(uuid, uuid), public.fetch_v2_settle_notification(bigint, text, text),
  public.fetch_v2_claim_notifications(integer), public.fetch_v2_cfg_int(text, integer), public.fetch_v2_push_decision(uuid, boolean),
  public.tg_fetch_v2_notice_from_issue(), public.tg_fetch_v2_notice_from_verification(), public.tg_fetch_v2_notice_from_event(),
  public.tg_fetch_v2_notice_from_match(), public.fetch_v2_admin_ids(), public.fetch_v2_enqueue_notice(text, uuid, uuid, text, text, text, jsonb),
  public.fetch_v2_notice_route(text, uuid, uuid), public.fetch_v2_notice_copy(text, uuid, uuid, jsonb), public.fetch_v2_notice_meta(text);
drop table if exists public.fetch_notifications;
delete from public.admin_config where key in ('fetch.notify.opportunity_hourly_max', 'fetch.notify.opportunity_daily_max', 'fetch.notify.max_push_attempts');

commit;
