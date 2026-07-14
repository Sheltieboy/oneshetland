/**
 * app/memories.tsx
 *
 * The Memories section landing page — a living map of Shetland covered
 * in rose-pink pins, one per memory. Tap a pin to open the memory; tap
 * empty water/land to drop a new memory at that lat/lng. Below the map
 * is a feed of the most recent memories across the islands.
 *
 * Designed so it can also be reached as a tab once the tabs layout adds
 * a "memories" tab (wiring left as a follow-up to avoid colliding with
 * an in-flight uncommitted edit to that file).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator,
  TouchableOpacity, RefreshControl, TextInput, Animated, Easing,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Stack, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { SECTIONS } from '@/constants/sections';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { useGoToSignIn } from '@/hooks/useGoToSignIn';
import { useAuth } from '@/context/AuthContext';
import { VIEW_BOUNDS } from '@/lib/shetland-geometry';
import {
  fetchMemoryPins, MemoryPin,
  searchMemories, MemorySearchResult,
} from '@/lib/memories-api';
import { ShetlandPlace, PLACE_CATEGORY_LABEL } from '@/lib/places-api';
import MemoryMapNative from '@/components/MemoryMapNative';
import MemoryCard from '@/components/MemoryCard';
import SectionHero from '@/components/SectionHero';
import { TabScreenHeader } from '@/components/TabScreenHeader';
import { SECTION_HEROES } from '@/constants/section-heroes';
import { track } from '@/lib/analytics';
import MemoryDetailScreen from '../memory/[id]';
import { eraTone } from '@/lib/memory-eras';

const memoriesHero = SECTION_HEROES.memories;

const SECTION = SECTIONS.memories;

export default function MemoriesScreen() {
  const router = useRouter();
  const goToSignIn = useGoToSignIn();
  const { profile } = useAuth();
  const { isTablet, screenWidth, screenHeight } = useAppLayout();
  const isLandscape = screenWidth > screenHeight;
  const twoPane = isTablet && isLandscape;
  // In two-pane mode the selected memory opens in the right pane instead of
  // navigating to its own screen.
  const [detailId, setDetailId] = useState<string | null>(null);

  // Subtle fade + slide whenever the right pane swaps between feed and detail.
  const paneAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    paneAnim.setValue(0);
    Animated.timing(paneAnim, {
      toValue: 1,
      duration: 240,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [detailId, paneAnim]);

  const [pins, setPins]       = useState<MemoryPin[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Search state. A non-empty query swaps the feed for search results
  // and hides the "Latest" heading. Searches DB title/body/era/tags AND
  // resolved photo-tag answers via the search_memories RPC.
  const [query, setQuery]               = useState('');
  const [results, setResults]           = useState<MemorySearchResult[] | null>(null);
  const [searching, setSearching]       = useState(false);

  // When a place is picked from the map's search box, surface the memories
  // sitting within a tight bbox around it ("Memories near Hillswick").
  const [nearPlace, setNearPlace]       = useState<ShetlandPlace | null>(null);
  const [nearby, setNearby]             = useState<MemoryPin[]>([]);
  const [nearbyLoading, setNearbyLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchMemoryPins({
        minLat: VIEW_BOUNDS.minLat,
        maxLat: VIEW_BOUNDS.maxLat,
        minLng: VIEW_BOUNDS.minLng,
        maxLng: VIEW_BOUNDS.maxLng,
      });
      setPins(data);
      setLoadError(false);
    } catch {
      // A genuine failure (network down / RPC error) is NOT the same as
      // "no stories yet" — flag it so the feed can offer a retry instead of
      // wrongly telling folk to be the first.
      setLoadError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Reload on every focus — coming back from creating a memory should show it.
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  useEffect(() => { void load(); }, [load]);

  // ── Memories near picked place ──────────────────────────────────────────
  // Roughly ±0.04° → ~4.4 km north-south, ~2.2 km east-west at 60°N.
  // Wide enough to cover a parish, narrow enough that we're talking about
  // "near here", not "on this island".
  useEffect(() => {
    if (!nearPlace) { setNearby([]); return; }
    setNearbyLoading(true);
    void (async () => {
      try {
        const lat = Number(nearPlace.lat);
        const lng = Number(nearPlace.lng);
        const r = await fetchMemoryPins({
          minLat: lat - 0.04,
          maxLat: lat + 0.04,
          minLng: lng - 0.04,
          maxLng: lng + 0.04,
        }, 30);
        setNearby(r);
      } catch {
        setNearby([]);
      } finally {
        setNearbyLoading(false);
      }
    })();
  }, [nearPlace]);

  // ── Search (debounced) ───────────────────────────────────────────────────
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const r = await searchMemories(q);
        setResults(r);
        track('search_performed', { props: { section: 'memories', query: q, results_count: r.length } });
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 280);
    return () => clearTimeout(handle);
  }, [query]);

  const openMemory = (mid: string) => {
    setSelectedId(mid);
    if (twoPane) setDetailId(mid);
    else router.push(`/memory/${mid}`);
  };

  const onPinTap = (pin: MemoryPin) => openMemory(pin.id);

  const onDropPin = (point: { lat: number; lng: number }) => {
    if (!profile?.id) {
      goToSignIn();
      return;
    }
    router.push({
      pathname: '/memory-new',
      params: { lat: String(point.lat), lng: String(point.lng) },
    });
  };

  const recent = pins.slice(0, 12);
  // Distinct eras present, for the "Explore by era" chip row.
  const eras = Array.from(new Set(pins.map(p => p.era).filter(Boolean) as string[])).slice(0, 10);

  const mapPane = (mapHeight: number) => (
    <>
      <View style={styles.mapWrap}>
        {loading ? (
          <View style={[styles.mapLoading, { height: mapHeight }]}>
            <ActivityIndicator color={SECTION.color} />
          </View>
        ) : (
          <MemoryMapNative
            pins={pins}
            onOpenPin={onPinTap}
            onDropPin={onDropPin}
            onPlacePicked={(p) => setNearPlace(p)}
            selectedId={selectedId}
            height={mapHeight}
          />
        )}
      </View>

      <TouchableOpacity
        onPress={() => router.push('/memory-new')}
        style={[styles.dropCta, { backgroundColor: SECTION.color }]}
      >
        <FontAwesome5 name="plus" size={14} color="#fff" />
        <Text style={styles.dropCtaText}>Add a story</Text>
      </TouchableOpacity>
    </>
  );

  const refreshCtl = (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={() => { setRefreshing(true); void load(); }}
      tintColor={SECTION.color}
    />
  );

  const feedContent = (
    <>
        {/* ── Search ──────────────────────────────────────────────────── */}
        <View style={styles.searchWrap}>
          <View style={styles.searchBar}>
            <FontAwesome5 name="search" size={14} color={colors.textMuted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search auld stories — names, places, themes…"
              placeholderTextColor={colors.textLight}
              style={styles.searchInput}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
            />
            {query ? (
              <TouchableOpacity onPress={() => setQuery('')} hitSlop={8}>
                <FontAwesome5 name="times-circle" size={14} color={colors.textMuted} solid />
              </TouchableOpacity>
            ) : null}
          </View>
          {query ? (
            <Text style={styles.searchHint}>
              Searches stories, eras, tags and the names tagged onto photos.
            </Text>
          ) : null}
        </View>

        {/* ── Memories near picked place ────────────────────────────── */}
        {nearPlace ? (
          <View style={styles.nearWrap}>
            <View style={styles.nearHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.nearEyebrow}>Auld stories near</Text>
                <Text style={styles.nearTitle}>
                  {nearPlace.name}
                  <Text style={styles.nearSub}>
                    {nearPlace.region ? ` · ${nearPlace.region.replace(/\b\w/g, c => c.toUpperCase())}` : ''}
                  </Text>
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => setNearPlace(null)}
                hitSlop={10}
                style={styles.nearClose}
              >
                <FontAwesome5 name="times" size={14} color={colors.textMuted} />
              </TouchableOpacity>
            </View>

            {nearbyLoading ? (
              <ActivityIndicator color={SECTION.color} style={{ marginTop: spacing.sm }} />
            ) : nearby.length === 0 ? (
              <View style={[styles.empty, { marginHorizontal: 0, marginTop: spacing.sm }]}>
                <FontAwesome5 name="book-open" size={22} color={SECTION.color} />
                <Text style={styles.emptyTitle}>No stories here yet</Text>
                <Text style={styles.emptyBody}>
                  Be the first — tap on the map above to drop a pin near {nearPlace.name}.
                </Text>
              </View>
            ) : (
              <View style={[styles.feed, { paddingHorizontal: 0, marginTop: spacing.sm }]}>
                {nearby.map(pin => (
                  <MemoryCard
                    key={pin.id}
                    pin={pin}
                    onPress={() => openMemory(pin.id)}
                  />
                ))}
              </View>
            )}
          </View>
        ) : null}

        {/* ── Results OR recent feed ──────────────────────────────────── */}
        {results !== null ? (
          <>
            <Text style={styles.sectionHeading}>
              {searching
                ? 'Searching…'
                : results.length
                  ? `${results.length} result${results.length === 1 ? '' : 's'}`
                  : 'No matches'}
            </Text>
            <View style={styles.feed}>
              {results.map(r => (
                <SearchResultRow
                  key={r.id}
                  result={r}
                  onPress={() => openMemory(r.id)}
                />
              ))}
            </View>
          </>
        ) : (
          <>
            {/* Explore by era — quick filters drawn from what's actually pinned */}
            {eras.length > 1 ? (
              <View style={styles.eraRowWrap}>
                <Text style={styles.eraRowLabel}>Explore by era</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.eraRow}
                >
                  {eras.map(era => {
                    const tone = eraTone(era);
                    return (
                      <TouchableOpacity
                        key={era}
                        onPress={() => setQuery(era)}
                        activeOpacity={0.8}
                        style={[styles.eraPill, { backgroundColor: tone.light, borderColor: tone.color + '33' }]}
                      >
                        <FontAwesome5 name={tone.icon as any} size={11} color={tone.color} solid />
                        <Text style={[styles.eraPillText, { color: tone.color }]}>{era}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>
            ) : null}

            <View style={styles.headingRow}>
              <Text style={styles.sectionHeading}>Latest from the islands</Text>
              {recent.length > 0 ? (
                <Text style={styles.headingCount}>{pins.length} pinned</Text>
              ) : null}
            </View>

            {loadError && pins.length === 0 && !loading ? (
              <View style={styles.empty}>
                <FontAwesome5 name="cloud-rain" size={28} color={SECTION.color} />
                <Text style={styles.emptyTitle}>Couldna load the stories</Text>
                <Text style={styles.emptyBody}>
                  Something went agley fetching the auld stories — likely a
                  blink in the connection. Pull doon to try again.
                </Text>
                <TouchableOpacity
                  onPress={() => { setLoading(true); void load(); }}
                  style={[styles.retryBtn, { backgroundColor: SECTION.color }]}
                >
                  <FontAwesome5 name="redo" size={13} color="#fff" />
                  <Text style={styles.retryBtnText}>Try again</Text>
                </TouchableOpacity>
              </View>
            ) : recent.length === 0 && !loading ? (
              <View style={styles.empty}>
                <FontAwesome5 name="book-open" size={28} color={SECTION.color} />
                <Text style={styles.emptyTitle}>No stories yet</Text>
                <Text style={styles.emptyBody}>
                  Be the first. Tap anywhere on the map above to drop a pin and start a story.
                </Text>
              </View>
            ) : (
              <View style={styles.feed}>
                {recent[0] ? (
                  <MemoryCard
                    key={recent[0].id}
                    pin={recent[0]}
                    variant="full"
                    onPress={() => openMemory(recent[0].id)}
                  />
                ) : null}
                {recent.slice(1).map(pin => (
                  <MemoryCard
                    key={pin.id}
                    pin={pin}
                    onPress={() => openMemory(pin.id)}
                  />
                ))}
              </View>
            )}
          </>
        )}
    </>
  );

  return (
    <SafeAreaView style={styles.container} edges={[]}>
      <Stack.Screen options={{ headerShown: false }} />

      {twoPane ? (
        // Landscape tablet: cinematic header on top; map pinned left; right pane
        // shows the feed, or the selected memory's full detail in place.
        <View style={styles.twoPaneWrap}>
          <TabScreenHeader section={SECTIONS.memories} photo={memoriesHero} eyebrow="The living map" />
          <View style={styles.splitRow}>
          <View style={styles.mapCol}>
            {mapPane(screenHeight - 368)}
          </View>
          <View style={styles.feedCol}>
            <Animated.View
              style={{
                flex: 1,
                opacity: paneAnim,
                transform: [{
                  translateX: paneAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [detailId ? 16 : -16, 0],
                  }),
                }],
              }}
            >
              {detailId ? (
                <MemoryDetailScreen
                  idOverride={detailId}
                  embedded
                  onClose={() => setDetailId(null)}
                />
              ) : (
                <ScrollView
                  style={{ flex: 1 }}
                  contentContainerStyle={styles.feedColContent}
                  refreshControl={refreshCtl}
                  showsVerticalScrollIndicator={false}
                >
                  {feedContent}
                </ScrollView>
              )}
            </Animated.View>
          </View>
        </View>
        </View>
      ) : (
        <ScrollView
          style={styles.twoPaneWrap}
          contentContainerStyle={[styles.scroll, isTablet && styles.scrollTablet]}
          refreshControl={refreshCtl}
        >
          <SectionHero
            section="memories"
            title="Auld Stories"
            eyebrow="The living map"
            photo={memoriesHero}
          />
          <Text style={styles.intro}>
            Drop a pin anywhere on Shetland. Write a story, leave a voice note,
            attach a photo or a film. Ask the community to help you remember.
          </Text>
          {mapPane(460)}
          {feedContent}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ── Search result row ──────────────────────────────────────────────────────

function SearchResultRow({
  result, onPress,
}: {
  result: MemorySearchResult;
  onPress: () => void;
}) {
  const matchLabel = (() => {
    switch (result.matched_via) {
      case 'title':      return 'Matched title';
      case 'body':       return 'Matched story';
      case 'era':        return 'Matched era';
      case 'tag':        return 'Matched theme';
      case 'photo_tag':  return 'Tagged in photo';
      default:           return null;
    }
  })();

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={styles.searchRow}>
      <View style={[styles.searchThumb, { backgroundColor: SECTION.light }]}>
        {result.hero_url && result.hero_kind === 'photo' ? null : (
          <FontAwesome5
            name={
              result.hero_kind === 'audio' ? 'microphone' :
              result.hero_kind === 'video' ? 'video' :
              'book-open'
            }
            size={16}
            color={SECTION.color}
          />
        )}
      </View>
      <View style={{ flex: 1 }}>
        {result.place_name ? (
          <Text style={styles.searchPlace} numberOfLines={1}>
            {result.place_name}
          </Text>
        ) : null}
        <Text style={styles.searchTitle} numberOfLines={1}>
          {result.title ?? result.body_excerpt ?? 'Untitled story'}
        </Text>
        <View style={styles.searchMetaRow}>
          {matchLabel ? (
            <View style={[styles.matchChip, { backgroundColor: SECTION.light }]}>
              <Text style={[styles.matchChipText, { color: SECTION.color }]}>{matchLabel}</Text>
            </View>
          ) : null}
          {result.era ? <Text style={styles.searchMeta}>{result.era}</Text> : null}
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.navy,
  },
  twoPaneWrap: { flex: 1, backgroundColor: colors.screenBackground },
  scroll: {
    paddingBottom: spacing.xxl,
  },
  scrollTablet: { maxWidth: 860, alignSelf: 'center', width: '100%' },
  // Landscape tablet two-pane
  splitRow: { flex: 1, flexDirection: 'row' },
  mapCol: { width: '52%', paddingTop: spacing.md },
  feedCol: { flex: 1, borderLeftWidth: 1, borderLeftColor: colors.border },
  feedColContent: { paddingTop: spacing.md, paddingBottom: spacing.xxl },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.md,
  },
  backBtn: {
    width: 36, height: 36, alignItems: 'center', justifyContent: 'center',
    borderRadius: 18,
  },
  eyebrow: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: SECTION.color,
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
    marginBottom: spacing.lg,
  },
  mapWrap: {
    paddingHorizontal: spacing.lg,
  },
  mapLoading: {
    height: 460,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#DCEEFF',
    borderRadius: 12,
  },
  dropCta: {
    marginTop: spacing.md,
    marginHorizontal: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    gap: 10,
    shadowColor: SECTION.color,
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  dropCtaText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: fontSize.md,
  },
  sectionHeading: {
    fontSize: fontSize.lg,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  headingRow: {
    marginTop: spacing.xl,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  headingCount: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: SECTION.color,
  },
  eraRowWrap: {
    marginTop: spacing.xl,
  },
  eraRowLabel: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    fontSize: fontSize.xs,
    fontWeight: '800',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  eraRow: {
    paddingHorizontal: spacing.lg,
    gap: 8,
  },
  eraPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  eraPillText: {
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  feed: {
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  searchWrap: {
    paddingHorizontal: spacing.lg,
    marginTop: spacing.lg,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  searchInput: {
    flex: 1,
    fontSize: fontSize.sm,
    color: colors.textPrimary,
    paddingVertical: 0,
  },
  searchHint: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 6,
  },
  nearWrap: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  nearHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  nearEyebrow: {
    fontSize: 10,
    fontWeight: '800',
    color: SECTION.color,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  nearTitle: {
    fontSize: fontSize.lg,
    fontWeight: '800',
    color: colors.textPrimary,
    marginTop: 2,
  },
  nearSub: {
    fontSize: fontSize.sm,
    fontWeight: '500',
    color: colors.textMuted,
  },
  nearClose: {
    width: 32, height: 32,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: 16,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
  },
  searchThumb: {
    width: 48, height: 48, borderRadius: radius.sm,
    alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
  },
  searchPlace: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: SECTION.color,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  searchTitle: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  searchMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 3,
  },
  searchMeta: {
    fontSize: 11,
    color: colors.textMuted,
  },
  matchChip: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
  },
  matchChipText: {
    fontSize: 10,
    fontWeight: '700',
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
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    marginTop: spacing.xs,
  },
  retryBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: fontSize.sm,
  },
});
