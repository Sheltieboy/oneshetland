import React, { useCallback, useState } from 'react';
import { useRouter } from 'expo-router';
import { fetchApi } from '@/lib/fetch/transport';
import { fetchMessage } from '@/lib/fetch-api';
import { useFetchLoad } from '@/hooks/useFetchV2';
import { Frame } from '@/components/fetch/v2/Frame';
import { BoardList } from '@/components/fetch/v2/Driving';

/** The board: "Suits you" first, "Show all" second. Journey matches stand out. Refreshed every 20 s while in view. */
export default function BoardScreen() {
  const router = useRouter();
  const [showAll, setShowAll] = useState(false);
  const load = useCallback(async () => {
    const [board, runs, elig] = await Promise.all([fetchApi.board(showAll), fetchApi.myRuns(), fetchApi.eligibility()]);
    if (!board.ok) return board;
    return { ok: true as const, data: { items: board.data, runs: runs.ok ? runs.data : [], problem: elig.ok && elig.data.driver_problem ? fetchMessage(elig.data.driver_problem) : null } };
  }, [showAll]);
  const { data, error, loading, refresh } = useFetchLoad(load, { pollMs: 20_000 });
  return (
    <Frame title="Fetches" subtitle="Things that need moving. The ones that fit your journeys come first." loading={loading && !data} error={error?.message} onRefresh={refresh}>
      {data && <BoardList items={data.items} runs={data.runs} showAll={showAll} problem={data.problem} setShowAll={setShowAll}
        open={(id) => router.push(`/fetch/board/${id}` as never)} go={(p) => router.push(p as never)} />}
    </Frame>
  );
}
