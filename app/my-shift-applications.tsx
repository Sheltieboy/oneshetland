import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { useAlert } from '@/components/BrandedAlert';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingState } from '@/components/ui/LoadingState';
import { useAuth } from '@/context/AuthContext';
import {
  fetchMyApplications, checkIn, checkOut,
  formatShiftDate, formatDuration, formatPay,
  type CheckInStatus,
} from '@/lib/shifts-api';

const S = SECTIONS.shifts;

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; icon: string }> = {
  pending:   { label: 'Pending',   color: '#D97706',        bg: '#FEF3C7',         icon: 'clock' },
  accepted:  { label: 'Confirmed', color: colors.jobs,      bg: colors.jobsLight,  icon: 'check-circle' },
  rejected:  { label: 'Declined',  color: '#DC2626',        bg: '#FEE2E2',         icon: 'times-circle' },
  withdrawn: { label: 'Withdrawn', color: colors.textMuted, bg: colors.screenBackground, icon: 'undo' },
};

type MyApplication = {
  id:                    string;
  status:                string;
  message:               string | null;
  created_at:            string;
  shift_id:              string;
  check_in_status:       CheckInStatus;
  checked_in_at:         string | null;
  checked_out_at:        string | null;
  employer_confirmed_at: string | null;
  shift: {
    id:            string;
    title:         string;
    start_at:      string;
    end_at:        string;
    location_text: string;
    pay_type:      string;
    pay_amount:    number | null;
    status:        string;
  } | null;
};

// ── Check-in status card shown on accepted applications ───────────────────────

