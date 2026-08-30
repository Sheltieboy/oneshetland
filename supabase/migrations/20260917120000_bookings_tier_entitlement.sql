-- ═══════════════════════════════════════════════════════════════════════════
-- Bookings become real work for the server, not the navigation
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Bookings are a Pro feature. Until now that was enforced by the website
-- redirecting off the page and the app not drawing the button — a decision made
-- in two clients and enforced in neither. The RLS insert policy on
-- book_bookings is `customer_id = auth.uid()` and nothing else: no business
-- check, no accepts_bookings check, no tier. So this is the first consumer of
-- business_meets_tier, and it puts the boundary where it belongs.
--
-- ── Two guards, because there are two ways in ──────────────────────────────
--
-- ACTIVATION   accepts_bookings false → true needs current Pro. This is the
--              switch that puts a business in front of customers.
--
-- TRANSACTION  a booking cannot be created unless the business is STILL
--              entitled. Activation alone is not enough: a business that went
--              live legitimately and then lapsed has accepts_bookings sitting
--              at true, and nothing sweeps it. The second guard is what makes
--              a stale flag harmless.
--
-- ── What is deliberately NOT gated ─────────────────────────────────────────
--
-- Turning bookings OFF. Never trap a business with customers able to book
-- something it can no longer honour — the same reasoning as W3I's withdrawal
-- carve-out, and it must hold when the tier has expired, when the business is
-- Free, and when a later terms version has not been accepted.
--
-- Services and availability. The agreed Business 2.0 direction is that a
-- business prepares Bookings before upgrading, so configuration stays open and
-- only going live is paid for. (Commercial terms are still required to write
-- them — W3I guards book_services — which is why activation does not repeat
-- that check: a business with anything to book has already accepted.)
--
-- Ordinary Directory updates. Editing a description must not fail because a
-- subscription lapsed, so the guard returns immediately unless the flag itself
-- is changing.
--
-- Existing bookings. This fires on INSERT only. A lapsed business must still
-- see, complete and cancel what it already took — those are obligations, not
-- exposure.

-- ── 1. Activation: false → true needs current Pro ──────────────────────────
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

  if not public.business_meets_tier(new.id, 'pro') then
    raise exception 'Taking bookings needs a Pro plan. Your services and opening times are saved — switch bookings on once your plan is active.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.local_businesses_bookings_tier_guard() is
  'Turning accepts_bookings on requires effective Pro-or-better via business_meets_tier. Turning it off is always permitted, and an update that does not touch the flag is never examined.';

drop trigger if exists local_businesses_bookings_tier_guard on public.local_businesses;
create trigger local_businesses_bookings_tier_guard
  before update on public.local_businesses
  for each row execute function public.local_businesses_bookings_tier_guard();

-- ── 2. Transaction backstop: a stale flag buys nothing ─────────────────────
--
-- Modelled on enforce_gift_funded_booking, which already guards this table.
-- INSERT only: managing bookings already taken must survive a lapse.
create or replace function public.book_bookings_tier_guard()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_active boolean;
  v_open   boolean;
begin
  if v_uid is null then
    return new;                       -- server-side creation, already trusted
  end if;

  if exists (
    select 1 from public.profiles p
     where p.id = v_uid and p.role = any (array['admin'::text, 'moderator'::text])
  ) then
    return new;
  end if;

  select is_active, accepts_bookings
    into v_active, v_open
    from public.local_businesses
   where id = new.business_id;

  if not found or not coalesce(v_active, false) then
    raise exception 'This business is not taking bookings.' using errcode = '42501';
  end if;

  if not coalesce(v_open, false) then
    raise exception 'This business is not taking bookings.' using errcode = '42501';
  end if;

  -- The point of the whole exercise: entitlement is checked at the booking,
  -- not inherited from a flag set months ago. A free service is still a Pro
  -- feature — the price of what is booked has never been what is paid for.
  if not public.business_meets_tier(new.business_id, 'pro') then
    raise exception 'This business is not taking bookings.' using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.book_bookings_tier_guard() is
  'A booking may only be created while the business is active, has bookings switched on, and currently meets Pro. Fires on INSERT only so a lapsed business can still manage bookings it already took. Says the same thing whichever check fails — a customer does not need to know a business''s billing state.';

drop trigger if exists book_bookings_tier_guard on public.book_bookings;
create trigger book_bookings_tier_guard
  before insert on public.book_bookings
  for each row execute function public.book_bookings_tier_guard();
