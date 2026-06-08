/**
 * components/GameCard.tsx
 *
 * One reusable promo card for every OneShetland game. Each game has its own
 * distinctive visual treatment so the card can be dropped anywhere a game is
 * being suggested — Home tab, Games tab grid, Spik tab tease, post-result
 * "try another game" prompts — and stay recognisable.
 *
 * Variants:
 *   spik-sprint    — racing clock, big "60s" numeral, teal gradient
 *   spik-snap      — overlapping cards mid-match, purple/teal
 *   guess-da-wird  — Wordle tiles spelling Shetlandic, green/yellow/grey
 *   map-it         — Shetland silhouette with a dropped pin, navy/orange
 *
 * All variants share the same outer shape (rounded card with title, subtitle
 * and CTA) — only the decorative panel on the right changes.
 *
 * Usage:
 *   <GameCard game="spik-sprint" onPress={() => router.push('/games/spik-sprint')} />
 *   <GameCard game="map-it" size="lg" subtitle="Daily round" />
 */

import React from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ViewStyle,
} from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius } from '@/constants/theme';

export type GameKey = 'spik-sprint' | 'spik-snap' | 'guess-da-wird' | 'map-it';

interface GameCardProps {
  game:       GameKey;
  /** Optional override title (defaults to a per-game canonical title). */
  title?:     string;
  /** Optional override subtitle (defaults to a per-game pitch). */
  subtitle?:  string;
  /** Optional CTA label (defaults to "Play"). */
  cta?:       string;
  onPress?:   () => void;
  size?:      'sm' | 'md' | 'lg';
  style?:     ViewStyle;
}

interface GameMeta {
  title:    string;
  subtitle: string;
  bg:       string;
  bgTint:   string;
  accent:   string;
  text:     string;
  emoji:    string;   // fallback character for the smallest size
}

const GAMES: Record<GameKey, GameMeta> = {
  'spik-sprint': {
    title:    'Spik Sprint',
    subtitle: '60 seconds. As many words as you can.',
    bg:       '#0E7490',
    bgTint:   '#0891B2',
    accent:   '#FDE68A',
    text:     '#FFFFFF',
    emoji:    '⏱',
  },
  'spik-snap': {
    title:    'Spik Snap',
    subtitle: 'Match the Shetlandic to its meaning.',
    bg:       '#7C3AED',
    bgTint:   '#9333EA',
    accent:   '#FDE68A',
    text:     '#FFFFFF',
    emoji:    '🃏',
  },
  'guess-da-wird': {
    title:    'Guess Da Wird',
    subtitle: 'Wordle, but in Shetlandic.',
    bg:       '#065F46',
    bgTint:   '#059669',
    accent:   '#FDE68A',
    text:     '#FFFFFF',
    emoji:    'Aa',
  },
  'map-it': {
    title:    'Map It',
    subtitle: 'Drop a pin. Closer is better.',
    bg:       '#032F4C',
    bgTint:   '#0A4A70',
    accent:   '#E0722A',
    text:     '#FFFFFF',
    emoji:    '📍',
  },
};

const SIZE_MAP = {
  sm: { padding: spacing.md, titleSize: fontSize.md,  subSize: fontSize.xs, height: 92,  visualW: 80 },
  md: { padding: spacing.lg, titleSize: fontSize.lg,  subSize: fontSize.sm, height: 128, visualW: 112 },
  lg: { padding: spacing.lg, titleSize: fontSize.xl,  subSize: fontSize.sm, height: 168, visualW: 140 },
} as const;

// ── Per-game decorative visual ──────────────────────────────────────────────

function SpikSprintVisual({ meta, w }: { meta: GameMeta; w: number }) {
  return (
    <View style={[styles.visual, { width: w }]}>
      {/* clock face ring */}
      <View
        style={{
          width:  w * 0.78,
          height: w * 0.78,
          borderRadius: w * 0.4,
          borderWidth: 4,
          borderColor: meta.accent,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ color: meta.accent, fontSize: w * 0.34, fontWeight: '900', letterSpacing: -1 }}>
          60
        </Text>
        <Text style={{ color: meta.accent, fontSize: w * 0.13, fontWeight: '700', marginTop: -4, opacity: 0.85 }}>
          SEC
        </Text>
      </View>
    </View>
  );
}

function SpikSnapVisual({ meta, w }: { meta: GameMeta; w: number }) {
  const cardW = w * 0.48;
  const cardH = w * 0.62;
  return (
    <View style={[styles.visual, { width: w }]}>
      {/* back card */}
      <View
        style={{
          position: 'absolute',
          width: cardW,
          height: cardH,
          borderRadius: 8,
          backgroundColor: 'rgba(255,255,255,0.18)',
          transform: [{ translateX: -10 }, { translateY: 10 }, { rotate: '-8deg' }],
        }}
      />
      {/* front card */}
      <View
        style={{
          width: cardW,
          height: cardH,
          borderRadius: 8,
          backgroundColor: meta.accent,
          alignItems: 'center',
          justifyContent: 'center',
          transform: [{ translateX: 10 }, { translateY: -4 }, { rotate: '6deg' }],
        }}
      >
        <Text style={{ color: meta.bg, fontSize: w * 0.18, fontWeight: '900' }}>Aa</Text>
      </View>
    </View>
  );
}

