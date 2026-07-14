-- Fix: checking in a ticket failed with
--   insert or update on table "event_checkins" violates foreign key constraint
--   "event_checkins_ticket_id_fkey"
--
-- The not-found scan path logged the failed attempt with a RANDOM ticket_id
-- (gen_random_uuid()), which of course doesn't exist in event_tickets → FK
-- violation. The intent (per the code comment) was a NULL ticket_id, but the
-- column was NOT NULL. Make ticket_id nullable and log NULL for not-found scans.

alter table public.event_checkins alter column ticket_id drop not null;

-- ── validate_and_checkin_ticket (raw QR token path) ──────────────────────────
create or replace function public.validate_and_checkin_ticket(p_raw_token text, p_event_id uuid, p_scanner_id uuid) returns jsonb
    language plpgsql security definer
    as $$
DECLARE
  token_hash  text;
  ticket      record;
  owns_event  boolean;
BEGIN
  token_hash := encode(sha256(p_raw_token::bytea), 'hex');

  SELECT t.* INTO ticket
    FROM public.event_tickets t
    WHERE t.validation_token_hash = token_hash;

  IF NOT FOUND THEN
    INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result)
    VALUES (NULL, p_event_id, p_scanner_id, 'not_found');
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  SELECT lb.owner_id = p_scanner_id INTO owns_event
    FROM public.events e
    JOIN public.local_businesses lb ON lb.id = e.organiser_business_id
    WHERE e.id = ticket.event_id;

  IF NOT owns_event THEN
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_scanner_id AND role = 'admin') THEN
      RETURN jsonb_build_object('result', 'wrong_event', 'message', 'This ticket does not belong to your event.');
    END IF;
  END IF;

  IF ticket.event_id <> p_event_id THEN
    INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result)
    VALUES (ticket.id, p_event_id, p_scanner_id, 'wrong_event');
    RETURN jsonb_build_object('result', 'wrong_event');
  END IF;

  IF ticket.status = 'pending_payment' THEN
    INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result)
    VALUES (ticket.id, p_event_id, p_scanner_id, 'payment_incomplete');
    RETURN jsonb_build_object('result', 'payment_incomplete');
  END IF;

  IF ticket.status = 'used' THEN
    INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result)
    VALUES (ticket.id, p_event_id, p_scanner_id, 'already_used');
    RETURN jsonb_build_object('result', 'already_used', 'checked_in_at', ticket.checked_in_at, 'attendee_name', ticket.attendee_name);
  END IF;

  IF ticket.status IN ('cancelled','refunded') THEN
    INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result)
    VALUES (ticket.id, p_event_id, p_scanner_id, ticket.status::text);
    RETURN jsonb_build_object('result', ticket.status);
  END IF;

  UPDATE public.event_tickets
  SET status = 'used', checked_in_at = now(), checked_in_by = p_scanner_id
  WHERE id = ticket.id;

  INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result)
  VALUES (ticket.id, p_event_id, p_scanner_id, 'valid');

  RETURN jsonb_build_object(
    'result', 'valid', 'ticket_id', ticket.id, 'attendee_name', ticket.attendee_name,
    'ticket_type_id', ticket.ticket_type_id, 'price_pence', ticket.price_pence, 'event_snapshot', ticket.event_snapshot
  );
END;
$$;

-- ── validate_backup_code (manual XXXX-XXXX code path) ─────────────────────────
create or replace function public.validate_backup_code(p_backup_code text, p_event_id uuid, p_scanner_id uuid) returns jsonb
    language plpgsql security definer
    as $$
DECLARE
  raw_token text;
BEGIN
  -- Normalise BOTH sides (strip dashes/spaces, upper-case) — stored codes look
  -- like "VN27-ZVVQ" but the scanner sends them de-dashed ("VN27ZVVQ").
  SELECT t.id::text INTO raw_token
    FROM public.event_tickets t
    WHERE regexp_replace(upper(t.backup_code), '[^A-Z0-9]', '', 'g')
        = regexp_replace(upper(p_backup_code), '[^A-Z0-9]', '', 'g');

  IF NOT FOUND THEN
    INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result)
    VALUES (NULL, p_event_id, p_scanner_id, 'not_found');
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  RETURN validate_and_checkin_ticket_by_id(raw_token::uuid, p_event_id, p_scanner_id);
END;
$$;
