-- ============================================================================
-- Booking metering can stop without the scheduler noticing.
--
-- 20260821140000 made the scheduler itself observable: cron_job_health() says
-- whether a job fired, cron_transport_health() says whether its HTTP request
-- landed. Neither can see this particular failure.
--
-- meter-bookings is not a cron job. reminder-runner invokes it (index.ts:392),
-- and it does so like this:
--
--   try {
--     const { data: metered } = await svc.functions.invoke('meter-bookings', ...);
--     result.bookings_metered = metered?.units ?? 0;
--   } catch (e) { console.error('[reminder-runner] booking meter failed', e); }
--
-- The catch swallows it. If meter-bookings started failing every single time —
-- bad Stripe key, revoked price, changed API — reminder-runner would still
-- return 200 with bookings_metered: 0, pg_cron would still record success, and
-- cron_job_health() would still say healthy. "0 metered" is indistinguishable
-- from "nothing needed metering".
--
-- So the signal has to come from the data instead of the scheduler: if bookings
-- that SHOULD have been metered are sitting unmetered hours later, metering has
-- stopped, whatever the job history says.
--
-- WHAT COUNTS AS "SHOULD HAVE BEEN METERED"
--
-- Only Pro and Premium businesses. Premium bookings are stamped but not
-- charged, Pro bookings are reported to Stripe up to the monthly cap and the
-- remainder stamped as forgiven. Every other tier is never stamped at all, so
-- counting those would make this permanently and uselessly red.
--
-- The one genuinely unbillable case — a Pro business with no Stripe
-- subscription, whose bookings meter-bookings can only ever skip — is reported
-- SEPARATELY. Folding it into the alarm would guarantee a false positive that
-- nobody could clear; leaving it out entirely would hide a business taking
-- bookings that can never be invoiced.
--
-- THRESHOLD. reminder-runner runs every five minutes and meters on every pass,
-- so anything unmetered six hours later has survived roughly 72 attempts. That
-- is a stopped pipeline, not a slow one.
-- ============================================================================

create or replace function public.metering_backlog_health()
returns table (
  unmetered_billable        int,
  oldest_unmetered_hours    numeric,
  threshold_hours           int,
  unbillable_pro_bookings   int,
  healthy                   boolean,
  problem                   text
)
  language sql
  stable
  security definer
  set search_path = public
as $$
  with graded as (
    select b.created_at,
           lb.subscription_tier,
           lb.stripe_subscription_id,
           -- Pro without a subscription can never be reported to Stripe: that
           -- is a billing setup problem, not a stopped scheduler.
           (lb.subscription_tier = 'pro' and lb.stripe_subscription_id is null) as unbillable
      from public.book_bookings b
      join public.local_businesses lb on lb.id = b.business_id
     where b.metered_at is null
       and b.status <> 'cancelled'
       and lb.subscription_tier in ('pro', 'premium')
       and b.created_at < now() - interval '6 hours'
  )
  select
    count(*) filter (where not unbillable)::int,
    round(extract(epoch from (now() - min(created_at) filter (where not unbillable))) / 3600, 1),
    6,
    count(*) filter (where unbillable)::int,
    count(*) filter (where not unbillable) = 0,
    case
      when count(*) filter (where not unbillable) > 0
        then 'metering appears stopped: ' || count(*) filter (where not unbillable)
             || ' billable booking(s) unmetered for over 6h'
      when count(*) filter (where unbillable) > 0
        then 'ok, but ' || count(*) filter (where unbillable)
             || ' booking(s) belong to a Pro business with no Stripe subscription and can never be billed'
      else 'ok'
    end
  from graded;
$$;

comment on function public.metering_backlog_health() is
  'Whether booking metering is still running, judged from the data rather than the scheduler. reminder-runner swallows a meter-bookings failure in a catch and still returns 200, so cron.job_run_details cannot show this.';

do $$
begin
  execute 'revoke all on function public.metering_backlog_health() from public';
  execute 'revoke all on function public.metering_backlog_health() from anon';
  execute 'revoke all on function public.metering_backlog_health() from authenticated';
  execute 'grant execute on function public.metering_backlog_health() to service_role';
end $$;
