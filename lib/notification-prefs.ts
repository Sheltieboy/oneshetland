/**
 * notification-prefs.ts
 * Read + write helpers for notification_preferences.
 *
 * Defaults: opted-in to everything, no quiet hours. New users get a row
 * seeded by registerPushToken() the first time they grant permission.
 */
import { supabase } from './supabase';

export type NotificationModule =
  | 'bookings' | 'shifts' | 'fetch' | 'loyalty' | 'offers' | 'spik' | 'games';

export interface NotificationPreferences {
  user_id:           string;
  enabled:           boolean;
  bookings_enabled:  boolean;
  shifts_enabled:    boolean;
  fetch_enabled:     boolean;
  loyalty_enabled:   boolean;
  offers_enabled:    boolean;
  spik_enabled:      boolean;
  games_enabled:     boolean;
  quiet_hours_start: string | null;  // 'HH:MM' or 'HH:MM:SS'
  quiet_hours_end:   string | null;
  updated_at:        string;
}

const DEFAULTS: Omit<NotificationPreferences, 'user_id' | 'updated_at'> = {
  enabled:           true,
  bookings_enabled:  true,
  shifts_enabled:    true,
  fetch_enabled:     true,
  loyalty_enabled:   true,
  offers_enabled:    true,
  spik_enabled:      true,
  games_enabled:     true,
  quiet_hours_start: null,
  quiet_hours_end:   null,
};

export async function fetchPreferences(userId: string): Promise<NotificationPreferences> {
  const { data } = await supabase
    .from('notification_preferences')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  // If no row yet, return the defaults shape (UI can save → upsert to create it)
  if (!data) {
    return {
      user_id:    userId,
      updated_at: new Date().toISOString(),
      ...DEFAULTS,
    };
  }
  return data as NotificationPreferences;
}

export async function updatePreferences(
  userId: string,
  patch: Partial<Omit<NotificationPreferences, 'user_id' | 'updated_at'>>,
): Promise<void> {
  const { error } = await supabase
    .from('notification_preferences')
    .upsert(
      { user_id: userId, ...patch, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    );
  if (error) throw error;
}

// ── Module metadata for the preferences UI ──────────────────────────────────

export interface ModuleInfo {
  module:      NotificationModule;
  prefKey:     keyof Pick<NotificationPreferences,
    'bookings_enabled' | 'shifts_enabled' | 'fetch_enabled' |
    'loyalty_enabled'  | 'offers_enabled' | 'spik_enabled'  | 'games_enabled'>;
  label:       string;
  description: string;
  icon:        string;
  color:       string;
}

export const NOTIFICATION_MODULES: ModuleInfo[] = [
  { module: 'bookings', prefKey: 'bookings_enabled', label: 'Bookings',  description: 'New bookings, reminders, cancellations',           icon: 'calendar-check', color: '#7C3AED' },
  { module: 'shifts',   prefKey: 'shifts_enabled',   label: 'Shifts',    description: 'Matching shifts, application updates, check-ins', icon: 'briefcase',      color: '#E8A020' },
  { module: 'fetch',    prefKey: 'fetch_enabled',    label: 'Fetch',     description: 'Delivery requests, pickup and drop updates',      icon: 'truck',          color: '#E0722A' },
  { module: 'loyalty',  prefKey: 'loyalty_enabled',  label: 'Loyalty',   description: 'Stamp collected, reward unlocked',                icon: 'stamp',          color: '#7C3AED' },
  { module: 'offers',   prefKey: 'offers_enabled',   label: 'Offers',    description: 'New time-limited deals near you',                 icon: 'tags',           color: '#7C3AED' },
  { module: 'spik',     prefKey: 'spik_enabled',     label: 'Spik',      description: 'Daily wird o\' da day, streak reminders',         icon: 'book',           color: '#12B3D6' },
  { module: 'games',    prefKey: 'games_enabled',    label: 'Games',     description: 'Leaderboard nudges',                              icon: 'gamepad',        color: '#10B981' },
];
