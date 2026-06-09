-- ── 047_spik_daily_fix.sql ──────────────────────────────────────────────────
--
-- The spik_daily() RPC in migration 045 referenced columns that don't
-- exist in spik_dictionary as it actually is (`meaning`, `pos`,
-- `example`). Drop the broken function and recreate it with the
-- columns that actually exist.
--
-- Defensive write: uses `definition` (the canonical column name) and
-- avoids any other column that might be schema-variable.
-- ────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.spik_daily();

CREATE OR REPLACE FUNCTION public.spik_daily()
RETURNS TABLE (
  id        UUID,
  word      TEXT,
  meaning   TEXT
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH eligible AS (
    SELECT
      d.id,
      d.word,
      d.definition AS meaning
    FROM public.spik_dictionary d
    WHERE d.word_status IN ('approved','published')
    ORDER BY d.id
  ),
  rotated AS (
    SELECT
      e.*,
      row_number() OVER () AS rn,
      ((extract(epoch FROM current_date)::bigint / 86400)
         % GREATEST((SELECT count(*) FROM eligible), 1)) + 1 AS target
    FROM eligible e
  )
  SELECT id, word, meaning
  FROM rotated
  WHERE rn = target;
$$;

GRANT EXECUTE ON FUNCTION public.spik_daily() TO anon, authenticated;

-- ══ nearby_local_offers ════════════════════════════════════════════════════
--
-- Re-emitted here because migration 045's spik_daily failed at the
-- CREATE FUNCTION statement (SQL-language function bodies are parsed
-- eagerly, not deferred). That aborted the migration before this
-- function was reached, so it's missing. Identical to the body in 045.

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