function GuessDaWirdVisual({ meta, w }: { meta: GameMeta; w: number }) {
  // five tiles spelling out S-P-I-K with the first two "green" (correct)
  const letters: { c: string; tone: 'hit' | 'near' | 'miss' }[] = [
    { c: 'S', tone: 'hit'  },
    { c: 'P', tone: 'hit'  },
    { c: 'I', tone: 'near' },
    { c: 'K', tone: 'miss' },
  ];
  const tile = (w - 8) / 4 - 6;
  const tileColour = (tone: 'hit' | 'near' | 'miss') =>
    tone === 'hit'  ? '#10B981' :
    tone === 'near' ? '#F59E0B' :
                      '#475569';
  return (
    <View style={[styles.visual, { width: w, flexDirection: 'row', gap: 4 }]}>
      {letters.map((l, i) => (
        <View
          key={i}
          style={{
            width: tile,
            height: tile,
            borderRadius: 4,
            backgroundColor: tileColour(l.tone),
            alignItems: 'center',
            justifyContent: 'center',
            transform: [{ rotate: `${(i - 1.5) * 4}deg` }],
          }}
        >
          <Text style={{ color: '#fff', fontSize: tile * 0.5, fontWeight: '900' }}>{l.c}</Text>
        </View>
      ))}
    </View>
  );
}

function MapItVisual({ meta, w }: { meta: GameMeta; w: number }) {
  // Stylised Shetland silhouette — a stack of three rough island shapes,
  // big to small, with an orange pin on the middle one. Not geographically
  // accurate; just instantly readable as "Shetland-ish archipelago".
  return (
    <View style={[styles.visual, { width: w, justifyContent: 'center' }]}>
      <View style={{ alignItems: 'center', gap: 4 }}>
        {/* North isle blob */}
        <View
          style={{
            width: w * 0.32,
            height: w * 0.16,
            borderRadius: 6,
            backgroundColor: meta.accent,
            opacity: 0.55,
            transform: [{ rotate: '-12deg' }, { translateX: -6 }],
          }}
        />
        {/* Mainland blob (the big one) — with pin */}
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View
            style={{
              width: w * 0.48,
              height: w * 0.32,
              borderRadius: 10,
              backgroundColor: meta.accent,
              opacity: 0.9,
            }}
          />
          <FontAwesome5
            name="map-marker-alt"
            size={w * 0.28}
            color="#FFFFFF"
            style={{ marginLeft: -w * 0.35, marginTop: -w * 0.18 }}
          />
        </View>
        {/* South isle blob */}
        <View
          style={{
            width: w * 0.26,
            height: w * 0.12,
            borderRadius: 6,
            backgroundColor: meta.accent,
            opacity: 0.55,
            transform: [{ rotate: '8deg' }, { translateX: 8 }],
          }}
        />
      </View>
    </View>
  );
}

// ── Card shell ──────────────────────────────────────────────────────────────

export function GameCard({
  game,
  title,
  subtitle,
  cta = 'Play',
  onPress,
  size = 'md',
  style,
}: GameCardProps) {
  const meta = GAMES[game];
  const s = SIZE_MAP[size];

  const visual = (() => {
    switch (game) {
      case 'spik-sprint':   return <SpikSprintVisual   meta={meta} w={s.visualW} />;
      case 'spik-snap':     return <SpikSnapVisual     meta={meta} w={s.visualW} />;
      case 'guess-da-wird': return <GuessDaWirdVisual  meta={meta} w={s.visualW} />;
      case 'map-it':        return <MapItVisual        meta={meta} w={s.visualW} />;
    }
  })();

  const Inner = (
    <View
      style={[
        styles.card,
        {
          backgroundColor: meta.bg,
          padding: s.padding,
          minHeight: s.height,
        },
        style,
      ]}
    >
      {/* tinted blob behind for depth */}
      <View
        style={[
          styles.bgBlob,
          { backgroundColor: meta.bgTint },
        ]}
      />
      <View style={styles.bodyRow}>
        <View style={styles.bodyText}>
          <Text style={[styles.title, { color: meta.text, fontSize: s.titleSize }]}>
            {title ?? meta.title}
          </Text>
          <Text style={[styles.subtitle, { color: meta.text, fontSize: s.subSize, opacity: 0.85 }]}>
            {subtitle ?? meta.subtitle}
          </Text>

          {onPress ? (
            <View style={[styles.cta, { backgroundColor: meta.accent }]}>
              <Text style={[styles.ctaText, { color: meta.bg }]}>{cta}</Text>
              <FontAwesome5 name="arrow-right" size={11} color={meta.bg} />
            </View>
          ) : null}
        </View>

        {visual}
      </View>
    </View>
  );

  if (onPress) {
    return (
      <TouchableOpacity onPress={onPress} activeOpacity={0.85}>
        {Inner}
      </TouchableOpacity>
    );
  }
  return Inner;
}

// ── Convenience: route map ──────────────────────────────────────────────────

/**
 * Canonical in-app route per game, for use with router.push.
 * Keeps callers from hard-coding paths in fifty places.
 */
export const GAME_ROUTES: Record<GameKey, string> = {
  'spik-sprint':   '/games/spik-sprint',
  'spik-snap':     '/games/spik-snap',
  'guess-da-wird': '/games/guess-da-wird',
  'map-it':        '/games/map-it',
};

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    overflow: 'hidden',
    position: 'relative',
  },
  bgBlob: {
    position: 'absolute',
    width: 260,
    height: 260,
    borderRadius: 200,
    right: -80,
    top:   -80,
    opacity: 0.6,
  },
  bodyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  bodyText: {
    flex: 1,
  },
  title: {
    fontWeight: '900',
    letterSpacing: -0.3,
    marginBottom: 4,
  },
  subtitle: {
    fontWeight: '500',
  },
  cta: {
    marginTop: spacing.sm,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    gap: 6,
  },
  ctaText: {
    fontWeight: '800',
    fontSize: fontSize.xs,
    letterSpacing: 0.3,
  },
  visual: {
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default GameCard;
