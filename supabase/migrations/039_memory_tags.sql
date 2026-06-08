-- ── 039_memory_tags.sql ─────────────────────────────────────────────────────
--
-- Adds tag-style categorisation to memories so islanders can mark a memory
-- with one or more themes — fishing, crofting, Up Helly Aa, knitting,
-- wartime, etc. Multi-tag because Shetland life is rarely one thing
-- (a wedding on a fishing boat is both "family" and "fishing").
--
-- Storage shape
--   memories.tags TEXT[]
--     Slugs (e.g. 'fishing', 'crofting', 'up-helly-aa'). Labels + icons
--     live in code (constants/memory-categories.ts) so we can rebrand a
--     category — change its icon, rename "Crofting" to "Crofting & sheep" —
--     without touching the DB. Slugs are the stable identity.
--
-- Indexing
--   GIN index on the array lets a future "show all fishing memories"
--   query stay snappy even at 100k+ rows.
--
-- RPC update
--   fetch_memory_pins also returns tags now so the map can colour-code or
--   filter pins by tag without a second round-trip per pin.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.memories
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

-- GIN supports operators @>, &&, etc. Used by "memories with tag X" queries.
CREATE INDEX IF NOT EXISTS idx_memories_tags
  ON public.memories USING GIN (tags);

-- Rebuild fetch_memory_pins to surface tags alongside the existing columns.
-- Same signature, same SECURITY DEFINER context, no caller changes needed.
DROP FUNCTION IF EXISTS public.fetch_memory_pins(NUMERIC, NUMERIC, NUMERIC, NUMERIC, INT);

CREATE OR REPLACE FUNCTION public.fetch_memory_pins(
  min_lat NUMERIC,
  max_lat NUMERIC,
  min_lng NUMERIC,
  max_lng NUMERIC,
  result_limit INT DEFAULT 500
) RETURNS TABLE (
  id              UUID,
  lat             NUMERIC,
  lng             NUMERIC,
  place_name      TEXT,
  title           TEXT,
  era             TEXT,
  tags            TEXT[],
  media_count     INT,
  comment_count   INT,
  reaction_count  INT,
  child_count     INT,
  hero_url        TEXT,
  hero_kind       TEXT,
  created_at      TIMESTAMPTZ
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    m.id, m.lat, m.lng, m.place_name, m.title, m.era, m.tags,
    m.media_count, m.comment_count, m.reaction_count, m.child_count,
    (SELECT mm.url
       FROM public.memory_media mm
       WHERE mm.memory_id = m.id
       ORDER BY (mm.kind = 'photo') DESC, mm.display_order
       LIMIT 1)  AS hero_url,
    (SELECT mm.kind
       FROM public.memory_media mm
       WHERE mm.memory_id = m.id
       ORDER BY (mm.kind = 'photo') DESC, mm.display_order
       LIMIT 1)  AS hero_kind,
    m.created_at
  FROM public.memories m
  WHERE m.parent_id IS NULL
    AND NOT m.is_hidden
    AND m.lat BETWEEN min_lat AND max_lat
    AND m.lng BETWEEN min_lng AND max_lng
    AND (
      m.visibility = 'public'
      OR (m.visibility = 'community' AND auth.uid() IS NOT NULL)
      OR m.author_id = auth.uid()
    )
  ORDER BY m.created_at DESC
  LIMIT result_limit;
$$;

GRANT EXECUTE ON FUNCTION public.fetch_memory_pins(NUMERIC,NUMERIC,NUMERIC,NUMERIC,INT) TO anon, authenticated;
