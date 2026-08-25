import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import { useAppLayout } from '@/hooks/useAppLayout';
import { useAlert } from '@/components/BrandedAlert';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingState } from '@/components/ui/LoadingState';
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
  const { screenWidth } = useAppLayout();
  const { alert } = useAlert();

  const [shifts, setShifts]         = useState<ShiftWithStats[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [cancelling, setCancelling]   = useState<string | null>(null);
  const [confirming, setConfirming]   = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile) return;
    try {
      const data = await fetchEmployerShifts(profile.id);
      setShifts(data as ShiftWithStats[]);
    } catch (e: any) {
      alert({ title: 'Error', message: e?.message ?? 'Could not load shifts.' });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [profile]);

  // Refresh on focus so application counts update after new applications arrive
  // or you accept/decline on the applicants screen.
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = () => { setRefreshing(true); load(); };

  const handleCancel = (shiftId: string, title: string) => {
    alert({
      title: 'Cancel this shift?',
      message: `"${title}" will be closed and no new applications can be received.`,
      actions: [
        { label: 'Keep it open', style: 'cancel' },
        {
          label: 'Yes, cancel it',
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
              alert({ title: 'Error', message: e?.message });
            } finally {
              setCancelling(null);
            }
          },
        },
      ],
    });
  };

  const handleConfirmComplete = (shiftId: string, title: string, checkedOutCount: number) => {
    const msg = checkedOutCount > 0
      ? `${checkedOutCount} worker${checkedOutCount > 1 ? 's have' : ' has'} finished. Mark "${title}" as complete and notify them?`
      : `Mark "${title}" as complete? This will notify all confirmed workers.`;

    alert({
      title: 'Mark shift complete?',
      message: msg,
      actions: [
        { label: 'Not yet', style: 'cancel' },
        {
          label: 'Confirm complete',
          style: 'primary',
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
              alert({ title: 'Error', message: e?.message ?? 'Could not mark complete.' });
            } finally {
              setConfirming(null);
            }
          },
        },
      ],
    });
  };

  // Shift boost is a paid digital feature and its in-app purchase path has been
  // removed for store compliance. The boost CTA is no longer rendered.

  const renderItem = ({ item }: { item: ShiftWithStats }) => {
    const urgency         = URGENCY_CONFIG[item.urgency];
    const status          = STATUS_CONFIG[item.status] ?? STATUS_CONFIG.open;
    const isCancelling    = cancelling === item.id;
    const isConfirming    = confirming === item.id;
    const isOpen          = item.status === 'open';
    const isFilled        = item.status === 'filled';
    const isActive        = isOpen || isFilled;
    const isShiftPast     = new Date(item.end_at) < new Date();
    const showConfirm     = isActive && (isShiftPast || item.checked_out_count > 0);
    const now             = new Date().toISOString();
    const isActiveBoosted = !!(item.boosted_until && item.boosted_until > now);
    const fillPct         = Math.min(1, item.positions_filled / Math.max(1, item.positions_total));
    const hasActions      = isOpen || (isActive && item.total_apps > 0) || showConfirm;

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
                onPress={() => { Haptics.selectionAsync(); router.push({ pathname: '/shift-detail', params: { id: item.id } }); }}
                activeOpacity={0.8}
              >
                <FontAwesome5 name="inbox" size={12} color={S.color} />
                <Text style={styles.appsBtnText}>
                  {item.pending_count > 0
                    ? `Review ${item.pending_count} applicant${item.pending_count === 1 ? '' : 's'}`
                    : `${item.total_apps} applicant${item.total_apps === 1 ? '' : 's'}`}
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
    <ScreenScaffold
      header={
        <ScreenHeader
          title="My Shifts"
          subtitle={
            shifts.length > 0
              ? `${openCount} open${pendingTotal > 0 ? `  ·  ${pendingTotal} to review` : ''}`
              : undefined
          }
          accent={S.color}
          backStyle="chevron"
          onBack={() => router.back()}
        />
      }
    >
      {loading ? (
        <LoadingState accent={S.color} />
      ) : (
        <FlatList
          data={shifts}
          keyExtractor={item => item.id}
          renderItem={renderItem}
          contentContainerStyle={[
            styles.list,
            shifts.length === 0 && { flex: 1 },
            contentContainer(screenWidth),
          ]}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={S.color} />
          }
          ListHeaderComponent={
            /* What has been PAID for, as opposed to what is boosted right now.
               Read-only — boosts are bought on the website. */
            <TouchableOpacity
              style={styles.historyLink}
              onPress={() => router.push('/shift-boost-history')}
              activeOpacity={0.85}
            >
              <FontAwesome5 name="bolt" size={13} color={S.color} solid />
              <Text style={styles.historyLinkText}>  Boost history</Text>
              <FontAwesome5 name="chevron-right" size={11} color={colors.textMuted} />
            </TouchableOpacity>
          }
          ListEmptyComponent={
            <EmptyState
              icon="briefcase"
              title="No shifts posted yet"
              body="Use the Shifts tab to post your first shift. It will appear here once submitted."
              accent={S.color}
              variant="card"
            />
          }
        />
      )}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
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
  historyLink: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1,
    borderColor: colors.border, paddingHorizontal: spacing.md, paddingVertical: 12,
    marginBottom: 12,
  },
  historyLinkText: { flex: 1, fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },

  boostBtn:        { borderWidth: 1.5, borderColor: '#FDE68A', backgroundColor: '#FFFBEB' },
  boostBtnText:    { fontSize: fontSize.sm, fontWeight: '700', color: colors.shifts },
});
