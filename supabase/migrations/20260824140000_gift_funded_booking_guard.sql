-- A gift pays for the thing it was bought for, for the person who claimed it.
--
-- WHAT WAS WRONG
--
-- book_bookings.gift_id was written straight from the client. The only rule on
-- the table was "Customers create their own bookings" (customer_id =
-- auth.uid()) — nothing whatsoever looked at the gift. Both of these were
-- reproduced against production on disposable data before this was written:
--
--   1. A signed-in stranger inserted a booking carrying SOMEBODY ELSE'S
--      gift_id with deposit_pence 0. HTTP 201. A free haircut on another
--      person's gift.
--
--   2. The rightful claimant of a £45 gift used its gift_id to book a
--      DIFFERENT service. HTTP 201. The gift funded something it was never
--      bought for.
--
-- Client screens never offered either, which is exactly why it needed fixing
-- here: "the button is hidden" is not an authorisation boundary.
--
-- THE RULE
--
-- A booking may carry a gift_id only when all of these hold:
--
--   · the gift is a BOOKING gift that has actually been claimed
--   · the booking's customer IS the claimant
--   · the booking's service and business are the gift's own
--   · the gift is not cancelled, unpaid or expired
--   · no other live booking is already spending it
--
-- customer_id rather than auth.uid() is compared on purpose: it holds for a
-- service-role insert too, and RLS already pins a client's customer_id to
-- their own auth.uid(), so for a client the two are the same statement.
--
-- REBOOKING AFTER A CANCELLATION is allowed, because the single-use check
-- ignores cancelled bookings. That is the existing shape of the data — a
-- cancelled booking releases the slot — rather than a new policy invented here.
--
-- Nothing about pricing changes. The purchaser paid the service price when they
-- bought the gift; the recipient's deposit is already zeroed by the booking UI
-- and no payment is created on this path.

begin;

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
  'Authorises a gift-funded booking: the customer must be the gift claimant, the service and business must be the gift''s own, the gift must be spendable, and only one live booking may spend it. Reproduced before writing: without this, any signed-in user could book free against another person''s gift_id, and a claimant could redirect a gift to a different service.';

commit;
