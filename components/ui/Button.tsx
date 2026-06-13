import React, { useRef } from 'react';
import {
  Animated,
  Pressable,
  Text,
  StyleSheet,
  ActivityIndicator,
  ViewStyle,
  TextStyle,
} from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, radius, fontSize, fontWeight, shadow } from '@/constants/theme';

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: Variant;
  size?: Size;
  /** Optional FontAwesome5 icon name shown before the label. */
  icon?: string;
  /** Override the fill (primary/secondary) — e.g. tint to a SECTION colour. */
  color?: string;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  style?: ViewStyle;
  haptic?: boolean;
}

const ICON_SIZE: Record<Size, number> = { sm: 12, md: 14, lg: 15 };

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  color,
  loading = false,
  disabled = false,
  fullWidth = false,
  style,
  haptic = true,
}: ButtonProps) {
  const isDisabled = disabled || loading;
  const scale = useRef(new Animated.Value(1)).current;
  const onDark = variant === 'primary' || variant === 'secondary' || variant === 'danger';
  const fg = onDark ? colors.white : colors.navy;

  const handlePressIn = () => {
    Animated.spring(scale, {
      toValue: 0.97,
      useNativeDriver: true,
      speed: 50,
      bounciness: 0,
    }).start();
  };

  const handlePressOut = () => {
    Animated.spring(scale, {
      toValue: 1,
      useNativeDriver: true,
      speed: 30,
      bounciness: 4,
    }).start();
  };

  const handlePress = () => {
    if (haptic && !isDisabled) {
      const impactStyle =
        variant === 'primary' || variant === 'secondary'
          ? Haptics.ImpactFeedbackStyle.Medium
          : Haptics.ImpactFeedbackStyle.Light;
      Haptics.impactAsync(impactStyle).catch(() => {});
    }
    onPress();
  };

  const hasShadow = (variant === 'primary' || variant === 'secondary') && !isDisabled;

  return (
    <Animated.View style={[fullWidth && styles.fullWidth, { transform: [{ scale }] }, style]}>
      <Pressable
        onPress={handlePress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        disabled={isDisabled}
        style={[
          styles.base,
          styles[variant],
          styles[size],
          color ? { backgroundColor: color } : null,
          fullWidth && styles.fullWidth,
          isDisabled && styles.disabled,
          hasShadow && (variant === 'secondary' ? shadow.accent : shadow.xs),
        ]}
      >
        {loading ? (
          <ActivityIndicator color={fg} size="small" />
        ) : (
          <>
            {icon ? <FontAwesome5 name={icon as any} size={ICON_SIZE[size]} color={fg} solid style={styles.icon} /> : null}
            <Text style={[styles.text, styles[`${variant}Text`] as TextStyle, styles[`${size}Text`] as TextStyle]}>
              {label}
            </Text>
          </>
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  icon: {},
  primary: { backgroundColor: colors.navy },
  secondary: { backgroundColor: colors.accent },
  outline: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: colors.navy,
  },
  ghost: { backgroundColor: 'transparent' },
  danger: { backgroundColor: colors.error },
  sm: { paddingVertical: 9, paddingHorizontal: 16 },
  md: { paddingVertical: 14, paddingHorizontal: 24 },
  lg: { paddingVertical: 17, paddingHorizontal: 32 },
  fullWidth: { width: '100%' },
  disabled: { opacity: 0.4 },
  text: { fontWeight: '600', letterSpacing: 0.1 },
  primaryText: { color: colors.white },
  secondaryText: { color: colors.white },
  outlineText: { color: colors.navy },
  ghostText: { color: colors.navy },
  dangerText: { color: colors.white },
  smText: { fontSize: fontSize.sm },
  mdText: { fontSize: fontSize.md },
  lgText: { fontSize: fontSize.lg, fontWeight: '700' },
});
