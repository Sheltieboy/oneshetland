import React, { PropsWithChildren, useRef } from 'react';
import { Animated, Pressable, View, StyleSheet, ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors, radius, spacing, shadow } from '@/constants/theme';

interface CardProps extends PropsWithChildren {
  style?: ViewStyle;
  onPress?: () => void;
  padded?: boolean;
  haptic?: boolean;
  dark?: boolean;
  /** Lift with a soft shadow — for standalone / featured cards. Lists stay flat. */
  elevated?: boolean;
  /** Tighter radius + padding for dense list rows. */
  compact?: boolean;
  /** A coloured left accent stripe (e.g. section / era colour). */
  accentColor?: string;
  /** No padding (for media-topped cards that pad their own body). */
  flush?: boolean;
}

export function Card({
  children,
  style,
  onPress,
  padded = true,
  haptic = true,
  dark = false,
  elevated = false,
  compact = false,
  accentColor,
  flush = false,
}: CardProps) {
  const scale = useRef(new Animated.Value(1)).current;

  const handlePressIn = () => {
    Animated.spring(scale, { toValue: 0.985, useNativeDriver: true, speed: 50, bounciness: 0 }).start();
  };
  const handlePressOut = () => {
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 30, bounciness: 3 }).start();
  };
  const handlePress = () => {
    if (haptic) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onPress?.();
  };

  const cardStyle = [
    styles.card,
    compact && styles.compact,
    dark ? styles.dark : (elevated ? shadow.card : null),
    !flush && (padded ? (compact ? styles.padCompact : styles.padded) : null),
    accentColor ? { borderLeftWidth: 4, borderLeftColor: accentColor } : null,
    style,
  ];

  if (onPress) {
    return (
      <Animated.View style={{ transform: [{ scale }] }}>
        <Pressable onPress={handlePress} onPressIn={handlePressIn} onPressOut={handlePressOut}>
          <View style={cardStyle}>{children}</View>
        </Pressable>
      </Animated.View>
    );
  }
  return <View style={cardStyle}>{children}</View>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.cardBackground,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  compact: { borderRadius: radius.md },
  dark: {
    backgroundColor: colors.darkCard,
    borderColor: colors.darkBorder,
    ...shadow.strong,
  },
  padded: { padding: spacing.md },
  padCompact: { padding: spacing.sm },
});
