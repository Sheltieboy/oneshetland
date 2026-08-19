-- ============================================================================
-- Nothing ever expired an abandoned ticket checkout.
--
-- expire_stale_ticket_orders has existed since 20260729020000 and works: it
-- finds pending orders older than the threshold, hands their reserved seats
-- back, voids the tickets and cancels the orders. Step 3B proved it correct and
-- idempotent, and proved it recognises the reservations the new atomic basket
-- creates.
--
-- It had simply never been scheduled. The live cron.job table carried five
-- active jobs — activate-scheduled-alerts, reminder-runner, social-composer,
-- social-publisher, sync-council-jobs — and none of them was this one. So a
-- buyer who opened checkout and walked away held those seats until somebody
-- noticed. On an event with a real capacity that is a sale that never happens.
--
-- (Worth recording, because the audit got it wrong in the other direction: the
-- original finding said no cron existed at all. It does. It is just absent from
-- version control, which is why this migration exists rather than a dashboard
-- click — the repository has to be able to recreate production behaviour.)
--
-- CADENCE. The function's own default threshold is 60 minutes, and that is the
-- business rule this migration is scheduling, not changing. Running hourly
-- would mean a seat could be held for up to two hours to enforce a one-hour
-- rule. Every five minutes keeps the real hold at 60–65 minutes, matches the
-- cadence reminder-runner already uses, and costs almost nothing: the function
-- returns 0 immediately when no order is stale, and event_ticket_orders is a
-- 24-row table today.
--
-- PRIVILEGE. pg_cron runs jobs as the role that created them — postgres, the
-- same as the other five. postgres already holds EXECUTE on the function
-- (proacl: postgres=X | service_role=X), so this needs no grant change and
-- Step 1B's model is untouched: PUBLIC, anon and authenticated stay denied.
--
-- Re-applying this migration, or someone having created the job by hand first,
-- must not leave two jobs racing each other. Unscheduling by name first makes
-- it idempotent either way.
-- ============================================================================

do $$
begin
  if exists (select 1 from cron.job where jobname = 'expire-stale-ticket-orders') then
    perform cron.unschedule('expire-stale-ticket-orders');
  end if;
end;
$$;

select cron.schedule(
  'expire-stale-ticket-orders',
  '*/5 * * * *',
  $job$select public.expire_stale_ticket_orders(60);$job$
);
