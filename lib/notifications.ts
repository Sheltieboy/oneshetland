/**
 * notifications.ts
 *
 * Push notification permission, token registration, and iOS category
 * registration (the bit that surfaces action buttons on Apple Watch).
 *
 * Call registerPushToken(userId) once after a user signs in.
 * The token is saved to profiles.push_token so edge functions can send to it.
 */
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { supabase } from './supabase';

// ── Notification categories ──────────────────────────────────────────────────
// Each category gets a unique id and a set of actions. The id is what edge
// functions pass as `categoryId` when sending — iOS uses it to render the
// matching action buttons (also visible on Apple Watch when the notification
// is mirrored from the phone).
//
// Convention: "module.event" — e.g. "bookings.new", "shifts.new_match".
//
// Adding a new category: define it here, redeploy, then start sending pushes
// with that categoryId from your edge function.

export const NOTIFICATION_CATEGORIES = {
  // ── Bookings ──────────────────────────────────────────────────────────────
  'bookings.new': [
    {
      identifier: 'ACKNOWLEDGE',
      buttonTitle: 'Acknowledge',
      options:    { opensAppToForeground: false },
    },
    {
      identifier: 'CALL_CUSTOMER',
      buttonTitle: 'Call customer',
      options:    { opensAppToForeground: true },
    },
  ],

  'bookings.reminder': [
    {
      identifier: 'DIRECTIONS',
      buttonTitle: 'Directions',
      options:    { opensAppToForeground: true },
    },
    {
      identifier: 'CALL_BUSINESS',
      buttonTitle: 'Call',
      options:    { opensAppToForeground: true },
    },
  ],

  'bookings.cancelled': [
    {
      identifier: 'VIEW',
      buttonTitle: 'View',
      options:    { opensAppToForeground: true },
    },
  ],

  // ── More categories land here in later phases ─────────────────────────────
  // 'shifts.new_match':       [Apply / Save / Dismiss]
  // 'shifts.application_update': [View]
  // 'fetch.new_request':      [Accept / Skip]
  // 'spik.daily_wird':        [Hear / Save]
} as const;

export type NotificationCategoryId = keyof typeof NOTIFICATION_CATEGORIES;

// ── Notification → route mapping ─────────────────────────────────────────────
// Turns a notification's `data` payload into an in-app route so tapping a push
// opens the relevant screen instead of dumping the user on Home. Senders attach
// either a `screen` alias or an id (request_id / shift_id / job_id / hub_id /
// order_id). Returns null when there's nothing meaningful to open.

const SCREEN_ALIASES: Record<string, string> = {
  fetch:                  '/(tabs)/fetch',
  shifts:                 '/(tabs)/jobs?tab=shifts',
  jobs:                   '/(tabs)/jobs',
  spik:                   '/(tabs)/spik',
  games:                  '/games',
  'my-shift-applications':'/my-shift-applications',
  'my-job-applications':  '/my-job-applications',
  'employer-applications':'/employer-applications',
  'local-my-cards':       '/local-my-cards',
  'local-offers':         '/local-offers',
  'local-wallet':         '/local-wallet',
  'local-my-passes':      '/local-my-passes',
  'local-my-gifts':       '/local-my-gifts',
  'local-my-bookings':    '/local-my-bookings',
  'my-event-tickets':     '/my-event-tickets',
  'my-orders':            '/my-orders',
  notices:                '/notices',
};

export function notificationRoute(
  data: Record<string, unknown> | null | undefined,
): string | null {
  if (!data) return null;

  const screen = typeof data.screen === 'string' ? data.screen : null;

  // Employer applicants pipeline needs the jobId query param.
  if (screen === 'job-applicants' && typeof data.job_id === 'string') {
    return `/job-applicants?jobId=${data.job_id}`;
  }

  // Shop orders: the merchant inbox needs its businessId param. (Must resolve
  // BEFORE the generic order_id fallback below, which is event tickets'.)
  if (screen === 'business-orders' && typeof data.business_id === 'string') {
    return `/business-orders?businessId=${data.business_id}`;
  }

  // Ships-in-today opens that day's cruise page, which keys on ?date=.
  if (screen === 'cruise-day' && typeof data.visit_date === 'string') {
    return `/cruise-day?date=${data.visit_date}`;
  }
  if (typeof data.product_order_id === 'string') return '/my-orders';

  if (screen && SCREEN_ALIASES[screen]) return SCREEN_ALIASES[screen];

  // Id-based fallbacks (most specific first).
  if (typeof data.shift_id === 'string')  return `/shift-detail?id=${data.shift_id}`;
  if (typeof data.job_id === 'string')    return `/job/${data.job_id}`;
  if (typeof data.hub_id === 'string')    return `/hubs/${data.hub_id}`;
  if (typeof data.order_id === 'string')  return '/my-event-tickets';
  if (typeof data.event_id === 'string')  return `/events/${data.event_id}`;
  if (typeof data.request_id === 'string')return '/(tabs)/fetch';
  if (typeof data.memory_id === 'string') return `/memory/${data.memory_id}`;
  if (typeof data.vessel_id === 'string') return `/boat/${data.vessel_id}`;
  if (typeof data.business_id === 'string') return `/local-business-detail?id=${data.business_id}`;

  return null;
}

