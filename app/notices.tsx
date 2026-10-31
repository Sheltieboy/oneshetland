/**
 * notices.tsx
 * Notices & Alerts: every public notice from Shetland's organisations, hubs, businesses and people, plus Deaths & Funeral Notices.
 * Reached from Home ("View all notices", an Essential Alert, a notice card). Reads the database functions in
 * docs/notices-alerts-contract.md (get_public_notices, get_funeral_notices); the server decides what is public and who published it.
 *
 *   filters     All / Essential alerts / Health & official / Community / Deaths & funeral, an area (or My areas) and a category
 *   paging      20 at a time, "Show more"
 *   links       ?tab=essential&open=<id> opens that tab with the notice highlighted
 *   destination campaign > event > hub > business > none (lib/notices-alerts.ts resolveDestination); a card with none is a plain block
 */

import React, { useEffect, useState, useCallback, useReducer, useRef } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, RefreshControl, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { LoadingState } from '@/components/ui/LoadingState';
import { EmptyState } from '@/components/ui/EmptyState';
import { NoticeListCard } from '@/components/notices/NoticeCards';
import { FuneralListCard } from '@/components/notices/FuneralTemplate';
import { AreaPicker } from '@/components/notices/AreaPicker';
import {
  NOTICE_TABS, INITIAL_FILTER, reduceFilter, appendPage, categoriesFrom, filterSummary,
  type NoticeModel, type NoticeTab, type FilterState,
} from '@/lib/notices-alerts';
import type { FuneralNoticeModel } from '@/lib/funeral-notices';
import { loadNoticePage, loadPublicNotice, loadAreas, loadCategories, FALLBACK_CATEGORIES, type AreaOption, type CategoryOption } from '@/lib/notices-alerts-api';
import { fetchMyNoticeAreas } from '@/lib/notice-prefs';
import { broadcastNotice, fetchNoticeBroadcastState } from '@/lib/notices-broadcast';
import { useAuth } from '@/context/AuthContext';
import { useAlert } from '@/components/BrandedAlert';

const S = SECTIONS.notices;

const EMPTY_COPY: Record<NoticeTab, { title: string; body: string }> = {
  all: { title: 'No notices right now.', body: 'When something is posted for your area it will appear here.' },
  essential: { title: 'No essential alerts.', body: 'Nothing urgent is in force. Essential alerts about roads, ferries, power and safety appear here and at the top of Home.' },
  official: { title: 'No official notices right now.', body: 'Notices from the council, NHS Shetland and other verified organisations appear here.' },
  community: { title: 'No community notices right now.', body: 'Notices from hubs, businesses and neighbours appear here.' },
  funeral: { title: 'No funeral notices at present.', body: 'Notices published with the family’s agreement appear here.' },
};

