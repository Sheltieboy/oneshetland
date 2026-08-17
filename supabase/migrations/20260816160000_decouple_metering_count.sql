-- ============================================================================
-- Stop bookings_due_metering depending on a permission-checked function.
--
-- 20260816150000 added an ownership check to booking_meter_count so one owner
-- could not read another's numbers. But bookings_due_metering CALLS
-- booking_meter_count, and it runs as the service role, which has no auth.uid().
--
-- It currently survives only by accident: `v_owner <> auth.uid()` is NULL when
-- auth.uid() is NULL, `NULL and true` is NULL, and plpgsql treats a NULL IF as
-- false — so the guard silently does not fire. Correct today, and one small
-- change to that condition away from every Pro business's metering failing with
-- "forbidden" at billing time.
--
-- The two functions want different things anyway: one answers a question for a
-- signed-in owner, the other does bookkeeping as the platform. So the reporter
-- now counts inline and shares nothing with the guarded one.
-- ============================================================================

create or replace function public.bookings_due_metering(p_cap int default 17)
returns table (
  business_id            uuid,
  stripe_subscription_id text,
  already_billed         int,
  billable_now           int,
  unmetered_total        int
)
language sql stable security definer set search_path = public as $$
  with pending as (
    select b.business_id, count(*)::int as unmetered_total
    from public.book_bookings b
    where b.metered_at is null
      and b.status <> 'cancelled'
    group by b.business_id
  ),
  billed as (
    -- Counted inline rather than via booking_meter_count(), which is
    -- ownership-checked and would refuse the service role if that check ever
    -- became strict about NULLs.
    select b.business_id, count(*)::int as already_billed
    from public.book_bookings b
    where b.metered_at is not null
      and date_trunc('month', b.metered_at) = date_trunc('month', now())
    group by b.business_id
  )
  select
    p.business_id,
    lb.stripe_subscription_id,
    coalesce(bl.already_billed, 0),
    greatest(0, least(p.unmetered_total, p_cap - coalesce(bl.already_billed, 0))),
    p.unmetered_total
  from pending p
  join public.local_businesses lb on lb.id = p.business_id
  left join billed bl on bl.business_id = p.business_id
  where lb.subscription_tier = 'pro'
$$;

comment on function public.bookings_due_metering(int) is
  'Pro businesses with bookings not yet billed, and how many may be billed this month given the cap. Counts inline — deliberately shares no code with the ownership-checked booking_meter_count. Service role only.';

revoke all on function public.bookings_due_metering(int) from public;
revoke all on function public.bookings_due_metering(int) from anon;
revoke all on function public.bookings_due_metering(int) from authenticated;
