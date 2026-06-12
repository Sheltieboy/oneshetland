-- ── 048_spik_daily_final.sql ────────────────────────────────────────────────
--
-- Third (and final) attempt at the spik_daily RPC, using the actual
-- column names from spik_dictionary as it exists in production:
--
--     short_meaning   — concise definition (preferred for the Home banner)
--     spik_meaning    — longer dialect-flavoured phrasing (fallback)
--     example_sentence — usage example
--     part_of_speech  — noun / verb / adj / …
--
-- Returns one word per UTC day, same for every user on that day.
-- Drops any earlier broken versions for cleanliness.
-- ────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.spik_daily() CASCADE;

CREATE OR REPLACE FUNCTION public.spik_daily()
RETURNS TABLE (
  id        UUID,
  word      TEXT,
  meaning   TEXT,
  example   TEXT,
  pos       TEXT
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH eligible AS (
    SELECT
      d.id,
      d.word,
      COALESCE(d.short_meaning, d.spik_meaning) AS meaning,
      d.example_sentence                         AS example,
      d.part_of_speech                           AS pos
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
  SELECT id, word, meaning, example, pos
  FROM rotated
  WHERE rn = target;
$$;

GRANT EXECUTE ON FUNCTION public.spik_daily() TO anon, authenticated;
