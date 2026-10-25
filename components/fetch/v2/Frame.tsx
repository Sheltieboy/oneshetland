/**
 * The frame every Fetch v2 screen sits in: safe areas, the app's header, a keyboard-aware scroll with pull-to-refresh, centred on tablets.
 * Back goes back — or, when the screen was opened from a notification with nothing behind it, to the Fetch home.
 */
import React from 'react';
import { ActivityIndicator, RefreshControl, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { colors, spacing } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { FormScrollView } from '@/components/ui/FormScrollView';
import { FETCH_HOME } from '@/lib/fetch/mobile';
import { FButton, FETCH, Notice } from '@/components/fetch/v2/ui';

export function Frame({ title, subtitle, children, loading, error, onRefresh }: {
  title: string; subtitle?: string; children?: React.ReactNode; loading?: boolean; error?: string | null; onRefresh?: () => void;
}) {
  const router = useRouter();
  const { sidePadding } = useAppLayout();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.screenBackground }} edges={['top']}>
      <ScreenHeader title={title} subtitle={subtitle} accent={FETCH}
        onBack={() => (router.canGoBack() ? router.back() : router.replace(FETCH_HOME as never))} />
      <FormScrollView contentContainerStyle={{ padding: spacing.md, paddingHorizontal: spacing.md + sidePadding, paddingBottom: spacing.xxl }}
        refreshControl={onRefresh ? <RefreshControl refreshing={false} onRefresh={onRefresh} tintColor={FETCH} /> : undefined}>
        {loading ? (
          <View accessible accessibilityLabel="Loading" style={{ paddingVertical: spacing.xxl }}><ActivityIndicator color={FETCH} /></View>
        ) : (
          <>
            {!!error && <Notice tone="error"><Text>{error}</Text>{onRefresh && <FButton label="Try again" kind="quiet" onPress={onRefresh} />}</Notice>}
            {children}
          </>
        )}
      </FormScrollView>
    </SafeAreaView>
  );
}

/** Shown when a screen's thing doesn't exist for this member (or no longer does). */
export function Gone({ title, text }: { title: string; text: string }) {
  const router = useRouter();
  return (
    <Frame title={title}>
      <Notice>{text}</Notice>
      <FButton label="Back to Fetch" kind="secondary" onPress={() => router.replace(FETCH_HOME as never)} />
    </Frame>
  );
}
