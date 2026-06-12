/**
 * FeaturedBusinessesBar
 *
 * Homepage grid of featured businesses (a Pro/Premium perk, backfilled with
 * other active listings while the directory is young). Responsive: 2-up on
 * phone, 3–4-up on tablet, in a single stable grid (no auto-rotation — it was
 * causing the bar to jump). A top-right "Browse all" link opens the full
 * Directory. Unclaimed listings show a "Claim" pill so owners see they can take
 * them over. Renders nothing if there are no businesses.
 *
 *   <FeaturedBusinessesBar />
 */

import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Image,
  type LayoutChangeEvent,
} from 'react-native';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import {
  fetchFeaturedBusinesses, CATEGORY_LABELS, CATEGORY_ICONS,
  type LocalBusiness,
} from '@/lib/local-api';

const GAP = 10;

export function FeaturedBusinessesBar() {
  const router = useRouter();
  const { screenWidth } = useAppLayout();
  const [items, setItems] = useState<LocalBusiness[]>([]);
  const [width, setWidth] = useState(0);

  const cols  = screenWidth >= 1100 ? 4 : screenWidth >= 768 ? 3 : 2;
  const shown = cols * 2; // one tidy two-row grid

  useEffect(() => {
    let alive = true;
    fetchFeaturedBusinesses(shown).then(b => { if (alive) setItems(b); }).catch(() => {});
    return () => { alive = false; };
  }, [shown]);

  if (items.length === 0) return null;

  const visible = items.slice(0, shown);
  const cardW   = width > 0 ? (width - GAP * (cols - 1)) / cols : 0;

  const accent = SECTIONS.local.color;

  return (
    <View style={styles.wrap}>
      <View style={styles.headRow}>
        <View style={[styles.accentBar, { backgroundColor: accent }]} />
        <Text style={styles.heading}>Featured local businesses</Text>
        <View style={{ flex: 1 }} />
        <TouchableOpacity
          onPress={() => router.push('/search')}
          hitSlop={10}
          style={styles.actionBtn}
          activeOpacity={0.7}
        >
          <Text style={[styles.browseAll, { color: accent }]}>Browse all</Text>
          <FontAwesome5 name="chevron-right" size={9} color={accent} />
        </TouchableOpacity>
      </View>

      <View
        style={styles.grid}
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      >
        {cardW > 0 && visible.map(b => {
          const accent = (b.brand_color && /^#?[0-9a-fA-F]{6}/.test(b.brand_color))
            ? (b.brand_color.startsWith('#') ? b.brand_color : `#${b.brand_color}`)
            : colors.accent;
          return (
            <TouchableOpacity
              key={b.id}
              style={[styles.card, { width: cardW }]}
              onPress={() => router.push(`/local-business-detail?id=${b.id}`)}
              activeOpacity={0.85}
            >
              <View style={styles.cardTop}>
                <View style={[styles.logoWrap, { backgroundColor: accent }]}>
                  {b.logo_url ? (
                    <Image source={{ uri: b.logo_url }} style={styles.logo} />
                  ) : (
                    <FontAwesome5 name={(CATEGORY_ICONS[b.category] ?? 'store') as any} size={15} color="#fff" solid />
                  )}
                </View>
                {b.is_verified && (
                  <FontAwesome5 name="check-circle" size={13} color={colors.success} solid />
                )}
              </View>

              <Text style={styles.name} numberOfLines={2}>{b.name}</Text>
              <Text style={styles.cat} numberOfLines={1}>{CATEGORY_LABELS[b.category] ?? 'Local'}</Text>

              <View style={styles.cardFoot}>
                {!b.is_claimed && (
                  <TouchableOpacity
                    style={[styles.claimPill, { borderColor: accent }]}
                    onPress={() => router.push(`/business-claim?id=${b.id}`)}
                    activeOpacity={0.8}
                    hitSlop={6}
                  >
                    <FontAwesome5 name="hand-paper" size={9} color={accent} solid />
                    <Text style={[styles.claimPillText, { color: accent }]}>Claim business</Text>
                  </TouchableOpacity>
                )}
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const CARD_H = 132;

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: spacing.lg },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: spacing.sm },
  accentBar: { width: 4, height: 20, borderRadius: 2 },
  heading: { fontSize: 17, fontWeight: '900', color: colors.textPrimary, letterSpacing: -0.3 },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  browseAll: { fontSize: 13, fontWeight: '700' },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP },

  card: {
    height: CARD_H,
    backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    padding: 12,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  logoWrap: {
    width: 40, height: 40, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  logo: { width: 40, height: 40, borderRadius: 11 },
  name: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary, lineHeight: 18, marginTop: 8 },
  cat:  { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },

  // Pinned to the bottom so every card is the same height regardless of pill.
  cardFoot: { marginTop: 'auto' },
  claimPill: {
    flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start',
    borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4,
  },
  claimPillText: { fontSize: 10, fontWeight: '800' },
});
