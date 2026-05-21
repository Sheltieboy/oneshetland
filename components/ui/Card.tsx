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
}

export function Card({
  children,
  style,
  onPress,
  padded = true,
  haptic = true,
  dark = false,
}: CardProps) {
  const scale = useRef(new Animated.Value(1)).current;

  const handlePressIn = () => {
    Animated.spring(scale, {
      toValue: 0.985,
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
      bounciness: 3,
    }).start();
  };

  const handlePress = () => {
    if (haptic) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onPress?.();
  };

  const cardStyle = [
    styles.card,
    dark && styles.dark,
    padded && styles.padded,
    style,
  ];

  if (onPress) {
    return (
      <Animated.View style={{ transform: [{ scale }] }}>
        <Pressable
          onPress={handlePress}
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
        >
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
    ...shadow.card,
  },
  dark: {
    backgroundColor: colors.darkCard,
    ...shadow.strong,
  },
  padded: {
    padding: spacing.md,
  },
});
