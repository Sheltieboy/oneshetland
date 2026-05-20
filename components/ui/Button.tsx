import React from 'react';
import {
  TouchableOpacity,
  Text,
  StyleSheet,
  ActivityIndicator,
  ViewStyle,
  TextStyle,
} from 'react-native';
import { colors, radius, fontSize } from '@/constants/theme';

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  style?: ViewStyle;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  fullWidth = false,
  style,
}: ButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={isDisabled}
      activeOpacity={0.8}
      style={[
        styles.base,
        styles[variant],
        styles[size],
        fullWidth && styles.fullWidth,
        isDisabled && styles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator
          color={variant === 'outline' || variant === 'ghost' ? colors.navy : colors.white}
          size="small"
        />
      ) : (
        <Text style={[styles.text, styles[`${variant}Text`] as TextStyle, styles[`${size}Text`] as TextStyle]}>
          {label}
        </Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  primary: {
    backgroundColor: colors.navy,
  },
  secondary: {
    backgroundColor: colors.accent,
  },
  outline: {
    backgroundColor: 'transparent',
    borderWidth: 2,
    borderColor: colors.navy,
  },
  ghost: {
    backgroundColor: 'transparent',
  },
  sm: { paddingVertical: 8, paddingHorizontal: 16 },
  md: { paddingVertical: 14, paddingHorizontal: 24 },
  lg: { paddingVertical: 18, paddingHorizontal: 32 },
  fullWidth: { width: '100%' },
  disabled: { opacity: 0.45 },
  text: { fontWeight: '600' },
  primaryText: { color: colors.white },
  secondaryText: { color: colors.white },
  outlineText: { color: colors.navy },
  ghostText: { color: colors.navy },
  smText: { fontSize: fontSize.sm },
  mdText: { fontSize: fontSize.md },
  lgText: { fontSize: fontSize.lg },
});
