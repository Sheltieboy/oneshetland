/**
 * shifts-browse.tsx
 * Full shift listing — extracted from the old shifts tab so the tab can
 * become a proper hub/landing page. Accessed by tapping "Browse Shifts"
 * from the hub.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, FlatList, TouchableOpacity,
  Animated, RefreshControl,
} from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { LoadingState } from '@/components/ui/LoadingState';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  fetchOpenShifts, formatPay, formatDuration, formatShiftDate,
  URGENCY_CONFIG, CATEGORY_LABELS, shiftDisplayBusiness, type Shift,
} from '@/lib/shifts-api';

const S = SECTIONS.shifts;

const FILTERS = [
  { id: '',          label: 'All shifts' },
  { id: 'asap',      label: '🔴 ASAP' },
  { id: 'today',     label: '🟠 Today' },
  { id: 'this_week', label: '🟡 This week' },
];

// ── Shift card ────────────────────────────────────────────────────────────────

function ShiftCard({ shift }: { shift: Shift }) {
  const router    = useRouter();
  const urgency   = URGENCY_CONFIG[shift.urgency];
  const spotsLeft = shift.positions_total - shift.positions_filled;
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const isBoosted = !!(shift.boosted_until && shift.boosted_until > new Date().toISOString());

  const onPressIn = () => Animated.timing(scaleAnim, {
    toValue: 0.97, duration: 80, useNativeDriver: true,
  }).start();
  const onPressOut = () => Animated.spring(scaleAnim, {
    toValue: 1, friction: 5, useNativeDriver: true,
  }).start();

  return (
    <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
      <TouchableOpacity
        style={[styles.card, { borderLeftColor: urgency.color }, isBoosted && styles.cardBoosted]}
        onPress={() => {
          Haptics.selectionAsync();
          router.push({ pathname: '/shift-detail', params: { id: shift.id } });
        }}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        activeOpacity={1}
      >
        {/* Top row */}
        <View style={styles.cardTop}>
          {isBoosted && (
            <View style={styles.featuredBadge}>
              <FontAwesome5 name="bolt" size={8} color={colors.shifts} solid />
              <Text style={styles.featuredText}>Featured</Text>
            </View>
          )}
          <View style={[styles.urgencyPill, { backgroundColor: urgency.bg }]}>
            <Text style={[styles.urgencyPillText, { color: urgency.color }]}>{urgency.label}</Text>
          </View>
          <Text style={styles.cardCategory} numberOfLines={1}>
            {CATEGORY_LABELS[shift.category] ?? shift.category}
          </Text>
          {shiftDisplayBusiness(shift).is_verified && (
            <FontAwesome5 name="check-circle" size={12} color={S.color} solid style={{ marginLeft: 'auto' }} />
          )}
        </View>

        {/* Title */}
        <Text style={styles.cardTitle} numberOfLines={2}>{shift.title}</Text>

        {/* Employer / linked Local business */}
        <Text style={styles.cardEmployer}>{shiftDisplayBusiness(shift).name}</Text>

        {/* Meta */}
        <View style={styles.cardMeta}>
          <View style={styles.cardMetaItem}>
            <FontAwesome5 name="clock" size={10} color={colors.textMuted} />
            <Text style={styles.cardMetaText}>{formatShiftDate(shift.start_at)}</Text>
          </View>
          <View style={styles.cardMetaItem}>
            <FontAwesome5 name="hourglass-half" size={10} color={colors.textMuted} />
            <Text style={styles.cardMetaText}>{formatDuration(shift.start_at, shift.end_at)}</Text>
          </View>
        </View>
        <View style={styles.cardMeta}>
          <View style={styles.cardMetaItem}>
            <FontAwesome5 name="map-marker-alt" size={10} color={colors.textMuted} />
            <Text style={styles.cardMetaText} numberOfLines={1}>{shift.location_text}</Text>
          </View>
        </View>

        {/* Footer */}
        <View style={styles.cardFooter}>
          <Text style={[styles.cardPay, { color: S.color }]}>
            {formatPay(shift.pay_type, shift.pay_amount)}
          </Text>
          <View style={styles.cardSpots}>
            <FontAwesome5 name="user" size={9} color={colors.textMuted} />
            <Text style={styles.cardSpotsText}>
              {spotsLeft} spot{spotsLeft !== 1 ? 's' : ''} left
            </Text>
          </View>
          <View style={{ marginLeft: 'auto' }}>
            <Text style={[styles.cardCta, { color: S.color }]}>View →</Text>
          </View>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ── Browse screen ─────────────────────────────────────────────────────────────

