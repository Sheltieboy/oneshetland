/**
 * app/local-book-bookings.tsx
 *
 * Owner-side bookings dashboard.
 * Tabs: Today / Upcoming / Past.
 * Per-booking actions: mark complete, mark no-show, cancel, call customer (if we
 * had their phone — Phase 4).
 *
 * Phase 2 of OneShetland Book (owner-side).
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import { useAlert } from '@/components/BrandedAlert';
import {
  fetchBusinessBookings, updateBookingStatus, cancelBooking,
  formatPence, formatDuration,
  type BookBooking, type BookingStatus,
} from '@/lib/book-api';

const S = SECTIONS.local;

type Tab = 'today' | 'upcoming' | 'past';

export default function BookBookingsScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const { alert } = useAlert();
  const { businessId } = useLocalSearchParams<{ businessId: string }>();

  const [bookings, setBookings] = useState<BookBooking[]>([]);
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<Tab>('today');

  const load = useCallback(async () => {
    if (!businessId) return;
    try {
      // Fetch a wide window: 30 days back to catch past, plus all future
      const from = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const rows = await fetchBusinessBookings(businessId, from);
      setBookings(rows);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [businessId]);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Partition into Today / Upcoming / Past
  const { today, upcoming, past } = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
    const endOfToday   = new Date(startOfToday); endOfToday.setDate(endOfToday.getDate() + 1);

    const t: BookBooking[] = [];
    const u: BookBooking[] = [];
    const p: BookBooking[] = [];
    for (const b of bookings) {
      const start = new Date(b.starts_at);
      if (b.status === 'cancelled' || b.status === 'completed' || b.status === 'no_show') {
        p.push(b);
      } else if (start >= startOfToday && start < endOfToday) {
        t.push(b);
      } else if (start >= endOfToday) {
        u.push(b);
      } else {
        p.push(b);
      }
    }
    t.sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
    u.sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
    p.sort((a, b) => new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime());
    return { today: t, upcoming: u, past: p };
  }, [bookings]);

  const list = tab === 'today' ? today : tab === 'upcoming' ? upcoming : past;

  const errorAlert = (msg: string) => alert({
    title:   'Failed',
    message: msg,
    icon:    'exclamation-triangle',
    accent:  colors.error,
    actions: [{ label: 'OK', style: 'primary' }],
  });

  const handleComplete = (b: BookBooking) => {
    alert({
      title:   'Mark complete?',
      message: `${b.service?.name ?? 'Booking'} — confirms the customer attended.`,
      icon:    'check-circle',
      accent:  '#10B981',
      actions: [
        { label: 'Cancel',        style: 'cancel' },
        { label: 'Mark complete', style: 'primary', onPress: async () => {
          try {
            await updateBookingStatus(b.id, 'completed');
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            load();
          } catch (e: any) { errorAlert(e?.message ?? 'Try again.'); }
        }},
      ],
    });
  };

  const handleNoShow = (b: BookBooking) => {
    alert({
      title:   'Mark as no-show?',
      message: `${b.service?.name ?? 'Booking'} — customer didn't turn up.`,
      icon:    'user-times',
      accent:  colors.shifts,
      actions: [
        { label: 'Cancel',   style: 'cancel' },
        { label: 'No-show',  style: 'destructive', onPress: async () => {
          try {
            await updateBookingStatus(b.id, 'no_show');
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            load();
          } catch (e: any) { errorAlert(e?.message ?? 'Try again.'); }
        }},
      ],
    });
  };

  const handleCancel = (b: BookBooking) => {
    if (!profile) return;
    alert({
      title:   'Cancel this booking?',
      message: `${b.service?.name ?? 'Booking'} for ${b.customer?.full_name ?? 'customer'}. They'll be notified.`,
      icon:    'calendar-times',
      accent:  colors.error,
      actions: [
        { label: 'Keep',           style: 'cancel' },
        { label: 'Cancel booking', style: 'destructive', onPress: async () => {
          try {
            await cancelBooking(b.id, profile.id);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            load();
          } catch (e: any) { errorAlert(e?.message ?? 'Try again.'); }
        }},
      ],
    });
  };

  if (!businessId) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}><Text style={styles.dim}>Missing business ID.</Text></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Bookings</Text>
        <View style={{ width: 70 }} />
      </View>

      {/* Tabs */}
      <View style={styles.tabs}>
        {([
          { id: 'today',    label: 'Today',    count: today.length    },
          { id: 'upcoming', label: 'Upcoming', count: upcoming.length },
          { id: 'past',     label: 'Past',     count: past.length     },
        ] as { id: Tab; label: string; count: number }[]).map(t => {
          const active = tab === t.id;
          return (
            <TouchableOpacity
              key={t.id}
              style={[styles.tabBtn, active && { borderBottomColor: S.color }]}
              onPress={() => { Haptics.selectionAsync(); setTab(t.id); }}
              activeOpacity={0.85}
            >
              <Text style={[styles.tabText, active && { color: S.color }]}>
                {t.label} {t.count > 0 ? `(${t.count})` : ''}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={S.color} />}
        >
          {list.length === 0 ? (
            <View style={styles.empty}>
              <View style={[styles.emptyIcon, { backgroundColor: S.light }]}>
                <FontAwesome5
                  name={tab === 'today' ? 'calendar-day' : tab === 'upcoming' ? 'calendar-alt' : 'history'}
                  size={28} color={S.color} solid
                />
              </View>
              <Text style={styles.emptyTitle}>
                {tab === 'today'    ? 'No bookings today' :
                 tab === 'upcoming' ? 'Nothing booked yet' :
                                      'No past bookings yet'}
              </Text>
              <Text style={styles.emptySub}>
                {tab === 'upcoming'
                  ? 'When customers book, they\'ll appear here.'
                  : tab === 'today'
                    ? 'A free day — or your schedule isn\'t open today.'
                    : 'Completed, cancelled and no-show bookings live here.'}
              </Text>
            </View>
          ) : (
            list.map(b => (
              <BookingRow
                key={b.id}
                booking={b}
                tab={tab}
                onComplete={() => handleComplete(b)}
                onNoShow={() => handleNoShow(b)}
                onCancel={() => handleCancel(b)}
              />
            ))
          )}
          <View style={{ height: 40 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ── Booking row ──────────────────────────────────────────────────────────────

function BookingRow({
  booking, tab, onComplete, onNoShow, onCancel,
}: {
  booking: BookBooking;
  tab: Tab;
  onComplete: () => void;
  onNoShow: () => void;
  onCancel: () => void;
}) {
  const start = new Date(booking.starts_at);
  const end   = new Date(booking.ends_at);
  const isDone = booking.status === 'completed' || booking.status === 'cancelled' || booking.status === 'no_show';
  const isPast = tab === 'past';
  const startedAgo = Date.now() > end.getTime();

  return (
    <View style={[styles.card, isDone && { opacity: 0.65 }]}>
      <View style={styles.cardHeader}>
        {/* Time block on the left */}
        <View style={[styles.timeBlock, { backgroundColor: S.color }]}>
          <Text style={styles.timeBig}>{formatTime(start)}</Text>
          <Text style={styles.timeSmall}>{formatDuration(booking.service?.duration_minutes ?? 30)}</Text>
        </View>

        <View style={{ flex: 1 }}>
          <Text style={styles.svcName}>{booking.service?.name ?? 'Service'}</Text>
          <Text style={styles.custName}>
            <FontAwesome5 name="user" size={9} color={colors.textMuted} />{'  '}
            {booking.customer?.full_name ?? 'Customer'}
          </Text>
          {tab !== 'today' && (
            <Text style={styles.dateLine}>
              {start.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
              {'  ·  '}
              {formatTime(start)}–{formatTime(end)}
            </Text>
          )}
        </View>

        <StatusBadge status={booking.status} />
      </View>

      {booking.notes ? (
        <View style={styles.notesBox}>
          <Text style={styles.notesLabel}>Customer note</Text>
          <Text style={styles.notesText}>{booking.notes}</Text>
        </View>
      ) : null}

      <View style={styles.metaRow}>
        {booking.price_pence > 0 && (
          <Text style={styles.metaItem}>
            <FontAwesome5 name="pound-sign" size={9} color={colors.textMuted} />
            {'  '}{formatPence(booking.price_pence)}
          </Text>
        )}
        {booking.deposit_pence > 0 && (
          <Text style={[styles.metaItem, { color: S.color, fontWeight: '800' }]}>
            <FontAwesome5 name="lock" size={9} color={S.color} />
            {'  '}{formatPence(booking.deposit_pence)} deposit
          </Text>
        )}
      </View>

      {/* Actions — none for done bookings, different sets for today vs upcoming */}
      {!isDone && (
        <View style={styles.actionRow}>
          {(tab === 'today' || startedAgo) && (
            <>
              <TouchableOpacity
                style={[styles.actionBtn, { borderColor: '#10B981' }]}
                onPress={onComplete} activeOpacity={0.85}
              >
                <FontAwesome5 name="check" size={11} color="#10B981" />
                <Text style={[styles.actionText, { color: '#10B981' }]}>Complete</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionBtn, { borderColor: colors.shifts }]}
                onPress={onNoShow} activeOpacity={0.85}
              >
                <FontAwesome5 name="user-times" size={11} color={colors.shifts} />
                <Text style={[styles.actionText, { color: colors.shifts }]}>No-show</Text>
              </TouchableOpacity>
            </>
          )}
          {tab === 'upcoming' && !startedAgo && (
            <TouchableOpacity
              style={[styles.actionBtn, { borderColor: colors.error }]}
              onPress={onCancel} activeOpacity={0.85}
            >
              <FontAwesome5 name="times" size={11} color={colors.error} />
              <Text style={[styles.actionText, { color: colors.error }]}>Cancel</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
}

function StatusBadge({ status }: { status: BookingStatus }) {
  const { label, color } = STATUS_INFO[status];
  return (
    <View style={[styles.badge, { backgroundColor: color + '22' }]}>
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

const STATUS_INFO: Record<BookingStatus, { label: string; color: string }> = {
  pending_payment: { label: 'Awaiting pay', color: '#F59E0B' },
  confirmed:       { label: 'Confirmed',    color: '#10B981' },
  cancelled:       { label: 'Cancelled',    color: colors.textMuted },
  no_show:         { label: 'No-show',      color: colors.error },
  completed:       { label: 'Completed',    color: colors.textMuted },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(d: Date): string {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.navy },
  scroll:  { flex: 1, backgroundColor: colors.screenBackground },
  content:{ padding: spacing.md, gap: 10 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  dim:    { color: colors.textMuted },

  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
    borderBottomWidth: 2,
  },
  backBtn:     { flexDirection: 'row', alignItems: 'center', gap: 8, width: 70 },
  backText:    { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '800', flex: 1, textAlign: 'center' },

  tabs:    { flexDirection: 'row', backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: colors.border },
  tabBtn:  { flex: 1, alignItems: 'center', paddingVertical: 12, borderBottomWidth: 3, borderBottomColor: 'transparent' },
  tabText: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textMuted },

  empty:     { alignItems: 'center', gap: 10, paddingVertical: 50 },
  emptyIcon: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  emptyTitle:{ fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, marginTop: 4 },
  emptySub:  { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', paddingHorizontal: spacing.xl },

  // Booking card
  card: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: spacing.md, gap: 10,
    borderWidth: 1, borderColor: colors.border,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },

  timeBlock: { width: 64, paddingVertical: 8, alignItems: 'center', borderRadius: radius.md, gap: 1 },
  timeBig:   { color: '#fff', fontSize: 18, fontWeight: '900', letterSpacing: -0.5, fontVariant: ['tabular-nums'] },
  timeSmall: { color: 'rgba(255,255,255,0.75)', fontSize: 10, fontWeight: '700' },

  svcName:  { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary, letterSpacing: -0.3 },
  custName: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 3, fontWeight: '600' },
  dateLine: { fontSize: 11, color: colors.textMuted, marginTop: 3, fontWeight: '600' },

  badge:     { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full },
  badgeText: { fontSize: 10, fontWeight: '900', letterSpacing: 0.5, textTransform: 'uppercase' },

  notesBox:   { padding: 10, backgroundColor: S.light, borderRadius: radius.md, gap: 2 },
  notesLabel: { fontSize: 10, fontWeight: '900', color: colors.textMuted, letterSpacing: 1, textTransform: 'uppercase' },
  notesText:  { fontSize: fontSize.xs, color: colors.textPrimary, fontStyle: 'italic' },

  metaRow:  { flexDirection: 'row', gap: 14, flexWrap: 'wrap' },
  metaItem: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '700' },

  actionRow: { flexDirection: 'row', gap: 8, paddingTop: 4 },
  actionBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 10, borderWidth: 1.5, borderRadius: radius.md, backgroundColor: '#fff',
  },
  actionText:{ fontSize: fontSize.xs, fontWeight: '800' },
});
