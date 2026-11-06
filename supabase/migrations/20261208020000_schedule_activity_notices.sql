-- Schedule the Regular Activities follower-alert job: every minute, as a SQL function under pg_cron (the same pattern as
-- 20260819240000_schedule_ticket_expiry.sql). The function claims only rows older than two minutes, takes a bounded batch, skips rows another
-- run holds, and isolates failures per activity, so a frequent schedule is safe and overlapping runs cannot double-send.
--
-- Re-applying this migration, or someone having created the job by hand first, must not leave two jobs racing: unschedule by name first.
-- Apply this ONLY AFTER 20261208000000 and 20261208010000. Until it is applied nothing is delivered (changes simply queue).
-- ROLLBACK: select cron.unschedule('process-activity-change-notices');
do $$
begin
  if exists (select 1 from cron.job where jobname = 'process-activity-change-notices') then
    perform cron.unschedule('process-activity-change-notices');
  end if;
end;
$$;

select cron.schedule(
  'process-activity-change-notices',
  '* * * * *',
  $job$select public.process_activity_change_notices(200);$job$
);
