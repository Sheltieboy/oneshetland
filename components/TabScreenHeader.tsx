/**
 * TabScreenHeader
 *
 * The cinematic section banner shared by every main tab landing — a tinted
 * (or photographic) hero with the section name set in display type, matching
 * the SectionHero used on Memories & Da Boats so every section root reads as
 * one family. The `right` slot holds a live badge / count (framed in a glass
 * chip so it stays legible over the tint); `children` render in a strip below
 * the banner — a search box or a mode toggle.
 *
 * Usage:
 *   <TabScreenHeader section={SECTIONS.shifts} right={<BadgeRow />}>
 *     <SearchBox />
 *   </TabScreenHeader>
 */

import React from 'react';
import { View, Text, StyleSheet, ImageBackground, ImageSourcePropType } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Stop, Rect } from 'react-native-svg';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import type { SectionBrand } from '@/constants/sections';
import { DisplayText } from './DisplayText';

interface Props {
  section:   SectionBrand;
  /** Banner title (defaults to the section label) — e.g. "Work" over the jobs tint. */
  title?:    string;
  /** Rendered top-right — e.g. a live badge, action buttons, word count. */
  right?:    React.ReactNode;
  /** Rendered in a strip below the banner — e.g. a search bar or mode toggle. */
  children?: React.ReactNode;
  /** Optional hero photo; falls back to a tinted gradient using the section colour. */
  photo?:    ImageSourcePropType;
  /** Optional custom banner background (e.g. an SVG). Takes precedence over `photo`. */
  banner?:   React.ReactNode;
  /** Optional eyebrow line (defaults to "OneShetland"). */
  eyebrow?:  string;
  /** Banner height. Default 138 — cinematic but compact for a fixed header. */
  height?:   number;
}

export function TabScreenHeader({
  section, title, right, children, photo, banner, eyebrow = 'OneShetland', height = 138,
}: Props) {
  // Absorb the status-bar inset so the hero image/tint runs to the very top of
  // the screen — the screen's SafeAreaView must NOT pad the top edge.
  const insets = useSafeAreaInsets();
  const h = height + insets.top;

  // The legibility gradient + content overlay, shared by photo & fallback.
  const overlay = (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <Svg style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id="tab-hero-grad" x1="0" y1="1" x2="0" y2="0">
            <Stop offset="0"    stopColor="#000" stopOpacity="0.78" />
            <Stop offset="0.55" stopColor="#000" stopOpacity="0.28" />
            <Stop offset="1"    stopColor="#000" stopOpacity="0" />
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width="100%" height="100%" fill="url(#tab-hero-grad)" />
      </Svg>

      {right != null ? <View style={[styles.rightSlot, { top: insets.top + 12 }]}>{right}</View> : null}

      <View style={styles.titleBlock}>
        <Text style={styles.eyebrow}>{eyebrow.toUpperCase()}</Text>
        <DisplayText weight="black" style={styles.title}>{title ?? section.label}</DisplayText>
        <Text style={styles.subtitle} numberOfLines={1}>{section.description}</Text>
      </View>
    </View>
  );

  const bannerEl = banner ? (
    <View style={{ height: h }}>
      <View style={StyleSheet.absoluteFill}>{banner}</View>
      {overlay}
    </View>
  ) : photo ? (
    <View style={{ height: h }}>
      <ImageBackground source={photo} resizeMode="cover" style={styles.fill}>{overlay}</ImageBackground>
    </View>
  ) : (
    <View style={[{ height: h, backgroundColor: section.color }, styles.fallback]}>
      <Svg style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id="tab-hero-tint" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={section.color} stopOpacity="1" />
            <Stop offset="1" stopColor="#06121C"        stopOpacity="0.55" />
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width="100%" height="100%" fill="url(#tab-hero-tint)" />
      </Svg>
      <View style={styles.iconMotif} pointerEvents="none">
        <FontAwesome5 name={section.icon as any} size={height * 0.82} color="#fff" style={{ opacity: 0.12 }} solid />
      </View>
      {overlay}
    </View>
  );

  return (
    <View>
      {bannerEl}
      {children != null ? <View style={styles.below}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { width: '100%', height: '100%' },
  fallback: { overflow: 'hidden', position: 'relative' },
  iconMotif: { position: 'absolute', right: -24, bottom: -28 },

  rightSlot: {
    position: 'absolute', top: 12, right: spacing.md,
    backgroundColor: 'rgba(0,0,0,0.22)', borderRadius: radius.full,
    paddingHorizontal: 6, paddingVertical: 4,
  },

  titleBlock: { position: 'absolute', left: spacing.md, right: spacing.md, bottom: 14 },
  eyebrow: {
    color: 'rgba(255,255,255,0.85)', fontSize: 11, fontWeight: '800',
    letterSpacing: 1.5, marginBottom: 3,
  },
  title: {
    color: '#fff', fontSize: 32, letterSpacing: -0.4,
    textShadowColor: 'rgba(0,0,0,0.45)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 5,
  },
  subtitle: { color: 'rgba(255,255,255,0.85)', fontSize: fontSize.sm, marginTop: 3 },

  below: { backgroundColor: colors.navy, paddingHorizontal: spacing.md, paddingVertical: 12 },
});
