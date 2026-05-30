/**
 * app/local-book-confirm.tsx
 *
 * Final confirm step. Shows what you're booking, lets you add notes,
 * then creates the booking. No deposits collected yet — Phase 3 will
 * insert a Stripe PaymentIntent step before the booking row is inserted.
 *
 * Phase 2 of OneShetland Book.
 */

import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import { useAlert } from '@/components/BrandedAlert';
import { fetchBusiness, type LocalBusiness } from '@/lib/local-api';
import {
  fetchBusinessServices, createBooking,
  formatPence, formatDuration,
  type BookService,
} from '@/lib/book-api';

const S = SECTIONS.local;

export default function BookConfirmScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const { alert } = useAlert();
  const params = useLocalSearchParams<{
    businessId: string;
    serviceId:  string;
    startsAt:   string;
    endsAt:     string;
    lastMin?:   string;
  }>();

  const [business, setBusiness] = useState<LocalBusiness | null>(null);
  const [service, setService]   = useState<BookService | null>(null);
  const [notes, setNotes]       = useState('');
  const [loading, setLoading]   = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const startsAt = new Date(params.startsAt ?? '');
  const endsAt   = new Date(params.endsAt   ?? '');
  const isLastMin = params.lastMin === '1';

  useEffect(() => {
    (async () => {
      try {
        const [biz, svcs] = await Promise.all([
          fetchBusiness(params.businessId),
          fetchBusinessServices(params.businessId, false),
        ]);
        setBusiness(biz);
        setService(svcs.find(s => s.id === params.serviceId) ?? null);
      } finally {
        setLoading(false);
      }
    })();
  }, [params.businessId, params.serviceId]);

  const handleConfirm = async () => {
    if (!profile || !business || !service) return;

    setSubmitting(true);
    try {
      const depositPence = service.requires_deposit ? service.deposit_pence : 0;

      // Phase 3 will branch here: if depositPence > 0, run Stripe PaymentIntent
      // and create the booking with status 'pending_payment'. For Phase 2 we
      // just create the booking confirmed immediately.
      await createBooking({
        businessId:   business.id,
        serviceId:    service.id,
        customerId:   profile.id,
        startsAt:     startsAt.toISOString(),
        endsAt:       endsAt.toISOString(),
        pricePence:   service.price_pence,
        depositPence,
        notes:        notes.trim() || null,
        status:       'confirmed',
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      // Replace so back doesn't return to confirm
      router.replace('/local-my-bookings');
    } catch (e: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      alert({
        title: 'Couldn\'t confirm booking',
        message: e?.message ?? 'Try again in a moment.',
        icon: 'exclamation-triangle',
        accent: colors.error,
        actions: [{ label: 'OK', style: 'primary' }],
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      </SafeAreaView>
    );
  }

  if (!business || !service) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <Header onBack={() => router.back()} />
        <View style={styles.center}><Text style={styles.dim}>Couldn't load that booking.</Text></View>
      </SafeAreaView>
    );
  }

  if (!profile) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <Header onBack={() => router.back()} />
        <View style={[styles.center, { padding: spacing.xl, gap: 12 }]}>
          <Text style={styles.emptyTitle}>Sign in to confirm</Text>
          <TouchableOpacity
            style={[styles.confirmBtn, { backgroundColor: S.color }]}
            onPress={() => router.push('/(auth)/sign-in')}
          >
            <Text style={styles.confirmBtnText}>Sign in</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Header onBack={() => router.back()} />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">

          {/* Headline */}
          <View style={styles.summaryCard}>
            {isLastMin && (
              <View style={styles.lastMinBanner}>
                <FontAwesome5 name="bolt" size={11} color="#fff" solid />
                <Text style={styles.lastMinBannerText}>LAST-MIN SLOT</Text>
              </View>
            )}
            <Text style={styles.bizName}>{business.name}</Text>
            <Text style={styles.svcName}>{service.name}</Text>

            <View style={styles.bigTimeBlock}>
              <FontAwesome5 name="calendar-alt" size={14} color={S.color} solid />
              <View>
                <Text style={styles.bigDate}>
                  {startsAt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
                </Text>
                <Text style={styles.bigTime}>
                  {formatTime(startsAt)}–{formatTime(endsAt)} · {formatDuration(service.duration_minutes)}
                </Text>
              </View>
            </View>
          </View>

          {/* Price breakdown */}
          <View style={styles.card}>
            <Text style={styles.cardLabel}>What you'll pay</Text>
            <View style={styles.priceRow}>
              <Text style={styles.priceLabel}>{service.name}</Text>
              <Text style={styles.priceValue}>{formatPence(service.price_pence)}</Text>
            </View>
            {service.requires_deposit && service.deposit_pence > 0 ? (
              <>
                <View style={styles.priceDivider} />
                <View style={styles.priceRow}>
                  <Text style={[styles.priceLabel, { color: S.color }]}>Deposit at booking</Text>
                  <Text style={[styles.priceValue, { color: S.color }]}>
                    {formatPence(service.deposit_pence)}
                  </Text>
                </View>
                <Text style={styles.priceFooter}>
                  Deposit holds your booking. Remaining{' '}
                  {formatPence(Math.max(0, service.price_pence - service.deposit_pence))}{' '}
                  paid in person.
                </Text>
              </>
            ) : (
              <Text style={styles.priceFooter}>
                {service.price_pence === 0 ? 'Price confirmed in person.' : 'Pay in full at your appointment.'}
              </Text>
            )}
          </View>

          {/* Notes */}
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Anything they should know? (optional)</Text>
            <TextInput
              style={styles.notesInput}
              value={notes} onChangeText={setNotes}
              placeholder="e.g. allergy to certain products, parking gate code…"
              placeholderTextColor={colors.textLight}
              multiline
              maxLength={300}
            />
          </View>

          {/* Cancellation note */}
          <View style={styles.policyRow}>
            <FontAwesome5 name="info-circle" size={11} color={colors.textMuted} />
            <Text style={styles.policyText}>
              You can cancel from "My bookings" any time before the appointment.
              {service.requires_deposit ? ' Deposit refund per the business\'s policy.' : ''}
            </Text>
          </View>

          <View style={{ height: 100 }} />
        </ScrollView>

        {/* Sticky confirm button */}
        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.confirmBtn, { backgroundColor: S.color }, submitting && { opacity: 0.7 }]}
            onPress={handleConfirm}
            disabled={submitting}
            activeOpacity={0.85}
          >
            {submitting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <FontAwesome5 name="check" size={13} color="#fff" />
                <Text style={styles.confirmBtnText}>
                  {service.requires_deposit && service.deposit_pence > 0
                    ? `Confirm · pay £${(service.deposit_pence / 100).toFixed(2)} deposit later`
                    : 'Confirm booking'}
                </Text>
              </>
            )}
          </TouchableOpacity>
          {service.requires_deposit && service.deposit_pence > 0 && (
            <Text style={styles.footerHint}>
              Deposit payment will be wired in shortly — booking is held in the meantime.
            </Text>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ── Header ───────────────────────────────────────────────────────────────────

function Header({ onBack }: { onBack: () => void }) {
  return (
    <View style={[styles.header, { borderBottomColor: S.color }]}>
      <TouchableOpacity style={styles.backBtn} onPress={onBack} hitSlop={12}>
        <FontAwesome5 name="chevron-left" size={14} color={S.color} />
        <Text style={[styles.backText, { color: S.color }]}>Back</Text>
      </TouchableOpacity>
      <Text style={styles.headerTitle}>Confirm booking</Text>
      <View style={{ width: 70 }} />
    </View>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(d: Date): string {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.screenBackground },
  scroll: { flex: 1 },
  content:{ padding: spacing.md, gap: 12 },
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

  summaryCard: {
    backgroundColor: '#fff', borderRadius: radius.xl,
    padding: spacing.lg, gap: 8,
    borderWidth: 1, borderColor: colors.border,
    shadowColor: '#0F1C26', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.06, shadowRadius: 12, elevation: 2,
  },
  lastMinBanner: {
    alignSelf: 'flex-start',
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: '#10B981', paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full,
    marginBottom: 4,
  },
  lastMinBannerText: { color: '#fff', fontSize: 10, fontWeight: '900', letterSpacing: 0.8 },
  bizName: { fontSize: fontSize.md, fontWeight: '700', color: colors.textMuted },
  svcName: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary, letterSpacing: -0.3 },

  bigTimeBlock: {
    flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8,
    padding: 12, backgroundColor: S.light, borderRadius: radius.md,
  },
  bigDate: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  bigTime: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600', marginTop: 2 },

  card: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: spacing.md, borderWidth: 1, borderColor: colors.border, gap: 8,
  },
  cardLabel: { fontSize: 11, fontWeight: '900', color: colors.textMuted, letterSpacing: 1, textTransform: 'uppercase' },

  priceRow:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
  priceLabel:   { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary, flex: 1 },
  priceValue:   { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary },
  priceDivider: { height: 1, backgroundColor: colors.border, marginVertical: 4 },
  priceFooter:  { fontSize: 11, color: colors.textMuted, marginTop: 4, lineHeight: 16 },

  notesInput: {
    backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: fontSize.sm, color: colors.textPrimary,
    minHeight: 80, textAlignVertical: 'top',
  },

  policyRow:  { flexDirection: 'row', gap: 8, alignItems: 'flex-start', paddingHorizontal: 4 },
  policyText: { flex: 1, fontSize: 11, color: colors.textMuted, lineHeight: 16 },

  footer: {
    padding: spacing.md, gap: 6,
    backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: colors.border,
  },
  confirmBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    paddingVertical: 14, borderRadius: radius.md,
  },
  confirmBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '900' },
  footerHint:     { fontSize: 10, color: colors.textMuted, textAlign: 'center' },

  emptyTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, textAlign: 'center' },
});
