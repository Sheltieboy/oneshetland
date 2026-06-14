import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { Card } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Button } from '@/components/ui/Button';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { LoadingState } from '@/components/ui/LoadingState';
import { EmptyState } from '@/components/ui/EmptyState';
import { useAppLayout } from '@/hooks/useAppLayout';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAlert } from '@/components/BrandedAlert';

const S = SECTIONS.fetch;

interface RequestDetail {
  id: string;
  category_slug: string;
  pickup_name: string;
  pickup_location: string;
  pickup_notes: string | null;
  destination_area: string | null;
  destination_address: string;
  delivery_notes: string | null;
  already_paid: boolean;
  ready_for_collection: boolean;
  status: string;
  created_at: string;
  run_id: string | null;
  base_fee_pence: number | null;
  waiting_fee_pence: number | null;
  total_fee_pence: number | null;
  payment_status: string | null;
}

interface RunDetail {
  departure_start: string;
  departure_end: string;
  ferry_crossing: boolean;
  driver: { full_name: string } | null;
  driver_profile: { vehicle_type: string | null } | null;
}

interface WaitingEvent {
  id: string;
  arrived_at: string;
  collected_at: string | null;
  waiting_fee_pence: number | null;
}

const GRACE_SECS = 300;   // 5 min grace before fee starts
const PERIOD_SECS = 300;  // 5 min billing period
const PERIOD_PENCE = 150; // £1.50 per period
const MAX_PENCE = 600;    // £6 cap

function calcWaitingFee(arrivedAt: Date, now: Date): number {
  const elapsed = Math.max(0, (now.getTime() - arrivedAt.getTime()) / 1000);
  const billable = Math.max(0, elapsed - GRACE_SECS);
  const periods = Math.floor(billable / PERIOD_SECS);
  return Math.min(periods * PERIOD_PENCE, MAX_PENCE);
}

