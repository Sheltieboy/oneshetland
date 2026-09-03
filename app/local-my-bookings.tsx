/**
 * app/local-my-bookings.tsx
 *
 * Customer-facing list of their bookings — upcoming + past, with cancel.
 * Phase 2 of OneShetland Book.
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert, RefreshControl, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import { useGoToSignIn } from '@/hooks/useGoToSignIn';
import { useAlert } from '@/components/BrandedAlert';
import {
  fetchMyBookings, cancelBooking,
  formatPence, formatDuration,
  type BookBooking,
} from '@/lib/book-api';
import { SHETLAND_TZ } from '@/lib/shetland-time';

const S = SECTIONS.local;

type Tab = 'upcoming' | 'past';

export default function MyBookingsScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const { alert } = useAlert();
  const goToSignIn = useGoToSignIn();

  const [bookings, setBookings] = useState<BookBooking[]>([]);
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<Tab>('upcoming');

  const load = useCallback(async () => {
    if (!profile) {
      setLoading(false);
      return;
    }
    try {
      const rows = await fetchMyBookings(profile.id);
      setBookings(rows);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [profile?.id]);

  useEffect(() => { load(); }, [load]);

  // Refresh when screen regains focus (e.g. after creating a booking)
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const { upcoming, past } = useMemo(() => {
    const now = Date.now();
    const u: BookBooking[] = [];
    const p: BookBooking[] = [];
    for (const b of bookings) {
      const startMs = new Date(b.starts_at).getTime();
      // Terminal is terminal, whatever the calendar says. A booking the
      // business has already closed off — cancelled, completed or a no-show —
      // is not something the customer is still waiting for, and calling a
      // future completed booking "upcoming" contradicted the owner's own
      // screen. Same three states the owner has always used.
      const closed = b.status === 'cancelled' || b.status === 'completed' || b.status === 'no_show';
      const isUpcoming = !closed && startMs >= now;
      (isUpcoming ? u : p).push(b);
    }
    // Upcoming: ascending (nearest first). Past: descending (most recent first).
    u.sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
    p.sort((a, b) => new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime());
    return { upcoming: u, past: p };
  }, [bookings]);

  const list = tab === 'upcoming' ? upcoming : past;

  const handleCancel = (booking: BookBooking) => {
    alert({
      title: 'Cancel this booking?',
      message: `${booking.service?.name ?? 'Booking'} at ${booking.business?.name ?? 'this business'} on ${formatDate(booking.starts_at)}.`,
      icon: 'calendar-times',
      accent: colors.error,
      actions: [
        { label: 'Keep booking',   style: 'cancel' },
        { label: 'Cancel booking', style: 'destructive', onPress: async () => {
          if (!profile) return;
          try {
            await cancelBooking(booking.id, profile.id);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            load();
          } catch (e: any) {
            alert({
              title: 'Couldn\'t cancel',
              message: e?.message ?? 'Try again.',
              icon: 'exclamation-triangle',
              accent: colors.error,
              actions: [{ label: 'OK', style: 'primary' }],
            });
          }
        }},
      ],
    });
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <Header onBack={() => router.back()} />
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      </SafeAreaView>
    );
  }

  if (!profile) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <Header onBack={() => router.back()} />
        <View style={[styles.center, { padding: spacing.xl, gap: 12 }]}>
          <View style={[styles.emptyIcon, { backgroundColor: S.light }]}>
            <FontAwesome5 name="user-circle" size={28} color={S.color} solid />
          </View>
          <Text style={styles.emptyTitle}>Sign in to see your bookings</Text>
          <TouchableOpacity
            style={[styles.primaryBtn, { backgroundColor: S.color }]}
            onPress={() => goToSignIn()}
          >
            <Text style={styles.primaryBtnText}>Sign in</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Header onBack={() => router.back()} />

      {/* Tabs */}
      <View style={styles.tabs}>
        {(['upcoming', 'past'] as const).map(t => {
          const active = tab === t;
          const count = t === 'upcoming' ? upcoming.length : past.length;
          return (
            <TouchableOpacity
              key={t}
              style={[styles.tabBtn, active && { borderBottomColor: S.color }]}
              onPress={() => { Haptics.selectionAsync(); setTab(t); }}
              activeOpacity={0.85}
            >
              <Text style={[styles.tabText, active && { color: S.color }]}>
                {t === 'upcoming' ? 'Upcoming' : 'Past'} {count > 0 ? `(${count})` : ''}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={S.color} />}
      >

        {list.length === 0 ? (
          <View style={styles.empty}>
            <View style={[styles.emptyIcon, { backgroundColor: S.light }]}>
              <FontAwesome5
                name={tab === 'upcoming' ? 'calendar-alt' : 'history'}
                size={28} color={S.color} solid
              />
            </View>
            <Text style={styles.emptyTitle}>
              {tab === 'upcoming' ? 'No upcoming bookings' : 'No past bookings yet'}
            </Text>
            <Text style={styles.emptySub}>
              {tab === 'upcoming'
                ? 'Browse Shetland businesses to find one that takes bookings.'
                : 'Bookings you\'ve completed or cancelled will show here.'}
            </Text>
            {tab === 'upcoming' && (
              <TouchableOpacity
                style={[styles.primaryBtn, { backgroundColor: S.color }]}
                onPress={() => router.push('/local-businesses-browse')}
                activeOpacity={0.85}
              >
                <FontAwesome5 name="search" size={11} color="#fff" />
                <Text style={styles.primaryBtnText}>Browse businesses</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          list.map(b => (
            <BookingCard
              key={b.id}
              booking={b}
              isPast={tab === 'past'}
              onCancel={() => handleCancel(b)}
              onOpenBusiness={() =>
                router.push({ pathname: '/local-business-detail', params: { id: b.business?.id ?? b.business_id } })
              }
              onCall={() => b.business?.phone && Linking.openURL(`tel:${b.business.phone}`)}
            />
          ))
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Booking card ─────────────────────────────────────────────────────────────

function BookingCard({
  booking, isPast, onCancel, onOpenBusiness, onCall,
}: {
  booking: BookBooking;
  isPast: boolean;
  onCancel: () => void;
  onOpenBusiness: () => void;
  onCall: () => void;
}) {
  const starts = new Date(booking.starts_at);
  const ends   = new Date(booking.ends_at);
  const cancelled = booking.status === 'cancelled';
  const completed = booking.status === 'completed';
  const noShow    = booking.status === 'no_show';

  return (
    <View style={[styles.card, cancelled && { opacity: 0.55 }]}>
      <TouchableOpacity onPress={onOpenBusiness} activeOpacity={0.85}>
        <View style={styles.cardTop}>
          <View style={[styles.cardIcon, { backgroundColor: S.color + '20' }]}>
            <FontAwesome5 name="calendar-check" size={13} color={S.color} solid />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardBiz}>{booking.business?.name ?? 'Booking'}</Text>
            <Text style={styles.cardSvc}>{booking.service?.name ?? 'Service'}</Text>
          </View>
          <StatusBadge status={booking.status} />
        </View>

        <View style={styles.cardWhen}>
          <View style={styles.cardWhenItem}>
            <FontAwesome5 name="calendar-alt" size={10} color={colors.textMuted} />
            <Text style={styles.cardWhenText}>{formatDate(booking.starts_at)}</Text>
          </View>
          <View style={styles.cardWhenItem}>
            <FontAwesome5 name="clock" size={10} color={colors.textMuted} />
            <Text style={styles.cardWhenText}>
              {formatTime(starts)}–{formatTime(ends)}
              {booking.service?.duration_minutes ? ` · ${formatDuration(booking.service.duration_minutes)}` : ''}
            </Text>
          </View>
          {booking.price_pence > 0 && (
            <View style={styles.cardWhenItem}>
              <FontAwesome5 name="pound-sign" size={10} color={colors.textMuted} />
              <Text style={styles.cardWhenText}>{formatPence(booking.price_pence)}</Text>
            </View>
          )}
        </View>

        {booking.notes ? (
          <View style={styles.notesBox}>
            <Text style={styles.notesLabel}>Your note</Text>
            <Text style={styles.notesText}>{booking.notes}</Text>
          </View>
        ) : null}
      </TouchableOpacity>

      {!isPast && !cancelled && (
        <View style={styles.actionRow}>
          {booking.business?.phone && (
            <TouchableOpacity style={styles.secondaryBtn} onPress={onCall} activeOpacity={0.85}>
              <FontAwesome5 name="phone" size={11} color={S.color} />
              <Text style={[styles.secondaryBtnText, { color: S.color }]}>Call</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={[styles.secondaryBtn, { borderColor: colors.error }]} onPress={onCancel} activeOpacity={0.85}>
            <FontAwesome5 name="times" size={11} color={colors.error} />
            <Text style={[styles.secondaryBtnText, { color: colors.error }]}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

function StatusBadge({ status }: { status: BookBooking['status'] }) {
  const label = STATUS_LABEL[status];
  const color = STATUS_COLOR[status];
  return (
    <View style={[styles.badge, { backgroundColor: color + '22' }]}>
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

const STATUS_LABEL: Record<BookBooking['status'], string> = {
  pending_payment: 'Awaiting payment',
  confirmed:       'Confirmed',
  cancelled:       'Cancelled',
  no_show:         'No-show',
  completed:       'Completed',
};
const STATUS_COLOR: Record<BookBooking['status'], string> = {
  pending_payment: '#F59E0B',
  confirmed:       '#10B981',
  cancelled:       colors.textMuted,
  no_show:         colors.error,
  completed:       colors.textMuted,
};

// ── Header ───────────────────────────────────────────────────────────────────

function Header({ onBack }: { onBack: () => void }) {
  return (
    <View style={[styles.header, { borderBottomColor: S.color }]}>
      <TouchableOpacity style={styles.backBtn} onPress={onBack} hitSlop={12}>
        <FontAwesome5 name="chevron-left" size={14} color={S.color} />
        <Text style={[styles.backText, { color: S.color }]}>Back</Text>
      </TouchableOpacity>
      <Text style={styles.headerTitle}>My bookings</Text>
      <View style={{ width: 70 }} />
    </View>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: SHETLAND_TZ });
}
function formatTime(d: Date): string {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: SHETLAND_TZ });
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.navy },
  scroll:  { flex: 1, backgroundColor: colors.screenBackground },
  content:{ padding: spacing.md, gap: 10 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

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

  empty:     { alignItems: 'center', gap: 12, paddingVertical: 60 },
  emptyIcon: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  emptyTitle:{ fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, marginTop: 4 },
  emptySub:  { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', paddingHorizontal: spacing.xl },

  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 12, paddingHorizontal: 18, borderRadius: radius.md, marginTop: 4,
  },
  primaryBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },

  card: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: spacing.md, gap: 10,
    borderWidth: 1, borderColor: colors.border,
  },
  cardTop:  { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardIcon: { width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  cardBiz:  { fontSize: fontSize.sm, color: colors.textMuted, fontWeight: '700' },
  cardSvc:  { fontSize: fontSize.md, color: colors.textPrimary, fontWeight: '900', marginTop: 1 },

  cardWhen:     { flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border },
  cardWhenItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  cardWhenText: { fontSize: fontSize.xs, color: colors.textPrimary, fontWeight: '700' },

  notesBox:   { padding: 10, backgroundColor: S.light, borderRadius: radius.md, gap: 2 },
  notesLabel: { fontSize: 10, fontWeight: '900', color: colors.textMuted, letterSpacing: 1, textTransform: 'uppercase' },
  notesText:  { fontSize: fontSize.xs, color: colors.textPrimary, fontStyle: 'italic' },

  badge:     { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full },
  badgeText: { fontSize: 10, fontWeight: '900', letterSpacing: 0.5, textTransform: 'uppercase' },

  actionRow:    { flexDirection: 'row', gap: 8, paddingTop: 4 },
  secondaryBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 10, borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.md, backgroundColor: '#fff',
  },
  secondaryBtnText: { fontSize: fontSize.xs, fontWeight: '800' },
});
