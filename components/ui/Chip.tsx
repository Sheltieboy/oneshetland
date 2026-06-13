import React from 'react';
import { Pressable, View, Text, StyleSheet } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, radius } from '@/constants/theme';

interface ChipProps {
  label: string;
  icon?: string;
  /** Section / status colour. */
  color?: string;
  /** Filled (selected) look. */
  selected?: boolean;
  onPress?: () => void;
  /** 'filter' = white/outline that fills when selected; 'status' = always a soft tinted pill. */
  variant?: 'filter' | 'status';
}

/**
 * Canonical chip — used for filters, categories and status pills. (Design A3.)
 * Filter chips are tappable and fill with `color` when selected; status chips
 * are static soft-tinted pills.
 */
export function Chip({ label, icon, color = colors.navy, selected = false, onPress, variant = 'filter' }: ChipProps) {
  const status = variant === 'status';
  const fill   = status ? color + '1A' : (selected ? color : colors.white);
  const border = status ? 'transparent' : (selected ? color : colors.border);
  const fg     = status ? color : (selected ? colors.white : colors.textSecondary);

  const inner = (
    <View style={[styles.chip, { backgroundColor: fill, borderColor: border }]}>
      {icon ? <FontAwesome5 name={icon as any} size={10} color={fg} solid /> : null}
      <Text style={[styles.text, { color: fg }]} numberOfLines={1}>{label}</Text>
    </View>
  );

  if (!onPress) return inner;
  return <Pressable onPress={onPress} hitSlop={6}>{inner}</Pressable>;
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: radius.full, borderWidth: 1,
    maxWidth: 200,
  },
  text: { fontSize: fontSize.xs, fontWeight: '800' },
});
