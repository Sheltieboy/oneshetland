/**
 * FundraisingProgress
 *
 * The "how much have we raised" graphic for a hub campaign: a big raised total,
 * a bold rounded progress bar (capped at 100%, with an over-target glow), and a
 * footer of supporters + time left.
 *
 *   <FundraisingProgress raisedPence={64000} goalPence={100000}
 *     donorCount={23} endsAt={iso} accent="#6B47BF" />
 */

import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { formatPence } from '@/lib/local-api';

interface Props {
  raisedPence: number;
  goalPence:   number;
  donorCount?: number;
  endsAt?:     string | null;
  accent?:     string;
  compact?:    boolean;   // tighter version for the hub page card
}

function daysLeft(iso?: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / 86_400_000);
}

export function FundraisingProgress({
  raisedPence, goalPence, donorCount, endsAt, accent = colors.navy, compact = false,
}: Props) {
  const pct = goalPence > 0 ? Math.min(1, raisedPence / goalPence) : 0;
  const pctLabel = Math.round((goalPence > 0 ? raisedPence / goalPence : 0) * 100);
  const over = raisedPence >= goalPence && goalPence > 0;
  const dleft = daysLeft(endsAt);

  const fill = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fill, { toValue: pct, duration: 700, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [pct]);
  const widthInterp = fill.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  return (
    <View>
      <View style={styles.topRow}>
        <View>
          <Text style={[styles.raised, compact && { fontSize: 26 }, { color: accent }]}>{formatPence(raisedPence)}</Text>
          <Text style={styles.goal}>raised of {formatPence(goalPence)}</Text>
        </View>
        <View style={[styles.pctChip, { backgroundColor: over ? colors.success : accent }]}>
          <Text style={styles.pctText}>{pctLabel}%</Text>
        </View>
      </View>

      <View style={[styles.track, compact && { height: 12 }]}>
        <Animated.View style={[styles.fill, compact && { height: 12 }, { width: widthInterp, backgroundColor: over ? colors.success : accent }]} />
      </View>

      <View style={styles.footRow}>
        <View style={styles.footItem}>
          <FontAwesome5 name="hand-holding-heart" size={11} color={colors.textMuted} solid />
          <Text style={styles.footText}>{donorCount ?? 0} supporter{donorCount === 1 ? '' : 's'}</Text>
        </View>
        {dleft != null ? (
          <View style={styles.footItem}>
            <FontAwesome5 name="clock" size={11} color={colors.textMuted} solid />
            <Text style={styles.footText}>{dleft === 0 ? 'Ending today' : `${dleft} day${dleft === 1 ? '' : 's'} left`}</Text>
          </View>
        ) : over ? (
          <View style={styles.footItem}>
            <FontAwesome5 name="check-circle" size={11} color={colors.success} solid />
            <Text style={[styles.footText, { color: colors.success }]}>Target reached!</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  topRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  raised: { fontSize: 32, fontWeight: '900', letterSpacing: -0.5 },
  goal: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 1 },
  pctChip: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999 },
  pctText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '900' },

  track: { height: 16, borderRadius: 999, backgroundColor: '#E9ECF2', overflow: 'hidden', marginTop: spacing.sm },
  fill: { height: 16, borderRadius: 999 },

  footRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginTop: spacing.sm },
  footItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  footText: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600' },
});
