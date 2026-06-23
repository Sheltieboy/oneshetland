-- ── 043_vessel_comments.sql ────────────────────────────────────────────────
--
-- Adds a discussion thread to every vessel in Da Boats. The men (and
-- women) who knew these boats are the only people who can fill the gaps
-- the Wildmuir catalogues and the GOV.UK register never captured.
--
-- Design choices
--
--   * One thread per vessel, comments are chronological. Each comment
--     can be optionally anchored to a subject ("about the names",
--     "about the owners") via subject_type so the UI can show a chip
--     and offer filters, but the underlying storage stays a single
--     flat list per vessel.
--
--   * One level of replies — a parent_comment_id pointer is enough.
--     Avoids the depth-tax of full nesting, while still letting
--     someone reply specifically to a correction.
--
--   * Soft-hide via is_hidden. Authors can delete their own; mods/
--     admins can hide anyone's. Hidden rows stay in the DB so we can
--     restore them.
--
--   * Maintained vessels.comment_count via trigger — keeps the
--     landing/profile "12 comments" badges cheap.
--
-- Idempotent — safe to re-run.
-- ────────────────────────────────────────────────────────────────────────────

-- ══ 1. The comments table ══════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.vessel_comments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vessel_id       UUID NOT NULL REFERENCES public.vessels(id) ON DELETE CASCADE,
  author_id       UUID REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- Optional subject anchor. Free text so we can iterate the picker
  -- without a migration; the UI offers a fixed list of canonical slugs.
  -- 'general' is the default for top-level boat-wide comments.
  subject_type    TEXT NOT NULL DEFAULT 'general',

  -- Optional pointer at a specific row (vessel_names.id,
  -- registrations.id, ownership_periods.id, vessel_events.id,
  -- media_assets.id, …) for hyper-specific corrections. Free-form so
  -- the application can decide which row types are addressable.
  subject_row_id  UUID,

  -- One-level thread: NULL = top-level, set = reply to another comment.
  parent_comment_id UUID REFERENCES public.vessel_comments(id) ON DELETE CASCADE,

  body            TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4000),

  -- Moderation. Hidden rows are invisible to everyone except the moderator
  -- who hid them and admins.
  is_hidden       BOOLEAN NOT NULL DEFAULT FALSE,
  hidden_by       UUID REFERENCES public.profiles(id),
  hidden_reason   TEXT,
  hidden_at       TIMESTAMPTZ,

  -- Edit tracking for UI affordance.
  edited_at       TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vessel_comments_vessel
  ON public.vessel_comments(vessel_id, created_at);

CREATE INDEX IF NOT EXISTS idx_vessel_comments_parent
  ON public.vessel_comments(parent_comment_id)
  WHERE parent_comment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vessel_comments_author
  ON public.vessel_comments(author_id);

-- ══ 2. Comment-count column on vessels ═════════════════════════════════════

ALTER TABLE public.vessels
  ADD COLUMN IF NOT EXISTS comment_count INT NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.tg_vessel_comment_count() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NOT NEW.is_hidden THEN
    UPDATE public.vessels SET comment_count = comment_count + 1
      WHERE id = NEW.vessel_id;
  ELSIF TG_OP = 'DELETE' AND NOT OLD.is_hidden THEN
    UPDATE public.vessels SET comment_count = GREATEST(comment_count - 1, 0)
      WHERE id = OLD.vessel_id;
  ELSIF TG_OP = 'UPDATE' AND OLD.is_hidden IS DISTINCT FROM NEW.is_hidden THEN
    UPDATE public.vessels
       SET comment_count = comment_count
                          + CASE WHEN NEW.is_hidden THEN -1 ELSE 1 END
     WHERE id = NEW.vessel_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_vessel_comment_count_aiud ON public.vessel_comments;
CREATE TRIGGER tg_vessel_comment_count_aiud
  AFTER INSERT OR UPDATE OR DELETE ON public.vessel_comments
  FOR EACH ROW EXECUTE FUNCTION public.tg_vessel_comment_count();

-- ══ 3. Refresh the vessel_search view to surface comment_count ═════════════

DROP VIEW IF EXISTS public.vessel_search;
CREATE VIEW public.vessel_search AS
SELECT
  v.id,
  v.canonical_name,
  v.primary_lk_number,
  v.built_year,
  v.builder,
  v.hull_material,
  v.status,
  v.identity_confidence,
  v.comment_count,
  string_agg(DISTINCT n.name, ', ' ORDER BY n.name)                AS all_names,
  string_agg(DISTINCT r.registration, ', ' ORDER BY r.registration) AS all_registrations,
  count(DISTINCT l.source_record_id)                              AS source_record_count,
  count(DISTINCT ml.media_asset_id)                               AS media_asset_count
FROM public.vessels v
LEFT JOIN public.vessel_names         n  ON n.vessel_id  = v.id
LEFT JOIN public.registrations        r  ON r.vessel_id  = v.id
LEFT JOIN public.vessel_source_links  l  ON l.vessel_id  = v.id
LEFT JOIN public.vessel_media_links   ml ON ml.vessel_id = v.id
GROUP BY
  v.id, v.canonical_name, v.primary_lk_number, v.built_year,
  v.builder, v.hull_material, v.status, v.identity_confidence,
  v.comment_count;

GRANT SELECT ON public.vessel_search TO anon, authenticated;

-- ══ 4. RLS ═════════════════════════════════════════════════════════════════
--
-- Reads: anyone (including signed-out browsers) can see non-hidden
--        comments. Helps community wisdom spread.
-- Writes: signed-in users only — they own what they post.
-- Edit/Delete: author owns their own; mods/admins can hide anyone's.

ALTER TABLE public.vessel_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "vessel_comments read"     ON public.vessel_comments;
DROP POLICY IF EXISTS "vessel_comments insert"   ON public.vessel_comments;
DROP POLICY IF EXISTS "vessel_comments update"   ON public.vessel_comments;
DROP POLICY IF EXISTS "vessel_comments delete"   ON public.vessel_comments;

CREATE POLICY "vessel_comments read"
  ON public.vessel_comments FOR SELECT
  USING (
    NOT is_hidden
    OR author_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.profiles p
                WHERE p.id = auth.uid() AND p.role IN ('admin','moderator'))
  );

CREATE POLICY "vessel_comments insert"
  ON public.vessel_comments FOR INSERT
  WITH CHECK (
    author_id = auth.uid()
    AND auth.uid() IS NOT NULL
  );

CREATE POLICY "vessel_comments update"
  ON public.vessel_comments FOR UPDATE
  USING (
    author_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.profiles p
                WHERE p.id = auth.uid() AND p.role IN ('admin','moderator'))
  );

CREATE POLICY "vessel_comments delete"
  ON public.vessel_comments FOR DELETE
  USING (
    author_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.profiles p
                WHERE p.id = auth.uid() AND p.role = 'admin')
  );
