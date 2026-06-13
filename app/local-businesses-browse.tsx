/**
 * local-businesses-browse.tsx
 * Full directory of local businesses, filterable by category.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, FlatList, TouchableOpacity,
  Image, ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import {
  fetchActiveBusinesses, CATEGORY_LABELS, CATEGORY_ICONS,
  type LocalBusiness, type LocalCategory,
} from '@/lib/local-api';
import { isBookableLive } from '@/lib/book-api';

const S = SECTIONS.local;

const FILTERS: { id: LocalCategory | ''; label: string }[] = [
  { id: '',              label: 'All' },
  { id: 'food_drink',    label: '🍽 Food & Drink' },
  { id: 'retail',        label: '🛍 Retail' },
  { id: 'services',      label: '🔧 Services' },
  { id: 'tourism',       label: '🌅 Tourism' },
  { id: 'accommodation', label: '🛏 Stay' },
];

export default function BrowseBusinessesScreen() {
  const router = useRouter();

  const [businesses, setBusinesses] = useState<LocalBusiness[]>([]);
  const [filter, setFilter]         = useState<LocalCategory | ''>('');
  const [bookableOnly, setBookableOnly] = useState(false);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchActiveBusinesses(filter || undefined);
      setBusinesses(data);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const visibleBusinesses = bookableOnly
    ? businesses.filter(isBookableLive)
    : businesses;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        {router.canGoBack() ? (
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
            <FontAwesome5 name="chevron-left" size={14} color={S.color} />
            <Text style={[styles.backText, { color: S.color }]}>Back</Text>
          </TouchableOpacity>
        ) : (
          <View style={{ width: 70 }} />
        )}
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Directory</Text>
          <Text style={styles.headerSub}>{visibleBusinesses.length} business{visibleBusinesses.length !== 1 ? 'es' : ''}</Text>
        </View>
        <View style={{ width: 70 }} />
      </View>

      {/* Filter strip */}
      <ScrollView
        horizontal showsHorizontalScrollIndicator={false}
        style={styles.filterBar} contentContainerStyle={styles.filterBarContent}
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
          return (
            <TouchableOpacity
              key={f.id || 'all'}
              style={[styles.filterChip, active && { backgroundColor: S.color, borderColor: S.color }]}
              onPress={() => { Haptics.selectionAsync(); setFilter(f.id); }}
              activeOpacity={0.75}
            >
              <Text style={[styles.filterChipText, active && { color: '#fff' }]}>{f.label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      ) : (
        <FlatList
          data={visibleBusinesses}
          keyExtractor={b => b.id}
          renderItem={({ item }) => <BusinessRow business={item} />}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={S.color} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <View style={[styles.emptyIcon, { backgroundColor: S.light }]}>
                <FontAwesome5 name="store" size={28} color={S.color} solid />
              </View>
              <Text style={styles.emptyTitle}>No businesses yet</Text>
              <Text style={styles.emptyText}>
                {filter ? 'Try a different category.' : 'Be the first to list yours.'}
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

function BusinessRow({ business }: { business: LocalBusiness }) {
  const router = useRouter();
  return (
    <TouchableOpacity
      style={styles.row}
      onPress={() => router.push({ pathname: '/local-business-detail', params: { id: business.id } })}
      activeOpacity={0.85}
    >
      {business.logo_url ? (
        <Image source={{ uri: business.logo_url }} style={styles.rowLogo} />
      ) : (
        <View style={[styles.rowLogo, { backgroundColor: S.light, alignItems: 'center', justifyContent: 'center' }]}>
          <FontAwesome5 name={CATEGORY_ICONS[business.category] as any} size={20} color={S.color} solid />
        </View>
      )}
      <View style={{ flex: 1 }}>
        <View style={styles.rowNameRow}>
          <Text style={styles.rowName} numberOfLines={1}>{business.name}</Text>
          {business.is_verified && (
            <FontAwesome5 name="check-circle" size={11} color={S.color} solid />
          )}
        </View>
        <Text style={[styles.rowCategory, { color: S.color }]}>{CATEGORY_LABELS[business.category]}</Text>
        <Text style={styles.rowAddress} numberOfLines={1}>{business.address}</Text>
        <View style={styles.rowBadges}>
          {isBookableLive(business) && (
            <View style={[styles.miniBadge, { backgroundColor: '#D1FAE5' }]}>
              <FontAwesome5 name="calendar-check" size={8} color="#10B981" solid />
              <Text style={[styles.miniBadgeText, { color: '#10B981' }]}>Bookable</Text>
            </View>
          )}
          {business.accepts_wallet && (
            <View style={styles.miniBadge}>
              <FontAwesome5 name="wallet" size={8} color={S.color} solid />
              <Text style={styles.miniBadgeText}>Wallet</Text>
            </View>
          )}
          {(business.cashback_percent ?? 0) > 0 && (
            <View style={[styles.miniBadge, { backgroundColor: '#FEF3C7' }]}>
              <FontAwesome5 name="percent" size={8} color={colors.shifts} solid />
              <Text style={[styles.miniBadgeText, { color: colors.shifts }]}>
                {business.cashback_percent}% back
              </Text>
            </View>
          )}
        </View>
      </View>
      <FontAwesome5 name="chevron-right" size={12} color={colors.textLight} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 60 },

  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
    borderBottomWidth: 2,
  },
  backBtn:     { flexDirection: 'row', alignItems: 'center', gap: 8, width: 70 },
  backText:    { fontSize: fontSize.sm, fontWeight: '700' },
  headerCenter:{ alignItems: 'center', gap: 2 },
  headerTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
  headerSub:   { color: 'rgba(255,255,255,0.5)', fontSize: fontSize.xs, fontWeight: '600' },

  filterBar:        { backgroundColor: colors.screenBackground, maxHeight: 52 },
  filterBarContent: { paddingHorizontal: spacing.md, paddingVertical: 10, gap: 8 },
  filterChip: {
    paddingHorizontal: 14, paddingVertical: 6,
    backgroundColor: '#fff', borderRadius: radius.full,
    borderWidth: 1.5, borderColor: colors.border,
  },
  filterChipText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textMuted },
  bookableChip:   { flexDirection: 'row', alignItems: 'center', gap: 5, borderColor: '#10B981' },

  listContent: { padding: spacing.md, gap: 10, paddingBottom: 100 },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: 12, borderWidth: 1, borderColor: colors.border,
  },
  rowLogo: { width: 56, height: 56, borderRadius: radius.md },
  rowNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowName:    { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary, flexShrink: 1 },
  rowCategory:{ fontSize: 10, fontWeight: '700', marginTop: 1 },
  rowAddress: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
  rowBadges:  { flexDirection: 'row', gap: 6, marginTop: 6, flexWrap: 'wrap' },
  miniBadge:  { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: S.light, paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.full },
  miniBadgeText: { fontSize: 9, fontWeight: '700', color: S.color },

  empty:      { alignItems: 'center', padding: spacing.xl, gap: 10, marginTop: spacing.xl },
  emptyIcon:  { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  emptyText:  { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },
});
