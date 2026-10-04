/**
 * app/local-experiences.tsx — Experiences & passes: the destination behind the Experiences pillar on Home and Local.
 *
 * Day passes, multi-visit passes, class packs and guided experiences that Shetland businesses sell (book_unit_items).
 * A card opens the existing pass purchase flow. With no inventory yet it is an intentional "opening soon" panel with a
 * route for businesses, not a blank list. An administrator also sees test fixtures, each marked TEST · ADMIN ONLY.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, FlatList, RefreshControl, StyleSheet } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { SECTIONS } from '@/constants/sections';
import { colors, contentContainer } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { useAuth } from '@/context/AuthContext';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { LoadingState } from '@/components/ui/LoadingState';
import DisplayText from '@/components/DisplayText';
import { fetchActiveLocalPasses } from '@/lib/local-api';
import { fetchFixtureIds, NO_FIXTURES } from '@/lib/discovery-fixtures';
import { MerchCard, PillarEmpty, SIDE } from '@/components/home-local/ui';
import { passesToMerch } from '@/components/home-local/data';
import { PILLARS, type Merch } from '@/components/home-local/model';

const S = SECTIONS.local;
const P = PILLARS.experiences;

export default function ExperiencesScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const { screenWidth } = useAppLayout();
  const [items, setItems] = useState<Merch[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [passes, fixtures] = await Promise.all([
        fetchActiveLocalPasses(60).catch(() => []),
        fetchFixtureIds(profile?.id).catch(() => NO_FIXTURES),
      ]);
      setItems(passesToMerch(passes, fixtures));
    } finally { setLoading(false); setRefreshing(false); }
  }, [profile?.id]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const cardW = Math.min(screenWidth, 640) - SIDE * 2;

  return (
    <ScreenScaffold header={<ScreenHeader title="Experiences & passes" subtitle={items.length ? `${items.length} available` : undefined} accent={P.color} onBack={() => router.back()} />}>
      {loading ? (
        <LoadingState accent={P.color} />
      ) : items.length === 0 ? (
        <View style={{ paddingTop: SIDE }}>
          <PillarEmpty pillar="experiences" width={Math.min(screenWidth, 640)} />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(m) => m.id}
          contentContainerStyle={[{ paddingVertical: SIDE, gap: 14, alignItems: 'center' }, contentContainer(screenWidth)]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={P.color} />}
          ListHeaderComponent={
            <View style={{ width: cardW, marginBottom: 2 }}>
              <Text style={s.eyebrow}>{P.short.toUpperCase()}</Text>
              <DisplayText weight="bold" style={s.title}>{P.heading}</DisplayText>
            </View>
          }
          renderItem={({ item }) => <MerchCard m={item} width={cardW} />}
        />
      )}
    </ScreenScaffold>
  );
}

const s = StyleSheet.create({
  eyebrow: { color: P.color, fontSize: 11, fontWeight: '800', letterSpacing: 1.2 },
  title: { color: colors.textPrimary, fontSize: 26, lineHeight: 29, marginTop: 3 },
});
