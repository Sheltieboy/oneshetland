-- ============================================================================
-- The scheduler stops living only in the Dashboard.
--
-- WHAT WAS WRONG
--
-- Six jobs run in production. Exactly one of them — expire-stale-ticket-orders,
-- added by 20260819240000 — existed in version control. The other five were
-- created by hand in the Dashboard and were reproducible from nothing:
--
--   activate-scheduled-alerts   * * * * *      SQL, from an ARCHIVED migration
--   reminder-runner             */5 * * * *    pg_net → Edge Function
--   social-composer             40 5 * * *     pg_net → Edge Function
--   social-publisher            */15 * * * *   pg_net → Edge Function
--   sync-council-jobs           17 */3 * * *   pg_net → Edge Function
--
-- A fresh project restored from this repository would have come up with one
-- sixth of its scheduler. Nothing would have failed loudly: reminders would
-- simply never send, council jobs would never import, and social posts would
-- never publish.
--
-- THE SECRET WAS SITTING IN THE JOB DEFINITION
--
-- The four pg_net jobs authenticate to their Edge Functions with a shared
-- `x-cron-secret` header, and the secret was written as a literal inside
-- cron.job.command — all four carrying the same 32-character value.
--
-- That is why this migration could not simply be the five missing
-- cron.schedule calls: writing them out would have committed the secret to git.
--
-- So the secret is moved into Vault instead, and it is moved WITHOUT LEAVING
-- THE DATABASE. The DO block below reads the existing job definition, extracts
-- the value with a regex, and hands it to vault.create_secret in the same
-- statement. The value is never printed, never passed through a client, and
-- never appears in this file. What appears here is its NAME.
--
-- Vault was already installed and completely empty. This is its first entry.
--
-- THE 5-SECOND TIMEOUT WAS SILENTLY EATING A QUARTER OF ALL RUNS
--
-- net.http_post defaults to a 5000 ms timeout. Measured over the ~6 hours of
-- history pg_net retains: 75 responses returned 200, and 24 timed out — 24% of
-- every dispatch, spread across reminder-runner and social-publisher.
--
-- Every one of those 24 was recorded by pg_cron as `succeeded`, because for a
-- pg_net job "succeeded" means the request was QUEUED, not answered. The
-- average cron run duration is 0.04s: that is the cost of queuing, and it is
-- all pg_cron ever observes. This is precisely the silent failure M10 is about,
-- and the existing run history could not have revealed it.
--
-- The canonical jobs below pass timeout_milliseconds := 20000. Edge Functions
-- cold-start, and 5s is not a generous budget for one that then does work.
--
-- WHAT IS DELIBERATELY *NOT* SCHEDULED
--
-- meter-bookings. The audit listed it as a missing cron job; it is not one.
-- reminder-runner invokes it directly (index.ts:392) on every pass, and its own
-- header says so. Giving it a second, independent schedule would create two
-- concurrent metering paths against the same bookings — the one thing a billing
-- job must not have. It is left exactly as it is.
--
-- WHAT IS NEWLY SCHEDULED
--
-- purge_old_job_applications(). It has existed since the jobs board shipped,
-- Step 1B locked it to service_role, and nothing has ever called it — no cron
-- job, no Edge Function, no client. Its retention rule (declined/withdrawn
-- applications, older than six months) is a background tidy with no deadline,
-- so it runs once a day at a quiet hour rather than on any faster cadence.
-- Scheduled as a direct SQL call: pg_cron runs as postgres, which already holds
-- EXECUTE, so this needs no HTTP hop and no service-role credential.
--
-- CADENCES ARE PRESERVED, NOT INVENTED
--
-- Every schedule below is the one already running in production, which is the
-- strongest available evidence of intent. The one job with no live schedule to
-- copy is the purge, and its cadence is argued above rather than guessed.
--
-- Re-runnable: each job is unscheduled by name first, so applying this twice —
-- or applying it after somebody created a job by hand — cannot leave two jobs
-- racing.
-- ============================================================================


-- ── The shared cron secret moves into Vault ─────────────────────────────────
do $$
declare
  v_secret text;
  v_check  text;
