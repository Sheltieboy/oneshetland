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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator,
  TextInput, TouchableOpacity, RefreshControl, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Stack, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { SECTIONS } from '@/constants/sections';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import {
  searchVessels, VesselSearchRow, fetchHeroPhotos, fetchVesselMetrics, type VesselMetric,
} from '@/lib/boats-api';
import {
  loadSavedBoats, loadRecentBoats, toggleSavedBoat, VesselStub,
} from '@/lib/boats-prefs';
import { computeFleetStats, matchBuildPlace, type BuildPlaceCount } from '@/lib/boats-stats';
import VesselCard from '@/components/VesselCard';
import SectionHero from '@/components/SectionHero';
import { BoatBuildMap } from '@/components/BoatBuildMap';
import { SECTION_HEROES } from '@/constants/section-heroes';
import { track } from '@/lib/analytics';

const SECTION = SECTIONS.daBoats;

const DECADES = ['1950s','1960s','1970s','1980s','1990s','2000s','2010s','2020s'];

function decadeOf(year: number | null | undefined): string | null {
  if (!year) return null;
  const d = Math.floor(year / 10) * 10;
  return `${d}s`;
}

type BoatSort = 'default' | 'name' | 'year_new' | 'year_old' | 'photos';

const SORT_OPTIONS: { key: BoatSort; label: string }[] = [
  { key: 'default',  label: 'Default' },
  { key: 'name',     label: 'Name A–Z' },
  { key: 'year_new', label: 'Year (newest)' },
  { key: 'year_old', label: 'Year (oldest)' },
  { key: 'photos',   label: 'Most photos' },
];

/** Pure client-side reorder of an already-loaded list. 'default' leaves order untouched. */
function sortVessels(rows: VesselSearchRow[], sort: BoatSort): VesselSearchRow[] {
  if (sort === 'default') return rows;
  const r = [...rows];
  switch (sort) {
    case 'name':
      return r.sort((a, b) => a.canonical_name.localeCompare(b.canonical_name, 'en', { sensitivity: 'base' }));
    case 'year_new':
      return r.sort((a, b) => (b.built_year ?? -Infinity) - (a.built_year ?? -Infinity));
    case 'year_old':
      return r.sort((a, b) => (a.built_year ?? Infinity) - (b.built_year ?? Infinity));
    case 'photos':
      return r.sort((a, b) => (b.media_asset_count ?? 0) - (a.media_asset_count ?? 0));
    default:
      return r;
  }
}

