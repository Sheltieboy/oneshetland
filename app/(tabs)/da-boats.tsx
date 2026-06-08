/**
 * app/(tabs)/da-boats.tsx
 *
 * Da Boats landing — scrapbook redesign for an older audience.
 *
 * Design priorities (compared with the original data-table look):
 *   * BIG type. Body 17 px, titles 26 px+, no faint metas.
 *   * Hero photo on every card that has one — boats people knew, not rows.
 *   * Plain English everywhere (no jargon like "evidence drawer").
 *   * Generous tap targets (cards 60 mm+ tall).
 *   * "Saved boats" + "Recently viewed" rows so the men who use this can
 *     return to "yon boat I was looking at" without searching again.
 *   * One-tap decade chips at the top — pick "1980s" and the grid filters
 *     in place; no separate search dance required.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
  searchVessels, VesselSearchRow, fetchHeroPhotos,
} from '@/lib/boats-api';
import {
  loadSavedBoats, loadRecentBoats, toggleSavedBoat, VesselStub,
} from '@/lib/boats-prefs';
import VesselCard from '@/components/VesselCard';

const SECTION = SECTIONS.daBoats;

const DECADES = ['1950s','1960s','1970s','1980s','1990s','2000s','2010s','2020s'];

function decadeOf(year: number | null | undefined): string | null {
  if (!year) return null;
  const d = Math.floor(year / 10) * 10;
  return `${d}s`;
}

export default function DaBoatsScreen() {
  const router = useRouter();
  const [rows, setRows]                   = useState<VesselSearchRow[]>([]);
  const [heroes, setHeroes]               = useState<Record<string, string>>({});
  const [query, setQuery]                 = useState('');
  const [decade, setDecade]               = useState<string | null>(null);
  const [photosOnly, setPhotosOnly]       = useState(false);
  const [loading, setLoading]             = useState(true);
  const [refreshing, setRefreshing]       = useState(false);
  const [saved, setSaved]                 = useState<VesselStub[]>([]);
  const [recent, setRecent]               = useState<VesselStub[]>([]);
  const [savedIds, setSavedIds]           = useState<Set<string>>(new Set());

  const refreshPrefs = useCallback(async () => {
    const [s, r] = await Promise.all([loadSavedBoats(), loadRecentBoats()]);
    setSaved(s);
    setRecent(r);
    setSavedIds(new Set(s.map(b => b.id)));
  }, []);

  const load = useCallback(async (q: string) => {
    try {
      // Fetch up to 600 rows — the whole fleet currently sits at ~467
      // vessels and the rows from vessel_search are lightweight (just
      // canonical name + LK + counts + names string). Lower limits
      // broke the decade chips because the ORDER BY built_year DESC
      // default never reached the older decades before the cap.
      const data = await searchVessels(q, 600);
      setRows(data);
      // In parallel fetch hero photos for whatever's visible
      const ids = data.map(d => d.id);
      const h = await fetchHeroPhotos(ids);
      setHeroes(h);
    } catch {
      setRows([]);
      setHeroes({});
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void refreshPrefs(); }, [refreshPrefs]));

  // Debounced search
  useEffect(() => {
    setLoading(true);
    const t = setTimeout(() => { void load(query); }, 250);
    return () => clearTimeout(t);
  }, [query, load]);

  // Apply decade + photo filters in-memory (467 rows max — trivial cost)
  const filtered = useMemo(() => {
    let r = rows;
    if (decade) r = r.filter(v => decadeOf(v.built_year) === decade);
    if (photosOnly) r = r.filter(v => v.media_asset_count > 0);
    return r;
  }, [rows, decade, photosOnly]);

  const handleToggleSave = async (row: VesselSearchRow) => {
    const stub: VesselStub = {
      id:             row.id,
      lk_number:      row.primary_lk_number,
      canonical_name: row.canonical_name,
      built_year:     row.built_year,
      hero_url:       heroes[row.id] ?? null,
    };
    const isNowSaved = await toggleSavedBoat(stub);
    setSavedIds(prev => {
      const next = new Set(prev);
      if (isNowSaved) next.add(row.id); else next.delete(row.id);
      return next;
    });
    void refreshPrefs();
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />

      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); void load(query); void refreshPrefs(); }}
            tintColor={SECTION.color}
          />
        }
      >
        {/* Hero header */}
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.eyebrow, { color: SECTION.color }]}>The fleet</Text>
            <Text style={styles.title}>Da Boats</Text>
            <Text style={styles.subtitle}>
              Shetland LK boats through the years
            </Text>
          </View>
          <View style={[styles.iconBadge, { backgroundColor: SECTION.light }]}>
            <FontAwesome5 name={SECTION.icon} size={26} color={SECTION.color} />
          </View>
        </View>

        {/* Big search */}
        <View style={styles.searchWrap}>
          <View style={styles.searchBar}>
            <FontAwesome5 name="search" size={18} color={SECTION.color} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search a boat — name or number"
              placeholderTextColor={colors.textMuted}
              style={styles.searchInput}
              autoCorrect={false}
              autoCapitalize="characters"
              returnKeyType="search"
            />
            {query ? (
              <TouchableOpacity onPress={() => setQuery('')} hitSlop={12}>
                <FontAwesome5 name="times-circle" size={20} color={colors.textMuted} solid />
              </TouchableOpacity>
            ) : null}
          </View>
        </View>

        {/* Decade chips */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
        >
          <Chip
            label="Any year"
            active={decade === null}
            onPress={() => setDecade(null)}
          />
          {DECADES.map(d => (
            <Chip
              key={d}
              label={d}
              active={decade === d}
              onPress={() => setDecade(prev => prev === d ? null : d)}
            />
          ))}
          <Chip
            label={photosOnly ? 'With photos ✓' : 'With photos'}
            active={photosOnly}
            onPress={() => setPhotosOnly(p => !p)}
          />
        </ScrollView>

        {/* Saved boats row */}
        {saved.length > 0 ? (
          <Section title="Saved boats">
            <View style={styles.list}>
              {saved.map(s => (
                <VesselCard
                  key={s.id}
                  data={{
                    id: s.id,
                    lk_number: s.lk_number,
                    canonical_name: s.canonical_name,
                    built_year: s.built_year,
                    hero_url: s.hero_url,
                  }}
                  variant="row"
                  saved
                  onToggleSave={async () => {
                    await toggleSavedBoat(s);
                    void refreshPrefs();
                  }}
                  onPress={() => router.push(`/boat/${s.id}`)}
                />
              ))}
            </View>
          </Section>
        ) : null}

        {/* Recently viewed row (suppress when same as saved) */}
        {recent.length > 0 ? (
          <Section title="You looked at">
            <View style={styles.list}>
              {recent.map(r => (
                <VesselCard
                  key={r.id}
                  data={{
                    id: r.id,
                    lk_number: r.lk_number,
                    canonical_name: r.canonical_name,
                    built_year: r.built_year,
                    hero_url: r.hero_url,
                  }}
                  variant="row"
                  saved={savedIds.has(r.id)}
                  onToggleSave={async () => {
                    await toggleSavedBoat(r);
                    void refreshPrefs();
                  }}
                  onPress={() => router.push(`/boat/${r.id}`)}
                />
              ))}
            </View>
          </Section>
        ) : null}

        {/* Browse */}
        <Section
          title={
            query.trim()
              ? loading ? 'Searching…' : `${filtered.length} found`
              : decade
                ? `Boats from ${decade}`
                : photosOnly
                  ? 'Boats with photos'
                  : 'The whole fleet'
          }
        >
          {loading ? (
            <View style={{ paddingVertical: spacing.lg }}>
              <ActivityIndicator color={SECTION.color} />
            </View>
          ) : filtered.length === 0 ? (
            <View style={styles.empty}>
              <FontAwesome5 name="ship" size={36} color={SECTION.color} />
              <Text style={styles.emptyTitle}>Nothing matches</Text>
              <Text style={styles.emptyBody}>
                Try a different name or number, or clear the filters above.
              </Text>
            </View>
          ) : (
            <View style={styles.list}>
              {filtered.map(r => (
                <VesselCard
                  key={r.id}
                  data={{
                    id:             r.id,
                    lk_number:      r.primary_lk_number,
                    canonical_name: r.canonical_name,
                    built_year:     r.built_year,
                    hull_material:  r.hull_material,
                    hero_url:       heroes[r.id] ?? null,
                    photo_count:    r.media_asset_count,
                    alt_names:      buildAltLine(r),
                  }}
                  variant="hero"
                  saved={savedIds.has(r.id)}
                  onToggleSave={() => handleToggleSave(r)}
                  onPress={() => router.push(`/boat/${r.id}`)}
                />
              ))}
            </View>
          )}
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function buildAltLine(r: VesselSearchRow): string | null {
  const others = (r.all_names ?? '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .filter(n => n.toUpperCase() !== r.canonical_name.toUpperCase());
  if (others.length === 0) return null;
  return others.slice(0, 3).join(', ');
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Chip({
  label, active, onPress,
}: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[
        styles.chip,
        active && { backgroundColor: SECTION.color, borderColor: SECTION.color },
      ]}
    >
      <Text style={[styles.chipText, active && { color: '#fff' }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.screenBackground },
  scroll:    { paddingBottom: spacing.xxl, gap: spacing.lg },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: spacing.md,
  },
  eyebrow: {
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  title: {
    fontSize: 34,
    fontWeight: '900',
    color: colors.textPrimary,
    marginTop: 2,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 16,
    color: colors.textSecondary,
    marginTop: 2,
    fontWeight: '500',
  },
  iconBadge: {
    width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center',
  },

  searchWrap: { paddingHorizontal: spacing.lg },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.white,
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 16,
    borderWidth: 1.5,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  searchInput: {
    flex: 1,
    fontSize: 18,
    fontWeight: '600',
    color: colors.textPrimary,
    paddingVertical: 0,
  },

  chipRow: {
    paddingHorizontal: spacing.lg,
    gap: 8,
  },
  chip: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: colors.white,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  chipText: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.textPrimary,
  },

  sectionTitle: {
    paddingHorizontal: spacing.lg,
    fontSize: 20,
    fontWeight: '900',
    color: colors.textPrimary,
    marginBottom: spacing.sm,
  },

  list: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },

  empty: {
    margin: spacing.lg,
    padding: spacing.xl,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: colors.textPrimary,
  },
  emptyBody: {
    fontSize: 16,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
  },
});
