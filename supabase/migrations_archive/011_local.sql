-- ── OneShetland Local ─────────────────────────────────────────────────────────
-- Discovery, loyalty, offers, and wallet for Shetland's independent businesses.
-- Phases:
--   1. Discovery — businesses, follows
--   2. Loyalty — stamp cards / points + transactions
--   3. Offers — time-limited deals + redemptions
--   4. Wallet — Stripe-backed e-wallet, top-ups + spend with cashback

-- ── 1. Businesses ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.local_businesses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  category          TEXT NOT NULL CHECK (category IN (
                      'food_drink', 'retail', 'services', 'tourism', 'accommodation', 'other'
                    )),
  description       TEXT,
  address           TEXT NOT NULL,
  lat               NUMERIC(9,6),
  lng               NUMERIC(9,6),
  logo_url          TEXT,
  cover_url         TEXT,
  phone             TEXT,
  website           TEXT,
  email             TEXT,
  opening_hours     JSONB,
  is_verified       BOOLEAN DEFAULT FALSE,
  is_active         BOOLEAN DEFAULT TRUE,
  accepts_wallet    BOOLEAN DEFAULT FALSE,
  cashback_percent  NUMERIC(4,2) DEFAULT 0,   -- e.g. 5.00 = 5%
  stripe_account_id TEXT,
  payout_enabled    BOOLEAN DEFAULT FALSE,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_local_businesses_owner    ON public.local_businesses(owner_id);
CREATE INDEX IF NOT EXISTS idx_local_businesses_category ON public.local_businesses(category) WHERE is_active = TRUE;

ALTER TABLE public.local_businesses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read active businesses"
  ON public.local_businesses FOR SELECT
  USING (is_active = TRUE OR owner_id = auth.uid());

CREATE POLICY "Owners can insert their own business"
  ON public.local_businesses FOR INSERT
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "Owners can update their own business"
  ON public.local_businesses FOR UPDATE
  USING (owner_id = auth.uid());

-- ── 2. Follows ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.local_business_follows (
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.local_businesses(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, business_id)
);

ALTER TABLE public.local_business_follows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own follows"
  ON public.local_business_follows FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Business owners can see followers"
  ON public.local_business_follows FOR SELECT
  USING (business_id IN (SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()));

-- ── 3. Loyalty programs ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.local_loyalty_programs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL UNIQUE REFERENCES public.local_businesses(id) ON DELETE CASCADE,
  type              TEXT NOT NULL CHECK (type IN ('stamps', 'points')),
  stamps_required   INT,                 -- e.g. 9 stamps for a free coffee
  stamp_reward      TEXT,                -- e.g. "Free hot drink of your choice"
  points_per_pound  NUMERIC(6,2),        -- e.g. 10 points per £1
  points_for_pound  INT,                 -- e.g. 100 points = £1 off
  is_active         BOOLEAN DEFAULT TRUE,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.local_loyalty_programs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read active loyalty programs"
  ON public.local_loyalty_programs FOR SELECT
  USING (is_active = TRUE);

CREATE POLICY "Business owners can manage their program"
  ON public.local_loyalty_programs FOR ALL
  USING (business_id IN (SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()))
  WITH CHECK (business_id IN (SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()));

-- ── 4. Loyalty cards (per user, per business) ────────────────────────────────

CREATE TABLE IF NOT EXISTS public.local_loyalty_cards (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  program_id        UUID NOT NULL REFERENCES public.local_loyalty_programs(id) ON DELETE CASCADE,
  business_id       UUID NOT NULL REFERENCES public.local_businesses(id) ON DELETE CASCADE,
  stamps_collected  INT DEFAULT 0,
  points_balance    INT DEFAULT 0,
  total_redeemed    INT DEFAULT 0,
  last_stamp_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, program_id)
);

CREATE INDEX IF NOT EXISTS idx_local_cards_user ON public.local_loyalty_cards(user_id);

ALTER TABLE public.local_loyalty_cards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see their own cards"
  ON public.local_loyalty_cards FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Business owners see cards for their business"
  ON public.local_loyalty_cards FOR SELECT
  USING (business_id IN (SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()));

-- Cards are created/updated by edge functions (service role) — no INSERT/UPDATE policies
-- for end users to prevent self-stamping.

