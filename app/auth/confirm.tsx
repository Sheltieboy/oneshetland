/**
 * app/auth/confirm.tsx
 *
 * Landing route for the email-confirmation deep link
 * (oneshetland-fetch://auth/confirm?next=…#access_token=…&refresh_token=…).
 *
 * Supabase confirms the account server-side, then redirects here. We:
 *   1. If the link carries session tokens, sign the user in directly
 *      (the client has detectSessionInUrl:false, so we set the session
 *      ourselves) and send them to `next` (where they were headed when they
 *      signed up) — or Home.
 *   2. Otherwise fall back to the sign-in screen, carrying `next`, so after a
 *      manual sign-in they still land where they were.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import * as Linking from 'expo-linking';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { sanitizeNext } from '@/lib/auth-redirect';
import { colors, fontSize, spacing } from '@/constants/theme';

/** Pull key=value pairs out of a URL fragment (#access_token=…&…). */
function parseFragment(url: string | null): Record<string, string> {
  if (!url) return {};
  const hash = url.split('#')[1];
  if (!hash) return {};
  const out: Record<string, string> = {};
  for (const part of hash.split('&')) {
    const [k, v] = part.split('=');
    if (k) out[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
  }
  return out;
}

export default function AuthConfirmScreen() {
  const router = useRouter();
  const url = Linking.useURL();
  const { next } = useLocalSearchParams<{ next?: string }>();
  const [handled, setHandled] = useState(false);

  useEffect(() => {
    if (handled || !url) return;
    setHandled(true);

    const dest = sanitizeNext(next) ?? '/(tabs)';
    const toSignIn = { pathname: '/(auth)/sign-in' as const, params: { ...(next ? { next } : {}), confirmed: '1' } };

    const { access_token, refresh_token } = parseFragment(url);
    if (access_token && refresh_token) {
      // Sign the user straight in from the confirmation link, then land them
      // where they were headed.
      supabase.auth
        .setSession({ access_token, refresh_token })
        .then(({ error }) => router.replace(error ? toSignIn : (dest as never)))
        .catch(() => router.replace(toSignIn));
      return;
    }

    // No tokens on the link — the account is confirmed, but we still need them
    // to sign in. Carry `next` so they return to where they were.
    router.replace(toSignIn);
  }, [url, next, handled, router]);

  return (
    <View style={styles.center}>
      <ActivityIndicator color="#fff" />
      <Text style={styles.text}>Confirming your account…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.navy },
  text: { color: '#fff', marginTop: spacing.md, fontSize: fontSize.sm },
});
