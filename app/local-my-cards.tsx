/**
 * local-my-cards.tsx — user's loyalty cards (stamp + points)
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  Image, RefreshControl, ActivityIndicator,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
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
  fetchMyLoyaltyCards, CATEGORY_ICONS,
  type LoyaltyCard,
} from '@/lib/local-api';

const S = SECTIONS.local;

export default function MyCardsScreen() {
  const router = useRouter();
  const { screenWidth } = useAppLayout();
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

  // Refresh on focus so a stamp collected on the scanner shows the moment you
  // come back to this screen (no need to leave and re-enter).
  useFocusEffect(useCallback(() => { load(); }, [load]));

  return (
    <ScreenScaffold
      header={
        <ScreenHeader
          title="My cards"
          subtitle={`${cards.length} card${cards.length !== 1 ? 's' : ''}`}
          accent={S.color}
          onBack={() => router.back()}
        />
      }
    >
      {loading ? (
        <LoadingState accent={S.color} />
      ) : (
        <FlatList
          data={cards}
          keyExtractor={c => c.id}
          renderItem={({ item }) => <CardRow card={item} />}
          ListHeaderComponent={
            <TouchableOpacity style={[styles.showCardBtn, { backgroundColor: S.color }]} onPress={() => router.push('/my-loyalty-code')} activeOpacity={0.9}>
              <FontAwesome5 name="qrcode" size={16} color="#fff" />
              <View style={{ flex: 1 }}>
                <Text style={styles.showCardTitle}>Show my card</Text>
                <Text style={styles.showCardSub}>One code for every Shetland shop — scan to collect or redeem</Text>
              </View>
              <FontAwesome5 name="chevron-right" size={13} color="rgba(255,255,255,0.8)" />
            </TouchableOpacity>
          }
          contentContainerStyle={[styles.listContent, contentContainer(screenWidth)]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={S.color} />}
          ListEmptyComponent={
            <EmptyState
              icon="stamp"
              title="No loyalty cards yet"
              body="Visit a participating business and collect your first stamp."
              accent={S.color}
              variant="card"
              actionLabel="Browse businesses"
              onAction={() => router.push('/local-businesses-browse')}
            />
          }
        />
      )}
    </ScreenScaffold>
  );
}

/** Up to two initials from the business name — "DEMO — Shetland Makkers" → "SM". */
function initialsOf(name: string): string {
  const words = name
    .replace(/[—–-]/g, ' ')
    .split(/\s+/)
    .filter(w => /[a-z]/i.test(w) && !/^(the|and|of|at|de|da)$/i.test(w));
  const picked = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  return picked.slice(0, 2).map(w => w[0].toUpperCase()).join('') || '★';
}

/**
 * A real stamp card rather than a progress bar — one slot per stamp, filled
 * ones carrying the shop's initials like an ink stamp. A bar reads as "37%
 * loaded"; this reads as "three stamps, two to go", which is what the customer
 * is actually counting.
 *
 * Long cards (10+) shrink the slots rather than wrapping, so the row stays one
 * glanceable line.
 */
function StampRow({ collected, needed, name }: { collected: number; needed: number; name: string }) {
  const marks = initialsOf(name);
  const size = needed > 12 ? 20 : needed > 8 ? 26 : 32;
  const font = size <= 20 ? 8 : size <= 26 ? 10 : 12;
  return (
    <View style={styles.stampRow} accessibilityLabel={`${collected} of ${needed} stamps collected`}>
      {Array.from({ length: needed }).map((_, i) => {
        const filled = i < collected;
        return (
          <View
            key={i}
            style={[
              styles.stamp,
              { width: size, height: size, borderRadius: size / 2 },
              filled
                ? { backgroundColor: S.color, borderColor: S.color }
                : { borderColor: colors.border, borderStyle: 'dashed' },
            ]}
          >
            {filled && <Text style={[styles.stampText, { fontSize: font }]}>{marks}</Text>}
          </View>
        );
      })}
    </View>
  );
}

function CardRow({ card }: { card: LoyaltyCard }) {
  const router = useRouter();
  const isStamp = card.program?.type === 'stamps';
  const stamps  = card.stamps_collected;
  const needed  = card.program?.stamps_required ?? 10;
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

      {isStamp && <StampRow collected={stamps} needed={needed} name={card.business?.name ?? ''} />}

      {card.program?.stamp_reward && (
        <Text style={styles.cardReward}>{card.program.stamp_reward}</Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
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

  stampRow:  { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 7 },
  stamp:     { borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  stampText: { color: '#fff', fontWeight: '900', letterSpacing: 0.2 },

  walletBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#fff', borderWidth: 1, borderColor: '#000', borderRadius: radius.md, paddingVertical: 10 },
  walletBtnText: { color: '#000', fontSize: fontSize.xs, fontWeight: '800' },

  showCardBtn: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: radius.lg, padding: 16, marginBottom: 4 },
  showCardTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '900' },
  showCardSub: { color: 'rgba(255,255,255,0.9)', fontSize: fontSize.xs, marginTop: 2, lineHeight: 15 },
});
