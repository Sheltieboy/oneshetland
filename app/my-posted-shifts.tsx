import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, Alert, RefreshControl,
} from 'react-native';
import { useStripe } from '@stripe/stripe-react-native';
import { supabase } from '@/lib/supabase';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import {
  fetchEmployerShifts, cancelShift, confirmShiftComplete,
  formatShiftDate, formatDuration, formatPay,
  URGENCY_CONFIG, CATEGORY_LABELS,
  type Shift,
} from '@/lib/shifts-api';

const S = SECTIONS.shifts;

type ShiftWithStats = Shift & {
  pending_count:     number;
  total_apps:        number;
  checked_out_count: number;
};

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  open:      { label: 'Open',      color: S.color,          bg: S.light },
  filled:    { label: 'Filled',    color: colors.jobs,      bg: colors.jobsLight },
  cancelled: { label: 'Cancelled', color: colors.textMuted,  bg: colors.screenBackground },
  completed: { label: 'Completed', color: '#2563EB',         bg: '#EFF6FF' },
  draft:     { label: 'Draft',     color: colors.textMuted,  bg: colors.screenBackground },
};

export default function MyPostedShiftsScreen() {
  const router = useRouter();
  const { profile } = useAuth();

  const [shifts, setShifts]         = useState<ShiftWithStats[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [cancelling, setCancelling]   = useState<string | null>(null);
  const [confirming, setConfirming]   = useState<string | null>(null);
  const [boosting,   setBoosting]     = useState<string | null>(null);
  const { initPaymentSheet, presentPaymentSheet } = useStripe();

  const load = useCallback(async () => {
    if (!profile) return;
    try {
      const data = await fetchEmployerShifts(profile.id);
      setShifts(data as ShiftWithStats[]);
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Could not load shifts.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [profile]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = () => { setRefreshing(true); load(); };

  const handleCancel = (shiftId: string, title: string) => {
    Alert.alert(
      'Cancel this shift?',
      `"${title}" will be closed and no new applications can be received.`,
      [
        { text: 'Keep it open', style: 'cancel' },
        {
          text: 'Yes, cancel it',
          style: 'destructive',
          onPress: async () => {
            setCancelling(shiftId);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            try {
              await cancelShift(shiftId);
              setShifts(prev =>
                prev.map(s => s.id === shiftId ? { ...s, status: 'cancelled' } : s)
              );
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            } catch (e: any) {
              Alert.alert('Error', e?.message);
            } finally {
              setCancelling(null);
            }
          },
        },
      ]
    );
  };

  const handleConfirmComplete = (shiftId: string, title: string, checkedOutCount: number) => {
    const msg = checkedOutCount > 0
      ? `${checkedOutCount} worker${checkedOutCount > 1 ? 's have' : ' has'} finished. Mark "${title}" as complete and notify them?`
      : `Mark "${title}" as complete? This will notify all confirmed workers.`;

    Alert.alert('Mark shift complete?', msg, [
      { text: 'Not yet', style: 'cancel' },
      {
        text: 'Confirm complete',
        onPress: async () => {
          setConfirming(shiftId);
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          try {
            await confirmShiftComplete(shiftId);
            setShifts(prev =>
              prev.map(s => s.id === shiftId ? { ...s, status: 'completed' } : s)
            );
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          } catch (e: any) {
            Alert.alert('Error', e?.message ?? 'Could not mark complete.');
          } finally {
            setConfirming(null);
          }
        },
      },
    ]);
  };

  const handleBoost = async (shiftId: string) => {
    // Pre-flight: card must be set up centrally in Me before boosting
    if (!profile?.has_payment_method) {
      Alert.alert(
        'Payment card needed',
        'Add a payment card in your account before boosting a shift.',
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Add card', onPress: () => router.push('/(customer)/payment-setup') },
        ],
      );
      return;
    }

    setBoosting(shiftId);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const { data, error: fnErr } = await supabase.functions.invoke('create-boost-intent', {
        body: { shift_id: shiftId },
      });
      if (fnErr) throw fnErr;

      const { error: initErr } = await initPaymentSheet({
        merchantDisplayName: 'OneShetland',
        paymentIntentClientSecret: data.clientSecret,
        style: 'alwaysLight',
      });
      if (initErr) throw initErr;

      const { error: presentErr } = await presentPaymentSheet();
      if (presentErr) {
        if (presentErr.code !== 'Canceled') Alert.alert('Payment failed', presentErr.message);
        return;
      }

      const { data: confirmData } = await supabase.functions.invoke('confirm-boost', {
        body: { shift_id: shiftId },
      });

      const boostedUntil = confirmData?.boosted_until ?? new Date(Date.now() + 86_400_000).toISOString();
      setShifts(prev => prev.map(s => s.id === shiftId ? { ...s, boosted_until: boostedUntil } : s));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert(
        '⚡ Shift boosted!',
        `Matching workers have been alerted. Your shift is pinned to the top for 24 hours.`,
        [{ text: 'Great' }]
      );
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Boost failed. Please try again.');
    } finally {
      setBoosting(null);
    }
  };

  const renderItem = ({ item }: { item: ShiftWithStats }) => {
    const urgency         = URGENCY_CONFIG[item.urgency];
    const status          = STATUS_CONFIG[item.status] ?? STATUS_CONFIG.open;
    const isCancelling    = cancelling === item.id;
    const isConfirming    = confirming === item.id;
    const isBoosting      = boosting === item.id;
    const isOpen          = item.status === 'open';
    const isFilled        = item.status === 'filled';
    const isActive        = isOpen || isFilled;
    const isShiftPast     = new Date(item.end_at) < new Date();
    const showConfirm     = isActive && (isShiftPast || item.checked_out_count > 0);
    const now             = new Date().toISOString();
    const isActiveBoosted = !!(item.boosted_until && item.boosted_until > now);
    const canBoost        = isOpen && !isActiveBoosted;
    const fillPct         = Math.min(1, item.positions_filled / Math.max(1, item.positions_total));
    const hasActions      = isOpen || (isActive && item.total_apps > 0) || showConfirm || canBoost;

    return (
      <View style={styles.card}>

        {/* Badge row */}
        <View style={styles.badgeRow}>
          <View style={[styles.urgencyBadge, { backgroundColor: urgency.bg }]}>
            <Text style={[styles.urgencyText, { color: urgency.color }]}>{urgency.label}</Text>
          </View>
          <View style={[styles.statusBadge, { backgroundColor: status.bg }]}>
            <Text style={[styles.statusText, { color: status.color }]}>{status.label}</Text>
          </View>
          {item.pending_count > 0 && (
            <View style={[styles.pendingBadge, { backgroundColor: S.color }]}>
              <Text style={styles.pendingBadgeText}>{item.pending_count} to review</Text>
            </View>
          )}
          {item.checked_out_count > 0 && item.status !== 'completed' && (
            <View style={[styles.pendingBadge, { backgroundColor: colors.jobs }]}>
              <Text style={styles.pendingBadgeText}>{item.checked_out_count} finished</Text>
            </View>
          )}
          {isActiveBoosted && (
            <View style={[styles.pendingBadge, { backgroundColor: colors.shifts }]}>
              <Text style={styles.pendingBadgeText}>⚡ Boosted</Text>
            </View>
          )}
          <Text style={styles.categoryLabel} numberOfLines={1}>
            {CATEGORY_LABELS[item.category] ?? item.category}
          </Text>
        </View>

        {/* Title */}
        <Text style={styles.cardTitle}>{item.title}</Text>

        {/* Date / duration row */}
        <View style={styles.metaRow}>
          <View style={styles.metaItem}>
            <FontAwesome5 name="clock" size={10} color={colors.textMuted} />
            <Text style={styles.metaText}>{formatShiftDate(item.start_at)}</Text>
          </View>
          <View style={styles.metaItem}>
            <FontAwesome5 name="hourglass-half" size={10} color={colors.textMuted} />
            <Text style={styles.metaText}>{formatDuration(item.start_at, item.end_at)}</Text>
          </View>
        </View>

        {/* Location / pay row */}
        <View style={styles.metaRow}>
          <View style={styles.metaItem}>
            <FontAwesome5 name="map-marker-alt" size={10} color={colors.textMuted} />
            <Text style={styles.metaText} numberOfLines={1}>{item.location_text}</Text>
          </View>
          <View style={styles.metaItem}>
            <FontAwesome5 name="pound-sign" size={10} color={colors.textMuted} />
            <Text style={styles.metaText}>{formatPay(item.pay_type, item.pay_amount)}</Text>
          </View>
        </View>

        {/* Positions progress bar */}
        <View style={styles.positionsRow}>
          <View style={styles.positionsBarTrack}>
            <View style={[
              styles.positionsBarFill,
              {
                width: `${fillPct * 100}%` as any,
                backgroundColor: isFilled ? colors.jobs : S.color,
              },
            ]} />
          </View>
          <Text style={styles.positionsLabel}>
            {item.positions_filled}/{item.positions_total} filled
            {isOpen && item.positions_total - item.positions_filled > 0
              ? `  ·  ${item.positions_total - item.positions_filled} available`
              : ''}
          </Text>
        </View>

        {/* Action buttons */}
        {hasActions && (
          <View style={styles.actions}>
            {isActive && item.total_apps > 0 && (
              <TouchableOpacity
                style={[styles.actionBtn, styles.appsBtn]}
                onPress={() => { Haptics.selectionAsync(); router.push('/employer-applications'); }}
                activeOpacity={0.8}
              >
                <FontAwesome5 name="inbox" size={12} color={S.color} />
                <Text style={styles.appsBtnText}>
                  {item.total_apps} {item.total_apps === 1 ? 'application' : 'applications'}
                </Text>
              </TouchableOpacity>
            )}
            {showConfirm && (
              <TouchableOpacity
                style={[styles.actionBtn, styles.completeBtn, isConfirming && { opacity: 0.55 }]}
                onPress={() => handleConfirmComplete(item.id, item.title, item.checked_out_count)}
                disabled={!!confirming}
                activeOpacity={0.8}
              >
                {isConfirming
                  ? <ActivityIndicator size="small" color={colors.jobs} />
                  : <>
                      <FontAwesome5 name="check-circle" size={12} color={colors.jobs} solid />
                      <Text style={styles.completeBtnText}>
                        {item.checked_out_count > 0
                          ? `${item.checked_out_count} finished — confirm`
                          : 'Mark complete'}
                      </Text>
                    </>
                }
              </TouchableOpacity>
            )}
            {canBoost && (
              <TouchableOpacity
                style={[styles.actionBtn, styles.boostBtn, isBoosting && { opacity: 0.55 }]}
                onPress={() => handleBoost(item.id)}
                disabled={!!boosting}
                activeOpacity={0.8}
              >
                {isBoosting
                  ? <ActivityIndicator size="small" color={colors.shifts} />
                  : <>
                      <FontAwesome5 name="bolt" size={12} color={colors.shifts} solid />
                      <Text style={styles.boostBtnText}>Boost — £2.99</Text>
                    </>
                }
              </TouchableOpacity>
            )}
            {isOpen && !showConfirm && (
              <TouchableOpacity
                style={[styles.actionBtn, styles.cancelBtn, isCancelling && { opacity: 0.55 }]}
                onPress={() => handleCancel(item.id, item.title)}
                disabled={!!cancelling}
                activeOpacity={0.8}
              >
                {isCancelling
                  ? <ActivityIndicator size="small" color={colors.textMuted} />
                  : <>
                      <FontAwesome5 name="times-circle" size={12} color="#DC2626" />
                      <Text style={styles.cancelBtnText}>Cancel shift</Text>
                    </>
                }
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>
    );
  };

  // Summary counts for the header subtitle
  const openCount     = shifts.filter(s => s.status === 'open').length;
  const pendingTotal  = shifts.reduce((n, s) => n + s.pending_count, 0);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>

      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Back</Text>
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>My Shifts</Text>
          {shifts.length > 0 && (
            <Text style={styles.headerSub}>
              {openCount} open{pendingTotal > 0 ? `  ·  ${pendingTotal} to review` : ''}
            </Text>
          )}
        </View>
        <View style={{ width: 60 }} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={S.color} />
        </View>
      ) : (
        <FlatList
          data={shifts}
          keyExtractor={item => item.id}
          renderItem={renderItem}
          contentContainerStyle={[styles.list, shifts.length === 0 && { flex: 1 }]}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={S.color} />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <View style={[styles.emptyIcon, { backgroundColor: S.light }]}>
                <FontAwesome5 name="briefcase" size={28} color={S.color} />
              </View>
              <Text style={styles.emptyTitle}>No shifts posted yet</Text>
              <Text style={styles.emptyText}>
                Use the Shifts tab to post your first shift. It will appear here once submitted.
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.screenBackground },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
    borderBottomWidth: 2,
  },
  backBtn:      { flexDirection: 'row', alignItems: 'center', gap: 8, width: 60 },
  backText:     { fontSize: fontSize.sm, fontWeight: '700' },
  headerCenter: { alignItems: 'center', gap: 2 },
  headerTitle:  { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
  headerSub:    { color: 'rgba(255,255,255,0.5)', fontSize: fontSize.xs, fontWeight: '600' },

  list: { padding: spacing.md, gap: 14, paddingBottom: 60 },

  card: {
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: 10,
    shadowColor: '#0F1C26',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 10,
    elevation: 2,
  },

  badgeRow:      { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  urgencyBadge:  { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full },
  urgencyText:   { fontSize: 10, fontWeight: '800' },
  statusBadge:   { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full },
  statusText:    { fontSize: 10, fontWeight: '700' },
  pendingBadge:  { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full },
  pendingBadgeText: { fontSize: 10, fontWeight: '800', color: '#fff' },
  categoryLabel: { flex: 1, fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600', textAlign: 'right' },

  cardTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary, lineHeight: 22 },

  metaRow:  { flexDirection: 'row', gap: 16 },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 5, flex: 1 },
  metaText: { fontSize: fontSize.xs, color: colors.textSecondary, fontWeight: '500', flex: 1 },

  positionsRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  positionsBarTrack: {
    flex: 1, height: 6, backgroundColor: colors.border,
    borderRadius: radius.full, overflow: 'hidden',
  },
  positionsBarFill: { height: '100%', borderRadius: radius.full },
  positionsLabel:   { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600' },

  actions: {
    flexDirection: 'row', gap: 10,
    paddingTop: 4, borderTopWidth: 1, borderTopColor: colors.border,
  },
  actionBtn: {
    flex: 1, height: 42, borderRadius: radius.md,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
  },
  appsBtn:      { backgroundColor: S.light, borderWidth: 1, borderColor: S.color + '55' },
  appsBtnText:  { fontSize: fontSize.sm, fontWeight: '700', color: S.color },
  cancelBtn:     { borderWidth: 1.5, borderColor: '#FECACA', backgroundColor: '#FFF5F5' },
  cancelBtnText: { fontSize: fontSize.sm, fontWeight: '700', color: '#DC2626' },
  completeBtn:     { borderWidth: 1.5, borderColor: colors.jobsLight, backgroundColor: colors.jobsLight },
  completeBtnText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.jobs },
  boostBtn:        { borderWidth: 1.5, borderColor: '#FDE68A', backgroundColor: '#FFFBEB' },
  boostBtnText:    { fontSize: fontSize.sm, fontWeight: '700', color: colors.shifts },

  empty:      { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: 12 },
  emptyIcon:  { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  emptyTitle: { fontSize: fontSize.lg, fontWeight: '800', color: colors.textPrimary },
  emptyText:  { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
});
