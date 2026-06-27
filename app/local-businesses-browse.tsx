/**
 * local-businesses-browse.tsx
 * Full directory of local businesses, filterable by category.
 * Used by the Directory tab (tabs/services.tsx).
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, FlatList, TouchableOpacity, TextInput,
  Image, ActivityIndicator, RefreshControl, useWindowDimensions, StyleSheet as RN,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius, shadow } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { TabScreenHeader } from '@/components/TabScreenHeader';
import { SECTION_HEROES } from '@/constants/section-heroes';
import { HeroBackPill } from '@/components/ui/HeroBackPill';
import {
  fetchActiveBusinesses, fetchActiveOffersForBusinesses,
  formatOfferDiscount, formatValidUntil,
  isBusinessFeatured, CATEGORY_LABELS,
  type LocalBusiness, type LocalCategory, type LocalOffer,
} from '@/lib/local-api';
import { isBookableLive } from '@/lib/book-api';

const S = SECTIONS.local;

const CATEGORY_COLOR: Record<string, string> = {
  food_drink:    '#D97706',
  retail:        '#7C3AED',
  services:      '#2563EB',
  tourism:       '#059669',
  accommodation: '#DC2626',
};
const CATEGORY_EMOJI: Record<string, string> = {
  food_drink:    '🍽',
  retail:        '🛍',
  services:      '🔧',
  tourism:       '🌅',
  accommodation: '🛏',
};

const FILTERS: { id: LocalCategory | ''; label: string }[] = [
  { id: '',              label: 'All' },
  { id: 'food_drink',   label: '🍽 Food & Drink' },
  { id: 'retail',       label: '🛍 Retail' },
  { id: 'services',     label: '🔧 Services' },
  { id: 'tourism',      label: '🌅 Tourism' },
  { id: 'accommodation',label: '🛏 Stay' },
];

export default function BrowseBusinessesScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;
  const numCols  = isTablet ? 2 : 1;

  const [businesses, setBusinesses] = useState<LocalBusiness[]>([]);
  const [offersMap, setOffersMap]   = useState<Map<string, LocalOffer>>(new Map());
  const [filter, setFilter]         = useState<LocalCategory | ''>('');
  const [bookableOnly, setBookableOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchActiveBusinesses(filter || undefined);
      setBusinesses(data);
      const offers = await fetchActiveOffersForBusinesses(data.map(b => b.id));
      const map = new Map<string, LocalOffer>();
      for (const o of offers) { if (!map.has(o.business_id)) map.set(o.business_id, o); }
      setOffersMap(map);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const q = searchQuery.trim().toLowerCase();
  const filtered = (bookableOnly ? businesses.filter(isBookableLive) : businesses)
    .filter(b => {
      if (!q) return true;
      const cat = b.category ? (CATEGORY_LABELS[b.category] ?? b.category) : '';
      return (
        b.name?.toLowerCase().includes(q) ||
        cat.toLowerCase().includes(q) ||
        b.address?.toLowerCase().includes(q) ||
        (b.tags ?? []).some(t => t.toLowerCase().includes(q))
      );
    });
  const featured = filtered.filter(b => isBusinessFeatured(b));
  const regular  = filtered.filter(b => !isBusinessFeatured(b));

  const renderItem = ({ item }: { item: LocalBusiness }) => (
    <BusinessCard
      business={item}
      offer={offersMap.get(item.id)}
      featured={isBusinessFeatured(item)}
      numCols={numCols}
      onPress={() => router.push({ pathname: '/local-business-detail', params: { id: item.id } })}
    />
  );

  // Interleave: featured first, then regular
  const allItems = [...featured, ...regular];

  return (
    <SafeAreaView style={styles.safe} edges={[]}>
      <View>
        <TabScreenHeader
          section={S}
          photo={SECTION_HEROES.directory}
          title="Directory"
          eyebrow="Shop local"
          right={
            <Text style={{ color: '#fff', fontSize: fontSize.xs, fontWeight: '800' }}>
              {filtered.length} business{filtered.length !== 1 ? 'es' : ''}
            </Text>
          }
        />
        {router.canGoBack() ? (
          <View style={{ position: 'absolute', top: 12, left: spacing.md }}>
            <HeroBackPill variant="overlay" label="Back" onPress={() => router.back()} />
          </View>
        ) : null}
      </View>

      {/* Search box */}
      <View style={styles.searchBar}>
        <View style={styles.searchWrap}>
          <FontAwesome5 name="search" size={13} color={colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search by name, type or place…"
            placeholderTextColor={colors.textMuted}
            value={searchQuery}
            onChangeText={setSearchQuery}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
          />
          {searchQuery.length > 0 ? (
            <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={10}>
              <FontAwesome5 name="times-circle" size={15} color={colors.textMuted} solid />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {/* Filter strip */}
      <View style={styles.filterBar}>
        <ScrollView
          horizontal showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterBarContent}
          alwaysBounceHorizontal={false}
        >
          <TouchableOpacity
            style={[styles.filterChip, styles.bookableChip, bookableOnly && { backgroundColor: '#10B981', borderColor: '#10B981' }]}
            onPress={() => { Haptics.selectionAsync(); setBookableOnly(v => !v); }}
            activeOpacity={0.75}
          >
            <FontAwesome5 name="calendar-check" size={10} color={bookableOnly ? '#fff' : '#10B981'} solid />
            <Text style={[styles.filterChipText, { color: bookableOnly ? '#fff' : '#10B981', fontWeight: '800' }]}>
              Bookable
            </Text>
          </TouchableOpacity>
          {FILTERS.map(f => {
            const active = filter === f.id;
            const col = f.id ? (CATEGORY_COLOR[f.id] ?? S.color) : S.color;
            return (
              <TouchableOpacity
                key={f.id || 'all'}
                style={[styles.filterChip, active && { backgroundColor: col, borderColor: col }]}
                onPress={() => { Haptics.selectionAsync(); setFilter(f.id); }}
                activeOpacity={0.75}
              >
                <Text style={[styles.filterChipText, active && { color: '#fff' }]}>{f.label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      ) : (
        <FlatList
          data={allItems}
          keyExtractor={b => b.id}
          renderItem={renderItem}
          numColumns={numCols}
          key={numCols} // re-mount when cols change
          columnWrapperStyle={numCols > 1 ? styles.columnWrap : undefined}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={S.color} />}
          ListEmptyComponent={<EmptyState filter={!!filter || !!q} />}
          ListFooterComponent={
            <TouchableOpacity
              style={styles.listBizCta}
              onPress={() => { Haptics.selectionAsync(); router.push('/local-business-register'); }}
              activeOpacity={0.85}
            >
              <FontAwesome5 name="store" size={15} color={S.color} solid />
              <View style={{ flex: 1 }}>
                <Text style={styles.listBizCtaTitle}>List your business</Text>
                <Text style={styles.listBizCtaSub}>Run a Shetland business? Add it to the Directory.</Text>
              </View>
              <FontAwesome5 name="chevron-right" size={12} color={colors.textMuted} />
            </TouchableOpacity>
          }
        />
      )}
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// BusinessCard — styled like EventCard
// ---------------------------------------------------------------------------

function BusinessCard({ business, offer, featured, numCols, onPress }: {
  business: LocalBusiness;
  offer?: LocalOffer;
  featured?: boolean;
  numCols: number;
  onPress: () => void;
}) {
  const router   = useRouter();
  const cat      = business.category ?? 'other';
  const catColor = CATEGORY_COLOR[cat] ?? S.color;
  const emoji    = CATEGORY_EMOJI[cat] ?? '🏪';

  return (
    <TouchableOpacity
      style={[styles.card, numCols > 1 && styles.cardTablet, featured && styles.cardFeatured]}
      onPress={onPress}
      activeOpacity={0.85}
    >
      {/* Cover image or coloured placeholder */}
      {business.cover_url ? (
        <Image source={{ uri: business.cover_url }} style={styles.cardImage} />
      ) : (
        <View style={[styles.cardImagePlaceholder, { backgroundColor: catColor + '18' }]}>
          <Text style={styles.cardPlaceholderEmoji}>{emoji}</Text>
        </View>
      )}

      {/* Featured badge */}
      {featured && (
        <View style={styles.featuredBadge}>
          <FontAwesome5 name="star" size={9} color="#fff" solid />
          <Text style={styles.featuredBadgeText}>Featured</Text>
        </View>
      )}

      {/* Card body: logo pill + meta */}
      <View style={styles.cardBody}>
        {/* Logo pill (mirrors date pill) */}
        <View style={[styles.logoPill, { backgroundColor: catColor + '18' }]}>
          {business.logo_url
            ? <Image source={{ uri: business.logo_url }} style={StyleSheet.absoluteFill} resizeMode="cover" />
            : <Text style={{ fontSize: 20 }}>{emoji}</Text>}
          {business.is_verified && (
            <View style={[styles.verifiedDot, { backgroundColor: catColor }]}>
              <FontAwesome5 name="check" size={6} color="#fff" solid />
            </View>
          )}
        </View>

        {/* Meta */}
        <View style={styles.cardMeta}>
          <Text style={[styles.cardCategory, { color: catColor }]}>
            {CATEGORY_LABELS[cat] ?? cat}
          </Text>
          <Text style={styles.cardTitle} numberOfLines={2}>{business.name}</Text>
          <View style={styles.cardInfoRow}>
            <View style={styles.cardInfoItem}>
              <FontAwesome5 name="map-marker-alt" size={10} color={colors.textMuted} />
              <Text style={styles.cardInfoText} numberOfLines={1}>{business.address}</Text>
            </View>
          </View>
          <View style={styles.cardFootRow}>
            <BadgePills business={business} catColor={catColor} />
            {offer && (
              <View style={styles.offerPill}>
                <FontAwesome5 name="tag" size={8} color="#fff" solid />
                <Text style={styles.offerPillText}>{formatOfferDiscount(offer)}</Text>
              </View>
            )}
          </View>
        </View>
      </View>

      {/* Offer strip */}
      {offer && (
        <View style={styles.offerStrip}>
          <Text style={styles.offerTitle} numberOfLines={1}>{offer.title}</Text>
          <Text style={styles.offerExpiry}>Until {formatValidUntil(offer.valid_until)}</Text>
        </View>
      )}

      {/* Claim strip */}
      {!business.is_claimed && (
        <TouchableOpacity
          style={styles.claimStrip}
          onPress={e => { e.stopPropagation?.(); router.push({ pathname: '/business-claim', params: { id: business.id } }); }}
          activeOpacity={0.75}
        >
          <FontAwesome5 name="store" size={10} color="#6366F1" />
          <Text style={styles.claimText}>Is this your business? <Text style={styles.claimLink}>Claim it →</Text></Text>
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

function BadgePills({ business, catColor }: { business: LocalBusiness; catColor: string }) {
  return (
    <View style={styles.badgeRow}>
      {isBookableLive(business) && (
        <View style={[styles.miniBadge, { backgroundColor: '#D1FAE5' }]}>
          <Text style={[styles.miniBadgeText, { color: '#059669' }]}>📅 Bookable</Text>
        </View>
      )}
      {(business.cashback_percent ?? 0) > 0 && (
        <View style={[styles.miniBadge, { backgroundColor: '#FEF3C7' }]}>
          <Text style={[styles.miniBadgeText, { color: '#D97706' }]}>{business.cashback_percent}% back</Text>
        </View>
      )}
      {business.accepts_wallet && (
        <View style={[styles.miniBadge, { backgroundColor: catColor + '18' }]}>
          <Text style={[styles.miniBadgeText, { color: catColor }]}>👛 Wallet</Text>
        </View>
      )}
    </View>
  );
}

function EmptyState({ filter }: { filter: boolean }) {
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyIcon, { backgroundColor: S.light }]}>
        <FontAwesome5 name="store" size={28} color={S.color} solid />
      </View>
      <Text style={styles.emptyTitle}>No businesses yet</Text>
      <Text style={styles.emptyText}>
        {filter ? 'Try a different category.' : 'Be the first to list yours.'}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.navy },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 60 },

  searchBar:   { backgroundColor: colors.screenBackground, paddingHorizontal: spacing.md, paddingTop: 10 },
  searchWrap:  {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#fff', borderRadius: radius.full, borderWidth: 1.5, borderColor: colors.border,
    paddingHorizontal: 14, paddingVertical: 9,
  },
  searchInput: { flex: 1, fontSize: fontSize.sm, color: colors.textPrimary, padding: 0 },

  filterBar:        { backgroundColor: colors.screenBackground, borderBottomWidth: 1, borderBottomColor: colors.border },
  filterBarContent: { paddingHorizontal: spacing.md, paddingVertical: 10, gap: 8, flexDirection: 'row', alignItems: 'center' },
  filterChip:       { paddingHorizontal: 14, paddingVertical: 7, backgroundColor: '#fff', borderRadius: radius.full, borderWidth: 1.5, borderColor: colors.border },
  filterChipText:   { fontSize: 13, fontWeight: '700', color: colors.textMuted },
  bookableChip:     { flexDirection: 'row', alignItems: 'center', gap: 5, borderColor: '#10B981' },

  listContent:  { padding: spacing.md, gap: 12, paddingBottom: 100, backgroundColor: colors.screenBackground },
  listBizCta: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    marginTop: spacing.sm, padding: spacing.md,
    backgroundColor: colors.white, borderRadius: radius.lg,
    borderWidth: 1.5, borderColor: S.color, borderStyle: 'dashed',
  },
  listBizCtaTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  listBizCtaSub:   { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
  columnWrap:   { gap: 12 },

  // Card — mirrors EventCard exactly
  card: {
    backgroundColor: '#fff', borderRadius: radius.lg, overflow: 'hidden',
    borderWidth: 1, borderColor: colors.border,
    ...shadow.card,
  },
  cardTablet:   { flex: 1 },
  cardFeatured: { borderColor: S.color + '60', borderWidth: 1.5 },

  cardImage:            { width: '100%', height: 160, resizeMode: 'cover' },
  cardImagePlaceholder: { width: '100%', height: 120, alignItems: 'center', justifyContent: 'center' },
  cardPlaceholderEmoji: { fontSize: 54, opacity: 0.3 },

  featuredBadge: {
    position: 'absolute', top: 10, right: 10,
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: S.color, paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: radius.full,
  },
  featuredBadgeText: { fontSize: 9, fontWeight: '800', color: '#fff' },

  cardBody:    { flexDirection: 'row', gap: 10, padding: spacing.md, paddingTop: 10 },

  logoPill: {
    width: 44, height: 44, borderRadius: radius.md, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, alignSelf: 'flex-start', position: 'relative',
  },
  verifiedDot: {
    position: 'absolute', bottom: -2, right: -2,
    width: 16, height: 16, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: '#fff',
  },

  cardMeta:     { flex: 1, gap: 3 },
  cardCategory: { fontSize: fontSize.xs, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
  cardTitle:    { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, lineHeight: 20 },
  cardInfoRow:  { flexDirection: 'row', gap: 10, flexWrap: 'wrap', marginTop: 2 },
  cardInfoItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  cardInfoText: { fontSize: fontSize.xs, color: colors.textMuted },
  cardFootRow:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, flexWrap: 'wrap', gap: 6 },

  badgeRow:     { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  miniBadge:    { paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.full },
  miniBadgeText:{ fontSize: 9, fontWeight: '800' },

  offerPill:     { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#F59E0B', borderRadius: radius.full, paddingHorizontal: 8, paddingVertical: 3 },
  offerPillText: { fontSize: 10, fontWeight: '900', color: '#fff' },

  offerStrip:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#FFFBEB', paddingHorizontal: spacing.md, paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#FDE68A' },
  offerTitle:  { fontSize: fontSize.xs, fontWeight: '700', color: '#92400E', flex: 1 },
  offerExpiry: { fontSize: 10, color: '#B45309', marginLeft: 8 },

  claimStrip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#EEF2FF', paddingHorizontal: spacing.md, paddingVertical: 7, borderTopWidth: 1, borderTopColor: '#C7D2FE' },
  claimText:  { fontSize: 11, color: '#4338CA' },
  claimLink:  { fontWeight: '800' },

  empty:      { alignItems: 'center', padding: spacing.xl, gap: 10, marginTop: spacing.xl },
  emptyIcon:  { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  emptyText:  { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },
});
