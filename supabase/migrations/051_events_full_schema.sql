-- 051_events_full_schema.sql
-- Full Events Calendar module
-- Creates the events table (self-contained; safe to run whether 045 was applied or not)
-- and adds ticketing, updates, check-in infrastructure.

-- ── 1. Events table ─────────────────────────────────────────────────────────────
-- CREATE TABLE IF NOT EXISTS is idempotent — runs cleanly whether 045 was applied or not.

CREATE TABLE IF NOT EXISTS public.events (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organiser_user_id        uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  organiser_business_id    uuid        REFERENCES public.local_businesses(id) ON DELETE SET NULL,
  title                    text        NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  description              text,
  category                 text,
  venue                    text,
  locality                 text,
  lat                      numeric,
  lng                      numeric,
  starts_at                timestamptz NOT NULL,
  ends_at                  timestamptz,
  cover_url                text,
  price_text               text,
  ticket_url               text,
  is_featured              boolean     NOT NULL DEFAULT false,
  is_hidden                boolean     NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS on events (no-op if already enabled)
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

-- Public reads published events; owners read/write their own; admins get all.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='events' AND policyname='events_public_read'
  ) THEN
    EXECUTE $p$
      CREATE POLICY "events_public_read" ON public.events FOR SELECT
        USING (NOT is_hidden OR organiser_user_id = auth.uid()
               OR EXISTS (SELECT 1 FROM public.local_businesses lb WHERE lb.id = organiser_business_id AND lb.owner_id = auth.uid())
               OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'))
    $p$;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='events' AND policyname='events_owner_write'
  ) THEN
    EXECUTE $p$
      CREATE POLICY "events_owner_write" ON public.events FOR ALL
        USING (organiser_user_id = auth.uid()
               OR EXISTS (SELECT 1 FROM public.local_businesses lb WHERE lb.id = organiser_business_id AND lb.owner_id = auth.uid())
               OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'))
    $p$;
  END IF;
END $$;

-- Now add the full-schema columns. ADD COLUMN IF NOT EXISTS is idempotent.
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS status           text        NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','published','cancelled','postponed','archived')),
  ADD COLUMN IF NOT EXISTS doors_open_at    timestamptz,
  ADD COLUMN IF NOT EXISTS capacity         int,
  ADD COLUMN IF NOT EXISTS has_tickets      boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS place_id         text,
  ADD COLUMN IF NOT EXISTS formatted_address text,
  ADD COLUMN IF NOT EXISTS gallery_urls     text[]      NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS video_url        text,
  ADD COLUMN IF NOT EXISTS accessibility_info text,
  ADD COLUMN IF NOT EXISTS age_restriction  text,
  ADD COLUMN IF NOT EXISTS refund_policy    text,
  ADD COLUMN IF NOT EXISTS contact_info     text,
  ADD COLUMN IF NOT EXISTS event_notes      text,
  ADD COLUMN IF NOT EXISTS tickets_sold     int         NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS updated_at       timestamptz NOT NULL DEFAULT now();

-- Keep is_hidden in sync: published=not hidden, everything else=hidden.
-- New events should use status; is_hidden kept for backward compat with concierge.
CREATE OR REPLACE FUNCTION tg_events_sync_hidden()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.is_hidden := (NEW.status <> 'published');
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_events_sync ON public.events;
CREATE TRIGGER tg_events_sync
  BEFORE INSERT OR UPDATE ON public.events
  FOR EACH ROW EXECUTE FUNCTION tg_events_sync_hidden();

-- Extra indices for filtering
CREATE INDEX IF NOT EXISTS idx_events_status    ON public.events(status)   WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_events_business  ON public.events(organiser_business_id);
CREATE INDEX IF NOT EXISTS idx_events_category  ON public.events(category) WHERE NOT is_hidden;

-- ── 2. Event ticket types ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.event_ticket_types (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                 uuid        NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  name                     text        NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  description              text,
  price_pence              int         NOT NULL DEFAULT 0 CHECK (price_pence >= 0),
  quantity_available       int,                    -- null = unlimited
  quantity_sold            int         NOT NULL DEFAULT 0,
  per_order_max            int         NOT NULL DEFAULT 10,
  sale_starts_at           timestamptz,
  sale_ends_at             timestamptz,
  is_active                boolean     NOT NULL DEFAULT true,
  requires_attendee_details boolean    NOT NULL DEFAULT false,
  display_order            int         NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticket_types_event ON public.event_ticket_types(event_id);

ALTER TABLE public.event_ticket_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ticket_types_public_read" ON public.event_ticket_types FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.events e WHERE e.id = event_id AND NOT e.is_hidden
  ));

