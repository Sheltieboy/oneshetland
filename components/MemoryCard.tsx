/**
 * components/MemoryCard.tsx
 *
 * List-style preview card for a memory. Used in:
 *   - the bottom-sheet list under the Memories map ("at this place")
 *   - the Home tab "latest from the islands" row
 *   - search results
 *
 * Two visual modes:
 *   compact = small horizontal card with hero thumb + title + place
 *   full    = larger card with bigger thumb + body excerpt
 */

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image, ViewStyle } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { SECTIONS } from '@/constants/sections';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { MemoryPin } from '@/lib/memories-api';

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

export function MemoryCard({ pin, onPress, variant = 'compact', style }: MemoryCardProps) {
  const isFull = variant === 'full';

  const Hero = () => (
    <View style={[isFull ? styles.heroFull : styles.heroCompact, { backgroundColor: SECTION.light }]}>
      {pin.hero_url && pin.hero_kind === 'photo' ? (
        <Image source={{ uri: pin.hero_url }} style={StyleSheet.absoluteFill} resizeMode="cover" />
      ) : (
        <FontAwesome5
          name={
            pin.hero_kind === 'audio'  ? 'microphone' :
            pin.hero_kind === 'video'  ? 'video'      :
            'book-open'
          }
          size={isFull ? 28 : 20}
          color={SECTION.color}
        />
      )}
      {pin.hero_kind === 'video' && pin.hero_url ? (
        <View style={styles.playOverlay}>
          <FontAwesome5 name="play" size={isFull ? 16 : 10} color="#fff" solid />
        </View>
      ) : null}
    </View>
  );

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      style={[isFull ? styles.cardFull : styles.cardCompact, style]}
    >
      <Hero />
      <View style={isFull ? styles.bodyFull : styles.bodyCompact}>
        {pin.place_name ? (
          <Text style={[styles.place, { color: SECTION.color }]} numberOfLines={1}>
            {pin.place_name}
          </Text>
        ) : null}
        <Text style={isFull ? styles.titleFull : styles.titleCompact} numberOfLines={isFull ? 2 : 1}>
          {pin.title ?? 'Untitled memory'}
        </Text>
        <View style={styles.metaRow}>
          {pin.era ? (
            <View style={[styles.eraChip, { backgroundColor: SECTION.light }]}>
              <Text style={[styles.eraChipText, { color: SECTION.color }]}>{pin.era}</Text>
            </View>
          ) : null}
          <Text style={styles.metaText}>{timeAgo(pin.created_at)}</Text>
          {pin.comment_count > 0 ? (
            <Text style={styles.metaText}>
              <FontAwesome5 name="comment" size={9} solid color={colors.textMuted} />{' '}
              {pin.comment_count}
            </Text>
          ) : null}
          {pin.child_count > 0 ? (
            <Text style={styles.metaText}>
              <FontAwesome5 name="layer-group" size={9} solid color={colors.textMuted} />{' '}
              {pin.child_count}
            </Text>
          ) : null}
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  cardCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.white,
    borderRadius: radius.md,
    padding: spacing.sm,
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  heroCompact: {
    width: 56,
    height: 56,
    borderRadius: radius.sm,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bodyCompact: {
    flex: 1,
  },
  titleCompact: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  cardFull: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  heroFull: {
    width: '100%',
    aspectRatio: 16 / 9,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  bodyFull: {
    padding: spacing.md,
  },
  titleFull: {
    fontSize: fontSize.lg,
    fontWeight: '800',
    color: colors.textPrimary,
    marginBottom: 4,
  },
  place: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: 6,
  },
  metaText: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
  },
  eraChip: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  eraChipText: {
    fontSize: 10,
    fontWeight: '700',
  },
  playOverlay: {
    position: 'absolute',
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default MemoryCard;
