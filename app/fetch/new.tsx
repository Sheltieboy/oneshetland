import React, { useCallback } from 'react';
import { Text } from 'react-native';
import { useRouter } from 'expo-router';
import { fetchApi } from '@/lib/fetch/transport';
import { useFetchLoad } from '@/hooks/useFetchV2';
import { Frame } from '@/components/fetch/v2/Frame';
import { RequestWizard } from '@/components/fetch/v2/Wizard';
import { AdultGate } from '@/components/fetch/v2/Home';
import { Notice, s } from '@/components/fetch/v2/ui';

/** Ask for a Fetch: the 18+ confirmation (once), a restricted-account notice, then the five steps. */
export default function NewFetch() {
  const router = useRouter();
  const load = useCallback(async () => {
    const [elig, regions, categories] = await Promise.all([fetchApi.eligibility(), fetchApi.regions(), fetchApi.categories()]);
    if (!elig.ok) return elig;
    return { ok: true as const, data: { elig: elig.data, regions: regions.ok ? regions.data : [], categories: categories.ok ? categories.data : [] } };
  }, []);
  const { data, error, loading, refresh } = useFetchLoad(load);
  return (
    <Frame title="Ask for a Fetch" subtitle="What needs moving, from where, to where, and when." loading={loading && !data} error={error?.message}>
      {data && (data.elig.restricted
        ? <Notice tone="warn"><Text style={s.body}>Your account can't post Fetches at the moment. Please contact OneShetland.</Text></Notice>
        : !data.elig.adult_confirmed ? <AdultGate onConfirmed={refresh} />
        : <RequestWizard regions={data.regions} categories={data.categories} openPayments={() => router.push('/payment-setup' as never)}
            onPosted={(id) => router.replace({ pathname: '/fetch/requests/[id]', params: { id, posted: '1' } } as never)} />)}
    </Frame>
  );
}
