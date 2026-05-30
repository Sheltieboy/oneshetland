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

  // Save to the user's profile row — edge functions read it from there
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