begin
  if exists (select 1 from vault.secrets where name = 'cron_secret') then
    raise notice 'cron_secret already present in Vault — leaving it alone';
    return;
  end if;

  -- Recovered from the running job rather than supplied, so the value stays
  -- inside the database. All four pg_net jobs carry the same secret; verified
  -- by fingerprint before this migration was written.
  select (regexp_match(j.command, $re$'x-cron-secret'\s*,\s*'([^']+)'$re$))[1]
    into v_secret
    from cron.job j
   where j.jobname = 'reminder-runner'
   limit 1;

  if v_secret is null or length(v_secret) < 16 then
    raise exception
      'Could not recover the cron secret from the reminder-runner job definition. '
      'Refusing to reschedule the pg_net jobs, because they would then authenticate '
      'with a null header and every Edge Function would answer 403.';
  end if;

  perform vault.create_secret(
    v_secret,
    'cron_secret',
    'Shared secret for the x-cron-secret header on scheduled Edge Function calls '
    '(reminder-runner, social-composer, social-publisher, sync-council-jobs). '
    'Recovered from the pre-existing cron job definitions; never present in git.');

  -- Prove the round trip before anything depends on it. If Vault cannot give
  -- the value back, the whole migration aborts and no schedule is touched.
  select decrypted_secret into v_check
    from vault.decrypted_secrets where name = 'cron_secret';

  if v_check is distinct from v_secret then
    raise exception 'Vault did not return the secret it was given — aborting before rescheduling.';
  end if;
end $$;


-- ── Canonical schedules ─────────────────────────────────────────────────────
do $$
declare
  v_name text;
begin
  foreach v_name in array array[
    'activate-scheduled-alerts',
    'reminder-runner',
    'social-composer',
    'social-publisher',
    'sync-council-jobs',
    'purge-old-job-applications'
  ] loop
    if exists (select 1 from cron.job where jobname = v_name) then
      perform cron.unschedule(v_name);
    end if;
  end loop;
end $$;


-- Database-only work: called directly, no HTTP hop, no credential.
--
-- partner_alerts holds 0 rows today, so this is currently a no-op running every
-- minute. The cadence is kept because it is the one in production and the
-- archived migration that created it states the requirement explicitly: an
-- alert becomes active the minute its starts_at passes.
select cron.schedule(
  'activate-scheduled-alerts',
  '* * * * *',
  $job$
    update public.partner_alerts
       set is_active = true
     where is_active = false
       and starts_at is not null
       and starts_at <= now()
       and (expires_at is null or expires_at > now());
  $job$
);

-- Six-month retention on declined/withdrawn job applications. Daily, offset
-- from every other job so it never starts in the same minute as one of them.
select cron.schedule(
  'purge-old-job-applications',
  '20 3 * * *',
  $job$select public.purge_old_job_applications();$job$
);

