-- ── 049_spik_daily_no_id.sql ────────────────────────────────────────────────
--
-- spik_dictionary.id is an integer/bigint, not a UUID. The RETURNS TABLE
-- declaration in 048 said UUID, hence the type-mismatch on column 1.
--
-- The Home banner doesn't use the id, so the cleanest fix is to drop it
-- from the return signature entirely. word + meaning + example + pos.
-- ────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.spik_daily();

CREATE OR REPLACE FUNCTION public.spik_daily()
RETURNS TABLE (
  word     TEXT,
  meaning  TEXT,
  example  TEXT,
  pos      TEXT
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
  SELECT word, meaning, example, pos
  FROM rotated
  WHERE rn = target;
$$;

GRANT EXECUTE ON FUNCTION public.spik_daily() TO anon, authenticated;
