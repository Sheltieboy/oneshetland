/**
 * whats-on.tsx — Public events calendar tab
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  FlatList, Image, ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius, shadow } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { SECTIONS } from '@/constants/sections';
import { TabScreenHeader } from '@/components/TabScreenHeader';
import { SECTION_HEROES } from '@/constants/section-heroes';
import { EventsCalendar, dayKey } from '@/components/EventsCalendar';
import {
  fetchPublishedEvents,
  formatShortDate, formatTime,
  lowestTicketPrice, isFreeEvent,
  EVENT_CATEGORIES,
  type OsEvent, type EventTicketType,
} from '@/lib/events-api';

const S = SECTIONS.events;

const FILTER_DATES = [
  { label: 'Today',     days: 0 },
  { label: 'This week', days: 7 },
  { label: 'This month',days: 30 },
  { label: 'All upcoming', days: 365 },
];

export default function WhatsOnTab() {
  const router  = useRouter();
  const { isTablet, screenWidth, screenHeight } = useAppLayout();
  const numCols = isTablet ? 2 : 1;
  const twoPane = isTablet && screenWidth > screenHeight;

  const [viewMode, setViewMode] = useState<'list' | 'calendar'>('list');

  // Highlights (featured + on-sale rows) — fetched once, independent of filters.
  const [highlights, setHighlights] = useState<OsEvent[]>([]);

  // Calendar state.
  const [calMonth, setCalMonth]         = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [monthEvents, setMonthEvents]   = useState<OsEvent[]>([]);
  const [selectedKey, setSelectedKey]   = useState<string | null>(() => dayKey(new Date()));

  const [events,      setEvents]      = useState<OsEvent[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [refreshing,  setRefreshing]  = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore,     setHasMore]     = useState(true);

  const [dateFilter,    setDateFilter]    = useState(1);  // index into FILTER_DATES
  const [categoryFilter,setCategoryFilter] = useState<string | null>(null);
  const [freeOnly,      setFreeOnly]      = useState(false);

  const PAGE = 20;
  const offsetRef = useRef(0);

  const buildQueryOpts = useCallback((offset = 0) => {
    const fd = FILTER_DATES[dateFilter];
    const from = new Date().toISOString();
    const to   = fd.days === 365
      ? undefined
      : (() => { const d = new Date(); d.setDate(d.getDate() + fd.days); return d.toISOString(); })();
    return {
      category: categoryFilter ?? undefined,
      from,
      to,
      limit:  PAGE,
      offset,
    };
  }, [dateFilter, categoryFilter]);

  const load = useCallback(async () => {
    setLoading(true);
    offsetRef.current = 0;
    try {
      const data = await fetchPublishedEvents(buildQueryOpts(0));
      setEvents(data);
      setHasMore(data.length === PAGE);
    } catch {}
    setLoading(false);
    setRefreshing(false);
  }, [buildQueryOpts]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const next = offsetRef.current + PAGE;
    try {
      const data = await fetchPublishedEvents(buildQueryOpts(next));
      setEvents(prev => [...prev, ...data]);
      setHasMore(data.length === PAGE);
      offsetRef.current = next;
    } catch {}
    setLoadingMore(false);
  }, [loadingMore, hasMore, buildQueryOpts]);

  useEffect(() => { load(); }, [load]);

  // Highlights — all upcoming, once.
  useEffect(() => {
    fetchPublishedEvents({ limit: 60 }).then(setHighlights).catch(() => {});
  }, []);

  // Calendar month events — refetch when the displayed month changes.
  useEffect(() => {
    if (viewMode !== 'calendar') return;
    const from = new Date(calMonth.getFullYear(), calMonth.getMonth(), 1).toISOString();
    const to   = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 0, 23, 59, 59).toISOString();
    fetchPublishedEvents({ from, to, limit: 200 }).then(setMonthEvents).catch(() => setMonthEvents([]));
  }, [viewMode, calMonth]);

  const visibleEvents = freeOnly
    ? events.filter(e => !e.has_tickets || (e.ticket_types?.length ? isFreeEvent(e.ticket_types) : !e.price_text))
    : events;

  // Derived highlight rows + calendar buckets.
  const featured = highlights.filter(e => e.is_featured).slice(0, 8);
  const ticketed = highlights.filter(e => e.has_tickets).slice(0, 12);

  const monthEventsCat = categoryFilter ? monthEvents.filter(e => e.category === categoryFilter) : monthEvents;
  const monthCounts: Record<string, number> = {};
  for (const e of monthEventsCat) {
    const k = dayKey(new Date(e.starts_at));
    monthCounts[k] = (monthCounts[k] ?? 0) + 1;
  }
  const dayEvents = selectedKey
    ? monthEventsCat.filter(e => dayKey(new Date(e.starts_at)) === selectedKey)
    : [];

  const goEvent = (id: string) => router.push({ pathname: '/events/[id]', params: { id } });
  const goTickets = (id: string) => router.push({ pathname: '/event-ticket-checkout', params: { id } });

  // Highlights header for the list (featured strip + on-sale row).
  const showHighlights = !categoryFilter && !freeOnly;
  const listHeader = showHighlights && (featured.length > 0 || ticketed.length > 0) ? (
    <View style={styles.highlightsWrap}>
      {featured.length > 0 && (
        <>
          <Text style={styles.rowHeading}>Featured</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hScroll}>
            {featured.map(e => <FeatureCard key={e.id} event={e} onPress={() => goEvent(e.id)} />)}
          </ScrollView>
        </>
      )}
      {ticketed.length > 0 && (
        <>
          <View style={styles.rowHeadingRow}>
            <FontAwesome5 name="ticket-alt" size={13} color={S.color} solid />
            <Text style={styles.rowHeading}>On sale now</Text>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hScroll}>
            {ticketed.map(e => <TicketCard key={e.id} event={e} onPress={() => goEvent(e.id)} onTickets={() => goTickets(e.id)} />)}
          </ScrollView>
        </>
      )}
      <Text style={[styles.rowHeading, { marginTop: spacing.lg }]}>
        {FILTER_DATES[dateFilter].label} · {visibleEvents.length}
      </Text>
    </View>
  ) : null;

  const calendarBody = (
    <>
      <EventsCalendar
        monthDate={calMonth}
        counts={monthCounts}
        selectedKey={selectedKey}
        onSelectDay={(k) => setSelectedKey(k)}
        onChangeMonth={(d) => setCalMonth(new Date(calMonth.getFullYear(), calMonth.getMonth() + d, 1))}
        color={S.color}
      />
      <View style={styles.dayPanel}>
        <Text style={styles.dayHeading}>
          {selectedKey ? `${dayEvents.length} event${dayEvents.length === 1 ? '' : 's'}` : 'Pick a day'}
        </Text>
        {dayEvents.length === 0 ? (
          <Text style={styles.dayEmpty}>Nothing on this day — tap a highlighted date.</Text>
        ) : (
          <View style={{ gap: 12 }}>
            {dayEvents.map(e => <EventCard key={e.id} event={e} onPress={() => goEvent(e.id)} />)}
          </View>
        )}
      </View>
    </>
  );

  return (
    <SafeAreaView style={styles.safe} edges={[]}>
      <TabScreenHeader section={S} photo={SECTION_HEROES.events} />

      {/* View toggle + filters */}
      <View style={styles.filtersWrap}>
        <View style={styles.toggleRow}>
          <View style={styles.toggle}>
            {(['list', 'calendar'] as const).map(m => (
              <TouchableOpacity
                key={m}
                style={[styles.toggleBtn, viewMode === m && { backgroundColor: S.color }]}
                onPress={() => setViewMode(m)}
                activeOpacity={0.85}
              >
                <FontAwesome5 name={m === 'list' ? 'stream' : 'calendar-alt'} size={11} color={viewMode === m ? '#fff' : colors.textMuted} solid />
                <Text style={[styles.toggleText, viewMode === m && { color: '#fff' }]}>{m === 'list' ? 'List' : 'Calendar'}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Date chips — list mode only */}
        {viewMode === 'list' && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
            {FILTER_DATES.map((f, i) => (
              <TouchableOpacity
                key={i}
                style={[styles.chip, dateFilter === i && { backgroundColor: S.color, borderColor: S.color }]}
                onPress={() => setDateFilter(i)}
                activeOpacity={0.8}
              >
                <Text style={[styles.chipText, dateFilter === i && { color: '#fff' }]}>{f.label}</Text>
              </TouchableOpacity>
            ))}
            <View style={styles.chipDivider} />
            <TouchableOpacity
              style={[styles.chip, freeOnly && { backgroundColor: S.color, borderColor: S.color }]}
              onPress={() => setFreeOnly(v => !v)}
              activeOpacity={0.8}
            >
              <Text style={[styles.chipText, freeOnly && { color: '#fff' }]}>Free only</Text>
            </TouchableOpacity>
          </ScrollView>
        )}

        {/* Category chips — both modes */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
          <TouchableOpacity
            style={[styles.chip, !categoryFilter && { backgroundColor: S.color + '22', borderColor: S.color }]}
            onPress={() => setCategoryFilter(null)}
            activeOpacity={0.8}
          >
            <Text style={[styles.chipText, !categoryFilter && { color: S.color }]}>All</Text>
          </TouchableOpacity>
          {EVENT_CATEGORIES.map(cat => (
            <TouchableOpacity
              key={cat}
              style={[styles.chip, categoryFilter === cat && { backgroundColor: S.color, borderColor: S.color }]}
              onPress={() => setCategoryFilter(c => c === cat ? null : cat)}
              activeOpacity={0.8}
            >
              <Text style={[styles.chipText, categoryFilter === cat && { color: '#fff' }]}>{cat}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* ── Calendar mode ── */}
      {viewMode === 'calendar' ? (
        twoPane ? (
          <View style={styles.calRow}>
            <ScrollView style={styles.calLeft} showsVerticalScrollIndicator={false}>
              <EventsCalendar
                monthDate={calMonth}
                counts={monthCounts}
                selectedKey={selectedKey}
                onSelectDay={(k) => setSelectedKey(k)}
                onChangeMonth={(d) => setCalMonth(new Date(calMonth.getFullYear(), calMonth.getMonth() + d, 1))}
                color={S.color}
              />
            </ScrollView>
            <ScrollView style={styles.calRight} contentContainerStyle={{ padding: spacing.md, gap: 12 }} showsVerticalScrollIndicator={false}>
              <Text style={styles.dayHeading}>
                {selectedKey ? `${dayEvents.length} event${dayEvents.length === 1 ? '' : 's'}` : 'Pick a day'}
              </Text>
              {dayEvents.length === 0
                ? <Text style={styles.dayEmpty}>Nothing on this day — tap a highlighted date.</Text>
                : dayEvents.map(e => <EventCard key={e.id} event={e} onPress={() => goEvent(e.id)} />)}
            </ScrollView>
          </View>
        ) : (
          <ScrollView style={{ flex: 1, backgroundColor: colors.screenBackground }} showsVerticalScrollIndicator={false}>
            {calendarBody}
          </ScrollView>
        )
      ) : loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={S.color} />
        </View>
      ) : visibleEvents.length === 0 ? (
        <View style={styles.center}>
          <FontAwesome5 name="calendar-times" size={36} color={S.color + '60'} />
          <Text style={styles.emptyTitle}>No events found</Text>
          <Text style={styles.emptyText}>Try changing the date or category filter</Text>
        </View>
      ) : (
        <FlatList
          data={visibleEvents}
          keyExtractor={item => item.id}
          style={{ backgroundColor: colors.screenBackground }}
          key={numCols}
          numColumns={numCols}
          columnWrapperStyle={isTablet ? styles.columnWrap : undefined}
          contentContainerStyle={[styles.list, isTablet && styles.listTablet]}
          ListHeaderComponent={listHeader}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={S.color} />}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          ListFooterComponent={loadingMore ? <ActivityIndicator color={S.color} style={{ marginVertical: 16 }} /> : null}
          renderItem={({ item }) => (
            <View style={isTablet ? { flex: 1, maxWidth: '50%' } : undefined}>
              <EventCard event={item} onPress={() => goEvent(item.id)} />
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

// ── Horizontal highlight cards ───────────────────────────────────────────────

function FeatureCard({ event, onPress }: { event: OsEvent; onPress: () => void }) {
  const starts = new Date(event.starts_at);
  return (
    <TouchableOpacity style={styles.featCard} onPress={onPress} activeOpacity={0.9}>
      {event.cover_url ? (
        <Image source={{ uri: event.cover_url }} style={styles.featImage} />
      ) : (
        <View style={[styles.featImage, { backgroundColor: S.color + '22', alignItems: 'center', justifyContent: 'center' }]}>
          <FontAwesome5 name="calendar-alt" size={26} color={S.color + '80'} />
        </View>
      )}
      <View style={styles.featScrim} />
      <View style={styles.featBadge}>
        <FontAwesome5 name="star" size={8} color="#fff" solid />
        <Text style={styles.featBadgeText}>Featured</Text>
      </View>
      <View style={styles.featBody}>
        <Text style={styles.featTitle} numberOfLines={2}>{event.title}</Text>
        <Text style={styles.featMeta} numberOfLines={1}>
          {formatShortDate(event.starts_at)} · {formatTime(event.starts_at)}{event.venue ? ` · ${event.venue}` : ''}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

function TicketCard({ event, onPress, onTickets }: { event: OsEvent; onPress: () => void; onTickets: () => void }) {
  const priceLabel = event.ticket_types?.length
    ? (isFreeEvent(event.ticket_types) ? 'Free' : (() => { const l = lowestTicketPrice(event.ticket_types!); return l !== null ? `From £${(l / 100).toFixed(2)}` : null; })())
    : event.price_text;
  return (
    <TouchableOpacity style={styles.tkCard} onPress={onPress} activeOpacity={0.9}>
      {event.cover_url ? (
        <Image source={{ uri: event.cover_url }} style={styles.tkImage} />
      ) : (
        <View style={[styles.tkImage, { backgroundColor: S.color + '22', alignItems: 'center', justifyContent: 'center' }]}>
          <FontAwesome5 name="ticket-alt" size={20} color={S.color + '80'} solid />
        </View>
      )}
      <View style={{ padding: 10, gap: 4 }}>
        <Text style={styles.tkTitle} numberOfLines={2}>{event.title}</Text>
        <Text style={styles.tkMeta} numberOfLines={1}>{formatShortDate(event.starts_at)}</Text>
        <TouchableOpacity style={styles.tkBtn} onPress={(e) => { e.stopPropagation?.(); onTickets(); }} activeOpacity={0.85}>
          <FontAwesome5 name="ticket-alt" size={9} color="#fff" solid />
          <Text style={styles.tkBtnText}>{priceLabel ?? 'Tickets'}</Text>
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
}

function EventCard({ event, onPress }: { event: OsEvent; onPress: () => void }) {
  const router = useRouter();
  const starts = new Date(event.starts_at);
  const dateStr = formatShortDate(event.starts_at);
  const timeStr = formatTime(event.starts_at);

  const priceLabel = (() => {
    if (!event.has_tickets) return event.price_text ?? null;
    if (event.ticket_types?.length) {
      if (isFreeEvent(event.ticket_types)) return 'Free';
      const low = lowestTicketPrice(event.ticket_types);
      return low !== null ? `From £${(low / 100).toFixed(2)}` : null;
    }
    return event.price_text ?? null;
  })();

  const isFeatured = event.is_featured;

  return (
    <TouchableOpacity
      style={[styles.card, isFeatured && styles.cardFeatured]}
      onPress={onPress}
      activeOpacity={0.85}
    >
      {event.cover_url ? (
        <Image source={{ uri: event.cover_url }} style={styles.cardImage} />
      ) : (
        <View style={[styles.cardImagePlaceholder, { backgroundColor: S.color + '22' }]}>
          <FontAwesome5 name="calendar-alt" size={28} color={S.color + '80'} />
        </View>
      )}

      {isFeatured && (
        <View style={styles.featuredBadge}>
          <FontAwesome5 name="star" size={9} color="#fff" solid />
          <Text style={styles.featuredBadgeText}>Featured</Text>
        </View>
      )}

      <View style={styles.cardBody}>
        {/* Date strip */}
        <View style={[styles.datePill, { backgroundColor: S.color }]}>
          <Text style={styles.datePillDay}>{starts.getDate()}</Text>
          <Text style={styles.datePillMonth}>{starts.toLocaleString('en-GB', { month: 'short' }).toUpperCase()}</Text>
        </View>

        <View style={styles.cardMeta}>
          {event.category && (
            <Text style={[styles.cardCategory, { color: S.color }]}>{event.category}</Text>
          )}
          <Text style={styles.cardTitle} numberOfLines={2}>{event.title}</Text>
          <View style={styles.cardInfoRow}>
            {event.venue && (
              <View style={styles.cardInfoItem}>
                <FontAwesome5 name="map-marker-alt" size={10} color={colors.textMuted} />
                <Text style={styles.cardInfoText} numberOfLines={1}>{event.venue}</Text>
              </View>
            )}
            <View style={styles.cardInfoItem}>
              <FontAwesome5 name="clock" size={10} color={colors.textMuted} />
              <Text style={styles.cardInfoText}>{timeStr}</Text>
            </View>
          </View>
          <View style={styles.cardFootRow}>
            {event.business && (
              <Text style={styles.cardOrganiser} numberOfLines={1}>{event.business.name}</Text>
            )}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {priceLabel && (
                <View style={[styles.pricePill, { backgroundColor: priceLabel === 'Free' ? colors.successLight : S.light }]}>
                  <Text style={[styles.pricePillText, { color: priceLabel === 'Free' ? colors.success : S.color }]}>
                    {priceLabel}
                  </Text>
                </View>
              )}
              {event.has_tickets && (
                <TouchableOpacity
                  style={styles.ticketBtn}
                  onPress={e => {
                    e.stopPropagation?.();
                    router.push({ pathname: '/event-ticket-checkout', params: { id: event.id } });
                  }}
                  hitSlop={8}
                  activeOpacity={0.8}
                >
                  <FontAwesome5 name="ticket-alt" size={10} color="#fff" solid />
                  <Text style={styles.ticketBtnText}>Get tickets</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.navy },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10, backgroundColor: colors.screenBackground },

  filtersWrap: { backgroundColor: colors.white, borderBottomWidth: 1, borderBottomColor: colors.border },

  // View toggle
  toggleRow: { paddingHorizontal: spacing.md, paddingTop: 10 },
  toggle: { flexDirection: 'row', backgroundColor: colors.screenBackground, borderRadius: radius.full, padding: 3, alignSelf: 'flex-start', gap: 2 },
  toggleBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 7, borderRadius: radius.full },
  toggleText: { fontSize: fontSize.xs, fontWeight: '800', color: colors.textMuted },

  // Highlights (list header)
  highlightsWrap: { gap: 8 },
  rowHeading: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary, paddingHorizontal: 4 },
  rowHeadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, marginTop: spacing.md },
  hScroll: { gap: 10, paddingVertical: 8, paddingRight: 8 },

  featCard: { width: 260, height: 150, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: '#fff' },
  featImage: { ...StyleSheet.absoluteFillObject as any, width: '100%', height: '100%' },
  featScrim: { ...StyleSheet.absoluteFillObject as any, backgroundColor: 'rgba(0,0,0,0.32)' },
  featBadge: { position: 'absolute', top: 10, left: 10, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: S.color, paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.full },
  featBadgeText: { fontSize: 9, fontWeight: '800', color: '#fff' },
  featBody: { position: 'absolute', left: 12, right: 12, bottom: 12 },
  featTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '900', lineHeight: 20 },
  featMeta: { color: 'rgba(255,255,255,0.85)', fontSize: fontSize.xs, fontWeight: '600', marginTop: 2 },

  tkCard: { width: 168, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border },
  tkImage: { width: '100%', height: 96 },
  tkTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary, lineHeight: 17 },
  tkMeta: { fontSize: fontSize.xs, color: colors.textMuted },
  tkBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, backgroundColor: S.color, borderRadius: radius.full, paddingVertical: 10, paddingHorizontal: 12, marginTop: 2 },
  tkBtnText: { color: '#fff', fontSize: fontSize.xs, fontWeight: '800' },

  // Calendar mode
  calRow: { flex: 1, flexDirection: 'row', backgroundColor: colors.screenBackground },
  calLeft: { width: '50%' },
  calRight: { flex: 1, borderLeftWidth: 1, borderLeftColor: colors.border },
  dayPanel: { paddingHorizontal: spacing.md, paddingBottom: spacing.xxl, gap: 10 },
  dayHeading: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary },
  dayEmpty: { fontSize: fontSize.sm, color: colors.textMuted },
  filterRow:   { paddingHorizontal: spacing.md, paddingVertical: 8, gap: 6, flexDirection: 'row', alignItems: 'center' },
  chip: {
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: radius.full, borderWidth: 1.5, borderColor: colors.border,
    backgroundColor: '#fff',
  },
  chipText:    { fontSize: fontSize.xs, fontWeight: '700', color: colors.textMuted },
  chipDivider: { width: 1, height: 20, backgroundColor: colors.border, marginHorizontal: 2 },

  emptyTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  emptyText:  { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', paddingHorizontal: 32 },

  list: { padding: spacing.md, gap: 12, backgroundColor: colors.screenBackground },
  listTablet: { maxWidth: 980, alignSelf: 'center', width: '100%' },
  columnWrap: { gap: 12 },

  card: {
    backgroundColor: '#fff', borderRadius: radius.lg, overflow: 'hidden',
    borderWidth: 1, borderColor: colors.border,
    ...shadow.card,
  },
  cardFeatured: {
    borderColor: S.color + '60', borderWidth: 1.5,
  },
  cardImage: { width: '100%', height: 160, resizeMode: 'cover' },
  cardImagePlaceholder: { width: '100%', height: 120, alignItems: 'center', justifyContent: 'center' },

  featuredBadge: {
    position: 'absolute', top: 10, right: 10,
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: S.color, paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: radius.full,
  },
  featuredBadgeText: { fontSize: 9, fontWeight: '800', color: '#fff' },

  cardBody: { flexDirection: 'row', gap: 10, padding: spacing.md, paddingTop: 10 },

  datePill: {
    width: 40, alignItems: 'center', borderRadius: radius.md,
    paddingVertical: 6, flexShrink: 0, alignSelf: 'flex-start',
  },
  datePillDay:   { color: '#fff', fontSize: fontSize.md, fontWeight: '900', lineHeight: 18 },
  datePillMonth: { color: 'rgba(255,255,255,0.8)', fontSize: 9, fontWeight: '700' },

  cardMeta:     { flex: 1, gap: 3 },
  cardCategory: { fontSize: fontSize.xs, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
  cardTitle:    { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, lineHeight: 20 },
  cardInfoRow:  { flexDirection: 'row', gap: 10, flexWrap: 'wrap', marginTop: 2 },
  cardInfoItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  cardInfoText: { fontSize: fontSize.xs, color: colors.textMuted },
  cardFootRow:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  cardOrganiser:{ fontSize: fontSize.xs, color: colors.textMuted, flex: 1 },
  pricePill: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full,
  },
  pricePillText: { fontSize: fontSize.xs, fontWeight: '800' },
  ticketBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: S.color, borderRadius: radius.full,
    paddingHorizontal: 10, paddingVertical: 5,
  },
  ticketBtnText: { fontSize: fontSize.xs, fontWeight: '800', color: '#fff' },
});
