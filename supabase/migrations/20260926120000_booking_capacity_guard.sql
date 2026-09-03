-- Booking capacity, enforced where it cannot be talked out of.
--
-- WHAT WAS WRONG
--
-- Nothing stopped a service being overbooked. Both clients did this:
--
--   const free = await isSlotAvailable(...);   -- read,  its own transaction
--   if (!free) throw ...;
--   await sb.from('book_bookings').insert(...) -- write, its own transaction
--
-- A counting SELECT takes no locks, so two customers read the same count and
-- both proceed. Reproduced against an isolated capacity-1 fixture: two
-- sessions both saw taken=0, both inserted, 127 ms apart, two confirmed
-- bookings on one place. book_bookings had no unique index, no exclusion
-- constraint and no trigger that looked at capacity.
--
-- WHY A TRIGGER AND NOT AN RPC
--
-- An RPC only protects callers who use it. Installed mobile builds insert
-- straight into the table through PostgREST and will keep doing so for as long
-- as they are in people's pockets, and RLS permits that insert by design. The
-- invariant has to live at the table, or it does not hold.
--
-- WHY THE LOCK IS KEYED ON THE SERVICE, NOT THE START TIME
--
-- Two bookings overlap without starting together: 10:00-10:30 and 10:15-10:45
-- compete for the same place. A lock keyed on starts_at would put those two in
-- different queues and let both through. The service is the smallest key that
-- is guaranteed to cover every attempt that could overlap.
--
-- WHY SECURITY DEFINER
--
-- RLS shows a customer only their own bookings. A guard running as the caller
-- would count one row where there are three and fail open, which is worse than
-- no guard at all because it would look like one.
--
-- SEMANTICS ARE COPIED, NOT CHOSEN
--
-- Active statuses (confirmed, pending_payment) and the overlap test
-- (existing.starts_at < new.ends_at AND existing.ends_at > new.starts_at) are
-- lifted from isSlotAvailable() so that the database agrees with the screen.
-- completed, cancelled and no_show free the place, exactly as today.
-- buffer_minutes is deliberately absent: it is applied when slots are
-- GENERATED, never to stored ends_at, and this guard is not the place to
-- change that.

create or replace function public.book_capacity_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_capacity integer;
  v_taken    integer;
begin
  -- Only a place-consuming row can breach capacity.
  if new.status not in ('confirmed', 'pending_payment') then
    return new;
  end if;

  -- An UPDATE that leaves an already-consuming booking on the same service at
  -- the same time consumes nothing new — metering writes and owner edits must
  -- not pay for a lock or be refused by a count that includes themselves.
  if TG_OP = 'UPDATE'
     and old.status in ('confirmed', 'pending_payment')
     and old.service_id is not distinct from new.service_id
     and old.starts_at  is not distinct from new.starts_at
     and old.ends_at    is not distinct from new.ends_at then
    return new;
  end if;

  -- Serialise every competing attempt for this service, including attempts
  -- that start at different times. Transaction-scoped: released on commit or
  -- rollback, so a failed insert never leaves the service wedged.
  perform pg_advisory_xact_lock(
    hashtextextended('book_capacity:' || new.service_id::text, 0));

  select s.capacity into v_capacity
    from public.book_services s where s.id = new.service_id;
  v_capacity := greatest(coalesce(v_capacity, 1), 1);

  select count(*) into v_taken
    from public.book_bookings b
   where b.service_id = new.service_id
     and b.id is distinct from new.id            -- an UPDATE must not count itself
     and b.status in ('confirmed', 'pending_payment')
     and b.starts_at < new.ends_at
     and b.ends_at   > new.starts_at;

  if v_taken >= v_capacity then
    -- 23505 so PostgREST answers 409 rather than 500; the token is what the
    -- clients match on to say "that slot just went" instead of showing this.
    raise exception 'slot_full: % of % places already taken for this service and time',
      v_taken, v_capacity
      using errcode = '23505';
  end if;

  return new;
end;
$$;

revoke all on function public.book_capacity_guard() from public, anon, authenticated;

-- Named to sort AFTER book_bookings_tier_guard: a business that may not take
-- bookings at all is refused before anyone waits on a lock. Triggers fire in
-- alphabetical order, so the name is load-bearing.
drop trigger if exists book_capacity_guard on public.book_bookings;
create trigger book_capacity_guard
  before insert or update on public.book_bookings
  for each row execute function public.book_capacity_guard();
