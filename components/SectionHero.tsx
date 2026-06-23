/**
 * components/SectionHero.tsx
 *
 * The new top-of-section landing block — a full-width photographic
 * banner with the section title overlaid in display type. Replaces the
 * old "eyebrow + 34 pt sans + icon badge" pattern that read like every
 * other React Native dashboard.
 *
 * Three states:
 *
 *   1. photo provided    → the photo is the hero; a dark SVG gradient
 *                          along the bottom holds the title legible
 *                          against any image.
 *
 *   2. no photo          → falls back to a tinted gradient using the
 *                          section's brand colour with a large faint
 *                          FontAwesome icon as backdrop. Looks
 *                          intentional, not unfinished.
 *
 *   3. ImageBackground for local require()-imported assets, plus URI
 *      support for remote URLs.
 *
 * Title rendered with <DisplayText> — picks up Fraunces if installed,
 * else system black weight.
 *
 * Usage:
 *   <SectionHero
 *     section="memories"
 *     title="Memories"
 *     eyebrow="The living map"
 *     photo={require('@/assets/section-heroes/memories.jpg')}
 *   />
 */

import React from 'react';
import {
  View, StyleSheet, ImageBackground, ImageSourcePropType, ViewStyle, Text,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Stop, Rect } from 'react-native-svg';
import { FontAwesome5 } from '@expo/vector-icons';
import { SECTIONS, SectionKey } from '@/constants/sections';
import { colors } from '@/constants/theme';
import { DisplayText } from './DisplayText';

interface SectionHeroProps {
  section:    SectionKey;
  title:      string;
  eyebrow?:   string;
  /** Local require() result or a remote URI object. Optional — falls back to gradient. */
  photo?:     ImageSourcePropType;
  /** Strip height. Defaults to 200 — tall enough to feel cinematic, not so tall it eats the screen. */
  height?:    number;
  /** Optional right-corner chip (e.g. a "saved 4" badge). */
  topRight?:  React.ReactNode;
  /** When this hero is the screen's top header, absorb the status-bar inset so
   *  the image runs to the very top (the screen's SafeAreaView must drop its top edge). */
  topInset?:  boolean;
  style?:     ViewStyle;
}

export function SectionHero({
  section, title, eyebrow, photo, height = 200, topRight, topInset = false, style,
}: SectionHeroProps) {
  const meta = SECTIONS[section];
  const insets = useSafeAreaInsets();
  const pad = topInset ? insets.top : 0;
  const h = height + pad;

  // Shared overlay — the gradient + title block that sits on top of
  // either the photo or the gradient-fallback view.
  const overlay = (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {/* Bottom-to-top dark gradient for text legibility */}
      <Svg style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id="hero-gradient" x1="0" y1="1" x2="0" y2="0">
            <Stop offset="0"   stopColor="#000" stopOpacity="0.78" />
            <Stop offset="0.5" stopColor="#000" stopOpacity="0.35" />
            <Stop offset="1"   stopColor="#000" stopOpacity="0"    />
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width="100%" height="100%" fill="url(#hero-gradient)" />
      </Svg>

      {topRight ? (
        <View style={[styles.topRight, { top: pad + 16 }]}>{topRight}</View>
      ) : null}

      <View style={styles.titleBlock}>
        {eyebrow ? (
          <Text style={styles.eyebrow}>{eyebrow.toUpperCase()}</Text>
        ) : null}
        <DisplayText weight="black" style={styles.title}>{title}</DisplayText>
      </View>
    </View>
  );

  if (photo) {
    return (
      <View style={[{ height: h }, style]}>
        <ImageBackground source={photo} resizeMode="cover" style={styles.fill}>
          {overlay}
        </ImageBackground>
      </View>
    );
  }

  // ── Fallback: tinted gradient + faint icon ─────────────────────────────
  return (
    <View style={[{ height: h, backgroundColor: meta.color }, styles.fallback, style]}>
      {/* A second gradient layer using the section colour and a darker mix */}
      <Svg style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id="fallback-tint" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={meta.color}  stopOpacity="1"   />
            <Stop offset="1" stopColor="#000"        stopOpacity="0.5" />
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width="100%" height="100%" fill="url(#fallback-tint)" />
      </Svg>

      {/* Large faint section icon as a backdrop motif */}
      <View style={styles.fallbackIconWrap} pointerEvents="none">
        <FontAwesome5
          name={meta.icon}
          size={height * 0.85}
          color="#fff"
          style={{ opacity: 0.13 }}
          solid
        />
      </View>

      {overlay}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    width: '100%',
    height: '100%',
  },
  fallback: {
    overflow: 'hidden',
    position: 'relative',
  },
  fallbackIconWrap: {
    position: 'absolute',
    right: -30,
    bottom: -30,
  },
  topRight: {
    position: 'absolute',
    top: 16,
    right: 16,
  },
  titleBlock: {
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: 18,
  },
  eyebrow: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 2,
    marginBottom: 2,
  },
  title: {
    color: '#fff',
    fontSize: 42,
    letterSpacing: -0.5,
    // Shadow so the title reads even against very busy parts of a photo
    textShadowColor: 'rgba(0, 0, 0, 0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
});

export default SectionHero;
