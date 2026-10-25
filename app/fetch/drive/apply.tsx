import React, { useCallback } from 'react';
import { Redirect, useRouter } from 'expo-router';
import { fetchApi } from '@/lib/fetch/transport';
import { useFetchLoad } from '@/hooks/useFetchV2';
import { Frame } from '@/components/fetch/v2/Frame';
import { ApplyForm } from '@/components/fetch/v2/Driving';
import { AdultGate } from '@/components/fetch/v2/Home';
import { Notice } from '@/components/fetch/v2/ui';

/** Apply to drive. It ends "Under review" — the app can never approve anyone. */
export default function ApplyScreen() {
  const router = useRouter();
  const load = useCallback(async () => {
    const [v, elig, regions] = await Promise.all([fetchApi.verification(), fetchApi.eligibility(), fetchApi.regions()]);
    if (!elig.ok) return elig;
    return { ok: true as const, data: { status: v.ok ? v.data.driver_status : null, elig: elig.data, regions: regions.ok ? regions.data : [] } };
  }, []);
  const { data, error, loading, refresh } = useFetchLoad(load);
  if (data?.status && ['pending', 'approved', 'suspended'].includes(data.status)) return <Redirect href={'/fetch/driver/verification' as never} />;
  return (
    <Frame title="Apply to drive" loading={loading && !data} error={error?.message}>
      {data && (data.elig.restricted ? <Notice tone="warn">Your account can't use Fetch at the moment. Please contact OneShetland.</Notice>
        : !data.elig.adult_confirmed ? <AdultGate onConfirmed={refresh} />
        : <ApplyForm regions={data.regions} onApplied={() => router.replace({ pathname: '/fetch/driver/verification', params: { applied: '1' } } as never)} />)}
    </Frame>
  );
}
