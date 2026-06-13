/**
 * local-offers.tsx — global feed of active offers
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingState } from '@/components/ui/LoadingState';
import { useAuth } from '@/context/AuthContext';
import {
  fetchActiveOffers, fetchMyRedeemedOfferIds,
  formatOfferDiscount, daysRemaining,
  type LocalOffer,
} from '@/lib/local-api';
import { isBookableLive } from '@/lib/book-api';

const S = SECTIONS.local;

export default function OffersScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const { screenWidth } = useAppLayout();
  const [offers, setOffers]     = useState<LocalOffer[]>([]);
  const [redeemed, setRedeemed] = useState<Set<string>>(new Set());
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [o, ids] = await Promise.all([
        fetchActiveOffers(),
        profile ? fetchMyRedeemedOfferIds(profile.id) : Promise.resolve([] as string[]),
      ]);
      setOffers(o);
      setRedeemed(new Set(ids));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [profile?.id]);

  useEffect(() => { load(); }, [load]);

  return (
    <ScreenScaffold
      header={
        <ScreenHeader
          title="Offers"
          subtitle={`${offers.length} active`}
          accent={S.color}
          onBack={() => router.back()}
        />
      }
    >
      {loading ? (
        <LoadingState accent={S.color} />
      ) : (
        <FlatList
          data={offers}
          keyExtractor={o => o.id}
          renderItem={({ item }) => <OfferRow offer={item} claimed={redeemed.has(item.id)} />}
          contentContainerStyle={[styles.listContent, contentContainer(screenWidth)]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={S.color} />}
          ListEmptyComponent={
            <EmptyState
              icon="tags"
              title="No offers right now"
              body="Follow local businesses to be alerted when they post deals."
              accent={S.color}
              variant="card"
            />
          }
        />
      )}
    </ScreenScaffold>
  );
}

function OfferRow({ offer, claimed }: { offer: LocalOffer; claimed: boolean }) {
  const router = useRouter();
  const days = daysRemaining(offer.valid_until);

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={() => {
        // Bookable business → straight to the booking screen; otherwise the profile
        if (offer.business && isBookableLive(offer.business)) {
          router.push({ pathname: '/local-book-business', params: { businessId: offer.business_id } });
        } else {
          router.push({ pathname: '/local-business-detail', params: { id: offer.business_id } });
        }
      }}
      activeOpacity={0.85}
    >
      <View style={[styles.discount, { backgroundColor: S.color }]}>
        <Text style={styles.discountText}>{formatOfferDiscount(offer)}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.title} numberOfLines={1}>{offer.title}</Text>
        {offer.business && (
          <Text style={styles.business}>{offer.business.name}</Text>
        )}
        {offer.description && (
          <Text style={styles.desc} numberOfLines={2}>{offer.description}</Text>
        )}
        <View style={styles.metaRow}>
          <FontAwesome5 name="clock" size={9} color={colors.textLight} />
          <Text style={styles.expiry}>
            {days === 0 ? 'Ends today' : `${days} day${days !== 1 ? 's' : ''} left`}
          </Text>
          {claimed && (
            <View style={styles.claimedPill}>
              <FontAwesome5 name="check" size={8} color={colors.success} />
              <Text style={styles.claimedText}>Claimed</Text>
            </View>
          )}
        </View>
      </View>
      <FontAwesome5 name="chevron-right" size={11} color={colors.textLight} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  listContent: { padding: spacing.md, gap: 10, paddingBottom: 100, flexGrow: 1 },

  card: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: 12, borderWidth: 1, borderColor: colors.border,
  },
  discount: { paddingHorizontal: 10, paddingVertical: 12, borderRadius: radius.md, minWidth: 70, alignItems: 'center', justifyContent: 'center' },
  discountText: { color: '#fff', fontSize: 11, fontWeight: '900', textAlign: 'center' },
  title:    { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  business: { fontSize: fontSize.xs, color: S.color, fontWeight: '700', marginTop: 1 },
  desc:     { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2, lineHeight: 16 },
  metaRow:  { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  expiry:   { fontSize: 10, color: colors.textLight, fontWeight: '600' },
  claimedPill: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: colors.successLight, paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.full, marginLeft: 'auto' },
  claimedText: { fontSize: 9, fontWeight: '800', color: colors.success },
});
