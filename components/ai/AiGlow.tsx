/**
 * AiGlow — wraps any box Peerie Bot is working on. RN twin of the web's
 * components/ai/AiGlow.tsx.
 *
 * While `active`, the border walks the OneShetland ring colours and the shadow
 * breathes, so anything Peerie Bot touches carries the same signature on both
 * platforms. Inert when `active` is false, so it's safe to leave mounted.
 *
 * Extracted from PeerieFill, which had this animation baked in and therefore
 * unusable anywhere else. Any new Peerie Bot surface should wrap its working
 * area in this rather than growing its own.
 *
 * Colour interpolation can't use the native driver — it's one border, so the
 * cost is negligible. The shadow pulse runs on its own native-driven value.
 */

import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleProp, ViewStyle } from 'react-native';
import { colors, radius } from '@/constants/theme';
import { RING_COLOURS } from '@/constants/peerie';

export function AiGlow({
  active,
  children,
  style,
  borderRadius = radius.lg,
  idleBorderColor = colors.border,
}: {
  active: boolean;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  borderRadius?: number;
  idleBorderColor?: string;
}) {
  const walk = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!active) { walk.stopAnimation(); walk.setValue(0); return; }
    const loop = Animated.loop(
      Animated.timing(walk, {
        toValue: 1,
        duration: 3200,
        easing: Easing.linear,
        useNativeDriver: false,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [active, walk]);

  // Wrap back to the first colour at 1, so the loop doesn't jump on restart.
  const stops = [...RING_COLOURS, RING_COLOURS[0]];
  const borderColor = active
    ? walk.interpolate({
        inputRange: stops.map((_, i) => i / (stops.length - 1)),
        outputRange: stops,
      })
    : idleBorderColor;

  return (
    <Animated.View
      style={[
        { borderWidth: 1.5, borderColor, borderRadius },
        active && {
          shadowColor: RING_COLOURS[1],
          shadowOpacity: 0.35,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 0 },
          elevation: 6,
        },
        style,
      ]}
      accessibilityState={{ busy: active }}
    >
      {children}
    </Animated.View>
  );
}
