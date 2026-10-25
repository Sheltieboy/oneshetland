/**
 * (tabs)/fetch.tsx — the Fetch tab (Fetch v2, Step 12).
 *
 * What it shows is decided by the server flag (fetch_v2_enabled), asked each time the tab comes into view and failing closed:
 *   - off for this member  → "Coming soon" (nothing invites anyone to request, drive or pay)
 *   - on, signed out       → the proposition, how it works, sign in
 *   - on, signed in        → the Fetch home: the two paths, your live Fetches and jobs, your journeys
 * The old v1 dashboards are no longer reachable from here (their routes now forward to v2; see app/(customer) and app/(driver)).
 */
import React, { useCallback } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { colors, spacing } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import { useAppLayout } from '@/hooks/useAppLayout';
import { useGoToSignIn } from '@/hooks/useGoToSignIn';
import { useFetchAccess, useFetchLoad } from '@/hooks/useFetchV2';
import { TabScreenHeader } from '@/components/TabScreenHeader';
import { ShetlandRoadSign } from '@/components/ShetlandRoadSign';
import { loadHome } from '@/lib/fetch/load';
import { ComingSoon, FetchHome, Proposition } from '@/components/fetch/v2/Home';
import { FButton, FETCH, Notice, Panel, s } from '@/components/fetch/v2/ui';

const S = SECTIONS.fetch;

export default function FetchTab() {
  const { profile, loading } = useAuth();
  const { access } = useFetchAccess(true);
  const { sidePadding } = useAppLayout();
  const pad = { padding: spacing.md, paddingHorizontal: spacing.md + sidePadding, paddingBottom: spacing.xxl };
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.navy }} edges={[]}>
      <TabScreenHeader section={S} title="Fetch" banner={<ShetlandRoadSign />} />
      <View style={{ flex: 1, backgroundColor: colors.screenBackground }}>
        {loading || access === 'checking' ? (
          <View accessible accessibilityLabel="Loading" style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={FETCH} /></View>
        ) : access === 'off' ? (
          <ScrollView contentContainerStyle={pad}><ComingSoon /></ScrollView>
        ) : !profile ? (
          <ScrollView contentContainerStyle={pad}><SignedOut /></ScrollView>
        ) : <SignedIn pad={pad} />}
      </View>
    </SafeAreaView>
  );
}

function SignedOut() {
  const goToSignIn = useGoToSignIn();
  return (
    <View>
      <Proposition />
      <Panel title="How it works">
        <Text style={s.body}>Post what needs fetching and see the price first. A driver who is going that way accepts it; your card is only authorised then, and you're charged once it's delivered.</Text>
      </Panel>
      <FButton label="Sign in to use Fetch" onPress={() => goToSignIn('/(tabs)/fetch')} />
    </View>
  );
}

function SignedIn({ pad }: { pad: object }) {
  const router = useRouter();
  const load = useCallback(() => loadHome(), []);
  const { data, error, loading, refresh } = useFetchLoad(load, { pollMs: 30_000 });
  return (
    <ScrollView contentContainerStyle={pad}>
      {loading && !data ? <ActivityIndicator color={FETCH} style={{ marginTop: spacing.xl }} />
        : error && !data ? <Notice tone="error"><Text style={s.body}>{error.message}</Text><FButton label="Try again" kind="quiet" onPress={refresh} /></Notice>
        : data && <FetchHome data={data} refresh={refresh} go={(p) => router.push(p as never)} />}
    </ScrollView>
  );
}
