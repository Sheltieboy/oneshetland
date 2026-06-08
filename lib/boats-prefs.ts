/**
 * lib/boats-prefs.ts
 *
 * Tiny AsyncStorage-backed helpers for Da Boats — "saved boats" so a user
 * can star a vessel and come back to it, and "recently viewed" so the
 * landing page can offer "yon boat I was looking at" as a one-tap shortcut.
 *
 * We store lightweight summaries (id, LK, name, build year, hero) so the
 * landing screen can render the rows without doing a fetch — they appear
 * instantly on first paint. The full profile is loaded only when the user
 * opens a card.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export interface VesselStub {
  id:                string;
  lk_number:         string | null;
  canonical_name:    string;
  built_year:        number | null;
  hero_url:          string | null;
  /** ISO timestamp of when this stub was last touched. */
  last_seen?:        string;
}

const SAVED_KEY  = 'daBoats.saved.v1';
const RECENT_KEY = 'daBoats.recent.v1';
const MAX_RECENT = 8;

async function readList(key: string): Promise<VesselStub[]> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function writeList(key: string, list: VesselStub[]): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(list));
  } catch { /* non-fatal */ }
}

// ── Saved boats ────────────────────────────────────────────────────────────

export async function loadSavedBoats(): Promise<VesselStub[]> {
  return readList(SAVED_KEY);
}

export async function isBoatSaved(id: string): Promise<boolean> {
  const list = await loadSavedBoats();
  return list.some(b => b.id === id);
}

/** Toggle saved. Returns the new saved-state for the caller's UI. */
export async function toggleSavedBoat(stub: VesselStub): Promise<boolean> {
  const list = await loadSavedBoats();
  const had  = list.some(b => b.id === stub.id);
  const next = had
    ? list.filter(b => b.id !== stub.id)
    : [{ ...stub, last_seen: new Date().toISOString() }, ...list];
  await writeList(SAVED_KEY, next);
  return !had;
}

// ── Recently viewed ────────────────────────────────────────────────────────

export async function loadRecentBoats(): Promise<VesselStub[]> {
  return readList(RECENT_KEY);
}

export async function pushRecentBoat(stub: VesselStub): Promise<VesselStub[]> {
  const current  = await loadRecentBoats();
  const filtered = current.filter(b => b.id !== stub.id);
  const next     = [{ ...stub, last_seen: new Date().toISOString() }, ...filtered].slice(0, MAX_RECENT);
  await writeList(RECENT_KEY, next);
  return next;
}

export async function clearRecentBoats(): Promise<void> {
  try { await AsyncStorage.removeItem(RECENT_KEY); } catch { /* ignore */ }
}
