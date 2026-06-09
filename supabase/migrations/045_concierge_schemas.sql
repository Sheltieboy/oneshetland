-- ── 045_concierge_schemas.sql ───────────────────────────────────────────────
--
-- Backs the Home concierge with real data:
--
--   * notices  — community announcements, urgent alerts (gated to
--                verified business publishers)
--   * events   — what's on across Shetland
--   * jobs     — permanent / longer-term positions (sibling of shifts)
--
-- Plus two RPCs:
--
--   * spik_daily()                     — deterministic-by-date single
--                                        Shetlandic word from the
--                                        existing spik_dictionary
--   * nearby_local_offers(lat, lng, km) — GPS-aware "loyalty cards / offers
--                                        for businesses near me" for the
--                                        Home For-you row
--
-- Apply via the SQL editor and `supabase migration repair --status applied 045`.
-- Idempotent — safe to re-run.
-- ────────────────────────────────────────────────────────────────────────────

-- ══ 1. Urgent publisher tier on businesses ═════════════════════════════════
--
-- Only businesses with can_publish_urgent = TRUE may post notices with
-- severity='urgent'. Admin grants the flag in the dashboard.

ALTER TABLE public.local_businesses
  ADD COLUMN IF NOT EXISTS can_publish_urgent BOOLEAN NOT NULL DEFAULT FALSE;

-- ══ 2. Notices ═════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.notices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  publisher_business_id UUID REFERENCES public.local_businesses(id) ON DELETE SET NULL,
  publisher_user_id     UUID REFERENCES public.profiles(id)         ON DELETE SET NULL,

  severity        TEXT NOT NULL DEFAULT 'community'
                    CHECK (severity IN ('urgent','community','info')),

  title           TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  body            TEXT,

  -- Free-text locality slug ("lerwick", "yell", "all-shetland") so the
  -- Home concierge can prioritise notices near the user's parish. Lat/lng
  -- optional for finer-grained radius queries later.
  locality        TEXT,
  lat             NUMERIC(9,6),
  lng             NUMERIC(9,6),

  -- Lifecycle
  is_pinned       BOOLEAN NOT NULL DEFAULT FALSE,
  is_hidden       BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at      TIMESTAMPTZ,
  published_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notices_published   ON public.notices(published_at DESC) WHERE NOT is_hidden;
CREATE INDEX IF NOT EXISTS idx_notices_severity    ON public.notices(severity)           WHERE NOT is_hidden;
CREATE INDEX IF NOT EXISTS idx_notices_locality    ON public.notices(locality)           WHERE NOT is_hidden;
CREATE INDEX IF NOT EXISTS idx_notices_pinned      ON public.notices(is_pinned)          WHERE is_pinned AND NOT is_hidden;

ALTER TABLE public.notices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notices read"   ON public.notices;
DROP POLICY IF EXISTS "notices insert" ON public.notices;
DROP POLICY IF EXISTS "notices update" ON public.notices;
DROP POLICY IF EXISTS "notices delete" ON public.notices;

CREATE POLICY "notices read"
  ON public.notices FOR SELECT
  USING (
    NOT is_hidden
    AND (expires_at IS NULL OR expires_at > NOW())
    OR EXISTS (SELECT 1 FROM public.profiles p
                WHERE p.id = auth.uid() AND p.role IN ('admin','moderator'))
  );

-- Anyone signed-in can post a community/info notice tagged to a profile.
-- Urgent notices require a business publisher with can_publish_urgent.
CREATE POLICY "notices insert"
  ON public.notices FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND (
      severity <> 'urgent'
      OR EXISTS (
        SELECT 1 FROM public.local_businesses b
        WHERE b.id = publisher_business_id
          AND b.owner_id = auth.uid()
          AND b.can_publish_urgent = TRUE
      )
      OR EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.id = auth.uid() AND p.role IN ('admin','moderator'))
    )
    AND (
      publisher_user_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.local_businesses b
        WHERE b.id = publisher_business_id AND b.owner_id = auth.uid()
      )
      OR EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.id = auth.uid() AND p.role IN ('admin','moderator'))
    )
  );

CREATE POLICY "notices update"
  ON public.notices FOR UPDATE
  USING (
    publisher_user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.local_businesses b
                WHERE b.id = publisher_business_id AND b.owner_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.profiles p
                WHERE p.id = auth.uid() AND p.role IN ('admin','moderator'))
  );

