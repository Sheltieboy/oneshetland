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

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator,
  TouchableOpacity, RefreshControl, TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Stack, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { SECTIONS } from '@/constants/sections';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { useAuth } from '@/context/AuthContext';
import { VIEW_BOUNDS } from '@/lib/shetland-geometry';
import {
  fetchMemoryPins, MemoryPin,
  searchMemories, MemorySearchResult,
} from '@/lib/memories-api';
import MemoryMapNative from '@/components/MemoryMapNative';
import MemoryCard from '@/components/MemoryCard';

const SECTION = SECTIONS.memories;

export default function MemoriesScreen() {
  const router = useRouter();
  const { profile } = useAuth();

  const [pins, setPins]       = useState<MemoryPin[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Search state. A non-empty query swaps the feed for search results
  // and hides the "Latest" heading. Searches DB title/body/era/tags AND
  // resolved photo-tag answers via the search_memories RPC.
  const [query, setQuery]               = useState('');
  const [results, setResults]           = useState<MemorySearchResult[] | null>(null);
  const [searching, setSearching]       = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchMemoryPins({
        minLat: VIEW_BOUNDS.minLat,
        maxLat: VIEW_BOUNDS.maxLat,
        minLng: VIEW_BOUNDS.minLng,
        maxLng: VIEW_BOUNDS.maxLng,
      });
      setPins(data);
    } catch {
      // Surface to UI? For now silently empty — the empty state is OK to show.
      setPins([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Reload on every focus — coming back from creating a memory should show it.
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  useEffect(() => { void load(); }, [load]);

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
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 280);
    return () => clearTimeout(handle);
  }, [query]);

  const onPinTap = (pin: MemoryPin) => {
    setSelectedId(pin.id);
    router.push(`/memory/${pin.id}`);
  };

  const onDropPin = (point: { lat: number; lng: number }) => {
    if (!profile?.id) {
      router.push('/(auth)/sign-in');
      return;
    }
    router.push({
      pathname: '/memory-new',
      params: { lat: String(point.lat), lng: String(point.lng) },
    });
  };

  const recent = pins.slice(0, 12);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); void load(); }}
            tintColor={SECTION.color}
          />
        }
      >
        {/* ── Hero header ─────────────────────────────────────────────── */}
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.eyebrow}>The living map</Text>
            <Text style={styles.title}>Memories</Text>
          </View>
          <View style={[styles.iconBadge, { backgroundColor: SECTION.light }]}>
            <FontAwesome5 name={SECTION.icon} size={20} color={SECTION.color} />
          </View>
        </View>

        <Text style={styles.intro}>
          Drop a pin anywhere on Shetland. Write a story, leave a voice note,
          attach a photo or a film. Ask the community to help you remember.
        </Text>

        {/* ── The map ─────────────────────────────────────────────────── */}
        <View style={styles.mapWrap}>
          {loading ? (
            <View style={styles.mapLoading}>
              <ActivityIndicator color={SECTION.color} />
            </View>
          ) : (
            <MemoryMapNative
              pins={pins}
              onOpenPin={onPinTap}
              onDropPin={onDropPin}
              selectedId={selectedId}
              height={460}
            />
          )}
        </View>

        {/* CTA underneath the map */}
        <TouchableOpacity
          onPress={() => router.push('/memory-new')}
          style={[styles.dropCta, { backgroundColor: SECTION.color }]}
        >
          <FontAwesome5 name="plus" size={14} color="#fff" />
          <Text style={styles.dropCtaText}>Add a memory</Text>
        </TouchableOpacity>

        {/* ── Search ──────────────────────────────────────────────────── */}
        <View style={styles.searchWrap}>
          <View style={styles.searchBar}>
            <FontAwesome5 name="search" size={14} color={colors.textMuted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search memories — names, places, themes…"
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
                  onPress={() => router.push(`/memory/${r.id}`)}
                />
              ))}
            </View>
          </>
        ) : (
          <>
            <Text style={styles.sectionHeading}>Latest from the islands</Text>
            {recent.length === 0 && !loading ? (
              <View style={styles.empty}>
                <FontAwesome5 name="book-open" size={28} color={SECTION.color} />
                <Text style={styles.emptyTitle}>No memories yet</Text>
                <Text style={styles.emptyBody}>
                  Be the first. Tap anywhere on the map above to drop a pin and start a memory.
                </Text>
              </View>
            ) : (
              <View style={styles.feed}>
                {recent.map(pin => (
                  <MemoryCard
                    key={pin.id}
                    pin={pin}
                    onPress={() => router.push(`/memory/${pin.id}`)}
                  />
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>
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
          {result.title ?? result.body_excerpt ?? 'Untitled memory'}
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
    backgroundColor: colors.screenBackground,
  },
  scroll: {
    paddingBottom: spacing.xxl,
  },
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
  },
  dropCtaText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: fontSize.md,
  },
  sectionHeading: {
    marginTop: spacing.xl,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    fontSize: fontSize.lg,
    fontWeight: '800',
    color: colors.textPrimary,
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
});
