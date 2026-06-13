import React from 'react';
import { Pressable, StyleSheet, ViewStyle } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, radius } from '@/constants/theme';

interface IconButtonProps {
  icon: string;
  onPress: () => void;
  /** Icon colour (default navy). */
  color?: string;
  /** Background fill (default a faint tint of `color`). */
  background?: string;
  size?: number;       // icon size; the touch target stays ≥ 40
  solid?: boolean;
  accessibilityLabel?: string;
  style?: ViewStyle;
  haptic?: boolean;
}

/**
 * A round 40×40 icon button — the canonical close-X / +/− / edit / delete
 * control. Always meets the 44pt-ish tap target. (Design A3.)
 */
export function IconButton({
  icon, onPress, color = colors.navy, background, size = 16, solid = true,
  accessibilityLabel, style, haptic = true,
}: IconButtonProps) {
  const bg = background ?? color + '14';
  return (
    <Pressable
      onPress={() => { if (haptic) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}); onPress(); }}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.btn, { backgroundColor: bg }, pressed && styles.pressed, style]}
    >
      <FontAwesome5 name={icon as any} size={size} color={color} solid={solid} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: { width: 40, height: 40, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
});
