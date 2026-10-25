/**
 * DEV-ONLY fixture preview of the Fetch v2 screens (Step 12). Renders the real view components from lib/fetch/scenarios.ts (the same
 * fixtures the tests and the website's preview use) — no backend, no session, nothing sent. It exists only in a development build
 * (__DEV__) started with EXPO_PUBLIC_FETCH_PREVIEW=1; otherwise it forwards to the Fetch tab. It sits outside /fetch, so the Fetch flag
 * gate is untouched. Buttons that would call the server fail harmlessly (the preview build points Supabase at a dead local address).
 */
import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, spacing } from '@/constants/theme';
import { CATEGORIES, MESSAGES, REGIONS, previewNow, scenarios, type Screen } from '@/lib/fetch/scenarios';
import { RequestWizard } from '@/components/fetch/v2/Wizard';
import { DriverJob, RequesterJob } from '@/components/fetch/v2/Jobs';
import { AcceptPanel, BoardList, VerificationView } from '@/components/fetch/v2/Driving';
import { FetchHome } from '@/components/fetch/v2/Home';
import { Notice, s } from '@/components/fetch/v2/ui';

const ENABLED = __DEV__ && process.env.EXPO_PUBLIC_FETCH_PREVIEW === '1';
const noop = () => undefined;

export default function FetchPreview() {
  const { scenario } = useLocalSearchParams<{ scenario: string }>();
  const router = useRouter();
  if (!ENABLED) return <Redirect href="/(tabs)/fetch" />;
  const now = previewNow();
  const all = scenarios(now);
  const sc = all.find((x) => x.key === scenario) ?? all[0];
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.screenBackground }} edges={['top']}>
      <View style={{ backgroundColor: colors.warningLight, padding: spacing.sm, flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <Text style={[s.bodyStrong, { width: '100%' }]}>Fixture preview — not live data</Text>
        {all.map((x) => (
          <Pressable key={x.key} onPress={() => router.replace(`/fetch-preview/${x.key}` as never)} accessibilityRole="button" style={{ minWidth: 36, minHeight: 32, justifyContent: 'center' }}>
            <Text style={[s.bodyStrong, { textDecorationLine: x.key === sc.key ? 'underline' : 'none' }]}>{x.key.toUpperCase()}</Text>
          </Pressable>
        ))}
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xxl }}>
        <Text style={[s.panelTitle, { marginBottom: spacing.md }]}>{sc.name}</Text>
        {sc.screens.map((screen, i) => (
          <View key={i} style={{ borderTopWidth: i ? 3 : 0, borderTopColor: colors.borderStrong, borderStyle: 'dashed', paddingTop: i ? spacing.md : 0, marginBottom: spacing.lg }}>
            <Text style={[s.muted, { marginBottom: spacing.sm }]}>SCREEN: {screen.title.toUpperCase()}</Text>
            {render(screen, now)}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function render(sc: Screen, now: number) {
  switch (sc.kind) {
    case 'wizard': return <RequestWizard regions={REGIONS} categories={CATEGORIES} initial={{ draft: sc.draft, step: sc.step, quote: sc.quote }} onPosted={noop} openPayments={noop} />;
    case 'requester': return <RequesterJob data={{ detail: sc.detail, timeline: sc.timeline, photos: sc.photos, issues: [], hint: sc.hint ?? null, now,
      messages: sc.messages ? { can_send: true, messages: [] } : null }} refresh={noop} go={noop} />;
    case 'driver': return <DriverJob data={{ detail: sc.detail, timeline: sc.timeline, photos: sc.photos, issues: [], pay: sc.pay, driverProblem: sc.driverProblem ?? null, now,
      messages: { can_send: true, messages: MESSAGES(now) } }} refresh={noop} go={noop} />;
    case 'board': return <BoardList items={sc.items} runs={sc.runs} showAll={sc.showAll} problem={sc.problem} setShowAll={noop} open={noop} go={noop} />;
    case 'boardItem': return sc.item ? <AcceptPanel item={sc.item} runs={sc.runs} problem={sc.problem} onAccepted={noop} go={noop} />
      : <View><Notice tone="warn">{sc.gone ?? ''}</Notice><Notice>It has been accepted by someone else, cancelled, or is no longer open.</Notice></View>;
    case 'verification': return <VerificationView v={sc.v} refresh={noop} />;
    case 'home': return <FetchHome data={{ requests: sc.requests, jobs: sc.jobs, runs: sc.runs, driverStatus: 'approved' }} refresh={noop} go={noop} />;
  }
}
