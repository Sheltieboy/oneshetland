/**
 * notice-prefs.ts — "Notices & alerts" notification choices: the member's areas and four independent opt-ins.
 *
 * Contract: areas NEVER imply consent; every audience starts OFF. set_my_notice_prefs takes null for "unchanged", so a toggle sends only the
 * field that changed. community_categories null = every community category; the explicit p_all_community_categories flag clears a list.
 * No areas = Shetland-wide notices only. Push also depends on the master switch, the `notices` module toggle and quiet hours (the sender
 * applies them); notices stay readable in the app with push off.
 */
import { supabase } from './supabase';

export type NoticePrefs = {
  essential_alerts: boolean; official_notices: boolean; community_notices: boolean;
  /** null = all community categories. */
  community_categories: string[] | null; funeral_notices: boolean;
};

export const NOTICE_PREF_DEFAULTS: NoticePrefs = {
  essential_alerts: false, official_notices: false, community_notices: false, community_categories: null, funeral_notices: false,
};

export const MAX_NOTICE_AREAS = 12;

/** Anything the server returns that is not a clear `true` is OFF. */
export function parseNoticePrefs(raw: unknown): NoticePrefs {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    essential_alerts: r.essential_alerts === true,
    official_notices: r.official_notices === true,
    community_notices: r.community_notices === true,
    community_categories: Array.isArray(r.community_categories) ? r.community_categories.filter((c): c is string => typeof c === 'string') : null,
    funeral_notices: r.funeral_notices === true,
  };
}

export type NoticePrefChange = Partial<{
  essential_alerts: boolean; official_notices: boolean; community_notices: boolean; funeral_notices: boolean;
  /** string[] = only these; null = all community categories. */
  community_categories: string[] | null;
}>;

/** Partial update: only the keys present in `change` are sent; everything else is null (unchanged on the server). */
export function buildPrefsArgs(change: NoticePrefChange): Record<string, unknown> {
  const has = (k: keyof NoticePrefChange) => Object.prototype.hasOwnProperty.call(change, k) && change[k] !== undefined;
  const cats = has('community_categories') ? change.community_categories : undefined;
  return {
    p_essential: has('essential_alerts') ? change.essential_alerts : null,
    p_official: has('official_notices') ? change.official_notices : null,
    p_community: has('community_notices') ? change.community_notices : null,
    p_categories: Array.isArray(cats) ? cats : null,
    p_funeral: has('funeral_notices') ? change.funeral_notices : null,
    p_all_community_categories: cats === null,
  };
}

/** Applies a change locally for the optimistic update (same rules as the server). */
export function applyPrefChange(current: NoticePrefs, change: NoticePrefChange): NoticePrefs {
  return { ...current, ...Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)) } as NoticePrefs;
}

/** Toggle one category in a community selection. From "all" (null) the first tap starts a list of just that one; emptying the list returns to "all kinds" (null). */
export function toggleCategory(current: string[] | null, id: string): string[] | null {
  const list = current ?? [];
  const next = list.includes(id) ? list.filter((c) => c !== id) : [...list, id];
  return next.length === 0 ? null : next;
}

/** Areas to save: physical areas only (never the Shetland-wide root), unique, at most 12. */
export function normaliseAreas(ids: string[]): { areas: string[]; error: string | null } {
  const areas = [...new Set(ids.filter((a) => typeof a === 'string' && a && a !== 'shetland_wide'))];
  if (areas.length > MAX_NOTICE_AREAS) return { areas: areas.slice(0, MAX_NOTICE_AREAS), error: `Choose at most ${MAX_NOTICE_AREAS} areas.` };
  return { areas, error: null };
}

export function friendlyPrefError(e: unknown): string {
  const m = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : '';
  return m && !/^(PGRST|fetch|network)/i.test(m) && m.length < 160 ? m : 'That change did not save. Please try again.';
}

export async function fetchMyNoticeAreas(): Promise<string[]> {
  const { data, error } = await supabase.rpc('my_notice_areas');
  if (error) throw error;
  return Array.isArray(data) ? data.filter((a: unknown): a is string => typeof a === 'string') : [];
}

export async function saveMyNoticeAreas(ids: string[]): Promise<string[]> {
  const { areas, error: tooMany } = normaliseAreas(ids);
  if (tooMany) throw new Error(tooMany);
  const { data, error } = await supabase.rpc('set_my_notice_areas', { p_areas: areas });
  if (error) throw error;
  return Array.isArray(data) ? data : areas;
}

export async function fetchNoticePrefs(): Promise<NoticePrefs> {
  const { data, error } = await supabase.rpc('my_notice_prefs');
  if (error) throw error;
  return parseNoticePrefs(data);
}

export async function saveNoticePrefs(change: NoticePrefChange): Promise<NoticePrefs> {
  const { data, error } = await supabase.rpc('set_my_notice_prefs', buildPrefsArgs(change));
  if (error) throw error;
  return parseNoticePrefs(data);
}
