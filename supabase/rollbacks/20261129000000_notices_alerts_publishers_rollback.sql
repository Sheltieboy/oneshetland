-- Rollback of 20261129000000_notices_alerts_publishers. Destroys organisations, members, entitlement grants and the AUDIT LOG. Roll back 20261129010000+ first.
-- Export notice_audit_log before running this if any real entitlement was ever granted: it is the only record of who granted what.
begin;
drop function if exists public.official_publisher_authority(uuid), public.my_official_publishers(), public.admin_notice_audit(integer, timestamptz), public.admin_list_official_publisher_members(uuid),
  public.admin_list_official_publishers(), public.admin_grant_essential_alert(uuid, text), public.admin_set_official_publisher_member(uuid, uuid, text, boolean),
  public.admin_set_official_publisher_active(uuid, boolean), public.admin_verify_official_publisher(uuid, text), public.admin_upsert_official_publisher(text, text, text, text, text),
  public.notice_audit(text, uuid, uuid, uuid, jsonb), public.notices_admin();
drop trigger if exists notice_audit_log_no_truncate on public.notice_audit_log; drop trigger if exists notice_audit_log_immutable on public.notice_audit_log;
drop table if exists public.notice_audit_log, public.essential_alert_grants, public.official_publisher_members, public.official_publishers;
drop function if exists public.tg_notice_audit_immutable();
drop function if exists public.notices_staff(), public.active_uid(), public.account_is_closed(uuid);   -- (their dependants were dropped above; later migrations' rollbacks run first)
commit;
