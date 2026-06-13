/**
 * SplashAnimation
 *
 * Animated splash overlay used on cold launch.
 *
 * Sequence:
 *   1. Logo zooms in (0.25 → 1.0) with spring overshoot
 *   2. Wordmark fades + slides up
 *   3. Tagline fades in (held visible for ~600ms)
 *   4. Section-colour strip scales out from centre
 *   5. Once `ready` (auth loaded) and minimum hold elapsed, runs the exit:
 *      logo scales up to 1.3 while the whole overlay fades to 0 — cross-fading
 *      into the screen rendered underneath.
 *   6. Calls `onDone` when the exit animation finishes so _layout can unmount it.
 */

import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, Image, Animated } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { fontSize, spacing } from '@/constants/theme';

const LOGO  = require('../assets/icon.png');
const WAVES = require('../assets/waves-crashing.mp4');

// Match the native splash background in app.json — no colour flash on transition
const DEEP_NAVY = '#032F4C';

interface Props {
  /** True once auth state is known. Splash will start its exit only after this is true. */
  ready: boolean;
  /** Called when the exit animation finishes — _layout uses this to unmount the splash. */
  onDone: () => void;
}

export function SplashAnimation({ ready, onDone }: Props) {
  const containerOpacity = useRef(new Animated.Value(1)).current;
  const logoOpacity      = useRef(new Animated.Value(0)).current;
  const logoScale        = useRef(new Animated.Value(0.25)).current;
  const wordOpacity      = useRef(new Animated.Value(0)).current;
  const wordTranslate    = useRef(new Animated.Value(14)).current;
  const tagOpacity       = useRef(new Animated.Value(0)).current;
  const stripScale       = useRef(new Animated.Value(0)).current;

  const [entranceDone, setEntranceDone] = useState(false);

  // Looping, muted waves video behind the wordmark. contentFit="cover" crops it
  // to fill any aspect ratio (portrait phone or tablet).
  const player = useVideoPlayer(WAVES, p => {
    p.loop = true;
    p.muted = true;
    p.play();
  });

  // Entrance + hold
  useEffect(() => {
    Animated.sequence([
      // Logo zooms in
      Animated.parallel([
        Animated.timing(logoOpacity, { toValue: 1, duration: 350, useNativeDriver: true }),
        Animated.spring(logoScale, { toValue: 1, friction: 4, tension: 55, useNativeDriver: true }),
      ]),
      // Wordmark in
      Animated.parallel([
        Animated.timing(wordOpacity, { toValue: 1, duration: 280, useNativeDriver: true }),
        Animated.spring(wordTranslate, { toValue: 0, friction: 7, tension: 60, useNativeDriver: true }),
      ]),
      // Tagline in
      Animated.timing(tagOpacity, { toValue: 1, duration: 280, useNativeDriver: true }),
      // Colour strip
      Animated.spring(stripScale, { toValue: 1, friction: 8, tension: 50, useNativeDriver: true }),
      // Hold so the tagline has time to land
      Animated.delay(550),
    ]).start(() => setEntranceDone(true));
  }, []);

  // Exit — only runs once entrance is done AND auth is loaded
  useEffect(() => {
    if (!entranceDone || !ready) return;
    Animated.parallel([
      // Logo zooms further out as we leave — "diving in" effect
      Animated.timing(logoScale, {
        toValue: 1.3, duration: 550, useNativeDriver: true,
      }),
      // Whole overlay cross-fades to reveal the screen behind
      Animated.timing(containerOpacity, {
        toValue: 0, duration: 550, useNativeDriver: true,
      }),
    ]).start(() => onDone());
  }, [entranceDone, ready]);

  return (
    <Animated.View style={[styles.container, { opacity: containerOpacity }]}>

      {/* Full-bleed waves video, cropped to fill */}
      <VideoView
        style={StyleSheet.absoluteFill}
        player={player}
        contentFit="cover"
        nativeControls={false}
        pointerEvents="none"
      />
      {/* Navy scrim keeps the white logo + wordmark legible over the waves */}
      <View style={styles.scrim} pointerEvents="none" />

      <View style={styles.center}>
        <Animated.View
          style={[styles.logoWrap, {
            opacity: logoOpacity,
            transform: [{ scale: logoScale }],
          }]}
        >
          <Image source={LOGO} style={styles.logo} resizeMode="contain" />
        </Animated.View>

        <Animated.Text
          style={[styles.wordmark, {
            opacity: wordOpacity,
            transform: [{ translateY: wordTranslate }],
          }]}
        >
          OneShetland
        </Animated.Text>

        <Animated.Text style={[styles.tagline, { opacity: tagOpacity }]}>
          Everything Shetland, in one place
        </Animated.Text>
      </View>

      <Animated.View
        style={[styles.colorStrip, { transform: [{ scaleX: stripScale }] }]}
      >
        <View style={[styles.colorChip, { backgroundColor: '#12B3D6' }]} />
        <View style={[styles.colorChip, { backgroundColor: '#E8A020' }]} />
        <View style={[styles.colorChip, { backgroundColor: '#7C3AED' }]} />
        <View style={[styles.colorChip, { backgroundColor: '#E0722A' }]} />
      </Animated.View>

    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: DEEP_NAVY,
    justifyContent: 'space-between',
  },
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(3,47,76,0.55)',
  },

  center: {
    flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14,
  },

  logoWrap: {
    width: 130, height: 130, borderRadius: 32,
    backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
    padding: 18,
    shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 40, shadowOffset: { width: 0, height: 14 },
    marginBottom: spacing.lg,
  },
  logo: { width: 94, height: 94 },

  wordmark: {
    color: '#fff', fontSize: 32, fontWeight: '900',
    letterSpacing: -0.7, marginTop: 4,
  },
  tagline: {
    color: 'rgba(255,255,255,0.75)', fontSize: fontSize.md,
    fontWeight: '600', marginTop: 6, letterSpacing: 0.2,
  },

  colorStrip: {
    flexDirection: 'row',
    height: 4,
    marginBottom: 60,
    marginHorizontal: spacing.xxl,
  },
  colorChip: { flex: 1 },
});
