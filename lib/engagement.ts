/**
 * lib/engagement.ts
 *
 * Tracks lightweight "what has this user been doing" signals so the
 * Home concierge can surface a personalised For-you row. Pure
 * AsyncStorage — no DB hits — so it works offline and stays cheap.
 *
 * What we track per section:
 *   * touches  — count of meaningful interactions (tab open + key actions)
 *   * lastAt   — ISO timestamp of the most recent touch
 *   * lastNote — optional one-line subtitle the screen wants to surface
 *                next time the For-you tile renders
 *                ("you commented on Brilliant", "3 cards in Scalloway")
 *
 * Use bumpSectionEngagement() from:
 *   * tab focus handlers (small +1, no note)
 *   * key actions (save, comment, post) — bigger weight + a fresh note
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export type EngagementKey =
  | 'memories'
  | 'daBoats'
  | 'spik'
  | 'fetch'
  | 'local'
  | 'shifts'
  | 'games'
  | 'events'
  | 'notices'
  | 'jobs';

export interface EngagementEntry {
  touches:   number;
  lastAt:    string;       // ISO
  lastNote?: string | null;
}

const KEY = 'engagement.v1';

type EngagementMap = Partial<Record<EngagementKey, EngagementEntry>>;

async function read(): Promise<EngagementMap> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as EngagementMap) : {};
  } catch { return {}; }
}

async function write(map: EngagementMap): Promise<void> {
  try { await AsyncStorage.setItem(KEY, JSON.stringify(map)); }
  catch { /* non-fatal */ }
}

/**
 * Increment the touch count on a section, refresh lastAt, and
 * optionally set lastNote. Call this from tab-focus handlers (no note)
 * and from key actions (with a note describing the action).
 *
 * Examples:
 *   bumpSectionEngagement('memories')                                  // tab focus
 *   bumpSectionEngagement('daBoats', 'You commented on BRILLIANT')      // action
 *   bumpSectionEngagement('local',   '3 cards in Scalloway')            // action
 */
export async function bumpSectionEngagement(
  key: EngagementKey,
  note?: string,
): Promise<void> {
  const map = await read();
  const prev = map[key];
  map[key] = {
    touches:   (prev?.touches ?? 0) + 1,
    lastAt:    new Date().toISOString(),
    lastNote:  note ?? prev?.lastNote ?? null,
  };
  await write(map);
}

export async function getSectionEngagement(key: EngagementKey): Promise<EngagementEntry | null> {
  const map = await read();
  return map[key] ?? null;
}

export async function getAllEngagement(): Promise<EngagementMap> {
  return read();
}

export async function clearEngagement(): Promise<void> {
  try { await AsyncStorage.removeItem(KEY); } catch { /* ignore */ }
}

/**
 * Returns the engagement entries sorted by most-recently-touched
 * first, capped at `limit` (default 5). Used by the For-you row.
 */
export async function getRecentEngagement(limit = 5): Promise<Array<{ key: EngagementKey; entry: EngagementEntry }>> {
  const map = await read();
  const rows: Array<{ key: EngagementKey; entry: EngagementEntry }> = [];
  (Object.entries(map) as [EngagementKey, EngagementEntry][])
    .forEach(([k, v]) => rows.push({ key: k, entry: v }));
  rows.sort((a, b) =>
    new Date(b.entry.lastAt).getTime() - new Date(a.entry.lastAt).getTime(),
  );
  return rows.slice(0, limit);
}
