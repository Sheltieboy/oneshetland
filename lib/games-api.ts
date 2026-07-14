/**
 * games-api.ts
 * Supabase calls + helpers for the OneShetland Games Centre.
 *
 * One scores table backs every game; new games just choose a new `game_id`.
 * Stats are maintained client-side after each score (simpler than triggers).
 */

import { supabase } from './supabase';
import { BASE_TRIES } from './guess-da-wird';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Add new games here as they ship. The string value lives in the DB. */
export const GAMES = {
  spik_sprint:   { id: 'spik_sprint',   label: 'Spik Sprint',   icon: 'bolt',         live: true,  description: '60-second tap-the-right-meaning speed round.' },
  spik_snap:     { id: 'spik_snap',     label: 'Spik Snap',     icon: 'hand-paper',   live: true,  description: 'Swipe right if the meaning matches, left if not.' },
  guess_da_wird: { id: 'guess_da_wird', label: 'Guess Da Wird', icon: 'puzzle-piece', live: true,  description: `Daily Shetland dialect word puzzle. ${BASE_TRIES} tries. Progressive clues.` },
  map_it:        { id: 'map_it',        label: 'Map It',        icon: 'map-marker-alt', live: true, description: 'Pin Shetland places on the map. 10 rounds. The closer, the better.' },
} as const;

export type GameId = keyof typeof GAMES;

export interface GameScore {
  id:          string;
  user_id:     string;
  game_id:     string;
  score:       number;
  duration_ms: number | null;
  metadata:    Record<string, unknown> | null;
  played_at:   string;
}

export interface UserGameStats {
  user_id:             string;
  total_xp:            number;
  level:               number;
  current_streak_days: number;
  longest_streak_days: number;
  last_played_date:    string | null;
  games_played:        number;
  updated_at:          string;
}

export interface LeaderboardRow {
  user_id:       string;
  games_handle:  string | null;
  best_score:    number;
  played_at:     string;
}

// ── Levels / XP ───────────────────────────────────────────────────────────────

/** XP needed to reach a given level. Tweak the curve as we go. */
export function xpForLevel(level: number): number {
  // 100 → 250 → 450 → 700 → 1000 ...
  return Math.round(100 * level + 50 * level * (level - 1));
}

/** Given total XP, return the current level. */
export function levelFromXp(xp: number): number {
  let level = 1;
  while (xp >= xpForLevel(level + 1)) level++;
  return level;
}

/** Friendly level title — "Peerie Beginner" → "Da Spik Master" */
export function levelTitle(level: number): string {
  if (level <= 1)  return 'Peerie Beginner';
  if (level <= 3)  return 'Learner';
  if (level <= 6)  return 'Spik Speaker';
  if (level <= 10) return 'Dialect Don';
  return 'Da Spik Master';
}

// ── Scores ────────────────────────────────────────────────────────────────────

/** Submit a score for a game and update the user's stats in one go. */
export async function submitScore(
  userId: string,
  gameId: GameId,
  score: number,
  opts?: { durationMs?: number; metadata?: Record<string, unknown>; xpEarned?: number },
): Promise<void> {
  const { error } = await supabase
    .from('games_scores')
    .insert({
      user_id:     userId,
      game_id:     gameId,
      score,
      duration_ms: opts?.durationMs ?? null,
      metadata:    opts?.metadata ?? null,
    });
  if (error) throw error;

  await updateStatsAfterPlay(userId, opts?.xpEarned ?? score);
}

/** Read-modify-write the user's stats table. Acceptable at this scale. */
async function updateStatsAfterPlay(userId: string, xpGained: number): Promise<void> {
  const { data: existing } = await supabase
    .from('games_user_stats')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().split('T')[0];

  const lastPlayed = existing?.last_played_date as string | null | undefined;

  let streak = existing?.current_streak_days ?? 0;
  if (lastPlayed === today)         { /* same day — streak unchanged */ }
  else if (lastPlayed === yesterday) { streak += 1; }
  else                                { streak = 1; }

  const longestStreak = Math.max(existing?.longest_streak_days ?? 0, streak);
  const newXp         = (existing?.total_xp ?? 0) + xpGained;

  await supabase
    .from('games_user_stats')
    .upsert({
      user_id:             userId,
      total_xp:            newXp,
      level:               levelFromXp(newXp),
      current_streak_days: streak,
      longest_streak_days: longestStreak,
      last_played_date:    today,
      games_played:        (existing?.games_played ?? 0) + 1,
      updated_at:          new Date().toISOString(),
    }, { onConflict: 'user_id' });
}

