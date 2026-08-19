-- ============================================================================
-- A reservation of -5 tickets sold you -5 tickets, and gave the event five more.
--
-- reserve_ticket_slots only ever asked whether there was ENOUGH room:
--
--   IF available IS NOT NULL AND (available - sold) < p_quantity THEN RETURN false;
--   UPDATE event_ticket_types SET quantity_sold = quantity_sold + p_quantity;
--
-- With p_quantity = -5 the guard is trivially satisfied — there is always more
-- than -5 room — and the update then SUBTRACTS from quantity_sold. Measured on
-- production before this migration, inside a rolled-back transaction:
-- quantity_sold went from 1 to -4.
--
-- The same negative quantity, sent as a line item, made
-- create-event-ticket-intent's basket sum to zero and take its free path with a
-- genuinely priced ticket in it (audit finding H1). That half is fixed in the
-- edge function, which now refuses anything that is not a safe integer >= 1
-- before it touches the database. This migration is the other half: the
-- invariant belongs in the database too, so it holds no matter which caller
-- arrives or how a future edge function is written.
--
-- Not reachable directly by a client today — reserve_ticket_slots is SECURITY
-- INVOKER, so RLS on event_ticket_types filters the row for anyone who is not
-- the organiser and the function returns false without writing. Verified. That
-- makes this defence in depth rather than a second open door, which is the
-- right reason to have it: the one caller that DOES get through, the ticket
-- intent function, runs on the service role and bypasses RLS entirely.
--
-- Raising rather than returning false is deliberate. `false` is the established
-- signal for "sold out", and a bad quantity is not a sold-out event; it is a
-- caller bug or an attack, and it should be loud in the logs instead of
-- indistinguishable from a busy Saturday.
--
-- Nothing else about ticketing changes here. C4 — two concurrent scans of one
-- ticket both returning VALID — is a separate step and validate_and_checkin_ticket
-- is deliberately untouched.
-- ============================================================================

create or replace function public.reserve_ticket_slots(p_type_id uuid, p_quantity integer)
returns boolean
language plpgsql
as $$
DECLARE
  available int;
  sold      int;
BEGIN
  -- The invariant: you may only ever reserve a whole, positive number of seats.
  -- p_quantity is already an integer by signature, so this is the whole of it.
  IF p_quantity IS NULL OR p_quantity < 1 THEN
    RAISE EXCEPTION 'reserve_ticket_slots: quantity must be at least 1 (got %)', p_quantity
      USING ERRCODE = '22023';   -- invalid_parameter_value
  END IF;

  SELECT quantity_available, quantity_sold
    INTO available, sold
    FROM public.event_ticket_types
    WHERE id = p_type_id
    FOR UPDATE;

  IF NOT FOUND THEN RETURN false; END IF;

  -- null = unlimited
  IF available IS NOT NULL AND (available - sold) < p_quantity THEN
    RETURN false;
  END IF;

  UPDATE public.event_ticket_types
     SET quantity_sold = quantity_sold + p_quantity
   WHERE id = p_type_id;

  RETURN true;
END;
$$;

comment on function public.reserve_ticket_slots(uuid, integer) is
  'Atomically holds p_quantity seats against a ticket type, row-locked. Refuses any quantity below 1: a negative reservation used to decrement quantity_sold and invent capacity. Returns false when the type does not exist or is sold out; raises on an invalid quantity, which is a caller bug rather than a sold-out event.';

-- Belt and braces on the column itself, so no future writer — RPC, trigger, or
-- a hand-run UPDATE — can drive the counter below zero. Checked against
-- production first: the minimum quantity_sold across all 16 ticket types is 0,
-- so this validates against existing data.
alter table public.event_ticket_types
  drop constraint if exists event_ticket_types_quantity_sold_non_negative;
alter table public.event_ticket_types
  add constraint event_ticket_types_quantity_sold_non_negative
  check (quantity_sold >= 0);