CREATE POLICY "notices delete"
  ON public.notices FOR DELETE
  USING (
    publisher_user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.local_businesses b
                WHERE b.id = publisher_business_id AND b.owner_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.profiles p
                WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- ══ 3. Events ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organiser_user_id     UUID REFERENCES public.profiles(id)         ON DELETE SET NULL,
  organiser_business_id UUID REFERENCES public.local_businesses(id) ON DELETE SET NULL,

  title           TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  description     TEXT,
  category        TEXT,          -- "Music", "Market", "Community", "Outdoors", "Sport", "Family"
  venue           TEXT,
  locality        TEXT,
  lat             NUMERIC(9,6),
  lng             NUMERIC(9,6),

  starts_at       TIMESTAMPTZ NOT NULL,
  ends_at         TIMESTAMPTZ,

  cover_url       TEXT,          -- hero photo
  ticket_url      TEXT,
  price_text      TEXT,          -- free text: "£10 / £6 concession" / "Free"

  is_featured     BOOLEAN NOT NULL DEFAULT FALSE,
  is_hidden       BOOLEAN NOT NULL DEFAULT FALSE,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_starts  ON public.events(starts_at) WHERE NOT is_hidden;
CREATE INDEX IF NOT EXISTS idx_events_locality ON public.events(locality) WHERE NOT is_hidden;
CREATE INDEX IF NOT EXISTS idx_events_featured ON public.events(is_featured) WHERE is_featured AND NOT is_hidden;

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "events read"   ON public.events;
DROP POLICY IF EXISTS "events insert" ON public.events;
DROP POLICY IF EXISTS "events update" ON public.events;
DROP POLICY IF EXISTS "events delete" ON public.events;

CREATE POLICY "events read"
  ON public.events FOR SELECT
  USING (
    NOT is_hidden
    OR EXISTS (SELECT 1 FROM public.profiles p
                WHERE p.id = auth.uid() AND p.role IN ('admin','moderator'))
  );

CREATE POLICY "events insert"
  ON public.events FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND (
      organiser_user_id = auth.uid()
      OR EXISTS (SELECT 1 FROM public.local_businesses b
                  WHERE b.id = organiser_business_id AND b.owner_id = auth.uid())
      OR EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.id = auth.uid() AND p.role IN ('admin','moderator'))
    )
  );

CREATE POLICY "events update"
  ON public.events FOR UPDATE
  USING (
    organiser_user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.local_businesses b
                WHERE b.id = organiser_business_id AND b.owner_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.profiles p
                WHERE p.id = auth.uid() AND p.role IN ('admin','moderator'))
  );

CREATE POLICY "events delete"
  ON public.events FOR DELETE
  USING (
    organiser_user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.local_businesses b
                WHERE b.id = organiser_business_id AND b.owner_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.profiles p
                WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- ══ 4. Jobs ════════════════════════════════════════════════════════════════
--
-- Distinct from Shifts. Shifts = short-notice cover; Jobs = permanent or
-- longer-term positions with a CV-style application flow.

CREATE TABLE IF NOT EXISTS public.jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  posted_as_business_id UUID REFERENCES public.local_businesses(id) ON DELETE SET NULL,

  title           TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  description     TEXT,
  category        TEXT,          -- "Hospitality", "Maritime", "Trade", "Care", "Retail", …
  location        TEXT,          -- free text: "Lerwick", "Hamnavoe", "Remote (Shetland)"
  locality        TEXT,
  lat             NUMERIC(9,6),
  lng             NUMERIC(9,6),

  contract_type   TEXT NOT NULL DEFAULT 'full-time'
                    CHECK (contract_type IN ('full-time','part-time','casual','apprenticeship','volunteer','freelance')),
  pay_text        TEXT,          -- free text: "£24–28k", "£14/hr", "Negotiable"

  apply_url       TEXT,
  apply_email     TEXT,

  is_featured     BOOLEAN NOT NULL DEFAULT FALSE,
  is_hidden       BOOLEAN NOT NULL DEFAULT FALSE,

  expires_at      TIMESTAMPTZ,
  posted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobs_posted    ON public.jobs(posted_at DESC) WHERE NOT is_hidden;
CREATE INDEX IF NOT EXISTS idx_jobs_locality  ON public.jobs(locality)       WHERE NOT is_hidden;
CREATE INDEX IF NOT EXISTS idx_jobs_featured  ON public.jobs(is_featured)    WHERE is_featured AND NOT is_hidden;
CREATE INDEX IF NOT EXISTS idx_jobs_employer  ON public.jobs(employer_id);

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "jobs read"   ON public.jobs;
DROP POLICY IF EXISTS "jobs insert" ON public.jobs;
DROP POLICY IF EXISTS "jobs update" ON public.jobs;
DROP POLICY IF EXISTS "jobs delete" ON public.jobs;

CREATE POLICY "jobs read"
  ON public.jobs FOR SELECT
  USING (
    NOT is_hidden
    AND (expires_at IS NULL OR expires_at > NOW())
    OR EXISTS (SELECT 1 FROM public.profiles p
                WHERE p.id = auth.uid() AND p.role IN ('admin','moderator'))
  );

CREATE POLICY "jobs insert"
  ON public.jobs FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND employer_id = auth.uid()
  );