CREATE POLICY "ticket_types_owner_all" ON public.event_ticket_types FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.events e
    JOIN public.local_businesses lb ON lb.id = e.organiser_business_id
    WHERE e.id = event_id AND lb.owner_id = auth.uid()
  ) OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

-- ── 3. Event ticket orders ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.event_ticket_orders (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                 uuid        NOT NULL REFERENCES public.events(id),
  buyer_id                 uuid        NOT NULL REFERENCES public.profiles(id),
  stripe_payment_intent_id text        UNIQUE,
  status                   text        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','cancelled','refunded')),
  total_pence              int         NOT NULL DEFAULT 0,
  platform_fee_pence       int         NOT NULL DEFAULT 0,
  tickets_count            int         NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now(),
  paid_at                  timestamptz,
  cancelled_at             timestamptz
);

CREATE INDEX IF NOT EXISTS idx_ticket_orders_buyer   ON public.event_ticket_orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_ticket_orders_event   ON public.event_ticket_orders(event_id);
CREATE INDEX IF NOT EXISTS idx_ticket_orders_stripe  ON public.event_ticket_orders(stripe_payment_intent_id);

ALTER TABLE public.event_ticket_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ticket_orders_buyer_read" ON public.event_ticket_orders FOR SELECT
  USING (buyer_id = auth.uid() OR EXISTS (
    SELECT 1 FROM public.events e
    JOIN public.local_businesses lb ON lb.id = e.organiser_business_id
    WHERE e.id = event_id AND lb.owner_id = auth.uid()
  ) OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

CREATE POLICY "ticket_orders_buyer_insert" ON public.event_ticket_orders FOR INSERT
  WITH CHECK (buyer_id = auth.uid());

-- ── 4. Individual event tickets ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.event_tickets (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                 uuid        NOT NULL REFERENCES public.event_ticket_orders(id),
  event_id                 uuid        NOT NULL REFERENCES public.events(id),
  ticket_type_id           uuid        NOT NULL REFERENCES public.event_ticket_types(id),
  holder_id                uuid        NOT NULL REFERENCES public.profiles(id),
  -- Security: raw token lives only in QR code; hash stored here
  validation_token_hash    text        NOT NULL UNIQUE,
  backup_code              text        NOT NULL UNIQUE,
  -- Status
  status                   text        NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment','valid','used','cancelled','refunded')),
  -- Optional attendee details
  attendee_name            text,
  attendee_email           text,
  attendee_notes           text,
  -- Check-in
  checked_in_at            timestamptz,
  checked_in_by            uuid        REFERENCES public.profiles(id),
  -- Purchase snapshot (title, venue, date at time of purchase — survives edits)
  price_pence              int         NOT NULL DEFAULT 0,
  event_snapshot           jsonb       NOT NULL DEFAULT '{}',
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_tickets_holder     ON public.event_tickets(holder_id);
CREATE INDEX IF NOT EXISTS idx_event_tickets_event      ON public.event_tickets(event_id);
CREATE INDEX IF NOT EXISTS idx_event_tickets_order      ON public.event_tickets(order_id);
CREATE INDEX IF NOT EXISTS idx_event_tickets_token_hash ON public.event_tickets(validation_token_hash);
CREATE INDEX IF NOT EXISTS idx_event_tickets_backup     ON public.event_tickets(backup_code);

ALTER TABLE public.event_tickets ENABLE ROW LEVEL SECURITY;

-- Holder sees own tickets
CREATE POLICY "event_tickets_holder_read" ON public.event_tickets FOR SELECT
  USING (holder_id = auth.uid());

-- Business owner sees tickets for their events
CREATE POLICY "event_tickets_owner_read" ON public.event_tickets FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.events e
    JOIN public.local_businesses lb ON lb.id = e.organiser_business_id
    WHERE e.id = event_id AND lb.owner_id = auth.uid()
  ));

