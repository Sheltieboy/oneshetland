/**
 * TodayAtAGlance
 *
 * A calm frosted card for the tablet hero's right-hand space: current Lerwick
 * weather, sunrise/sunset and daylight length. Renders nothing until data
 * loads (so it never flashes a half-empty card over the photo).
 *
 *   <TodayAtAGlance />
 */

import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { fontSize, spacing, radius } from '@/constants/theme';
import { fetchTodaySnapshot, describeWeather, type TodaySnapshot } from '@/lib/shetland-today';

export function TodayAtAGlance() {
  const [snap, setSnap] = useState<TodaySnapshot | null>(null);

  useEffect(() => {
    let alive = true;
    fetchTodaySnapshot().then(s => { if (alive) setSnap(s); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!snap) return null;
  const w = describeWeather(snap.weatherCode);

  return (
    <View style={styles.card}>
      <Text style={styles.kicker}>TODAY IN SHETLAND</Text>

      <View style={styles.weatherRow}>
        <FontAwesome5 name={w.icon as any} size={26} color="#fff" solid />
        <Text style={styles.temp}>{snap.tempC != null ? `${snap.tempC}°` : '—'}</Text>
        <View>
          <Text style={styles.place}>Lerwick</Text>
          <Text style={styles.cond}>{w.label}</Text>
        </View>
      </View>

      <View style={styles.divider} />

      <View style={styles.sunRow}>
        <Row icon="sun"  label="Sunrise" value={snap.sunrise} />
        <Row icon="moon" label="Sunset"  value={snap.sunset} />
      </View>
      <View style={styles.daylightRow}>
        <FontAwesome5 name="clock" size={11} color="rgba(255,255,255,0.7)" solid />
        <Text style={styles.daylight}>{snap.daylight} of daylight</Text>
      </View>
    </View>
  );
}

function Row({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <View style={styles.sunCol}>
      <View style={styles.sunLabelRow}>
        <FontAwesome5 name={icon as any} size={11} color="rgba(255,255,255,0.7)" solid />
        <Text style={styles.sunLabel}>{label}</Text>
      </View>
      <Text style={styles.sunValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 230,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    overflow: 'hidden',
    backgroundColor: 'rgba(8,20,32,0.42)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    gap: 10,
  },
  kicker: {
    color: 'rgba(255,255,255,0.6)', fontSize: 10, fontWeight: '800', letterSpacing: 1,
  },
  weatherRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  temp: { color: '#fff', fontSize: 30, fontWeight: '800' },
  place: { color: '#fff', fontSize: fontSize.sm, fontWeight: '700' },
  cond:  { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.xs },

  divider: { height: 1, backgroundColor: 'rgba(255,255,255,0.15)' },

  sunRow: { flexDirection: 'row', justifyContent: 'space-between' },
  sunCol: { gap: 3 },
  sunLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  sunLabel: { color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: '600' },
  sunValue: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },

  daylightRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  daylight: { color: 'rgba(255,255,255,0.85)', fontSize: fontSize.xs, fontWeight: '600' },
});
