import React, { useCallback } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { fetchApi } from '@/lib/fetch/transport';
import { useFetchLoad } from '@/hooks/useFetchV2';
import { Frame } from '@/components/fetch/v2/Frame';
import { VerificationView } from '@/components/fetch/v2/Driving';
import { FButton, Notice } from '@/components/fetch/v2/ui';

/** Your driver details and documents (Step 8 deep link /fetch/driver/verification). */
export default function VerificationScreen() {
  const { applied } = useLocalSearchParams<{ applied?: string }>();
  const router = useRouter();
  const load = useCallback(() => fetchApi.verification(), []);
  const { data, error, loading, refresh } = useFetchLoad(load);
  return (
    <Frame title="Your driver details" loading={loading && !data} error={error?.message} onRefresh={refresh}>
      {data && (data.driver_status === 'not_applied'
        ? <><Notice>You haven't applied to drive yet.</Notice><FButton label="Apply to drive" onPress={() => router.replace('/fetch/drive/apply' as never)} /></>
        : <VerificationView v={data} applied={applied === '1'} refresh={refresh} />)}
    </Frame>
  );
}
