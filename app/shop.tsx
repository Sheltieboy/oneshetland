/**
 * shop.tsx — Shop Shetland: everything on sale, across every shop.
 *
 * Until now products were only reachable through the shop that sells them (a
 * business listing) or the "Fresh in the shops" rail on Home. That works if you
 * already know the maker; it's no use if you just want to buy something
 * Shetland. This is the standalone browse surface: search, category, price.
 *
 * Deliberately a shelf, not a webshop — the buying still happens on the
 * product page and the money still belongs to the shop.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, FlatList, Image, RefreshControl, ScrollView, StyleSheet,
  Text, TextInput, TouchableOpacity, useWindowDimensions, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, radius, shadow, spacing } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { SECTION_HEROES } from '@/constants/section-heroes';
import { TabScreenHeader } from '@/components/TabScreenHeader';
import { HeroBackPill } from '@/components/ui/HeroBackPill';
import {
  browseProducts, PRODUCT_CATEGORIES,
  type BrowseProduct, type BrowseSort, type ProductCategory,
} from '@/lib/products-api';

const S = SECTIONS.local;
const PAGE = 24;

const SORTS: { id: BrowseSort; label: string }[] = [
  { id: 'newest',     label: 'Newest' },
  { id: 'price_low',  label: 'Price ↑' },
  { id: 'price_high', label: 'Price ↓' },
];

const money = (pence: number) => `£${(pence / 100).toFixed(2)}`;

export default function ShopScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const numCols = width >= 900 ? 4 : width >= 620 ? 3 : 2;

  const [items, setItems] = useState<BrowseProduct[]>([]);
  const [category, setCategory] = useState<ProductCategory | null>(null);
  const [sort, setSort] = useState<BrowseSort>('newest');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [more, setMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState(false);

  // Debounce typing so a search doesn't fire a query per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    setError(false);
    try {
      const rows = await browseProducts({ category, query, sort, limit: PAGE });
      setItems(rows);
      setExhausted(rows.length < PAGE);
    } catch {
      setError(true);
      setItems([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [category, query, sort]);

  useEffect(() => { setLoading(true); void load(); }, [load]);

  const loadMore = async () => {
    if (more || exhausted || loading) return;
    setMore(true);
    try {
      const rows = await browseProducts({ category, query, sort, limit: PAGE, offset: items.length });
      setItems((prev) => [...prev, ...rows]);
      if (rows.length < PAGE) setExhausted(true);
    } catch { /* keep what's on screen */ }
    finally { setMore(false); }
  };

  const pickCategory = (c: ProductCategory | null) => {
    Haptics.selectionAsync();
    setCategory(c);
  };

  return (
    <SafeAreaView style={styles.safe} edges={[]}>
      <View>
        <TabScreenHeader
          section={S}
          photo={SECTION_HEROES.local}
          title="Shop Shetland"
          eyebrow="Made and sold here"
          right={
            <Text style={{ color: '#fff', fontSize: fontSize.xs, fontWeight: '800' }}>
              {items.length}{exhausted ? '' : '+'} item{items.length !== 1 ? 's' : ''}
            </Text>
          }
        />
        {router.canGoBack() ? (
          <View style={{ position: 'absolute', top: 12, left: spacing.md }}>
            <HeroBackPill variant="overlay" label="Back" onPress={() => router.back()} />
          </View>
        ) : null}
      </View>

      <View style={styles.searchBar}>
        <View style={styles.searchWrap}>
          <FontAwesome5 name="search" size={13} color={colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={setSearch}
            placeholder="Search everything on sale…"
            placeholderTextColor={colors.textLight}
            returnKeyType="search"
            autoCorrect={false}
          />
          {search ? (
            <TouchableOpacity onPress={() => setSearch('')} accessibilityLabel="Clear search">
              <FontAwesome5 name="times-circle" size={14} color={colors.textMuted} solid />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipScroll}
        contentContainerStyle={styles.chipRow}
      >
        <Chip label="All" active={category === null} onPress={() => pickCategory(null)} />
        {PRODUCT_CATEGORIES.map((c) => (
          <Chip key={c.value} label={c.label} active={category === c.value} onPress={() => pickCategory(c.value)} />
        ))}
      </ScrollView>

      <View style={styles.sortRow}>
        {SORTS.map((s) => (
          <TouchableOpacity key={s.id} onPress={() => { Haptics.selectionAsync(); setSort(s.id); }} style={styles.sortBtn}>
            <Text style={[styles.sortText, sort === s.id && { color: S.color, fontWeight: '900' }]}>{s.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      ) : (
        <FlatList
          key={numCols}
          data={items}
          numColumns={numCols}
          keyExtractor={(p) => p.id}
          contentContainerStyle={styles.grid}
          columnWrapperStyle={numCols > 1 ? { gap: spacing.md } : undefined}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={S.color} />}
          onEndReachedThreshold={0.5}
          onEndReached={loadMore}
          ListEmptyComponent={
            <View style={styles.empty}>
              <FontAwesome5 name={error ? 'exclamation-circle' : 'shopping-bag'} size={26} color={colors.textLight} />
              <Text style={styles.emptyTitle}>
                {error ? 'Could not load the shops' : query || category ? 'Nothing matches that yet' : 'No products yet'}
              </Text>
              <Text style={styles.emptyBody}>
                {error
                  ? 'Check your connection and pull down to try again.'
                  : query || category
                    ? 'Try another word, or a different category.'
                    : 'Shetland shops are still adding their first products.'}
              </Text>
            </View>
          }
          ListFooterComponent={more ? <ActivityIndicator style={{ marginVertical: spacing.lg }} color={S.color} /> : null}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.card, { flex: 1 / numCols }]}
              activeOpacity={0.85}
              onPress={() => router.push(`/product-detail?id=${item.id}`)}
            >
              {item.photos?.[0] ? (
                <Image source={{ uri: item.photos[0] }} style={styles.photo} />
              ) : (
                <View style={[styles.photo, styles.photoEmpty]}>
                  <FontAwesome5 name="image" size={18} color={colors.textLight} />
                </View>
              )}
              <View style={styles.cardBody}>
                <Text style={styles.cardTitle} numberOfLines={2}>{item.title}</Text>
                <Text style={styles.cardShop} numberOfLines={1}>{item.business_name}</Text>
                <View style={styles.priceRow}>
                  <Text style={[styles.price, { color: S.color }]}>{money(item.price_pence)}</Text>
                  {item.compare_at_pence ? <Text style={styles.was}>{money(item.compare_at_pence)}</Text> : null}
                </View>
              </View>
            </TouchableOpacity>
          )}
        />
      )}
    </SafeAreaView>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.chip, active && { backgroundColor: S.color, borderColor: S.color }]}
      activeOpacity={0.85}
    >
      <Text style={[styles.chipText, active && { color: '#fff' }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.screenBackground },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  searchBar:   { paddingHorizontal: spacing.md, paddingTop: spacing.md },
  searchWrap:  { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: radius.full, paddingHorizontal: 16, paddingVertical: 11, borderWidth: 1, borderColor: colors.border },
  searchInput: { flex: 1, fontSize: fontSize.md, color: colors.textPrimary, padding: 0 },

  chipScroll: { flexGrow: 0, marginTop: spacing.md },
  chipRow:    { gap: 8, paddingHorizontal: spacing.md },
  chip:       { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.full, borderWidth: 1.5, borderColor: colors.border, backgroundColor: '#fff' },
  chipText:   { fontSize: fontSize.sm, fontWeight: '800', color: colors.textSecondary },

  sortRow:  { flexDirection: 'row', gap: spacing.lg, paddingHorizontal: spacing.md, paddingTop: spacing.md },
  sortBtn:  { paddingVertical: 2 },
  sortText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textMuted },

  grid: { padding: spacing.md, gap: spacing.md, paddingBottom: 120 },

  card:       { backgroundColor: '#fff', borderRadius: radius.lg, overflow: 'hidden', ...shadow.card },
  photo:      { width: '100%', aspectRatio: 1, backgroundColor: colors.offWhite },
  photoEmpty: { alignItems: 'center', justifyContent: 'center' },
  cardBody:   { padding: 10, gap: 2 },
  cardTitle:  { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary, lineHeight: 18 },
  cardShop:   { fontSize: fontSize.xs, color: colors.textMuted },
  priceRow:   { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 2 },
  price:      { fontSize: fontSize.md, fontWeight: '900' },
  was:        { fontSize: fontSize.xs, color: colors.textLight, textDecorationLine: 'line-through' },

  empty:      { alignItems: 'center', gap: 8, paddingTop: 60, paddingHorizontal: spacing.xl },
  emptyTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  emptyBody:  { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', lineHeight: 19 },
});
