/**
 * app/cruise.tsx — Cruise ships in Lerwick (calendar + upcoming).
 * Pushable screen. Responsive phone → tablet via useAppLayout.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator,
  Image, ImageBackground, RefreshControl, type LayoutChangeEvent,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, spacing, radius, fontSize, SIDEBAR_WIDTH } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { AppBottomNav } from '@/components/AppBottomNav';
import DisplayText from '@/components/DisplayText';
import { CruiseTodayCard } from '@/components/CruiseTodayCard';
import { CruiseSeasonStats } from '@/components/cruise/CruiseSeasonStats';
import { CruiseScopeView } from '@/components/cruise/CruiseScopeView';
import { CruiseMap, type MapMarker, type MapLine } from '@/components/cruise/CruiseMap';
import {
  getMonthDays, getUpcomingDaysRich, getSeasonOrigins, getScopeData, getScopeAvailability, getCruiseHomeCard, scopeRange, SCOPES, baro, BARO, monthLabel, fmtDateShort, londonToday, londonMonth, CRUISE_HERO, LERWICK,
  type CruiseDay, type CruiseDayRich, type Barometer, type Origin, type CruiseScope, type ScopeData,
} from '@/lib/cruise-api';

const ACCENT = '#0E6E8C';
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function shiftMonth(month: string, by: number) {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + by);
  return d.toISOString().slice(0, 7);
}

export default function CruiseScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { sidePadding, isTablet } = useAppLayout();

  const [month, setMonth] = useState(() => londonMonth());
  const [days, setDays] = useState<Record<string, CruiseDay>>({});
  const [upcoming, setUpcoming] = useState<CruiseDayRich[]>([]);
  const [loading, setLoading] = useState(true);
  const [gridW, setGridW] = useState(0);
  const [origins, setOrigins] = useState<Origin[]>([]);

  const today = londonToday();
  const [scope, setScope] = useState<CruiseScope>('season');
  const range = scope === 'season' ? null : scopeRange(scope, today);
  const [scopeData, setScopeData] = useState<ScopeData | null>(null);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [nextDate, setNextDate] = useState<string | null>(null);
  const [avail, setAvail] = useState<Record<'today' | 'weekend' | 'week', boolean>>({ today: true, weekend: true, week: true });
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => { getScopeAvailability(today).then(setAvail).catch(() => {}); }, [today]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        getUpcomingDaysRich(40).then(setUpcoming),
        getMonthDays(month).then(setDays),
        getScopeAvailability(today).then(setAvail),
        getSeasonOrigins().then(setOrigins),
        range ? getScopeData(range.from, range.to).then(setScopeData) : Promise.resolve(),
      ]);
    } catch { /* keep the last good data on a failed refresh */ }
    setRefreshing(false);
  }, [month, today, range?.from, range?.to]);

  useEffect(() => {
    if (!range) { setScopeData(null); return; }
    let alive = true;
    setScopeLoading(true);
    Promise.all([getScopeData(range.from, range.to), getCruiseHomeCard()])
      .then(([d, card]) => { if (alive) { setScopeData(d); setNextDate(card?.date ?? null); setScopeLoading(false); } })
      .catch(() => { if (alive) setScopeLoading(false); });
    return () => { alive = false; };
  }, [scope, range?.from, range?.to]);

  useEffect(() => { getSeasonOrigins().then(setOrigins).catch(() => {}); }, []);
  useEffect(() => { getMonthDays(month).then(setDays).catch(() => {}); }, [month]);
  useFocusEffect(useCallback(() => {
    let alive = true;
    getUpcomingDaysRich(40).then((u) => { if (alive) { setUpcoming(u); setLoading(false); } }).catch(() => setLoading(false));
    return () => { alive = false; };
  }, []));

  // Month grid
  const first = new Date(`${month}-01T00:00:00Z`);
  const daysInMonth = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const offset = (first.getUTCDay() + 6) % 7;
  const cells: (string | null)[] = [];
  for (let i = 0; i < offset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(`${month}-${String(d).padStart(2, '0')}`);
  const cell = gridW > 0 ? (gridW - 6 * 6) / 7 : 0;

  return (
    <SafeAreaView style={styles.safe} edges={[]}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={{ flex: 1, paddingLeft: isTablet ? SIDEBAR_WIDTH : 0 }}>
      {/* Header band — extends under the status bar so the safe-area strip matches the header colour. */}
      <ImageBackground source={{ uri: CRUISE_HERO }} imageStyle={{ opacity: 0.32 }} style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))} hitSlop={12} style={styles.back}>
            <FontAwesome5 name="chevron-left" size={16} color="#fff" />
          </TouchableOpacity>
          <DisplayText weight="black" style={styles.headerTitle}>Cruise ships</DisplayText>
        </View>
        <Text style={styles.headerSub}>Lerwick — the Barometer tells you how busy town will be.</Text>
        <View style={styles.legend}>
          {(['quiet', 'busy', 'very_busy', 'peak'] as Barometer[]).map((k) => (
            <View key={k} style={styles.legendItem}>
              <View style={[styles.dot, { backgroundColor: BARO[k].color }]} />
              <Text style={styles.legendText}>{BARO[k].label}</Text>
            </View>
          ))}
        </View>
      </ImageBackground>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: sidePadding + spacing.lg, paddingBottom: spacing.xxl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} colors={[ACCENT]} />}
      >
        {/* Scope pills */}
        <View style={styles.pills}>
          {SCOPES.map((s) => {
            const on = s.key === scope;
            const disabled = s.key !== 'season' && !avail[s.key as 'today' | 'weekend' | 'week'];
            return (
              <TouchableOpacity
                key={s.key}
                activeOpacity={0.85}
                disabled={disabled}
                onPress={() => setScope(s.key)}
                style={[styles.pill, on && styles.pillOn, disabled && styles.pillDisabled]}
              >
                <Text style={[styles.pillText, on && styles.pillTextOn, disabled && styles.pillTextDisabled]}>{s.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {range ? (
          <>
            <Text style={styles.sectionTitle}>{range.label} in Lerwick</Text>
            {scopeLoading && !scopeData ? (
              <ActivityIndicator color={ACCENT} style={{ marginTop: 20 }} />
            ) : scopeData ? (
              <CruiseScopeView label={range.label} from={range.from} to={range.to} data={scopeData} nextDate={nextDate} today={today} />
            ) : null}
          </>
        ) : (
        <>
        <CruiseTodayCard style={{ marginTop: spacing.lg }} />

        {/* Season at a glance */}
        <Text style={styles.sectionTitle}>The season at a glance</Text>
        <CruiseSeasonStats show="tiles" />

        {/* Month calendar */}
        <View style={styles.monthRow}>
          <Text style={styles.monthTitle}>{monthLabel(month)}</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Previous month" onPress={() => setMonth(shiftMonth(month, -1))} hitSlop={8} style={styles.navBtn}><FontAwesome5 name="chevron-left" size={12} color={colors.textPrimary} /></TouchableOpacity>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Next month" onPress={() => setMonth(shiftMonth(month, 1))} hitSlop={8} style={styles.navBtn}><FontAwesome5 name="chevron-right" size={12} color={colors.textPrimary} /></TouchableOpacity>
          </View>
        </View>

        <View style={styles.card} onLayout={(e: LayoutChangeEvent) => setGridW(e.nativeEvent.layout.width - 24)}>
          <View style={styles.dowRow}>
            {DOW.map((d) => <Text key={d} style={[styles.dow, { width: cell || undefined }]}>{d}</Text>)}
          </View>
          <View style={styles.grid}>
            {cell > 0 && cells.map((date, i) => {
              if (!date) return <View key={`b${i}`} style={{ width: cell, height: cell * 0.92, margin: 3 }} />;
              const day = days[date];
              const b = day ? baro(day.barometer) : null;
              const dn = Number(date.slice(8));
              return (
                <TouchableOpacity
                  key={date}
                  disabled={!day}
                  onPress={() => router.push({ pathname: '/cruise-day', params: { date } })}
                  style={{ width: cell, height: cell * 0.92, margin: 3, borderRadius: 9, padding: 5, backgroundColor: b ? b.tint : colors.screenBackground }}
                >
                  <Text style={{ fontSize: 12, fontWeight: b ? '800' : '400', color: b ? colors.textPrimary : colors.textLight }}>{dn}</Text>
                  {day && day.total_est_pax ? (
                    <Text style={{ fontSize: 9, fontWeight: '800', color: b!.color, marginTop: 1 }}>
                      {day.total_est_pax >= 1000 ? `${(day.total_est_pax / 1000).toFixed(1)}k` : day.total_est_pax}
                    </Text>
                  ) : null}
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Where ships sail from */}
        {origins.length > 0 && (() => {
          const maxC = Math.max(...origins.map((o) => o.count));
          const markers: MapMarker[] = [
            { lat: LERWICK[0], lng: LERWICK[1], label: 'Lerwick', hub: true },
            ...origins.map((o) => ({ lat: o.lat, lng: o.lng, label: `${o.name} · ${o.count}`, size: 9 + Math.round((o.count / maxC) * 13) })),
          ];
          const lines: MapLine[] = origins.map((o) => [[o.lat, o.lng], [LERWICK[0], LERWICK[1]]]);
          return (
            <>
              <Text style={styles.sectionTitle}>Where ships sail from</Text>
              <Text style={styles.sectionSub}>Every cruise calling at Lerwick this season, by the port it sailed from.</Text>
              <CruiseMap markers={markers} lines={lines} height={300} />
            </>
          );
        })()}

        {/* Passengers by month */}
        <View style={{ marginTop: spacing.lg }}>
          <CruiseSeasonStats show="chart" />
        </View>

        {/* Upcoming */}
        <Text style={styles.sectionTitle}>Coming up</Text>
        {loading ? (
          <ActivityIndicator color={ACCENT} style={{ marginTop: 20 }} />
        ) : upcoming.length === 0 ? (
          <View style={styles.empty}><Text style={styles.emptyText}>No upcoming cruise calls listed just now.</Text></View>
        ) : (
          upcoming.map((d) => {
            const b = baro(d.barometer);
            return (
              <TouchableOpacity key={d.visit_date} style={styles.dayCard} activeOpacity={0.85} onPress={() => router.push({ pathname: '/cruise-day', params: { date: d.visit_date } })}>
                {d.lead_image ? (
                  <Image source={{ uri: d.lead_image }} style={styles.dayThumb} />
                ) : (
                  <View style={[styles.dayThumb, { backgroundColor: b.tint, alignItems: 'center', justifyContent: 'center' }]}>
                    <FontAwesome5 name="ship" size={18} color={b.color} />
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={styles.dayDate}>{fmtDateShort(d.visit_date)}</Text>
                    {d.visit_date === today && <View style={styles.todayPill}><Text style={styles.todayPillText}>TODAY</Text></View>}
                  </View>
                  <Text style={styles.dayMeta}>{d.ships_count} {d.ships_count === 1 ? 'ship' : 'ships'}{d.total_est_pax ? ` · ~${d.total_est_pax.toLocaleString()} passengers` : ''}</Text>
                </View>
                <View style={[styles.baroPill, { backgroundColor: b.tint }]}><Text style={[styles.baroPillText, { color: b.color }]}>{b.label}</Text></View>
              </TouchableOpacity>
            );
          })
        )}
        </>
        )}
      </ScrollView>
      </View>
      <AppBottomNav />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  header: { backgroundColor: ACCENT, paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  back: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.18)' },
  headerTitle: { fontSize: 26, color: '#fff', letterSpacing: -0.3 },
  headerSub: { color: 'rgba(255,255,255,0.9)', fontSize: fontSize.sm, marginTop: 6 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  legendText: { color: 'rgba(255,255,255,0.92)', fontSize: 12 },

  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: spacing.lg },
  pill: { borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: '#fff', paddingHorizontal: 16, paddingVertical: 9 },
  pillOn: { backgroundColor: colors.navy, borderColor: colors.navy },
  pillDisabled: { backgroundColor: colors.screenBackground, borderColor: colors.border, opacity: 0.6 },
  pillText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  pillTextOn: { color: '#fff' },
  pillTextDisabled: { color: colors.textLight },

  monthRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.lg, marginBottom: spacing.sm },
  monthTitle: { fontSize: 18, fontWeight: '900', color: colors.textPrimary, letterSpacing: -0.3 },
  navBtn: { width: 30, height: 30, borderRadius: 15, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },

  card: { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 12 },
  dowRow: { flexDirection: 'row', marginBottom: 4, paddingHorizontal: 3 },
  dow: { fontSize: 11, color: colors.textLight, textAlign: 'left', marginHorizontal: 3 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },

  sectionTitle: { fontSize: 18, fontWeight: '900', color: colors.textPrimary, letterSpacing: -0.3, marginTop: spacing.xl, marginBottom: spacing.sm },
  sectionSub: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: -spacing.xs, marginBottom: spacing.md },
  empty: { backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.xl, alignItems: 'center' },
  emptyText: { color: colors.textSecondary },

  dayCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 12, marginBottom: 10 },
  dayBar: { width: 5, height: 38, borderRadius: 3 },
  dayThumb: { width: 52, height: 52, borderRadius: 12 },
  dayDate: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  dayMeta: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  todayPill: { backgroundColor: colors.navy, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 },
  todayPillText: { color: '#fff', fontSize: 9, fontWeight: '900' },
  baroPill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  baroPillText: { fontSize: 11, fontWeight: '800' },
});