-- ── 5. Loyalty transactions ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.local_loyalty_transactions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id      UUID NOT NULL REFERENCES public.local_loyalty_cards(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  business_id  UUID NOT NULL REFERENCES public.local_businesses(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('stamp', 'points_earn', 'redeem', 'reward')),
  amount       INT NOT NULL,
  note         TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_local_loyalty_tx_card ON public.local_loyalty_transactions(card_id);

ALTER TABLE public.local_loyalty_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see their own loyalty transactions"
  ON public.local_loyalty_transactions FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Business owners see their loyalty transactions"
  ON public.local_loyalty_transactions FOR SELECT
  USING (business_id IN (SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()));

-- ── 6. Offers ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.local_offers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL REFERENCES public.local_businesses(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  description       TEXT,
  image_url         TEXT,
  discount_type     TEXT CHECK (discount_type IN ('percent', 'fixed', 'freebie', 'bogo', 'other')),
  discount_value    NUMERIC(8,2),
  valid_from        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until       TIMESTAMPTZ NOT NULL,
  terms             TEXT,
  max_redemptions   INT,                  -- NULL = unlimited
  is_active         BOOLEAN DEFAULT TRUE,
  redemption_count  INT DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_local_offers_business ON public.local_offers(business_id);
CREATE INDEX IF NOT EXISTS idx_local_offers_active   ON public.local_offers(valid_until) WHERE is_active = TRUE;

ALTER TABLE public.local_offers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read active offers"
  ON public.local_offers FOR SELECT
  USING (is_active = TRUE OR business_id IN (SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()));

CREATE POLICY "Business owners can manage their offers"
  ON public.local_offers FOR ALL
  USING (business_id IN (SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()))
  WITH CHECK (business_id IN (SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()));

-- ── 7. Offer redemptions ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.local_offer_redemptions (
  offer_id    UUID NOT NULL REFERENCES public.local_offers(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  redeemed_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (offer_id, user_id)
);

ALTER TABLE public.local_offer_redemptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see their own redemptions"
  ON public.local_offer_redemptions FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Business owners see redemptions for their offers"
  ON public.local_offer_redemptions FOR SELECT
  USING (offer_id IN (
    SELECT id FROM public.local_offers
    WHERE business_id IN (SELECT id FROM public.local_businesses WHERE owner_id = auth.uid())
  ));

-- ── 8. Wallet — balances and transactions ────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.local_wallet_balances (
  user_id       UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  balance_pence INT DEFAULT 0,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.local_wallet_balances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see their own wallet"
  ON public.local_wallet_balances FOR SELECT
  USING (user_id = auth.uid());

CREATE TABLE IF NOT EXISTS public.local_wallet_transactions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  business_id              UUID REFERENCES public.local_businesses(id),
  type                     TEXT NOT NULL CHECK (type IN ('topup', 'spend', 'refund', 'cashback')),
  amount_pence             INT NOT NULL,        -- positive for credit, negative for debit
  stripe_payment_intent_id TEXT,
  stripe_transfer_id       TEXT,
  description              TEXT,
  created_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_local_wallet_tx_user ON public.local_wallet_transactions(user_id, created_at DESC);

ALTER TABLE public.local_wallet_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see their own wallet transactions"
  ON public.local_wallet_transactions FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Business owners see their wallet transactions"
  ON public.local_wallet_transactions FOR SELECT
  USING (business_id IN (SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()));

-- ── 9. Rotating codes table — used for stamps & wallet pay ───────────────────
-- The business shows a 6-digit code that refreshes every 60 seconds.
-- The edge function validates against this table.

CREATE TABLE IF NOT EXISTS public.local_business_codes (
  business_id  UUID PRIMARY KEY REFERENCES public.local_businesses(id) ON DELETE CASCADE,
  current_code TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.local_business_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Business owners read their own code"
  ON public.local_business_codes FOR SELECT
  USING (business_id IN (SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()));

CREATE POLICY "Business owners can refresh their code"
  ON public.local_business_codes FOR ALL
  USING (business_id IN (SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()))
  WITH CHECK (business_id IN (SELECT id FROM public.local_businesses WHERE owner_id = auth.uid()));