-- Admins see everything
CREATE POLICY "event_tickets_admin_all" ON public.event_tickets FOR ALL
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

-- ── 5. Event updates / announcements ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.event_updates (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid        NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  author_id   uuid        NOT NULL REFERENCES public.profiles(id),
  title       text        NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  body        text        NOT NULL,
  kind        text        NOT NULL DEFAULT 'info'
    CHECK (kind IN ('info','urgent','cancellation','venue_change','time_change','weather','entry_info')),
  is_urgent   boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_updates_event ON public.event_updates(event_id);

ALTER TABLE public.event_updates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "event_updates_public_read" ON public.event_updates FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.events e WHERE e.id = event_id
    AND (NOT e.is_hidden OR EXISTS (
      SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','moderator')
    ))
  ));

CREATE POLICY "event_updates_owner_write" ON public.event_updates FOR INSERT
  WITH CHECK (
    author_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.events e
      JOIN public.local_businesses lb ON lb.id = e.organiser_business_id
      WHERE e.id = event_id AND lb.owner_id = auth.uid()
    )
  );

CREATE POLICY "event_updates_admin_all" ON public.event_updates FOR ALL
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

-- ── 6. Event check-in log ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.event_checkins (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   uuid        NOT NULL REFERENCES public.event_tickets(id),
  event_id    uuid        NOT NULL REFERENCES public.events(id),
  scanner_id  uuid        NOT NULL REFERENCES public.profiles(id),
  result      text        NOT NULL
    CHECK (result IN ('valid','already_used','wrong_event','cancelled','refunded','not_found','payment_incomplete','invalid_token')),
  scanned_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_checkins_event  ON public.event_checkins(event_id);
CREATE INDEX IF NOT EXISTS idx_checkins_ticket ON public.event_checkins(ticket_id);

ALTER TABLE public.event_checkins ENABLE ROW LEVEL SECURITY;

CREATE POLICY "event_checkins_owner_read" ON public.event_checkins FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.events e
    JOIN public.local_businesses lb ON lb.id = e.organiser_business_id
    WHERE e.id = event_id AND lb.owner_id = auth.uid()
  ) OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

CREATE POLICY "event_checkins_scanner_insert" ON public.event_checkins FOR INSERT
  WITH CHECK (scanner_id = auth.uid());

-- ── 7. Backup code generator ────────────────────────────────────────────────────
-- Generates a unique 9-char code in XXXX-XXXX format (no 0/O/1/I/L ambiguous chars).

CREATE OR REPLACE FUNCTION generate_ticket_backup_code()
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  code     text;
  part1    text := '';
  part2    text := '';
  i        int;
BEGIN
  LOOP
    part1 := ''; part2 := '';
    FOR i IN 1..4 LOOP
      part1 := part1 || substr(alphabet, floor(random() * 32 + 1)::int, 1);
    END LOOP;
    FOR i IN 1..4 LOOP
      part2 := part2 || substr(alphabet, floor(random() * 32 + 1)::int, 1);
    END LOOP;
    code := part1 || '-' || part2;
    IF NOT EXISTS (SELECT 1 FROM public.event_tickets WHERE backup_code = code) THEN
      RETURN code;
    END IF;
  END LOOP;
