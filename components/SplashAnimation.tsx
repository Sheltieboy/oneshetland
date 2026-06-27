/**
 * SplashAnimation
 *
 * Cold-launch splash overlay.
 *
 * Primary: plays the brand reveal video (rings weave on, then resolve into the
 * painterly OneShetland mark) on a cream field, holds on the resolved logo, and
 * cross-fades away once auth is ready.
 *
 * Fallback: if the `expo-video` native module isn't in the build (e.g. Expo Go),
 * it shows the animated RingLoader + wordmark instead of crashing.
 *
 * Calls `onDone` when the exit fade finishes so _layout can unmount it.
 */

import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, Animated, Text } from 'react-native';
import { fontSize, spacing } from '@/constants/theme';
import { RingLoader } from './RingLoader';
import { DisplayText } from './DisplayText';

// Deep navy field — matches the waves splash video and the native splash bg.
const CREAM = '#F4EDDF';
const NAVY = '#032F4C';

// Load the reveal video defensively (needs the expo-video native module).
let SplashReveal: React.ComponentType<{ onEnd: () => void }> | null = null;
try {
  SplashReveal = require('./SplashReveal').SplashReveal;
} catch {
  SplashReveal = null;
}

interface Props {
  /** True once auth state is known. Splash starts its exit only after this is true. */
  ready: boolean;
  /** Called when the exit animation finishes — _layout uses this to unmount it. */
  onDone: () => void;
}

export function SplashAnimation({ ready, onDone }: Props) {
  const containerOpacity = useRef(new Animated.Value(1)).current;
  const fallbackOpacity = useRef(new Animated.Value(0)).current;

  // "Content done" gate: video finished, or (fallback) a minimum hold elapsed.
  const [videoEnded, setVideoEnded] = useState(false);
  const [minHoldDone, setMinHoldDone] = useState(false);
  const contentDone = SplashReveal ? videoEnded : minHoldDone;

  // Fallback entrance + minimum hold (only matters when there's no video).
  useEffect(() => {
    if (SplashReveal) return;
    Animated.timing(fallbackOpacity, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    const t = setTimeout(() => setMinHoldDone(true), 1600);
    return () => clearTimeout(t);
  }, [fallbackOpacity]);

  // Exit once the reveal has resolved AND auth is ready.
  useEffect(() => {
    if (!ready || !contentDone) return;
    Animated.timing(containerOpacity, {
      toValue: 0,
      duration: 500,
      useNativeDriver: true,
    }).start(() => onDone());
  }, [ready, contentDone, containerOpacity, onDone]);

  return (
    <Animated.View style={[styles.container, { opacity: containerOpacity }]}>
      {SplashReveal ? (
        <SplashReveal onEnd={() => setVideoEnded(true)} />
      ) : (
        <Animated.View style={[styles.center, { opacity: fallbackOpacity }]}>
          <RingLoader size={132} strokeWidth={3.2} />
          <DisplayText weight="black" style={styles.wordmark}>OneShetland</DisplayText>
          <Text style={styles.tagline}>Everything Shetland, in one place</Text>
        </Animated.View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: NAVY,
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
  },
  wordmark: {
    color: CREAM,
    fontSize: 34,
    letterSpacing: -0.5,
    marginTop: spacing.md,
    // Font comes from DisplayText (Fraunces-Black) — same as the app headers.
  },
  tagline: {
    color: 'rgba(244,237,223,0.7)',
    fontSize: fontSize.md,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
});
