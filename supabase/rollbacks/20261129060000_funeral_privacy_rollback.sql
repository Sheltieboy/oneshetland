-- Rollback of 20261129060000_funeral_privacy. Drops the cleanup / retention / enquiry / redaction functions and the redaction ledger and settings tables.
-- It does NOT restore anything that account-deletion cleanup already removed (that data is gone by design). Audit text already redacted stays redacted.
begin;
drop trigger if exists funeral_notices_retention on public.funeral_notices;
drop function if exists public.admin_audit_redactions(integer), public.admin_redact_audit_text(bigint, text[], text), public.admin_audit_redaction_candidates(integer),
  public.admin_log_funeral_enquiry(uuid, text, text, text, text, text), public.submit_funeral_enquiry(uuid, text, text, text, text, text),
  public.admin_set_funeral_retention_hold(uuid, boolean, text), public.funeral_retention_run(boolean), public.admin_funeral_retention_report(), public.funeral_retention_candidates(),
  public.delete_member_memberships(uuid), public.delete_member_funeral_data(uuid), public.admin_set_funeral_retention_enabled(boolean, text), public.tg_funeral_retention();
drop table if exists public.notice_audit_redactions, public.notice_privacy_settings;
commit;
