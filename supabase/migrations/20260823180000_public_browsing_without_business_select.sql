-- The rest of the signed-out browsing experience works again.
--
-- WHAT WAS WRONG
--
-- 20260822140000 fixed the EVENT journey and named the rest:
--
--     "The same defect affects 26 further tables — local_offers, products,
--      book_services, book_unit_items, business_addons and others all refuse
--      anonymous reads for the same reason."
--
-- 20260822160000 then fixed products and product_variants for Paygate 2.
-- Re-running the survey against production today, 25 tables still answer an
-- anonymous read with
--
--     42501: permission denied for table local_businesses
--
-- but only FIVE of them carry a genuinely public surface. The rest are
-- customer-private (orders, bookings, loyalty cards, wallet rows), owner-
-- private (alert access, business codes) or server-internal, and their denial
-- is the correct answer to the wrong question. This migration repairs the five
-- and deliberately leaves the other twenty exactly as they are.
--
-- WHY IT BREAKS
--
-- Step 8 replaced anon's table-wide SELECT on local_businesses with a column
-- whitelist that withholds owner_id. These policies answer "does the caller own
-- this business?" by reading that column AS THE CALLER, so anon needs a
-- privilege it does not have to compute an answer that was always going to be
-- "no". A policy that errors takes the whole request with it.
--
-- Two shapes are involved, and the second one is easy to miss:
--
--   1. a FOR SELECT policy that ORs a public rule with an owner subquery
--      ("Anyone can read active offers"), and
--   2. a FOR ALL owner "manage" policy, which Postgres also evaluates for
--      SELECT. local_loyalty_programs proves the point: its read policy is
--      plainly `is_active = true` and it STILL refused anonymous reads, purely
--      because the manage policy sitting beside it reads local_businesses.
--
-- THE FIX
--
-- public.is_business_owner(business, user) already exists — added by
-- 20260822140000, SECURITY DEFINER, search_path pinned, granted to anon.
-- Reused as-is rather than duplicated. Only WHO DOES THE READING changes.
--
-- ROW SEMANTICS ARE IDENTICAL. `business_id IN (SELECT id FROM
-- local_businesses WHERE owner_id = auth.uid())` and
-- `is_business_owner(business_id, auth.uid())` agree on every row for every
-- caller, including anon: auth.uid() is NULL there, `owner_id = NULL` is NULL,
-- EXISTS over no rows is false. Active/inactive publication rules are copied
-- across untouched — this migration does not publish a single row that was not
-- already meant to be public.
--
-- Granting anon SELECT on owner_id would also have "fixed" it, by publishing
-- which user owns which business. Not that. Step 8 stands.

begin;

-- ── local_offers — public deals on /loyalty, /local and business pages ──────
drop policy if exists "Anyone can read active offers" on public.local_offers;
create policy "Anyone can read active offers" on public.local_offers
  for select using (
    is_active = true
    or public.is_business_owner(business_id, auth.uid())
  );

drop policy if exists "Business owners can manage their offers" on public.local_offers;
create policy "Business owners can manage their offers" on public.local_offers
  using      (public.is_business_owner(business_id, auth.uid()))
  with check (public.is_business_owner(business_id, auth.uid()));

-- ── book_services — service discovery on /directory/bookable + business ─────
drop policy if exists "Anyone can read active services" on public.book_services;
create policy "Anyone can read active services" on public.book_services
  for select using (
    is_active = true
    or public.is_business_owner(business_id, auth.uid())
  );

drop policy if exists "Business owners manage their services" on public.book_services;
create policy "Business owners manage their services" on public.book_services
  using      (public.is_business_owner(business_id, auth.uid()))
  with check (public.is_business_owner(business_id, auth.uid()));

-- ── book_unit_items — public passes/packs on a business page ────────────────
drop policy if exists "Anyone can read active unit items" on public.book_unit_items;
create policy "Anyone can read active unit items" on public.book_unit_items
  for select using (
    is_active = true
    or public.is_business_owner(business_id, auth.uid())
  );

drop policy if exists "Business owners manage their unit items" on public.book_unit_items;
create policy "Business owners manage their unit items" on public.book_unit_items
  using      (public.is_business_owner(business_id, auth.uid()))
  with check (public.is_business_owner(business_id, auth.uid()));

-- ── local_loyalty_programs — the Shop Local Shetland showcase ───────────────
-- The read policy here is already clean and is left exactly as it is; only the
-- manage policy beside it needed to stop reading local_businesses.
drop policy if exists "Business owners can manage their program" on public.local_loyalty_programs;
create policy "Business owners can manage their program" on public.local_loyalty_programs
  using      (public.is_business_owner(business_id, auth.uid()))
  with check (public.is_business_owner(business_id, auth.uid()));

-- ── partner_alerts — the Home page alert strip ──────────────────────────────
-- partner_alerts_public_read (is_active and not expired) is already clean.
-- partner_alerts_owner_read_all is the one that refuses the request. The
-- owner UPDATE and INSERT policies also read local_businesses, but neither is
-- evaluated for SELECT, so they are out of scope here and left alone.
drop policy if exists partner_alerts_owner_read_all on public.partner_alerts;
create policy partner_alerts_owner_read_all on public.partner_alerts
  for select using (public.is_business_owner(business_id, auth.uid()));

commit;
