import React, { useCallback } from 'react';
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { spacing } from '@/constants/theme';
import { fetchApi } from '@/lib/fetch/transport';
import { useFetchLoad } from '@/hooks/useFetchV2';
import { Frame } from '@/components/fetch/v2/Frame';
import { JourneyList } from '@/components/fetch/v2/Driving';
import { FButton, Notice, Panel, s } from '@/components/fetch/v2/ui';

/** Driving: the onboarding explainer if not applied; otherwise status, the board, journeys and payouts. */
export default function DriveScreen() {
  const router = useRouter();
  const go = (p: string) => router.push(p as never);
  const load = useCallback(async () => {
    const [v, runs] = await Promise.all([fetchApi.verification(), fetchApi.myRuns()]);
    if (!v.ok) return v;
    return { ok: true as const, data: { v: v.data, runs: runs.ok ? runs.data : [] } };
  }, []);
  const { data, error, loading, refresh } = useFetchLoad(load);
  const status = data?.v.driver_status;
  const applied = !!status && status !== 'not_applied';
  return (
    <Frame title="Drive with Fetch" subtitle="Take things where you're already going, and get paid for it." loading={loading && !data} error={error?.message} onRefresh={refresh}>
      {data && !applied && (
        <Panel title="How driving works">
          {['Apply with your vehicle, then add your driving licence and insurance. OneShetland checks them.',
            'Tell us where you\u2019re travelling. Fetches that fit your journey are shown first.',
            'Accept one, collect it once the payment is confirmed, deliver it. You\u2019re paid to your bank account.'].map((t, i) => <Text key={i} style={[s.body, { marginBottom: 6 }]}>{i + 1}. {t}</Text>)}
          <Text style={[s.muted, { marginBottom: spacing.sm }]}>You'll need payouts set up before you accept a Fetch.</Text>
          <FButton label="Apply to drive" onPress={() => go('/fetch/drive/apply')} />
        </Panel>
      )}
      {data && applied && (
        <View>
          {status === 'pending' && <Notice>Your application is under review.</Notice>}
          {status === 'approved' && !data.v.can_claim && <Notice tone="warn">You can't accept Fetches right now — see your driver details.</Notice>}
          <View style={{ gap: spacing.sm, marginBottom: spacing.md }}>
            <FButton label="See Fetches" onPress={() => go('/fetch/board')} />
            <FButton label="Post a journey" kind="secondary" onPress={() => go('/fetch/journeys/new')} />
            <FButton label="My driver details" kind="secondary" onPress={() => go('/fetch/driver/verification')} />
            <FButton label="My payouts" kind="secondary" onPress={() => go('/(driver)/connect-bank')} />
          </View>
          <Panel title="Your journeys"><JourneyList runs={data.runs} refresh={refresh} go={go} /></Panel>
        </View>
      )}
    </Frame>
  );
}
