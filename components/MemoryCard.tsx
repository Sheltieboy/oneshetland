/**
 * components/MemoryCard.tsx
 *
 * Preview card for a memory. Used in:
 *   - the list under the Memories map ("at this place")
 *   - the Memories feed ("latest from the islands")
 *   - the Home tab row
 *
 * Two visual modes:
 *   compact = horizontal card: hero thumb + place + title + era + stats,
 *             with an era-coloured left accent.
 *   full    = editorial card: 16:9 hero (photo with title overlay, or an
 *             era-tinted tile), era badge, and a stats strip.
 */

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image, ViewStyle } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { SECTIONS } from '@/constants/sections';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { MemoryPin } from '@/lib/memories-api';
import { eraTone } from '@/lib/memory-eras';

interface MemoryCardProps {
  pin:       MemoryPin;
  onPress?:  () => void;
  variant?:  'compact' | 'full';
  style?:    ViewStyle;
}

const SECTION = SECTIONS.memories;

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1)     return 'just now';
  if (mins < 60)    return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)     return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7)     return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5)    return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12)  return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

function pinStats(pin: MemoryPin): { icon: string; n: number }[] {
  return [
    pin.media_count    > 0 ? { icon: 'image',       n: pin.media_count }    : null,
    pin.reaction_count > 0 ? { icon: 'heart',       n: pin.reaction_count } : null,
    pin.comment_count  > 0 ? { icon: 'comment',     n: pin.comment_count }  : null,
    pin.child_count    > 0 ? { icon: 'layer-group', n: pin.child_count }    : null,
  ].filter(Boolean) as { icon: string; n: number }[];
}

function Stat({ icon, n }: { icon: string; n: number }) {
  return (
    <View style={styles.stat}>
      <FontAwesome5 name={icon as any} size={9} color={colors.textMuted} solid />
      <Text style={styles.metaText}>{n}</Text>
    </View>
  );
}

