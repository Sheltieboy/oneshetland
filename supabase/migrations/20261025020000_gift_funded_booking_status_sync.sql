-- Booking-kind gifts relied on a client-side update, after createBooking(),
-- to move book_gifts.status from 'claimed' to 'used'. book_gifts has SELECT
-- RLS policies only — no UPDATE policy for the claiming customer — so that
-- update silently affected zero rows every time. Production confirms this:
-- gift abb19ac7-18d4-48d5-810f-3c504e9c7bf0 has a real, fully-reconciled
-- gift-funded booking against it and has sat at status='claimed' ever since.
--
-- Made server-authoritative and atomic with the booking write instead, via a
-- trigger — the same mechanism enforce_gift_funded_booking already uses to
-- validate the booking in the first place, in the same transaction.
--
-- enforce_gift_funded_booking's own comment already states the intended
-- rebooking rule: "A cancelled one does not count, so a cancelled gift
-- booking can be rebooked." A gift that reached 'used' must therefore revert
-- to 'claimed' when its one live booking is cancelled, or that promise would
-- break the moment this bug was fixed (the gift would move to 'used' and
-- then never be spendable again). This does exactly that, and only that —
-- the one-live-booking-per-gift invariant is unchanged, still enforced by
-- enforce_gift_funded_booking's advisory-locked existence check.

create or replace function public.sync_gift_status_with_booking()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.status <> 'cancelled' then
    -- A live gift-funded booking exists: the gift is spent. Idempotent, and
    -- harmless to re-run on later status changes (completed, no_show) that
    -- are still "not cancelled" — the gift is already 'used' by then.
    update public.book_gifts
       set status = 'used', used_at = now()
     where id = new.gift_id
       and status <> 'used';
  else
    -- The gift's one live booking was just cancelled. Free the gift back up
    -- so enforce_gift_funded_booking's own rule ("a cancelled one does not
    -- count") is actually true, not just documented.
    update public.book_gifts
       set status = 'claimed', used_at = null
     where id = new.gift_id
       and status = 'used';
  end if;
  return new;
end;
$function$;

drop trigger if exists sync_gift_status_with_booking on public.book_bookings;
create trigger sync_gift_status_with_booking
  after insert or update of status on public.book_bookings
  for each row
  when (new.gift_id is not null)
  execute function public.sync_gift_status_with_booking();

-- One-time repair: the existing production row is a real, reconciled booking
-- (not a bug to undo), just mislabelled by the client-update that never
-- worked. Bring it into line with what the new trigger would have produced
-- had it existed when this booking was created.
update public.book_gifts
   set status = 'used', used_at = coalesce(used_at, now())
 where id = 'abb19ac7-18d4-48d5-810f-3c504e9c7bf0'
   and status = 'claimed'
   and exists (
     select 1 from public.book_bookings b
      where b.gift_id = book_gifts.id
        and b.status <> 'cancelled'
   );
