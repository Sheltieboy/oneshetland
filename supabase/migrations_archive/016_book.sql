-- ── OneShetland Book ──────────────────────────────────────────────────────────
-- Slot-booking for service businesses (hairdressers, nail bars, restaurants...).
-- Lives inside Local — reuses local_businesses for the business identity.
--
-- Phase 1 tables:
--   1. book_services            — what a business can be booked for
--   2. book_availability_rules  — recurring weekly opening hours
--   3. book_slot_overrides      — one-off opens / closures / last-min openings
--   4. book_bookings            — actual customer bookings
--
-- Plus a flag on local_businesses so we can filter "bookable" in the directory.

-- Flag: this business accepts in-app bookings
ALTER TABLE public.local_businesses
  ADD COLUMN IF NOT EXISTS accepts_bookings BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_local_businesses_bookable
  ON public.local_businesses(id) WHERE accepts_bookings = TRUE AND is_active = TRUE;

-- ── 1. Services ───────────────────────────────────────────────────────────────
-- One row per bookable thing. e.g. "Ladies Cut" / "Pedicure" / "Table for 2".
-- duration_minutes drives slot length. buffer_minutes adds turnaround after.

CREATE TABLE IF NOT EXISTS public.book_services (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL REFERENCES public.local_businesses(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT,
  duration_minutes  INT  NOT NULL CHECK (duration_minutes BETWEEN 5 AND 600),
  buffer_minutes    INT  DEFAULT 0  CHECK (buffer_minutes >= 0),
  price_pence       INT  NOT NULL CHECK (price_pence >= 0),  -- 0 = price on request
  deposit_pence     INT  DEFAULT 0 CHECK (deposit_pence >= 0),
  requires_deposit  BOOLEAN DEFAULT FALSE,
  category          TEXT,           -- free-form: "haircut", "colour", "manicure"...
  display_order     INT DEFAULT 0,
  is_active         BOOLEAN DEFAULT TRUE,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_book_services_business
  ON public.book_services(business_id) WHERE is_active = TRUE;

ALTER TABLE public.book_services ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read active services"
  ON public.book_services FOR SELECT
  USING (is_active = TRUE OR business_id IN (
    SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()
  ));

CREATE POLICY "Business owners manage their services"
  ON public.book_services FOR ALL
  USING (business_id IN (SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()))
  WITH CHECK (business_id IN (SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()));

-- ── 2. Recurring weekly availability ─────────────────────────────────────────
-- e.g. "Tuesdays 09:00–17:30, 30-min slots, all services"
-- service_id IS NULL  →  applies to all of the business's services
-- service_id IS set   →  applies only to that one service

CREATE TABLE IF NOT EXISTS public.book_availability_rules (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           UUID NOT NULL REFERENCES public.local_businesses(id) ON DELETE CASCADE,
  service_id            UUID REFERENCES public.book_services(id) ON DELETE CASCADE,
  day_of_week           INT  NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),  -- 0=Sun … 6=Sat
  start_time            TIME NOT NULL,
  end_time              TIME NOT NULL,
  slot_interval_minutes INT  DEFAULT 30 CHECK (slot_interval_minutes BETWEEN 5 AND 240),
  is_active             BOOLEAN DEFAULT TRUE,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_book_avail_business_day
  ON public.book_availability_rules(business_id, day_of_week) WHERE is_active = TRUE;

ALTER TABLE public.book_availability_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read availability rules"
  ON public.book_availability_rules FOR SELECT
  USING (true);

CREATE POLICY "Business owners manage their availability"
  ON public.book_availability_rules FOR ALL
  USING (business_id IN (SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()))
  WITH CHECK (business_id IN (SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()));

-- ── 3. One-off slot overrides ────────────────────────────────────────────────
-- Three flavours:
--   'open'     → add bookable time outside the normal weekly schedule (holiday opening)
--   'closed'   → remove bookable time (one-off closure, holiday, sick day)
--   'last_min' → like 'open' but flagged for the last-minute feed (Phase 4)

CREATE TABLE IF NOT EXISTS public.book_slot_overrides (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL REFERENCES public.local_businesses(id) ON DELETE CASCADE,
  service_id   UUID REFERENCES public.book_services(id) ON DELETE CASCADE,  -- NULL = all
  starts_at    TIMESTAMPTZ NOT NULL,
  ends_at      TIMESTAMPTZ NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('open', 'closed', 'last_min')),
  notes        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_book_overrides_business_time
  ON public.book_slot_overrides(business_id, starts_at);

CREATE INDEX IF NOT EXISTS idx_book_overrides_last_min
  ON public.book_slot_overrides(starts_at) WHERE type = 'last_min';

ALTER TABLE public.book_slot_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read overrides"
  ON public.book_slot_overrides FOR SELECT
  USING (true);

CREATE POLICY "Business owners manage their overrides"
  ON public.book_slot_overrides FOR ALL
  USING (business_id IN (SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()))
  WITH CHECK (business_id IN (SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()));

-- ── 4. Bookings ──────────────────────────────────────────────────────────────
-- Price/deposit snapshot taken at booking time so later price changes on the
-- service don't mutate historic bookings.

CREATE TABLE IF NOT EXISTS public.book_bookings (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id                UUID NOT NULL REFERENCES public.local_businesses(id) ON DELETE CASCADE,
  service_id                 UUID NOT NULL REFERENCES public.book_services(id),
  customer_id                UUID NOT NULL REFERENCES public.profiles(id),
  starts_at                  TIMESTAMPTZ NOT NULL,
  ends_at                    TIMESTAMPTZ NOT NULL,
  status                     TEXT NOT NULL DEFAULT 'confirmed' CHECK (
    status IN ('pending_payment', 'confirmed', 'cancelled', 'no_show', 'completed')
  ),
  price_pence                INT NOT NULL,
  deposit_pence              INT DEFAULT 0,
  deposit_payment_intent_id  TEXT,
  deposit_paid_at            TIMESTAMPTZ,
  cancelled_at               TIMESTAMPTZ,
  cancelled_by               UUID REFERENCES public.profiles(id),
  notes                      TEXT,
  created_at                 TIMESTAMPTZ DEFAULT NOW(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_book_bookings_business_time
  ON public.book_bookings(business_id, starts_at);

CREATE INDEX IF NOT EXISTS idx_book_bookings_customer
  ON public.book_bookings(customer_id, starts_at DESC);

-- Prevent two bookings overlapping for the same service.
-- A partial unique index won't quite do this (overlaps), so we use an
-- application-level check in Phase 2's booking creation flow. (We can add
-- a btree_gist exclusion constraint later if drift becomes a real problem.)

ALTER TABLE public.book_bookings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Customers see their own bookings"
  ON public.book_bookings FOR SELECT
  USING (customer_id = auth.uid());

CREATE POLICY "Business owners see bookings for their business"
  ON public.book_bookings FOR SELECT
  USING (business_id IN (SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()));

CREATE POLICY "Customers create their own bookings"
  ON public.book_bookings FOR INSERT
  WITH CHECK (customer_id = auth.uid());

CREATE POLICY "Customers update their own bookings (e.g. cancel)"
  ON public.book_bookings FOR UPDATE
  USING (customer_id = auth.uid());

CREATE POLICY "Business owners update bookings for their business"
  ON public.book_bookings FOR UPDATE
  USING (business_id IN (SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()));