/**
 * Set up the foreground display handler + Android channel + iOS categories.
 * Idempotent — safe to call on every app start.
 */
async function configureNotifications(): Promise<void> {
  // How foreground notifications appear
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,    // legacy (SDK ≤54)
      shouldShowBanner: true,   // SDK 55+
      shouldShowList: true,     // SDK 55+
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });

  // Android: notification channel
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'OneShetland',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
    });
  }

  // iOS: register action-button categories. Apple Watch picks these up
  // automatically when the notification is mirrored from the phone.
  // We register them on Android too — it's a no-op there but keeps the code
  // path uniform.
  for (const [id, actions] of Object.entries(NOTIFICATION_CATEGORIES)) {
    try {
      await Notifications.setNotificationCategoryAsync(id, actions as any);
    } catch (e) {
      console.warn(`[notifications] failed to register category ${id}:`, e);
    }
  }
}

// The Expo token for THIS device, captured on registration so sign-out can
// remove exactly this device's row from push_tokens (and not the user's other
// devices).
let lastRegisteredToken: string | null = null;

export async function registerPushToken(userId: string): Promise<void> {
  // Push tokens only work on physical devices
  if (!Device.isDevice) return;

  await configureNotifications();

  // Request permission
  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;
  if (existing !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== 'granted') return;

  // Get the Expo push token
  // projectId comes from EAS config after `eas init`, falls back to slug for Expo Go
  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId;

  const tokenData = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined,
  );

  const token = tokenData.data;
  if (!token) return;
  lastRegisteredToken = token;

  // Multi-device: one row per device in push_tokens (the send helper fans out
  // to every row). Upsert on the token so re-registering the same device just
  // refreshes its owner + last_seen (and reassigns it if a new user signs in
  // on this device).
  await supabase
    .from('push_tokens')
    .upsert(
      {
        user_id:      userId,
        token,
        platform:     Platform.OS,
        device_name:  Device.deviceName ?? null,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'token' },
    );

  // Keep the legacy single-column in sync for any sender not yet on push_tokens.
  await supabase
    .from('profiles')
    .update({ push_token: token })
    .eq('id', userId);

  // Seed a default notification_preferences row if one doesn't exist yet.
  // Idempotent: ON CONFLICT DO NOTHING via upsert with ignoreDuplicates.
  await supabase
    .from('notification_preferences')
    .upsert({ user_id: userId }, { onConflict: 'user_id', ignoreDuplicates: true });
}

/**
 * Clear this user's push token on sign-out.
 *
 * Without this, a shared device keeps the previous user's token on their
 * profile row, so pushes addressed to them land on whoever holds the device
 * next. Call this BEFORE supabase.auth.signOut() (we still have the session).
 *
 * Best-effort and non-fatal: a failure here must never block sign-out.
 */
export async function clearPushToken(userId: string): Promise<void> {
  try {
    // Remove only THIS device's row, so the user's other devices keep working.
    if (lastRegisteredToken) {
      await supabase.from('push_tokens').delete().eq('token', lastRegisteredToken);
    } else {
      // Fallback (token not captured this session): drop this user's rows.
      await supabase.from('push_tokens').delete().eq('user_id', userId);
    }
    // Clear the legacy column too.
    await supabase
      .from('profiles')
      .update({ push_token: null })
      .eq('id', userId);
    lastRegisteredToken = null;
  } catch (e) {
    console.warn('[notifications] clearPushToken failed:', e);
  }
}
