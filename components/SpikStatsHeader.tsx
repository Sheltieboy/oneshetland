/**
 * SpikStatsHeader
 *
 * Animated stats section shown above the word list on the Spik tab.
 * Staggered card entrances, count-up numbers, animated progress bars,
 * usage mix with bounce highlight, and a "Surprise me" random word button.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  Easing,
  TouchableOpacity,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { colors, fontSize, radius, spacing } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { type SpikStats } from '@/lib/oneshetland-api';

const SUPABASE_URL     = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

// ── Count-up hook ─────────────────────────────────────────────────────────────

function useCountUp(target: number, delay: number = 0, duration: number = 1400) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!target) return;
    const timeout = setTimeout(() => {
      const steps = 60;
      const stepTime = duration / steps;
      let step = 0;
      const timer = setInterval(() => {
        step++;
        const t = step / steps;
        const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
        setCount(Math.round(eased * target));
        if (step >= steps) { setCount(target); clearInterval(timer); }
      }, stepTime);
      return () => clearInterval(timer);
    }, delay);
    return () => clearTimeout(timeout);
  }, [target, delay, duration]);
  return count;
}

// ── Animated bar ──────────────────────────────────────────────────────────────

function AnimatedBar({
  percent,
  color,
  delay,
}: {
  percent: number;
  color: string;
  delay: number;
}) {
  const widthAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(widthAnim, {
      toValue: percent,
      duration: 900,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [percent, delay]);

  const width = widthAnim.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
  });

  return (
    <View style={styles.barTrack}>
      <Animated.View style={[styles.barFill, { width, backgroundColor: color }]} />
    </View>
  );
}

// ── Surprise me ───────────────────────────────────────────────────────────────

function SurpriseButton() {
  const [loading, setLoading] = useState(false);
  const spinAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const spin = spinAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  const handlePress = useCallback(async () => {
    if (loading) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Spin icon + scale press
    Animated.parallel([
      Animated.timing(spinAnim, { toValue: 1, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.sequence([
        Animated.timing(scaleAnim, { toValue: 0.94, duration: 80, useNativeDriver: true }),
        Animated.spring(scaleAnim, { toValue: 1, friction: 4, useNativeDriver: true }),
      ]),
    ]).start(() => spinAnim.setValue(0));

    setLoading(true);
    try {
      const offset = Math.floor(Math.random() * 2844);
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/spik_dictionary?select=id&limit=1&offset=${offset}`,
        {
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          },
        },
      );
      const rows = await res.json();
      if (rows?.[0]?.id) {
        router.push({ pathname: '/spik-detail', params: { id: String(rows[0].id) } });
      }
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [loading]);

  return (
    <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
      <TouchableOpacity style={styles.surpriseBtn} onPress={handlePress} activeOpacity={1}>
        <Animated.View style={{ transform: [{ rotate: spin }] }}>
          <FontAwesome5 name="random" size={14} color="#fff" />
        </Animated.View>
        {loading
          ? <ActivityIndicator size="small" color="#fff" style={{ marginLeft: 8 }} />
          : <Text style={styles.surpriseBtnText}>Surprise me</Text>
        }
      </TouchableOpacity>
    </Animated.View>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  stats: SpikStats | null;
  loading: boolean;
}

const NUM_CARDS = 4;

export default function SpikStatsHeader({ stats, loading }: Props) {
  const { isTablet } = useAppLayout();
  // One opacity+translateY pair per card for staggered entrance
  const cardAnims = useRef(
    Array.from({ length: NUM_CARDS }, () => ({
      opacity:     new Animated.Value(0),
      translateY:  new Animated.Value(28),
    }))
  ).current;

  // Scale bounce for the dominant usage stat
  const dominantScale = useRef(new Animated.Value(0.6)).current;
  const dominantOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!stats) return;

    // Stagger card entrances
    Animated.stagger(
      90,
      cardAnims.map(({ opacity, translateY }) =>
        Animated.parallel([
          Animated.timing(opacity, {
            toValue: 1, duration: 450,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
          Animated.timing(translateY, {
            toValue: 0, duration: 450,
            easing: Easing.out(Easing.back(1.4)),
            useNativeDriver: true,
          }),
        ])
      )
    ).start();

    // Dominant usage stat bounces in after cards
    setTimeout(() => {
      Animated.parallel([
        Animated.spring(dominantScale, {
          toValue: 1, friction: 4, tension: 120,
          useNativeDriver: true,
        }),
        Animated.timing(dominantOpacity, {
          toValue: 1, duration: 250,
          useNativeDriver: true,
        }),
      ]).start();
    }, NUM_CARDS * 90 + 200);
  }, [stats]);

  const animStyle = (i: number) => ({
    opacity: cardAnims[i].opacity,
    transform: [{ translateY: cardAnims[i].translateY }],
  });

  const totalCount = useCountUp(stats?.total ?? 0, 0);

  // Sort origins descending
  const origins = stats?.origins
    ? [...stats.origins].sort((a, b) => b.count - a.count).slice(0, 4)
    : [];
  const maxOrigin = origins[0]?.count ?? 1;

  // Sort usage descending, find dominant
  const usage = stats?.usage
    ? [...stats.usage].sort((a, b) => b.count - a.count)
    : [];
  const dominant = usage[0];
  const others   = usage.slice(1);

  if (loading) {
    return (
      <View style={styles.loadingWrap}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (!stats) return null;

  return (
    <View style={[styles.wrap, isTablet && styles.wrapGrid]}>

      {/* ── Card 1: Total + Surprise ── */}
      <Animated.View style={[styles.card, styles.totalCard, isTablet && styles.colFull, animStyle(0)]}>
        <View style={styles.totalRow}>
          <View>
            <Text style={styles.totalNum}>{totalCount.toLocaleString()}</Text>
            <Text style={styles.totalLabel}>words in the Shetland dictionary</Text>
          </View>
          <SurpriseButton />
        </View>
      </Animated.View>

      {/* ── Card 2: Origin breakdown — each row taps through to filtered list ── */}
      <Animated.View style={[styles.card, isTablet && styles.colHalf, animStyle(1)]}>
        <View style={styles.cardHeaderRow}>
          <View>
            <Text style={styles.cardTitle}>Origin</Text>
            <Text style={styles.cardSubtitle}>Tap a row to see those words</Text>
          </View>
          <FontAwesome5 name="hand-pointer" size={12} color={colors.textLight} />
        </View>
        <View style={styles.originRows}>
          {origins.map((o, i) => (
            <OriginRow
              key={o.origin}
              label={o.origin}
              count={o.count}
              percent={(o.count / maxOrigin) * 100}
              delay={300 + i * 120}
              barDelay={500 + i * 120}
              onPress={() => {
                Haptics.selectionAsync();
                router.push({ pathname: '/spik-filter', params: { origin: o.origin } });
              }}
            />
          ))}
        </View>
      </Animated.View>

      {/* ── Card 3: Usage mix — every stat taps through to its filtered list ── */}
      <Animated.View style={[styles.card, isTablet && styles.colHalf, animStyle(2)]}>
        <View style={styles.cardHeaderRow}>
          <View>
            <Text style={styles.cardTitle}>Usage mix</Text>
            <Text style={styles.cardSubtitle}>Tap a level to filter the dictionary</Text>
          </View>
          <FontAwesome5 name="hand-pointer" size={12} color={colors.textLight} />
        </View>

        {/* Dominant stat bounces in */}
        {dominant && (
          <Animated.View style={[
            styles.dominantWrap,
            { opacity: dominantOpacity, transform: [{ scale: dominantScale }] }
          ]}>
            <Pressable
              onPress={() => {
                Haptics.selectionAsync();
                router.push({ pathname: '/spik-filter', params: { usage: dominant.level } });
              }}
              style={({ pressed }) => [styles.dominantBadge, pressed && { opacity: 0.85 }]}
            >
              <Text style={styles.dominantLabel}>{dominant.level}</Text>
              <View style={styles.dominantRight}>
                <UsageCount target={dominant.count} delay={NUM_CARDS * 90 + 350} big />
                <FontAwesome5 name="chevron-right" size={11} color="rgba(255,255,255,0.7)" />
              </View>
            </Pressable>
          </Animated.View>
        )}

        {/* Others in a grid */}
        <View style={styles.usageGrid}>
          {others.map((u) => (
            <Pressable
              key={u.level}
              onPress={() => {
                Haptics.selectionAsync();
                router.push({ pathname: '/spik-filter', params: { usage: u.level } });
              }}
              style={({ pressed }) => [styles.usageItem, pressed && { opacity: 0.6 }]}
            >
              <Text style={styles.usageLevel}>{u.level}</Text>
              <UsageCount target={u.count} delay={NUM_CARDS * 90 + 500} />
            </Pressable>
          ))}
        </View>
      </Animated.View>

      {/* ── Card 4: How to use ── */}
      <Animated.View style={[styles.card, styles.howToCard, isTablet && styles.colFull, animStyle(3)]}>
        <View style={styles.howToIcon}>
          <FontAwesome5 name="lightbulb" size={16} color={colors.accent} />
        </View>
        <Text style={styles.howToTitle}>How to use Spik</Text>
        <Text style={styles.howToBody}>
          Pick a letter above to jump into the dictionary, then open any full entry to see richer detail like pronunciation, example usage, alternate spelling, and origin.
        </Text>
      </Animated.View>

    </View>
  );
}

