/**
 * app/local-bookable-browse.tsx
 *
 * Discovery screen for "what can I book in Shetland right now?" — a list of
 * bookable SERVICES, not a list of businesses to open and search through.
 * Finding a service used to mean picking a business off a generic list, then
 * scrolling to "Book online" and choosing among whatever it offered. The
 * business is still shown and still tappable for people who want that
 * context, but it is no longer the thing standing between a customer and
 * booking a slot.
 *
 * - Lists every active service at a business where isBookableLive() returns
 *   true (accepts_bookings AND tier Pro-or-above AND is_active) — the same
 *   eligibility rule the business-detail page's own "Book online" section
 *   already uses, not a new one.
 * - Category filter chips (food_drink / retail / services / tourism / etc),
 *   filtering on the owning business's category, same as before.
 * - "My bookings →" link in the header for users who want to manage existing
 *   bookings instead.
 * - Tap the business name → /local-business-detail (context, offers,
 *   loyalty) for anyone who wants it; tap Book → straight into the slot
 *   picker for that exact service, pre-selected.
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { CATEGORY_LABELS, CATEGORY_ICONS, type LocalCategory } from '@/lib/local-api';
import {
  fetchActiveBookableServices, formatPence, formatDuration,
  type BookableServiceCard,
} from '@/lib/book-api';

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

  const [services, setServices]     = useState<BookableServiceCard[]>([]);
  const [filter, setFilter]         = useState<LocalCategory | ''>('');
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (cat: LocalCategory | '') => {
    try {
      const rows = await fetchActiveBookableServices(200, cat || undefined);
      setServices(rows);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(filter); }, [filter, load]);

  const grouped = useMemo(() => {
    // Services from the same business stay together, in the order they
    // already came back (display_order within a business, newest business
    // first) — reads like "here's what Anderson & Co offers", not shuffled.
    const seen = new Set<string>();
    const order: string[] = [];
    for (const s of services) {
      if (!seen.has(s.business_id)) { seen.add(s.business_id); order.push(s.business_id); }
    }
    return order.map(id => services.filter(s => s.business_id === id));
  }, [services]);

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
            {services.length} bookable service{services.length !== 1 ? 's' : ''}
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

      {/* List — grouped by business, service is the unit */}
      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      ) : (
        <FlatList
          data={grouped}
          keyExtractor={group => group[0].business_id}
          renderItem={({ item: group }) => <BusinessGroup services={group} />}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(filter); }}
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

// ── Business group (a small header row, then its bookable services) ────────

function BusinessGroup({ services }: { services: BookableServiceCard[] }) {
  const router = useRouter();
  const first = services[0];
  return (
    <View style={styles.group}>
      <TouchableOpacity
        style={styles.groupHeader}
        onPress={() => router.push({ pathname: '/local-business-detail', params: { id: first.business_id } })}
        activeOpacity={0.75}
      >
        <FontAwesome5 name={CATEGORY_ICONS[first.business_category] as any} size={12} color={S.color} solid />
        <Text style={styles.groupHeaderText} numberOfLines={1}>{first.business_name}</Text>
        <Text style={styles.groupHeaderCat}>{CATEGORY_LABELS[first.business_category]}</Text>
        <FontAwesome5 name="chevron-right" size={10} color={colors.textLight} />
      </TouchableOpacity>
      {services.map(s => <ServiceRow key={s.id} service={s} />)}
    </View>
  );
}

// ── Service row — the thing you actually book ───────────────────────────────

function ServiceRow({ service }: { service: BookableServiceCard }) {
  const router = useRouter();
  return (
    <TouchableOpacity
      style={styles.row}
      onPress={() => router.push({ pathname: '/local-book-business', params: { businessId: service.business_id, serviceId: service.id } })}
      activeOpacity={0.85}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.rowName} numberOfLines={1}>{service.name}</Text>
        {service.description ? (
          <Text style={styles.rowDesc} numberOfLines={1}>{service.description}</Text>
        ) : null}
        <View style={styles.rowMeta}>
          <Text style={styles.rowMetaText}>{formatDuration(service.duration_minutes)}</Text>
          <View style={styles.rowMetaDot} />
          <Text style={[styles.rowMetaText, { fontWeight: '800', color: S.color }]}>{formatPence(service.price_pence)}</Text>
        </View>
      </View>
      <View style={[styles.bookBtn, { backgroundColor: S.color }]}>
        <Text style={styles.bookBtnText}>Book</Text>
      </View>
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

  listContent: { padding: spacing.md, gap: 16, paddingBottom: 100 },

  group: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, overflow: 'hidden',
  },
  groupHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: colors.screenBackground, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  groupHeaderText: { flex: 1, fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  groupHeaderCat:  { fontSize: 10, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase' },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 12, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  rowName:    { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  rowDesc:    { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
  rowMeta:    { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 5 },
  rowMetaText:{ fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600' },
  rowMetaDot: { width: 3, height: 3, borderRadius: 2, backgroundColor: colors.border },
  bookBtn:    { paddingHorizontal: 16, paddingVertical: 9, borderRadius: radius.full },
  bookBtnText:{ color: '#fff', fontWeight: '800', fontSize: fontSize.xs },

  empty:      { alignItems: 'center', padding: spacing.xl, gap: 10, marginTop: spacing.xl },
  emptyIcon:  { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, marginTop: 4 },
  emptyText:  { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', paddingHorizontal: spacing.lg },
});