function penceToGBP(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

export default function RequestDetailScreen() {
  const router = useRouter();
  const { alert } = useAlert();
  const { screenWidth } = useAppLayout();
  const params = useLocalSearchParams<{
    id: string;
    pickup_name?: string;
    destination_area?: string;
    destination_address?: string;
    status?: string;
  }>();
  const { id } = params;

  const [request, setRequest] = useState<RequestDetail | null>(
    params.pickup_name
      ? ({
          id: params.id,
          pickup_name: params.pickup_name,
          destination_area: params.destination_area || null,
          destination_address: params.destination_address ?? '',
          status: params.status ?? 'pending',
          category_slug: '',
          pickup_location: '',
          pickup_notes: null,
          delivery_notes: null,
          already_paid: false,
          ready_for_collection: false,
          created_at: '',
          run_id: null,
          base_fee_pence: null,
          waiting_fee_pence: null,
          total_fee_pence: null,
          payment_status: null,
        } as RequestDetail)
      : null,
  );
  const [run, setRun] = useState<RunDetail | null>(null);
  const [waitingEvent, setWaitingEvent] = useState<WaitingEvent | null>(null);
  const [liveWaitingFee, setLiveWaitingFee] = useState(0);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    if (!id) return;

    const { data: reqData } = await supabase
      .from('delivery_requests')
      .select('*')
      .eq('id', id)
      .single();

    if (!reqData) { setLoading(false); return; }
    setRequest(reqData as RequestDetail);

    // Driver info via RPC (bypasses RLS)
    if (reqData.run_id && reqData.status !== 'pending') {
      const { data: driverInfo } = await supabase
        .rpc('get_driver_info_for_request', { request_id: id });
      if (driverInfo) {
        setRun({
          departure_start: driverInfo.departure_start,
          departure_end: driverInfo.departure_end,
          ferry_crossing: driverInfo.ferry_crossing,
          driver: driverInfo.full_name ? { full_name: driverInfo.full_name } : null,
          driver_profile: driverInfo.vehicle_type ? { vehicle_type: driverInfo.vehicle_type } : null,
        });
      }
    }

    // Waiting event for this request (open = driver arrived, not yet collected)
    const { data: waitData } = await supabase
      .from('waiting_events')
      .select('id, arrived_at, collected_at, waiting_fee_pence')
      .eq('request_id', id)
      .order('arrived_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    setWaitingEvent(waitData as WaitingEvent | null);
    setLoading(false);
  }, [id]);

  // Initial load + realtime subscription for status changes
  useEffect(() => {
    if (!id) return;
    load();

    const channel = supabase
      .channel(`request-detail-${id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'delivery_requests', filter: `id=eq.${id}` },
        () => { load(); },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'waiting_events', filter: `request_id=eq.${id}` },
        () => { load(); },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [id, load]);

  // Live waiting fee timer — ticks every 10s while driver is waiting
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);

    if (waitingEvent && !waitingEvent.collected_at) {
      const arrived = new Date(waitingEvent.arrived_at);
      const tick = () => setLiveWaitingFee(calcWaitingFee(arrived, new Date()));
      tick();
      timerRef.current = setInterval(tick, 10_000);
    } else {
      setLiveWaitingFee(waitingEvent?.waiting_fee_pence ?? 0);
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [waitingEvent]);

  if (loading) {
    return (
      <ScreenScaffold
        header={<ScreenHeader title="Delivery request" accent={S.color} onBack={() => router.back()} />}
      >
        <LoadingState accent={S.color} />
      </ScreenScaffold>
    );
  }

  if (!request) {
    return (
      <ScreenScaffold
        header={<ScreenHeader title="Delivery request" accent={S.color} onBack={() => router.back()} />}
      >
        <EmptyState
          icon="exclamation-circle"
          title="Request not found"
          body="We couldn't find this delivery request. It may have been removed."
          accent={S.color}
          variant="card"
        />
      </ScreenScaffold>
    );
  }

  const start = run ? new Date(run.departure_start) : null;
  const end = run ? new Date(run.departure_end) : null;
  const isDelivered = request.status === 'delivered';

  // Waiting fee state
  const driverArrived = waitingEvent && !waitingEvent.collected_at && request.status === 'matched';
  const arrivedAt = waitingEvent ? new Date(waitingEvent.arrived_at) : null;
  const graceRemaining = arrivedAt
    ? Math.max(0, GRACE_SECS - (Date.now() - arrivedAt.getTime()) / 1000)
    : 0;
  const inGrace = graceRemaining > 0;

  async function handleCancel() {
    const status = request.status;

    if (status === 'collected' || status === 'delivered') return; // blocked

    const isMatched = status === 'matched';

    alert({
      title: isMatched ? 'Cancel this request?' : 'Cancel this request?',
      message: isMatched
        ? 'A driver has already accepted this request. They will be notified of the cancellation. Please only cancel if absolutely necessary.'
        : 'This will remove your request and no driver will be sent.',
      actions: [
        { label: 'Keep request', style: 'cancel' },
        {
          label: 'Yes, cancel it',
          style: 'destructive',
          onPress: async () => {
            setCancelling(true);
            const { error } = await supabase
              .from('delivery_requests')
              .update({ status: 'cancelled' })
              .eq('id', id);

            if (error) {
              setCancelling(false);
              alert({ title: 'Error', message: 'Could not cancel the request. Please try again.' });
              return;
            }

            // Notify the driver if they had already accepted
            if (isMatched) {
              const { data: { session } } = await supabase.auth.getSession();
              fetch('https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/notify-drivers', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${session?.access_token}`,
                },
                body: JSON.stringify({ request_id: id, event: 'cancelled' }),
              }).catch(() => {/* non-fatal */});
            }

            setCancelling(false);
            router.back();
          },
        },
      ],
    });
  }

  const baseFee = request.base_fee_pence;
  const waitFee = isDelivered ? (request.waiting_fee_pence ?? 0) : liveWaitingFee;
  const totalFee = isDelivered
    ? (request.total_fee_pence ?? (baseFee ?? 0) + waitFee)
    : (baseFee ?? 0) + waitFee;

  return (
    <ScreenScaffold
      header={
        <ScreenHeader
          title="Delivery request"
          accent={S.color}
          onBack={() => router.back()}
          rightElement={<StatusBadge status={`request_${request.status}`} />}
        />
      }
    >
      <ScrollView
        contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.body}>

          {/* ── Waiting fee alert ── */}
          {driverArrived && (
            <Card style={{...styles.waitCard, ...(inGrace ? styles.waitCardGrace : styles.waitCardActive)}}>
              <Text style={styles.waitTitle}>
                {inGrace ? '🕐 Driver has arrived' : '⏱ Waiting fee in progress'}
              </Text>
              <Text style={styles.waitBody}>
                {inGrace
                  ? 'Your driver is at the collection point. Confirm your item is ready to avoid a waiting fee.'
                  : 'Your driver has been waiting longer than the grace period. A waiting fee of up to £6.00 may apply.'}
              </Text>
              {inGrace && (
                <View style={styles.countdownRow}>
                  <Text style={styles.countdownValue}>{Math.ceil(graceRemaining / 60)}</Text>
                  <Text style={styles.countdownLabel}>min remaining{'\n'}before fee starts</Text>
                </View>
              )}
              {!inGrace && liveWaitingFee > 0 && (
                <Text style={styles.waitFeeAmount}>
                  Current waiting fee: {penceToGBP(liveWaitingFee)}
                </Text>
              )}
              {request.ready_for_collection ? (
                <View style={styles.collectionConfirmed}>
                  <Text style={styles.collectionConfirmedText}>✓ Collection confirmed — driver is on their way</Text>
                </View>
              ) : (
                <Button
                  label="I've confirmed collection is ready"
                  onPress={() =>
                    alert({
                      title: 'Confirm collection ready?',
                      message: 'This lets your driver know the item is definitely ready for collection and stops any further waiting fee.',
                      actions: [
                        { label: 'Cancel', style: 'cancel' },
                        {
                          label: 'Yes, confirm',
                          style: 'primary',
                          onPress: async () => {
                            await supabase
                              .from('delivery_requests')
                              .update({ ready_for_collection: true })
                              .eq('id', id);
                            load();
                          },
                        },
                      ],
                    })
                  }
                  variant="secondary"
                  size="sm"
                  fullWidth
                  style={{ marginTop: spacing.sm }}
                />
              )}
            </Card>
          )}

          {/* ── Status timeline ── */}
          <Card>
            <Text style={styles.sectionLabel}>Status</Text>
            <StatusTimeline status={request.status} driverArrived={!!driverArrived} />
          </Card>

          {/* ── Driver info ── */}
          {run && request.status !== 'pending' && (
            <Card style={styles.driverCard}>
              <Text style={styles.driverCardTitle}>Your driver</Text>
              <View style={styles.driverRow}>
                <View style={styles.driverAvatar}>
                  <Text style={styles.driverAvatarText}>
                    {(run.driver?.full_name ?? 'D')[0].toUpperCase()}
                  </Text>
                </View>
                <View style={styles.driverInfo}>
                  <Text style={styles.driverName}>
                    {run.driver?.full_name?.split(' ')[0] ?? 'Your driver'}
                  </Text>
                  {run.driver_profile?.vehicle_type && (
                    <Text style={styles.driverVehicle}>🚗 {run.driver_profile.vehicle_type}</Text>
                  )}
                </View>
              </View>
              {start && end && (
                <View style={styles.runTimeRow}>
                  <Text style={styles.runTimeLabel}>Departure window</Text>
                  <Text style={styles.runTimeValue}>
                    {start.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })},{' '}
                    {start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                    {' – '}
                    {end.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                  </Text>
                </View>
              )}
              {run.ferry_crossing && (
                <Text style={styles.ferryNote}>⛴ This run involves a ferry crossing</Text>
              )}
            </Card>
          )}

          {/* ── Matched info banner ── */}
          {request.status === 'matched' && (
            <Card style={styles.matchedBanner}>
              <Text style={styles.matchedBannerTitle}>🚗 Your driver is on the way</Text>
              <Text style={styles.matchedBannerBody}>
                They'll collect your item during the window above and deliver it straight to you.
                You'll see this screen update automatically as your delivery progresses.
              </Text>
              <View style={styles.matchedSteps}>
                <Text style={styles.matchedStep}>1. Driver collects your item</Text>
                <Text style={styles.matchedStep}>2. Driver heads to your address</Text>
                <Text style={styles.matchedStep}>3. Item delivered — card charged</Text>
              </View>
            </Card>
          )}

          {/* ── Fee breakdown ── shown once authorised */}
          {baseFee != null && (
            <Card style={isDelivered ? styles.feeCardDone : styles.feeCard}>
              <Text style={styles.sectionLabel}>
                {isDelivered ? 'Payment charged' : 'Payment pre-authorised'}
              </Text>
              <FeeRow label="Delivery fee" value={penceToGBP(baseFee)} />
              {(waitFee > 0) && (
                <FeeRow
                  label={isDelivered ? 'Waiting fee' : 'Waiting fee (running)'}
                  value={penceToGBP(waitFee)}
                  highlight={!isDelivered}
                />
              )}
              <View style={styles.feeDivider} />
              <FeeRow
                label="Total"
                value={penceToGBP(totalFee)}
                bold
              />
              <Text style={styles.feeNote}>
                {isDelivered
                  ? 'Your card has been charged.'
                  : 'Your card is pre-authorised and will only be charged on delivery.'}
              </Text>
            </Card>
          )}

          {/* ── Collection details ── */}
          <Card>
            <Text style={styles.sectionLabel}>Collection</Text>
            <DetailRow label="Category" value={request.category_slug} />
            <DetailRow label="From" value={request.pickup_name} />
            <DetailRow label="Address" value={request.pickup_location} />
            {request.pickup_notes && <DetailRow label="Notes" value={request.pickup_notes} />}
            <DetailRow label="Already paid" value={request.already_paid ? 'Yes' : 'No'} />
            <DetailRow
              label="Ready to collect"
              value={request.ready_for_collection ? 'Yes' : 'Not yet'}
            />
          </Card>

          {/* ── Delivery details ── */}
          <Card>
            <Text style={styles.sectionLabel}>Delivery</Text>
            {request.destination_area && (
              <DetailRow label="Area" value={request.destination_area} />
            )}
            <DetailRow label="Address" value={request.destination_address} />
            {request.delivery_notes && (
              <DetailRow label="Notes" value={request.delivery_notes} />
            )}
          </Card>

          {/* ── Cancel request ── */}
          {(request.status === 'pending' || request.status === 'matched') && (
            <Button
              label={cancelling ? 'Cancelling…' : 'Cancel this request'}
              onPress={handleCancel}
              loading={cancelling}
              variant="danger"
              size="md"
              fullWidth
              style={styles.cancelBtn}
            />
          )}

          {request.status === 'collected' && (
            <View style={styles.cancelBlockedCard}>
              <Text style={styles.cancelBlockedTitle}>⚠️ Can't cancel at this stage</Text>
              <Text style={styles.cancelBlockedBody}>
                The driver has already collected your item and is on their way. To stop the delivery please contact your driver directly.
              </Text>
            </View>
          )}

          <Text style={styles.submittedAt}>
            Submitted{' '}
            {new Date(request.created_at).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'long',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </Text>
          <Text style={styles.refreshNote}>🔴 Live updates</Text>
        </View>
      </ScrollView>
    </ScreenScaffold>
  );
}

