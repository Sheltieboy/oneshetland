/**
 * local-offers.tsx — global feed of active offers
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  Image, ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import {
  fetchActiveOffers, fetchMyRedeemedOfferIds,
  formatOfferDiscount, daysRemaining,
  type LocalOffer,
} from '@/lib/local-api';

const S = SECTIONS.local;

export default function OffersScreen() {
  const router = useRouter();
  const { profile } = useAuth();
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
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Local</Text>
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Offers</Text>
          <Text style={styles.headerSub}>{offers.length} active</Text>
        </View>
        <View style={{ width: 70 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      ) : (
        <FlatList
          data={offers}
          keyExtractor={o => o.id}
          renderItem={({ item }) => <OfferRow offer={item} claimed={redeemed.has(item.id)} />}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={S.color} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <View style={[styles.emptyIcon, { backgroundColor: S.light }]}>
                <FontAwesome5 name="tags" size={28} color={S.color} solid />
              </View>
              <Text style={styles.emptyTitle}>No offers right now</Text>
              <Text style={styles.emptyText}>Follow local businesses to be alerted when they post deals.</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

function OfferRow({ offer, claimed }: { offer: LocalOffer; claimed: boolean }) {
  const router = useRouter();
  const days = daysRemaining(offer.valid_until);

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={() => router.push({ pathname: '/local-business-detail', params: { id: offer.business_id } })}
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
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 60 },

  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
    borderBottomWidth: 2,
  },
  backBtn:     { flexDirection: 'row', alignItems: 'center', gap: 8, width: 70 },
  backText:    { fontSize: fontSize.sm, fontWeight: '700' },
  headerCenter:{ alignItems: 'center', gap: 2 },
  headerTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
  headerSub:   { color: 'rgba(255,255,255,0.5)', fontSize: fontSize.xs, fontWeight: '600' },

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

  empty:      { alignItems: 'center', padding: spacing.xl, gap: 10, flex: 1, justifyContent: 'center' },
  emptyIcon:  { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, marginTop: 4 },
  emptyText:  { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },
});
