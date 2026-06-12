/**
 * app/search.tsx — App search (Phase 1: business directory).
 *
 * Pre-query, this is a discovery hub: browse-by-category, popular trades,
 * recently viewed, and featured businesses — so the screen is useful and full
 * before anyone types. As you type, it ranks the preloaded directory
 * client-side (instant). Results group by type so future sources slot in.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView,
  ActivityIndicator, Keyboard, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import {
  fetchActiveBusinesses, CATEGORY_LABELS, CATEGORY_ICONS,
  type LocalBusiness, type LocalCategory,
} from '@/lib/local-api';
import {
  searchBusinesses, groupResults, businessResult, getRecentlyViewed, addRecentlyViewed,
  RESULT_GROUP_LABEL, type SearchResult,
} from '@/lib/search';

const ACCENT = '#7C3AED';
const RECENT_KEY = 'search_recent_v1';
const QUICK_TRADES = ['Plumbing', 'Joinery', 'Building', 'Electrical', 'Cleaning', 'Hair & Beauty', 'Catering', 'Car Repair & MOT'];

const CATEGORY_COLOR: Record<LocalCategory, string> = {
  food_drink:    '#C2410C',
  retail:        '#7C3AED',
  services:      '#0E7490',
  tourism:       '#15803D',
  accommodation: '#4338CA',
  other:         '#475569',
};
const CATEGORY_ORDER: LocalCategory[] = ['services', 'food_drink', 'retail', 'tourism', 'accommodation', 'other'];

export default function SearchScreen() {
  const router = useRouter();
  const { isTablet, screenWidth } = useAppLayout();

  const [query, setQuery]           = useState('');
  const [businesses, setBusiness]   = useState<LocalBusiness[]>([]);
  const [loading, setLoading]       = useState(true);
  const [recent, setRecent]         = useState<string[]>([]);
  const [viewed, setViewed]         = useState<SearchResult[]>([]);
  const [activeCat, setActiveCat]   = useState<LocalCategory | null>(null);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    fetchActiveBusinesses()
      .then(setBusiness)
      .catch(() => setBusiness([]))
      .finally(() => setLoading(false));
    AsyncStorage.getItem(RECENT_KEY).then(v => { if (v) setRecent(JSON.parse(v)); }).catch(() => {});
    getRecentlyViewed().then(setViewed);
    const t = setTimeout(() => inputRef.current?.focus(), 350);
    return () => clearTimeout(t);
  }, []);

  const hasQuery = query.trim().length > 0;
  const mode: 'query' | 'category' | 'hub' = hasQuery ? 'query' : activeCat ? 'category' : 'hub';

  const results = useMemo(() => {
    if (mode === 'query') return searchBusinesses(businesses, query);
    if (mode === 'category') {
      return businesses
        .filter(b => b.category === activeCat)
        .sort((a, z) => (z.is_verified ? 1 : 0) - (a.is_verified ? 1 : 0) || a.name.localeCompare(z.name))
        .map(businessResult);
    }
    return [];
  }, [mode, businesses, query, activeCat]);

  const groups   = useMemo(() => groupResults(results), [results]);
  const featured = useMemo(
    () => businesses.filter(b => b.is_verified).slice(0, 6).map(businessResult),
    [businesses],
  );

  // Per-category counts for the browse grid.
  const catCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const b of businesses) m[b.category] = (m[b.category] ?? 0) + 1;
    return m;
  }, [businesses]);

  // Full directory listing for the hub — verified first, then A–Z.
  const allBusinesses = useMemo(
    () => [...businesses]
      .sort((a, z) => (z.is_verified ? 1 : 0) - (a.is_verified ? 1 : 0) || a.name.localeCompare(z.name))
      .map(businessResult),
    [businesses],
  );

  const rememberSearch = useCallback(async (term: string) => {
    const t = term.trim();
    if (!t) return;
    const next = [t, ...recent.filter(r => r.toLowerCase() !== t.toLowerCase())].slice(0, 8);
    setRecent(next);
    try { await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch {}
  }, [recent]);

  const openResult = useCallback((r: SearchResult) => {
    if (hasQuery) rememberSearch(query);
    addRecentlyViewed(r);
    Keyboard.dismiss();
    router.push(r.route);
  }, [hasQuery, query, rememberSearch, router]);

  const clearRecent = useCallback(async () => {
    setRecent([]);
    try { await AsyncStorage.removeItem(RECENT_KEY); } catch {}
  }, []);

  // Tablet: centre content in a readable column instead of spanning the screen.
  const maxW = isTablet ? Math.min(720, screenWidth - spacing.lg * 2) : undefined;

  const ResultRow = ({ item }: { item: SearchResult }) => (
    <TouchableOpacity style={styles.resultRow} onPress={() => openResult(item)} activeOpacity={0.7}>
      <View style={[styles.resultIcon, { backgroundColor: item.color + '18' }]}>
        <FontAwesome5 name={item.icon as any} size={15} color={item.color} solid />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.resultTitle} numberOfLines={1}>{item.title}</Text>
        <Text style={styles.resultSub} numberOfLines={1}>{item.subtitle}</Text>
      </View>
      <FontAwesome5 name="chevron-right" size={12} color={colors.textLight} />
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Navy header — brand + search box */}
      <View style={styles.header}>
        <View style={maxW ? { width: maxW, alignSelf: 'center' } : undefined}>
          <View style={styles.brandRow}>
            <Image source={require('../assets/icon.png')} style={styles.brandLogo} resizeMode="contain" />
            <View style={{ flex: 1 }}>
              <Text style={styles.brandName}>OneShetland</Text>
              <Text style={styles.brandSub}>Find a local business or service</Text>
            </View>
            <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))} hitSlop={10}>
              <Text style={styles.cancel}>Cancel</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.searchBar}>
            <FontAwesome5 name="search" size={15} color={colors.textMuted} />
            <TextInput
              ref={inputRef}
              style={styles.searchInput}
              value={query}
              onChangeText={t => { setQuery(t); if (t) setActiveCat(null); }}
              placeholder="Search businesses, trades, services…"
              placeholderTextColor={colors.textLight}
              returnKeyType="search"
              autoCorrect={false}
              onSubmitEditing={() => rememberSearch(query)}
            />
            {(query.length > 0 || activeCat) && (
              <TouchableOpacity onPress={() => { setQuery(''); setActiveCat(null); }} hitSlop={10}>
                <FontAwesome5 name="times-circle" size={16} color={colors.textMuted} solid />
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>

      <ScrollView
        style={{ flex: 1, backgroundColor: colors.screenBackground }}
        contentContainerStyle={[styles.scrollContent, maxW ? { width: maxW, alignSelf: 'center' } : null]}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Discovery hub ── */}
        {mode === 'hub' && (
          <>
            <Text style={styles.sectionLabel}>Browse by category</Text>
            <View style={styles.catGrid}>
              {CATEGORY_ORDER.map(cat => (
                <TouchableOpacity
                  key={cat}
                  style={[styles.catCard, { flexBasis: isTablet ? '31%' : '47%' }]}
                  onPress={() => { Keyboard.dismiss(); setActiveCat(cat); }}
                  activeOpacity={0.85}
                >
                  <View style={[styles.catIcon, { backgroundColor: CATEGORY_COLOR[cat] + '18' }]}>
                    <FontAwesome5 name={CATEGORY_ICONS[cat] as any} size={18} color={CATEGORY_COLOR[cat]} solid />
                  </View>
                  <Text style={styles.catLabel} numberOfLines={2}>{CATEGORY_LABELS[cat]}</Text>
                  {(catCounts[cat] ?? 0) > 0 && (
                    <Text style={styles.catCount}>{catCounts[cat]}</Text>
                  )}
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.sectionLabel}>Popular trades</Text>
            <View style={styles.chipWrap}>
              {QUICK_TRADES.map(t => (
                <TouchableOpacity key={t} style={styles.chip} onPress={() => setQuery(t)} activeOpacity={0.8}>
                  <Text style={styles.chipText}>{t}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {viewed.length > 0 && (
              <>
                <Text style={styles.sectionLabel}>Recently viewed</Text>
                {viewed.map(item => <ResultRow key={`v-${item.id}`} item={item} />)}
              </>
            )}

            {recent.length > 0 && (
              <>
                <View style={styles.recentHeader}>
                  <Text style={styles.sectionLabel}>Recent searches</Text>
                  <TouchableOpacity onPress={clearRecent} hitSlop={8}><Text style={styles.clearText}>Clear</Text></TouchableOpacity>
                </View>
                {recent.map(r => (
                  <TouchableOpacity key={r} style={styles.recentRow} onPress={() => setQuery(r)} activeOpacity={0.7}>
                    <FontAwesome5 name="history" size={13} color={colors.textMuted} />
                    <Text style={styles.recentText}>{r}</Text>
                  </TouchableOpacity>
                ))}
              </>
            )}

            {featured.length > 0 && (
              <>
                <Text style={styles.sectionLabel}>Featured businesses</Text>
                {featured.map(item => <ResultRow key={`f-${item.id}`} item={item} />)}
              </>
            )}

            {allBusinesses.length > 0 && (
              <>
                <Text style={styles.sectionLabel}>
                  All businesses
                  <Text style={styles.groupCount}>  {allBusinesses.length}</Text>
                </Text>
                {allBusinesses.map(item => <ResultRow key={`all-${item.id}`} item={item} />)}
              </>
            )}
          </>
        )}

        {/* ── Category browse ── */}
        {mode === 'category' && activeCat && (
          <>
            <View style={styles.catHeader}>
              <Text style={styles.groupTitle}>{CATEGORY_LABELS[activeCat]}
                <Text style={styles.groupCount}>  {results.length}</Text>
              </Text>
              <TouchableOpacity onPress={() => setActiveCat(null)} hitSlop={8}>
                <Text style={styles.clearText}>All categories</Text>
              </TouchableOpacity>
            </View>
            {results.length === 0
              ? <Text style={styles.emptyBody}>No businesses listed here yet.</Text>
              : results.map(item => <ResultRow key={item.id} item={item} />)}
          </>
        )}

        {/* ── Query results ── */}
        {mode === 'query' && (
          loading ? (
            <View style={styles.center}><ActivityIndicator color={ACCENT} /></View>
          ) : results.length === 0 ? (
            <View style={styles.empty}>
              <FontAwesome5 name="search" size={32} color={colors.textLight} />
              <Text style={styles.emptyTitle}>No matches for “{query.trim()}”</Text>
              <Text style={styles.emptyBody}>Try a trade like “plumber” or a business name.</Text>
            </View>
          ) : (
            groups.map(group => (
              <View key={group.type} style={{ marginTop: spacing.lg }}>
                <Text style={styles.groupTitle}>
                  {RESULT_GROUP_LABEL[group.type]}<Text style={styles.groupCount}>  {group.items.length}</Text>
                </Text>
                {group.items.map(item => <ResultRow key={item.id} item={item} />)}
              </View>
            ))
          )
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },

  header: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    borderBottomWidth: 3,
    borderBottomColor: ACCENT,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: spacing.md },
  brandLogo: { width: 36, height: 36, borderRadius: 9 },
  brandName: { color: '#fff', fontSize: fontSize.md, fontWeight: '900', letterSpacing: -0.3 },
  brandSub: { color: 'rgba(255,255,255,0.55)', fontSize: fontSize.xs, fontWeight: '600', marginTop: 1 },

  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#fff', borderRadius: radius.full,
    paddingHorizontal: 14, paddingVertical: 11,
  },
  searchInput: { flex: 1, fontSize: fontSize.md, color: colors.textPrimary, padding: 0 },
  cancel: { fontSize: fontSize.sm, fontWeight: '700', color: '#fff' },

  scrollContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl },

  sectionLabel: { fontSize: fontSize.xs, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: spacing.lg, marginBottom: 10 },

  catGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  catCard: {
    flexGrow: 1,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: 12,
  },
  catIcon: { width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  catLabel: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary, flexShrink: 1 },
  catCount: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textLight, marginLeft: 'auto' },

  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { backgroundColor: '#fff', borderRadius: radius.full, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 9 },
  chipText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },

  recentHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  clearText: { fontSize: fontSize.xs, fontWeight: '700', color: ACCENT, marginTop: spacing.lg },
  recentRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11 },
  recentText: { flex: 1, fontSize: fontSize.md, color: colors.textPrimary },

  catHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.lg, marginBottom: 8 },
  groupTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary, marginBottom: 8 },
  groupCount: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textLight },

  resultRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: 12, marginBottom: 8,
  },
  resultIcon: { width: 42, height: 42, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  resultTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  resultSub: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },

  center: { paddingVertical: spacing.xxl, alignItems: 'center' },
  empty: { alignItems: 'center', gap: 8, paddingVertical: spacing.xxl },
  emptyTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, marginTop: 6 },
  emptyBody: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', marginTop: 6 },
});
