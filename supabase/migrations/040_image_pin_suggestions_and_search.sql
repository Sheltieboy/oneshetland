-- ── 040_image_pin_suggestions_and_search.sql ────────────────────────────────
--
-- Photo tagging — community version.
--
-- Today a memory image pin is "ask the author's question, author resolves
-- it themselves." This migration adds:
--
--   1. memory_image_pin_suggestions — anyone signed-in can propose an
--      answer to an open pin. Author sees all suggestions and either
--      accepts one (sets the pin's resolved_answer, credits the suggester)
--      or types their own. Once accepted, the answer becomes a visible
--      tag on the photo for everyone to see.
--
--   2. memory_image_pins.accepted_suggestion_id — back-reference so the
--      UI can credit the suggester on the resolved label.
--
--   3. search_memories(q TEXT, limit INT) RPC — single round-trip search
--      across title, body, era, tag slugs, and resolved image-pin answers.
--      Returns just the columns a result card needs.
--
-- Idempotent — safe to re-run.
-- ────────────────────────────────────────────────────────────────────────────

-- ══ 1. Suggestions table ════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.memory_image_pin_suggestions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pin_id          UUID NOT NULL REFERENCES public.memory_image_pins(id) ON DELETE CASCADE,
  suggester_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

  answer          TEXT NOT NULL CHECK (length(trim(answer)) BETWEEN 1 AND 400),

  -- Set TRUE when the memory author accepts this suggestion.
  is_accepted     BOOLEAN NOT NULL DEFAULT FALSE,
  accepted_at     TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Stop a user firing off the same suggestion twice on the same pin.
  UNIQUE (pin_id, suggester_id, answer)
);

CREATE INDEX IF NOT EXISTS idx_pin_suggestions_pin
  ON public.memory_image_pin_suggestions(pin_id);

-- ══ 2. Back-reference on the pin ═══════════════════════════════════════════

ALTER TABLE public.memory_image_pins
  ADD COLUMN IF NOT EXISTS accepted_suggestion_id UUID
    REFERENCES public.memory_image_pin_suggestions(id) ON DELETE SET NULL;

-- ══ 3. RLS ═════════════════════════════════════════════════════════════════

ALTER TABLE public.memory_image_pin_suggestions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pin_suggestions read"   ON public.memory_image_pin_suggestions;
DROP POLICY IF EXISTS "pin_suggestions insert" ON public.memory_image_pin_suggestions;
DROP POLICY IF EXISTS "pin_suggestions update" ON public.memory_image_pin_suggestions;
DROP POLICY IF EXISTS "pin_suggestions delete" ON public.memory_image_pin_suggestions;

-- Anyone who can read the parent memory can read suggestions on its pins.
CREATE POLICY "pin_suggestions read"
  ON public.memory_image_pin_suggestions FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.memory_image_pins p
      JOIN public.memory_media mm ON mm.id = p.media_id
      JOIN public.memories m       ON m.id  = mm.memory_id
      WHERE p.id = memory_image_pin_suggestions.pin_id
        AND NOT m.is_hidden
        AND (
          m.visibility = 'public'
          OR (m.visibility = 'community' AND auth.uid() IS NOT NULL)
          OR m.author_id = auth.uid()
        )
    )
    OR EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = auth.uid() AND pr.role IN ('admin','moderator'))
  );

-- Any signed-in user can suggest an answer.
CREATE POLICY "pin_suggestions insert"
  ON public.memory_image_pin_suggestions FOR INSERT
  WITH CHECK (
    suggester_id = auth.uid()
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.memory_image_pins p
      JOIN public.memory_media mm ON mm.id = p.media_id
      JOIN public.memories m       ON m.id  = mm.memory_id
      WHERE p.id = memory_image_pin_suggestions.pin_id
        AND NOT m.is_hidden
    )
  );

-- A suggester can edit their own suggestion until it's accepted. After
-- acceptance the pin's resolved_answer is the source of truth and the
-- suggestion is effectively immutable. The memory author can flip
-- is_accepted via the accept_image_pin_suggestion() helper below (which
-- runs SECURITY DEFINER), so we don't need a separate update policy for
-- them.
CREATE POLICY "pin_suggestions update"
  ON public.memory_image_pin_suggestions FOR UPDATE
  USING (
    suggester_id = auth.uid()
    AND NOT is_accepted
  );

-- Suggester can withdraw; memory author + admins can prune.
CREATE POLICY "pin_suggestions delete"
  ON public.memory_image_pin_suggestions FOR DELETE
  USING (
    suggester_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.memory_image_pins p
      JOIN public.memory_media mm ON mm.id = p.media_id
      JOIN public.memories m       ON m.id  = mm.memory_id
      WHERE p.id = memory_image_pin_suggestions.pin_id
        AND m.author_id = auth.uid()
    )
    OR EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = auth.uid() AND pr.role IN ('admin','moderator'))
  );

-- ══ 4. Accept-suggestion helper (SECURITY DEFINER) ═════════════════════════
--
-- Marks a suggestion accepted, copies its answer onto the pin, credits the
-- suggester via resolved_by. Only the memory author can call this. Returns
-- the updated pin so the client can refresh in one call.

CREATE OR REPLACE FUNCTION public.accept_image_pin_suggestion(suggestion_id UUID)
RETURNS public.memory_image_pins
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_pin_id      UUID;
  v_answer      TEXT;
  v_suggester   UUID;
  v_author      UUID;
  v_pin         public.memory_image_pins;
