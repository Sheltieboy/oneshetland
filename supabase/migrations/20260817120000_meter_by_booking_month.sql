-- ============================================================================
-- Count the meter by the month the BOOKING happened, not the month a job ran.
--
-- Two faults, both visible the moment somebody took four real bookings and the
-- dashboard said nothing:
--
-- 1. booking_meter_count counted rows with metered_at set — i.e. bookings
--    already REPORTED to Stripe. Between taking a booking and the reporter
--    running, a business saw £0 and had no idea what it was running up. The
--    number they want is "what am I accruing", not "what has been filed".
--
-- 2. Both the count and the cap keyed off metered_at's month, which is when the
--    job happened to run. A booking taken on 31 January and reported on 1
--    February ate February's cap. The cap is sold as "17 bookings a month" and
--    a business means the month the bookings happened.
--
-- So: created_at decides the month, everywhere. The reporter still stamps
-- metered_at to guarantee each booking bills exactly once — it just no longer
-- decides WHICH month that booking belongs to.
-- ============================================================================

-- Both numbers a business needs, for the month a booking was actually taken.
create or replace function public.booking_meter_status(p_business_id uuid, p_month date default null)
returns table (booked int, billed int)
language sql stable security definer set search_path = public as $$
  select
    count(*) filter (where b.status <> 'cancelled')::int                             as booked,
    count(*) filter (where b.status <> 'cancelled' and b.metered_at is not null)::int as billed
  from public.book_bookings b
  where b.business_id = p_business_id
    and date_trunc('month', b.created_at) = date_trunc('month', coalesce(p_month::timestamptz, now()))
$$;

comment on function public.booking_meter_status(uuid, date) is
  'Bookings taken this month and how many have been billed. Keyed on created_at — the month the booking happened, not the month the reporter ran.';

revoke all on function public.booking_meter_status(uuid, date) from public;
revoke all on function public.booking_meter_status(uuid, date) from anon;
grant execute on function public.booking_meter_status(uuid, date) to authenticated;

-- The reporter's view: ONE ROW PER BUSINESS PER MONTH.
--
-- It has to be per month, not a single total. If January is capped out and
-- February has room, a combined total would let the reporter stamp January's
-- forgiven bookings against February's allowance — billing the ones the cap had
-- already excused and leaving February's to be billed later. The reporter
-- iterates months and stamps within each.
-- The return type gains month_start, and Postgres won't let CREATE OR REPLACE
-- change a function's OUT columns. Nothing but meter-bookings calls this, and it
-- calls it by name with the service role, so dropping is safe.
drop function if exists public.bookings_due_metering(int);

create function public.bookings_due_metering(p_cap int default 17)
returns table (
  business_id            uuid,
  stripe_subscription_id text,
  month_start            timestamptz,
  already_billed         int,
  billable_now           int,
  unmetered_total        int
)
language sql stable security definer set search_path = public as $$
  with months as (
    select
      b.business_id,
      date_trunc('month', b.created_at) as m,
      count(*) filter (where b.metered_at is null)::int     as unmetered,
      count(*) filter (where b.metered_at is not null)::int as billed
    from public.book_bookings b
    where b.status <> 'cancelled'
    group by b.business_id, date_trunc('month', b.created_at)
  )
  select
    mo.business_id,
    lb.stripe_subscription_id,
    mo.m,
    mo.billed,
    greatest(0, least(mo.unmetered, p_cap - mo.billed)),
    mo.unmetered
  from months mo
  join public.local_businesses lb on lb.id = mo.business_id
  where lb.subscription_tier = 'pro'
    and mo.unmetered > 0
  order by mo.business_id, mo.m
$$;

comment on function public.bookings_due_metering(int) is
  'One row per Pro business per BOOKING month with anything unbilled, and how many of that month may still be billed given the cap. Per-month so a backlog crossing a boundary cannot spend the wrong month allowance. Service role only.';

revoke all on function public.bookings_due_metering(int) from public;
revoke all on function public.bookings_due_metering(int) from anon;
revoke all on function public.bookings_due_metering(int) from authenticated;
