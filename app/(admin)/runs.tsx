import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { Card } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { colors, fontSize, spacing, radius } from '@/constants/theme';

interface Run {
  id: string;
  driver_id: string;
  departure_start: string;
  departure_end: string;
  ferry_crossing: boolean;
  notes: string | null;
  status: string;
  categories_accepted: string[];
  driver_name: string;
  request_count: number;
}

const STATUS_FILTERS = ['all', 'open', 'completed', 'cancelled'] as const;
type StatusFilter = typeof STATUS_FILTERS[number];

export default function AdminRunsScreen() {
  const router = useRouter();
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>('open');

  const fetchRuns = useCallback(async () => {
    let query = supabase
      .from('runs')
      .select('id, driver_id, departure_start, departure_end, ferry_crossing, notes, status, categories_accepted')
      .order('departure_start', { ascending: false })
      .limit(100);

    if (filter !== 'all') {
      query = query.eq('status', filter);
    }

    const { data } = await query;
    const runsData = (data as any[]) ?? [];

    // Fetch driver names and request counts in parallel
    const runIds = runsData.map((r) => r.id);
    const driverIds = [...new Set(runsData.map((r) => r.driver_id).filter(Boolean))];
    let countsMap: Record<string, number> = {};
    let namesMap: Record<string, string> = {};

    await Promise.all([
      runIds.length > 0
        ? supabase
            .from('delivery_requests')
            .select('run_id')
            .in('run_id', runIds)
            .neq('status', 'cancelled')
            .then(({ data: countData }) => {
              (countData ?? []).forEach((row: { run_id: string }) => {
                countsMap[row.run_id] = (countsMap[row.run_id] ?? 0) + 1;
              });
            })
        : Promise.resolve(),
      driverIds.length > 0
        ? supabase
            .from('profiles')
            .select('id, full_name')
            .in('id', driverIds)
            .then(({ data: profileData }) => {
              (profileData ?? []).forEach((p: { id: string; full_name: string | null }) => {
                if (p.full_name) namesMap[p.id] = p.full_name;
              });
            })
        : Promise.resolve(),
    ]);

    setRuns(
      runsData.map((r) => ({
        ...r,
        driver_name: namesMap[r.driver_id] ?? 'Unknown driver',
        request_count: countsMap[r.id] ?? 0,
      })),
    );
    setLoading(false);
    setRefreshing(false);
  }, [filter]);

  useEffect(() => {
    setLoading(true);
    fetchRuns();
  }, [fetchRuns]);

  function onRefresh() {
    setRefreshing(true);
    fetchRuns();
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
        }
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backLink}>
            <Text style={styles.backLinkText}>‹ Back</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Runs</Text>
          <Text style={styles.subtitle}>All driver runs across Shetland.</Text>
        </View>

        {/* Filter tabs */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
        >
          {STATUS_FILTERS.map((s) => (
            <TouchableOpacity
              key={s}
              style={[styles.filterChip, filter === s && styles.filterChipActive]}
              onPress={() => setFilter(s)}
            >
              <Text style={[styles.filterChipText, filter === s && styles.filterChipTextActive]}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <View style={styles.body}>
          {loading ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyBody}>Loading…</Text>
            </Card>
          ) : runs.length === 0 ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyIcon}>🚗</Text>
              <Text style={styles.emptyTitle}>No runs</Text>
              <Text style={styles.emptyBody}>
                {filter === 'all' ? 'No runs yet.' : `No ${filter} runs.`}
              </Text>
            </Card>
          ) : (
            <>
              <Text style={styles.count}>
                {runs.length} run{runs.length !== 1 ? 's' : ''}
              </Text>
              {runs.map((run) => {
                const start = new Date(run.departure_start);
                const end = new Date(run.departure_end);
                const today = new Date();
                const isToday = start.toDateString() === today.toDateString();
                const dayLabel = isToday
                  ? 'Today'
                  : start.toLocaleDateString('en-GB', {
                      weekday: 'short',
                      day: 'numeric',
                      month: 'short',
                    });
                const timeRange = `${start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} – ${end.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
                const noteLines = (run.notes ?? '').split('\n');
                const origin =
                  noteLines.find((l) => l.startsWith('Origin:'))?.replace('Origin: ', '') ??
                  'Lerwick';
                const destination =
                  noteLines.find((l) => l.startsWith('Destination:'))?.replace(
                    'Destination: ',
                    '',
                  ) ?? '—';

                return (
                  <Card key={run.id} style={styles.runCard}>
                    {/* Route + status */}
                    <View style={styles.runTopRow}>
                      <Text style={styles.runRoute} numberOfLines={1}>
                        {origin} → {destination}
                      </Text>
                      <StatusBadge status={run.status} />
                    </View>

                    {/* Time */}
                    <Text style={styles.runTime}>
                      {dayLabel}, {timeRange}
                    </Text>

                    {/* Driver + ferry + requests */}
                    <View style={styles.runMetaRow}>
                      <View style={styles.runMeta}>
                        <Text style={styles.runMetaText}>
                          🧑‍✈️ {run.driver_name}
                        </Text>
                      </View>
                      {run.ferry_crossing && (
                        <View style={styles.ferryBadge}>
                          <Text style={styles.ferryText}>⛴ Ferry</Text>
                        </View>
                      )}
                      <View style={styles.requestsBadge}>
                        <Text style={styles.requestsBadgeText}>
                          📦 {run.request_count} request{run.request_count !== 1 ? 's' : ''}
                        </Text>
                      </View>
                    </View>

                    {/* Categories */}
                    {run.categories_accepted?.length > 0 && (
                      <View style={styles.categoryRow}>
                        {run.categories_accepted.slice(0, 3).map((c) => (
                          <View key={c} style={styles.categoryChip}>
                            <Text style={styles.categoryText}>{c}</Text>
                          </View>
                        ))}
                        {run.categories_accepted.length > 3 && (
                          <Text style={styles.categoryMore}>
                            +{run.categories_accepted.length - 3} more
                          </Text>
                        )}
                      </View>
                    )}
                  </Card>
                );
              })}
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  content: { backgroundColor: colors.screenBackground, paddingBottom: spacing.xxl, flexGrow: 1 },

  header: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
  },
  backLink: { marginBottom: spacing.md },
  backLinkText: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.sm },
  title: { color: colors.white, fontSize: fontSize.xxl, fontWeight: '800', marginBottom: spacing.xs },
  subtitle: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.sm, lineHeight: 20 },

  filterRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.full,
    backgroundColor: colors.offWhite,
    borderWidth: 1,
    borderColor: colors.border,
  },
  filterChipActive: { backgroundColor: colors.navy, borderColor: colors.navy },
  filterChipText: { fontSize: fontSize.sm, fontWeight: '600', color: colors.textMuted },
  filterChipTextActive: { color: colors.white },

  body: { padding: spacing.lg },
  count: { fontSize: fontSize.sm, fontWeight: '600', color: colors.textMuted, marginBottom: spacing.md },

  emptyCard: { alignItems: 'center', paddingVertical: spacing.xxl },
  emptyIcon: { fontSize: 36, marginBottom: spacing.sm },
  emptyTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.navy, marginBottom: spacing.xs },
  emptyBody: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },

  runCard: { marginBottom: spacing.sm },
  runTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
    gap: spacing.sm,
  },
  runRoute: { fontSize: fontSize.md, fontWeight: '700', color: colors.navy, flex: 1 },
  runTime: { fontSize: fontSize.sm, color: colors.textMuted, marginBottom: spacing.sm },
  runMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.sm,
    alignItems: 'center',
  },
  runMeta: { flexDirection: 'row', alignItems: 'center' },
  runMetaText: { fontSize: fontSize.sm, color: colors.textPrimary },
  ferryBadge: {
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  ferryText: { fontSize: fontSize.xs, color: '#1D4ED8', fontWeight: '600' },
  requestsBadge: {
    backgroundColor: colors.offWhite,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  requestsBadgeText: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600' },
  categoryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  categoryChip: {
    backgroundColor: colors.offWhite,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  categoryText: { fontSize: fontSize.xs, color: colors.textMuted },
  categoryMore: { fontSize: fontSize.xs, color: colors.textLight, alignSelf: 'center' },
});
