-- ============================================================================
-- Metered bookings on Pro.
--
-- Pro can take bookings at 95p each; Premium includes them unmetered. The point
-- is not the revenue — it is that Shetland trade is seasonal, so a 30-day
-- Premium trial in February tells a tour operator nothing. Paying by the booking
-- lets a business test in its own season, at its own pace.
--
-- THE CAP IS THE IMPORTANT PART. Pro is £12 and Premium is £29, so metered fees
-- are capped at 17 bookings a month (17 x 95p = £16.15, giving £28.15 — always
-- strictly less than Premium). A Pro business can therefore never pay more than
-- Premium would have cost, no matter how well it goes. That turns the meter from
-- something that punishes success into "try it, and we won't let you overpay
-- while you find out" — which is worth more than the £16 to 527 businesses being
-- asked to trust a new platform.
--
-- Full reasoning: oneshetland-web/docs/tier-model.md.
-- ============================================================================

-- ── When a booking was billed ───────────────────────────────────────────────
-- NULL = not yet reported to Stripe. Set once, never cleared, so a booking can
-- never be billed twice however often the reporter runs.
alter table public.book_bookings
  add column if not exists metered_at timestamptz;

comment on column public.book_bookings.metered_at is
  'When this booking was reported to Stripe as metered usage. NULL = not yet billed. Set once; the uniqueness of that write is what prevents double-billing.';

-- Partial index: the reporter only ever asks for the unmetered ones.
create index if not exists idx_book_bookings_unmetered
  on public.book_bookings (business_id, created_at)
  where metered_at is null;

-- ── How many bookings a business has been billed for this calendar month ─────
create or replace function public.booking_meter_count(p_business_id uuid, p_month date default null)
returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::int
  from public.book_bookings
  where business_id = p_business_id
    and metered_at is not null
    and date_trunc('month', metered_at) = date_trunc('month', coalesce(p_month::timestamptz, now()))
$$;

comment on function public.booking_meter_count(uuid, date) is
  'Bookings already billed for this business in the given month (default: now). Used for the £16.15/mo cap and the upgrade nudge.';

grant execute on function public.booking_meter_count(uuid, date) to authenticated;

-- ── What the reporter should bill, honouring the cap ─────────────────────────
--
-- Returns one row per Pro business with unmetered bookings, and how many of them
-- may be billed this month. Premium is excluded entirely: bookings are included
-- there, so its bookings are marked metered without ever being charged.
create or replace function public.bookings_due_metering(p_cap int default 17)
returns table (
  business_id       uuid,
  stripe_subscription_id text,
  already_billed    int,
  billable_now      int,
  unmetered_total   int
)
language sql stable security definer set search_path = public as $$
  with pending as (
    select b.business_id, count(*)::int as unmetered_total
    from public.book_bookings b
    where b.metered_at is null
      and b.status <> 'cancelled'
    group by b.business_id
  )
  select
    p.business_id,
    lb.stripe_subscription_id,
    public.booking_meter_count(p.business_id) as already_billed,
    greatest(0, least(p.unmetered_total, p_cap - public.booking_meter_count(p.business_id))) as billable_now,
    p.unmetered_total
  from pending p
  join public.local_businesses lb on lb.id = p.business_id
  where lb.subscription_tier = 'pro'
$$;

comment on function public.bookings_due_metering(int) is
  'Pro businesses with bookings not yet billed, and how many may be billed this month given the cap. Premium is excluded — bookings are included on that tier.';

revoke all on function public.bookings_due_metering(int) from public;
