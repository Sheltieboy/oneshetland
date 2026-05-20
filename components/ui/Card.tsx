import React, { PropsWithChildren } from 'react';
import { View, StyleSheet, ViewStyle, TouchableOpacity } from 'react-native';
import { colors, radius, spacing, shadow } from '@/constants/theme';

interface CardProps extends PropsWithChildren {
  style?: ViewStyle;
  onPress?: () => void;
  padded?: boolean;
}

export function Card({ children, style, onPress, padded = true }: CardProps) {
  const content = (
    <View style={[styles.card, padded && styles.padded, style]}>{children}</View>
  );

  if (onPress) {
    return (
      <TouchableOpacity onPress={onPress} activeOpacity={0.8}>
        {content}
      </TouchableOpacity>
    );
  }

  return content;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.cardBackground,
    borderRadius: radius.lg,
    ...shadow.card,
  },
  padded: {
    padding: spacing.md,
  },
});
