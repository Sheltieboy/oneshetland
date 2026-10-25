import React, { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { fetchApi } from '@/lib/fetch/transport';
import { useFetchLoad } from '@/hooks/useFetchV2';
import { Frame } from '@/components/fetch/v2/Frame';
import { JourneyForm } from '@/components/fetch/v2/Driving';

export default function NewJourneyScreen() {
  const router = useRouter();
  const load = useCallback(async () => {
    const [regions, categories] = await Promise.all([fetchApi.regions(), fetchApi.categories()]);
    if (!regions.ok) return regions;
    return { ok: true as const, data: { regions: regions.data, categories: categories.ok ? categories.data : [] } };
  }, []);
  const { data, error, loading } = useFetchLoad(load);
  return (
    <Frame title="Where are you going?" subtitle="Fetches that fit your journey are shown to you first." loading={loading && !data} error={error?.message}>
      {data && <JourneyForm regions={data.regions} categories={data.categories} onPosted={() => router.replace('/fetch/board' as never)} />}
    </Frame>
  );
}
