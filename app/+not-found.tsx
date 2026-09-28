/**
 * app/+not-found.tsx
 *
 * Expo Router's catch-all for any URL that doesn't match a registered route —
 * previously unhandled, so any unmatched route (a deep link that failed to
 * resolve, a stale/garbled URL, anything) fell through to Expo Router's raw
 * "Unmatched Route / Page could not be found" screen with no way forward
 * except backing out manually.
 *
 * This is a defensive recovery layer, not a fix for whatever produced an
 * unmatched route in the first place — that cause is not established here
 * and this screen makes no attempt to diagnose or reconstruct it. It reads
 * nothing from the failed URL (no token, no next, nothing) and decides
 * nothing about auth or onboarding itself. It has exactly one job: get off
 * this dead end and back onto a real, registered route — "/" — where
 * app/_layout.tsx's existing session/profile-aware routing (already proven
 * to recover correctly on its own, given a live route to work from) takes
 * over exactly as it does for any other navigation.
 */
import React, { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { colors } from '@/constants/theme';

export default function NotFoundScreen() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/');
    // Runs once, on mount — nothing here to wait on or react to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.navy }}>
      <ActivityIndicator color="#fff" />
    </View>
  );
}