END;
$$;

-- ── 8. Server-side ticket validation + check-in ─────────────────────────────────
-- Called by the validate-event-ticket edge function (SECURITY DEFINER to bypass
-- ticket RLS — the function enforces business ownership before mutating).

CREATE OR REPLACE FUNCTION validate_and_checkin_ticket(
  p_raw_token  text,
  p_event_id   uuid,
  p_scanner_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  token_hash  text;
  ticket      record;
  event_biz   uuid;
  owns_event  boolean;
BEGIN
  -- Hash the raw token to find the DB record.
  token_hash := encode(sha256(p_raw_token::bytea), 'hex');

  SELECT t.* INTO ticket
    FROM public.event_tickets t
    WHERE t.validation_token_hash = token_hash;

  IF NOT FOUND THEN
    -- Log the failed scan attempt (ticket_id stays NULL for not_found).
    INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result)
    VALUES (gen_random_uuid(), p_event_id, p_scanner_id, 'not_found');
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  -- Verify scanner owns the event.
  SELECT lb.owner_id = p_scanner_id INTO owns_event
    FROM public.events e
    JOIN public.local_businesses lb ON lb.id = e.organiser_business_id
    WHERE e.id = ticket.event_id;

  IF NOT owns_event THEN
    -- Also check admin role.
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_scanner_id AND role = 'admin') THEN
      RETURN jsonb_build_object('result', 'wrong_event', 'message', 'This ticket does not belong to your event.');
    END IF;
  END IF;

  -- Check event match.
  IF ticket.event_id <> p_event_id THEN
    INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result)
    VALUES (ticket.id, p_event_id, p_scanner_id, 'wrong_event');
    RETURN jsonb_build_object('result', 'wrong_event');
  END IF;

  -- Check status.
  IF ticket.status = 'pending_payment' THEN
    INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result)
    VALUES (ticket.id, p_event_id, p_scanner_id, 'payment_incomplete');
    RETURN jsonb_build_object('result', 'payment_incomplete');
  END IF;

  IF ticket.status = 'used' THEN
    INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result)
    VALUES (ticket.id, p_event_id, p_scanner_id, 'already_used');
    RETURN jsonb_build_object(
      'result',        'already_used',
      'checked_in_at', ticket.checked_in_at,
      'attendee_name', ticket.attendee_name
    );
  END IF;

  IF ticket.status IN ('cancelled','refunded') THEN
    INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result)
    VALUES (ticket.id, p_event_id, p_scanner_id, ticket.status::text);
    RETURN jsonb_build_object('result', ticket.status);
  END IF;

  -- All clear — mark as used and log the successful check-in.
  UPDATE public.event_tickets
  SET status = 'used', checked_in_at = now(), checked_in_by = p_scanner_id
  WHERE id = ticket.id;

  INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result)
  VALUES (ticket.id, p_event_id, p_scanner_id, 'valid');

  RETURN jsonb_build_object(
    'result',          'valid',
    'ticket_id',       ticket.id,
    'attendee_name',   ticket.attendee_name,
    'ticket_type_id',  ticket.ticket_type_id,
    'price_pence',     ticket.price_pence,
    'event_snapshot',  ticket.event_snapshot
  );
END;
$$;

GRANT EXECUTE ON FUNCTION validate_and_checkin_ticket(text, uuid, uuid) TO authenticated;

