/**
 * app/local-my-gifts.tsx
 *
 * Gifts the user has received and claimed but not yet redeemed.
 *
 * Unit gifts disappear from this list as soon as they're claimed because
 * claim_gift() spawns a book_unit_purchases row — those live in Passes.
 * Booking gifts stay here until the recipient picks a slot (which then
 * creates a book_bookings row with gift_id set).
 *
 * Each card has a clear CTA: "Pick a slot" for booking gifts.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { LoadingState } from '@/components/ui/LoadingState';
import { EmptyState } from '@/components/ui/EmptyState';
import { useAuth } from '@/context/AuthContext';
import { fetchMyGiftsReceived, type MyGiftReceived } from '@/lib/local-api';

const S = SECTIONS.local;

export default function MyGiftsScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const { screenWidth } = useAppLayout();

  const [gifts, setGifts]         = useState<MyGiftReceived[]>([]);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!profile?.id) { setLoading(false); return; }
    try {
      const rows = await fetchMyGiftsReceived(profile.id);
      setGifts(rows);
    } catch {
      setGifts([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [profile?.id]);

  useEffect(() => { load(); }, [load]);

  // Only "to claim" goes to the top; "used" goes below if any
  const toClaim = gifts.filter(g => g.status === 'claimed');
  const used    = gifts.filter(g => g.status === 'used');

  return (
    <ScreenScaffold
      header={<ScreenHeader title="Gifts received" accent={S.color} onBack={() => router.back()} />}
    >
      {loading ? (
        <LoadingState accent={S.color} />
      ) : gifts.length === 0 ? (
        <EmptyState
          icon="gift"
          title="No gifts yet"
          body="When someone sends you a gift through OneShetland, it'll appear here ready to claim."
          accent={S.color}
          variant="card"
        />
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
              tintColor={S.color}
            />
          }
        >
          {toClaim.length > 0 && (
            <>
              <Text style={styles.sectionLabel}>To claim</Text>
              {toClaim.map(g => <GiftCard key={g.id} gift={g} onPickSlot={pickSlot} />)}
            </>
          )}

          {used.length > 0 && (
            <>
              <Text style={[styles.sectionLabel, { marginTop: 12 }]}>Already used</Text>
              {used.map(g => <GiftCard key={g.id} gift={g} onPickSlot={pickSlot} />)}
            </>
          )}

          <View style={{ height: 24 }} />
        </ScrollView>
      )}
    </ScreenScaffold>
  );

  function pickSlot(g: MyGiftReceived) {
    // For booking gifts: send the recipient into the service-selection flow
    // for the gifted business. We pass gift_id along so the booking confirm
    // step can attach it (createBooking already accepts giftId).
    if (g.kind === 'booking' && g.business_id) {
      router.push({
        pathname: '/local-book-business',
        params:   { id: g.business_id, gift_id: g.id, gift_service_id: g.service_id ?? '' },
      });
    }
  }
}

function GiftCard({ gift, onPickSlot }: { gift: MyGiftReceived; onPickSlot: (g: MyGiftReceived) => void }) {
  const isBookingPending = gift.kind === 'booking' && gift.status === 'claimed';
  const title = gift.kind === 'unit'
    ? (gift.unit_item_name ?? 'Gift')
    : (gift.service_name ?? 'Booking');

  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <View style={[styles.cardIcon, { backgroundColor: S.color + '18' }]}>
          <FontAwesome5 name="gift" size={14} color={S.color} solid />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle} numberOfLines={1}>{title}</Text>
          {gift.business_name && (
            <Text style={styles.cardBiz} numberOfLines={1}>{gift.business_name}</Text>
          )}
        </View>
        {gift.status === 'used' && (
          <View style={styles.usedPill}>
            <FontAwesome5 name="check" size={9} color="#fff" solid />
            <Text style={styles.usedPillText}>Used</Text>
          </View>
        )}
      </View>

      {gift.purchaser_name && (
        <Text style={styles.from}>From <Text style={styles.fromName}>{gift.purchaser_name}</Text></Text>
      )}
      {gift.message && (
        <View style={styles.messageWrap}>
          <Text style={styles.message} numberOfLines={4}>&ldquo;{gift.message}&rdquo;</Text>
        </View>
      )}

      {isBookingPending && (
        <TouchableOpacity
          style={[styles.cta, { backgroundColor: S.color }]}
          onPress={() => onPickSlot(gift)}
          activeOpacity={0.85}
        >
          <FontAwesome5 name="calendar-plus" size={11} color="#fff" solid />
          <Text style={styles.ctaText}>Pick a slot</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  scroll:  { flex: 1, backgroundColor: colors.screenBackground },
  content:{ padding: spacing.md, gap: 12 },

  sectionLabel: { fontSize: 11, fontWeight: '900', color: colors.textMuted, letterSpacing: 1, textTransform: 'uppercase', paddingHorizontal: spacing.xs, marginBottom: -4 },

  card: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing.md, gap: 10,
  },
  cardTop:   { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cardIcon:  { width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary },
  cardBiz:   { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },

  usedPill:     { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.full, backgroundColor: '#10B981' },
  usedPillText: { fontSize: 10, color: '#fff', fontWeight: '900', letterSpacing: 0.4 },

  from:     { fontSize: fontSize.xs, color: colors.textMuted },
  fromName: { color: colors.textPrimary, fontWeight: '800' },

  messageWrap: { backgroundColor: colors.screenBackground, padding: 10, borderRadius: radius.md },
  message:     { fontSize: fontSize.sm, color: colors.textPrimary, fontStyle: 'italic', lineHeight: 20 },

  cta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 11, borderRadius: radius.md, marginTop: 4 },
  ctaText: { color: '#fff', fontWeight: '900', fontSize: fontSize.sm, letterSpacing: 0.3 },
});