// ── Usage count sub-component ─────────────────────────────────────────────────

function UsageCount({ target, delay, big }: { target: number; delay: number; big?: boolean }) {
  const count = useCountUp(target, delay, 1000);
  return (
    <Text style={[styles.usageCount, big && styles.usageCountBig]}>
      {count.toLocaleString()}
    </Text>
  );
}

// ── Origin row ────────────────────────────────────────────────────────────────

function OriginRow({
  label, count, percent, delay, barDelay, onPress,
}: {
  label: string; count: number; percent: number; delay: number; barDelay: number;
  onPress?: () => void;
}) {
  const displayCount = useCountUp(count, delay, 1000);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.originRow, pressed && { opacity: 0.55 }]}
    >
      <View style={styles.originRowTop}>
        <Text style={styles.originLabel}>{label}</Text>
        <View style={styles.originRight}>
          <Text style={styles.originCount}>{displayCount.toLocaleString()}</Text>
          <FontAwesome5 name="chevron-right" size={10} color={colors.textLight} />
        </View>
      </View>
      <AnimatedBar percent={percent} color={colors.navy} delay={barDelay} />
    </Pressable>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  wrap:        { paddingHorizontal: spacing.md, paddingTop: spacing.md, gap: 10 },
  wrapGrid:    { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'stretch' },
  colFull:     { width: '100%' },
  colHalf:     { width: '48.5%' },
  loadingWrap: { height: 80, justifyContent: 'center', alignItems: 'center' },

  card: {
    backgroundColor: colors.cardBackground,
    borderRadius: radius.lg,
    padding: spacing.md,
    shadowColor: '#0F1C26',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 8,
    elevation: 2,
  },

  // Total card
  totalCard:  { backgroundColor: colors.offWhite },
  totalRow:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  totalNum:   { color: colors.navy, fontSize: 42, fontWeight: '900', lineHeight: 48 },
  totalLabel: { color: colors.textMuted, fontSize: fontSize.sm, marginTop: 2 },

  // Surprise button
  surpriseBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.navy,
    paddingHorizontal: 16, paddingVertical: 10,
    borderRadius: radius.full,
  },
  surpriseBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '700' },

  // Card typography
  cardTitle:    { color: colors.navy, fontSize: fontSize.lg, fontWeight: '800', marginBottom: 2 },
  cardSubtitle: { color: colors.textMuted, fontSize: fontSize.xs },
  cardHeaderRow:{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 },

  // Origin bars
  originRows:    { gap: 12 },
  originRow:     { gap: 5 },
  originRowTop:  { flexDirection: 'row', justifyContent: 'space-between' },
  originLabel:   { color: colors.textSecondary, fontSize: fontSize.sm },
  originRight:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  originCount:   { color: colors.navy, fontSize: fontSize.sm, fontWeight: '800' },
  barTrack:      { height: 8, backgroundColor: '#E5E9EF', borderRadius: 4, overflow: 'hidden' },
  barFill:       { height: 8, borderRadius: 4 },

  // Usage mix
  dominantWrap:  { marginBottom: 12 },
  dominantBadge: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.navy,
    borderRadius: radius.md,
    paddingHorizontal: 16, paddingVertical: 12,
  },
  dominantLabel:    { color: '#fff', fontSize: fontSize.md, fontWeight: '700' },
  dominantRight:    { flexDirection: 'row', alignItems: 'center', gap: 10 },
  usageCountBig:    { color: '#fff', fontSize: 28, fontWeight: '900' },
  usageGrid:        { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  usageItem:        { width: '45%' },
  usageLevel:       { color: colors.textMuted, fontSize: fontSize.xs, marginBottom: 2 },
  usageCount:       { color: colors.navy, fontSize: fontSize.xl, fontWeight: '800' },

  // How to
  howToCard:  { backgroundColor: '#F0F9FF' },
  howToIcon:  { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.accentLight, justifyContent: 'center', alignItems: 'center', marginBottom: 10 },
  howToTitle: { color: colors.navy, fontSize: fontSize.md, fontWeight: '800', marginBottom: 6 },
  howToBody:  { color: colors.textSecondary, fontSize: fontSize.sm, lineHeight: 20 },
});
