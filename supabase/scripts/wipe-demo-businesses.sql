-- =============================================================================
-- OneShetland — remove DEMO / TEST businesses before the launch outreach
-- =============================================================================
-- Run this in the Supabase SQL editor (it runs as service role, bypassing RLS).
--
-- HOW IT WORKS
--   Your real, imported directory is source = 'wordpress' (seeded stubs).
--   Every test business you made by hand is source = 'owner'. At pre-launch,
--   nobody real has self-registered yet, so source='owner' == "test data I made"
--   — this catches Hood Wink & the demo cafe even though their names don't say
--   "test", and it can NEVER touch a real 'wordpress' listing.
--
--   Almost all child tables cascade on delete. The one exception is
--   local_wallet_transactions, so we clear those first.
--
-- SAFETY
--   * Run STEP 1 first and READ the list. Nothing is deleted until STEP 3.
--   * If a row you want to KEEP appears, add its id to the KEEP list in STEP 3.
--   * You are still on Stripe TEST keys, so these transactions are test money.
-- =============================================================================


-- ─── STEP 1a — PREVIEW: the wipe set (hand-made businesses) ───────────────────
-- Every row here will be deleted in STEP 3 (unless you exclude it).
select
  b.id,
  b.name,
  b.category,
  b.source,
  b.is_claimed,
  b.subscription_tier,
  b.owner_id,
  b.created_at,
  (select count(*) from public.local_wallet_transactions t where t.business_id = b.id) as wallet_txns,
  (select count(*) from public.local_offers        o where o.business_id = b.id) as offers,
  (select count(*) from public.business_claims      c where c.business_id = b.id) as claims,
  (select count(*) from public.local_business_codes k where k.business_id = b.id) as till_codes
from public.local_businesses b
where b.source = 'owner'
order by b.created_at;


-- ─── STEP 1b — REVIEW ONLY: real (seeded) listings that happen to be named
--     like a demo/test. These are probably genuine — they are NOT deleted by
--     STEP 3. If any is actually junk, copy its id into STEP 4. ────────────────
select b.id, b.name, b.source, b.is_claimed, b.created_at
from public.local_businesses b
where b.source <> 'owner'
  and b.name ~* '\y(demo|test|sample|example|dummy|xxx|asdf)\y'
order by b.name;


-- ─── STEP 2 — PREVIEW: demo / test EVENTS (word-boundary match, so "Contest"
--     etc. are NOT caught). Deleting a test business only nulls the event's
--     organiser, so clean these separately if you want them gone. ─────────────
select e.id, e.title, e.status, e.organiser_business_id, e.created_at
from public.events e
where e.title ~* '\y(demo|test)\y'
   or e.organiser_business_id in (select id from public.local_businesses where source = 'owner')
order by e.created_at;


-- =============================================================================
-- STEP 3 — DELETE the test businesses.  ⚠️ Only run after reviewing STEP 1a.
-- =============================================================================
-- Everything is in one transaction: if any part fails, NOTHING is deleted.
-- To keep a specific source='owner' business, add its id to _keep below.

begin;

with _keep as (
  select id from public.local_businesses
  where id in (
    -- '00000000-0000-0000-0000-000000000000'   -- ← paste ids to KEEP here
    null::uuid
  )
),
_targets as (
  select b.id
  from public.local_businesses b
  where b.source = 'owner'
    and b.id not in (select id from _keep)
)
-- 3a. clear the one non-cascading child first
, _wipe_txns as (
  delete from public.local_wallet_transactions
  where business_id in (select id from _targets)
  returning 1
)
-- 3b. delete the businesses — cascades offers, loyalty, codes, claims, addons,
--     bookings, boosts, follows; nulls out events/jobs/shifts/notices refs
delete from public.local_businesses
where id in (select id from _targets);

-- Review the row count, then:
commit;      -- ← keep this to apply
-- rollback; -- ← swap to this line instead if the numbers look wrong


-- =============================================================================
-- STEP 4 (optional) — delete demo / test EVENTS
-- =============================================================================
-- Run after STEP 3 if you also want the demo events gone. Uses title match only
-- (organiser links were nulled by STEP 3). Review STEP 2 output first.
--
-- delete from public.events
-- where title ~* '\y(demo|test)\y';


-- ─── STEP 5 — VERIFY: should be 0 hand-made businesses left ───────────────────
select
  (select count(*) from public.local_businesses where source = 'owner') as remaining_owner_made,
  (select count(*) from public.local_businesses where source = 'wordpress') as real_directory,
  (select count(*) from public.local_businesses) as total_businesses;
