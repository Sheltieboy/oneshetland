-- ── 031_spik_dictionary_game_columns.sql ────────────────────────────────────
--
-- Adds columns to spik_dictionary that are defined in the WordPress ACF schema
-- (DB/spik.php) but were not previously replicated in Supabase.
--
-- All changes are ADD COLUMN IF NOT EXISTS so this migration is safe to re-run.
-- The columns match the ACF field names exactly so WordPress→Supabase syncs
-- can write to them without transformation.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Word lifecycle ────────────────────────────────────────────────────────────
-- word_status controls what's visible in the game pool.
-- Only 'approved' and 'published' words appear in Guess Da Wird.
ALTER TABLE public.spik_dictionary
  ADD COLUMN IF NOT EXISTS word_status TEXT
    CHECK (word_status IN ('draft','review','approved','published','archived','duplicate','rejected'));

CREATE INDEX IF NOT EXISTS idx_spik_word_status
  ON public.spik_dictionary(word_status)
  WHERE word_status IN ('approved','published');

-- ── Language metadata ─────────────────────────────────────────────────────────
-- era: whether the word is current usage or historical
ALTER TABLE public.spik_dictionary
  ADD COLUMN IF NOT EXISTS era TEXT
    CHECK (era IN ('older','current','archaic','neutral'));

-- tone: used to filter inappropriate words from the game pool
ALTER TABLE public.spik_dictionary
  ADD COLUMN IF NOT EXISTS tone TEXT
    CHECK (tone IN ('neutral','harsh','insult','humorous','affectionate','warm'));

-- ── Search / normalisation ────────────────────────────────────────────────────
ALTER TABLE public.spik_dictionary
  ADD COLUMN IF NOT EXISTS stripped_word TEXT;

ALTER TABLE public.spik_dictionary
  ADD COLUMN IF NOT EXISTS number_letters INT
    CHECK (number_letters >= 0);

CREATE INDEX IF NOT EXISTS idx_spik_number_letters
  ON public.spik_dictionary(number_letters);

-- ── Wirdil (Guess Da Wird) curated hints ─────────────────────────────────────
-- These are manually curated per-word hints used in the progressive clue system.
-- wirdil_hint_1: soft meaning / first clue
-- wirdil_hint_2: category / theme clue
-- wirdil_hint_3: additional context / first-letter reveal context
ALTER TABLE public.spik_dictionary
  ADD COLUMN IF NOT EXISTS wirdil_hint_1 TEXT;
ALTER TABLE public.spik_dictionary
  ADD COLUMN IF NOT EXISTS wirdil_hint_2 TEXT;
ALTER TABLE public.spik_dictionary
  ADD COLUMN IF NOT EXISTS wirdil_hint_3 TEXT;

-- ── Grants (match existing pattern from migration 025) ────────────────────────
-- New columns inherit table-level RLS; just ensure roles can read them.
-- The _os_grant helper from migration 025 fires GRANT on a named table.
-- New columns on an already-granted table don't need explicit column grants
-- in Postgres — the table-level GRANT SELECT covers them. No action needed.

-- ── Back-fill number_letters from word column ─────────────────────────────────
-- Populate for rows that already exist so the game can use it immediately.
UPDATE public.spik_dictionary
   SET number_letters = LENGTH(TRIM(word))
 WHERE number_letters IS NULL
   AND word IS NOT NULL
   AND TRIM(word) <> '';

-- ── Back-fill stripped_word (lowercase, no diacritics, alpha only) ────────────
UPDATE public.spik_dictionary
   SET stripped_word = LOWER(REGEXP_REPLACE(TRIM(word), '[^a-zA-Z]', '', 'g'))
 WHERE stripped_word IS NULL
   AND word IS NOT NULL
   AND TRIM(word) <> '';

-- ── Trigger: keep number_letters and stripped_word in sync on insert/update ───
CREATE OR REPLACE FUNCTION public.tg_spik_sync_computed_fields()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.word IS NOT NULL THEN
    NEW.number_letters := LENGTH(TRIM(NEW.word));
    NEW.stripped_word  := LOWER(REGEXP_REPLACE(TRIM(NEW.word), '[^a-zA-Z]', '', 'g'));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS spik_sync_computed_fields ON public.spik_dictionary;
CREATE TRIGGER spik_sync_computed_fields
  BEFORE INSERT OR UPDATE OF word ON public.spik_dictionary
  FOR EACH ROW EXECUTE FUNCTION public.tg_spik_sync_computed_fields();
