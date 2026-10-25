import React, { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { fetchApi } from '@/lib/fetch/transport';
import { useFetchLoad } from '@/hooks/useFetchV2';
import { Frame } from '@/components/fetch/v2/Frame';
import { History } from '@/components/fetch/v2/Home';

export default function HistoryScreen() {
  const router = useRouter();
  const load = useCallback(async () => {
    const [req, jobs] = await Promise.all([fetchApi.myRequests(), fetchApi.myJobs()]);
    if (!req.ok) return req;
    return { ok: true as const, data: { requests: req.data, jobs: jobs.ok ? jobs.data : [] } };
  }, []);
  const { data, error, loading, refresh } = useFetchLoad(load);
  return (
    <Frame title="Your Fetch history" loading={loading && !data} error={error?.message} onRefresh={refresh}>
      {data && <History requests={data.requests} jobs={data.jobs} go={(p) => router.push(p as never)} />}
    </Frame>
  );
}
