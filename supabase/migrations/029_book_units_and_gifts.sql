-- ── 029_book_units_and_gifts.sql ─────────────────────────────────────────────
--
-- Extends OneShetland Book with two new concepts:
--
--   1. Unit items — non-time-based things a business can sell:
--      tickets, class packs, gift vouchers, day passes. Optional finite stock,
--      optional expiry from purchase date, optional multi-use (e.g. a 10-class
--      pack is one purchase that grants ten redemptions).
--
--   2. Gifts — buy a booking or a unit item for someone else. Recipient gets
--      an email with a claim link (oneshetland.com/g/<code>). On claim the
--      gift converts into either a book_unit_purchases row or a book_bookings
--      row in the recipient's account.
--
-- Both modes coexist within the same business — a yoga studio can sell time-
-- slot classes AND 10-class packs from one dashboard.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Unit items ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.book_unit_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID NOT NULL REFERENCES public.local_businesses(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  description         TEXT,
  price_pence         INT  NOT NULL CHECK (price_pence > 0),
  stock               INT  CHECK (stock IS NULL OR stock >= 0),       -- NULL = unlimited
  valid_days          INT  CHECK (valid_days IS NULL OR valid_days > 0), -- NULL = never expires
  uses_per_purchase   INT  NOT NULL DEFAULT 1 CHECK (uses_per_purchase > 0),
  image_url           TEXT,
  category            TEXT,
  display_order       INT  DEFAULT 0,
  is_active           BOOLEAN DEFAULT TRUE,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_book_unit_items_business
  ON public.book_unit_items(business_id) WHERE is_active = TRUE;

ALTER TABLE public.book_unit_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read active unit items"
  ON public.book_unit_items FOR SELECT
  USING (is_active = TRUE OR business_id IN (
    SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()
  ));

CREATE POLICY "Business owners manage their unit items"
  ON public.book_unit_items FOR ALL
  USING (business_id IN (SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()))
  WITH CHECK (business_id IN (SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()));

-- ── 2. Unit purchases ─────────────────────────────────────────────────────────
-- One row per "I own this thing" — created on direct purchase OR on gift claim.
-- uses_remaining starts at the item's uses_per_purchase and decrements as the
-- owner redeems. expires_at is computed from valid_days at purchase time.

CREATE TABLE IF NOT EXISTS public.book_unit_purchases (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id             UUID NOT NULL REFERENCES public.book_unit_items(id),
  business_id         UUID NOT NULL REFERENCES public.local_businesses(id) ON DELETE CASCADE,
  owner_id            UUID NOT NULL REFERENCES public.profiles(id),
  paid_amount_pence   INT  NOT NULL,
  uses_remaining      INT  NOT NULL CHECK (uses_remaining >= 0),
  payment_intent_id   TEXT,
  gift_id             UUID,                       -- FK added after book_gifts exists
  expires_at          TIMESTAMPTZ,
  fully_used_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_book_unit_purchases_owner
  ON public.book_unit_purchases(owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_book_unit_purchases_business
  ON public.book_unit_purchases(business_id, created_at DESC);

ALTER TABLE public.book_unit_purchases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners see their unit purchases"
  ON public.book_unit_purchases FOR SELECT
  USING (owner_id = auth.uid());

CREATE POLICY "Businesses see purchases of their items"
  ON public.book_unit_purchases FOR SELECT
  USING (business_id IN (SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()));

-- Businesses redeem uses on their items (decrement uses_remaining when customer turns up).
CREATE POLICY "Businesses redeem uses on their items"
  ON public.book_unit_purchases FOR UPDATE
  USING (business_id IN (SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()))
  WITH CHECK (business_id IN (SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()));

-- Inserts happen via service_role (edge functions handle Stripe + gift claim).

-- ── 3. Gifts ──────────────────────────────────────────────────────────────────
-- Unified table for both kinds of gift:
--   kind = 'unit'    → unit_item_id set, service_id NULL
--   kind = 'booking' → service_id   set, unit_item_id NULL  (recipient picks slot on claim)
--
-- Lifecycle via status:
--   pending_payment → sent → claimed → used
--                                   ↘ cancelled (refund / admin void)

CREATE TABLE IF NOT EXISTS public.book_gifts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                TEXT UNIQUE NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('unit', 'booking')),
  status              TEXT NOT NULL DEFAULT 'pending_payment' CHECK (
    status IN ('pending_payment', 'sent', 'claimed', 'used', 'cancelled')
  ),
  business_id         UUID NOT NULL REFERENCES public.local_businesses(id) ON DELETE CASCADE,
  unit_item_id        UUID REFERENCES public.book_unit_items(id) ON DELETE RESTRICT,
  service_id          UUID REFERENCES public.book_services(id)   ON DELETE RESTRICT,
  purchaser_id        UUID NOT NULL REFERENCES public.profiles(id),
  purchaser_name      TEXT,
  recipient_email     TEXT NOT NULL,
  recipient_name      TEXT,
  message             TEXT,
  price_paid_pence    INT  NOT NULL,
  payment_intent_id   TEXT,
  email_sent_at       TIMESTAMPTZ,
  claimed_at          TIMESTAMPTZ,
  claimed_by_user_id  UUID REFERENCES public.profiles(id),
  used_at             TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  CHECK (
    (kind = 'unit'    AND unit_item_id IS NOT NULL AND service_id   IS NULL) OR
    (kind = 'booking' AND service_id   IS NOT NULL AND unit_item_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_book_gifts_code       ON public.book_gifts(code);
CREATE INDEX IF NOT EXISTS idx_book_gifts_purchaser  ON public.book_gifts(purchaser_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_book_gifts_recipient  ON public.book_gifts(recipient_email);
CREATE INDEX IF NOT EXISTS idx_book_gifts_claimed_by ON public.book_gifts(claimed_by_user_id);
CREATE INDEX IF NOT EXISTS idx_book_gifts_business   ON public.book_gifts(business_id, created_at DESC);

-- Now that gifts exists, wire the FKs back.
ALTER TABLE public.book_unit_purchases
  ADD CONSTRAINT book_unit_purchases_gift_fk
  FOREIGN KEY (gift_id) REFERENCES public.book_gifts(id) ON DELETE SET NULL;

ALTER TABLE public.book_bookings
  ADD COLUMN IF NOT EXISTS gift_id UUID REFERENCES public.book_gifts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_book_bookings_gift
  ON public.book_bookings(gift_id) WHERE gift_id IS NOT NULL;

ALTER TABLE public.book_gifts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Purchasers see their gifts"
  ON public.book_gifts FOR SELECT
  USING (purchaser_id = auth.uid());

CREATE POLICY "Claimers see gifts they've claimed"
  ON public.book_gifts FOR SELECT
  USING (claimed_by_user_id = auth.uid());

CREATE POLICY "Businesses see gifts for their items"
  ON public.book_gifts FOR SELECT
  USING (business_id IN (SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()));

-- INSERT / UPDATE handled via service_role through edge functions.

-- ── 4. Gift code generator ────────────────────────────────────────────────────
-- 8-char base32 from an alphabet that excludes visually-confusable characters
-- (0/O, 1/I/L). ~1.1 trillion combinations; retries on the (vanishingly rare)
-- collision.

CREATE OR REPLACE FUNCTION public.generate_gift_code()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  alphabet  CONSTANT TEXT := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  candidate TEXT;
  i         INT;
BEGIN
  LOOP
    candidate := '';
    FOR i IN 1..8 LOOP
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.book_gifts WHERE code = candidate);
  END LOOP;
  RETURN candidate;
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_gift_code() TO service_role;

-- ── 5. Claim RPC ──────────────────────────────────────────────────────────────
-- Recipient calls this with a gift code. On success:
--   • unit gifts    → inserts a book_unit_purchases row owned by the caller,
--                      marks the gift used, returns the new purchase id
--   • booking gifts → claims the gift (status='claimed') and returns the
--                      service/business so the app routes the user into the
--                      slot picker. The booking row is inserted later, when
--                      they pick a slot, with gift_id set.
--
-- Idempotent — re-calling after claim returns the same data without re-spawning
-- a purchase. SECURITY DEFINER so it can bypass the policy that limits inserts
-- to service_role.

CREATE OR REPLACE FUNCTION public.claim_gift(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_gift      public.book_gifts%ROWTYPE;
  v_item      public.book_unit_items%ROWTYPE;
  v_purchase  public.book_unit_purchases%ROWTYPE;
  v_user_id   UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'auth_required';
  END IF;

  SELECT * INTO v_gift FROM public.book_gifts WHERE code = p_code FOR UPDATE;

  IF NOT FOUND                                        THEN RAISE EXCEPTION 'gift_not_found';      END IF;
  IF v_gift.status = 'pending_payment'                THEN RAISE EXCEPTION 'gift_not_paid';       END IF;
  IF v_gift.status = 'cancelled'                      THEN RAISE EXCEPTION 'gift_cancelled';      END IF;
  IF v_gift.expires_at IS NOT NULL
       AND v_gift.expires_at < NOW()                  THEN RAISE EXCEPTION 'gift_expired';        END IF;
  IF v_gift.claimed_by_user_id IS NOT NULL
       AND v_gift.claimed_by_user_id <> v_user_id     THEN RAISE EXCEPTION 'gift_already_claimed';END IF;

  -- First-time claim → mark claimed
  IF v_gift.claimed_by_user_id IS NULL THEN
    UPDATE public.book_gifts
       SET claimed_at = NOW(),
           claimed_by_user_id = v_user_id,
           status = 'claimed'
     WHERE id = v_gift.id
    RETURNING * INTO v_gift;
  END IF;

  -- Unit gifts spawn a purchase immediately (idempotent)
  IF v_gift.kind = 'unit' THEN
    SELECT * INTO v_purchase
      FROM public.book_unit_purchases
     WHERE gift_id = v_gift.id;

    IF NOT FOUND THEN
      SELECT * INTO v_item FROM public.book_unit_items WHERE id = v_gift.unit_item_id;

      INSERT INTO public.book_unit_purchases (
        item_id, business_id, owner_id, paid_amount_pence,
        uses_remaining, gift_id, expires_at
      ) VALUES (
        v_item.id, v_item.business_id, v_user_id, v_gift.price_paid_pence,
        v_item.uses_per_purchase, v_gift.id,
        CASE WHEN v_item.valid_days IS NOT NULL
             THEN NOW() + (v_item.valid_days || ' days')::interval
        END
      )
      RETURNING * INTO v_purchase;

      UPDATE public.book_gifts
         SET used_at = NOW(), status = 'used'
       WHERE id = v_gift.id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'gift_id',          v_gift.id,
    'kind',             v_gift.kind,
    'business_id',      v_gift.business_id,
    'unit_item_id',     v_gift.unit_item_id,
    'service_id',       v_gift.service_id,
    'unit_purchase_id', v_purchase.id,
    'claimed_at',       v_gift.claimed_at,
    'used_at',          v_gift.used_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_gift(TEXT) TO authenticated;

-- ── 6. Stock decrement trigger ────────────────────────────────────────────────
-- After a unit purchase is inserted, decrement the source item's stock if it's
-- finite. The item's CHECK (stock >= 0) prevents over-sale — if a race tries
-- to push stock below zero the insert is rolled back.

CREATE OR REPLACE FUNCTION public.tg_decrement_unit_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.book_unit_items
     SET stock = stock - 1
   WHERE id = NEW.item_id
     AND stock IS NOT NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS book_unit_purchases_decrement_stock ON public.book_unit_purchases;

CREATE TRIGGER book_unit_purchases_decrement_stock
AFTER INSERT ON public.book_unit_purchases
FOR EACH ROW EXECUTE FUNCTION public.tg_decrement_unit_stock();