export default function DaBoatsScreen() {
  const router = useRouter();
  const { isTablet } = useAppLayout();
  const [rows, setRows]                   = useState<VesselSearchRow[]>([]);
  const [heroes, setHeroes]               = useState<Record<string, string>>({});
  const [metrics, setMetrics]             = useState<Record<string, VesselMetric>>({});
  const [query, setQuery]                 = useState('');
  const [decade, setDecade]               = useState<string | null>(null);
  const [photosOnly, setPhotosOnly]       = useState(false);
  const [buildPlace, setBuildPlace]       = useState<string | null>(null);  // place key
  const [builderName, setBuilderName]     = useState<string | null>(null);
  const [sort, setSort]                   = useState<BoatSort>('default');
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
      if (q.trim()) {
        track('search_performed', { props: { section: 'boats', query: q.trim(), results_count: data.length } });
      }
      // Show the cards straight away — don't block the list on photos.
      setLoading(false);
      setRefreshing(false);

      // Hero photos are the expensive part (a big IN-join that returns
      // every media link). Fetch them in the background and let them pop
      // in: first the top batch the user actually sees, then the rest.
      const ids = data.map(d => d.id);
      const FIRST_BATCH = 40;
      void (async () => {
        try {
          const firstIds = ids.slice(0, FIRST_BATCH);
          const restIds  = ids.slice(FIRST_BATCH);
          const firstHeroes = await fetchHeroPhotos(firstIds);
          setHeroes(prev => ({ ...prev, ...firstHeroes }));
          if (restIds.length) {
            const restHeroes = await fetchHeroPhotos(restIds);
            setHeroes(prev => ({ ...prev, ...restHeroes }));
          }
        } catch {
          /* heroes are best-effort — cards still render with placeholders */
        }
      })();
    } catch {
      setRows([]);
      setHeroes({});
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void refreshPrefs(); }, [refreshPrefs]));

  // Search: fire immediately on first load, debounce subsequent keystrokes.
  const didFirstLoad = useRef(false);
  useEffect(() => {
    setLoading(true);
    if (!didFirstLoad.current) {
      didFirstLoad.current = true;
      void load(query);
      return;
    }
    const t = setTimeout(() => { void load(query); }, 250);
    return () => clearTimeout(t);
  }, [query, load]);

  // Per-vessel metrics (length / tonnage / engine) for yard stats — fetched once.
  useEffect(() => { fetchVesselMetrics().then(setMetrics).catch(() => {}); }, []);

  // Fleet-wide stats for the landing — recomputes as heroes/metrics arrive.
  const stats = useMemo(() => computeFleetStats(rows, { metrics, heroes }), [rows, metrics, heroes]);

  // Apply decade / photo / build-place / builder filters in-memory.
  const filtered = useMemo(() => {
    let r = rows;
    if (decade) r = r.filter(v => decadeOf(v.built_year) === decade);
    if (photosOnly) r = r.filter(v => v.media_asset_count > 0);
    if (buildPlace) r = r.filter(v => matchBuildPlace(v.builder)?.key === buildPlace);
    if (builderName) r = r.filter(v => (v.builder ?? '').trim() === builderName);
    return sortVessels(r, sort);
  }, [rows, decade, photosOnly, buildPlace, builderName, sort]);

  // Pristine landing (stats + map + breakdowns) shows only with no filter/search.
  const exploreActive = !query.trim() && !decade && !photosOnly && !buildPlace && !builderName;
  const anyFilter = !!(decade || photosOnly || buildPlace || builderName);
  const clearFilters = () => { setDecade(null); setPhotosOnly(false); setBuildPlace(null); setBuilderName(null); };
  const buildPlaceLabel = buildPlace ? (stats.buildPlaces.find(p => p.key === buildPlace)?.label ?? 'this yard') : null;

  const handleToggleSave = async (row: VesselSearchRow) => {
    const stub: VesselStub = {
      id:             row.id,
      lk_number:      row.primary_lk_number,
      canonical_name: row.canonical_name,
      built_year:     row.built_year,
      hero_url:       heroes[row.id] ?? null,
    };
    const isNowSaved = await toggleSavedBoat(stub);
    track(isNowSaved ? 'item_saved' : 'item_unsaved', { objectType: 'vessel', objectId: row.id });
    setSavedIds(prev => {
      const next = new Set(prev);
      if (isNowSaved) next.add(row.id); else next.delete(row.id);
      return next;
    });
    void refreshPrefs();
  };

  return (
    <SafeAreaView style={styles.container} edges={[]}>
      <Stack.Screen options={{ headerShown: false }} />

      <ScrollView
        style={styles.scrollBg}
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
        {/* Hero photo strip */}
        <SectionHero
          section="daBoats"
          title="Da Boats"
          eyebrow="The fleet"
          photo={SECTION_HEROES.daBoats}
          topInset
          height={220}
        />

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

          {/* Add a boat — community submission */}
          <TouchableOpacity
            style={styles.addBoatBtn}
            onPress={() => router.push('/boat-add')}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Add a boat"
          >
            <FontAwesome5 name="plus" size={14} color="#fff" />
            <Text style={styles.addBoatBtnText}>Add a boat</Text>
          </TouchableOpacity>
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

        {/* ── Explore landing (pristine state only) ── */}
        {exploreActive && rows.length > 0 && (
          <>
            {/* Headline stats */}
            <View style={[styles.statsBand, isTablet && styles.statsBandWide]}>
              <StatTile value={stats.total} label="boats logged" />
              <StatTile value={stats.yearMin && stats.yearMax ? `${stats.yearMin}–${stats.yearMax}` : '—'} label="spanning" />
              <StatTile value={stats.withPhotos} label="with photos" />
              <StatTile value={stats.buildPlaces.length} label="build ports" />
            </View>

            {/* Community note — help improve the archive */}
            <View style={[styles.helpCard, isTablet && styles.statsBandWide]}>
              <View style={styles.helpIcon}>
                <FontAwesome5 name="hands-helping" size={14} color={SECTION.color} solid />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.helpTitle}>Help keep da history right</Text>
                <Text style={styles.helpBody}>
                  This archive was gathered and researched to the best of OneShetland's knowledge —
                  but there will be gaps and mistakes. If you know a boat, open its page and tap any
                  detail to suggest a change, add a date, name an owner or share a photo. Every wee
                  correction helps.
                </Text>
              </View>
            </View>

            {/* Build map */}
            {stats.buildPlaces.length > 0 && (
              <Section title="Where the boats were built">
                <Text style={styles.exploreCaption}>
                  {stats.placedBoats} boats traced to {stats.buildPlaces.length} yards — tap a port to see them.
                </Text>
                <View style={{ paddingHorizontal: spacing.lg, marginTop: 8 }}>
                  <BoatBuildMap
                    places={stats.buildPlaces}
                    height={isTablet ? 360 : 280}
                    onSelectPlace={(p) => setBuildPlace(p.key)}
                  />
                </View>
              </Section>
            )}

            {/* Decade histogram */}
            {stats.decades.length > 0 && (
              <Section title="The fleet through time">
                <View style={styles.histo}>
                  {stats.decades.map(d => {
                    const max = Math.max(...stats.decades.map(x => x.count));
                    return (
                      <TouchableOpacity
                        key={d.key}
                        style={styles.histoCol}
                        onPress={() => setDecade(d.key)}
                        activeOpacity={0.8}
                        accessibilityRole="button"
                        accessibilityLabel={`${d.count} boats from the ${d.key} — tap to filter`}
                      >
                        <Text style={styles.histoCount}>{d.count}</Text>
                        <View style={[styles.histoBar, { height: 10 + (d.count / max) * 96 }]} />
                        <Text style={styles.histoLabel}>{d.key}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </Section>
            )}

            {/* Hull material split */}
            {stats.hulls.length > 0 && (
              <Section title="What they're built of">
                <View style={{ paddingHorizontal: spacing.lg, gap: 8 }}>
                  {stats.hulls.map(h => (
                    <View key={h.key} style={styles.hullRow}>
                      <Text style={styles.hullLabel}>{h.label}</Text>
                      <View style={styles.hullTrack}>
                        <View style={[styles.hullFill, { width: `${(h.count / stats.hulls[0].count) * 100}%` }]} />
                      </View>
                      <Text style={styles.hullCount}>{h.count}</Text>
                    </View>
                  ))}
                </View>
              </Section>
            )}

            {/* Top yards — rich cards, two per row on tablet */}
            {stats.topBuilders.length > 0 && (
              <Section title="Busiest yards">
                <View style={styles.builderGrid}>
                  {stats.topBuilders.map(b => {
                    const span = b.yearMin && b.yearMax
                      ? (b.yearMin === b.yearMax ? `${b.yearMin}` : `${b.yearMin}–${b.yearMax}`)
                      : null;
                    return (
                      <TouchableOpacity
                        key={b.name}
                        style={[styles.builderCard, isTablet && styles.builderCardHalf]}
                        onPress={() => setBuilderName(b.name)}
                        activeOpacity={0.85}
                      >
                        <View style={styles.builderCardTop}>
                          {b.heroUrl ? (
                            <Image source={{ uri: b.heroUrl }} style={styles.builderThumb} />
                          ) : (
                            <View style={[styles.builderThumb, styles.builderThumbEmpty]}>
                              <FontAwesome5 name="hammer" size={14} color={SECTION.color} solid />
                            </View>
                          )}
                          <View style={{ flex: 1 }}>
                            <Text style={styles.builderCardName} numberOfLines={2}>{b.displayName}</Text>
                            {b.place ? (
                              <View style={styles.builderMetaChip}>
                                <FontAwesome5 name="map-marker-alt" size={9} color={SECTION.color} solid />
                                <Text style={styles.builderMetaChipText}>{b.place.label}</Text>
                              </View>
                            ) : null}
                          </View>
                          <View style={styles.builderCountPill}>
                            <Text style={styles.builderCountPillText}>{b.count}</Text>
                          </View>
                        </View>

                        <View style={styles.builderStatsRow}>
                          {span ? <BuilderStat icon="calendar-alt" text={span} /> : null}
                          {b.hullTop ? <BuilderStat icon="ship" text={b.hullTop} /> : null}
                          {b.avgLength ? <BuilderStat icon="ruler-horizontal" text={`${b.avgLength.toFixed(1)} m avg`} /> : null}
                          {b.maxEngine ? <BuilderStat icon="bolt" text={`${Math.round(b.maxEngine)} kW`} /> : null}
                          {b.photos > 0 ? <BuilderStat icon="image" text={`${b.photos}`} /> : null}
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </Section>
            )}
          </>
        )}

        {/* Saved boats row */}
        {saved.length > 0 && !anyFilter && !query.trim() ? (
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
                    const isNowSaved = await toggleSavedBoat(s);
                    track(isNowSaved ? 'item_saved' : 'item_unsaved', { objectType: 'vessel', objectId: s.id });
                    void refreshPrefs();
                  }}
                  onPress={() => router.push(`/boat/${s.id}`)}
                />
              ))}
            </View>
          </Section>
        ) : null}

        {/* Recently viewed row (suppress when same as saved) */}
        {recent.length > 0 && !anyFilter && !query.trim() ? (
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
                    const isNowSaved = await toggleSavedBoat(r);
                    track(isNowSaved ? 'item_saved' : 'item_unsaved', { objectType: 'vessel', objectId: r.id });
                    void refreshPrefs();
                  }}
                  onPress={() => router.push(`/boat/${r.id}`)}
                />
              ))}
            </View>
          </Section>
        ) : null}

        {/* Back to the explore landing when a stat filter is active */}
        {anyFilter && (
          <TouchableOpacity style={styles.backBar} onPress={clearFilters} activeOpacity={0.75}>
            <FontAwesome5 name="chevron-left" size={14} color={SECTION.color} />
            <Text style={styles.backBarText}>Back to explore</Text>
          </TouchableOpacity>
        )}

        {/* Browse */}
        <Section
          title={
            query.trim()
              ? loading ? 'Searching…' : `${filtered.length} found`
              : builderName
                ? `${filtered.length} from ${builderName}`
                : buildPlace
                  ? `${filtered.length} built in ${buildPlaceLabel}`
                  : decade
                    ? `Boats from ${decade}`
                    : photosOnly
                      ? 'Boats with photos'
                      : 'The whole fleet'
          }
          action={anyFilter ? { label: 'Show all', onPress: clearFilters } : undefined}
        >
          {/* Sort control — pure client-side reorder of the loaded list */}
          {!loading && filtered.length > 1 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.sortRow}
              accessibilityLabel="Sort boats"
            >
              {SORT_OPTIONS.map(opt => (
                <Chip
                  key={opt.key}
                  label={opt.label}
                  active={sort === opt.key}
                  onPress={() => setSort(opt.key)}
                />
              ))}
            </ScrollView>
          )}
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
            <View style={[styles.list, isTablet && styles.listGrid]}>
              {filtered.map(r => (
                <VesselCard
                  key={r.id}
                  style={isTablet ? styles.gridCard : undefined}
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

function Section({ title, children, action }: {
  title: string;
  children: React.ReactNode;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {action ? (
          <TouchableOpacity onPress={action.onPress} hitSlop={8}>
            <Text style={styles.sectionAction}>{action.label}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {children}
    </View>
  );
}

function StatTile({ value, label }: { value: string | number; label: string }) {
  return (
    <View
      style={styles.statTile}
      accessible
      accessibilityLabel={`${value} ${label}`}
    >
      <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function BuilderStat({ icon, text }: { icon: string; text: string }) {
  return (
    <View style={styles.builderStat}>
      <FontAwesome5 name={icon as any} size={10} color={colors.textMuted} solid />
      <Text style={styles.builderStatText}>{text}</Text>
    </View>
  );
}

function Chip({
  label, active, onPress,
}: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
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
  container: { flex: 1, backgroundColor: colors.navy },
  scrollBg:  { flex: 1, backgroundColor: colors.screenBackground },
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
  addBoatBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: spacing.md,
    paddingVertical: 14,
    borderRadius: 999,
    backgroundColor: SECTION.color,
  },
  addBoatBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
  },

  chipRow: {
    paddingHorizontal: spacing.lg,
    gap: 8,
  },
  sortRow: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
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
  backBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start',
    marginHorizontal: spacing.lg, marginTop: spacing.md,
    paddingVertical: 8, paddingHorizontal: 14,
    backgroundColor: SECTION.color + '14', borderRadius: radius.full,
  },
  backBarText: { color: SECTION.color, fontSize: fontSize.sm, fontWeight: '800' },

  sectionHeaderRow: {
    flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between',
    paddingRight: spacing.lg,
  },
  sectionAction: { color: SECTION.color, fontSize: fontSize.sm, fontWeight: '800' },

  // ── Explore landing ──
  statsBand: {
    flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm,
    paddingHorizontal: spacing.lg, marginTop: spacing.md, marginBottom: spacing.lg,
  },
  statsBandWide: { maxWidth: 900, alignSelf: 'center', width: '100%' },
  statTile: {
    flexGrow: 1, flexBasis: '22%', minWidth: 78,
    backgroundColor: SECTION.color, borderRadius: radius.lg,
    paddingVertical: 12, paddingHorizontal: 10, alignItems: 'center',
  },
  statValue: { color: '#fff', fontSize: 20, fontWeight: '900' },
  statLabel: { color: 'rgba(255,255,255,0.75)', fontSize: 10, fontWeight: '700', marginTop: 2, textAlign: 'center' },
  exploreCaption: { paddingHorizontal: spacing.lg, fontSize: fontSize.sm, color: colors.textMuted },

  // Community / help-improve note
  helpCard: {
    flexDirection: 'row', gap: 12, alignItems: 'flex-start',
    marginHorizontal: spacing.lg, marginBottom: spacing.lg,
    backgroundColor: SECTION.color + '10', borderRadius: radius.lg,
    borderWidth: 1, borderColor: SECTION.color + '24', padding: 14,
  },
  helpIcon: {
    width: 34, height: 34, borderRadius: 17, flexShrink: 0,
    backgroundColor: SECTION.color + '1F', alignItems: 'center', justifyContent: 'center',
  },
  helpTitle: { fontSize: fontSize.sm, fontWeight: '900', color: colors.textPrimary, marginBottom: 3 },
  helpBody:  { fontSize: fontSize.xs, color: colors.textSecondary, lineHeight: 18 },

  // Decade histogram
  histo: {
    flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between',
    gap: 6, paddingHorizontal: spacing.lg, minHeight: 150,
  },
  histoCol: { flex: 1, alignItems: 'center', gap: 4 },
  histoCount: { fontSize: 11, fontWeight: '800', color: colors.textSecondary },
  histoBar: { width: '70%', backgroundColor: SECTION.color, borderRadius: 4, minHeight: 10 },
  histoLabel: { fontSize: 9, fontWeight: '700', color: colors.textMuted },

  // Hull split
  hullRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  hullLabel: { width: 78, fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  hullTrack: { flex: 1, height: 14, backgroundColor: '#E5E9EF', borderRadius: 7, overflow: 'hidden' },
  hullFill: { height: 14, backgroundColor: SECTION.color, borderRadius: 7 },
  hullCount: { width: 34, textAlign: 'right', fontSize: fontSize.sm, fontWeight: '800', color: colors.textSecondary },

  // Top yards — rich cards
  builderGrid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  builderCard: {
    width: '100%',
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: 14, gap: 10,
  },
  builderCardHalf: { width: '48.7%' },
  builderCardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  builderThumb: { width: 52, height: 52, borderRadius: radius.md, backgroundColor: '#dce6ef', flexShrink: 0 },
  builderThumbEmpty: { backgroundColor: SECTION.color + '14', alignItems: 'center', justifyContent: 'center' },
  builderIcon: { width: 30, height: 30, borderRadius: 15, backgroundColor: SECTION.color + '18', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  builderCardName: { flex: 1, fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary, lineHeight: 19 },
  builderCountPill: { backgroundColor: SECTION.color, borderRadius: radius.full, minWidth: 30, paddingHorizontal: 9, paddingVertical: 3, alignItems: 'center' },
  builderCountPillText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '900' },
  builderMetaChip: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', backgroundColor: SECTION.color + '12', borderRadius: radius.full, paddingHorizontal: 9, paddingVertical: 4, marginTop: 5 },
  builderMetaChipText: { color: SECTION.color, fontSize: 11, fontWeight: '700' },
  builderStatsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  builderStat: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  builderStatText: { fontSize: fontSize.xs, color: colors.textSecondary, fontWeight: '600' },

  list: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  listGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    maxWidth: 1000,
    alignSelf: 'center',
    width: '100%',
  },
  gridCard: { width: '48%' },

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