export default function ShiftsBrowseScreen() {
  const router = useRouter();
  const { screenWidth } = useAppLayout();

  const [shifts, setShifts]         = useState<Shift[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter]         = useState('');
  const [fetchError, setFetchError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFetchError(null);
    try {
      const data = await fetchOpenShifts();
      setShifts(data);
    } catch (e: any) {
      setFetchError(e?.message ?? 'Could not load shifts');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = () => { setRefreshing(true); load(); };

  const filtered = filter ? shifts.filter(s => s.urgency === filter) : shifts;

  return (
    <ScreenScaffold
      header={
        <ScreenHeader
          title="Browse Shifts"
          subtitle={!loading ? `${shifts.length} open right now` : undefined}
          accent={S.color}
          onBack={() => router.back()}
        />
      }
    >

      {/* Filter strip */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterBar}
        contentContainerStyle={styles.filterBarContent}
      >
        {FILTERS.map(f => {
          const active = filter === f.id;
          return (
            <TouchableOpacity
              key={f.id}
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
        <LoadingState accent={S.color} />
      ) : fetchError ? (
        <EmptyState
          icon="exclamation-circle"
          title="Couldn't load shifts"
          body={fetchError}
          accent={colors.error}
          variant="card"
          actionLabel="Try again"
          onAction={() => { setLoading(true); load(); }}
        />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={item => item.id}
          renderItem={({ item }) => <ShiftCard shift={item} />}
          contentContainerStyle={[styles.listContent, contentContainer(screenWidth), filtered.length === 0 && { flex: 1 }]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={S.color} />}
          ListEmptyComponent={
            <EmptyState
              icon="briefcase"
              title="No shifts right now"
              body={filter ? 'Try a different filter above.' : 'Pull down to refresh or check back soon.'}
              accent={S.color}
            />
          }
        />
      )}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  filterBar:        { backgroundColor: colors.screenBackground, maxHeight: 52 },
  filterBarContent: { paddingHorizontal: spacing.md, paddingVertical: 10, gap: 8 },
  filterChip: {
    paddingHorizontal: 14, paddingVertical: 6,
    backgroundColor: '#fff', borderRadius: radius.full,
    borderWidth: 1.5, borderColor: colors.border,
  },
  filterChipText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textMuted },

  listContent: { padding: spacing.md, gap: 12, paddingBottom: 100 },

  // Card
  card: {
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    borderLeftWidth: 4,
    padding: spacing.md,
    gap: 6,
    shadowColor: '#0F1C26',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  cardBoosted: {
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 4,
  },
  cardTop:          { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  featuredBadge:    { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#FEF3C7', paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full },
  featuredText:     { fontSize: 10, fontWeight: '800', color: colors.shifts },
  urgencyPill:      { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full },
  urgencyPillText:  { fontSize: 10, fontWeight: '800' },
  cardCategory:     { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600', flex: 1 },
  cardTitle:        { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, lineHeight: 22 },
  cardEmployer:     { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600' },
  cardMeta:         { flexDirection: 'row', gap: 16, flexWrap: 'wrap' },
  cardMetaItem:     { flexDirection: 'row', alignItems: 'center', gap: 5 },
  cardMetaText:     { fontSize: fontSize.xs, color: colors.textMuted },
  cardFooter:       { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border },
  cardPay:          { fontSize: fontSize.sm, fontWeight: '800' },
  cardSpots:        { flexDirection: 'row', alignItems: 'center', gap: 4 },
  cardSpotsText:    { fontSize: fontSize.xs, color: colors.textMuted },
  cardCta:          { fontSize: fontSize.xs, fontWeight: '800' },
});
