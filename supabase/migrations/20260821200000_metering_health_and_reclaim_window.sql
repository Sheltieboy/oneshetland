-- ============================================================================
-- The reclaim window is measured from the attempt, and the health check learns
-- the new states.
--
-- TWO CORRECTIONS, BOTH FOUND BY TESTING
--
-- reclaim_unresolved_metering measured its window from
-- coalesce(metering_reported_at, created_at). For a booking that has never
-- succeeded, metering_reported_at is null, so it fell back to created_at — when
-- the CUSTOMER MADE THE BOOKING, which has nothing to do with when we called
-- Stripe. A booking made three weeks ago and attempted a minute ago looked
-- ancient, so it was never reclaimed and sat unresolved for ever.
--
-- The question the window is actually asking is "would Stripe still recognise
-- this identifier as a duplicate", and that depends only on when the call was
-- made. metering_claimed_at, added by the previous migration, is that moment.
--
-- And metering_backlog_health() predates the state machine. It asked
-- "metered_at is null", which lumps three different situations together:
--
--   pending too long   nothing is running — the pipeline has stopped
--   reporting too long  a worker died mid-flight
--   unresolved older
--   than Stripe's window  we do not know whether the customer was billed, and
--                         nobody can safely decide that automatically
--
-- The third is the one that needs a person, and it was invisible. Reporting
-- them separately is the difference between "something is wrong" and knowing
-- which thing.
-- ============================================================================

create or replace function public.reclaim_unresolved_metering(
  p_business_id uuid,
  p_within      interval default interval '12 hours'
)
returns table (booking_id uuid, attempt_id uuid)
  language sql
  security definer
  set search_path = public
as $$
  update public.book_bookings b
     set metering_state    = 'reporting',
         metering_claimed_at = now(),
         metering_attempts = b.metering_attempts + 1
   where b.id in (
           select b2.id from public.book_bookings b2
            where b2.business_id = p_business_id
              and b2.metering_state = 'unresolved'
              and b2.metering_attempt_id is not null
              -- measured from the ATTEMPT, not from when the booking was made
              and b2.metering_claimed_at is not null
              and b2.metering_claimed_at > now() - p_within
            for update skip locked)
  returning b.id, b.metering_attempt_id;
$$;

comment on function public.reclaim_unresolved_metering(uuid, interval) is
  'Re-claims ambiguous attempts while Stripe would still reject their identifier as a duplicate, reusing the same attempt id. The window runs from metering_claimed_at — when the call was made — not from when the booking was created.';


-- Postgres will not change a function's OUT parameters in place, and this one
-- gains three columns, so it is dropped first. Nothing calls it but the tests
-- and an operator, so there is no dependency to break.
drop function if exists public.metering_backlog_health();

create or replace function public.metering_backlog_health()
returns table (
  unmetered_billable        int,
  oldest_unmetered_hours    numeric,
  threshold_hours           int,
  unbillable_pro_bookings   int,
  stuck_pending             int,
  stuck_reporting           int,
  unresolved_needing_review int,
  healthy                   boolean,
  problem                   text
)
  language sql
  stable
  security definer
  set search_path = public
as $$
  with graded as (
    select b.metering_state,
           b.created_at,
           b.metering_claimed_at,
           (lb.subscription_tier = 'pro' and lb.stripe_subscription_id is null) as unbillable
      from public.book_bookings b
      join public.local_businesses lb on lb.id = b.business_id
     where b.status <> 'cancelled'
       and lb.subscription_tier in ('pro', 'premium')
       and b.metering_state in ('pending', 'reporting', 'unresolved')
  ),
  aged as (
    select *,
           -- a booking is only "late" once it has had six hours of chances;
           -- reminder-runner passes every five minutes, so that is ~72 of them
           (created_at < now() - interval '6 hours')                                   as old_enough,
           (metering_state = 'unresolved'
            and coalesce(metering_claimed_at, created_at) < now() - interval '12 hours') as past_stripe_window
      from graded
  )
  select
    count(*) filter (where not unbillable and old_enough)::int,
    round(extract(epoch from (now() - min(created_at) filter (where not unbillable and old_enough))) / 3600, 1),
    6,
    count(*) filter (where unbillable and old_enough)::int,
    count(*) filter (where metering_state = 'pending'   and not unbillable and old_enough)::int,
    count(*) filter (where metering_state = 'reporting' and not unbillable and old_enough)::int,
    count(*) filter (where past_stripe_window and not unbillable)::int,
    count(*) filter (where not unbillable and old_enough) = 0,
    case
      when count(*) filter (where past_stripe_window and not unbillable) > 0
        then 'NEEDS A HUMAN: ' || count(*) filter (where past_stripe_window and not unbillable)
             || ' attempt(s) ended ambiguously more than 12h ago — Stripe may or may not have billed them'
      when count(*) filter (where metering_state = 'pending' and not unbillable and old_enough) > 0
        then 'metering appears stopped: ' || count(*) filter (where metering_state = 'pending' and not unbillable and old_enough)
             || ' booking(s) never claimed after 6h'
      when count(*) filter (where metering_state = 'reporting' and not unbillable and old_enough) > 0
        then count(*) filter (where metering_state = 'reporting' and not unbillable and old_enough)
             || ' booking(s) stuck mid-report'
      when count(*) filter (where unbillable and old_enough) > 0
        then 'ok, but ' || count(*) filter (where unbillable and old_enough)
             || ' booking(s) belong to a Pro business with no Stripe subscription and can never be billed'
      else 'ok'
    end
  from aged;
$$;

comment on function public.metering_backlog_health() is
  'Whether booking metering is still running, judged from the data rather than the scheduler. Separates a stopped pipeline from a dead worker from an ambiguous Stripe outcome that needs a person — reminder-runner swallows a meter-bookings failure and still returns 200, so cron history cannot show any of it.';

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.reclaim_unresolved_metering(uuid, interval)',
    'public.metering_backlog_health()'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;
