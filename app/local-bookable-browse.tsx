/**
 * app/local-bookable-browse.tsx
 *
 * Discovery screen for "what can I book in Shetland right now?"
 *
 * - Lists every business where isBookableLive() returns true (accepts_bookings
 *   AND tier === 'premium' AND is_active).
 * - Shows service count per business so users get a feel for what's on offer.
 * - Category filter chips (food_drink / retail / services / tourism / etc).
 * - "My bookings →" link in the header for users who want to manage existing
 *   bookings instead.
 * - Tap a business row → goes to /local-business-detail (where the "Book a slot"
 *   CTA lives) — gives them context (description, offers, loyalty) before they
 *   commit to a slot picker.
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
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
import { supabase } from '@/lib/supabase';

const S = SECTIONS.local;

const FILTERS: { id: LocalCategory | ''; label: string }[] = [
  { id: '',              label: 'All' },
  { id: 'food_drink',    label: 'Food & Drink' },
  { id: 'retail',        label: 'Retail' },
  { id: 'services',      label: 'Services' },
  { id: 'tourism',       label: 'Tourism' },
  { id: 'accommodation', label: 'Stay' },
];

export default function BookableBrowseScreen() {
  const router = useRouter();

  const [businesses, setBusinesses]       = useState<LocalBusiness[]>([]);
  const [serviceCounts, setServiceCounts] = useState<Record<string, number>>({});
  const [filter, setFilter]               = useState<LocalCategory | ''>('');
  const [loading, setLoading]             = useState(true);
  const [refreshing, setRefreshing]       = useState(false);

  const load = useCallback(async () => {
    try {
      const all = await fetchActiveBusinesses();
      const bookable = all.filter(isBookableLive);
      setBusinesses(bookable);

      // Fetch service counts in one go for the bookable businesses
      const ids = bookable.map(b => b.id);
      if (ids.length > 0) {
        const { data } = await supabase
          .from('book_services')
          .select('business_id')
          .eq('is_active', true)
          .in('business_id', ids);
        const counts: Record<string, number> = {};
        for (const row of (data ?? []) as Array<{ business_id: string }>) {
          counts[row.business_id] = (counts[row.business_id] ?? 0) + 1;
        }
        setServiceCounts(counts);
      } else {
        setServiceCounts({});
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(
    () => filter ? businesses.filter(b => b.category === filter) : businesses,
    [businesses, filter],
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Back</Text>
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Book in Shetland</Text>
          <Text style={styles.headerSub}>
            {filtered.length} bookable place{filtered.length !== 1 ? 's' : ''}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.myBookingsBtn}
          onPress={() => { Haptics.selectionAsync(); router.push('/local-my-bookings'); }}
          hitSlop={8}
        >
          <Text style={[styles.myBookingsText, { color: S.color }]}>My bookings →</Text>
        </TouchableOpacity>
      </View>

      {/* Filter strip */}
      <ScrollView
        horizontal showsHorizontalScrollIndicator={false}
        style={styles.filterBar} contentContainerStyle={styles.filterBarContent}
      >
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

      {/* List */}
      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={b => b.id}
          renderItem={({ item }) => (
            <BookableRow business={item} serviceCount={serviceCounts[item.id] ?? 0} />
          )}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
              tintColor={S.color}
            />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <View style={[styles.emptyIcon, { backgroundColor: S.light }]}>
                <FontAwesome5 name="calendar-times" size={28} color={S.color} solid />
              </View>
              <Text style={styles.emptyTitle}>Nothing bookable here yet</Text>
              <Text style={styles.emptyText}>
                {filter
                  ? 'Try a different category, or set filter to All.'
                  : 'Shetland businesses can enable bookings from their dashboard. Be the first to list yours!'}
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

// ── Row ──────────────────────────────────────────────────────────────────────

function BookableRow({ business, serviceCount }: { business: LocalBusiness; serviceCount: number }) {
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
        <View style={styles.rowMeta}>
          <View style={styles.rowMetaItem}>
            <FontAwesome5 name="calendar-check" size={10} color={colors.textMuted} solid />
            <Text style={styles.rowMetaText}>
              {serviceCount === 0
                ? 'No services yet'
                : `${serviceCount} service${serviceCount === 1 ? '' : 's'}`}
            </Text>
          </View>
          {business.address && (
            <View style={styles.rowMetaItem}>
              <FontAwesome5 name="map-marker-alt" size={10} color={colors.textMuted} />
              <Text style={styles.rowMetaText} numberOfLines={1}>
                {business.address.split(',').slice(0, 2).join(',')}
              </Text>
            </View>
          )}
        </View>
      </View>
      <FontAwesome5 name="chevron-right" size={12} color={colors.textLight} />
    </TouchableOpacity>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.navy },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 60 },

  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
    borderBottomWidth: 2,
    gap: 8,
  },
  backBtn:        { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 70 },
  backText:       { fontSize: fontSize.sm, fontWeight: '700' },
  headerCenter:   { flex: 1, alignItems: 'center', gap: 2 },
  headerTitle:    { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
  headerSub:      { color: 'rgba(255,255,255,0.5)', fontSize: fontSize.xs, fontWeight: '600' },
  myBookingsBtn:  { minWidth: 90, alignItems: 'flex-end' },
  myBookingsText: { fontSize: fontSize.xs, fontWeight: '800' },

  filterBar:        { backgroundColor: colors.screenBackground, maxHeight: 52 },
  filterBarContent: { paddingHorizontal: spacing.md, paddingVertical: 10, gap: 8 },
  filterChip: {
    paddingHorizontal: 14, paddingVertical: 6,
    backgroundColor: '#fff', borderRadius: radius.full,
    borderWidth: 1.5, borderColor: colors.border,
  },
  filterChipText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textMuted },

  listContent: { padding: spacing.md, gap: 10, paddingBottom: 100 },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: 12, borderWidth: 1, borderColor: colors.border,
  },
  rowLogo:    { width: 56, height: 56, borderRadius: radius.md },
  rowNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowName:    { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary, flexShrink: 1 },
  rowCategory:{ fontSize: 10, fontWeight: '700', marginTop: 1 },
  rowMeta:    { flexDirection: 'row', gap: 12, marginTop: 6, flexWrap: 'wrap' },
  rowMetaItem:{ flexDirection: 'row', alignItems: 'center', gap: 4 },
  rowMetaText:{ fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600' },

  empty:      { alignItems: 'center', padding: spacing.xl, gap: 10, marginTop: spacing.xl },
  emptyIcon:  { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, marginTop: 4 },
  emptyText:  { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', paddingHorizontal: spacing.lg },
});
