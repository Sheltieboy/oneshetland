/**
 * RingLoader
 *
 * The OneShetland mark as an animated loader: each coloured ring rotates at its
 * own speed and direction, so they drift in and out of overlap rather than
 * spinning in lockstep — an organic, "woven" feel that matches the brand video.
 *
 * Built on RN's Animated (native driver) so it runs on the UI thread without
 * react-native-reanimated. Reusable anywhere a loading state is needed.
 */

import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View, StyleSheet } from 'react-native';
import Svg, { Ellipse, G } from 'react-native-svg';

// Geometry/colours scaled to a 120-unit viewBox (centre 60,60), matched to the
// painterly mark — including the indigo loop.
// Brightened so the rings read on both light (cream) and dark (navy) fields.
const RINGS = [
  { rx: 40, ry: 49, rot: -12, color: '#0B5E86', dur: 9000,  dir: 1 },
  { rx: 36, ry: 43, rot: -42, color: '#3E63B0', dur: 13000, dir: -1 },
  { rx: 46, ry: 40, rot: 18,  color: '#19B3A6', dur: 7000,  dir: 1 },
  { rx: 31, ry: 37, rot: 3,   color: '#E6B24C', dur: 15000, dir: -1 },
  { rx: 52, ry: 35, rot: -24, color: '#F0936B', dur: 11000, dir: 1 },
  { rx: 42, ry: 50, rot: 14,  color: '#A874C0', dur: 17000, dir: -1 },
];

interface Props {
  size?: number;
  strokeWidth?: number;
  strokeOpacity?: number;
}

export function RingLoader({ size = 96, strokeWidth = 3.2, strokeOpacity = 0.9 }: Props) {
  const vals = useRef(RINGS.map(() => new Animated.Value(0))).current;

  useEffect(() => {
    const loops = vals.map((v, i) =>
      Animated.loop(
        Animated.timing(v, {
          toValue: 1,
          duration: RINGS[i].dur,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [vals]);

  return (
    <View style={{ width: size, height: size }}>
      {RINGS.map((r, i) => {
        const rotate = vals[i].interpolate({
          inputRange: [0, 1],
          outputRange: r.dir > 0 ? ['0deg', '360deg'] : ['0deg', '-360deg'],
        });
        return (
          <Animated.View
            key={i}
            style={[StyleSheet.absoluteFill, { transform: [{ rotate }] }]}
          >
            <Svg width={size} height={size} viewBox="0 0 120 120">
              <G rotation={r.rot} origin="60, 60">
                <Ellipse
                  cx={60}
                  cy={60}
                  rx={r.rx}
                  ry={r.ry}
                  stroke={r.color}
                  strokeWidth={strokeWidth}
                  strokeOpacity={strokeOpacity}
                  strokeLinecap="round"
                  fill="none"
                />
              </G>
            </Svg>
          </Animated.View>
        );
      })}
    </View>
  );
}
