/**
 * spik-games-data.ts
 *
 * Loads the Spik dictionary into memory once per session and provides
 * random-pick helpers for the games (Sprint, Snap, future games).
 */

import { supabase } from './supabase';

export interface SpikGameWord {
  id:           number;
  word:         string;
  meaning:      string;          // short_meaning, with spik_meaning fallback
  pronunciation?: string | null; // e.g. "broo-nik"
}

let cache: SpikGameWord[] | null = null;

/**
 * Fetch all Spik words that have a meaning we can use in games.
 * Cached for the lifetime of the JS bundle (cleared on app restart).
 */
export async function loadSpikGameWords(): Promise<SpikGameWord[]> {
  if (cache && cache.length > 0) return cache;

  const { data, error } = await supabase
    .from('spik_dictionary')
    .select('id, word, short_meaning, spik_meaning, pronunciation')
    .or('short_meaning.not.is.null,spik_meaning.not.is.null')
    .limit(3000);

  if (error) throw error;

  const words: SpikGameWord[] = (data ?? [])
    .map((r: any) => ({
      id:            r.id,
      word:          r.word,
      meaning:       (r.short_meaning ?? r.spik_meaning ?? '').trim(),
      pronunciation: r.pronunciation ?? null,
    }))
    .filter(w => w.word && w.meaning && w.meaning.length < 80);

  cache = words;
  return words;
}

/** Fisher-Yates shuffle (mutates and returns) */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Pick N distinct random words from the pool. */
export function pickRandom(pool: SpikGameWord[], n: number): SpikGameWord[] {
  if (pool.length === 0) return [];
  const copy = pool.slice();
  shuffle(copy);
  return copy.slice(0, Math.min(n, copy.length));
}

/**
 * Build one Sprint question: one correct word + N-1 distractor words.
 * Returns the 4 (or however many) words with the index of the correct one.
 */
export function makeSprintQuestion(
  pool: SpikGameWord[],
  optionsCount = 4,
): { meaning: string; options: SpikGameWord[]; correctIndex: number } | null {
  if (pool.length < optionsCount) return null;
  const picks = pickRandom(pool, optionsCount);
  const correctIndex = Math.floor(Math.random() * optionsCount);
  return {
    meaning: picks[correctIndex].meaning,
    options: picks,
    correctIndex,
  };
}

/**
 * Build one Snap card: a Shetland word paired with a meaning that is either
 * its real meaning (`match: true`) or another random word's meaning (`match: false`).
 */
export function makeSnapCard(pool: SpikGameWord[]): { word: SpikGameWord; shownMeaning: string; match: boolean } | null {
  if (pool.length < 2) return null;
  const word = pool[Math.floor(Math.random() * pool.length)];
  const match = Math.random() < 0.5;
  if (match) {
    return { word, shownMeaning: word.meaning, match: true };
  }
  // Pick a different word's meaning
  let other = pool[Math.floor(Math.random() * pool.length)];
  let safety = 0;
  while ((other.id === word.id || other.meaning === word.meaning) && safety < 20) {
    other = pool[Math.floor(Math.random() * pool.length)];
    safety++;
  }
  return { word, shownMeaning: other.meaning, match: false };
}
