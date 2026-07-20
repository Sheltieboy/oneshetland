/** Focused time-window view for the app cruise screen (Today / Weekend / This week). */
import React from 'react';
import { View, Text, TouchableOpacity, Image, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, spacing, radius, fontSize } from '@/constants/theme';
import { CruiseMap, type MapMarker, type MapLine } from '@/components/cruise/CruiseMap';
import {
  baro, fmtDateShort, fmtTime, LERWICK,
  type ScopeData, type CruiseVisit,
} from '@/lib/cruise-api';
import { shipImageSource } from '@/lib/cruise-ship-images';

const ACCENT = '#0E6E8C';

export function CruiseScopeView({
  label, from, to, data, nextDate, today,
}: {
  label: string;
  from: string;
  to: string;
  data: ScopeData;
  nextDate: string | null;
  today: string;
}) {
  const router = useRouter();
  const { stats, daysByDate, visits, origins } = data;
  const multiday = from !== to;

  if (visits.length === 0) {
    return (
      <View style={st.empty}>
        <FontAwesome5 name="ship" size={22} color={colors.textLight} />
        <Text style={st.emptyText}>No cruise ships in port {label.toLowerCase()}.</Text>
        {nextDate ? (
          <TouchableOpacity style={st.nextBtn} onPress={() => router.push({ pathname: '/cruise-day', params: { date: nextDate } })}>
            <Text style={st.nextBtnText}>Next call · {fmtDateShort(nextDate)}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }

  const tiles: { l: string; v: string; sub?: string }[] = multiday
    ? [
        { l: 'Ship calls', v: String(stats.calls) },
        { l: 'Passengers', v: stats.pax.toLocaleString() },
        { l: 'Different ships', v: String(stats.distinctShips) },
        ...(stats.busiestDay ? [{ l: 'Busiest day', v: `~${stats.busiestDay.pax.toLocaleString()}`, sub: fmtDateShort(stats.busiestDay.date) }] : []),
      ]
    : [
        { l: 'Ships in port', v: String(stats.calls) },
        { l: 'Passengers', v: stats.pax.toLocaleString() },
        ...(stats.firstIn ? [{ l: 'First in', v: fmtTime(stats.firstIn) }] : []),
        ...(stats.lastOut ? [{ l: 'Last out', v: fmtTime(stats.lastOut) }] : []),
      ];

  // Group visits by date.
  const byDate: Record<string, CruiseVisit[]> = {};
  for (const v of visits) { const k = v.visit_date ?? ''; (byDate[k] ??= []).push(v); }
  const orderedDates = Object.keys(byDate).sort();

  // Strip = every date in window.
  const stripDates: string[] = [];
  { let cur = from; for (let i = 0; i < 60 && cur <= to; i++) { stripDates.push(cur); const d = new Date(`${cur}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); cur = d.toISOString().slice(0, 10); } }

  // Map data.
  const maxC = origins.length ? Math.max(...origins.map((o) => o.count)) : 1;
  const markers: MapMarker[] = [
    { lat: LERWICK[0], lng: LERWICK[1], label: 'Lerwick', hub: true },
    ...origins.map((o) => ({ lat: o.lat, lng: o.lng, label: `${o.name} · ${o.count}`, size: 9 + Math.round((o.count / maxC) * 13) })),
  ];
  const lines: MapLine[] = origins.map((o) => [[o.lat, o.lng], [LERWICK[0], LERWICK[1]]]);

  return (
    <View>
      {/* Stat tiles */}
      <View style={st.tiles}>
        {tiles.map((t) => (
          <View key={t.l} style={st.tile}>
            <Text style={st.tileLabel}>{t.l}</Text>
            <Text style={st.tileValue}>{t.v}</Text>
            {t.sub ? <Text style={st.tileSub} numberOfLines={1}>{t.sub}</Text> : null}
          </View>
        ))}
      </View>

      {/* Day strip (multi-day windows) */}
      {multiday && (
        <View style={{ marginTop: spacing.md, gap: 8 }}>
          {stripDates.map((date) => {
            const day = daysByDate[date];
            const b = day ? baro(day.barometer) : null;
            const inner = (
              <View style={st.stripRow}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={st.stripDate}>{fmtDateShort(date)}</Text>
                  {date === today ? <View style={st.todayPill}><Text style={st.todayPillText}>TODAY</Text></View> : null}
                </View>
                {day ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <Text style={st.stripMeta}>{day.ships_count} {day.ships_count === 1 ? 'ship' : 'ships'}{day.total_est_pax ? ` · ~${day.total_est_pax.toLocaleString()}` : ''}</Text>
                    <View style={[st.baroPill, { backgroundColor: b!.tint }]}><Text style={[st.baroPillText, { color: b!.color }]}>{b!.label}</Text></View>
                  </View>
                ) : (
                  <Text style={st.stripNone}>No ships</Text>
                )}
              </View>
            );
            return day ? (
              <TouchableOpacity key={date} activeOpacity={0.85} style={st.stripCard} onPress={() => router.push({ pathname: '/cruise-day', params: { date } })}>{inner}</TouchableOpacity>
            ) : (
              <View key={date} style={[st.stripCard, st.stripCardEmpty]}>{inner}</View>
            );
          })}
        </View>
      )}

      {/* Per-ship listing */}
      <Text style={st.sectionTitle}>In port</Text>
      {orderedDates.map((date) => (
        <View key={date} style={{ marginBottom: spacing.md }}>
          {multiday ? <Text style={st.dateHeader}>{fmtDateShort(date)}</Text> : null}
          {byDate[date].map((v) => {
            const name = v.ship?.name ?? v.ship_name_cache ?? 'Cruise ship';
            const shipImg = shipImageSource(v.ship);
            return (
              <TouchableOpacity key={v.id} style={st.shipRow} activeOpacity={0.85} onPress={() => router.push({ pathname: '/cruise-ship', params: { id: v.id } })}>
                {shipImg ? (
                  <Image source={shipImg} style={st.thumb} />
                ) : (
                  <View style={[st.thumb, st.thumbPlaceholder]}><FontAwesome5 name="ship" size={18} color={colors.textLight} /></View>
                )}
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={st.shipName} numberOfLines={1}>{name}</Text>
                  <Text style={st.shipMeta} numberOfLines={1}>
                    {fmtTime(v.arrival_at)}–{fmtTime(v.departure_at)}{v.est_pax ? ` · ~${v.est_pax.toLocaleString()} pax` : ''}{v.berth_area_group ? ` · ${v.berth_area_group}` : ''}
                  </Text>
                </View>
                <FontAwesome5 name="chevron-right" size={12} color={colors.textLight} />
              </TouchableOpacity>
            );
          })}
        </View>
      ))}

      {/* Map */}
      {origins.length > 0 && (
        <>
          <Text style={st.sectionTitle}>Where they sail from</Text>
          <Text style={st.sectionSub}>The ports these ships sailed from before calling at Lerwick.</Text>
          <CruiseMap markers={markers} lines={lines} height={280} />
        </>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  empty: { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.xl, alignItems: 'center', gap: 10, marginTop: spacing.md },
  emptyText: { color: colors.textSecondary, fontSize: fontSize.md },
  nextBtn: { backgroundColor: colors.navy, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 9, marginTop: 4 },
  nextBtnText: { color: '#fff', fontWeight: '800', fontSize: fontSize.sm },

  tiles: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  tile: { width: '48.5%', backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: 12, marginBottom: 10 },
  tileLabel: { fontSize: 12, color: colors.textMuted },
  tileValue: { fontSize: 22, fontWeight: '900', color: colors.textPrimary, marginTop: 2, letterSpacing: -0.3 },
  tileSub: { fontSize: 11, color: colors.textLight, marginTop: 1 },

  stripCard: { backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 11 },
  stripCardEmpty: { backgroundColor: colors.screenBackground },
  stripRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stripDate: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  stripMeta: { fontSize: 12, color: colors.textMuted },
  stripNone: { fontSize: 12, color: colors.textLight },
  todayPill: { backgroundColor: colors.navy, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 },
  todayPillText: { color: '#fff', fontSize: 9, fontWeight: '900' },
  baroPill: { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 },
  baroPillText: { fontSize: 11, fontWeight: '800' },

  sectionTitle: { fontSize: 18, fontWeight: '900', color: colors.textPrimary, letterSpacing: -0.3, marginTop: spacing.xl, marginBottom: spacing.sm },
  sectionSub: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: -spacing.xs, marginBottom: spacing.md },
  dateHeader: { fontSize: 13, fontWeight: '800', color: colors.textMuted, marginBottom: 8 },

  shipRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 10, marginBottom: 10 },
  thumb: { width: 56, height: 56, borderRadius: 12 },
  thumbPlaceholder: { backgroundColor: colors.screenBackground, alignItems: 'center', justifyContent: 'center' },
  shipName: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  shipMeta: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
});
