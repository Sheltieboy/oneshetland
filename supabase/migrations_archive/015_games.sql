-- ── OneShetland Games ─────────────────────────────────────────────────────────
-- Foundation for the Games Centre: scores, per-user stats, leaderboards.
-- Individual games (Guess Da Wird, Spik Sprint, Spik Snap, etc.) all write to
-- this single scores table — keyed by a free-form game_id string. Easy to add
-- new games later without schema changes.

CREATE TABLE IF NOT EXISTS public.games_scores (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  game_id     TEXT NOT NULL,         -- 'guess_da_wird' | 'spik_sprint' | 'spik_snap' | ...
  score       INT NOT NULL,
  duration_ms INT,                   -- optional: length of the round for speed games
  metadata    JSONB,                 -- words played, streak count, difficulty, etc.
  played_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Leaderboard lookups
CREATE INDEX IF NOT EXISTS idx_games_scores_leaderboard
  ON public.games_scores (game_id, score DESC, played_at DESC);

-- "My recent games" lookups
CREATE INDEX IF NOT EXISTS idx_games_scores_user_recent
  ON public.games_scores (user_id, played_at DESC);

-- Today/this-week filters
CREATE INDEX IF NOT EXISTS idx_games_scores_recent
  ON public.games_scores (played_at DESC);

ALTER TABLE public.games_scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read scores"
  ON public.games_scores FOR SELECT
  USING (true);

CREATE POLICY "Users can insert their own scores"
  ON public.games_scores FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- ── Per-user aggregated stats ────────────────────────────────────────────────
-- Maintained client-side after each game (simpler than triggers; can switch to
-- a DB function later if drift becomes a problem).

CREATE TABLE IF NOT EXISTS public.games_user_stats (
  user_id              UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  total_xp             INT DEFAULT 0,
  level                INT DEFAULT 1,
  current_streak_days  INT DEFAULT 0,
  longest_streak_days  INT DEFAULT 0,
  last_played_date     DATE,
  games_played         INT DEFAULT 0,
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.games_user_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read user stats (for leaderboards)"
  ON public.games_user_stats FOR SELECT
  USING (true);

CREATE POLICY "Users manage their own stats"
  ON public.games_user_stats FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
