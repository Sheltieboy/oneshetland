/** "When they're in port" timeline for a cruise day (app). */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, radius, fontSize } from '@/constants/theme';
import { londonHours, fmtTime, type CruiseVisit } from '@/lib/cruise-api';

const ACCENT = '#0E6E8C';

export function CruiseDayTimeline({ visits }: { visits: CruiseVisit[] }) {
  const rows = visits
    .map((v) => {
      const a = londonHours(v.arrival_at);
      if (a == null) return null;
      let d = londonHours(v.departure_at);
      if (d == null || d <= a) d = Math.min(24, a + 6);
      return { v, a, d };
    })
    .filter(Boolean) as { v: CruiseVisit; a: number; d: number }[];
  if (rows.length === 0) return null;

  const start = Math.max(0, Math.floor(Math.min(...rows.map((r) => r.a))) - 1);
  const end = Math.min(24, Math.ceil(Math.max(...rows.map((r) => r.d))) + 1);
  const span = Math.max(1, end - start);
  const ticks: number[] = [];
  for (let h = start; h <= end; h += Math.max(1, Math.round(span / 5))) ticks.push(h);

  return (
    <View style={st.card}>
      <Text style={st.title}>When they're in port</Text>
      {rows.map(({ v, a, d }) => (
        <View key={v.id} style={st.row}>
          <Text style={st.name} numberOfLines={1}>{v.ship?.name ?? 'Ship'}</Text>
          <View style={st.track}>
            <View style={[st.bar, { left: `${((a - start) / span) * 100}%`, width: `${Math.max(14, ((d - a) / span) * 100)}%` }]}>
              <Text style={st.barText} numberOfLines={1}>{fmtTime(v.arrival_at)}–{fmtTime(v.departure_at)}</Text>
            </View>
          </View>
        </View>
      ))}
      <View style={st.axis}>
        {ticks.map((h) => (
          <Text key={h} style={st.tick}>{String(h).padStart(2, '0')}:00</Text>
        ))}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  card: { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 14 },
  title: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textSecondary, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  name: { width: 82, fontSize: 12, fontWeight: '700', color: colors.textPrimary, paddingRight: 8 },
  track: { flex: 1, height: 26, backgroundColor: '#eef1f3', borderRadius: 6, position: 'relative', overflow: 'hidden' },
  bar: { position: 'absolute', top: 0, bottom: 0, backgroundColor: ACCENT, borderRadius: 6, justifyContent: 'center', paddingHorizontal: 6 },
  barText: { color: '#fff', fontSize: 9, fontWeight: '800' },
  axis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4, marginLeft: 82 },
  tick: { fontSize: 9, color: colors.textLight },
});
