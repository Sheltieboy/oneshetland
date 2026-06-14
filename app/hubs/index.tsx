/**
 * hubs/index.tsx
 * Browse OneShetland Hubs — community organisations with their own space.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius, SIDEBAR_WIDTH } from '@/constants/theme';
import { NavRail } from '@/components/NavRail';
import { TabScreenHeader } from '@/components/TabScreenHeader';
import { HeroBackPill } from '@/components/ui/HeroBackPill';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { useAuth } from '@/context/AuthContext';
import {
  fetchActiveHubs, HUB_TYPE_LABELS, HUB_TYPE_ICONS,
  type Hub, type HubType,
} from '@/lib/hubs-api';

const S = SECTIONS.community;

const TYPE_FILTERS: (HubType | 'all')[] = ['all', 'club', 'sports', 'youth', 'hall', 'charity', 'arts', 'volunteer'];

export default function HubsScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const { isTablet, screenWidth } = useAppLayout();

  const [hubs, setHubs] = useState<Hub[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<HubType | 'all'>('all');

  const load = useCallback(async () => {
    try { setHubs(await fetchActiveHubs()); }
    catch { setHubs([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true); await load(); setRefreshing(false);
  }, [load]);

  const visible = filter === 'all' ? hubs : hubs.filter(h => h.type === filter);
  const cols = isTablet ? (screenWidth >= 1100 ? 3 : 2) : 1;
  const maxW = isTablet ? Math.min(900, screenWidth - spacing.lg * 2) : undefined;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <NavRail />
      <View style={{ flex: 1, paddingLeft: isTablet ? SIDEBAR_WIDTH : 0, backgroundColor: colors.screenBackground }}>
      <View>
        <TabScreenHeader section={S} eyebrow="Community" />
        {!isTablet && router.canGoBack() ? (
          <View style={{ position: 'absolute', top: 12, left: spacing.md }}>
            <HeroBackPill variant="overlay" label="Back" onPress={() => router.back()} />
          </View>
        ) : null}
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, maxW ? { width: maxW, alignSelf: 'center' } : null]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={S.color} />}
      >
        <Text style={styles.intro}>
          A simple branded home for Shetland clubs, groups, charities and community organisations.
        </Text>

        {/* Create CTA */}
        <TouchableOpacity
          style={[styles.createCard, { backgroundColor: S.color }]}
          onPress={() => {
            Haptics.selectionAsync();
            if (!profile) { router.push('/(auth)/sign-in'); return; }
            router.push('/hub-register');
          }}
          activeOpacity={0.9}
        >
          <View style={styles.createIcon}><FontAwesome5 name="plus" size={16} color={S.color} solid /></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.createTitle}>Start a Hub</Text>
            <Text style={styles.createSub}>Free for your club, group or organisation</Text>
          </View>
          <FontAwesome5 name="chevron-right" size={14} color="rgba(255,255,255,0.85)" />
        </TouchableOpacity>

        {/* Type filter */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterRow} contentContainerStyle={{ gap: 8, paddingVertical: 2 }}>
          {TYPE_FILTERS.map(t => (
            <TouchableOpacity
              key={t}
              style={[styles.chip, filter === t && { backgroundColor: S.color, borderColor: S.color }]}
              onPress={() => setFilter(t)}
              activeOpacity={0.8}
            >
              <Text style={[styles.chipText, filter === t && { color: '#fff' }]}>
                {t === 'all' ? 'All' : HUB_TYPE_LABELS[t]}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {loading ? (
          <View style={styles.center}><ActivityIndicator color={S.color} /></View>
        ) : visible.length === 0 ? (
          <View style={styles.empty}>
            <FontAwesome5 name="users" size={30} color={colors.textLight} />
            <Text style={styles.emptyTitle}>No hubs yet</Text>
            <Text style={styles.emptyBody}>Be the first — start a Hub for your group.</Text>
          </View>
        ) : (
          <View style={[styles.grid, { gap: spacing.md }]}>
            {visible.map(h => (
              <HubCard key={h.id} hub={h} width={cols === 1 ? '100%' : `${100 / cols - 2}%`}
                onPress={() => router.push(`/hubs/${h.id}`)} />
            ))}
          </View>
        )}
        <View style={{ height: 40 }} />
      </ScrollView>
      </View>
    </SafeAreaView>
  );
}

function HubCard({ hub, width, onPress }: { hub: Hub; width: any; onPress: () => void }) {
  const accent = (hub.brand_color && /^#?[0-9a-fA-F]{6}/.test(hub.brand_color))
    ? (hub.brand_color.startsWith('#') ? hub.brand_color : `#${hub.brand_color}`)
    : S.color;
  return (
    <TouchableOpacity style={[styles.card, { width }]} onPress={onPress} activeOpacity={0.85}>
      <View style={[styles.cardBanner, { backgroundColor: accent }]}>
        {hub.cover_url ? <Image source={{ uri: hub.cover_url }} style={styles.cardCover} /> : null}
        <View style={[styles.cardLogo, { borderColor: '#fff' }]}>
          {hub.logo_url
            ? <Image source={{ uri: hub.logo_url }} style={styles.cardLogoImg} />
            : <FontAwesome5 name={(HUB_TYPE_ICONS[hub.type] ?? 'users') as any} size={18} color={accent} solid />}
        </View>
      </View>
      <View style={styles.cardBody}>
        <Text style={styles.cardName} numberOfLines={1}>{hub.name}</Text>
        <Text style={styles.cardType} numberOfLines={1}>
          {HUB_TYPE_LABELS[hub.type]}{hub.is_verified ? '  ·  Verified' : ''}
        </Text>
        {hub.description ? <Text style={styles.cardDesc} numberOfLines={2}>{hub.description}</Text> : null}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingBottom: spacing.sm, borderBottomWidth: 2, backgroundColor: '#fff',
  },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, width: 70 },
  backText: { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },

  content: { padding: spacing.md },
  intro: { fontSize: fontSize.sm, color: colors.textMuted, lineHeight: 21, marginBottom: spacing.md },

  createCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md,
  },
  createIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  createTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
  createSub: { color: 'rgba(255,255,255,0.85)', fontSize: fontSize.xs, marginTop: 1 },

  filterRow: { marginBottom: spacing.md },
  chip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
    backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border,
  },
  chipText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary },

  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  card: { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  cardBanner: { height: 70, justifyContent: 'flex-end', paddingLeft: spacing.md },
  cardCover: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
  cardLogo: {
    width: 48, height: 48, borderRadius: 14, marginBottom: -24, borderWidth: 2,
    backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  cardLogoImg: { width: 48, height: 48 },
  cardBody: { padding: spacing.md, paddingTop: 30, gap: 3 },
  cardName: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  cardType: { fontSize: fontSize.xs, color: colors.textMuted },
  cardDesc: { fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 19, marginTop: 2 },

  center: { paddingVertical: spacing.xl, alignItems: 'center' },
  empty: { alignItems: 'center', paddingVertical: spacing.xxl, gap: 10 },
  emptyTitle: { fontSize: fontSize.lg, fontWeight: '800', color: colors.textPrimary },
  emptyBody: { fontSize: fontSize.sm, color: colors.textMuted },
});
