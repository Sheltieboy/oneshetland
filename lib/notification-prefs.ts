/**
 * notification-prefs.ts
 * Read + write helpers for notification_preferences.
 *
 * Defaults: opted-in to everything, no quiet hours. New users get a row
 * seeded by registerPushToken() the first time they grant permission.
 */
import { supabase } from './supabase';

export type NotificationModule =
  | 'bookings' | 'shifts' | 'fetch' | 'loyalty' | 'offers' | 'spik' | 'games'
  | 'jobs' | 'events' | 'cruise' | 'wallet' | 'hubs' | 'community'
  | 'notices' | 'business';

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
  jobs_enabled:      boolean;
  events_enabled:    boolean;
  cruise_enabled:    boolean;
  wallet_enabled:    boolean;
  hubs_enabled:      boolean;
  community_enabled: boolean;
  notices_enabled:   boolean;
  business_enabled:  boolean;
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
  jobs_enabled:      true,
  events_enabled:    true,
  cruise_enabled:    false,   // niche interest — opt-in (mirrors DB default)
  wallet_enabled:    true,
  hubs_enabled:      true,
  community_enabled: true,
  notices_enabled:   true,
  business_enabled:  true,
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

export type PrefGroupKey = 'work' | 'local' | 'money' | 'community' | 'play' | 'business';

export type ModulePrefKey = keyof Pick<NotificationPreferences,
  'bookings_enabled' | 'shifts_enabled' | 'fetch_enabled' | 'loyalty_enabled' |
  'offers_enabled'   | 'spik_enabled'   | 'games_enabled' | 'jobs_enabled' |
  'events_enabled'   | 'cruise_enabled' | 'wallet_enabled' | 'hubs_enabled' |
  'community_enabled' | 'notices_enabled' | 'business_enabled'>;

export interface ModuleInfo {
  module:      NotificationModule;
  prefKey:     ModulePrefKey;
  group:       PrefGroupKey;
  label:       string;
  description: string;
  icon:        string;
  color:       string;
}

/** The broad parent categories shown in the settings screen (each expands to
 *  its modules). Order here is the display order. */
export const NOTIFICATION_GROUPS: { key: PrefGroupKey; label: string; icon: string }[] = [
  { key: 'work',      label: 'Getting things done', icon: 'briefcase' },
  { key: 'local',     label: 'Local life',          icon: 'store' },
  { key: 'money',     label: 'Money & payments',    icon: 'wallet' },
  { key: 'community', label: 'Community',            icon: 'users' },
  { key: 'play',      label: 'Games & language',    icon: 'gamepad' },
  { key: 'business',  label: 'For businesses',       icon: 'shop' },
];

export const NOTIFICATION_MODULES: ModuleInfo[] = [
  // Getting things done
  { module: 'fetch',     prefKey: 'fetch_enabled',     group: 'work',      label: 'Fetch deliveries', description: 'Your delivery progress and driver updates',        icon: 'truck',          color: '#E0722A' },
  { module: 'shifts',    prefKey: 'shifts_enabled',    group: 'work',      label: 'Shifts',           description: 'Matching shifts, applications, check-ins',          icon: 'briefcase',      color: '#E8A020' },
  { module: 'jobs',      prefKey: 'jobs_enabled',      group: 'work',      label: 'Jobs',             description: 'Applications and updates on jobs you applied for',  icon: 'user-tie',       color: '#2A8B5C' },
  // Local life
  { module: 'bookings',  prefKey: 'bookings_enabled',  group: 'local',     label: 'Bookings',         description: 'Confirmations, reminders and changes',              icon: 'calendar-check', color: '#7C3AED' },
  { module: 'loyalty',   prefKey: 'loyalty_enabled',   group: 'local',     label: 'Loyalty & rewards',description: 'Stamps collected and rewards ready',                icon: 'stamp',          color: '#7C3AED' },
  { module: 'offers',    prefKey: 'offers_enabled',    group: 'local',     label: 'Offers & deals',   description: 'New time-limited deals near you',                   icon: 'tags',           color: '#7C3AED' },
  { module: 'events',    prefKey: 'events_enabled',    group: 'local',     label: "What's On",        description: 'Tickets, reminders, cancellations',                 icon: 'ticket-alt',     color: '#D4921A' },
  { module: 'cruise',    prefKey: 'cruise_enabled',    group: 'local',     label: 'Cruise ships',     description: 'Ships arriving in Shetland (off by default)',       icon: 'ship',           color: '#0E7490' },
  // Money & payments
  { module: 'wallet',    prefKey: 'wallet_enabled',    group: 'money',     label: 'Wallet & payments',description: 'Top-ups, payments, cashback and gifts',             icon: 'wallet',         color: '#032F4C' },
  // Community
  { module: 'hubs',      prefKey: 'hubs_enabled',      group: 'community', label: 'Hubs',             description: 'Announcements from hubs you belong to',             icon: 'users',          color: '#032F4C' },
  { module: 'community', prefKey: 'community_enabled', group: 'community', label: 'Community & stories',description: 'Replies and reactions on your stories and boats', icon: 'comments',       color: '#12B3D6' },
  { module: 'notices',   prefKey: 'notices_enabled',   group: 'community', label: 'Notices & safety', description: 'Community notices, including urgent alerts',         icon: 'bullhorn',       color: '#B91C1C' },
  // Games & language
  { module: 'spik',      prefKey: 'spik_enabled',      group: 'play',      label: 'Spik',             description: "Wird o' da day and streak reminders",               icon: 'book',           color: '#12B3D6' },
  { module: 'games',     prefKey: 'games_enabled',     group: 'play',      label: 'Games',            description: 'Daily games and leaderboard nudges',                icon: 'gamepad',        color: '#10B981' },
  // For businesses
  { module: 'business',  prefKey: 'business_enabled',  group: 'business',  label: 'My business',      description: 'New bookings, sales, payments and approvals',       icon: 'store',          color: '#032F4C' },
];

/** Modules belonging to a parent group (display order preserved). */
export function modulesInGroup(group: PrefGroupKey): ModuleInfo[] {
  return NOTIFICATION_MODULES.filter(m => m.group === group);
}
