-- Rollback of 20261224000000_fetch_v2_admin_controls.sql (Fetch v2 Step 10: admin controls).
-- Step 10 redefines no earlier object: this removes its functions, tables and the restricted_by column, restoring the catalogue exactly.
-- Refuses while any redaction or restriction history exists (it is the audit record), or any description_redacted event.
begin;

do $$
begin
  if exists (select 1 from public.fetch_request_redactions) or exists (select 1 from public.fetch_member_restriction_log)
     or exists (select 1 from public.fetch_member_stats where restricted_by is not null)
     or exists (select 1 from public.fetch_request_events where event = 'description_redacted') then
    raise exception 'refusing to roll back Fetch admin controls: administrator history exists';
  end if;
end $$;

drop function if exists
  public.fetch_v2_admin_member(uuid), public.fetch_v2_admin_job(uuid), public.fetch_v2_admin_jobs(jsonb), public.fetch_v2_admin_queues(),
  public.fetch_v2_admin_name(uuid), public.fetch_v2_q_verification_jobs(), public.fetch_v2_q_returns(), public.fetch_v2_q_cancellations(),
  public.fetch_v2_q_payments(), public.fetch_v2_set_member_restriction(uuid, uuid, boolean, text), public.fetch_v2_redact_description(uuid, uuid, text, text);
drop table if exists public.fetch_member_restriction_log;
drop table if exists public.fetch_request_redactions;
drop function if exists public.tg_fetch_admin_history_append_only();
alter table public.fetch_member_stats drop column if exists restricted_by;

commit;
