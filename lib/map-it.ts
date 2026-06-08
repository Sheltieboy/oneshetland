/**
 * lib/map-it.ts
 *
 * Game logic for Map It — daily Shetland place-pinning game.
 *
 *   • Deterministic daily place picker (same 10 for everyone)
 *   • Haversine distance scoring with an exponential curve
 *   • AsyncStorage state so users can resume mid-session
 *   • Submits to existing games_scores + games_user_stats via submitScore()
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { distanceKm } from './shetland-geometry';

// ── Types ────────────────────────────────────────────────────────────────────

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface Place {
  id:         string;
  name:       string;
  category:   string;
  region:     string | null;
  lat:        number;
  lng:        number;
  difficulty: Difficulty;
}

export interface RoundResult {
  /** Place the round was about. */
  place:     Place;
  /** Where the user tapped. */
  guess:     { lat: number; lng: number };
  /** Distance in km. */
  distanceKm: number;
  /** Points scored for this round (0–1000). */
  points:    number;
}

export interface SessionState {
  dateKey:    string;
  places:     Place[];
  results:    RoundResult[];
  /** True once all rounds done and the score has been submitted to the server. */
  submitted:  boolean;
}

// ── Constants ────────────────────────────────────────────────────────────────

export const ROUNDS_PER_DAY = 10;
export const PRACTICE_ROUNDS = 5;
export const MAX_POINTS_PER_ROUND = 1000;

/** Mix of difficulties per daily set. Sums to ROUNDS_PER_DAY. */
const DIFFICULTY_MIX = { easy: 4, medium: 4, hard: 2 };
/** Mix of difficulties per practice batch. Sums to PRACTICE_ROUNDS. */
const PRACTICE_MIX  = { easy: 2, medium: 2, hard: 1 };

const STATE_KEY = (userId: string, dateKey: string) =>
  `mapit_state_v1_${userId}_${dateKey}`;

// ── Date helpers ─────────────────────────────────────────────────────────────

export function todayKey(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function formatDateLabel(key: string): string {
  // YYYY-MM-DD → "Saturday 6 June"
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
}

// ── Seeded PRNG (mulberry32) ─────────────────────────────────────────────────

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Levels ───────────────────────────────────────────────────────────────────

export interface LevelDef {
  level:  number;
  name:   string;    // Shetland-dialect flavoured title
  icon:   string;    // FontAwesome5 icon name
  color:  string;
  minPts: number;    // cumulative lifetime points required
}

/**
 * Five progressive ranks based on lifetime Map It points.
 * At ~3 000 pts/day (daily + a couple of practice batches) the typical
 * progression is: L1 day 1 → L2 day 2 → L3 ~day 5 → L4 ~day 12 → L5 ~day 30.
 */
export const LEVELS: LevelDef[] = [
  { level: 1, name: 'Peerie Wanderer',  icon: 'seedling', color: '#78C87E', minPts: 0      },
  { level: 2, name: 'Geo Explorer',     icon: 'water',    color: '#5BC0DE', minPts: 2500   },
  { level: 3, name: 'Voe Voyager',      icon: 'ship',     color: '#4A90D9', minPts: 10000  },
  { level: 4, name: 'Isle Skipper',     icon: 'anchor',   color: '#9B59B6', minPts: 25000  },
  { level: 5, name: 'Shetland Maaster', icon: 'crown',    color: '#FFD700', minPts: 60000  },
];

export function getLevelInfo(cumulativePts: number) {
  let idx = 0;
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (cumulativePts >= LEVELS[i].minPts) { idx = i; break; }
  }
  const current  = LEVELS[idx];
  const next     = LEVELS[idx + 1] ?? null;
  const progress = next
    ? (cumulativePts - current.minPts) / (next.minPts - current.minPts)
    : 1;
  return { current, next, progress, cumulativePts };
}

const CUMULATIVE_KEY = 'map_it_cumulative_pts_v1';

export async function loadCumulativePts(): Promise<number> {
  try {
    const s = await AsyncStorage.getItem(CUMULATIVE_KEY);
    return s ? parseInt(s, 10) : 0;
  } catch { return 0; }
}

export async function addCumulativePts(pts: number): Promise<number> {
  try {
    const current = await loadCumulativePts();
    const next    = current + pts;
    await AsyncStorage.setItem(CUMULATIVE_KEY, String(next));
    return next;
  } catch { return pts; }
}

// ── Place pool & daily pick ──────────────────────────────────────────────────

let cachedPool: Place[] | null = null;

export async function loadPlacePool(): Promise<Place[]> {
  if (cachedPool && cachedPool.length > 0) return cachedPool;

  const { data, error } = await supabase
    .from('game_shetland_places')
    .select('id, name, category, region, lat, lng, difficulty, is_active')
    .eq('is_active', true)
    .limit(1000);

  if (error) throw error;

  const pool: Place[] = (data ?? []).map(r => ({
    id:         r.id as string,
    name:       r.name as string,
    category:   r.category as string,
    region:     r.region as string | null,
    lat:        Number(r.lat),
    lng:        Number(r.lng),
    difficulty: r.difficulty as Difficulty,
  }));

  cachedPool = pool;
  return pool;
}

