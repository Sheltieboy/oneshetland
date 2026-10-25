import React, { useCallback } from 'react';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { fetchApi } from '@/lib/fetch/transport';
import { fetchMessage } from '@/lib/fetch-api';
import { useFetchLoad } from '@/hooks/useFetchV2';
import { Frame, Gone } from '@/components/fetch/v2/Frame';
import { AcceptPanel } from '@/components/fetch/v2/Driving';

/** One Fetch on the board (Step 8 deep link /fetch/board/<id>): the board's safe view — area only, never the address — and accept. */
export default function BoardItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const load = useCallback(async () => {
    const [board, runs, elig] = await Promise.all([fetchApi.board(true), fetchApi.myRuns(), fetchApi.eligibility()]);
    if (!board.ok) return board;
    const item = board.data.find((i) => i.request_id === id) ?? null;
    const mine = item ? null : await fetchApi.detail(String(id));
    return { ok: true as const, data: { item, mineAsDriver: !!(mine?.ok && mine.data.viewer === 'driver'), runs: runs.ok ? runs.data : [],
      problem: elig.ok && elig.data.driver_problem ? fetchMessage(elig.data.driver_problem) : null } };
  }, [id]);
  const { data, error, loading } = useFetchLoad(load);
  if (data?.mineAsDriver) return <Redirect href={`/fetch/jobs/${id}` as never} />;
  if (data && !data.item) return <Gone title="This Fetch has gone" text="It has been accepted by someone else, cancelled, or is no longer open." />;
  return (
    <Frame title={data?.item?.item_description ?? 'A Fetch'} loading={loading && !data} error={error?.message}>
      {data?.item && <AcceptPanel item={data.item} runs={data.runs} problem={data.problem} onAccepted={() => undefined} go={(p) => router.push(p as never)} />}
    </Frame>
  );
}
