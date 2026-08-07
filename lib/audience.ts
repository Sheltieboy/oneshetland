/**
 * Audience — "I live here" vs "I'm visiting".
 *
 * A RANKING HINT, and deliberately nothing more. It reorders the For-you feed
 * and the Explore groups on Home so a visitor isn't given half a screen of
 * Fetch, Shifts and payroll they can't use. It never hides a section, never
 * gates anything, and nothing reads it for permissions — a Shetlander hosting
 * family and a returning visitor with roots are both real people, so nothing
 * may become unreachable because of this setting.
 *
 * Stored on the profile so it follows the one-login promise across app and
 * web, with an AsyncStorage cache so Home can rank correctly on first paint
 * instead of flickering from one order to the other.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

export type Audience = 'resident' | 'visiting';

const CACHE_KEY = 'audience_v1';

export const AUDIENCE_LABEL: Record<Audience, string> = {
  resident: 'I live here',
  visiting: 'I’m visiting',
};

/** Last known choice, for ranking before the profile has loaded. */
export async function cachedAudience(): Promise<Audience | null> {
  try {
    const v = await AsyncStorage.getItem(CACHE_KEY);
    return v === 'visiting' || v === 'resident' ? v : null;
  } catch { return null; }
}

export async function cacheAudience(a: Audience): Promise<void> {
  try { await AsyncStorage.setItem(CACHE_KEY, a); } catch { /* cache only */ }
}

/**
 * Persist the choice. Writes the cache first so the UI can switch instantly
 * even on a bad connection — this is a display preference, so a failed sync
 * is not worth blocking or apologising for. If the column isn't there yet
 * (migration not run), the cache still carries it on this device.
 */
export async function saveAudience(userId: string | null | undefined, a: Audience): Promise<void> {
  await cacheAudience(a);
  if (!userId) return;
  try {
    await supabase.from('profiles').update({ audience: a }).eq('id', userId);
  } catch { /* the cache is enough to keep this device correct */ }
}
