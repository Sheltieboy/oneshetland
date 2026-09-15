/**
 * app/auth/confirm.tsx
 *
 * Landing route for oneshetland-fetch://auth/confirm — opened from the "Open
 * OneShetland" link on the web /auth/confirmed success page, reached only
 * after Supabase has already confirmed the account server-side via the
 * HTTPS callback (oneshetland.com/auth/callback). This screen has nothing
 * left to verify or wait for: it routes straight to sign-in, carrying
 * `next` so the user lands back where they were after signing in manually.
 *
 * ── Why this no longer waits for anything ──────────────────────────────
 *
 * This used to wait on Linking.useURL() to read a #access_token=… fragment
 * directly off this same link, for an older flow where the link came
 * straight from Supabase's own /verify redirect with no server-side hop in
 * between. That mechanism is now unreachable: nothing in either repo
 * constructs this link with a fragment any more (confirmed by search) — the
 * web success page's "Open OneShetland" link only ever carries a plain
 * `next` query hint, deliberately never a session credential.
 *
 * Worse, waiting on it was actively broken: on a warm app resume (the app
 * was backgrounded, not relaunched — the common case here, since the whole
 * signup happens in one continuous session before the user briefly checks
 * email), Linking.useURL() can permanently return null. Expo Router's own
 * top-level linking listener consumes the one native "url" event first —
 * that's the only way it could have navigated here at all — and this
 * screen's own, separate useURL() subscription only starts listening after
 * that event has already passed. The screen spun on "Confirming your
 * account…" forever. Not waiting on anything removes that failure mode
 * structurally rather than patching the race.
 *
 * No access_token or refresh_token is read, held, or forwarded anywhere by
 * this screen — automatic sign-in was never required for launch; a plain
 * "confirmed, please sign in" handoff is.
 */
import React, { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { sanitizeNext } from '@/lib/auth-redirect';
import { colors } from '@/constants/theme';

export default function AuthConfirmScreen() {
  const router = useRouter();
  const { next } = useLocalSearchParams<{ next?: string }>();

  useEffect(() => {
    const dest = sanitizeNext(next);
    router.replace({
      pathname: '/(auth)/sign-in' as const,
      // confirmed: '1' is carried for a future success banner on sign-in;
      // harmless and ignored today, since that screen doesn't read it yet.
      params: { ...(dest ? { next: dest } : {}), confirmed: '1' },
    });
    // Runs once, on mount — there is nothing to wait for or react to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.navy }}>
      <ActivityIndicator color="#fff" />
    </View>
  );
}
