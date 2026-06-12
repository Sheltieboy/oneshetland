/**
 * lib/search.ts
 *
 * App search — Phase 1 covers the business directory, but the result model and
 * ranking are deliberately generic so future sources (events, services, spik,
 * boats…) can be added behind the same interface without touching the UI.
 *
 * To add a new source later:
 *   1. write `searchEvents(q): SearchResult[]` (map your rows → SearchResult)
 *   2. add it to SEARCH_SOURCES (or call it from the search screen)
 * The search screen already groups results by `type`, so new types just appear.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Href } from 'expo-router';
import { CATEGORY_LABELS, CATEGORY_ICONS, type LocalBusiness } from './local-api';

export type SearchResultType = 'business' | 'service' | 'event' | 'spik' | 'boat' | 'shift';

export interface SearchResult {
  id:       string;
  type:     SearchResultType;
  title:    string;
  subtitle: string;
  icon:     string;     // FontAwesome5 name
  color:    string;     // accent for the row icon
  route:    Href;
  /** Internal ranking score — higher is better. Not displayed. */
  score:    number;
}

/** Human label for a result group heading. */
export const RESULT_GROUP_LABEL: Record<SearchResultType, string> = {
  business: 'Businesses',
  service:  'Services',
  event:    'Events',
  spik:     'Spik',
  boat:     'Da Boats',
  shift:    'Shifts',
};

function norm(s: string): string {
  return s.toLowerCase().trim();
}

/**
 * Score a single business against a query. Returns 0 when it doesn't match.
 * Ranking: tag exact > tag prefix > name prefix > name contains >
 * tag contains > description/category contains. Verified/bookable get a nudge.
 */
function scoreBusiness(b: LocalBusiness, q: string): number {
  const query = norm(q);
  if (!query) return 0;

  const name = norm(b.name);
  const desc = norm(b.description ?? '');
  const catLabel = norm(CATEGORY_LABELS[b.category] ?? '');
  const tags = (b.tags ?? []).map(norm);

  let score = 0;

  if (tags.some(t => t === query))                 score = Math.max(score, 100);
  if (tags.some(t => t.startsWith(query)))          score = Math.max(score, 90);
  if (name === query)                               score = Math.max(score, 85);
  if (name.startsWith(query))                       score = Math.max(score, 75);
  if (tags.some(t => t.includes(query)))            score = Math.max(score, 65);
  if (name.includes(query))                         score = Math.max(score, 55);
  if (catLabel.includes(query))                     score = Math.max(score, 35);
  if (desc.includes(query))                         score = Math.max(score, 25);

  if (score === 0) return 0;
  if (b.is_verified) score += 4;
  return score;
}

/** Map a business to a SearchResult (score 0 — used for browse/featured/recent). */
export function businessResult(b: LocalBusiness): SearchResult {
  return businessToResult(b, 0);
}

function businessToResult(b: LocalBusiness, score: number): SearchResult {
  const trade = (b.tags && b.tags.length > 0)
    ? b.tags.slice(0, 2).join(' · ')
    : CATEGORY_LABELS[b.category];
  return {
    id:       b.id,
    type:     'business',
    title:    b.name,
    subtitle: trade,
    icon:     CATEGORY_ICONS[b.category] ?? 'store',
    color:    b.brand_color || '#7C3AED',
    route:    { pathname: '/local-business-detail', params: { id: b.id } },
    score,
  };
}

/**
 * Rank a preloaded list of businesses against a query, returning the matches as
 * SearchResults sorted best-first. Client-side ranking is ideal at directory
 * scale (hundreds of rows) — instant, no network per keystroke.
 */
export function searchBusinesses(businesses: LocalBusiness[], query: string): SearchResult[] {
  const q = norm(query);
  if (!q) return [];
  return businesses
    .map(b => ({ b, score: scoreBusiness(b, q) }))
    .filter(x => x.score > 0)
    .sort((a, z) => z.score - a.score || a.b.name.localeCompare(z.b.name))
    .map(x => businessToResult(x.b, x.score));
}

// ── Recently viewed ──────────────────────────────────────────────────────────

const RECENT_VIEWED_KEY = 'search_recent_viewed_v1';

/** Persist a viewed result to the "recently viewed" list (most-recent first, max 8). */
export async function addRecentlyViewed(r: SearchResult): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(RECENT_VIEWED_KEY);
    const list: SearchResult[] = raw ? JSON.parse(raw) : [];
    const next = [{ ...r, score: 0 }, ...list.filter(x => x.id !== r.id)].slice(0, 8);
    await AsyncStorage.setItem(RECENT_VIEWED_KEY, JSON.stringify(next));
  } catch {}
}

export async function getRecentlyViewed(): Promise<SearchResult[]> {
  try {
    const raw = await AsyncStorage.getItem(RECENT_VIEWED_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Group results by type, preserving best-first order within each group. */
export function groupResults(results: SearchResult[]): { type: SearchResultType; items: SearchResult[] }[] {
  const order: SearchResultType[] = ['business', 'service', 'event', 'spik', 'boat', 'shift'];
  const map = new Map<SearchResultType, SearchResult[]>();
  for (const r of results) {
    if (!map.has(r.type)) map.set(r.type, []);
    map.get(r.type)!.push(r);
  }
  return order
    .filter(t => map.has(t))
    .map(t => ({ type: t, items: map.get(t)! }));
}
