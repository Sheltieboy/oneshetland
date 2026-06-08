/**
 * app/(tabs)/da-boats.tsx
 *
 * Da Boats landing — search and browse the LK-registered Shetland fleet.
 *
 * Search box hits vessel_search via .or() across canonical name, all
 * historical names, all historical registrations and the primary LK
 * number. Empty query returns the most-recently-built confirmed boats
 * first as a default browse list. Tapping a card opens
 * /boat/[id] (the profile screen).
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator,
  TextInput, TouchableOpacity, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Stack, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { SECTIONS } from '@/constants/sections';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import {
  searchVessels, VesselSearchRow,
  vesselDisplayTitle, hullMaterialLabel,
} from '@/lib/boats-api';

const SECTION = SECTIONS.daBoats;

export default function DaBoatsScreen() {
  const router = useRouter();
  const [rows, setRows]                 = useState<VesselSearchRow[]>([]);
  const [query, setQuery]               = useState('');
  const [loading, setLoading]           = useState(true);
  const [refreshing, setRefreshing]     = useState(false);

  const load = useCallback(async (q: string) => {
    try {
      const data = await searchVessels(q);
      setRows(data);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Default browse on first focus.
  useFocusEffect(useCallback(() => {
    if (!query.trim()) void load('');
  }, [load, query]));

  // Debounced search.
  useEffect(() => {
    setLoading(true);
    const t = setTimeout(() => { void load(query); }, 240);
    return () => clearTimeout(t);
  }, [query, load]);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />

      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); void load(query); }}
            tintColor={SECTION.color}
          />
        }
      >
        {/* Hero header */}
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.eyebrow, { color: SECTION.color }]}>The fleet</Text>
            <Text style={styles.title}>Da Boats</Text>
          </View>
          <View style={[styles.iconBadge, { backgroundColor: SECTION.light }]}>
            <FontAwesome5 name={SECTION.icon} size={20} color={SECTION.color} />
          </View>
        </View>

        <Text style={styles.intro}>
          Every Shetland LK-registered boat we've found a record of, with the names she
          carried, the numbers she wore, the owners, the photographers, and the years.
        </Text>

        {/* Search */}
        <View style={styles.searchWrap}>
          <View style={styles.searchBar}>
            <FontAwesome5 name="search" size={14} color={colors.textMuted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search by name, LK number, owner…"
              placeholderTextColor={colors.textLight}
              style={styles.searchInput}
              autoCorrect={false}
              autoCapitalize="characters"
              returnKeyType="search"
            />
            {query ? (
              <TouchableOpacity onPress={() => setQuery('')} hitSlop={8}>
                <FontAwesome5 name="times-circle" size={14} color={colors.textMuted} solid />
              </TouchableOpacity>
            ) : null}
          </View>
        </View>

        {/* Results */}
        <Text style={styles.heading}>
          {loading
            ? 'Searching…'
            : query.trim()
              ? `${rows.length} match${rows.length === 1 ? '' : 'es'}`
              : 'Most-recent boats'}
        </Text>

        {loading ? (
          <View style={{ paddingVertical: spacing.lg }}>
            <ActivityIndicator color={SECTION.color} />
          </View>
        ) : rows.length === 0 ? (
          <View style={styles.empty}>
            <FontAwesome5 name="ship" size={28} color={SECTION.color} />
            <Text style={styles.emptyTitle}>No matches</Text>
            <Text style={styles.emptyBody}>
              Try a different name or LK number — many boats also went by
              an FR, BF or PD registration at some point.
            </Text>
          </View>
        ) : (
          <View style={styles.list}>
            {rows.map(r => (
              <VesselRow key={r.id} row={r} onPress={() => router.push(`/boat/${r.id}`)} />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Vessel result row ──────────────────────────────────────────────────────

function VesselRow({ row, onPress }: { row: VesselSearchRow; onPress: () => void }) {
  const title = vesselDisplayTitle({
    canonical_name:    row.canonical_name,
    primary_lk_number: row.primary_lk_number,
  });
  const hull = hullMaterialLabel(row.hull_material);

  // "Also" line = the historical names + registrations stripped of the
  // primary so we don't show "BRILLIANT · BRILLIANT".
  const altNames = (row.all_names ?? '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .filter(n => n.toUpperCase() !== row.canonical_name.toUpperCase());

  const altRegs = (row.all_registrations ?? '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .filter(r => r !== row.primary_lk_number);

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={styles.row}>
      <View style={[styles.rowBadge, { backgroundColor: SECTION.light }]}>
        <Text style={[styles.rowLk, { color: SECTION.color }]} numberOfLines={1}>
          {row.primary_lk_number ?? '—'}
        </Text>
      </View>

      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle} numberOfLines={1}>{title}</Text>
        <View style={styles.metaRow}>
          {row.built_year ? (
            <Text style={styles.meta}>Built {row.built_year}</Text>
          ) : null}
          {hull ? <Text style={styles.meta}>· {hull}</Text> : null}
          {row.media_asset_count > 0 ? (
            <Text style={styles.meta}>
              · <FontAwesome5 name="image" size={9} color={colors.textMuted} solid />{' '}
              {row.media_asset_count}
            </Text>
          ) : null}
        </View>
        {altNames.length || altRegs.length ? (
          <Text style={styles.also} numberOfLines={1}>
            {altNames.length ? `Also: ${altNames.slice(0, 3).join(', ')}` : ''}
            {altNames.length && altRegs.length ? ' · ' : ''}
            {altRegs.length  ? altRegs.slice(0, 3).join(', ') : ''}
          </Text>
        ) : null}
      </View>

      <FontAwesome5 name="chevron-right" size={12} color={colors.textLight} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.screenBackground },
  scroll:    { paddingBottom: spacing.xxl },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.md,
  },
  eyebrow: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  title: {
    fontSize: 28,
    fontWeight: '900',
    color: colors.textPrimary,
    marginTop: 2,
  },
  iconBadge: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
  },
  intro: {
    paddingHorizontal: spacing.lg,
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    lineHeight: 19,
    marginBottom: spacing.md,
  },

  searchWrap: { paddingHorizontal: spacing.lg, marginTop: spacing.sm },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.white,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: colors.textPrimary,
    paddingVertical: 0,
  },

  heading: {
    paddingHorizontal: spacing.lg,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    fontSize: fontSize.md,
    fontWeight: '800',
    color: colors.textPrimary,
  },

  list: { paddingHorizontal: spacing.lg, gap: spacing.xs },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowBadge: {
    minWidth: 60,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  rowLk: {
    fontSize: fontSize.sm,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  rowTitle: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  meta: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
  },
  also: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 2,
    fontStyle: 'italic',
  },

  empty: {
    margin: spacing.lg,
    padding: spacing.lg,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emptyTitle: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  emptyBody: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 19,
  },
});