-- ── 9. Scanner stats RPC ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_event_scanner_stats(p_event_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT jsonb_build_object(
    'tickets_sold',     COALESCE((SELECT COUNT(*) FROM event_tickets WHERE event_id = p_event_id AND status IN ('valid','used')), 0),
    'checked_in',       COALESCE((SELECT COUNT(*) FROM event_tickets WHERE event_id = p_event_id AND status = 'used'), 0),
    'pending_payment',  COALESCE((SELECT COUNT(*) FROM event_tickets WHERE event_id = p_event_id AND status = 'pending_payment'), 0)
  );
$$;

GRANT EXECUTE ON FUNCTION get_event_scanner_stats(uuid) TO authenticated;

-- ── 10. Also validate via backup code ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION validate_backup_code(
  p_backup_code text,
  p_event_id    uuid,
  p_scanner_id  uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  raw_token text;
BEGIN
  SELECT t.id::text INTO raw_token
    FROM public.event_tickets t
    WHERE upper(trim(t.backup_code)) = upper(trim(p_backup_code));

  IF NOT FOUND THEN
    INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result)
    VALUES (gen_random_uuid(), p_event_id, p_scanner_id, 'not_found');
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  -- Re-use the main validation path (passes ticket ID as the fake token — handled below).
  RETURN validate_and_checkin_ticket_by_id(raw_token::uuid, p_event_id, p_scanner_id);
END;
$$;

-- Helper: same as validate_and_checkin_ticket but looks up by ticket ID instead of hash.
CREATE OR REPLACE FUNCTION validate_and_checkin_ticket_by_id(
  p_ticket_id  uuid,
  p_event_id   uuid,
  p_scanner_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  ticket     record;
  owns_event boolean;
BEGIN
  SELECT * INTO ticket FROM public.event_tickets WHERE id = p_ticket_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  SELECT lb.owner_id = p_scanner_id INTO owns_event
    FROM public.events e
    JOIN public.local_businesses lb ON lb.id = e.organiser_business_id
    WHERE e.id = ticket.event_id;

  IF NOT owns_event AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_scanner_id AND role = 'admin') THEN
    RETURN jsonb_build_object('result', 'wrong_event', 'message', 'This ticket does not belong to your event.');
  END IF;

  IF ticket.event_id <> p_event_id THEN
    INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result) VALUES(ticket.id, p_event_id, p_scanner_id, 'wrong_event');
    RETURN jsonb_build_object('result', 'wrong_event');
  END IF;

  IF ticket.status = 'pending_payment' THEN
    INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result) VALUES(ticket.id, p_event_id, p_scanner_id, 'payment_incomplete');
    RETURN jsonb_build_object('result', 'payment_incomplete');
  END IF;

  IF ticket.status = 'used' THEN
    INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result) VALUES(ticket.id, p_event_id, p_scanner_id, 'already_used');
    RETURN jsonb_build_object('result', 'already_used', 'checked_in_at', ticket.checked_in_at, 'attendee_name', ticket.attendee_name);
  END IF;

  IF ticket.status IN ('cancelled','refunded') THEN
    INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result) VALUES(ticket.id, p_event_id, p_scanner_id, ticket.status::text);
    RETURN jsonb_build_object('result', ticket.status);
  END IF;

  UPDATE public.event_tickets SET status = 'used', checked_in_at = now(), checked_in_by = p_scanner_id WHERE id = ticket.id;
  INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result) VALUES(ticket.id, p_event_id, p_scanner_id, 'valid');

  RETURN jsonb_build_object(
    'result', 'valid', 'ticket_id', ticket.id,
    'attendee_name', ticket.attendee_name, 'ticket_type_id', ticket.ticket_type_id,
    'price_pence', ticket.price_pence, 'event_snapshot', ticket.event_snapshot
  );
END;
$$;

GRANT EXECUTE ON FUNCTION validate_backup_code(text, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION validate_and_checkin_ticket_by_id(uuid, uuid, uuid) TO authenticated;

-- ── 11. Atomically decrement ticket type quantity (prevents overselling) ────────

CREATE OR REPLACE FUNCTION reserve_ticket_slots(
  p_type_id uuid,
  p_quantity int
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  available int;
  sold      int;
BEGIN
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

GRANT EXECUTE ON FUNCTION reserve_ticket_slots(uuid, int) TO service_role;
