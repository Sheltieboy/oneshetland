/**
 * app/intro.tsx
 *
 * First-launch tour. Seen once per fresh install — gated by AsyncStorage flag
 * `intro_seen_v1`. Bump the version suffix if you ever want to re-show a
 * refreshed intro without resetting the original flag.
 *
 * Layout: horizontal ScrollView with pagingEnabled — no extra dependency.
 * Section-coloured icons follow constants/sections.ts so the visual language
 * matches the rest of the app.
 */

import React, { useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  NativeSyntheticEvent, NativeScrollEvent, StatusBar, useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';

export const INTRO_SEEN_KEY = 'intro_seen_v1';

interface Slide {
  title:    string;
  body:     string;
  icon:     string;
  color:    string;       // accent + icon colour
  bg:       string;       // background — usually navy, but a few accent-tinted variants
  cta?:     string;       // only set on the last slide
}

const SLIDES: Slide[] = [
  {
    title: 'Welcome to OneShetland',
    body:  'Your home for everything Shetland — built locally, for the islands. Have a look around freely; you don\'t need an account to browse.',
    icon:  'compass',
    color: '#12B3D6',
    bg:    colors.navy,
  },
  {
    title: 'Local',
    body:  'Shops, services, bookings, loyalty stamps and points, and exclusive offers from Shetland businesses.',
    icon:  SECTIONS.local.icon,
    color: SECTIONS.local.color,
    bg:    colors.navy,
  },
  {
    title: "What's On",
    body:  'Events, gigs and things to do right across Shetland — all in one place.',
    icon:  SECTIONS.events.icon,
    color: SECTIONS.events.color,
    bg:    colors.navy,
  },
  {
    title: 'Fetch',
    body:  'Need something picked up? Request a driver. Or become a driver and earn money — take a request, or create your own run for people to request into.',
    icon:  SECTIONS.fetch.icon,
    color: SECTIONS.fetch.color,
    bg:    colors.navy,
  },
  {
    title: 'Jobs',
    body:  'Work across the islands — from a shift for tonight to a permanent post for next month.',
    icon:  SECTIONS.jobs.icon,
    color: SECTIONS.jobs.color,
    bg:    colors.navy,
  },
  {
    title: 'Games',
    body:  'Guess Da Wird, Spik Snap, Spik Sprint — daily word challenges in Shetland dialect.',
    icon:  'gamepad',
    color: SECTIONS.games.color,
    bg:    colors.navy,
  },
  {
    title: 'Spik',
    body:  'The Shetland dialect community dictionary — over 2,800 wirds and growing.',
    icon:  SECTIONS.spik.icon,
    color: SECTIONS.spik.color,
    bg:    colors.navy,
  },
  {
    title: "There's lots more inside",
    body:  "Tap the More button to find the Directory, Auld Stories, Da Boats, Games, Hubs and more. You can explore it all without signing in.",
    icon:  'ellipsis-h',
    color: '#12B3D6',
    bg:    colors.navy,
  },
  {
    title: 'One login. More to come.',
    body:  "Make a free account to save your place and use everything — or carry on browsing and sign in whenever you like. We're just getting started, with new features landing regularly.",
    icon:  'rocket',
    color: '#12B3D6',
    bg:    colors.navy,
    cta:   'Get started',
  },
];

export default function IntroScreen() {
  const router = useRouter();
  const { width: SCREEN_W } = useWindowDimensions();
  const scrollRef = useRef<ScrollView>(null);
  const [index, setIndex] = useState(0);

  const lastSlide = index === SLIDES.length - 1;

  const finish = async () => {
    try {
      await AsyncStorage.setItem(INTRO_SEEN_KEY, '1');
    } catch {
      // Non-fatal — worst case the intro shows once more.
    }
    router.replace('/(tabs)');
  };

  const onNext = () => {
    Haptics.selectionAsync();
    if (lastSlide) {
      finish();
      return;
    }
    scrollRef.current?.scrollTo({ x: (index + 1) * SCREEN_W, animated: true });
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const newIndex = Math.round(e.nativeEvent.contentOffset.x / SCREEN_W);
    if (newIndex !== index) setIndex(newIndex);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.navy }}>
      <StatusBar barStyle="light-content" />
      <SafeAreaView edges={['top']} style={{ flex: 0 }}>
        <View style={styles.topBar}>
          <View style={{ flex: 1 }} />
          {!lastSlide && (
            <TouchableOpacity onPress={finish} hitSlop={16} accessibilityLabel="Skip intro">
              <Text style={styles.skip}>Skip</Text>
            </TouchableOpacity>
          )}
        </View>
      </SafeAreaView>

      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onScroll}
        style={{ flex: 1 }}
      >
        {SLIDES.map((s, i) => (
          <View key={i} style={[styles.slide, { width: SCREEN_W, backgroundColor: s.bg }]}>
            <View style={[styles.iconWrap, { backgroundColor: s.color + '20', borderColor: s.color + '40' }]}>
              <FontAwesome5 name={s.icon as any} size={56} color={s.color} solid />
            </View>
            <Text style={styles.title}>{s.title}</Text>
            <Text style={styles.body}>{s.body}</Text>
          </View>
        ))}
      </ScrollView>

      <SafeAreaView edges={['bottom']} style={{ flex: 0, backgroundColor: colors.navy }}>
        <View style={styles.dots}>
          {SLIDES.map((_, i) => (
            <View
              key={i}
              style={[
                styles.dot,
                i === index && { backgroundColor: SLIDES[index].color, width: 22 },
              ]}
            />
          ))}
        </View>

        <View style={styles.ctaWrap}>
          <TouchableOpacity
            style={[styles.ctaBtn, { backgroundColor: SLIDES[index].color }]}
            onPress={onNext}
            activeOpacity={0.85}
            accessibilityLabel={lastSlide ? (SLIDES[index].cta ?? 'Get started') : 'Next'}
          >
            <Text style={styles.ctaText}>
              {lastSlide ? (SLIDES[index].cta ?? 'Get started') : 'Next'}
            </Text>
            <FontAwesome5 name={lastSlide ? 'check' : 'arrow-right'} size={13} color="#fff" />
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: spacing.md, paddingVertical: 12,
    minHeight: 44,
  },
  skip: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.sm, fontWeight: '700', letterSpacing: 0.3 },

  slide: {
    flex: 1,
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: 24,
  },
  iconWrap: {
    width: 130, height: 130, borderRadius: 65,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2,
  },
  title: {
    color: '#fff', fontSize: 28, fontWeight: '900',
    textAlign: 'center', letterSpacing: 0.3,
  },
  body: {
    color: 'rgba(255,255,255,0.78)', fontSize: fontSize.md, lineHeight: 24,
    textAlign: 'center', paddingHorizontal: spacing.sm,
  },

  dots: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6,
    paddingTop: 8, paddingBottom: 16,
  },
  dot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.25)',
  },

  ctaWrap: { paddingHorizontal: spacing.lg, paddingBottom: 8 },
  ctaBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    paddingVertical: 16, borderRadius: radius.lg,
  },
  ctaText: { color: '#fff', fontSize: fontSize.md, fontWeight: '900', letterSpacing: 0.3 },
});