-- Every time-based notification, plus shop/ticket order expiry, plus the
-- booking meter it invokes itself.
select cron.schedule(
  'reminder-runner',
  '*/5 * * * *',
  $job$
    select net.http_post(
      url     := 'https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/reminder-runner',
      headers := jsonb_build_object(
                   'Content-Type',   'application/json',
                   'x-cron-secret',  (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
      body    := '{}'::jsonb,
      timeout_milliseconds := 20000
    );
  $job$
);

select cron.schedule(
  'social-composer',
  '40 5 * * *',
  $job$
    select net.http_post(
      url     := 'https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/social-composer',
      headers := jsonb_build_object(
                   'Content-Type',   'application/json',
                   'x-cron-secret',  (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
      body    := '{}'::jsonb,
      timeout_milliseconds := 20000
    );
  $job$
);

select cron.schedule(
  'social-publisher',
  '*/15 * * * *',
  $job$
    select net.http_post(
      url     := 'https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/social-publisher',
      headers := jsonb_build_object(
                   'Content-Type',   'application/json',
                   'x-cron-secret',  (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
      body    := '{}'::jsonb,
      timeout_milliseconds := 20000
    );
  $job$
);

select cron.schedule(
  'sync-council-jobs',
  '17 */3 * * *',
  $job$
    select net.http_post(
      url     := 'https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/sync-council-jobs',
      headers := jsonb_build_object(
                   'Content-Type',   'application/json',
                   'x-cron-secret',  (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
      body    := '{}'::jsonb,
      timeout_milliseconds := 20000
    );
  $job$
);


-- ── Detecting a job that has quietly stopped ────────────────────────────────
--
-- Scheduling the jobs does not solve the operational risk on its own; the whole
-- point of M10 is that a job can stop without anyone noticing. These two
-- functions turn "is the scheduler alive" into something a test can assert.
--
-- They are split because pg_cron and pg_net answer different questions and
-- conflating them is exactly how the 24% timeout rate stayed invisible:
--
--   cron_job_health()        did the job FIRE, on time, without erroring
--   cron_transport_health()  did the HTTP request it fired actually LAND
--
-- For a SQL job the first is the whole story. For a pg_net job it is only half:
-- pg_cron records `succeeded` the moment the request is queued, whatever the
-- Edge Function later does or fails to do.
create or replace function public.cron_job_health()
returns table (
  job_name                text,
  active                  boolean,
  schedule                text,
  tolerance_minutes       int,
  minutes_since_last_run  numeric,
  has_ever_run            boolean,
  recent_failures         int,
  healthy                 boolean,
  problem                 text
)
  language sql
  stable
  security definer
  set search_path = public
as $$
  with expected(job_name, tolerance_minutes) as (
    -- Tolerance is the cadence with room for one missed tick plus slack, so a
    -- single late run is not an alert but a stopped job is.
    values ('activate-scheduled-alerts',    10),
           ('reminder-runner',              20),
           ('social-publisher',             45),
           ('expire-stale-ticket-orders',   20),
           ('sync-council-jobs',           240),
           ('social-composer',            1560),
           ('purge-old-job-applications', 1560)
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
$$;

comment on function public.cron_job_health() is
  'Per-job scheduler health from cron.job / cron.job_run_details. For pg_net jobs this reports DISPATCH only — pair it with cron_transport_health() to see whether the request landed.';


create or replace function public.cron_transport_health()
returns table (
  window_start   timestamptz,
  window_end     timestamptz,
  responses      int,
  ok_2xx         int,
  non_2xx        int,
  timed_out      int,
  timeout_pct    numeric
)
  language sql
  stable
  security definer
  set search_path = public
as $$
  -- pg_net prunes _http_response aggressively (a few hours), so this is a
  -- rolling recent picture, not history. That is enough to answer "are the
  -- scheduled Edge Function calls currently landing".
  select min(r.created), max(r.created),
         count(*)::int,
         count(*) filter (where r.status_code between 200 and 299)::int,
         count(*) filter (where r.status_code is not null
                            and (r.status_code < 200 or r.status_code > 299))::int,
         count(*) filter (where r.timed_out)::int,
         round(100.0 * count(*) filter (where r.timed_out) / nullif(count(*), 0), 1)
    from net._http_response r;
$$;

comment on function public.cron_transport_health() is
  'Whether scheduled pg_net requests are actually landing. pg_cron reports a queued request as succeeded, so a high timeout_pct here is invisible in cron.job_run_details.';


-- Cron internals stay server-side. Steps 1/1B: a revoke naming fewer than
-- {public, anon, authenticated} leaves one door open, so all three are named.
do $$
declare fn text;
begin
  foreach fn in array array['public.cron_job_health()', 'public.cron_transport_health()'] loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;


-- ── Prove it, in the transaction that did it ────────────────────────────────
do $$
declare
  v_missing text;
  v_leaky   int;
begin
  select string_agg(e.name, ', ')
    into v_missing
    from (values ('activate-scheduled-alerts'), ('reminder-runner'), ('social-composer'),
                 ('social-publisher'), ('sync-council-jobs'), ('expire-stale-ticket-orders'),
                 ('purge-old-job-applications')) e(name)
   where not exists (select 1 from cron.job j where j.jobname = e.name and j.active);

  if v_missing is not null then
    raise exception 'These canonical jobs are missing or inactive after scheduling: %', v_missing;
  end if;

  -- No job may carry a literal secret any more; they resolve it from Vault.
  select count(*) into v_leaky
    from cron.job
   where command ~ $re$'x-cron-secret'\s*,\s*'[^']$re$
     and command not like '%decrypted_secrets%';

  if v_leaky > 0 then
    raise exception '% job(s) still embed a literal cron secret in their command', v_leaky;
  end if;
end $$;