CREATE POLICY "jobs update"
  ON public.jobs FOR UPDATE
  USING (
    employer_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.profiles p
                WHERE p.id = auth.uid() AND p.role IN ('admin','moderator'))
  );

CREATE POLICY "jobs delete"
  ON public.jobs FOR DELETE
  USING (
    employer_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.profiles p
                WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- ══ 5. spik_daily() RPC ═══════════════════════════════════════════════════
--
-- Returns one Shetlandic word per UTC day. Deterministic: every user gets
-- the same word on a given date. Uses the day-since-epoch as an offset
-- against the count of eligible (approved/published) dictionary rows so
-- the rotation walks the dictionary without bias.

CREATE OR REPLACE FUNCTION public.spik_daily()
RETURNS TABLE (
  id                UUID,
  word              TEXT,
  meaning           TEXT,
  pos               TEXT,
  example           TEXT
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH eligible AS (
    SELECT id, word, meaning, pos, example
    FROM public.spik_dictionary
    WHERE word_status IN ('approved','published')
    ORDER BY id
  ),
  rotated AS (
    SELECT *, row_number() OVER () AS rn,
           ((extract(epoch FROM current_date)::bigint / 86400)
              % GREATEST((SELECT count(*) FROM eligible), 1)) + 1 AS target
    FROM eligible
  )
  SELECT id, word, meaning, pos, example
  FROM rotated
  WHERE rn = target;
$$;

GRANT EXECUTE ON FUNCTION public.spik_daily() TO anon, authenticated;

-- ══ 6. nearby_local_offers RPC ═════════════════════════════════════════════
--
-- GPS-aware "what's on near me from businesses I have a card with OR who
-- have an active offer". Returns at most `result_limit` rows ordered by
-- distance ascending. Uses the haversine formula at Shetland latitudes
-- (good enough at this scale; PostGIS not required).

CREATE OR REPLACE FUNCTION public.nearby_local_offers(
  user_lat    NUMERIC,
  user_lng    NUMERIC,
  radius_km   NUMERIC DEFAULT 2.0,
  result_limit INT     DEFAULT 8
) RETURNS TABLE (
  business_id     UUID,
  business_name   TEXT,
  business_lat    NUMERIC,
  business_lng    NUMERIC,
  distance_km     NUMERIC,
  offer_id        UUID,
  offer_title     TEXT,
  offer_image_url TEXT,
  has_loyalty     BOOLEAN
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH near_businesses AS (
    SELECT
      b.id, b.name, b.lat, b.lng,
      6371 * 2 * asin(sqrt(
        sin(radians((b.lat - user_lat) / 2))^2
        + cos(radians(user_lat)) * cos(radians(b.lat))
          * sin(radians((b.lng - user_lng) / 2))^2
      )) AS distance_km
    FROM public.local_businesses b
    WHERE b.is_active = TRUE
      AND b.lat IS NOT NULL AND b.lng IS NOT NULL
  )
  SELECT
    nb.id           AS business_id,
    nb.name         AS business_name,
    nb.lat          AS business_lat,
    nb.lng          AS business_lng,
    nb.distance_km,
    o.id            AS offer_id,
    o.title         AS offer_title,
    o.image_url     AS offer_image_url,
    EXISTS (
      SELECT 1 FROM public.local_loyalty_cards lc
      WHERE lc.business_id = nb.id AND lc.user_id = auth.uid()
    ) AS has_loyalty
  FROM near_businesses nb
  LEFT JOIN LATERAL (
    SELECT id, title, image_url
    FROM public.local_offers
    WHERE business_id = nb.id
      AND is_active = TRUE
      AND valid_until > NOW()
    ORDER BY valid_until DESC
    LIMIT 1
  ) o ON TRUE
  WHERE nb.distance_km <= radius_km
  ORDER BY nb.distance_km ASC
  LIMIT result_limit;
$$;

GRANT EXECUTE ON FUNCTION public.nearby_local_offers(NUMERIC, NUMERIC, NUMERIC, INT) TO anon, authenticated;
