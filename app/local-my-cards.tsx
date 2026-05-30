/**
 * local-my-cards.tsx — user's loyalty cards (stamp + points)
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
  fetchMyLoyaltyCards, CATEGORY_ICONS,
  type LoyaltyCard,
} from '@/lib/local-api';

const S = SECTIONS.local;

export default function MyCardsScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const [cards, setCards]       = useState<LoyaltyCard[]>([]);
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!profile) return;
    try {
      const data = await fetchMyLoyaltyCards(profile.id);
      setCards(data);
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
          <Text style={styles.headerTitle}>My cards</Text>
          <Text style={styles.headerSub}>{cards.length} card{cards.length !== 1 ? 's' : ''}</Text>
        </View>
        <View style={{ width: 70 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      ) : (
        <FlatList
          data={cards}
          keyExtractor={c => c.id}
          renderItem={({ item }) => <CardRow card={item} />}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={S.color} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <View style={[styles.emptyIcon, { backgroundColor: S.light }]}>
                <FontAwesome5 name="stamp" size={28} color={S.color} solid />
              </View>
              <Text style={styles.emptyTitle}>No loyalty cards yet</Text>
              <Text style={styles.emptyText}>
                Visit a participating business and collect your first stamp.
              </Text>
              <TouchableOpacity
                style={[styles.browseBtn, { backgroundColor: S.color }]}
                onPress={() => router.push('/local-businesses-browse')}
                activeOpacity={0.85}
              >
                <Text style={styles.browseBtnText}>Browse businesses</Text>
              </TouchableOpacity>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

function CardRow({ card }: { card: LoyaltyCard }) {
  const router = useRouter();
  const isStamp = card.program?.type === 'stamps';
  const stamps  = card.stamps_collected;
  const needed  = card.program?.stamps_required ?? 10;
  const progress = Math.min(1, stamps / needed);
  const rewardReady = isStamp && stamps >= needed;

  return (
    <TouchableOpacity
      style={[styles.card, rewardReady && { borderColor: S.color, borderWidth: 2 }]}
      onPress={() => router.push({ pathname: '/local-business-detail', params: { id: card.business_id } })}
      activeOpacity={0.85}
    >
      <View style={styles.cardTop}>
        {card.business?.logo_url ? (
          <Image source={{ uri: card.business.logo_url }} style={styles.cardLogo} />
        ) : (
          <View style={[styles.cardLogo, { backgroundColor: S.light, alignItems: 'center', justifyContent: 'center' }]}>
            <FontAwesome5 name={(card.business ? CATEGORY_ICONS[card.business.category] : 'store') as any} size={18} color={S.color} solid />
          </View>
        )}
        <View style={{ flex: 1 }}>
          <Text style={styles.cardName} numberOfLines={1}>{card.business?.name ?? 'Local'}</Text>
          {isStamp ? (
            <Text style={styles.cardSub}>
              {stamps} of {needed} stamps
            </Text>
          ) : (
            <Text style={styles.cardSub}>{card.points_balance} points</Text>
          )}
        </View>
        {rewardReady && (
          <View style={[styles.readyBadge, { backgroundColor: S.color }]}>
            <FontAwesome5 name="gift" size={9} color="#fff" solid />
            <Text style={styles.readyBadgeText}>Ready!</Text>
          </View>
        )}
      </View>

      {isStamp && (
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { backgroundColor: S.color, width: `${progress * 100}%` }]} />
        </View>
      )}

      {card.program?.stamp_reward && (
        <Text style={styles.cardReward}>{card.program.stamp_reward}</Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.screenBackground },
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

  listContent: { padding: spacing.md, gap: 12, paddingBottom: 100, flexGrow: 1 },

  card: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: 14, gap: 10,
    borderWidth: 1, borderColor: colors.border,
  },
  cardTop:    { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cardLogo:   { width: 44, height: 44, borderRadius: radius.md },
  cardName:   { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  cardSub:    { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2, fontWeight: '600' },
  cardReward: { fontSize: fontSize.xs, color: colors.textSecondary, fontStyle: 'italic' },

  readyBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.full },
  readyBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },

  progressTrack: { height: 6, backgroundColor: colors.border, borderRadius: 3, overflow: 'hidden' },
  progressFill:  { height: 6, borderRadius: 3 },

  empty:      { alignItems: 'center', padding: spacing.xl, gap: 10, flex: 1, justifyContent: 'center' },
  emptyIcon:  { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, marginTop: 4 },
  emptyText:  { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
  browseBtn:  { paddingHorizontal: 20, paddingVertical: 12, borderRadius: radius.full, marginTop: 12 },
  browseBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
});
