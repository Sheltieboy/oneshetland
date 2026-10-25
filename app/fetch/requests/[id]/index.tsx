import React, { useCallback } from 'react';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { loadJob } from '@/lib/fetch/load';
import { useFetchLoad } from '@/hooks/useFetchV2';
import { Frame, Gone } from '@/components/fetch/v2/Frame';
import { RequesterJob } from '@/components/fetch/v2/Jobs';

/** The requester's Fetch (Step 8 deep link /fetch/requests/<id>). A driver opening it is sent to their job screen. */
export default function RequestScreen() {
  const { id, posted } = useLocalSearchParams<{ id: string; posted?: string }>();
  const router = useRouter();
  const load = useCallback(() => loadJob(String(id)), [id]);
  const { data, error, loading, refresh } = useFetchLoad(load, { pollMs: 20_000 });
  if (error?.code === 'not_found') return <Gone title="Your Fetch" text="We couldn't find that Fetch." />;
  if (data?.viewer === 'driver') return <Redirect href={`/fetch/jobs/${id}` as never} />;
  return (
    <Frame title="Your Fetch" loading={loading && !data} error={data ? null : error?.message} onRefresh={refresh}>
      {data?.viewer === 'requester' && <RequesterJob data={{ ...data.data, posted: posted === '1' }} refresh={refresh} go={(p) => router.push(p as never)} />}
    </Frame>
  );
}
