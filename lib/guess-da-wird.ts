/**
 * lib/guess-da-wird.ts
 *
 * All non-UI logic for Guess Da Wird — the daily Shetland dialect word game.
 *
 * Schema used (from spik_dictionary ACF field definitions):
 *   word, word_status, short_meaning, spik_meaning, example_sentence,
 *   part_of_speech, category, usage_level, era, tone,
 *   wirdil_hint_1, wirdil_hint_2, wirdil_hint_3,
 *   number_letters, pronunciation
 *
 * Word selection rules:
 *   - Only `word_status` IN ('approved', 'published')
 *   - 3–8 letters only (using number_letters where available, word.length fallback)
 *   - Pure alphabet + apostrophe + hyphen characters
 *   - Daily word seeded deterministically by date — all players see the same wird
 *   - Prefer `usage_level` IN ('common', 'known') for the daily pool
 *   - Avoid `era = 'archaic'` in the easy daily rotation
 *   - Avoid `tone IN ('harsh', 'insult')` always
 *
 * Letter states (original, not Wordle-derived):
 *   "Anchored"  — right letter, right position   → sea-blue
 *   "Drifting"  — right letter, wrong position   → amber
 *   "Away"      — letter not in the wird          → slate
 *
 * Scoring: 1000 base − 100 per try − 20 per clue + 50 per unused try. Min 50.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

// ── Types ─────────────────────────────────────────────────────────────────────

export type LetterState = 'anchored' | 'drifting' | 'away' | 'empty';

export interface LetterResult {
  letter: string;
  state:  LetterState;
}

export interface GuessRow {
  word:    string;
  letters: LetterResult[];
}

export type ClueLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface GdwClue {
  level:   ClueLevel;
  icon:    string;                // FontAwesome5 name
  label:   string;                // button label shown before reveal
  content: string;                // revealed text
}

export interface DailyWird {
  id:               number;
  word:             string;
  meaning:          string;       // short_meaning or spik_meaning
  full_meaning:     string | null;
  part_of_speech:   string | null;
  example_sentence: string | null;
  usage_level:      string | null;
  category:         string | null;
  era:              string | null;
  tone:             string | null;
  pronunciation:    string | null;
  wirdil_hint_1:    string | null;
  wirdil_hint_2:    string | null;
  wirdil_hint_3:    string | null;
  date_key:         string;       // 'YYYY-MM-DD' this wird is for
  difficulty:       number;       // 1 = easy, 2 = medium, 3 = hard (derived)
}

export interface DailyStats {
  played:        number;
  won:           number;
  currentStreak: number;
  bestStreak:    number;
  lastDate:      string | null;
  distribution:  number[];        // index = tries-1 (0..7), value = win count at that try
  cluesUsed:     number;
  fastestSolve:  number | null;   // seconds, null if never timed
}

export interface SavedDailyState {
  dateKey:    string;
  guesses:    string[];
  won:        boolean;
  lost:       boolean;
  cluesShown: ClueLevel;
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const MIN_LEN   = 3;
export const MAX_LEN   = 8;
export const BASE_TRIES = 7;
export const LONG_TRIES = 8;   // words ≥ 7 letters

// Category → human theme label
const CATEGORY_THEME: Record<string, string> = {
  emotion:  'feelings and emotions',
  nature:   'the natural world',
  sea:      'the sea and fishing',
  object:   'everyday objects',
  action:   'actions and doing',
  animals:  'animals and creatures',
  quality:  'qualities and descriptions',
  people:   'people and community',
  clothing: 'clothing and textiles',
  food:     'food and drink',
  body:     'the body',
  home:     'home and hearth',
  place:    'places and landscape',
  work:     'work and trades',
  weather:  'weather and the elements',
  time:     'time',
};

// ── Difficulty scoring ────────────────────────────────────────────────────────

/**
 * Derive a difficulty score 1–3 from the rich ACF metadata.
 *   1 = easy:   common, current, short, good meaning, has hints
 *   2 = medium: known, neutral era, medium length
 *   3 = hard:   less common/rare/uncommon, archaic, long, no meaning clues
 */
