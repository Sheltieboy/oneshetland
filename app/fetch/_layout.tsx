/**
 * Fetch v2 member screens (Step 12). Same paths as the website, so Step 8 notification routes open the matching screen directly.
 * Every screen here needs a signed-in member AND the server flag (fetch_v2_enabled) — checked again each time Fetch comes into view,
 * failing closed. There is no local flag and no route back into the old v1 Fetch screens.
 */
import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Redirect, Stack, usePathname } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, spacing } from '@/constants/theme';
import { useAuth } from '@/context/AuthContext';
import { useFetchAccess } from '@/hooks/useFetchV2';
import { AppBottomNav } from '@/components/AppBottomNav';
import { ComingSoon } from '@/components/fetch/v2/Home';
import { FETCH } from '@/components/fetch/v2/ui';

export default function FetchV2Layout() {
  const { session, loading } = useAuth();
  const pathname = usePathname();
  const { access } = useFetchAccess(!!session);
  if (loading || (session && access === 'checking')) {
    return <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}><ActivityIndicator color={FETCH} /></View>;
  }
  if (!session) return <Redirect href={`/(auth)/sign-in?next=${encodeURIComponent(pathname)}`} />;
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        {access === 'on' ? <Stack screenOptions={{ headerShown: false }} /> : (
          <SafeAreaView style={{ flex: 1, backgroundColor: colors.screenBackground, padding: spacing.md }}><ComingSoon /></SafeAreaView>
        )}
      </View>
      <AppBottomNav />
    </View>
  );
}