// ── Stats / leaderboards ─────────────────────────────────────────────────────

export async function fetchUserStats(userId: string): Promise<UserGameStats | null> {
  const { data } = await supabase
    .from('games_user_stats')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  return (data ?? null) as UserGameStats | null;
}

/** Top scores for a game over the given window. */
export async function fetchTopScores(
  gameId: GameId,
  period: 'today' | 'week' | 'all' = 'all',
  limit = 10,
): Promise<LeaderboardRow[]> {
  let q = supabase
    .from('games_scores')
    .select('user_id, score, played_at')
    .eq('game_id', gameId)
    .order('score', { ascending: false })
    .order('played_at', { ascending: true })
    .limit(200);   // overfetch — we de-dupe by user below

  if (period === 'today') {
    const since = new Date(); since.setHours(0, 0, 0, 0);
    q = q.gte('played_at', since.toISOString());
  } else if (period === 'week') {
    const since = new Date(Date.now() - 7 * 86_400_000);
    q = q.gte('played_at', since.toISOString());
  }

  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as Array<{ user_id: string; score: number; played_at: string }>;

  // Keep only the best score per user
  const best = new Map<string, { score: number; played_at: string }>();
  for (const r of rows) {
    const cur = best.get(r.user_id);
    if (!cur || r.score > cur.score) best.set(r.user_id, { score: r.score, played_at: r.played_at });
  }
  const userIds = Array.from(best.keys());
  if (userIds.length === 0) return [];

  // Leaderboards use the games handle, NOT the full name — keeps people
  // from being doxxed by their real name when they appear on a public board.
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, games_handle')
    .in('id', userIds);
  const handleMap = Object.fromEntries((profiles ?? []).map(p => [p.id, p.games_handle]));

  return userIds
    .map(uid => ({
      user_id: uid,
      games_handle: handleMap[uid] ?? null,
      best_score: best.get(uid)!.score,
      played_at: best.get(uid)!.played_at,
    }))
    .sort((a, b) => b.best_score - a.best_score)
    .slice(0, limit);
}

// ── Per-game breakdown (for the stats drill-in screen) ──────────────────────

export interface GameBreakdownEntry {
  game_id:       string;
  best_score:    number;
  games_played:  number;
  average_score: number;
  last_played:   string | null;
}

/** Per-game breakdown for one user — used by the Games stats screen. */
export async function fetchGameBreakdown(userId: string): Promise<GameBreakdownEntry[]> {
  const { data, error } = await supabase
    .from('games_scores')
    .select('game_id, score, played_at')
    .eq('user_id', userId)
    .order('played_at', { ascending: false });
  if (error) throw error;

  const rows = (data ?? []) as Array<{ game_id: string; score: number; played_at: string }>;
  const byGame = new Map<string, { scores: number[]; last: string }>();
  for (const r of rows) {
    const e = byGame.get(r.game_id);
    if (e) { e.scores.push(r.score); }
    else   { byGame.set(r.game_id, { scores: [r.score], last: r.played_at }); }
  }

  return Array.from(byGame.entries()).map(([game_id, e]) => ({
    game_id,
    best_score:    Math.max(...e.scores),
    games_played:  e.scores.length,
    average_score: Math.round(e.scores.reduce((a, b) => a + b, 0) / e.scores.length),
    last_played:   e.last,
  }));
}

/** Most recent scores for one user, newest first. */
export async function fetchMyRecentScores(userId: string, limit = 10): Promise<GameScore[]> {
  const { data, error } = await supabase
    .from('games_scores')
    .select('*')
    .eq('user_id', userId)
    .order('played_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as GameScore[];
}

/** This user's personal best for a given game. */
export async function fetchMyBestScore(userId: string, gameId: GameId): Promise<number> {
  const { data } = await supabase
    .from('games_scores')
    .select('score')
    .eq('user_id', userId)
    .eq('game_id', gameId)
    .order('score', { ascending: false })
    .limit(1);
  return data?.[0]?.score ?? 0;
}
