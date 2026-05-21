/**
 * DIAGNOSTIC BUILD — stripped to bare minimum to isolate iOS 26 crash.
 * No AuthProvider, no StripeProvider, no Supabase, no Notifications.
 * If this launches, the crash is in one of those layers.
 * Restore from _layout.tsx.bak once confirmed.
 */
import { Stack } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false }} />
    </SafeAreaProvider>
  );
}
