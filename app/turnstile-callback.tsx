/**
 * app/turnstile-callback.tsx
 *
 * Deep-link landing pad for the hosted Turnstile challenge
 * (oneshetland-fetch://turnstile-callback), mirroring driver/connect-return.tsx
 * and payment-return.tsx exactly.
 *
 * expo-web-browser's openAuthSessionAsync (lib/turnstile.ts) is supposed to
 * intercept this URL itself and hand the result straight back to the caller
 * as a promise — this screen exists only for when that intercept doesn't
 * fire (browser dismissed manually, redirect opened externally, SDK quirks)
 * and the URL reaches Expo Router instead. It does nothing with the token
 * itself — no confirmation, no Stripe/Supabase calls, no writes — it is pure
 * navigation, exactly like its siblings.
 */

import { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';

export default function TurnstileCallback() {
  const router = useRouter();

  useEffect(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)');
    }
  }, []);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' }}>
      <ActivityIndicator color="#fff" />
    </View>
  );
}