BEGIN
  -- Look up the suggestion + parent memory in one go.
  SELECT s.pin_id, s.answer, s.suggester_id, m.author_id
    INTO v_pin_id, v_answer, v_suggester, v_author
    FROM public.memory_image_pin_suggestions s
    JOIN public.memory_image_pins p ON p.id = s.pin_id
    JOIN public.memory_media mm     ON mm.id = p.media_id
    JOIN public.memories m          ON m.id  = mm.memory_id
   WHERE s.id = suggestion_id;

  IF v_pin_id IS NULL THEN
    RAISE EXCEPTION 'Suggestion not found';
  END IF;

  -- Only the memory author can accept.
  IF v_author <> auth.uid() AND NOT EXISTS (
    SELECT 1 FROM public.profiles pr WHERE pr.id = auth.uid() AND pr.role IN ('admin','moderator')
  ) THEN
    RAISE EXCEPTION 'Only the memory author can accept a suggestion';
  END IF;

  -- Flip the accepted flag and demote any sibling acceptances on the same pin.
  UPDATE public.memory_image_pin_suggestions
     SET is_accepted = (id = suggestion_id),
         accepted_at = CASE WHEN id = suggestion_id THEN NOW() ELSE NULL END
   WHERE pin_id = v_pin_id;

  -- Stamp the pin.
  UPDATE public.memory_image_pins
     SET resolved              = TRUE,
         resolved_answer       = v_answer,
         resolved_by           = v_suggester,
         resolved_at           = NOW(),
         accepted_suggestion_id = suggestion_id
   WHERE id = v_pin_id
   RETURNING * INTO v_pin;

  RETURN v_pin;
END;
$$;

GRANT EXECUTE ON FUNCTION public.accept_image_pin_suggestion(UUID) TO authenticated;

-- ══ 5. search_memories RPC ═════════════════════════════════════════════════
--
-- Single round-trip search. Ranks by recency (no tsvector yet — at the
-- expected scale ILIKE is plenty, and a GIN trigram index can be layered
-- on later without changing the signature). Title, body, era and tag
-- slugs are searched directly; resolved image-pin answers are searched
-- via a correlated EXISTS so the photo-tag labels become first-class
-- search hits.

CREATE OR REPLACE FUNCTION public.search_memories(
  q TEXT,
  result_limit INT DEFAULT 50
) RETURNS TABLE (
  id              UUID,
  lat             NUMERIC,
  lng             NUMERIC,
  place_name      TEXT,
  title           TEXT,
  body_excerpt    TEXT,
  era             TEXT,
  tags            TEXT[],
  matched_via     TEXT,     -- 'title' | 'body' | 'era' | 'tag' | 'photo_tag'
  hero_url        TEXT,
  hero_kind       TEXT,
  created_at      TIMESTAMPTZ
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH q_norm AS (
    SELECT lower(trim(q)) AS qq
  ),
  candidates AS (
    SELECT
      m.*,
      CASE
        WHEN m.title      ILIKE '%' || (SELECT qq FROM q_norm) || '%' THEN 'title'
        WHEN m.body       ILIKE '%' || (SELECT qq FROM q_norm) || '%' THEN 'body'
        WHEN m.era        ILIKE '%' || (SELECT qq FROM q_norm) || '%' THEN 'era'
        WHEN (SELECT qq FROM q_norm) = ANY(m.tags)                    THEN 'tag'
        ELSE                                                                'photo_tag'
      END AS matched_via
    FROM public.memories m
    WHERE NOT m.is_hidden
      AND m.parent_id IS NULL
      AND (
        m.title      ILIKE '%' || (SELECT qq FROM q_norm) || '%'
        OR m.body    ILIKE '%' || (SELECT qq FROM q_norm) || '%'
        OR m.era     ILIKE '%' || (SELECT qq FROM q_norm) || '%'
        OR (SELECT qq FROM q_norm) = ANY(m.tags)
        OR EXISTS (
          SELECT 1
          FROM public.memory_media mm
          JOIN public.memory_image_pins p ON p.media_id = mm.id
          WHERE mm.memory_id = m.id
            AND p.resolved
            AND p.resolved_answer ILIKE '%' || (SELECT qq FROM q_norm) || '%'
        )
      )
      AND (
        m.visibility = 'public'
        OR (m.visibility = 'community' AND auth.uid() IS NOT NULL)
        OR m.author_id = auth.uid()
      )
  )
  SELECT
    c.id, c.lat, c.lng, c.place_name, c.title,
    LEFT(COALESCE(c.body, ''), 220) AS body_excerpt,
    c.era, c.tags, c.matched_via,
    (SELECT mm.url
       FROM public.memory_media mm
       WHERE mm.memory_id = c.id
       ORDER BY (mm.kind = 'photo') DESC, mm.display_order
       LIMIT 1)  AS hero_url,
    (SELECT mm.kind
       FROM public.memory_media mm
       WHERE mm.memory_id = c.id
       ORDER BY (mm.kind = 'photo') DESC, mm.display_order
       LIMIT 1)  AS hero_kind,
    c.created_at
  FROM candidates c
  ORDER BY c.created_at DESC
  LIMIT result_limit;
$$;

GRANT EXECUTE ON FUNCTION public.search_memories(TEXT, INT) TO anon, authenticated;
