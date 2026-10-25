import React, { useCallback } from 'react';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { loadJob } from '@/lib/fetch/load';
import { useFetchLoad } from '@/hooks/useFetchV2';
import { Frame, Gone } from '@/components/fetch/v2/Frame';
import { DriverJob } from '@/components/fetch/v2/Jobs';

/** The driver's job (Step 8 deep link /fetch/jobs/<id>). A requester opening it is sent to their own Fetch. */
export default function JobScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const load = useCallback(() => loadJob(String(id)), [id]);
  const { data, error, loading, refresh } = useFetchLoad(load, { pollMs: 20_000 });
  if (error?.code === 'not_found') return <Gone title="Your job" text="This job is no longer available to you." />;
  if (data?.viewer === 'requester') return <Redirect href={`/fetch/requests/${id}` as never} />;
  return (
    <Frame title={data?.viewer === 'driver' ? String(data.data.detail.request.item_description) : 'Your job'} loading={loading && !data} error={data ? null : error?.message} onRefresh={refresh}>
      {data?.viewer === 'driver' && <DriverJob data={data.data} refresh={refresh} go={(p) => router.push(p as never)} />}
    </Frame>
  );
}