export function MemoryCard({ pin, onPress, variant = 'compact', style }: MemoryCardProps) {
  const tone     = eraTone(pin.era);
  const hasPhoto = !!(pin.hero_url && pin.hero_kind === 'photo');
  const kindIcon = pin.hero_kind === 'audio' ? 'microphone'
                 : pin.hero_kind === 'video' ? 'video'
                 : tone.icon;
  const stats    = pinStats(pin);

  // ── Full / featured ────────────────────────────────────────────────────────
  if (variant === 'full') {
    return (
      <TouchableOpacity activeOpacity={0.9} onPress={onPress} style={[styles.cardFull, style]}>
        <View style={styles.heroFull}>
          {hasPhoto ? (
            <>
              <Image source={{ uri: pin.hero_url! }} style={StyleSheet.absoluteFill} resizeMode="cover" />
              <View style={styles.heroScrim} />
              <View style={styles.heroOverlay}>
                {pin.place_name ? <Text style={styles.heroPlace} numberOfLines={1}>{pin.place_name}</Text> : null}
                <Text style={styles.heroTitle} numberOfLines={2}>{pin.title ?? 'Untitled memory'}</Text>
              </View>
              {pin.hero_kind === 'video' ? (
                <View style={styles.playOverlay}><FontAwesome5 name="play" size={15} color="#fff" solid /></View>
              ) : null}
            </>
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.heroTile, { backgroundColor: tone.light }]}>
              <FontAwesome5 name={tone.icon as any} size={34} color={tone.color} solid />
            </View>
          )}
          {pin.era ? (
            <View style={[styles.eraBadgeFloat, { backgroundColor: tone.color }]}>
              <FontAwesome5 name={tone.icon as any} size={9} color="#fff" solid />
              <Text style={styles.eraBadgeFloatText}>{pin.era}</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.bodyFull}>
          {!hasPhoto ? (
            <>
              {pin.place_name ? <Text style={[styles.place, { color: SECTION.color }]} numberOfLines={1}>{pin.place_name}</Text> : null}
              <Text style={styles.titleFull} numberOfLines={2}>{pin.title ?? 'Untitled memory'}</Text>
            </>
          ) : null}
          <View style={styles.metaRow}>
            <Text style={styles.metaText}>{timeAgo(pin.created_at)}</Text>
            {stats.map(s => <Stat key={s.icon} icon={s.icon} n={s.n} />)}
          </View>
        </View>
      </TouchableOpacity>
    );
  }

  // ── Compact ──────────────────────────────────────────────────────────────────
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      style={[styles.cardCompact, { borderLeftColor: tone.color }, style]}
    >
      <View style={[styles.heroCompact, { backgroundColor: hasPhoto ? '#0b1f2a' : tone.light }]}>
        {hasPhoto ? (
          <Image source={{ uri: pin.hero_url! }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : (
          <FontAwesome5 name={kindIcon as any} size={22} color={tone.color} solid />
        )}
        {pin.hero_kind === 'video' && hasPhoto ? (
          <View style={styles.playOverlaySm}><FontAwesome5 name="play" size={9} color="#fff" solid /></View>
        ) : null}
      </View>

      <View style={styles.bodyCompact}>
        {pin.place_name ? (
          <Text style={[styles.place, { color: SECTION.color }]} numberOfLines={1}>{pin.place_name}</Text>
        ) : null}
        <Text style={styles.titleCompact} numberOfLines={1}>{pin.title ?? 'Untitled memory'}</Text>
        <View style={styles.metaRow}>
          {pin.era ? (
            <View style={[styles.eraChip, { backgroundColor: tone.light }]}>
              <FontAwesome5 name={tone.icon as any} size={9} color={tone.color} solid />
              <Text style={[styles.eraChipText, { color: tone.color }]} numberOfLines={1}>{pin.era}</Text>
            </View>
          ) : null}
          <Text style={styles.metaText}>{timeAgo(pin.created_at)}</Text>
          {stats.map(s => <Stat key={s.icon} icon={s.icon} n={s.n} />)}
        </View>
      </View>

      <FontAwesome5 name="chevron-right" size={13} color={colors.textLight} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  // ── Compact ──────────────────────────────────────────────────────────────────
  cardCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.white,
    borderRadius: radius.md,
    padding: spacing.sm,
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 4,
    shadowColor: '#0b1f2a',
    shadowOpacity: 0.04,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  heroCompact: {
    width: 64,
    height: 64,
    borderRadius: radius.sm,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bodyCompact: { flex: 1 },
  titleCompact: {
    fontSize: fontSize.md,
    fontWeight: '800',
    color: colors.textPrimary,
    marginTop: 1,
  },

  // ── Full ───────────────────────────────────────────────────────────────────
  cardFull: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#0b1f2a',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  heroFull: {
    width: '100%',
    aspectRatio: 16 / 9,
    overflow: 'hidden',
    position: 'relative',
  },
  heroTile: { alignItems: 'center', justifyContent: 'center' },
  heroScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(11,31,42,0.42)',
  },
  heroOverlay: {
    position: 'absolute',
    left: spacing.md, right: spacing.md, bottom: spacing.md,
  },
  heroPlace: {
    color: '#fff',
    fontSize: fontSize.xs,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    opacity: 0.92,
    marginBottom: 2,
  },
  heroTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: -0.3,
  },
  bodyFull: { padding: spacing.md, gap: 2 },
  titleFull: {
    fontSize: fontSize.lg,
    fontWeight: '800',
    color: colors.textPrimary,
    marginBottom: 2,
  },
  eraBadgeFloat: {
    position: 'absolute',
    top: spacing.sm, left: spacing.sm,
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 9, paddingVertical: 4,
    borderRadius: 999,
  },
  eraBadgeFloatText: { color: '#fff', fontSize: 10, fontWeight: '800' },

  // ── Shared ───────────────────────────────────────────────────────────────────
  place: {
    fontSize: fontSize.xs,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: 6,
    flexWrap: 'wrap',
  },
  metaText: { fontSize: fontSize.xs, color: colors.textMuted },
  stat: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  eraChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    maxWidth: 160,
  },
  eraChipText: { fontSize: 10, fontWeight: '800' },
  playOverlay: {
    position: 'absolute',
    top: '50%', left: '50%',
    width: 44, height: 44, borderRadius: 22,
    marginLeft: -22, marginTop: -22,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center', justifyContent: 'center',
  },
  playOverlaySm: {
    position: 'absolute',
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center',
  },
});

export default MemoryCard;
