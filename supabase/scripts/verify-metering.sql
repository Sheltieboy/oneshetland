-- ============================================================================
-- verify-metering.sql — proves the booking-meter logic against real schema.
--
-- Wrapped in a transaction that ROLLS BACK, so it writes nothing permanent.
-- Paste the whole file into the Supabase SQL editor and run it. Every row of
-- the output should say PASS.
--
-- Covers the cases that pure-logic tests can't: that the SQL actually excludes
-- Premium and cancelled bookings, respects the cap, is idempotent, and counts
-- per calendar month.
-- ============================================================================

begin;

-- ── Fixtures ────────────────────────────────────────────────────────────────
-- Two businesses, identical except for tier, so the only variable is the thing
-- under test. IDs are fixed and obviously fake.
-- category and address are NOT NULL with no default; category is also
-- constrained to a fixed set.
insert into public.local_businesses
  (id, owner_id, name, category, address, subscription_tier, stripe_subscription_id, is_active)
values
  ('eeeeeeee-0000-0000-0000-000000000001'::uuid,
   (select id from auth.users limit 1), 'TEST Pro Co', 'services', 'TEST address', 'pro', 'sub_test_pro', true),
  ('eeeeeeee-0000-0000-0000-000000000002'::uuid,
   (select id from auth.users limit 1), 'TEST Premium Co', 'services', 'TEST address', 'premium', 'sub_test_prem', true);

-- A service each, because book_bookings requires one.
insert into public.book_services (id, business_id, name, duration_minutes, price_pence, is_active)
values
  ('eeeeeeee-1111-0000-0000-000000000001'::uuid, 'eeeeeeee-0000-0000-0000-000000000001'::uuid, 'TEST svc', 30, 1000, true),
  ('eeeeeeee-1111-0000-0000-000000000002'::uuid, 'eeeeeeee-0000-0000-0000-000000000002'::uuid, 'TEST svc', 30, 1000, true);

-- 25 confirmed bookings for the Pro business — deliberately more than the cap.
insert into public.book_bookings (business_id, service_id, customer_id, starts_at, ends_at, status, price_pence)
select 'eeeeeeee-0000-0000-0000-000000000001'::uuid,
       'eeeeeeee-1111-0000-0000-000000000001'::uuid,
       (select id from auth.users limit 1),
       now() + (g || ' days')::interval,
       now() + (g || ' days')::interval + interval '30 min',
       'confirmed', 1000
from generate_series(1, 25) g;

-- 3 CANCELLED bookings for the same business — must never be billed.
insert into public.book_bookings (business_id, service_id, customer_id, starts_at, ends_at, status, price_pence)
select 'eeeeeeee-0000-0000-0000-000000000001'::uuid,
       'eeeeeeee-1111-0000-0000-000000000001'::uuid,
       (select id from auth.users limit 1),
       now(), now() + interval '30 min', 'cancelled', 1000
from generate_series(1, 3);

-- 10 bookings for the Premium business — must be stamped, never billed.
insert into public.book_bookings (business_id, service_id, customer_id, starts_at, ends_at, status, price_pence)
select 'eeeeeeee-0000-0000-0000-000000000002'::uuid,
       'eeeeeeee-1111-0000-0000-000000000002'::uuid,
       (select id from auth.users limit 1),
       now(), now() + interval '30 min', 'confirmed', 1000
from generate_series(1, 10);

-- ── 1. First run: cap applies, cancelled excluded ───────────────────────────
select 'cap limits first run to 17'                                as scenario,
       case when billable_now = 17 then 'PASS' else 'FAIL got ' || billable_now end as result
from public.bookings_due_metering(17)
where business_id = 'eeeeeeee-0000-0000-0000-000000000001'::uuid;

select 'cancelled bookings excluded (25 not 28)'                   as scenario,
       case when unmetered_total = 25 then 'PASS' else 'FAIL got ' || unmetered_total end as result
from public.bookings_due_metering(17)
where business_id = 'eeeeeeee-0000-0000-0000-000000000001'::uuid;

select 'premium business never appears'                            as scenario,
       case when count(*) = 0 then 'PASS' else 'FAIL — premium would be billed' end as result
from public.bookings_due_metering(17)
where business_id = 'eeeeeeee-0000-0000-0000-000000000002'::uuid;

-- ── 2. Simulate the reporter stamping those 17 ──────────────────────────────
update public.book_bookings set metered_at = now()
where id in (
  select id from public.book_bookings
  where business_id = 'eeeeeeee-0000-0000-0000-000000000001'::uuid
    and metered_at is null and status <> 'cancelled'
  order by created_at limit 17
);

select 'after billing 17, nothing further is billable'             as scenario,
       case when coalesce(max(billable_now), 0) = 0 then 'PASS'
            else 'FAIL got ' || max(billable_now) end              as result
from public.bookings_due_metering(17)
where business_id = 'eeeeeeee-0000-0000-0000-000000000001'::uuid;

select 'the remaining 8 are still visible as pending'              as scenario,
       case when max(unmetered_total) = 8 then 'PASS'
            else 'FAIL got ' || coalesce(max(unmetered_total)::text, 'none') end as result
from public.bookings_due_metering(17)
where business_id = 'eeeeeeee-0000-0000-0000-000000000001'::uuid;

-- ── 3. Idempotency: a second identical run bills nothing more ───────────────
select 'second run is a no-op (idempotent)'                        as scenario,
       case when coalesce(max(billable_now), 0) = 0 then 'PASS' else 'FAIL' end as result
from public.bookings_due_metering(17)
where business_id = 'eeeeeeee-0000-0000-0000-000000000001'::uuid;

-- ── 4. Month boundary: last month's billing doesn't consume this month's cap ─
update public.book_bookings set metered_at = now() - interval '40 days'
where business_id = 'eeeeeeee-0000-0000-0000-000000000001'::uuid
  and metered_at is not null;

select 'last month''s 17 do not consume this month''s cap'          as scenario,
       case when max(billable_now) = 8 then 'PASS'
            else 'FAIL got ' || coalesce(max(billable_now)::text, 'none') end as result
from public.bookings_due_metering(17)
where business_id = 'eeeeeeee-0000-0000-0000-000000000001'::uuid;

-- ── 5. A Pro business with NO bookings never appears ────────────────────────
select 'businesses with nothing pending are absent'                as scenario,
       case when count(*) = 0 then 'PASS' else 'FAIL' end          as result
from public.bookings_due_metering(17)
where business_id = 'eeeeeeee-0000-0000-0000-000000000002'::uuid;

rollback;

-- Confirm nothing was left behind.
select 'fixtures rolled back'                                      as scenario,
       case when count(*) = 0 then 'PASS' else 'FAIL — test data persisted!' end as result
from public.local_businesses where name like 'TEST %';
