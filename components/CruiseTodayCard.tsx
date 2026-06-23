/**
 * CruiseTodayCard — "In port today" (or next call) banner.
 * Renders nothing when there are no upcoming cruise calls. Used on the Home
 * screen and the Cruise screen.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, radius, fontSize } from '@/constants/theme';
import { getCruiseHomeCard, baro, fmtDateShort, type CruiseHomeCard } from '@/lib/cruise-api';

const ACCENT = '#0E6E8C';

export function CruiseTodayCard({ style }: { style?: StyleProp<ViewStyle> }) {
  const router = useRouter();
  const [card, setCard] = useState<CruiseHomeCard | null>(null);

  useEffect(() => {
    let alive = true;
    getCruiseHomeCard().then((c) => { if (alive) setCard(c); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!card) return null;
  const b = baro(card.barometer);
  const names = card.thumbs.map((t) => t.name).slice(0, 2).join(', ') + (card.thumbs.length > 2 ? ` +${card.thumbs.length - 2}` : '');

  return (
    <TouchableOpacity style={[styles.card, style]} activeOpacity={0.85} onPress={() => router.push({ pathname: '/cruise-day', params: { date: card.date } })}>
      <View style={styles.thumbs}>
        {card.thumbs.slice(0, 3).map((t, i) =>
          t.image ? (
            <Image key={t.id} source={{ uri: t.image }} style={[styles.thumb, { marginLeft: i ? -14 : 0, zIndex: 3 - i }]} />
          ) : (
            <View key={t.id} style={[styles.thumb, styles.thumbPh, { marginLeft: i ? -14 : 0, zIndex: 3 - i }]}>
              <FontAwesome5 name="ship" size={14} color={colors.textLight} />
            </View>
          ),
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.label}>
          {card.isToday ? 'IN PORT TODAY' : 'NEXT CRUISE CALL'}
          {card.isToday ? '' : <Text style={styles.labelDate}>  {fmtDateShort(card.date)}</Text>}
        </Text>
        <Text style={styles.names} numberOfLines={1}>{names}</Text>
        <Text style={styles.meta} numberOfLines={1}>
          {card.ships_count} {card.ships_count === 1 ? 'ship' : 'ships'}{card.total_est_pax ? `  ·  ~${card.total_est_pax.toLocaleString()} passengers` : ''}
        </Text>
      </View>
      <View style={[styles.pill, { backgroundColor: b.tint }]}><Text style={[styles.pillText, { color: b.color }]}>{b.label}</Text></View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, borderLeftWidth: 5, borderLeftColor: ACCENT, padding: 12 },
  thumbs: { flexDirection: 'row', alignItems: 'center' },
  thumb: { width: 44, height: 44, borderRadius: 12, borderWidth: 2, borderColor: '#fff' },
  thumbPh: { backgroundColor: colors.screenBackground, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 10, fontWeight: '900', letterSpacing: 0.6, color: ACCENT },
  labelDate: { color: colors.textMuted, fontWeight: '700' },
  names: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, marginTop: 2 },
  meta: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
  pill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  pillText: { fontSize: 11, fontWeight: '800' },
});
