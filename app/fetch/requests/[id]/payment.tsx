import React, { useCallback } from 'react';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { loadJob } from '@/lib/fetch/load';
import { useFetchLoad } from '@/hooks/useFetchV2';
import { Frame, Gone } from '@/components/fetch/v2/Frame';
import { PaymentConfirm } from '@/components/fetch/v2/JobParts';
import { Notice } from '@/components/fetch/v2/ui';

/** The "your bank needs you to confirm" deep link. Anything other than a payment waiting on the requester opens the Fetch itself. */
export default function PaymentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const load = useCallback(() => loadJob(String(id)), [id]);
  const { data, error, loading, refresh } = useFetchLoad(load);
  if (error?.code === 'not_found' || data?.viewer === 'driver') return <Gone title="Confirm your payment" text="We couldn't find that Fetch." />;
  const r = data?.viewer === 'requester' ? data.data.detail.request : null;
  if (r && (r.status !== 'matched' || !['requires_action', 'requires_payment_method'].includes(r.payment_status))) return <Redirect href={`/fetch/requests/${id}` as never} />;
  return (
    <Frame title="Confirm your payment" loading={loading && !data} error={data ? null : error?.message}>
      <Notice>A driver has accepted your Fetch. The amount is only reserved now; you're charged when it's delivered.</Notice>
      {r && <PaymentConfirm requestId={String(id)} paymentStatus={r.payment_status} onDone={refresh} openPayments={() => router.push('/payment-setup' as never)} />}
    </Frame>
  );
}
