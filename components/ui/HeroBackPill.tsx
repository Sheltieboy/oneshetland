import React from 'react';
import { Pressable, Text, StyleSheet, ViewStyle, StyleProp } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, radius, fontSize } from '@/constants/theme';

type Surface = 'tint' | 'frost' | 'overlay';

interface HeroBackPillProps {
  /** The destination name — usually the section ("Da Boats", "What's On", "Hubs"). */
  label: string;
  onPress: () => void;
  /**
   * Which hero the pill floats on, so its backdrop stays legible:
   *   'tint'    — a light surface / top-bar  → faint accent fill, accent text.
   *   'frost'   — a dark solid hero (navy)   → frosted-light fill, accent text.
   *   'overlay' — a user photo               → dark scrim fill, white text.
   */
  variant?: Surface;
  /** Foreground (chevron/icon/label) colour. Defaults: section navy for tint/frost, white for overlay. */
  accent?: string;
  /** Optional FontAwesome5 icon shown between the chevron and the label (e.g. 'ship'). */
  icon?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * The canonical "back to <section>" control for image / colour hero detail
 * screens (boat, hub, event, spik…). One shape and one behaviour everywhere;
 * the backdrop adapts to the hero while each section keeps its own colour.
 * (Design — Wave 4.)
 */
export function HeroBackPill({ label, onPress, variant = 'tint', accent, icon, style }: HeroBackPillProps) {
  const fg = variant === 'overlay' ? colors.white : (accent ?? colors.navy);
  const bg =
    variant === 'overlay' ? 'rgba(0,0,0,0.42)' :
    variant === 'frost'   ? 'rgba(255,255,255,0.14)' :
    (accent ?? colors.navy) + '14';

  return (
    <Pressable
      onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}); onPress(); }}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={`Back to ${label}`}
      style={({ pressed }) => [styles.pill, { backgroundColor: bg }, pressed && styles.pressed, style]}
    >
      <FontAwesome5 name="chevron-left" size={14} color={fg} />
      {icon ? <FontAwesome5 name={icon as any} size={12} color={fg} solid /> : null}
      <Text style={[styles.label, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingVertical: 8,
    paddingHorizontal: 13,
    borderRadius: radius.full,
    alignSelf: 'flex-start',
    minHeight: 38,
  },
  pressed: { opacity: 0.7 },
  label: { fontSize: fontSize.sm, fontWeight: '800' },
});

export default HeroBackPill;
