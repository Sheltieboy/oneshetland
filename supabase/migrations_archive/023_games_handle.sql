-- ── Games handle on profiles ─────────────────────────────────────────────────
-- A separate, public-facing name used on Games Centre leaderboards so people
-- aren't doxxed by their real full_name. Optional — null = show as "Anon".
--
-- Format: 3–20 chars, [A-Za-z0-9_-], no spaces. Case-insensitive uniqueness so
-- "ShetlandSpik" and "shetlandspik" can't both exist. Belt-and-braces format
-- check in SQL because the client validator is best-effort.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS games_handle TEXT;

-- Case-insensitive uniqueness. Partial index keeps nulls collision-free.
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_games_handle_unique
  ON public.profiles (lower(games_handle))
  WHERE games_handle IS NOT NULL;

-- Server-side format guard
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_games_handle_format;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_games_handle_format
  CHECK (
    games_handle IS NULL
    OR (
      char_length(games_handle) BETWEEN 3 AND 20
      AND games_handle ~ '^[A-Za-z0-9_-]+$'
    )
  );

COMMENT ON COLUMN public.profiles.games_handle IS
  'Public handle shown on Games Centre leaderboards. Optional. 3–20 chars, '
  '[A-Za-z0-9_-]. Case-insensitively unique. Falls back to "Anon" when null.';