function CheckInCard({
  app,
  onCheckIn,
  onCheckOut,
  loading,
}: {
  app: MyApplication;
  onCheckIn: () => void;
  onCheckOut: () => void;
  loading: boolean;
}) {
  const now = Date.now();
  const shiftStart = app.shift ? new Date(app.shift.start_at).getTime() : 0;
  const shiftEnd   = app.shift ? new Date(app.shift.end_at).getTime()   : 0;
  // Allow check-in up to 2 hrs before start
  const canCheckIn = shiftStart > 0 && now >= shiftStart - 2 * 3_600_000;
  const cis = app.check_in_status;

  // Shift completed — employer confirmed
  if (cis === 'employer_confirmed') {
    return (
      <View style={[styles.checkInCard, styles.checkInComplete]}>
        <View style={[styles.checkInIconWrap, { backgroundColor: colors.successLight }]}>
          <FontAwesome5 name="check-double" size={14} color={colors.success} solid />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.checkInTitle, { color: colors.successDark }]}>Shift complete</Text>
          <Text style={styles.checkInSub}>
            Confirmed by the employer
            {app.employer_confirmed_at
              ? ` · ${new Date(app.employer_confirmed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
              : ''}
          </Text>
        </View>
      </View>
    );
  }

  // Worker finished — waiting for employer
  if (cis === 'checked_out') {
    return (
      <View style={[styles.checkInCard, styles.checkInWaiting]}>
        <View style={[styles.checkInIconWrap, { backgroundColor: colors.warningLight }]}>
          <FontAwesome5 name="hourglass-half" size={13} color={colors.warning} solid />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.checkInTitle, { color: colors.warningDark }]}>Waiting for confirmation</Text>
          <Text style={styles.checkInSub}>
            You finished at{' '}
            {app.checked_out_at
              ? new Date(app.checked_out_at).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true })
              : '—'}
            {' '}· the employer will confirm shortly
          </Text>
        </View>
      </View>
    );
  }

  // Worker is on shift
  if (cis === 'checked_in') {
    return (
      <View style={{ gap: 8 }}>
        <View style={[styles.checkInCard, styles.checkInActive]}>
          <View style={[styles.checkInIconWrap, { backgroundColor: S.light }]}>
            <FontAwesome5 name="map-marker-alt" size={13} color={S.color} solid />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.checkInTitle, { color: S.color }]}>You're checked in</Text>
            <Text style={styles.checkInSub}>
              Started at{' '}
              {app.checked_in_at
                ? new Date(app.checked_in_at).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true })
                : '—'}
            </Text>
          </View>
        </View>
        <TouchableOpacity
          style={[styles.checkInBtn, styles.checkOutBtn, loading && { opacity: 0.6 }]}
          onPress={onCheckOut}
          disabled={loading}
          activeOpacity={0.85}
        >
          {loading
            ? <ActivityIndicator color="#fff" size="small" />
            : <>
                <FontAwesome5 name="flag-checkered" size={13} color="#fff" solid />
                <Text style={styles.checkInBtnText}>I've finished this shift</Text>
              </>
          }
        </TouchableOpacity>
      </View>
    );
  }

  // Not yet checked in
  if (!canCheckIn) {
    // Shift not close enough yet — show confirmed state with time info
    return (
      <View style={[styles.checkInCard, styles.checkInConfirmed]}>
        <View style={[styles.checkInIconWrap, { backgroundColor: colors.jobsLight }]}>
          <FontAwesome5 name="check-circle" size={14} color={colors.jobs} solid />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.checkInTitle, { color: colors.jobs }]}>You're confirmed!</Text>
          <Text style={styles.checkInSub}>
            Check-in opens 2 hours before your shift starts
          </Text>
        </View>
      </View>
    );
  }

  // Ready to check in
  return (
    <TouchableOpacity
      style={[styles.checkInBtn, styles.checkInStartBtn, loading && { opacity: 0.6 }]}
      onPress={onCheckIn}
      disabled={loading}
      activeOpacity={0.85}
    >
      {loading
        ? <ActivityIndicator color="#fff" size="small" />
        : <>
            <FontAwesome5 name="map-marker-alt" size={13} color="#fff" solid />
            <Text style={styles.checkInBtnText}>Check in to this shift</Text>
          </>
      }
    </TouchableOpacity>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function MyShiftApplicationsScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const { screenWidth } = useAppLayout();
  const { alert } = useAlert();

  const [applications, setApplications] = useState<MyApplication[]>([]);
  const [loading, setLoading]           = useState(true);
  const [refreshing, setRefreshing]     = useState(false);
  const [filter, setFilter]             = useState<string>('all');
  const [checkInLoading, setCheckInLoading] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile) return;
    try {
      const data = await fetchMyApplications(profile.id);
      setApplications(data as MyApplication[]);
    } catch { /* silent */ }
    finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [profile]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = () => { setRefreshing(true); load(); };

  const handleCheckIn = async (appId: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setCheckInLoading(appId);
    try {
      await checkIn(appId);
      setApplications(prev => prev.map(a =>
        a.id === appId
          ? { ...a, check_in_status: 'checked_in', checked_in_at: new Date().toISOString() }
          : a
      ));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      alert({ title: 'Error', message: e?.message ?? 'Could not check in. Try again.' });
    } finally {
      setCheckInLoading(null);
    }
  };

  const handleCheckOut = async (appId: string) => {
    alert({
      title: 'Finished your shift?',
      message: "This will notify the employer to confirm the shift is complete.",
      actions: [
        { label: 'Not yet', style: 'cancel' },
        {
          label: "Yes, I'm done",
          style: 'primary',
          onPress: async () => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            setCheckInLoading(appId);
            try {
              await checkOut(appId);
              setApplications(prev => prev.map(a =>
                a.id === appId
                  ? { ...a, check_in_status: 'checked_out', checked_out_at: new Date().toISOString() }
                  : a
              ));
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            } catch (e: any) {
              alert({ title: 'Error', message: e?.message ?? 'Could not mark as finished. Try again.' });
            } finally {
              setCheckInLoading(null);
            }
          },
        },
      ],
    });
  };

  const filtered = filter === 'all'
    ? applications
    : applications.filter(a => a.status === filter);

  const renderItem = ({ item }: { item: MyApplication }) => {
    const statusCfg = STATUS_CONFIG[item.status] ?? STATUS_CONFIG.pending;
    const shiftGone = !item.shift || item.shift.status !== 'open';
    const isAccepted = item.status === 'accepted';

    return (
      <TouchableOpacity
        style={styles.card}
        onPress={() => {
          if (!item.shift) return;
          Haptics.selectionAsync();
          router.push({ pathname: '/shift-detail', params: { id: item.shift_id } });
        }}
        activeOpacity={item.shift ? 0.75 : 1}
      >
        {/* Status badge */}
        <View style={styles.cardTop}>
          <View style={[styles.statusBadge, { backgroundColor: statusCfg.bg }]}>
            <FontAwesome5 name={statusCfg.icon as any} size={10} color={statusCfg.color} solid />
            <Text style={[styles.statusBadgeText, { color: statusCfg.color }]}>{statusCfg.label}</Text>
          </View>
          {shiftGone && item.shift && (
            <View style={styles.shiftClosedBadge}>
              <Text style={styles.shiftClosedText}>Shift closed</Text>
            </View>
          )}
          <Text style={styles.appliedDate}>
            Applied {new Date(item.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
          </Text>
        </View>

        {/* Shift info */}
        {item.shift ? (
          <>
            <Text style={styles.shiftTitle} numberOfLines={2}>{item.shift.title}</Text>
            <View style={styles.metaRow}>
              <View style={styles.metaItem}>
                <FontAwesome5 name="clock" size={10} color={colors.textMuted} />
                <Text style={styles.metaText}>{formatShiftDate(item.shift.start_at)}</Text>
              </View>
              <View style={styles.metaItem}>
                <FontAwesome5 name="hourglass-half" size={10} color={colors.textMuted} />
                <Text style={styles.metaText}>{formatDuration(item.shift.start_at, item.shift.end_at)}</Text>
              </View>
            </View>
            <View style={styles.metaRow}>
              <View style={styles.metaItem}>
                <FontAwesome5 name="map-marker-alt" size={10} color={colors.textMuted} />
                <Text style={styles.metaText} numberOfLines={1}>{item.shift.location_text}</Text>
              </View>
            </View>
            <View style={styles.cardFooter}>
              <Text style={[styles.payText, { color: S.color }]}>
                {formatPay(item.shift.pay_type as any, item.shift.pay_amount)}
              </Text>
              {item.shift.status === 'open' && (
                <Text style={styles.viewLink}>View shift →</Text>
              )}
            </View>
          </>
        ) : (
          <Text style={styles.shiftGone}>This shift is no longer available.</Text>
        )}

        {/* Their message */}
        {item.message ? (
          <View style={styles.messageRow}>
            <FontAwesome5 name="comment-alt" size={10} color={colors.textMuted} />
            <Text style={styles.messageText} numberOfLines={2}>"{item.message}"</Text>
          </View>
        ) : null}

        {/* Check-in card — only for accepted, non-cancelled/rejected shifts */}
        {isAccepted && item.shift && item.shift.status !== 'cancelled' ? (
          <CheckInCard
            app={item}
            onCheckIn={() => handleCheckIn(item.id)}
            onCheckOut={() => handleCheckOut(item.id)}
            loading={checkInLoading === item.id}
          />
        ) : null}
      </TouchableOpacity>
    );
  };

  const FILTERS = [
    { id: 'all',       label: 'All' },
    { id: 'pending',   label: 'Pending' },
    { id: 'accepted',  label: 'Confirmed' },
    { id: 'rejected',  label: 'Declined' },
    { id: 'withdrawn', label: 'Withdrawn' },
  ];

  return (
    <ScreenScaffold
      header={
        <ScreenHeader
          title="My applications"
          accent={S.color}
          onBack={() => router.back()}
        />
      }
    >
      {loading ? (
        <LoadingState accent={S.color} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={item => item.id}
          renderItem={renderItem}
          ListHeaderComponent={
            <View style={styles.filterBar}>
              {FILTERS.map(f => {
                const count = f.id === 'all' ? applications.length : applications.filter(a => a.status === f.id).length;
                if (f.id !== 'all' && count === 0) return null;
                const active = filter === f.id;
                return (
                  <TouchableOpacity
                    key={f.id}
                    style={[styles.filterChip, active && { backgroundColor: S.color, borderColor: S.color }]}
                    onPress={() => { Haptics.selectionAsync(); setFilter(f.id); }}
                    activeOpacity={0.75}
                  >
                    <Text style={[styles.filterChipText, active && { color: '#fff' }]}>
                      {f.label}{count > 0 ? ` (${count})` : ''}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          }
          contentContainerStyle={[styles.list, filtered.length === 0 && { flex: 1 }, contentContainer(screenWidth)]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={S.color} />}
          ListEmptyComponent={
            <EmptyState
              icon="paper-plane"
              title={filter === 'all' ? 'No applications yet' : `No ${filter} applications`}
              body={filter === 'all'
                ? "When you submit interest in a shift, it'll appear here."
                : 'Try a different filter above.'}
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
  filterBar: {
    flexDirection: 'row', flexWrap: 'wrap',
    gap: 8, padding: spacing.md, paddingBottom: 4,
  },
  filterChip: {
    paddingHorizontal: 12, paddingVertical: 6,
    backgroundColor: '#fff', borderRadius: radius.full,
    borderWidth: 1.5, borderColor: colors.border,
  },
  filterChipText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textMuted },

  list: { padding: spacing.md, paddingTop: 4, gap: 12, paddingBottom: 60 },

  card: {
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: 8,
    shadowColor: '#0F1C26',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.full,
  },
  statusBadgeText:  { fontSize: 10, fontWeight: '800' },
  shiftClosedBadge: { backgroundColor: colors.screenBackground, paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.full },
  shiftClosedText:  { fontSize: 10, color: colors.textMuted, fontWeight: '600' },
  appliedDate:      { marginLeft: 'auto' as any, fontSize: fontSize.xs, color: colors.textMuted },

  shiftTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, lineHeight: 22 },
  shiftGone:  { fontSize: fontSize.sm, color: colors.textMuted, fontStyle: 'italic' },
  metaRow:    { flexDirection: 'row', gap: 16, flexWrap: 'wrap' },
  metaItem:   { flexDirection: 'row', alignItems: 'center', gap: 5 },
  metaText:   { fontSize: fontSize.xs, color: colors.textMuted },

  cardFooter: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border,
  },
  payText:  { fontSize: fontSize.sm, fontWeight: '800' },
  viewLink: { fontSize: fontSize.xs, fontWeight: '800', color: S.color },

  messageRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 7 },
  messageText: { flex: 1, fontSize: fontSize.xs, color: colors.textMuted, fontStyle: 'italic', lineHeight: 16 },

  // ── Check-in card styles ───────────────────────────────────────────────────
  checkInCard: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 12, borderRadius: radius.md, borderWidth: 1,
    marginTop: 4,
  },
  checkInConfirmed: { borderColor: colors.jobsLight,   backgroundColor: colors.jobsLight },
  checkInActive:    { borderColor: S.light,             backgroundColor: S.light },
  checkInWaiting:   { borderColor: colors.warningLight, backgroundColor: colors.warningLight },
  checkInComplete:  { borderColor: colors.successLight, backgroundColor: colors.successLight },

  checkInIconWrap: {
    width: 34, height: 34, borderRadius: radius.sm,
    alignItems: 'center', justifyContent: 'center',
  },
  checkInTitle: { fontSize: fontSize.sm, fontWeight: '800', lineHeight: 18 },
  checkInSub:   { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1, lineHeight: 16 },

  checkInBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, height: 46, borderRadius: radius.md, marginTop: 4,
  },
  checkInStartBtn: { backgroundColor: S.color },
  checkOutBtn:     { backgroundColor: colors.jobs },
  checkInBtnText:  { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
});
