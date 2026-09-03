-- Who may move a booking, and when.
--
-- WHAT WAS WRONG
--
-- Nothing governed the status column beyond a CHECK listing its values. Two
-- consequences, both found during the booking end-to-end:
--
--   An owner could mark next week's appointment completed. Capacity counts
--   only confirmed and pending_payment, so a future booking marked completed
--   stopped holding its place and the slot was quietly bookable again. That is
--   how one 09:30 slot came to hold two bookings for a capacity-1 service.
--
--   A customer holds UPDATE on status (the grant is column-level: status,
--   cancelled_at, cancelled_by) and the RLS policy checks only that the row is
--   theirs. Its comment says "e.g. cancel", but nothing enforced the "e.g." —
--   a customer could set their own booking to completed or no_show, releasing
--   the place while their own screen still called it upcoming.
--
-- The UI offered neither. That is exactly the point: a UI guard is a courtesy,
-- and PostgREST is a public API.
--
-- WHO IS WHO
--
-- auth.uid() is null means a server-side or service-role write, already
-- trusted — the same test book_bookings_tier_guard uses, kept identical on
-- purpose so the two guards cannot disagree about what "trusted" means.
-- Admins and moderators are exempt, as they are there.
--
-- WHAT IS ALLOWED
--
--   owner     -> cancelled any time; completed or no_show only once the
--                appointment has started. Not once it has ENDED: an owner
--                finishing early and marking it done is ordinary, and the
--                product has never required otherwise.
--   customer  -> cancelled, and nothing else. That is the only transition any
--                customer surface offers, on web or mobile.
--   trusted   -> anything. Payment confirmation, metering and reminders must
--                keep working, and they do not sign in.
--
-- Updates that do not change status are not governed at all, so metering
-- writes and reminder stamps never reach this code.

create or replace function public.book_booking_transition_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_is_owner boolean;
begin
  -- Only a CHANGE of status is governed. A metering write on a confirmed
  -- booking is not a transition and must not pay for these lookups.
  if new.status is not distinct from old.status then
    return new;
  end if;

  -- Server-side/service-role: already trusted. Same test as the tier guard.
  if v_uid is null then
    return new;
  end if;

  if exists (
    select 1 from public.profiles p
     where p.id = v_uid and p.role = any (array['admin'::text, 'moderator'::text])
  ) then
    return new;
  end if;

  v_is_owner := exists (
    select 1 from public.local_businesses b
     where b.id = new.business_id and b.owner_id = v_uid);

  if v_is_owner then
    -- An appointment that has not started cannot have been attended or missed.
    if new.status in ('completed', 'no_show') and new.starts_at > now() then
      raise exception
        'booking_not_started: a booking cannot be marked % before it starts', new.status
        using errcode = '22023';
    end if;
    return new;
  end if;

  if new.customer_id = v_uid then
    if new.status <> 'cancelled' then
      raise exception
        'booking_customer_may_only_cancel: a customer may cancel their booking, not mark it %',
        new.status
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- RLS should already have stopped this. Say so anyway rather than assume it.
  raise exception 'booking_not_yours: only the customer or the business may move this booking'
    using errcode = '42501';
end;
$$;

revoke all on function public.book_booking_transition_guard() from public, anon, authenticated;

-- UPDATE only: inserts are governed by book_bookings_tier_guard and
-- book_capacity_guard, and this has nothing to say about a booking being made.
-- Alphabetically first among the BEFORE UPDATE triggers, so an illegal
-- transition is refused before anyone waits on the capacity lock.
drop trigger if exists book_booking_transition_guard on public.book_bookings;
create trigger book_booking_transition_guard
  before update on public.book_bookings
  for each row execute function public.book_booking_transition_guard();
