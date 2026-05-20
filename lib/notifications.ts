/**
 * notifications.ts
 *
 * Handles push notification permission requests and push token registration.
 * Call registerPushToken(userId) once after a user signs in.
 * The token is saved to profiles.push_token so edge functions can send to it.
 */
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { supabase } from './supabase';

// How foreground notifications appear while the app is open
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export async function registerPushToken(userId: string): Promise<void> {
  // Push tokens only work on physical devices
  if (!Device.isDevice) return;

  // Android needs a notification channel
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'OneShetland Fetch',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
    });
  }

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
}
