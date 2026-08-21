-- Step 15 — the rate-limit purge joins the canonical scheduled-job inventory.
--
-- Step 15 added `purge-rate-limits` to cron.job. Step 10 made the rule that a
-- scheduled job is only real if it is version-controlled AND monitored: the
-- scheduled-jobs test refuses any job cron.job knows about that the canonical
-- list does not, and it caught this one immediately.
--
-- cron_job_health() carries its own hard-coded expectation list, so a job that
-- is merely scheduled is invisible to monitoring. This adds it there. Nothing
-- else about the function changes; the body below is the deployed definition
-- with one row added.
--
-- Tolerance 1560 minutes = 26 hours, matching the other daily purge: one
-- missed nightly run is not an alert, a stopped job is.

create or replace function public.cron_job_health()
 RETURNS TABLE(job_name text, active boolean, schedule text, tolerance_minutes integer, minutes_since_last_run numeric, has_ever_run boolean, recent_failures integer, healthy boolean, problem text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with expected(job_name, tolerance_minutes) as (
    -- Tolerance is the cadence with room for one missed tick plus slack, so a
    -- single late run is not an alert but a stopped job is.
    values ('activate-scheduled-alerts',    10),
           ('reminder-runner',              20),
           ('social-publisher',             45),
           ('expire-stale-ticket-orders',   20),
           ('sync-council-jobs',           240),
           ('social-composer',            1560),
           ('purge-old-job-applications', 1560),
           ('purge-rate-limits',          1560)
  ),
  runs as (
    select d.jobid,
           max(d.start_time) filter (where d.status = 'succeeded')            as last_ok,
           count(*) filter (where d.status = 'failed'
                              and d.start_time > now() - interval '1 day')::int as fails_1d
      from cron.job_run_details d
     where d.start_time > now() - interval '30 days'
     group by d.jobid
  )
  select e.job_name,
         coalesce(j.active, false),
         coalesce(j.schedule, '(not scheduled)'),
         e.tolerance_minutes,
         round(extract(epoch from (now() - r.last_ok)) / 60, 1),
         r.last_ok is not null,
         coalesce(r.fails_1d, 0),
         j.jobid is not null
           and coalesce(j.active, false)
           and coalesce(r.fails_1d, 0) < 3
           and (r.last_ok is null
                or now() - r.last_ok < make_interval(mins => e.tolerance_minutes)),
         case
           when j.jobid is null                then 'not scheduled at all'
           when not j.active                   then 'scheduled but INACTIVE'
           when coalesce(r.fails_1d,0) >= 3    then 'failing repeatedly: ' || r.fails_1d || ' failures in 24h'
           when r.last_ok is null              then 'has never run yet'
           when now() - r.last_ok >= make_interval(mins => e.tolerance_minutes)
                                               then 'stale: last succeeded '
                                                    || round(extract(epoch from (now() - r.last_ok))/60) || ' min ago'
           else 'ok'
         end
    from expected e
    left join cron.job j on j.jobname = e.job_name
    left join runs   r on r.jobid    = j.jobid
   order by e.job_name;
$function$
;
