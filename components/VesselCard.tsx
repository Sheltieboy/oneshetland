/**
 * components/VesselCard.tsx
 *
 * Big, scannable boat card for Da Boats. Optimised for older eyes:
 * larger type, bigger hero photo when one exists, generous tap area,
 * full row is tappable. Two variants:
 *
 *   variant="hero"    — full-width card with a tall photo banner above
 *                       the name + LK. Used in saved + recently-viewed
 *                       rows and as the main browse card.
 *   variant="row"     — horizontal row with a square thumb at left and
 *                       text at right. Compact but still 72 px tall so
 *                       it stays tappable with thumbs.
 */

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image, ViewStyle } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { SECTIONS } from '@/constants/sections';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { hullMaterialLabel } from '@/lib/boats-api';

const SECTION = SECTIONS.daBoats;

export interface VesselCardData {
  id:             string;
  lk_number:      string | null;
  canonical_name: string;
  built_year:     number | null;
  hull_material?: string | null;
  hero_url:       string | null;
  photo_count?:   number | null;
  alt_names?:     string | null;
  alt_regs?:      string | null;
}

interface VesselCardProps {
  data:     VesselCardData;
  onPress:  () => void;
  variant?: 'hero' | 'row';
  saved?:   boolean;
  onToggleSave?: () => void;
  style?:   ViewStyle;
}

export function VesselCard({
  data, onPress, variant = 'hero', saved = false, onToggleSave, style,
}: VesselCardProps) {
  const hull = hullMaterialLabel(data.hull_material ?? null);

  if (variant === 'row') {
    return (
      <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={[styles.row, style]}>
        <View style={[styles.rowThumb, { backgroundColor: SECTION.light }]}>
          {data.hero_url ? (
            <Image source={{ uri: data.hero_url }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          ) : (
            <Text style={[styles.rowThumbLk, { color: SECTION.color }]}>
              {data.lk_number ?? '—'}
            </Text>
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowName} numberOfLines={1}>{data.canonical_name}</Text>
          <Text style={styles.rowSub} numberOfLines={1}>
            {data.lk_number ? `${data.lk_number}` : ''}
            {data.built_year ? `  ·  ${data.built_year}` : ''}
            {hull ? `  ·  ${hull}` : ''}
          </Text>
        </View>
        {onToggleSave ? (
          <TouchableOpacity onPress={onToggleSave} hitSlop={12} style={styles.saveBtn}>
            <FontAwesome5
              name="heart"
              size={18}
              color={saved ? SECTION.color : colors.textLight}
              solid={saved}
            />
          </TouchableOpacity>
        ) : (
          <FontAwesome5 name="chevron-right" size={14} color={colors.textLight} />
        )}
      </TouchableOpacity>
    );
  }

  // hero variant — full-width photo card
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.9} style={[styles.heroCard, style]}>
      <View style={styles.heroPhotoFrame}>
        {data.hero_url ? (
          <Image source={{ uri: data.hero_url }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : (
          <View style={styles.heroPhotoEmpty}>
            <FontAwesome5 name="ship" size={42} color={SECTION.color} />
          </View>
        )}
        {/* Floating LK badge on the photo */}
        <View style={[styles.heroLkBadge, { backgroundColor: SECTION.color }]}>
          <Text style={styles.heroLkText} numberOfLines={1}>
            {data.lk_number ?? 'NO LK'}
          </Text>
        </View>
        {/* Save heart top-right */}
        {onToggleSave ? (
          <TouchableOpacity onPress={onToggleSave} hitSlop={12} style={styles.heroHeart}>
            <FontAwesome5
              name="heart"
              size={20}
              color={saved ? SECTION.color : '#fff'}
              solid={saved}
            />
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={styles.heroBody}>
        <Text style={styles.heroName} numberOfLines={2}>{data.canonical_name}</Text>
        <Text style={styles.heroSub} numberOfLines={1}>
          {data.built_year ? `Built ${data.built_year}` : 'Build year unknown'}
          {hull ? `  ·  ${hull}` : ''}
          {data.photo_count && data.photo_count > 0 ? `  ·  ${data.photo_count} photo${data.photo_count === 1 ? '' : 's'}` : ''}
        </Text>
        {data.alt_names ? (
          <Text style={styles.heroAlt} numberOfLines={1}>
            Also called: {data.alt_names}
          </Text>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  // ── Hero variant ─────────────────────────────────────────────────────────
  heroCard: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  heroPhotoFrame: {
    width: '100%',
    aspectRatio: 16 / 10,
    backgroundColor: SECTION.light,
    position: 'relative',
  },
  heroPhotoEmpty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroLkBadge: {
    position: 'absolute',
    left: 12,
    bottom: 12,
    minWidth: 64,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    alignItems: 'center',
  },
  heroLkText: {
    color: '#fff',
    fontWeight: '900',
    fontSize: 14,
    letterSpacing: 0.5,
  },
  heroHeart: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(15, 28, 38, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroBody: {
    padding: spacing.md,
  },
  heroName: {
    fontSize: 22,
    fontWeight: '900',
    color: colors.textPrimary,
    letterSpacing: -0.2,
  },
  heroSub: {
    fontSize: 15,
    color: colors.textSecondary,
    marginTop: 4,
    fontWeight: '500',
  },
  heroAlt: {
    fontSize: 13,
    color: colors.textMuted,
    fontStyle: 'italic',
    marginTop: 4,
  },

  // ── Row variant ──────────────────────────────────────────────────────────
  row: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowThumb: {
    width: 56,
    height: 56,
    borderRadius: radius.sm,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowThumbLk: {
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
  rowName: {
    fontSize: 17,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  rowSub: {
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: 2,
    fontWeight: '500',
  },
  saveBtn: {
    width: 44, height: 44,
    alignItems: 'center', justifyContent: 'center',
  },
});

export default VesselCard;
