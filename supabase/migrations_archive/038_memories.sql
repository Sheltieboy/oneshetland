-- ── 038_memories.sql ────────────────────────────────────────────────────────
--
-- "Memories" — a living map of Shetland, pinned with stories.
--
-- A memory is anchored to a lat/lng and can carry any combination of:
--   * a written story
--   * voice notes (audio + transcript)
--   * photos (with optional annotation pins asking "who/what is this?")
--   * videos
--   * sub-memories (children of a parent — e.g. a thread of stories about
--     the same place / family / boat)
--   * comments from other islanders
--   * reactions (lightweight ❤️ / 👏 / 🧭 / 📜)
--
-- A photo on a memory can have one or more "image pins" — coordinates on
-- the image with a question or label. Other users can answer in the
-- comments thread, or directly resolve the pin (with the original author's
-- permission later, if we want).
--
-- Permission model
-- ----------------
-- Public-by-default — Shetland is a small place; the joy of the feature is
-- discovering other people's memories. A memory has visibility:
--   public                 — anyone can read
--   community              — signed-in users only
--   private                — only the author
--
-- Authors can always edit / delete their own memories. Comments + image-pin
-- answers are owned by their poster. Moderators can hide anything.
--
-- Storage
-- -------
-- Media lives in the `memories-media` bucket (created here, public-read,
-- author-write), pathed as:
--   memories-media/<memory_id>/<kind>/<uuid>.<ext>
--     kind ∈ { photo | video | audio }
--
-- Naming choice: `memories-media` rather than just `memories` to keep it
-- visually clean alongside business-media / employer-logos / avatars from
-- migration 037.
--
-- Idempotent — safe to re-run.
-- ────────────────────────────────────────────────────────────────────────────