function FilterChip({ label, on, onPress, icon }: { label: string; on: boolean; onPress: () => void; icon?: string }) {
  return (
    <Pressable onPress={onPress} hitSlop={6} accessibilityRole="button" accessibilityState={{ selected: on }}
      style={[styles.chip, on && { backgroundColor: S.color, borderColor: S.color }]}>
      {icon ? <FontAwesome5 name={icon as any} size={11} color={on ? '#fff' : colors.textSecondary} solid /> : null}
      <Text style={[styles.chipText, on && { color: '#fff' }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

export default function NoticesScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ tab?: string; open?: string }>();
  const { screenWidth } = useAppLayout();
  const { profile } = useAuth();
  const { alert } = useAlert();

  const initialTab = (NOTICE_TABS.some((t) => t.key === params.tab) ? params.tab : 'all') as NoticeTab;
  const openId = typeof params.open === 'string' && params.open ? params.open : null;
  const [filter, dispatchFilter] = useReducer(reduceFilter, { ...INITIAL_FILTER, tab: initialTab } as FilterState);
  // Changing a filter ends the deep-linked view: the linked notice was shown on top only to land the reader on it.
  const dispatch = (a: Parameters<typeof reduceFilter>[1]) => { setLinked(null); setLinkedGone(false); dispatchFilter(a); };

  const [notices, setNotices] = useState<NoticeModel[]>([]);
  const [funeral, setFuneral] = useState<FuneralNoticeModel[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [myAreas, setMyAreas] = useState<string[]>([]);
  const [areas, setAreas] = useState<AreaOption[]>([]);
  const [categories, setCategories] = useState<CategoryOption[]>(FALLBACK_CATEGORIES);
  const [picker, setPicker] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [sentMap, setSentMap] = useState<Record<string, string | null>>({});
  const request = useRef(0);
  const [linked, setLinked] = useState<NoticeModel | null>(null);
  const [linkedGone, setLinkedGone] = useState(false);
  // Paging reads the latest lists through refs, so "Show more" never appends to a stale list.
  const noticesRef = useRef<NoticeModel[]>([]); noticesRef.current = notices;
  const funeralRef = useRef<FuneralNoticeModel[]>([]); funeralRef.current = funeral;

  const isAdmin = profile?.role === 'admin';
  const signedIn = !!profile?.id;

  // Reference data. Each is optional: a failure leaves the filter out, never the list.
  useEffect(() => {
    loadAreas().then(setAreas).catch(() => {});
    loadCategories().then(setCategories).catch(() => {});
  }, []);
  useEffect(() => {
    if (!signedIn) { setMyAreas([]); return; }
    fetchMyNoticeAreas().then(setMyAreas).catch(() => setMyAreas([]));
  }, [signedIn]);

  // Push an urgent notice to every device on the islands. Confirmed first, because it bypasses quiet hours and cannot be recalled.
  // (The existing admin tool; Essential Alerts are announced through their own, separate, once-only request on the website.)
  const broadcast = (n: NoticeModel) => {
    alert({
      title: 'Send to everyone?',
      message:
        `"${n.title}" will be pushed to every OneShetland user who hasn't turned notices off — ` +
        'including through quiet hours. It can only be sent once and cannot be recalled.',
      icon: 'exclamation-triangle',
      accent: colors.error,
      actions: [
        { label: 'Cancel', style: 'cancel' },
        {
          label: 'Send island-wide',
          style: 'destructive',
          onPress: async () => {
            setSending(n.id);
            try {
              const res = await broadcastNotice(n.id);
              setSentMap(prev => ({ ...prev, [n.id]: new Date().toISOString() }));
              alert({ title: 'Sent', message: `Delivered to ${res.sent} of ${res.recipients} devices.` });
            } catch (e) {
              alert({ title: 'Not sent', message: e instanceof Error ? e.message : 'Something went wrong.' });
            } finally {
              setSending(null);
            }
          },
        },
      ],
    });
  };

  // "My areas" is only consulted when that scope is chosen, so loading the saved areas does not reload the list.
  const scopeAreas = filter.scope.mode === 'mine' ? myAreas : null;

  /** Loads one page. offset 0 replaces the list; a later page is appended. A response for a superseded filter is dropped. */
  const fetchPage = useCallback(async (offset: number) => {
    const mine = ++request.current;
    try {
      const page = await loadNoticePage(filter, scopeAreas, offset);
      if (mine !== request.current) return;
      if (filter.tab === 'funeral') {
        const r = appendPage(offset === 0 ? [] : funeralRef.current, page.funeral, page.hasMore);
        setFuneral(r.items); setHasMore(r.hasMore);
      } else {
        const r = appendPage(offset === 0 ? [] : noticesRef.current, page.notices, page.hasMore);
        setNotices(r.items); setHasMore(r.hasMore);
        if (isAdmin && offset === 0) {
          const urgent = r.items.filter(n => n.severity === 'urgent' && !n.isEssential).map(n => n.id);
          if (urgent.length) fetchNoticeBroadcastState(urgent).then(setSentMap).catch(() => {});
        }
      }
      setError(null);
    } catch {
      if (mine !== request.current) return;
      setError('We could not load notices. Check your connection and try again.');
    }
  }, [filter, scopeAreas, isAdmin]);

  useEffect(() => {
    let alive = true;
    setLoading(true); setNotices([]); setFuneral([]); setHasMore(false);
    fetchPage(0).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [fetchPage]);

  const showMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const len = filter.tab === 'funeral' ? funeralRef.current.length : noticesRef.current.length;
    await fetchPage(len);
    setLoadingMore(false);
  }, [fetchPage, hasMore, loadingMore, filter.tab]);

  // A deep link (?open=<id>) fetches that one notice with get_public_notice and shows it on top, whatever page or filter it would be in.
  useEffect(() => {
    if (!openId) return;
    let alive = true;
    loadPublicNotice(openId).then((n) => { if (alive) { setLinked(n); setLinkedGone(!n); } }).catch(() => {});
    return () => { alive = false; };
  }, [openId]);

  const onRefresh = useCallback(async () => { setRefreshing(true); await fetchPage(0); setRefreshing(false); }, [fetchPage]);

  const scopeLabel = filter.scope.mode === 'all' ? 'All Shetland'
    : filter.scope.mode === 'mine' ? 'My areas'
    : (areas.find((a) => a.id === (filter.scope as { areaId: string }).areaId)?.name ?? 'One area');
  const categoryOptions = categories.length ? categories : categoriesFrom(notices);
  const isFuneral = filter.tab === 'funeral';
  const categoryLabel = !isFuneral && filter.category ? (categoryOptions.find((c) => c.id === filter.category)?.label ?? filter.category) : null;
  const summary = filterSummary(filter.scope.mode === 'all' ? null : scopeLabel, categoryLabel);
  const listLength = isFuneral ? funeral.length : notices.length;

  return (
    <ScreenScaffold
      header={
        <ScreenHeader
          title="Notices & alerts"
          accent={S.color}
          onBack={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))}
        />
      }
    >
      <ScrollView
        stickyHeaderIndices={[0]}
        contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={S.color} />}>

        {/* Only the type tabs stay in view while the list scrolls (sticky child 0). */}
        <View style={styles.filters}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow} accessibilityRole="tablist">
            {NOTICE_TABS.map((t) => <FilterChip key={t.key} label={t.label} on={filter.tab === t.key} onPress={() => dispatch({ type: 'tab', tab: t.key })} />)}
          </ScrollView>
        </View>

        {/* Area and category live in a collapsible Filters row that scrolls away with the content. Its summary stays visible while a filter is active. */}
        <View style={styles.filterBox}>
          <Pressable onPress={() => setFiltersOpen((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: filtersOpen }}
            accessibilityLabel={summary ? `Filters: ${summary}. ${filtersOpen ? 'Hide' : 'Show'} filters` : `${filtersOpen ? 'Hide' : 'Show'} filters`} style={styles.filterHead}>
            <FontAwesome5 name="sliders-h" size={13} color={colors.navy} />
            <Text style={styles.filterTitle}>Filters</Text>
            <Text style={[styles.filterSummary, !summary && { color: colors.textLight }]} numberOfLines={1}>{summary || 'All Shetland, any category'}</Text>
            <FontAwesome5 name={filtersOpen ? 'chevron-up' : 'chevron-down'} size={11} color={colors.textLight} />
          </Pressable>
          {filtersOpen ? (
            <View style={{ gap: 6, paddingBottom: 10 }}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                <FilterChip icon="map-marker-alt" label={filter.scope.mode === 'area' ? scopeLabel : 'Choose area'} on={filter.scope.mode === 'area'} onPress={() => setPicker(true)} />
                {signedIn && myAreas.length > 0 ? (
                  <FilterChip label="My areas" on={filter.scope.mode === 'mine'} onPress={() => dispatch({ type: 'scope', scope: filter.scope.mode === 'mine' ? { mode: 'all' } : { mode: 'mine' } })} />
                ) : null}
                {filter.scope.mode !== 'all' ? <FilterChip label="All Shetland" on={false} onPress={() => dispatch({ type: 'scope', scope: { mode: 'all' } })} /> : null}
              </ScrollView>
              {!isFuneral ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                  <FilterChip label="Any category" on={filter.category === null} onPress={() => dispatch({ type: 'category', category: null })} />
                  {categoryOptions.map((c) => <FilterChip key={c.id} label={c.label} on={filter.category === c.id} onPress={() => dispatch({ type: 'category', category: filter.category === c.id ? null : c.id })} />)}
                </ScrollView>
              ) : null}
            </View>
          ) : null}
        </View>

        {linkedGone && !isFuneral ? <Text style={styles.inlineError}>That notice is no longer current. It may have ended or been withdrawn.</Text> : null}
        {isFuneral ? (
          <View style={styles.funeralActions}>
            <Pressable onPress={() => router.push('/funeral-notice-submit' as any)} accessibilityRole="button" style={styles.fAction}>
              <FontAwesome5 name="pen" size={12} color={colors.navy} />
              <Text style={styles.fActionText}>Submit a notice</Text>
            </Pressable>
            <Pressable onPress={() => router.push('/my-funeral-notices' as any)} accessibilityRole="button" style={styles.fAction}>
              <FontAwesome5 name="folder-open" size={12} color={colors.navy} />
              <Text style={styles.fActionText}>My submissions</Text>
            </Pressable>
          </View>
        ) : null}

        {loading ? (
          <LoadingState accent={S.color} />
        ) : error && listLength === 0 ? (
          <EmptyState icon="exclamation-circle" title="Notices did not load" body={error} accent={S.color} variant="card" actionLabel="Try again" onAction={() => { setLoading(true); fetchPage(0).finally(() => setLoading(false)); }} />
        ) : listLength === 0 && !linked ? (
          <EmptyState icon="bullhorn" title={EMPTY_COPY[filter.tab].title} body={EMPTY_COPY[filter.tab].body} accent={S.color} variant="card" />
        ) : isFuneral ? (
          funeral.map((f) => <FuneralListCard key={f.id} f={f} onPress={() => router.push({ pathname: '/funeral-notice', params: { id: f.id } } as any)} />)
        ) : (linked && !isFuneral ? [linked, ...notices.filter((x) => x.id !== linked.id)] : notices).map((n) => {
          const isUrgent = n.severity === 'urgent' && !n.isEssential;
          return (
            <NoticeListCard
              key={n.id}
              n={n}
              highlighted={openId === n.id}
              onOpenDestination={(d) => router.push(d.route as any)}
              adminAction={isAdmin && isUrgent ? (
                // Admin only: push an urgent notice to every device.
                sentMap[n.id] ? (
                  <View style={styles.sentRow}>
                    <FontAwesome5 name="check-circle" size={11} color={colors.success} solid />
                    <Text style={styles.sentText}>Sent island-wide</Text>
                  </View>
                ) : (
                  <Pressable style={styles.broadcastBtn} disabled={sending === n.id} onPress={() => broadcast(n)} accessibilityRole="button">
                    <FontAwesome5 name="broadcast-tower" size={12} color="#fff" solid />
                    <Text style={styles.broadcastText}>{sending === n.id ? 'Sending…' : 'Send to everyone'}</Text>
                  </Pressable>
                )
              ) : null}
            />
          );
        })}

        {!loading && hasMore ? (
          <Pressable onPress={showMore} disabled={loadingMore} accessibilityRole="button" accessibilityLabel="Show more notices" style={styles.more}>
            {loadingMore ? <ActivityIndicator color={S.color} /> : <Text style={styles.moreText}>Show more</Text>}
          </Pressable>
        ) : null}
        {error && listLength > 0 ? <Text style={styles.inlineError}>{error}</Text> : null}
        <View style={{ height: 40 }} />
      </ScrollView>

      <AreaPicker
        visible={picker}
        title="Choose an area"
        areas={areas}
        selected={filter.scope.mode === 'area' ? [filter.scope.areaId] : []}
        onClose={() => setPicker(false)}
        onDone={(ids) => { setPicker(false); if (ids[0]) dispatch({ type: 'scope', scope: { mode: 'area', areaId: ids[0] } }); }}
      />
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md, gap: spacing.sm },
  filterBox: { backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  filterHead: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14 },
  filterTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.navy },
  filterSummary: { flex: 1, fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: '600' },
  filters: { backgroundColor: colors.screenBackground, paddingBottom: 4, gap: 6, marginHorizontal: -spacing.md, paddingHorizontal: spacing.md },
  chipRow: { gap: 8, paddingVertical: 2, paddingRight: spacing.md },
  chip: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, borderRadius: 99, borderWidth: 1, borderColor: colors.border, backgroundColor: '#fff' },
  chipText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary },

  funeralActions: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  fAction: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: '#fff' },
  fActionText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.navy },

  more: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: '#fff', marginTop: 4 },
  moreText: { fontSize: fontSize.sm, fontWeight: '800', color: colors.navy },
  inlineError: { textAlign: 'center', color: colors.errorDark, fontSize: fontSize.xs, marginTop: 6 },

  broadcastBtn:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: spacing.sm, backgroundColor: colors.error, borderRadius: radius.md, minHeight: 44 },
  broadcastText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
  sentRow:       { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing.sm },
  sentText:      { fontSize: fontSize.xs, fontWeight: '700', color: colors.success },
});