export function deriveDifficulty(w: {
  usage_level:      string | null;
  era:              string | null;
  word:             string;
  short_meaning:    string | null;
  example_sentence: string | null;
  wirdil_hint_1:    string | null;
}): number {
  let score = 0;

  // Usage level (most important signal)
  const ul = (w.usage_level ?? '').toLowerCase();
  if (ul === 'common')      score += 0;
  else if (ul === 'known')  score += 1;
  else                       score += 3;   // less common / rare / uncommon

  // Era
  const era = (w.era ?? '').toLowerCase();
  if (era === 'archaic')    score += 2;
  else if (era === 'older') score += 1;

  // Word length
  const len = w.word.length;
  if (len <= 4)      score += 0;
  else if (len <= 6) score += 1;
  else               score += 2;

  // Richness of data (more data = easier to clue)
  if (!w.short_meaning && !w.example_sentence) score += 1;
  if (!w.wirdil_hint_1) score += 1;

  // Map to 1–3
  if (score <= 1) return 1;
  if (score <= 4) return 2;
  return 3;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

export function todayKey(): string {
  return new Date().toISOString().split('T')[0];
}

/** Stable integer from 'YYYY-MM-DD'. */
function dateToSeed(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  return y * 10000 + m * 100 + d;
}

/** LCG seeded pseudo-random in [0, max). Stable per-seed. */
function seededIndex(seed: number, max: number): number {
  const a = 1664525, c = 1013904223, m = 2 ** 32;
  const v = (a * seed + c) % m;
  return Math.abs(v) % max;
}

// ── Word pool ─────────────────────────────────────────────────────────────────

export interface WirdCandidate {
  id:               number;
  word:             string;
  short_meaning:    string | null;
  spik_meaning:     string | null;
  example_sentence: string | null;
  part_of_speech:   string | null;
  category:         string | null;
  usage_level:      string | null;
  era:              string | null;
  tone:             string | null;
  pronunciation:    string | null;
  wirdil_hint_1:    string | null;
  wirdil_hint_2:    string | null;
  wirdil_hint_3:    string | null;
  difficulty:       number;
}

let poolCache:      WirdCandidate[] | null = null;
let guessPoolCache: Set<string>    | null = null;

export async function loadWirdPool(): Promise<WirdCandidate[]> {
  if (poolCache && poolCache.length > 0) return poolCache;

  // Fetch only approved/published words with a usable meaning.
  // Filter tones that are inappropriate for a public daily game.
  const { data, error } = await supabase
    .from('spik_dictionary')
    .select([
      'id', 'word', 'short_meaning', 'spik_meaning', 'part_of_speech',
      'example_sentence', 'category', 'usage_level', 'era', 'tone',
      'pronunciation', 'wirdil_hint_1', 'wirdil_hint_2', 'wirdil_hint_3',
      'word_status',
    ].join(', '))
    .in('word_status', ['approved', 'published'])
    .not('tone', 'in', '("harsh","insult")')
    .or('short_meaning.not.is.null,spik_meaning.not.is.null')
    .limit(6000);

  // If word_status filter returned an error OR zero rows (column exists but no
  // words have been status-tagged yet from WordPress), fall back to fetching
  // the full dictionary without the status filter.
  const needsFallback = !!error || !data || data.length === 0;

  if (needsFallback) {
    if (error) {
      console.warn('[guess-da-wird] word_status filter failed, retrying without:', error.message);
    } else {
      console.info('[guess-da-wird] word_status returned 0 rows — falling back to full pool (words not yet tagged)');
    }
    const { data: fallback, error: err2 } = await supabase
      .from('spik_dictionary')
      .select('id, word, short_meaning, spik_meaning, part_of_speech, example_sentence, category, usage_level, era, tone, pronunciation, wirdil_hint_1, wirdil_hint_2, wirdil_hint_3')
      .or('short_meaning.not.is.null,spik_meaning.not.is.null')
      .limit(6000);
    if (err2) throw err2;
    poolCache = buildPool(fallback ?? []);
    return poolCache;
  }

  poolCache = buildPool(data);
  return poolCache;
}

function buildPool(rows: any[]): WirdCandidate[] {
  return rows
    .map((r: any) => {
      const word = (r.word ?? '').trim().toLowerCase();
      return {
        id:               r.id,
        word,
        short_meaning:    r.short_meaning ?? null,
        spik_meaning:     r.spik_meaning  ?? null,
        example_sentence: r.example_sentence ?? null,
        part_of_speech:   r.part_of_speech  ?? null,
        category:         r.category  ?? null,
        usage_level:      r.usage_level ?? null,
        era:              r.era  ?? null,
        tone:             r.tone ?? null,
        pronunciation:    r.pronunciation ?? null,
        wirdil_hint_1:    r.wirdil_hint_1 ?? null,
        wirdil_hint_2:    r.wirdil_hint_2 ?? null,
        wirdil_hint_3:    r.wirdil_hint_3 ?? null,
        difficulty:       deriveDifficulty(r),
      } as WirdCandidate;
    })
    .filter(w =>
      w.word.length >= MIN_LEN &&
      w.word.length <= MAX_LEN &&
      /^[a-z''-]+$/.test(w.word)
    );
}

/**
 * The word list that's valid for *guessing* — deliberately broader than the
 * target-selection pool. We accept any Shetland word in the dictionary, even
 * if it hasn't been word_status-tagged yet, has a "harsh" tone, or has no
 * meaning recorded. This avoids the frustration of typing a perfectly real
 * Spik word and being told it isn't one.
 *
 * Target selection (loadWirdPool) keeps the strict filters so the daily
 * answer is always something curated.
 *
 * Filters applied here:
 *   - length within [MIN_LEN, MAX_LEN]
 *   - characters only in [a-z'-] after lowercasing (excludes digits, spaces,
 *     multi-word entries — those can't be typed on the alphabetic keyboard)
 */
export async function loadGuessPool(): Promise<Set<string>> {
  if (guessPoolCache) return guessPoolCache;

  const { data, error } = await supabase
    .from('spik_dictionary')
    .select('word')
    .not('word', 'is', null)
    .limit(20000);
  if (error) {
    console.warn('[guess-da-wird] permissive guess pool query failed, falling back to target pool:', error.message);
    const pool = await loadWirdPool();
    guessPoolCache = new Set(pool.map(w => w.word));
    return guessPoolCache;
  }

  const set = new Set<string>();
  for (const row of data ?? []) {
    const w = (row.word ?? '').trim().toLowerCase();
    if (w.length < MIN_LEN || w.length > MAX_LEN) continue;
    if (!/^[a-z''-]+$/.test(w)) continue;
    set.add(w);
  }

  // Defensive: union with the strict target pool, so even if the permissive
  // query is somehow missing a word the curated set has, the guess still
  // validates.
  const target = await loadWirdPool();
  for (const w of target) set.add(w.word);

  guessPoolCache = set;
  return guessPoolCache;
}

// ── Daily word selection ──────────────────────────────────────────────────────

export async function getDailyWird(dateKey: string): Promise<DailyWird> {
  const pool = await loadWirdPool();
  const seed = dateToSeed(dateKey);

  // Build tiered candidate pools (each tier falls through if fewer than 30 words).
  //   Tier 0 (preferred): 4–5 letters + common/known + non-archaic + difficulty ≤ 2
  //   Tier 1:             4–6 letters + common/known + non-archaic + difficulty ≤ 2
  //   Tier 2:             4–6 letters, any usage
  //   Tier 3:             full pool (any length, any usage)
  const usagePref  = new Set(['common', 'known']);
  const eraAvoid   = new Set(['archaic']);

  const tier0 = pool.filter(w =>
    w.word.length >= 4 && w.word.length <= 5 &&
    usagePref.has(w.usage_level ?? '') &&
    !eraAvoid.has(w.era ?? '') &&
    w.difficulty <= 2
  );
  const tier1 = pool.filter(w =>
    w.word.length >= 4 && w.word.length <= 6 &&
    usagePref.has(w.usage_level ?? '') &&
    !eraAvoid.has(w.era ?? '') &&
    w.difficulty <= 2
  );
  const tier2 = pool.filter(w =>
    w.word.length >= 4 && w.word.length <= 6
  );
  const candidates =
    tier0.length >= 30 ? tier0 :
    tier1.length >= 30 ? tier1 :
    tier2.length >= 30 ? tier2 : pool;

  if (candidates.length === 0) {
    throw new Error('No Shetland words found in da dictionary. Check your Supabase connection.');
  }

  const idx    = seededIndex(seed, candidates.length);
  const picked = candidates[idx];

  const meaning = ((picked.short_meaning ?? picked.spik_meaning ?? '') as string).trim();

  return {
    id:               picked.id,
    word:             picked.word,
    meaning,
    full_meaning:     picked.spik_meaning?.trim() ?? null,
    part_of_speech:   picked.part_of_speech,
    example_sentence: picked.example_sentence,
    usage_level:      picked.usage_level,
    category:         picked.category,
    era:              picked.era,
    tone:             picked.tone,
    pronunciation:    picked.pronunciation,
    wirdil_hint_1:    picked.wirdil_hint_1,
    wirdil_hint_2:    picked.wirdil_hint_2,
    wirdil_hint_3:    picked.wirdil_hint_3,
    date_key:         dateKey,
    difficulty:       picked.difficulty,
  };
}

export function maxTries(word: string): number {
  return word.length >= 7 ? LONG_TRIES : BASE_TRIES;
}

// ── Guess checking ────────────────────────────────────────────────────────────

/**
 * Score a guess against the answer.
 * Two-pass algorithm correctly handles duplicate letters.
 */
export function checkGuess(guess: string, answer: string): LetterResult[] {
  const g = guess.toLowerCase().split('');
  const a = answer.toLowerCase().split('');
  const result: LetterResult[] = g.map(letter => ({ letter, state: 'away' as LetterState }));
  const pool: (string | null)[] = [...a];

  // Pass 1: anchored
  for (let i = 0; i < g.length; i++) {
    if (g[i] === a[i]) {
      result[i].state = 'anchored';
      pool[i]         = null;
    }
  }
  // Pass 2: drifting
  for (let i = 0; i < g.length; i++) {
    if (result[i].state === 'anchored') continue;
    const j = pool.indexOf(g[i]);
    if (j !== -1) {
      result[i].state = 'drifting';
      pool[j]         = null;
    }
  }
  return result;
}

// ── Keyboard state ────────────────────────────────────────────────────────────

const STATE_PRIORITY: Record<LetterState, number> = { anchored: 3, drifting: 2, away: 1, empty: 0 };

export function buildKeyMap(rows: GuessRow[]): Record<string, LetterState> {
  const map: Record<string, LetterState> = {};
  for (const row of rows) {
    for (const r of row.letters) {
      const cur = map[r.letter];
      if (!cur || STATE_PRIORITY[r.state] > STATE_PRIORITY[cur]) {
        map[r.letter] = r.state;
      }
    }
  }
  return map;
}

// ── Clue system ───────────────────────────────────────────────────────────────

/**
 * Build up to 5 progressive clues, using curated wirdil_hint fields first,
 * then falling back to derived clues from the richer ACF metadata.
 *
 * Clue 1 is always visible (free).
 * Clues 2–5 unlock on request.
 */
export function buildClues(wird: DailyWird): GdwClue[] {
  const clues: GdwClue[] = [];

  // ── Clue 1: Part of speech (always free) ─────────────────────────────────
  const posText = wird.part_of_speech
    ? `This wird is a ${wird.part_of_speech}.`
    : `This wird has ${wird.word.length} letter${wird.word.length !== 1 ? 's' : ''}.`;
  clues.push({ level: 1, icon: 'tag', label: 'What kind of wird is it?', content: posText });

  // ── Clue 2: Curated wirdil_hint_1 or soft meaning ───────────────────────
  const hint2 = wird.wirdil_hint_1 ?? softenMeaning(wird.meaning);
  clues.push({ level: 2, icon: 'compass', label: 'Need a peerie clue?', content: hint2 });

  // ── Clue 3: Category/theme (with wirdil_hint_2 override) ────────────────
  let hint3: string;
  if (wird.wirdil_hint_2) {
    hint3 = wird.wirdil_hint_2;
  } else if (wird.category) {
    const theme = CATEGORY_THEME[wird.category] ?? wird.category;
    hint3 = `This wird relates to ${theme}.`;
    if (wird.usage_level) {
      const ul = wird.usage_level === 'common' ? 'a common'
              : wird.usage_level === 'known'   ? 'a well-known'
              : 'a less common';
      hint3 += ` It's ${ul} Shetland word.`;
    }
  } else {
    hint3 = `The wird has ${countVowels(wird.word)} vowel${countVowels(wird.word) !== 1 ? 's' : ''} and ${wird.word.length - countVowels(wird.word)} consonant${(wird.word.length - countVowels(wird.word)) !== 1 ? 's' : ''}.`;
  }
  clues.push({ level: 3, icon: 'map-marker-alt', label: 'Give me a theme clue', content: hint3 });

  // ── Clue 4: First letter (with wirdil_hint_3 override) ───────────────────
  let hint4: string;
  if (wird.wirdil_hint_3) {
    hint4 = wird.wirdil_hint_3;
  } else {
    hint4 = `The wird starts with "${wird.word[0].toUpperCase()}".`;
    if (wird.pronunciation) {
      hint4 += ` It's pronounced: ${wird.pronunciation}.`;
    }
  }
  clues.push({ level: 4, icon: 'font', label: 'Reveal the first letter', content: hint4 });

  // ── Clue 5: Example sentence (most revealing) ────────────────────────────
  let hint5: string;
  if (wird.example_sentence) {
    hint5 = `"${wird.example_sentence}"`;
  } else {
    // Reveal two confirmed letters if no example available
    const mid = Math.floor(wird.word.length / 2);
    hint5 = `The ${mid + 1}${ordinal(mid + 1)} letter is "${wird.word[mid].toUpperCase()}".`;
  }
  clues.push({ level: 5, icon: 'book-open', label: 'Show me an example', content: hint5 });

  return clues;
}

function softenMeaning(meaning: string): string {
  const words = meaning.trim().split(/\s+/);
  if (words.length <= 3) return `It relates to: ${meaning.toLowerCase()}.`;
  const keep = Math.ceil(words.length * 0.55);
  return words.slice(0, keep).join(' ') + '…';
}

function countVowels(word: string): number {
  return (word.match(/[aeiou]/gi) ?? []).length;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * A guess is valid if it:
 *   - has the right length
 *   - exists in the Shetland word pool
 * We don't validate against English dictionaries — Shetland words only.
 */
export async function isValidGuess(guess: string, wordLen: number): Promise<boolean> {
  const g = guess.toLowerCase().trim();
  if (g.length !== wordLen) return false;
  const pool = await loadGuessPool();
  return pool.has(g);
}

// ── Sharing ───────────────────────────────────────────────────────────────────

/** Original OneShetland share format — no Wordle grid. */
export function buildShareText(
  dateKey:    string,
  guesses:    GuessRow[],
  won:        boolean,
  cluesUsed:  number,
  stats:      Pick<DailyStats, 'currentStreak'>,
): string {
  const date    = formatDateLabel(dateKey);
  const result  = won
    ? `Solved in ${guesses.length} tr${guesses.length === 1 ? 'y' : 'ies'}`
    : 'Kept its secret today';
  const streak  = stats.currentStreak > 1 ? `\n🔥 Streak: ${stats.currentStreak}` : '';
  const clueStr = cluesUsed > 0 ? `\nClues used: ${cluesUsed}` : '';

  // Compact row summary using original symbols
  const rows = guesses.map(g =>
    g.letters.map(l =>
      l.state === 'anchored' ? '⚓' :
      l.state === 'drifting' ? '〰️' : '·'
    ).join('')
  ).join('\n');

  return [
    `Guess da Wird — ${date}`,
    result,
    clueStr,
    streak,
    '',
    rows,
    '',
    'Play on OneShetland',
  ].filter(l => l !== undefined).join('\n').replace(/\n{3,}/g, '\n\n');
}

function formatDateLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d} ${months[m - 1]} ${y}`;
}

// ── Scoring ───────────────────────────────────────────────────────────────────

/**
 * 1000 base − 100 per try used − 20 per clue + 50 per unused try.
 * Bonus: +100 for difficulty 3 (hard) solved, +50 for difficulty 2.
 * Minimum 50.
 */
export function calcScore(
  triesUsed:  number,
  maxT:       number,
  cluesUsed:  number,
  won:        boolean,
  difficulty: number,
): number {
  if (!won) return 0;
  const diffBonus = difficulty === 3 ? 100 : difficulty === 2 ? 50 : 0;
  const base = 1000
    - (triesUsed - 1) * 100
    + (maxT - triesUsed) * 50
    - cluesUsed * 20
    + diffBonus;
  return Math.max(50, base);
}

// ── Local stats (AsyncStorage) ────────────────────────────────────────────────

const STATS_KEY = (uid: string) => `gdw_stats_v2_${uid}`;
const STATE_KEY = (uid: string) => `gdw_state_v2_${uid}`;

const DEFAULT_STATS: DailyStats = {
  played:        0,
  won:           0,
  currentStreak: 0,
  bestStreak:    0,
  lastDate:      null,
  distribution:  new Array(8).fill(0),
  cluesUsed:     0,
  fastestSolve:  null,
};

export async function loadStats(userId: string): Promise<DailyStats> {
  try {
    const raw = await AsyncStorage.getItem(STATS_KEY(userId));
    if (!raw) return { ...DEFAULT_STATS };
    return { ...DEFAULT_STATS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATS };
  }
}

export async function saveStats(userId: string, stats: DailyStats): Promise<void> {
  try {
    await AsyncStorage.setItem(STATS_KEY(userId), JSON.stringify(stats));
  } catch { /* non-fatal */ }
}

export async function recordResult(
  userId:     string,
  dateKey:    string,
  guessCount: number,
  won:        boolean,
  cluesUsed:  number,
  solveSeconds?: number,
): Promise<DailyStats> {
  const stats    = await loadStats(userId);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().split('T')[0];
  const isContinuation = stats.lastDate === yesterday || stats.lastDate === dateKey;
  const alreadyCountedToday = stats.lastDate === dateKey;

  let newStreak = stats.currentStreak;
  if (!alreadyCountedToday) {
    newStreak = won ? (isContinuation ? stats.currentStreak + 1 : 1) : 0;
  }

  const dist = [...stats.distribution];
  if (won && guessCount >= 1 && guessCount <= 8 && !alreadyCountedToday) {
    dist[guessCount - 1] = (dist[guessCount - 1] ?? 0) + 1;
  }

  const newFastest = (won && solveSeconds)
    ? (stats.fastestSolve === null ? solveSeconds : Math.min(stats.fastestSolve, solveSeconds))
    : stats.fastestSolve;

  const updated: DailyStats = {
    played:        alreadyCountedToday ? stats.played : stats.played + 1,
    won:           alreadyCountedToday ? stats.won : stats.won + (won ? 1 : 0),
    currentStreak: newStreak,
    bestStreak:    Math.max(stats.bestStreak, newStreak),
    lastDate:      dateKey,
    distribution:  dist,
    cluesUsed:     stats.cluesUsed + (alreadyCountedToday ? 0 : cluesUsed),
    fastestSolve:  newFastest,
  };
  await saveStats(userId, updated);
  return updated;
}

// ── Daily state persistence ───────────────────────────────────────────────────

export async function loadDailyState(userId: string): Promise<SavedDailyState | null> {
  try {
    const raw = await AsyncStorage.getItem(STATE_KEY(userId));
    if (!raw) return null;
    const s: SavedDailyState = JSON.parse(raw);
    if (s.dateKey !== todayKey()) return null;  // stale
    return s;
  } catch {
    return null;
  }
}

export async function saveDailyState(userId: string, state: SavedDailyState): Promise<void> {
  try {
    await AsyncStorage.setItem(STATE_KEY(userId), JSON.stringify(state));
  } catch { /* non-fatal */ }
}