export function pickDailyPlaces(dateKey: string, pool: Place[]): Place[] {
  const rng = mulberry32(hashString(`mapit-${dateKey}`));

  const byDiff: Record<Difficulty, Place[]> = {
    easy:   pool.filter(p => p.difficulty === 'easy'),
    medium: pool.filter(p => p.difficulty === 'medium'),
    hard:   pool.filter(p => p.difficulty === 'hard'),
  };

  const picks: Place[] = [];
  (Object.keys(DIFFICULTY_MIX) as Difficulty[]).forEach(diff => {
    const shuffled = shuffleInPlace([...byDiff[diff]], rng);
    picks.push(...shuffled.slice(0, DIFFICULTY_MIX[diff]));
  });

  // Final shuffle so difficulty doesn't appear in clumps.
  return shuffleInPlace(picks, rng);
}

/** Pick a fresh random batch for practice (excludes today's daily places). */
export function pickPracticeRounds(pool: Place[], excludeIds: string[] = []): Place[] {
  const rng       = mulberry32((Date.now() * 1000 + Math.floor(Math.random() * 999)) >>> 0);
  const available = pool.filter(p => !excludeIds.includes(p.id));

  const byDiff: Record<Difficulty, Place[]> = {
    easy:   available.filter(p => p.difficulty === 'easy'),
    medium: available.filter(p => p.difficulty === 'medium'),
    hard:   available.filter(p => p.difficulty === 'hard'),
  };

  const picks: Place[] = [];
  (Object.keys(PRACTICE_MIX) as Difficulty[]).forEach(diff => {
    const shuffled = shuffleInPlace([...byDiff[diff]], rng);
    picks.push(...shuffled.slice(0, PRACTICE_MIX[diff as keyof typeof PRACTICE_MIX]));
  });

  return shuffleInPlace(picks, rng);
}

// ── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Exponential decay: 1000 points for a perfect pin, smoothly dropping to
 * near zero at 50 km away. The 10 km half-life means typical "close-but-not-
 * great" guesses (5–10 km) still feel rewarding (~600 → 370 points).
 *
 *   distance (km) | points
 *   --------------+-------
 *   0             | 1000
 *   0.5           | 951
 *   1             | 905
 *   2             | 819
 *   5             | 607
 *   10            | 368
 *   20            | 135
 *   50            | 7
 */
export function scoreForDistance(distanceKm: number): number {
  if (distanceKm <= 0) return MAX_POINTS_PER_ROUND;
  const points = MAX_POINTS_PER_ROUND * Math.exp(-distanceKm / 10);
  return Math.round(points);
}

/** Star rating: 3 ≤ 1km, 2 ≤ 5km, 1 ≤ 25km, 0 beyond. */
export function starsForDistance(distanceKm: number): 0 | 1 | 2 | 3 {
  if (distanceKm <= 1)  return 3;
  if (distanceKm <= 5)  return 2;
  if (distanceKm <= 25) return 1;
  return 0;
}

export function totalScore(results: RoundResult[]): number {
  return results.reduce((s, r) => s + r.points, 0);
}

export function resolveRound(
  place: Place,
  guess: { lat: number; lng: number },
): RoundResult {
  const d = distanceKm(place, guess);
  return {
    place,
    guess,
    distanceKm: d,
    points: scoreForDistance(d),
  };
}

// ── AsyncStorage state (resume mid-session) ──────────────────────────────────

export async function loadSession(
  userId: string,
  dateKey: string,
): Promise<SessionState | null> {
  try {
    const raw = await AsyncStorage.getItem(STATE_KEY(userId, dateKey));
    if (!raw) return null;
    return JSON.parse(raw) as SessionState;
  } catch {
    return null;
  }
}

export async function saveSession(
  userId: string,
  state: SessionState,
): Promise<void> {
  try {
    await AsyncStorage.setItem(STATE_KEY(userId, state.dateKey), JSON.stringify(state));
  } catch {
    /* non-fatal */
  }
}

export async function clearSession(userId: string, dateKey: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(STATE_KEY(userId, dateKey));
  } catch {
    /* non-fatal */
  }
}

// ── Share text ───────────────────────────────────────────────────────────────

/** Wordle-style emoji grid: ⚓ = 3-star, 〰 = 2-star, · = 1-star, ✕ = 0-star. */
export function buildShareText(state: SessionState, total: number): string {
  const dateLabel = formatDateLabel(state.dateKey);
  const grid = state.results
    .map(r => {
      const s = starsForDistance(r.distanceKm);
      return s === 3 ? '⚓' : s === 2 ? '〰' : s === 1 ? '·' : '✕';
    })
    .join(' ');
  return `Map It · ${dateLabel}
${total.toLocaleString()} / ${ROUNDS_PER_DAY * MAX_POINTS_PER_ROUND} pts
${grid}

OneShetland`;
}
