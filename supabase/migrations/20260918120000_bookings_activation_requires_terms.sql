-- ═══════════════════════════════════════════════════════════════════════════
-- Going live needs the terms as well as the plan
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The Bookings activation guard checked the subscription and nothing else. The
-- reasoning for that was: a business cannot create a book_service without
-- accepting, so by the time it has anything to book it has accepted. That is
-- true of a business set up today and it is not an invariant.
--
-- It fails exactly where it matters most — the next time the terms change:
--
--   accepted v1.0 · services already exist · bookings off
--   → terms move to v1.1 · owner has not accepted
--   → owner switches bookings back on, and the guard waves it through
--     because the subscription is fine
--
-- which is the one case the version-pinned acceptance model exists to catch.
-- It also assumes no legacy or seeded configuration predates acceptance, and
-- there is such configuration in this database today.
--
-- So activation now asks both questions. business_may_transact is the deployed
-- helper that already answers the second one — it checks ownership AND
-- acceptance of the CURRENT version through has_accepted_commercial_terms, and
-- it refuses to answer about anyone but the caller. The terms lookup is not
-- reimplemented here; there is one acceptance truth and this asks it.
--
-- ── Deliberately unchanged ─────────────────────────────────────────────────
--
-- Turning bookings OFF still needs neither a plan nor current terms. A version
-- bump must never leave a business unable to withdraw something customers can
-- still book — the same carve-out W3I already makes, for the same reason.
--
-- An update that does not touch the flag is still never examined, so a terms
-- bump cannot stop somebody fixing their opening hours.
--
-- The customer booking backstop is NOT given a terms check. Live commercial
-- exposure is deliberately not killed by a version bump; the owner is asked at
-- the next activation, not by having bookings stop mid-week. That guard keeps
-- requiring an active business, bookings on, and current Pro.
--
-- W3I is not broadened: accepts_bookings is not added to its column guard, its
-- nine tables and current version are untouched, and this stays a dedicated
-- Bookings guard.
create or replace function public.local_businesses_bookings_tier_guard()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  if new.accepts_bookings is not distinct from old.accepts_bookings then
    return new;                       -- an ordinary update; not our business
  end if;

  if new.accepts_bookings is not true then
    return new;                       -- turning it OFF is always allowed
  end if;

  if v_uid is null then
    return new;                       -- service role, webhooks, scheduled jobs
  end if;

  if exists (
    select 1 from public.profiles p
     where p.id = v_uid and p.role = any (array['admin'::text, 'moderator'::text])
  ) then
    return new;                       -- platform staff, deliberately
  end if;

  -- Acceptance first: it is the earlier step in the journey and the cheaper of
  -- the two to put right. business_may_transact covers ownership and the
  -- current terms version together.
  if not public.business_may_transact(new.id, v_uid) then
    raise exception 'Accept the business & selling terms for this business before switching bookings on'
      using errcode = '42501';
  end if;

  if not public.business_meets_tier(new.id, 'pro') then
    raise exception 'Taking bookings needs a Pro plan. Your services and opening times are saved — switch bookings on once your plan is active.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.local_businesses_bookings_tier_guard() is
  'Turning accepts_bookings on requires current commercial-terms acceptance (via business_may_transact) AND effective Pro-or-better (via business_meets_tier). Turning it off requires neither, and an update that does not touch the flag is never examined.';
