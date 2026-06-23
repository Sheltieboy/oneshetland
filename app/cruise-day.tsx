/**
 * app/cruise-day.tsx — ships in port on one date.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Image, StyleSheet, ActivityIndicator } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, spacing, radius, fontSize } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import DisplayText from '@/components/DisplayText';
import { getCruiseDay, baro, fmtTime, fmtDateLong, hoursAshore, type CruiseDay, type CruiseVisit } from '@/lib/cruise-api';
import { CruiseDayTimeline } from '@/components/cruise/CruiseDayTimeline';

const ACCENT = '#0E6E8C';
const STATUS: Record<string, { label: string; color: string }> = {
  scheduled: { label: 'Scheduled', color: colors.textMuted },
  confirmed: { label: 'Confirmed', color: colors.textMuted },
  in_port: { label: 'In port', color: '#1AA188' },
  departed: { label: 'Departed', color: colors.textLight },
  completed: { label: 'Departed', color: colors.textLight },
};

export default function CruiseDayScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { sidePadding } = useAppLayout();
  const { date } = useLocalSearchParams<{ date: string }>();

  const [summary, setSummary] = useState<CruiseDay | null>(null);
  const [visits, setVisits] = useState<CruiseVisit[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!date) return;
    getCruiseDay(date).then(({ summary, visits }) => { setSummary(summary); setVisits(visits); setLoading(false); }).catch(() => setLoading(false));
  }, [date]);

  const b = baro(summary?.barometer);
  const busy = summary && ['busy', 'very_busy', 'peak'].includes(summary.barometer);

  const arrivals = visits.map((v) => v.arrival_at).filter(Boolean) as string[];
  const departures = visits.map((v) => v.departure_at).filter(Boolean) as string[];
  const firstIn = arrivals.length ? arrivals.slice().sort()[0] : null;
  const lastOut = departures.length ? departures.slice().sort().slice(-1)[0] : null;
  const berths = new Set(visits.map((v) => v.berth_area_group).filter(Boolean)).size;
  const chips: { label: string; value: string }[] = [
    ...(firstIn ? [{ label: 'First in', value: fmtTime(firstIn) }] : []),
    ...(lastOut ? [{ label: 'Last out', value: fmtTime(lastOut) }] : []),
    ...(berths ? [{ label: berths === 1 ? 'Berth area' : 'Berth areas', value: String(berths) }] : []),
  ];

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={[styles.topBar, { paddingTop: insets.top ? 4 : 10 }]}>
        <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace('/cruise'))} hitSlop={12} style={styles.back}>
          <FontAwesome5 name="chevron-left" size={16} color={ACCENT} />
        </TouchableOpacity>
        <Text style={styles.topBarTitle}>Cruise calendar</Text>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: sidePadding + spacing.lg, paddingBottom: spacing.xxl }}>
        <DisplayText weight="black" style={styles.h1}>{date ? fmtDateLong(date) : ''}</DisplayText>

        {/* Barometer banner */}
        <View style={[styles.banner, { borderLeftColor: b.color }]}>
          <View style={[styles.dot, { backgroundColor: b.color }]} />
          <View style={{ flex: 1 }}>
            <Text style={styles.bannerTitle}>
              {b.label}
              {summary ? <Text style={styles.bannerSub}>  ·  {summary.ships_count} {summary.ships_count === 1 ? 'ship' : 'ships'} in port</Text> : null}
            </Text>
            {summary?.total_est_pax ? <Text style={styles.bannerMeta}>around {summary.total_est_pax.toLocaleString()} passengers ashore</Text> : null}
          </View>
        </View>

        {busy ? (
          <View style={styles.heads}><Text style={styles.headsText}>Lerwick town centre and the waterfront will be busy with visitors, roughly 9am–5pm.</Text></View>
        ) : null}

        {chips.length > 0 && (
          <View style={styles.chipRow}>
            {chips.map((c) => (
              <View key={c.label} style={styles.chip}>
                <Text style={styles.chipValue}>{c.value}</Text>
                <Text style={styles.chipLabel}>{c.label}</Text>
              </View>
            ))}
          </View>
        )}

        {visits.length > 0 && (
          <View style={{ marginTop: spacing.md }}>
            <CruiseDayTimeline visits={visits} />
          </View>
        )}

        <Text style={styles.sectionTitle}>In port</Text>
        {loading ? (
          <ActivityIndicator color={ACCENT} style={{ marginTop: 16 }} />
        ) : visits.length === 0 ? (
          <View style={styles.empty}><Text style={styles.emptyText}>No ships listed for this day.</Text></View>
        ) : (
          visits.map((v) => {
            const name = v.ship?.name ?? v.ship_name_cache ?? 'Ship';
            const st = STATUS[v.status] ?? STATUS.scheduled;
            const hrs = hoursAshore(v);
            return (
              <TouchableOpacity key={v.id} style={styles.shipRow} activeOpacity={0.85} onPress={() => router.push({ pathname: '/cruise-ship', params: { id: v.id } })}>
                {v.ship?.image_url ? (
                  <Image source={{ uri: v.ship.image_url }} style={styles.thumb} />
                ) : (
                  <View style={[styles.thumb, styles.thumbPlaceholder]}><FontAwesome5 name="ship" size={20} color={colors.textLight} /></View>
                )}
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.shipName} numberOfLines={1}>{name}</Text>
                  <Text style={styles.shipMeta} numberOfLines={1}>
                    {fmtTime(v.arrival_at)}–{fmtTime(v.departure_at)}{v.berth_area_group ? `  ·  ${v.berth_area_group}${v.is_tender ? ' (tender)' : ''}` : ''}
                  </Text>
                  <Text style={styles.shipMeta} numberOfLines={1}>
                    {v.est_pax ? `~${v.est_pax.toLocaleString()} pax` : v.est_pax_label ?? ''}{hrs ? `  ·  ${hrs} hrs ashore` : ''}
                  </Text>
                </View>
                <Text style={[styles.status, { color: st.color }]}>{st.label}</Text>
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  topBar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: spacing.lg, paddingBottom: 8 },
  back: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  topBarTitle: { color: ACCENT, fontWeight: '700', fontSize: fontSize.sm },
  h1: { fontSize: 28, color: colors.textPrimary, letterSpacing: -0.5, marginTop: 4, marginBottom: spacing.md, paddingHorizontal: spacing.lg - spacing.lg },

  banner: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, borderLeftWidth: 5, padding: 14 },
  dot: { width: 12, height: 12, borderRadius: 6 },
  bannerTitle: { fontSize: 18, fontWeight: '900', color: colors.textPrimary },
  bannerSub: { fontSize: fontSize.md, fontWeight: '400', color: colors.textMuted },
  bannerMeta: { fontSize: 13, color: colors.textMuted, marginTop: 2 },

  heads: { backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: 12, marginTop: 10 },
  headsText: { fontSize: 13, color: colors.textSecondary, lineHeight: 19 },

  chipRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  chip: { flex: 1, backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingVertical: 10, alignItems: 'center' },
  chipValue: { fontSize: 17, fontWeight: '900', color: colors.textPrimary, letterSpacing: -0.3 },
  chipLabel: { fontSize: 11, color: colors.textMuted, marginTop: 2 },

  sectionTitle: { fontSize: 17, fontWeight: '900', color: colors.textPrimary, marginTop: spacing.xl, marginBottom: spacing.sm },
  empty: { backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.xl, alignItems: 'center' },
  emptyText: { color: colors.textSecondary },

  shipRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 10, marginBottom: 10 },
  thumb: { width: 64, height: 64, borderRadius: 12 },
  thumbPlaceholder: { backgroundColor: colors.screenBackground, alignItems: 'center', justifyContent: 'center' },
  shipName: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  shipMeta: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
  status: { fontSize: 11, fontWeight: '800' },
});
