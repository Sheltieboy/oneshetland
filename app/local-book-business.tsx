/**
 * app/local-book-business.tsx
 *
 * Customer-facing booking screen for one business.
 * Flow: pick service → scroll dates → tap an open slot → goes to confirm.
 *
 * Phase 2 of OneShetland Book.
 */

import React, { useEffect, useState, useMemo, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import { useGoToSignIn } from '@/hooks/useGoToSignIn';
import { fetchBusiness, type LocalBusiness } from '@/lib/local-api';
import {
  fetchBusinessServices, fetchAvailabilityRules, fetchUpcomingOverrides,
  fetchPublicBookings, isBookableLive,
  formatPence, formatDuration,
  type BookService, type BookAvailabilityRule, type BookSlotOverride, type BookBooking,
} from '@/lib/book-api';
import {
  computeAvailableSlots, groupSlotsByDate, dateKey, formatSlotTime,
  type Slot,
} from '@/lib/book-slots';

const S = SECTIONS.local;
const WINDOW_DAYS = 14;

export default function BookBusinessScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const goToSignIn = useGoToSignIn();
  const { businessId, serviceId: paramServiceId, giftId } = useLocalSearchParams<{
    businessId: string;
    serviceId?: string;
    giftId?:    string;
  }>();

  const [business, setBusiness]   = useState<LocalBusiness | null>(null);
  const [services, setServices]   = useState<BookService[]>([]);
  const [rules, setRules]         = useState<BookAvailabilityRule[]>([]);
  const [overrides, setOverrides] = useState<BookSlotOverride[]>([]);
  const [bookings, setBookings]   = useState<BookBooking[]>([]);

  const [selectedService, setSelectedService] = useState<BookService | null>(null);
  const [selectedDateKey, setSelectedDateKey] = useState<string>(dateKey(new Date()));
  const [loading, setLoading]                 = useState(true);

  const load = useCallback(async () => {
    if (!businessId) return;
    try {
      const biz = await fetchBusiness(businessId);
      setBusiness(biz);

      // Public booking-load (non-PII) so the slot engine can show capacity
      // states. Window: 14 days from now, matching the day-strip.
      const now      = new Date();
      const windowTo = new Date(now.getTime() + WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const [svcs, rls, ovs, bks] = await Promise.all([
        fetchBusinessServices(businessId, false),
        fetchAvailabilityRules(businessId),
        fetchUpcomingOverrides(businessId),
        fetchPublicBookings(businessId, now.toISOString(), windowTo.toISOString()),
      ]);
      setServices(svcs);
      setRules(rls);
      setOverrides(ovs);
      setBookings(bks);

      // Pick initial service
      const targetId = paramServiceId ?? svcs[0]?.id;
      setSelectedService(svcs.find(s => s.id === targetId) ?? svcs[0] ?? null);
    } finally {
      setLoading(false);
    }
  }, [businessId, paramServiceId]);

  useEffect(() => { load(); }, [load]);

  // Compute slots for the 14-day window, memoised on (service + data version).
  const allSlots: Slot[] = useMemo(() => {
    if (!selectedService) return [];
    const now = new Date();
    const from = new Date(now); from.setHours(0, 0, 0, 0);
    const to   = new Date(from); to.setDate(to.getDate() + WINDOW_DAYS);
    return computeAvailableSlots({
      service: selectedService,
      rules, overrides, bookings,
      from, to, now,
    });
  }, [selectedService, rules, overrides, bookings]);

  const slotsByDate = useMemo(() => groupSlotsByDate(allSlots), [allSlots]);
  const todaySlots  = slotsByDate.get(selectedDateKey) ?? [];

  // Build the day strip — 14 days from today, with a count of OPEN (non-full)
  // slots per day so the user can scan quickly for availability.
  const dayStrip = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return Array.from({ length: WINDOW_DAYS }, (_, i) => {
      const d = new Date(today); d.setDate(today.getDate() + i);
      const k = dateKey(d);
      const slots = slotsByDate.get(k) ?? [];
      const openSlots = slots.filter(s => !s.isFull);
      return {
        key: k,
        date: d,
        count: openSlots.length,
        hasLastMin: openSlots.some(s => s.lastMin),
      };
    });
  }, [slotsByDate]);

  const handleSlotPress = (slot: Slot) => {
    if (!selectedService || !business) return;
    if (slot.isFull) return;
    if (!profile) {
      const next = `/local-book-business?businessId=${business.id}`
        + `&serviceId=${selectedService.id}`
        + (giftId ? `&giftId=${giftId}` : '');
      goToSignIn(next);
      return;
    }
    Haptics.selectionAsync();
    router.push({
      pathname: '/local-book-confirm',
      params: {
        businessId: business.id,
        serviceId:  selectedService.id,
        startsAt:   slot.start.toISOString(),
        endsAt:     slot.end.toISOString(),
        lastMin:    slot.lastMin ? '1' : '0',
        ...(giftId ? { giftId } : {}),
      },
    });
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      </SafeAreaView>
    );
  }

  if (!business) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}><Text style={styles.dim}>Business not found.</Text></View>
      </SafeAreaView>
    );
  }

  if (!isBookableLive(business) || services.length === 0) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <Header title={business.name} onBack={() => router.back()} />
        <View style={[styles.center, { padding: spacing.xl, gap: 12 }]}>
          <View style={[styles.emptyIcon, { backgroundColor: S.light }]}>
            <FontAwesome5 name="calendar-times" size={28} color={S.color} solid />
          </View>
          <Text style={styles.emptyTitle}>Not taking bookings yet</Text>
          <Text style={styles.emptySub}>
            {business.name} hasn't enabled in-app bookings. Try giving them a ring instead.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Header title={business.name} onBack={() => router.back()} />

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>

        {/* ── Service picker ── */}
        {services.length > 1 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Service</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: spacing.md }}>
              {services.map(svc => {
                const active = svc.id === selectedService?.id;
                return (
                  <TouchableOpacity
                    key={svc.id}
                    style={[styles.svcChip, active && { backgroundColor: S.color, borderColor: S.color }]}
                    onPress={() => { Haptics.selectionAsync(); setSelectedService(svc); }}
                    activeOpacity={0.85}
                  >
                    <Text style={[styles.svcChipTitle, active && { color: '#fff' }]}>{svc.name}</Text>
                    <Text style={[styles.svcChipMeta,  active && { color: 'rgba(255,255,255,0.85)' }]}>
                      {formatDuration(svc.duration_minutes)} · {formatPence(svc.price_pence)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        )}

        {selectedService && (
          <View style={styles.serviceSummary}>
            <View style={{ flex: 1 }}>
              <Text style={styles.serviceSummaryName}>{selectedService.name}</Text>
              {selectedService.description ? (
                <Text style={styles.serviceSummaryDesc} numberOfLines={2}>{selectedService.description}</Text>
              ) : null}
              <View style={styles.serviceSummaryMeta}>
                <View style={styles.metaPill}>
                  <FontAwesome5 name="clock" size={9} color={colors.textMuted} />
                  <Text style={styles.metaPillText}>{formatDuration(selectedService.duration_minutes)}</Text>
                </View>
                <View style={styles.metaPill}>
                  <FontAwesome5 name="pound-sign" size={9} color={colors.textMuted} />
                  <Text style={styles.metaPillText}>{formatPence(selectedService.price_pence)}</Text>
                </View>
                {selectedService.requires_deposit && selectedService.deposit_pence > 0 && (
                  <View style={[styles.metaPill, { backgroundColor: S.color + '20' }]}>
                    <FontAwesome5 name="lock" size={9} color={S.color} />
                    <Text style={[styles.metaPillText, { color: S.color, fontWeight: '800' }]}>
                      {formatPence(selectedService.deposit_pence)} deposit
                    </Text>
                  </View>
                )}
              </View>
              {selectedService.price_pence > 0 && (
                <TouchableOpacity
                  style={[styles.giftLink, { borderColor: S.color }]}
                  onPress={() => router.push({ pathname: '/local-gift', params: { kind: 'booking', serviceId: selectedService.id } })}
                  activeOpacity={0.85}
                >
                  <FontAwesome5 name="gift" size={10} color={S.color} solid />
                  <Text style={[styles.giftLinkText, { color: S.color }]}>Gift this to someone</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}

        {/* ── Date strip ── */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Date</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingRight: spacing.md }}>
            {dayStrip.map(d => {
              const active = d.key === selectedDateKey;
              const isEmpty = d.count === 0;
              return (
                <TouchableOpacity
                  key={d.key}
                  style={[
                    styles.dayChip,
                    active && { backgroundColor: S.color, borderColor: S.color },
                    isEmpty && !active && { opacity: 0.4 },
                  ]}
                  onPress={() => { Haptics.selectionAsync(); setSelectedDateKey(d.key); }}
                  activeOpacity={0.85}
                >
                  <Text style={[styles.dayChipWeekday, active && { color: 'rgba(255,255,255,0.75)' }]}>
                    {d.date.toLocaleDateString('en-GB', { weekday: 'short' }).toUpperCase()}
                  </Text>
                  <Text style={[styles.dayChipNum, active && { color: '#fff' }]}>
                    {d.date.getDate()}
                  </Text>
                  <Text style={[styles.dayChipCount, active && { color: 'rgba(255,255,255,0.75)' }]}>
                    {isEmpty ? '—' : `${d.count} slot${d.count === 1 ? '' : 's'}`}
                  </Text>
                  {d.hasLastMin && (
                    <View style={styles.dayChipDot} />
                  )}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>

        {/* ── Slots for selected day ── */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Available times</Text>

          {todaySlots.length === 0 ? (
            <View style={styles.noSlotsCard}>
              <FontAwesome5 name="calendar-times" size={20} color={colors.textMuted} />
              <Text style={styles.noSlotsText}>No openings on this day.</Text>
              <Text style={styles.noSlotsHint}>Try another date — last-min slots appear marked with a green dot.</Text>
            </View>
          ) : (
            <View style={styles.slotsGrid}>
              {todaySlots.map(slot => {
                const spotsLeft = slot.capacity - slot.taken;
                const showSpotsLeft = !slot.isFull && slot.capacity > 1 && slot.taken > 0;
                return (
                  <TouchableOpacity
                    key={slot.start.toISOString()}
                    style={[
                      styles.slotBtn,
                      slot.lastMin && !slot.isFull && styles.slotBtnLastMin,
                      slot.isFull && styles.slotBtnFull,
                    ]}
                    onPress={() => handleSlotPress(slot)}
                    disabled={slot.isFull}
                    activeOpacity={0.85}
                  >
                    {slot.lastMin && !slot.isFull && (
                      <View style={styles.lastMinBadge}>
                        <FontAwesome5 name="bolt" size={8} color="#fff" solid />
                        <Text style={styles.lastMinBadgeText}>LAST MIN</Text>
                      </View>
                    )}
                    <View style={styles.slotBtnTimeRow}>
                      <Text style={[
                        styles.slotBtnTime,
                        slot.lastMin && !slot.isFull && { color: '#10B981' },
                        slot.isFull && { color: colors.textLight },
                      ]}>
                        {formatSlotTime(slot.start)}
                      </Text>
                      <Text style={[
                        styles.slotBtnArrow,
                        slot.lastMin && !slot.isFull && { color: '#10B981' },
                        slot.isFull && { color: colors.textLight },
                      ]}>→</Text>
                      <Text style={[
                        styles.slotBtnEndTime,
                        slot.isFull && { color: colors.textLight },
                      ]}>
                        {formatSlotTime(slot.end)}
                      </Text>
                    </View>
                    {slot.isFull ? (
                      <Text style={styles.slotBtnFullLabel}>Full</Text>
                    ) : showSpotsLeft ? (
                      <Text style={styles.slotBtnSpotsLeft}>{spotsLeft} left</Text>
                    ) : null}
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        </View>

        {!profile && todaySlots.length > 0 && (
          <View style={styles.signInHint}>
            <FontAwesome5 name="info-circle" size={11} color={colors.textMuted} />
            <Text style={styles.signInHintText}>
              You'll need to sign in to confirm a booking.
            </Text>
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Header ───────────────────────────────────────────────────────────────────

function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <View style={[styles.header, { borderBottomColor: S.color }]}>
      <TouchableOpacity style={styles.backBtn} onPress={onBack} hitSlop={12}>
        <FontAwesome5 name="chevron-left" size={14} color={S.color} />
        <Text style={[styles.backText, { color: S.color }]}>Back</Text>
      </TouchableOpacity>
      <Text style={styles.headerTitle} numberOfLines={1}>Book · {title}</Text>
      <View style={{ width: 70 }} />
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.navy },
  scroll:  { flex: 1, backgroundColor: colors.screenBackground },
  content:{ padding: spacing.md, gap: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
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

  section:      { gap: 10 },
  sectionLabel: { fontSize: 11, fontWeight: '900', color: colors.textMuted, letterSpacing: 1, textTransform: 'uppercase' },

  // Service chips
  svcChip: {
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: radius.md,
    borderWidth: 1.5, borderColor: colors.border, backgroundColor: '#fff',
    minWidth: 130,
  },
  svcChipTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  svcChipMeta:  { fontSize: 11, color: colors.textMuted, fontWeight: '600', marginTop: 2 },

  // Service summary card
  serviceSummary: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: spacing.md, borderWidth: 1, borderColor: colors.border,
  },
  serviceSummaryName: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  serviceSummaryDesc: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 4, lineHeight: 17 },
  serviceSummaryMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  metaPill:           { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.border, paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.full },
  metaPillText:       { fontSize: 11, color: colors.textPrimary, fontWeight: '700' },

  giftLink: {
    flexDirection: 'row', alignSelf: 'flex-start', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.md, borderWidth: 1,
    marginTop: 10,
  },
  giftLinkText: { fontSize: 12, fontWeight: '800' },

  // Day chip
  dayChip: {
    width: 64, paddingVertical: 10, alignItems: 'center', gap: 2,
    borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border, backgroundColor: '#fff',
    position: 'relative',
  },
  dayChipWeekday: { fontSize: 10, fontWeight: '900', color: colors.textMuted, letterSpacing: 0.8 },
  dayChipNum:     { fontSize: 22, fontWeight: '900', color: colors.textPrimary, letterSpacing: -0.5 },
  dayChipCount:   { fontSize: 10, color: colors.textMuted, fontWeight: '700' },
  dayChipDot:     { position: 'absolute', top: 6, right: 6, width: 6, height: 6, borderRadius: 3, backgroundColor: '#10B981' },

  // Slot
  slotsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  slotBtn:   {
    // 3 per row → makes room for "09:00 → 10:30" without truncating.
    // 31.5% * 3 + 8px * 2 gaps fits inside the container's content width.
    width: '31.5%', minHeight: 62,
    backgroundColor: '#fff', borderWidth: 1.5, borderColor: colors.border,
    borderRadius: radius.md, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 10, paddingHorizontal: 4, position: 'relative',
  },
  slotBtnLastMin: { borderColor: '#10B981', backgroundColor: '#ECFDF5' },
  slotBtnFull:    { borderColor: colors.border, backgroundColor: '#F3F4F6', opacity: 0.7 },
  slotBtnTimeRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  slotBtnTime:    { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary, fontVariant: ['tabular-nums'] },
  slotBtnArrow:   { fontSize: 11, color: colors.textMuted, fontWeight: '700' },
  slotBtnEndTime: { fontSize: 12, fontWeight: '700', color: colors.textMuted, fontVariant: ['tabular-nums'] },
  slotBtnSpotsLeft: { fontSize: 10, color: colors.textMuted, fontWeight: '700', marginTop: 3 },
  slotBtnFullLabel: { fontSize: 10, color: colors.textLight, fontWeight: '800', marginTop: 3, textTransform: 'uppercase', letterSpacing: 0.5 },

  lastMinBadge: {
    position: 'absolute', top: -8, alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: '#10B981', paddingHorizontal: 5, paddingVertical: 2, borderRadius: radius.full,
  },
  lastMinBadgeText: { color: '#fff', fontSize: 8, fontWeight: '900', letterSpacing: 0.5 },

  // No-slots state
  noSlotsCard: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: spacing.xl, alignItems: 'center', gap: 8,
    borderWidth: 1, borderColor: colors.border,
  },
  noSlotsText: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  noSlotsHint: { fontSize: fontSize.xs, color: colors.textMuted, textAlign: 'center' },

  // Sign-in hint
  signInHint:    { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, backgroundColor: S.light, borderRadius: radius.md },
  signInHintText:{ fontSize: fontSize.xs, color: colors.textMuted, flex: 1 },

  // Empty (no services / not taking bookings)
  emptyIcon: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  emptyTitle:{ fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, marginTop: 4 },
  emptySub:  { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },
});
