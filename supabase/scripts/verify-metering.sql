-- ============================================================================
-- verify-metering.sql — proves the booking-meter logic against real schema.
--
-- Paste the whole file into the Supabase SQL editor and run it. You should get
-- ONE table of nine rows, every one saying PASS.
--
-- Everything happens inside a transaction that ROLLS BACK, so nothing is left
-- behind. Assertions accumulate into a temp table and are selected once at the
-- end, because the SQL editor only shows the LAST result set — the first
-- version of this script ran all nine checks and displayed none of them.
--
-- Covers what pure-logic tests can't reach: that the SQL genuinely excludes
-- Premium and cancelled bookings, respects the cap, is idempotent, and counts
-- per calendar month.
-- ============================================================================

begin;

create temp table _r (n int generated always as identity, scenario text, result text) on commit drop;

-- ── Fixtures ────────────────────────────────────────────────────────────────
-- Two businesses identical but for tier, so tier is the only variable.
-- category and address are NOT NULL with no default; category is constrained.
insert into public.local_businesses
  (id, owner_id, name, category, address, subscription_tier, stripe_subscription_id, is_active)
values
  ('eeeeeeee-0000-0000-0000-000000000001'::uuid,
   (select id from auth.users limit 1), 'TEST Pro Co', 'services', 'TEST address', 'pro', 'sub_test_pro', true),
  ('eeeeeeee-0000-0000-0000-000000000002'::uuid,
   (select id from auth.users limit 1), 'TEST Premium Co', 'services', 'TEST address', 'premium', 'sub_test_prem', true);

insert into public.book_services (id, business_id, name, duration_minutes, price_pence, is_active)
values
  ('eeeeeeee-1111-0000-0000-000000000001'::uuid, 'eeeeeeee-0000-0000-0000-000000000001'::uuid, 'TEST svc', 30, 1000, true),
  ('eeeeeeee-1111-0000-0000-000000000002'::uuid, 'eeeeeeee-0000-0000-0000-000000000002'::uuid, 'TEST svc', 30, 1000, true);

-- 25 confirmed bookings for Pro — deliberately more than the cap.
insert into public.book_bookings (business_id, service_id, customer_id, starts_at, ends_at, status, price_pence)
select 'eeeeeeee-0000-0000-0000-000000000001'::uuid, 'eeeeeeee-1111-0000-0000-000000000001'::uuid,
       (select id from auth.users limit 1),
       now() + (g || ' days')::interval, now() + (g || ' days')::interval + interval '30 min', 'confirmed', 1000
from generate_series(1, 25) g;

-- 3 CANCELLED for the same business — must never be billed.
insert into public.book_bookings (business_id, service_id, customer_id, starts_at, ends_at, status, price_pence)
select 'eeeeeeee-0000-0000-0000-000000000001'::uuid, 'eeeeeeee-1111-0000-0000-000000000001'::uuid,
       (select id from auth.users limit 1), now(), now() + interval '30 min', 'cancelled', 1000
from generate_series(1, 3);

-- 10 for Premium — bookings are included there, so it must never be billed.
insert into public.book_bookings (business_id, service_id, customer_id, starts_at, ends_at, status, price_pence)
select 'eeeeeeee-0000-0000-0000-000000000002'::uuid, 'eeeeeeee-1111-0000-0000-000000000002'::uuid,
       (select id from auth.users limit 1), now(), now() + interval '30 min', 'confirmed', 1000
from generate_series(1, 10);

-- ── 1. First run ────────────────────────────────────────────────────────────
insert into _r (scenario, result)
select '1. cap limits the first run to 17',
       case when billable_now = 17 then 'PASS' else 'FAIL — got ' || billable_now end
from public.bookings_due_metering(17)
where business_id = 'eeeeeeee-0000-0000-0000-000000000001'::uuid;

insert into _r (scenario, result)
select '2. cancelled bookings excluded (25, not 28)',
       case when unmetered_total = 25 then 'PASS' else 'FAIL — got ' || unmetered_total end
from public.bookings_due_metering(17)
where business_id = 'eeeeeeee-0000-0000-0000-000000000001'::uuid;

insert into _r (scenario, result)
select '3. premium business never appears',
       case when count(*) = 0 then 'PASS' else 'FAIL — premium would be billed' end
from public.bookings_due_metering(17)
where business_id = 'eeeeeeee-0000-0000-0000-000000000002'::uuid;

insert into _r (scenario, result)
select '4. subscription id carried through for Stripe',
       case when stripe_subscription_id = 'sub_test_pro' then 'PASS' else 'FAIL' end
from public.bookings_due_metering(17)
where business_id = 'eeeeeeee-0000-0000-0000-000000000001'::uuid;

-- ── 2. Simulate the reporter stamping those 17 ──────────────────────────────
update public.book_bookings set metered_at = now()
where id in (
  select id from public.book_bookings
  where business_id = 'eeeeeeee-0000-0000-0000-000000000001'::uuid
    and metered_at is null and status <> 'cancelled'
  order by created_at limit 17
);

insert into _r (scenario, result)
select '5. after billing 17, nothing more is billable this month',
       case when coalesce(max(billable_now), 0) = 0 then 'PASS' else 'FAIL — got ' || max(billable_now) end
from public.bookings_due_metering(17)
where business_id = 'eeeeeeee-0000-0000-0000-000000000001'::uuid;

insert into _r (scenario, result)
select '6. the remaining 8 are still visible as pending',
       case when max(unmetered_total) = 8 then 'PASS' else 'FAIL — got ' || coalesce(max(unmetered_total)::text, 'no row') end
from public.bookings_due_metering(17)
where business_id = 'eeeeeeee-0000-0000-0000-000000000001'::uuid;

insert into _r (scenario, result)
select '7. a second identical run is a no-op (idempotent)',
       case when coalesce(max(billable_now), 0) = 0 then 'PASS' else 'FAIL' end
from public.bookings_due_metering(17)
where business_id = 'eeeeeeee-0000-0000-0000-000000000001'::uuid;

-- ── 3. Month boundary ───────────────────────────────────────────────────────
update public.book_bookings set metered_at = now() - interval '40 days'
where business_id = 'eeeeeeee-0000-0000-0000-000000000001'::uuid and metered_at is not null;

insert into _r (scenario, result)
select '8. last month''s 17 do not eat this month''s cap',
       case when max(billable_now) = 8 then 'PASS' else 'FAIL — got ' || coalesce(max(billable_now)::text, 'no row') end
from public.bookings_due_metering(17)
where business_id = 'eeeeeeee-0000-0000-0000-000000000001'::uuid;

-- ── 4. Premium stays absent through a full cycle ────────────────────────────
insert into _r (scenario, result)
select '9. premium still absent after a full cycle',
       case when count(*) = 0 then 'PASS' else 'FAIL' end
from public.bookings_due_metering(17)
where business_id = 'eeeeeeee-0000-0000-0000-000000000002'::uuid;

-- ── Results — the LAST row-returning statement, so the editor shows it ──────
select scenario, result from _r order by n;

rollback;

-- Cleanup is guaranteed by the rollback above. To satisfy yourself separately,
-- run this on its own afterwards — it should return no rows:
--   select id, name from public.local_businesses where name like 'TEST %';
