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
import { useAlert } from '@/components/BrandedAlert';
import { APPLE_WALLET_SUPPORTED, addLoyaltyCardToAppleWallet } from '@/lib/apple-wallet';
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

function CardRow({ card }: { card: LoyaltyCard }) {
  const router = useRouter();
  const { alert } = useAlert();
  const [addingWallet, setAddingWallet] = useState(false);
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

      {APPLE_WALLET_SUPPORTED && (
        <TouchableOpacity
          style={styles.walletBtn}
          disabled={addingWallet}
          onPress={async () => {
            setAddingWallet(true);
            try {
              await addLoyaltyCardToAppleWallet(card.id);
            } catch (e) {
              alert({ title: 'Apple Wallet', message: e instanceof Error ? e.message : 'Could not add the pass.' });
            } finally {
              setAddingWallet(false);
            }
          }}
          activeOpacity={0.85}
        >
          {addingWallet
            ? <ActivityIndicator size="small" color="#000" />
            : <><FontAwesome5 name="wallet" size={12} color="#000" solid /><Text style={styles.walletBtnText}>Add to Apple Wallet</Text></>}
        </TouchableOpacity>
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

  progressTrack: { height: 6, backgroundColor: colors.border, borderRadius: 3, overflow: 'hidden' },
  progressFill:  { height: 6, borderRadius: 3 },

  walletBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#fff', borderWidth: 1, borderColor: '#000', borderRadius: radius.md, paddingVertical: 10 },
  walletBtnText: { color: '#000', fontSize: fontSize.xs, fontWeight: '800' },
});
