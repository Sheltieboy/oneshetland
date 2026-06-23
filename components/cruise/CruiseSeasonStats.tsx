/** Season stat tiles + "passengers by month" chart (app). */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, radius, fontSize, spacing } from '@/constants/theme';
import { getSeasonStats, monthShort, fmtDateShort, type SeasonStats } from '@/lib/cruise-api';

const ACCENT = '#0E6E8C';

export function CruiseSeasonStats({ show = 'both' }: { show?: 'tiles' | 'chart' | 'both' }) {
  const [s, setS] = useState<SeasonStats | null>(null);
  useEffect(() => { let a = true; getSeasonStats().then((x) => { if (a) setS(x); }).catch(() => {}); return () => { a = false; }; }, []);
  if (!s) return null;

  const tiles: { l: string; v: string; sub?: string }[] = [
    { l: 'Ship calls', v: s.totalCalls.toLocaleString() },
    { l: 'Passengers', v: s.totalPax.toLocaleString(), sub: 'this season' },
    { l: 'Different ships', v: String(s.distinctShips) },
    { l: 'Peak days', v: String(s.peakDays) },
    ...(s.biggestShip ? [{ l: 'Biggest ship', v: `${s.biggestShip.length_m} m`, sub: s.biggestShip.name }] : []),
    ...(s.busiestDay ? [{ l: 'Busiest day', v: `~${s.busiestDay.pax.toLocaleString()}`, sub: fmtDateShort(s.busiestDay.date) }] : []),
  ];
  const maxPax = Math.max(1, ...s.byMonth.map((m) => m.pax));

  return (
    <View>
      {show !== 'chart' && (
        <View style={st.tiles}>
          {tiles.map((t) => (
            <View key={t.l} style={st.tile}>
              <Text style={st.tileLabel}>{t.l}</Text>
              <Text style={st.tileValue}>{t.v}</Text>
              {t.sub ? <Text style={st.tileSub} numberOfLines={1}>{t.sub}</Text> : null}
            </View>
          ))}
        </View>
      )}

      {show !== 'tiles' && (
        <View style={st.chartCard}>
          <Text style={st.chartTitle}>Passengers by month</Text>
          <View style={st.chartRow}>
            {s.byMonth.map((m) => {
              const h = Math.max(4, Math.round((m.pax / maxPax) * 110));
              return (
                <View key={m.month} style={st.barCol}>
                  <Text style={st.barVal}>{m.pax >= 1000 ? `${Math.round(m.pax / 1000)}k` : m.pax}</Text>
                  <View style={[st.bar, { height: h }]} />
                  <Text style={st.barLabel}>{monthShort(m.month)}</Text>
                </View>
              );
            })}
          </View>
        </View>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  tiles: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  tile: { width: '48.5%', backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: 12, marginBottom: 10 },
  tileLabel: { fontSize: 12, color: colors.textMuted },
  tileValue: { fontSize: 22, fontWeight: '900', color: colors.textPrimary, marginTop: 2, letterSpacing: -0.3 },
  tileSub: { fontSize: 11, color: colors.textLight, marginTop: 1 },
  chartCard: { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 14, marginTop: 2 },
  chartTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textSecondary, marginBottom: 12 },
  chartRow: { flexDirection: 'row', alignItems: 'flex-end', height: 150 },
  barCol: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  barVal: { fontSize: 9, fontWeight: '800', color: colors.textSecondary, marginBottom: 4 },
  bar: { width: '64%', backgroundColor: ACCENT, opacity: 0.85, borderTopLeftRadius: 4, borderTopRightRadius: 4 },
  barLabel: { fontSize: 10, color: colors.textMuted, marginTop: 4 },
});