-- ══ 1. The memories table ══════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.memories (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

  -- Anchor on the map. NULL only allowed for sub-memories (parent provides
  -- location) — see CHECK below.
  lat               NUMERIC(9,6),
  lng               NUMERIC(9,6),

  -- Optional human-readable place name (e.g. "Hillswick Pier", "Da Lodberries").
  -- Free text so authors can mention places not in the places table.
  place_name        TEXT,

  -- Optional thread: a memory can be a child of another memory. Sub-memories
  -- inherit visibility from their root, but each has its own author + media.
  parent_id         UUID REFERENCES public.memories(id) ON DELETE CASCADE,

  -- Optional era hint — "pre-1900", "1920s", "WW2", "1970s", "recent".
  -- Free-form so we don't have to enumerate; UI offers suggestions but
  -- allows free text.
  era               TEXT,

  -- Title + body. Both optional — a memory might be JUST a photo.
  title             TEXT,
  body              TEXT,

  visibility        TEXT NOT NULL DEFAULT 'public'
                      CHECK (visibility IN ('public','community','private')),

  -- Moderation flag. Sets to TRUE when hidden; the row stays in the DB so
  -- we can restore it. Authors can't see hidden, only the moderator who
  -- hid it and admins.
  is_hidden         BOOLEAN NOT NULL DEFAULT FALSE,
  hidden_reason     TEXT,
  hidden_by         UUID REFERENCES public.profiles(id),
  hidden_at         TIMESTAMPTZ,

  -- Aggregate counters kept in sync by triggers below. Saves the home
  -- map screen from running aggregate queries per pin.
  media_count       INT NOT NULL DEFAULT 0,
  comment_count     INT NOT NULL DEFAULT 0,
  reaction_count    INT NOT NULL DEFAULT 0,
  child_count       INT NOT NULL DEFAULT 0,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Either we have coordinates OR we're a sub-memory (parent provides them).
  CONSTRAINT memories_has_location CHECK (
    (lat IS NOT NULL AND lng IS NOT NULL) OR parent_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_memories_author
  ON public.memories(author_id);

CREATE INDEX IF NOT EXISTS idx_memories_parent
  ON public.memories(parent_id)
  WHERE parent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memories_location
  ON public.memories(lat, lng)
  WHERE lat IS NOT NULL AND is_hidden = FALSE;

CREATE INDEX IF NOT EXISTS idx_memories_recent
  ON public.memories(created_at DESC)
  WHERE is_hidden = FALSE AND parent_id IS NULL;

-- ══ 2. Media attached to a memory ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.memory_media (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id         UUID NOT NULL REFERENCES public.memories(id) ON DELETE CASCADE,
  uploader_id       UUID NOT NULL REFERENCES public.profiles(id) ON DELETE SET NULL,

  kind              TEXT NOT NULL CHECK (kind IN ('photo','video','audio')),

  -- Public URL to the asset in `memories-media` bucket.
  url               TEXT NOT NULL,
  -- Storage path (kept so we can delete on row delete via app code).
  storage_path      TEXT NOT NULL,
  -- For photos / videos: a separate thumbnail URL if we generate one.
  thumb_url         TEXT,

  -- For audio: the transcript produced by the transcribe-audio edge fn.
  -- Nullable while pending. The edge function writes back here.
  transcript        TEXT,
  transcript_status TEXT NOT NULL DEFAULT 'none'
                      CHECK (transcript_status IN ('none','pending','done','failed')),

  -- For photos/videos: caption.
  caption           TEXT,

  -- Sort order within a memory.
  display_order     INT NOT NULL DEFAULT 0,

  -- Optional duration for audio/video, in seconds.
  duration_seconds  INT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_media_memory
  ON public.memory_media(memory_id);

-- ══ 3. Pins dropped on a photo ═════════════════════════════════════════════
--
-- Coordinates are in unit space (0.0–1.0) so they survive resizing. The
-- author drops the pin and asks a question; other people answer in the
-- comments thread (linked via image_pin_id on memory_comments). The pin
-- can be marked `resolved` once the question has been answered.

CREATE TABLE IF NOT EXISTS public.memory_image_pins (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  media_id          UUID NOT NULL REFERENCES public.memory_media(id) ON DELETE CASCADE,
  author_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

  -- Position on the image in unit coordinates (0.0 = left/top, 1.0 = right/bottom).
  x                 NUMERIC(5,4) NOT NULL CHECK (x BETWEEN 0 AND 1),
  y                 NUMERIC(5,4) NOT NULL CHECK (y BETWEEN 0 AND 1),

  -- The question or label. "Who is this?", "What boat is that?".
  prompt            TEXT NOT NULL,

  -- Once someone helps and the author accepts the answer.
  resolved          BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_answer   TEXT,
  resolved_by       UUID REFERENCES public.profiles(id),
  resolved_at       TIMESTAMPTZ,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_image_pins_media
  ON public.memory_image_pins(media_id);

-- ══ 4. Comments ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.memory_comments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id         UUID NOT NULL REFERENCES public.memories(id) ON DELETE CASCADE,
  author_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

  -- Optional link to a specific image pin — "here's who that is".
  image_pin_id      UUID REFERENCES public.memory_image_pins(id) ON DELETE SET NULL,

  body              TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),

  is_hidden         BOOLEAN NOT NULL DEFAULT FALSE,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_comments_memory
  ON public.memory_comments(memory_id, created_at);

CREATE INDEX IF NOT EXISTS idx_memory_comments_pin
  ON public.memory_comments(image_pin_id)
  WHERE image_pin_id IS NOT NULL;

-- ══ 5. Reactions ═══════════════════════════════════════════════════════════
--
-- One row per (memory, user, kind). Constrained so a user can't double-react.

CREATE TABLE IF NOT EXISTS public.memory_reactions (
  memory_id         UUID NOT NULL REFERENCES public.memories(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('heart','applaud','compass','scroll')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (memory_id, user_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_memory_reactions_user
  ON public.memory_reactions(user_id);

-- ══ 6. Counter-keeping triggers ════════════════════════════════════════════
--
-- Cheap aggregate maintenance so the map can paint pins without aggregates.

CREATE OR REPLACE FUNCTION public.tg_memory_media_count() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.memories SET media_count = media_count + 1, updated_at = NOW()
      WHERE id = NEW.memory_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.memories SET media_count = GREATEST(media_count - 1, 0), updated_at = NOW()
      WHERE id = OLD.memory_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_memory_media_count_aiud ON public.memory_media;
CREATE TRIGGER tg_memory_media_count_aiud
  AFTER INSERT OR DELETE ON public.memory_media
  FOR EACH ROW EXECUTE FUNCTION public.tg_memory_media_count();

CREATE OR REPLACE FUNCTION public.tg_memory_comment_count() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.memories SET comment_count = comment_count + 1, updated_at = NOW()
      WHERE id = NEW.memory_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.memories SET comment_count = GREATEST(comment_count - 1, 0)
      WHERE id = OLD.memory_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_memory_comment_count_aiud ON public.memory_comments;
CREATE TRIGGER tg_memory_comment_count_aiud
  AFTER INSERT OR DELETE ON public.memory_comments
  FOR EACH ROW EXECUTE FUNCTION public.tg_memory_comment_count();

CREATE OR REPLACE FUNCTION public.tg_memory_reaction_count() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.memories SET reaction_count = reaction_count + 1 WHERE id = NEW.memory_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.memories SET reaction_count = GREATEST(reaction_count - 1, 0) WHERE id = OLD.memory_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_memory_reaction_count_aiud ON public.memory_reactions;
CREATE TRIGGER tg_memory_reaction_count_aiud
  AFTER INSERT OR DELETE ON public.memory_reactions
  FOR EACH ROW EXECUTE FUNCTION public.tg_memory_reaction_count();

CREATE OR REPLACE FUNCTION public.tg_memory_child_count() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.parent_id IS NOT NULL THEN
    UPDATE public.memories SET child_count = child_count + 1, updated_at = NOW()
      WHERE id = NEW.parent_id;
  ELSIF TG_OP = 'DELETE' AND OLD.parent_id IS NOT NULL THEN
    UPDATE public.memories SET child_count = GREATEST(child_count - 1, 0)
      WHERE id = OLD.parent_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_memory_child_count_aiud ON public.memories;
CREATE TRIGGER tg_memory_child_count_aiud
  AFTER INSERT OR DELETE ON public.memories
  FOR EACH ROW EXECUTE FUNCTION public.tg_memory_child_count();

-- ══ 7. RLS ═════════════════════════════════════════════════════════════════

ALTER TABLE public.memories            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_media        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_image_pins   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_comments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_reactions    ENABLE ROW LEVEL SECURITY;

-- ── memories ───────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "memories visible per visibility" ON public.memories;
CREATE POLICY "memories visible per visibility"
  ON public.memories FOR SELECT
  USING (
    NOT is_hidden AND (
      visibility = 'public'
      OR (visibility = 'community' AND auth.uid() IS NOT NULL)
      OR author_id = auth.uid()
      OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','moderator'))
    )
  );

DROP POLICY IF EXISTS "memories author insert" ON public.memories;
CREATE POLICY "memories author insert"
  ON public.memories FOR INSERT
  WITH CHECK (author_id = auth.uid());

DROP POLICY IF EXISTS "memories author update" ON public.memories;
CREATE POLICY "memories author update"
  ON public.memories FOR UPDATE
  USING (author_id = auth.uid()
         OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','moderator')))
  WITH CHECK (author_id = auth.uid()
         OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','moderator')));

DROP POLICY IF EXISTS "memories author delete" ON public.memories;
CREATE POLICY "memories author delete"
  ON public.memories FOR DELETE
  USING (author_id = auth.uid()
         OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

-- ── memory_media ──────────────────────────────────────────────────────────
-- Inherit readability from parent memory; only uploader can write.

DROP POLICY IF EXISTS "memory_media read" ON public.memory_media;
CREATE POLICY "memory_media read"
  ON public.memory_media FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.memories m
      WHERE m.id = memory_media.memory_id
        AND NOT m.is_hidden
        AND (
          m.visibility = 'public'
          OR (m.visibility = 'community' AND auth.uid() IS NOT NULL)
          OR m.author_id = auth.uid()
        )
    )
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','moderator'))
  );

DROP POLICY IF EXISTS "memory_media insert" ON public.memory_media;
CREATE POLICY "memory_media insert"
  ON public.memory_media FOR INSERT
  WITH CHECK (
    uploader_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.memories m
      WHERE m.id = memory_media.memory_id
        AND m.author_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "memory_media update" ON public.memory_media;
CREATE POLICY "memory_media update"
  ON public.memory_media FOR UPDATE
  USING (uploader_id = auth.uid()
         OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','moderator')));

DROP POLICY IF EXISTS "memory_media delete" ON public.memory_media;
CREATE POLICY "memory_media delete"
  ON public.memory_media FOR DELETE
  USING (uploader_id = auth.uid()
         OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

-- ── memory_image_pins ─────────────────────────────────────────────────────
-- Anyone who can see the parent memory can see its pins. Authors of the
-- *memory* drop pins on their own photos. The *memory* author can resolve.

DROP POLICY IF EXISTS "memory_image_pins read" ON public.memory_image_pins;
CREATE POLICY "memory_image_pins read"
  ON public.memory_image_pins FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.memory_media mm
      JOIN   public.memories m ON m.id = mm.memory_id
      WHERE  mm.id = memory_image_pins.media_id
        AND  NOT m.is_hidden
        AND  (
          m.visibility = 'public'
          OR (m.visibility = 'community' AND auth.uid() IS NOT NULL)
          OR m.author_id = auth.uid()
        )
    )
  );

DROP POLICY IF EXISTS "memory_image_pins insert" ON public.memory_image_pins;
CREATE POLICY "memory_image_pins insert"
  ON public.memory_image_pins FOR INSERT
  WITH CHECK (
    author_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.memory_media mm
      JOIN   public.memories m ON m.id = mm.memory_id
      WHERE  mm.id = memory_image_pins.media_id
        AND  m.author_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "memory_image_pins update" ON public.memory_image_pins;
CREATE POLICY "memory_image_pins update"
  ON public.memory_image_pins FOR UPDATE
  USING (author_id = auth.uid()
         OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','moderator')));

DROP POLICY IF EXISTS "memory_image_pins delete" ON public.memory_image_pins;
CREATE POLICY "memory_image_pins delete"
  ON public.memory_image_pins FOR DELETE
  USING (author_id = auth.uid()
         OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

-- ── memory_comments ───────────────────────────────────────────────────────

DROP POLICY IF EXISTS "memory_comments read" ON public.memory_comments;
CREATE POLICY "memory_comments read"
  ON public.memory_comments FOR SELECT
  USING (
    NOT is_hidden
    AND EXISTS (
      SELECT 1 FROM public.memories m
      WHERE m.id = memory_comments.memory_id
        AND NOT m.is_hidden
        AND (
          m.visibility = 'public'
          OR (m.visibility = 'community' AND auth.uid() IS NOT NULL)
          OR m.author_id = auth.uid()
        )
    )
  );

DROP POLICY IF EXISTS "memory_comments insert" ON public.memory_comments;
CREATE POLICY "memory_comments insert"
  ON public.memory_comments FOR INSERT
  WITH CHECK (
    author_id = auth.uid()
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.memories m
      WHERE m.id = memory_comments.memory_id
        AND NOT m.is_hidden
        AND (
          m.visibility = 'public'
          OR (m.visibility = 'community' AND auth.uid() IS NOT NULL)
          OR m.author_id = auth.uid()
        )
    )
  );

DROP POLICY IF EXISTS "memory_comments update" ON public.memory_comments;
CREATE POLICY "memory_comments update"
  ON public.memory_comments FOR UPDATE
  USING (author_id = auth.uid()
         OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','moderator')));

DROP POLICY IF EXISTS "memory_comments delete" ON public.memory_comments;
CREATE POLICY "memory_comments delete"
  ON public.memory_comments FOR DELETE
  USING (author_id = auth.uid()
         OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','moderator')));

-- ── memory_reactions ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "memory_reactions read" ON public.memory_reactions;
CREATE POLICY "memory_reactions read"
  ON public.memory_reactions FOR SELECT
  USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "memory_reactions write" ON public.memory_reactions;
CREATE POLICY "memory_reactions write"
  ON public.memory_reactions FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "memory_reactions delete" ON public.memory_reactions;
CREATE POLICY "memory_reactions delete"
  ON public.memory_reactions FOR DELETE
  USING (user_id = auth.uid());

-- ══ 8. Storage bucket ══════════════════════════════════════════════════════

INSERT INTO storage.buckets (id, name, public)
VALUES ('memories-media', 'memories-media', TRUE)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

DROP POLICY IF EXISTS "memories-media public read"   ON storage.objects;
DROP POLICY IF EXISTS "memories-media author write"  ON storage.objects;
DROP POLICY IF EXISTS "memories-media author update" ON storage.objects;
DROP POLICY IF EXISTS "memories-media author delete" ON storage.objects;

CREATE POLICY "memories-media public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'memories-media');

-- Path: <memory_id>/<kind>/<filename>
-- Writer must own the memory (be its author) OR be a moderator/admin.
CREATE POLICY "memories-media author write"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'memories-media'
    AND auth.uid() IS NOT NULL
    AND (
      EXISTS (
        SELECT 1 FROM public.memories m
        WHERE m.id::text = (storage.foldername(name))[1]
          AND m.author_id = auth.uid()
      )
      OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','moderator'))
    )
  );

CREATE POLICY "memories-media author update"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'memories-media'
    AND (
      EXISTS (
        SELECT 1 FROM public.memories m
        WHERE m.id::text = (storage.foldername(name))[1]
          AND m.author_id = auth.uid()
      )
      OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','moderator'))
    )
  );

CREATE POLICY "memories-media author delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'memories-media'
    AND (
      EXISTS (
        SELECT 1 FROM public.memories m
        WHERE m.id::text = (storage.foldername(name))[1]
          AND m.author_id = auth.uid()
      )
      OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    )
  );

-- ══ 9. Helper RPC for the map view ═════════════════════════════════════════
--
-- Returns lightweight pin data for the map screen — only the columns the
-- map needs, only root memories (parent_id IS NULL), only within a bbox,
-- with hero media (one photo if any). One round-trip per region.

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
  media_count     INT,
  comment_count   INT,
  reaction_count  INT,
  child_count     INT,
  hero_url        TEXT,
  hero_kind       TEXT,
  created_at      TIMESTAMPTZ
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    m.id, m.lat, m.lng, m.place_name, m.title, m.era,
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
