/**
 * app/driver/connect-return.tsx
 *
 * Deep-link landing pad for Stripe Connect onboarding.
 *
 * The Connect onboarding flow is opened with WebBrowser.openAuthSessionAsync,
 * which is *supposed* to dismiss the browser when Stripe redirects to
 * oneshetland-fetch://driver/connect-return and never let it reach the router.
 * In practice that intercept can fail (browser dismissed manually, redirect
 * opened externally, SDK quirks) — when it does, this screen catches the
 * deep link, re-pulls the profile so the webhook-written Connect status is
 * visible, and bounces the driver into their dashboard.
 *
 * Lives at the literal /driver/ URL path (NOT inside the (driver) route group)
 * because route groups are stripped from URLs.
 */

import { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/context/AuthContext';

export default function ConnectReturn() {
  const router = useRouter();
  const { refreshProfile } = useAuth();

  useEffect(() => {
    (async () => {
      try {
        await refreshProfile();
      } catch {
        // Non-fatal — dashboard will refetch on focus.
      }
      router.replace('/(driver)/dashboard');
    })();
  }, []);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' }}>
      <ActivityIndicator color="#fff" />
    </View>
  );
}