// ── Status Timeline ──────────────────────────────────────────────────────────
const BASE_STEPS = [
  { key: 'pending',        label: 'Request submitted',    sub: 'Waiting for a driver to accept' },
  { key: 'matched',        label: 'Driver matched',       sub: 'Your driver will collect within the window below' },
  { key: 'driver_arrived', label: 'Driver arrived 📍',    sub: 'Your driver is at the collection point' },
  { key: 'collected',      label: 'Item collected',       sub: 'Your driver has picked up your item and is on their way' },
  { key: 'delivered',      label: 'Delivered 🎉',         sub: 'Your item has arrived!' },
];

function StatusTimeline({ status, driverArrived }: { status: string; driverArrived: boolean }) {
  const steps = driverArrived || status === 'collected' || status === 'delivered'
    ? BASE_STEPS
    : BASE_STEPS.filter((s) => s.key !== 'driver_arrived');

  // Map real status to step key (driver_arrived is injected, not a DB status)
  const activeKey = driverArrived && status === 'matched' ? 'driver_arrived' : status;
  const currentIdx = steps.findIndex((s) => s.key === activeKey);

  return (
    <View style={tlStyles.container}>
      {steps.map((step, idx) => {
        const done = idx <= currentIdx;
        const active = idx === currentIdx;
        return (
          <View key={step.key} style={tlStyles.row}>
            <View style={tlStyles.lineCol}>
              <View style={[tlStyles.dot, done && tlStyles.dotDone, active && tlStyles.dotActive]} />
              {idx < steps.length - 1 && (
                <View style={[tlStyles.line, idx < currentIdx && tlStyles.lineDone]} />
              )}
            </View>
            <View style={tlStyles.labelCol}>
              <Text style={[tlStyles.label, done && tlStyles.labelDone, active && tlStyles.labelActive]}>
                {step.label}
              </Text>
              {active && (
                <Text style={tlStyles.sublabel}>{step.sub}</Text>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const tlStyles = StyleSheet.create({
  container: { paddingTop: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'flex-start', minHeight: 36 },
  lineCol: { width: 24, alignItems: 'center' },
  labelCol: { flex: 1, paddingLeft: spacing.xs, paddingBottom: spacing.sm },
  dot: {
    width: 12, height: 12, borderRadius: 6,
    backgroundColor: colors.border, marginTop: 2,
  },
  dotDone: { backgroundColor: colors.accent },
  dotActive: { backgroundColor: colors.accent, width: 14, height: 14, borderRadius: 7, marginTop: 1 },
  line: { width: 2, flex: 1, backgroundColor: colors.border, marginTop: 2 },
  lineDone: { backgroundColor: colors.accent },
  label: { fontSize: fontSize.sm, color: colors.textMuted },
  labelDone: { color: colors.textPrimary },
  labelActive: { color: colors.navy, fontWeight: '700' },
  sublabel: { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 16, marginTop: 2 },
});

// ── Fee row ──────────────────────────────────────────────────────────────────
function FeeRow({ label, value, bold, highlight }: {
  label: string; value: string; bold?: boolean; highlight?: boolean;
}) {
  return (
    <View style={feeStyles.row}>
      <Text style={[feeStyles.label, bold && feeStyles.bold]}>{label}</Text>
      <Text style={[feeStyles.value, bold && feeStyles.bold, highlight && feeStyles.highlight]}>
        {value}
      </Text>
    </View>
  );
}

const feeStyles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  label: { fontSize: fontSize.sm, color: colors.textMuted },
  value: { fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: '500' },
  bold: { fontWeight: '700', color: colors.navy, fontSize: fontSize.md },
  highlight: { color: '#B45309' },
});

// ── Detail row ───────────────────────────────────────────────────────────────
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={detailStyles.row}>
      <Text style={detailStyles.label}>{label}</Text>
      <Text style={detailStyles.value}>{value || '—'}</Text>
    </View>
  );
}

const detailStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    gap: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  label: { fontSize: fontSize.sm, color: colors.textMuted, flexShrink: 0, width: 110 },
  value: { fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: '500', flex: 1, textAlign: 'right' },
});

// ── Main styles ──────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  content: { backgroundColor: colors.screenBackground, paddingBottom: spacing.xxl, flexGrow: 1 },

  body: { padding: spacing.lg, gap: spacing.md },

  // Waiting card
  waitCard: { borderWidth: 1.5 },
  waitCardGrace: { backgroundColor: '#FFFBEB', borderColor: '#F59E0B' },
  waitCardActive: { backgroundColor: '#FEF2F2', borderColor: '#EF4444' },
  waitTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.navy, marginBottom: spacing.xs },
  waitBody: { fontSize: fontSize.sm, color: colors.textMuted, lineHeight: 20 },
  waitFeeAmount: { fontSize: fontSize.md, fontWeight: '700', color: '#DC2626', marginTop: spacing.xs },

  // Driver card
  driverCard: { backgroundColor: '#F0FBFF', borderColor: colors.accent, borderWidth: 1.5 },
  driverCardTitle: {
    fontSize: fontSize.xs, fontWeight: '700', color: colors.accent,
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: spacing.sm,
  },
  driverRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.sm },
  driverAvatar: {
    width: 44, height: 44, borderRadius: radius.full,
    backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center',
  },
  driverAvatarText: { color: colors.white, fontWeight: '800', fontSize: fontSize.lg },
  driverInfo: { flex: 1 },
  driverName: { fontSize: fontSize.lg, fontWeight: '700', color: colors.navy },
  driverVehicle: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 2 },
  runTimeRow: { marginBottom: spacing.xs },
  runTimeLabel: { fontSize: fontSize.xs, color: colors.textMuted, marginBottom: 2 },
  runTimeValue: { fontSize: fontSize.sm, fontWeight: '600', color: colors.navy },
  ferryNote: { fontSize: fontSize.sm, color: '#1D4ED8', marginTop: spacing.xs },

  // Matched banner
  matchedBanner: { backgroundColor: '#F0FBFF', borderColor: colors.accent, borderWidth: 1 },
  matchedBannerTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.navy, marginBottom: spacing.xs },
  matchedBannerBody: { fontSize: fontSize.sm, color: colors.textMuted, lineHeight: 20, marginBottom: spacing.sm },
  matchedSteps: { gap: 4 },
  matchedStep: { fontSize: fontSize.sm, color: colors.navy, fontWeight: '500' },

  // Fee card
  feeCard: { borderColor: colors.accent, borderWidth: 1 },
  feeCardDone: { backgroundColor: '#F0FDF4', borderColor: '#22C55E', borderWidth: 1 },
  feeDivider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.xs },
  feeNote: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: spacing.xs, lineHeight: 16 },

  sectionLabel: {
    fontSize: fontSize.xs, fontWeight: '700', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: spacing.xs,
  },
  submittedAt: { fontSize: fontSize.xs, color: colors.textLight, textAlign: 'center' },
  refreshNote: { fontSize: fontSize.xs, color: colors.textLight, textAlign: 'center', marginTop: 2 },

  countdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.sm,
    backgroundColor: 'rgba(245,158,11,0.15)',
    borderRadius: radius.md,
    padding: spacing.md,
  },
  countdownValue: { fontSize: 40, fontWeight: '800', color: '#B45309', lineHeight: 44 },
  countdownLabel: { fontSize: fontSize.sm, color: '#92400E', fontWeight: '600', lineHeight: 18 },
  collectionConfirmed: {
    marginTop: spacing.sm,
    backgroundColor: '#F0FDF4',
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: 'center',
  },
  collectionConfirmedText: { fontSize: fontSize.sm, color: '#166534', fontWeight: '600' },
  cancelBtn: { marginBottom: spacing.md },
  cancelBlockedCard: {
    backgroundColor: colors.warningLight,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  cancelBlockedTitle: { fontSize: fontSize.sm, fontWeight: '700', color: '#92400E', marginBottom: 4 },
  cancelBlockedBody: { fontSize: fontSize.sm, color: '#78350F', lineHeight: 20 },
});
