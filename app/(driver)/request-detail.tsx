import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { colors, fontSize, spacing, radius } from '@/constants/theme';

// ── Waiting fee constants ─────────────────────────────────────────────────────
const GRACE_SECS   = 5 * 60;   // 5 min grace period
const PERIOD_SECS  = 5 * 60;   // fee charged per 5 min block
const PERIOD_PENCE = 150;       // £1.50 per block
const MAX_PENCE    = 600;       // £6.00 cap

function calcWaitingFee(arrivedAt: Date, now: Date): number {
  const elapsed = Math.max(0, (now.getTime() - arrivedAt.getTime()) / 1000);
  const afterGrace = Math.max(0, elapsed - GRACE_SECS);
  const periods = Math.floor(afterGrace / PERIOD_SECS);
  return Math.min(periods * PERIOD_PENCE, MAX_PENCE);
}

function formatTimer(secs: number): string {
  const m = Math.floor(secs / 60).toString().padStart(2, '0');
  const s = (secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// ── Directions helper ─────────────────────────────────────────────────────────
function openDirections(address: string) {
  const encoded = encodeURIComponent(address);
  Alert.alert('Get directions', `Navigate to: ${address}`, [
    { text: 'Apple Maps', onPress: () => Linking.openURL(`maps://maps.apple.com/?daddr=${encoded}`) },
    { text: 'Google Maps', onPress: () => Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${encoded}`) },
    { text: 'Waze',        onPress: () => Linking.openURL(`https://waze.com/ul?q=${encoded}&navigate=yes`) },
    { text: 'Cancel', style: 'cancel' },
  ]);
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface RequestDetail {
  id: string;
  category_slug: string;
  pickup_name: string;
  pickup_location: string;
  pickup_notes: string | null;
  destination_area: string | null;
  destination_address: string;
  contact_phone: string | null;
  delivery_notes: string | null;
  already_paid: boolean;
  ready_for_collection: boolean;
  status: string;
  base_fee_pence: number | null;
  waiting_fee_pence: number;
}

interface WaitingEvent {
  id: string;
  arrived_at: string;
  collected_at: string | null;
  waiting_fee_pence: number;
  customer_confirmed: boolean | null;
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function DriverRequestDetailScreen() {
  const router  = useRouter();
  const { id }  = useLocalSearchParams<{ id: string }>();
  const { session } = useAuth();

  const [request, setRequest]           = useState<RequestDetail | null>(null);
  const [customerName, setCustomerName] = useState<string | null>(null);
  const [waitingEvent, setWaitingEvent] = useState<WaitingEvent | null>(null);
  const [loading, setLoading]           = useState(true);
  const [updating, setUpdating]         = useState(false);

  // ── Timer ────────────────────────────────────────────────────────────────
  const [elapsedSecs, setElapsedSecs] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (waitingEvent && !waitingEvent.collected_at) {
      const arrivedAt = new Date(waitingEvent.arrived_at);
      const tick = () => {
        const secs = Math.floor((Date.now() - arrivedAt.getTime()) / 1000);
        setElapsedSecs(secs);
      };
      tick();
      timerRef.current = setInterval(tick, 1000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [waitingEvent]);

  // ── Load data ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!id) return;
    async function load() {
      const { data } = await supabase
        .from('delivery_requests')
        .select('id, category_slug, pickup_name, pickup_location, pickup_notes, destination_area, destination_address, contact_phone, delivery_notes, already_paid, ready_for_collection, status, base_fee_pence, waiting_fee_pence')
        .eq('id', id)
        .single();

      if (data) {
        setRequest(data as RequestDetail);
        const { data: customerData } = await supabase
          .rpc('get_customer_info_for_request', { request_id: id });
        if (customerData?.first_name) setCustomerName(customerData.first_name);

        // Check for an existing waiting event
        const { data: we } = await supabase
          .from('waiting_events')
          .select('id, arrived_at, collected_at, waiting_fee_pence, customer_confirmed')
          .eq('request_id', id)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();
        if (we) setWaitingEvent(we as WaitingEvent);
      }
      setLoading(false);
    }
    load();
  }, [id]);

  // ── I've arrived ─────────────────────────────────────────────────────────
  async function handleArrived() {
    if (!request || !session?.user.id) return;
    setUpdating(true);
    const { data, error } = await supabase
      .from('waiting_events')
      .insert({ request_id: request.id, driver_id: session.user.id })
      .select()
      .single();
    setUpdating(false);
    if (error) { Alert.alert('Error', error.message); return; }
    setWaitingEvent(data as WaitingEvent);
  }

  // ── Mark collected ───────────────────────────────────────────────────────
  async function handleCollected() {
    if (!request || !waitingEvent) return;

    const arrivedAt    = new Date(waitingEvent.arrived_at);
    const collectedAt  = new Date();
    const feePence     = request.ready_for_collection
      ? calcWaitingFee(arrivedAt, collectedAt)
      : 0;

    const feeLabel = feePence > 0
      ? `A waiting fee of £${(feePence / 100).toFixed(2)} will be added (${Math.floor((collectedAt.getTime() - arrivedAt.getTime()) / 60000)} mins wait).`
      : '';

    Alert.alert(
      'Mark as collected?',
      `Confirm you've collected the item.${feeLabel ? '\n\n' + feeLabel : ''}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm collected',
          onPress: async () => {
            setUpdating(true);
            // Update waiting event
            await supabase
              .from('waiting_events')
              .update({ collected_at: collectedAt.toISOString(), waiting_fee_pence: feePence })
              .eq('id', waitingEvent.id);

            // Update request
            await supabase
              .from('delivery_requests')
              .update({ status: 'collected', waiting_fee_pence: feePence })
              .eq('id', request.id);

            setUpdating(false);
            setRequest((prev) => prev ? { ...prev, status: 'collected', waiting_fee_pence: feePence } : prev);
            setWaitingEvent((prev) => prev ? { ...prev, collected_at: collectedAt.toISOString(), waiting_fee_pence: feePence } : prev);
            if (timerRef.current) clearInterval(timerRef.current);

            // Notify the customer their item has been collected
            const { data: { session: s } } = await supabase.auth.getSession();
            fetch('https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/notify-collected', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s?.access_token}` },
              body: JSON.stringify({ request_id: request.id }),
            }).catch(() => {/* non-fatal */});
          },
        },
      ],
    );
  }

  // ── Mark delivered + capture payment ────────────────────────────────────
  async function handleDelivered() {
    if (!request) return;
    Alert.alert(
      'Mark as delivered?',
      "Confirm you've delivered the item to the customer. Payment will be taken now.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm delivered',
          onPress: async () => {
            setUpdating(true);
            try {
              const res = await fetch(
                'https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/capture-payment',
                {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${session?.access_token}`,
                  },
                  body: JSON.stringify({ request_id: request.id }),
                },
              );
              const result = await res.json();
              if (!res.ok) throw new Error(result?.error ?? `Error ${res.status}`);
              setRequest((prev) => prev ? { ...prev, status: 'delivered' } : prev);
              const payMsg = result.total_fee_pence
                ? `£${(result.total_fee_pence / 100).toFixed(2)} has been charged to the customer.`
                : 'Delivery marked as complete.';
              Alert.alert(
                'Delivered! 🎉',
                `${payMsg} You'll receive your payout within 2 working days.`,
                [{ text: 'Back to dashboard', onPress: () => router.replace('/(driver)/dashboard') }],
              );
            } catch (err) {
              Alert.alert('Payment error', err instanceof Error ? err.message : 'Could not capture payment.');
            } finally {
              setUpdating(false);
            }
          },
        },
      ],
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.centre}><ActivityIndicator color={colors.accent} size="large" /></View>
      </SafeAreaView>
    );
  }
  if (!request) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.centre}><Text style={styles.centreText}>Request not found.</Text></View>
      </SafeAreaView>
    );
  }

  const inGrace       = elapsedSecs < GRACE_SECS;
  const currentFee    = waitingEvent && !waitingEvent.collected_at && request.ready_for_collection
    ? calcWaitingFee(new Date(waitingEvent.arrived_at), new Date())
    : 0;
  const baseFeeLabel  = request.base_fee_pence ? `£${(request.base_fee_pence / 100).toFixed(2)}` : '—';

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backLink}>
            <Text style={styles.backLinkText}>‹ Back</Text>
          </TouchableOpacity>
          <View style={styles.headerTop}>
            <Text style={styles.title}>Delivery request</Text>
            <StatusBadge status={request.status} />
          </View>
          {customerName && <Text style={styles.customerName}>Customer: {customerName}</Text>}
        </View>

        <View style={styles.body}>

          {/* Pickup */}
          <View style={styles.stopSection}>
            <View style={styles.stopLabelRow}>
              <View style={[styles.stopDot, styles.stopDotPickup]} />
              <Text style={styles.stopLabel}>COLLECTION</Text>
            </View>
            <Card style={styles.stopCard}>
              <Text style={styles.stopName}>{request.pickup_name}</Text>
              <Text style={styles.stopAddress}>{request.pickup_location}</Text>
              {request.pickup_notes && <Text style={styles.stopNotes}>📝 {request.pickup_notes}</Text>}
              <View style={styles.stopMeta}>
                {request.already_paid && (
                  <View style={styles.metaBadge}><Text style={styles.metaBadgeText}>✅ Already paid</Text></View>
                )}
                {request.ready_for_collection && (
                  <View style={[styles.metaBadge, styles.metaBadgeGreen]}>
                    <Text style={[styles.metaBadgeText, styles.metaBadgeTextGreen]}>Ready now</Text>
                  </View>
                )}
              </View>
              <TouchableOpacity style={styles.directionsButton} onPress={() => openDirections(request.pickup_location)} activeOpacity={0.8}>
                <Text style={styles.directionsButtonText}>🗺  Get directions to pickup</Text>
              </TouchableOpacity>
            </Card>
          </View>

          {/* Route connector */}
          <View style={styles.routeLine}>
            <View style={styles.routeLineBar} />
            <Text style={styles.routeCategory}>{request.category_slug}</Text>
            <View style={styles.routeLineBar} />
          </View>

          {/* Delivery */}
          <View style={styles.stopSection}>
            <View style={styles.stopLabelRow}>
              <View style={[styles.stopDot, styles.stopDotDelivery]} />
              <Text style={styles.stopLabel}>DELIVERY</Text>
            </View>
            <Card style={styles.stopCard}>
              {request.destination_area && <Text style={styles.stopArea}>{request.destination_area}</Text>}
              <Text style={styles.stopAddress}>{request.destination_address}</Text>
              {request.delivery_notes && <Text style={styles.stopNotes}>📝 {request.delivery_notes}</Text>}
              {request.contact_phone && (
                <TouchableOpacity style={styles.callButton} onPress={() => Linking.openURL(`tel:${request.contact_phone}`)} activeOpacity={0.8}>
                  <Text style={styles.callButtonText}>📞  Call customer — {request.contact_phone}</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={styles.directionsButton} onPress={() => openDirections([request.destination_area, request.destination_address].filter(Boolean).join(', '))} activeOpacity={0.8}>
                <Text style={styles.directionsButtonText}>🗺  Get directions to delivery</Text>
              </TouchableOpacity>
            </Card>
          </View>

          {/* ── Waiting fee timer ── */}
          {waitingEvent && !waitingEvent.collected_at && (
            <View style={[styles.timerCard, inGrace ? styles.timerCardGrace : currentFee > 0 ? styles.timerCardFee : styles.timerCardGrace]}>
              <View style={styles.timerRow}>
                <Text style={styles.timerLabel}>
                  {inGrace ? '⏱ Grace period' : '⏳ Waiting fee running'}
                </Text>
                <Text style={styles.timerClock}>{formatTimer(elapsedSecs)}</Text>
              </View>
              {inGrace ? (
                <Text style={styles.timerSub}>
                  Waiting fee starts after {formatTimer(GRACE_SECS - elapsedSecs)}
                </Text>
              ) : (
                <Text style={styles.timerSub}>
                  Current fee: £{(currentFee / 100).toFixed(2)} · Max £{(MAX_PENCE / 100).toFixed(2)}
                </Text>
              )}
            </View>
          )}

          {/* ── Fee summary ── */}
          {request.base_fee_pence != null && (
            <View style={styles.feeSummary}>
              <View style={styles.feeRow}>
                <Text style={styles.feeLabel}>Base fee</Text>
                <Text style={styles.feeValue}>{baseFeeLabel}</Text>
              </View>
              {(request.waiting_fee_pence > 0 || currentFee > 0) && (
                <View style={styles.feeRow}>
                  <Text style={styles.feeLabel}>Waiting fee</Text>
                  <Text style={styles.feeValue}>
                    £{((request.waiting_fee_pence || currentFee) / 100).toFixed(2)}
                  </Text>
                </View>
              )}
              <View style={[styles.feeRow, styles.feeTotalRow]}>
                <Text style={styles.feeTotalLabel}>Total</Text>
                <Text style={styles.feeTotalValue}>
                  £{(((request.base_fee_pence ?? 0) + (request.waiting_fee_pence || currentFee)) / 100).toFixed(2)}
                </Text>
              </View>
            </View>
          )}

          {/* ── Status actions ── */}

          {/* Step 1: arrived at pickup */}
          {request.status === 'matched' && !waitingEvent && (
            <Button
              label="I've arrived at collection point"
              onPress={handleArrived}
              loading={updating}
              variant="outline"
              size="lg"
              fullWidth
              style={styles.actionButton}
            />
          )}

          {/* Step 2: mark collected (after arriving) */}
          {request.status === 'matched' && waitingEvent && !waitingEvent.collected_at && (
            <Button
              label="Mark as collected"
              onPress={handleCollected}
              loading={updating}
              variant="outline"
              size="lg"
              fullWidth
              style={styles.actionButton}
            />
          )}

          {/* Step 3: mark delivered + capture payment */}
          {request.status === 'collected' && (
            <Button
              label="Mark as delivered ✓"
              onPress={handleDelivered}
              loading={updating}
              variant="secondary"
              size="lg"
              fullWidth
              style={styles.actionButton}
            />
          )}

          {request.status === 'delivered' && (
            <Card style={styles.deliveredCard}>
              <Text style={styles.deliveredText}>🎉 This delivery is complete.</Text>
            </Card>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  content: { backgroundColor: colors.screenBackground, paddingBottom: spacing.xxl, flexGrow: 1 },
  centre: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.navy },
  centreText: { color: colors.white, fontSize: fontSize.md },

  header: { backgroundColor: colors.navy, paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xl },
  backLink: { marginBottom: spacing.md },
  backLinkText: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.sm, fontWeight: '500' },
  headerTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.xs },
  title: { color: colors.white, fontSize: fontSize.xxl, fontWeight: '800' },
  customerName: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.sm, marginTop: 4 },

  body: { padding: spacing.lg },

  stopSection: { marginBottom: 0 },
  stopLabelRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xs },
  stopDot: { width: 12, height: 12, borderRadius: 6 },
  stopDotPickup: { backgroundColor: colors.accent },
  stopDotDelivery: { backgroundColor: colors.navy },
  stopLabel: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textMuted, letterSpacing: 1 },
  stopCard: { marginBottom: 0 },
  stopName: { fontSize: fontSize.lg, fontWeight: '700', color: colors.navy, marginBottom: 4 },
  stopArea: { fontSize: fontSize.sm, fontWeight: '600', color: colors.textMuted, marginBottom: 2 },
  stopAddress: { fontSize: fontSize.sm, color: colors.textMuted, lineHeight: 20, marginBottom: spacing.sm },
  stopNotes: { fontSize: fontSize.sm, color: colors.textPrimary, marginBottom: spacing.sm, lineHeight: 20 },
  stopMeta: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm, flexWrap: 'wrap' },
  metaBadge: { backgroundColor: colors.offWhite, paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.full, borderWidth: 1, borderColor: colors.border },
  metaBadgeGreen: { backgroundColor: colors.successLight, borderColor: '#6EE7B7' },
  metaBadgeText: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600' },
  metaBadgeTextGreen: { color: '#065F46' },
  callButton: { backgroundColor: '#F0FDF4', borderRadius: radius.md, paddingVertical: 10, paddingHorizontal: spacing.md, alignItems: 'center', borderWidth: 1, borderColor: '#BBF7D0', marginBottom: spacing.sm },
  callButtonText: { fontSize: fontSize.sm, fontWeight: '600', color: '#15803D' },
  directionsButton: { backgroundColor: '#EFF6FF', borderRadius: radius.md, paddingVertical: 10, paddingHorizontal: spacing.md, alignItems: 'center', borderWidth: 1, borderColor: '#BFDBFE' },
  directionsButtonText: { fontSize: fontSize.sm, fontWeight: '600', color: '#1D4ED8' },

  routeLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm, paddingHorizontal: spacing.xs },
  routeLineBar: { flex: 1, height: 1, backgroundColor: colors.border },
  routeCategory: { fontSize: fontSize.xs, color: colors.textLight, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },

  // Waiting fee timer
  timerCard: { marginTop: spacing.lg, borderRadius: radius.lg, padding: spacing.md, borderWidth: 1 },
  timerCardGrace: { backgroundColor: '#FFF7ED', borderColor: '#FED7AA' },
  timerCardFee:   { backgroundColor: '#FEF2F2', borderColor: '#FECACA' },
  timerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  timerLabel: { fontSize: fontSize.sm, fontWeight: '700', color: '#92400E' },
  timerClock: { fontSize: fontSize.xl, fontWeight: '800', color: '#92400E', fontVariant: ['tabular-nums'] },
  timerSub: { fontSize: fontSize.xs, color: '#B45309' },

  // Fee summary
  feeSummary: { marginTop: spacing.lg, backgroundColor: colors.white, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  feeRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: spacing.md, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  feeLabel: { fontSize: fontSize.sm, color: colors.textMuted },
  feeValue: { fontSize: fontSize.sm, color: colors.navy, fontWeight: '600' },
  feeTotalRow: { borderBottomWidth: 0, backgroundColor: colors.offWhite },
  feeTotalLabel: { fontSize: fontSize.md, fontWeight: '700', color: colors.navy },
  feeTotalValue: { fontSize: fontSize.md, fontWeight: '800', color: colors.navy },

  actionButton: { marginTop: spacing.lg },
  deliveredCard: { marginTop: spacing.lg, backgroundColor: colors.successLight, alignItems: 'center' },
  deliveredText: { fontSize: fontSize.md, fontWeight: '600', color: '#065F46' },
});
