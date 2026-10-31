-- Rollback of 20261129030000_funeral_notices. DESTROYS every funeral submission, review record and change request. Export them first if any real ones exist.
begin;
drop function if exists public.funeral_record_delivery(uuid, uuid, text, text), public.funeral_dispatch_recipients(uuid, integer), public.funeral_claim_dispatch(uuid, uuid), public.funeral_dispatchable(uuid),
  public.funeral_notification_text(uuid), public.admin_funeral_resolve_change(uuid, text, text, jsonb), public.admin_funeral_change_requests(), public.admin_funeral_takedown(uuid, text),
  public.admin_funeral_review(uuid, text, text, text), public.admin_funeral_queue(text), public.request_funeral_notice_change(uuid, text, text, text), public.get_funeral_notice(uuid),
  public.get_funeral_notices(text[], integer, integer), public.withdraw_my_funeral_notice(uuid), public.update_my_funeral_submission(uuid, jsonb), public.my_funeral_submissions(),
  public.submit_funeral_notice(jsonb), public.admin_set_funeral_director(text, uuid, boolean), public.can_dispatch_funeral(uuid), public.funeral_staff();
drop table if exists public.funeral_change_requests, public.funeral_notices, public.funeral_director_members, public.funeral_directors;
drop function if exists public.tg_funeral_notices_validate();
delete from public.notice_deliveries where subject_type = 'funeral'; delete from public.notice_dispatches where subject_type = 'funeral';
commit;
