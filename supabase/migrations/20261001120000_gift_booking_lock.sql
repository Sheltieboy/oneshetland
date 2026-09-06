-- ============================================================================
-- The gift rule stops depending on a lock in another file.
--
-- WHAT IS WRONG
--
-- enforce_gift_funded_booking allows one live booking per gift with a bare
-- EXISTS, taking no lock on the gift and none on the bookings it counts. That
-- is a check-then-act. Proved in an isolated PostgreSQL 17 cluster: with this
-- trigger alone, two concurrent bookings against one claimed gift BOTH
-- succeed — two live bookings, nothing refused.
--
-- It is not exploitable in production, and the reason has nothing to do with
-- gifts. book_capacity_guard takes pg_advisory_xact_lock on
-- 'book_capacity:' || service_id and fires first, because triggers run
-- alphabetically and book_capacity_guard sorts before this one. A gift is
-- pinned to a single service by gift_service_mismatch, so two bookings funded
-- by one gift are always for the same service and always queue behind that
-- lock.
--
-- So a rule in this file is held up by three things written elsewhere for
-- another purpose: that lock's key, the trigger ordering, and the service
-- pinning. Re-key the capacity lock and this silently opens. There is also a
-- narrow bypass today: book_capacity_guard returns early unless the status is
-- confirmed or pending_payment, so two concurrent inserts at any other status
-- take no lock at all. The application never does that; nothing stops it.
--
-- THE CHANGE
--
-- One line. An advisory lock keyed on the GIFT, taken immediately before the
-- count it protects. Nothing else moves: the same checks in the same order,
-- the same exceptions, the same errcodes, the same trigger definition.
--
-- Keyed on the gift alone and not on the service, so two different gifts never
-- wait on each other — the invariant is per-gift, and so is the lock.
--
-- WHAT IS DELIBERATELY UNCHANGED
--
-- One-live-booking semantics: a cancelled booking still does not count, so a
-- cancelled gift booking can still be rebooked, and a completed or no-show one
-- still holds the gift. book_capacity_guard, the trigger ordering,
-- gift_service_mismatch, ordinary paid bookings, unit gifts and every payment
-- path are all untouched. This is additive belt to an existing pair of braces.
-- ============================================================================

begin;

-- Body identical to 20260824140000 except for the advisory lock.
create or replace function public.enforce_gift_funded_booking()
returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_gift public.book_gifts%rowtype;
begin
  if new.gift_id is null then
    return new;  -- an ordinary paid booking; nothing to check
  end if;

  select * into v_gift from public.book_gifts where id = new.gift_id;
  if not found then
    raise exception 'gift_not_found' using errcode = '42501';
  end if;

  if v_gift.kind <> 'booking' then
    raise exception 'gift_not_a_booking_gift' using errcode = '42501';
  end if;

  if v_gift.claimed_by_user_id is null then
    raise exception 'gift_not_claimed' using errcode = '42501';
  end if;

  -- The spender must be the claimant. Not "someone signed in".
  if new.customer_id is distinct from v_gift.claimed_by_user_id then
    raise exception 'gift_not_yours' using errcode = '42501';
  end if;

  -- It funds the service it was bought for, at that business, and no other.
  if new.service_id is distinct from v_gift.service_id then
    raise exception 'gift_service_mismatch' using errcode = '42501';
  end if;
  if new.business_id is distinct from v_gift.business_id then
    raise exception 'gift_business_mismatch' using errcode = '42501';
  end if;

  if v_gift.status in ('pending_payment', 'cancelled') then
    raise exception 'gift_not_spendable' using errcode = '42501';
  end if;
  if v_gift.expires_at is not null and v_gift.expires_at < now() then
    raise exception 'gift_expired' using errcode = '42501';
  end if;

  -- Serialise every attempt to spend THIS gift, before the count below reads
  -- anything. Keyed on the gift alone, so two different gifts never wait on
  -- each other. Transaction-scoped: released on commit or rollback, so a
  -- refused booking leaves nothing wedged.
  perform pg_advisory_xact_lock(
    hashtextextended('gift_booking:' || new.gift_id::text, 0));

  -- One live booking per gift. A cancelled one does not count, so a cancelled
  -- gift booking can be rebooked.
  if exists (
    select 1 from public.book_bookings b
     where b.gift_id = new.gift_id
       and b.id is distinct from new.id
       and b.status <> 'cancelled'
  ) then
    raise exception 'gift_already_booked' using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_gift_funded_booking on public.book_bookings;
create trigger enforce_gift_funded_booking
  before insert or update of gift_id, service_id, business_id, customer_id
  on public.book_bookings
  for each row execute function public.enforce_gift_funded_booking();

comment on function public.enforce_gift_funded_booking() is
  'One live booking per gift, serialised by a gift-scoped advisory transaction lock so the rule holds on its own rather than depending on book_capacity_guard firing first with a service-scoped lock.';

commit;
