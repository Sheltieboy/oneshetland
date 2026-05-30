/**
 * TabScreenHeader
 *
 * Shared header used by every main tab screen.
 * Keeps all tabs visually consistent — navy background, "OneShetland" eyebrow,
 * section icon + name, subtitle, and a 3-px accent border in the section colour.
 *
 * Usage:
 *   <TabScreenHeader section={SECTIONS.shifts} right={<BadgeRow />}>
 *     <Toggle />   {/* optional content below the title row (search bar, mode toggle…) *\/}
 *   </TabScreenHeader>
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import type { SectionBrand } from '@/constants/sections';

interface Props {
  section:   SectionBrand;
  /** Rendered top-right — e.g. a live badge, action buttons, word count */
  right?:    React.ReactNode;
  /** Rendered below the title block — e.g. a search bar or mode toggle */
  children?: React.ReactNode;
}

export function TabScreenHeader({ section, right, children }: Props) {
  return (
    <View style={[styles.header, { borderBottomColor: section.color }]}>

      {/* Title row */}
      <View style={styles.top}>
        <View style={styles.titleBlock}>
          <Text style={styles.eyebrow}>OneShetland</Text>
          <View style={styles.titleRow}>
            <View style={[styles.iconPill, { backgroundColor: section.color + '28' }]}>
              <FontAwesome5 name={section.icon as any} size={13} color={section.color} solid />
            </View>
            <Text style={styles.title}>{section.label}</Text>
          </View>
          <Text style={styles.subtitle}>{section.description}</Text>
        </View>

        {right != null && (
          <View style={styles.rightSlot}>{right}</View>
        )}
      </View>

      {/* Optional below-title content */}
      {children != null && (
        <View style={styles.below}>{children}</View>
      )}

    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: 3,
  },

  top: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },

  titleBlock: { flex: 1 },

  eyebrow: {
    color: 'rgba(255,255,255,0.28)',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 5,
  },

  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    marginBottom: 4,
  },

  iconPill: {
    width: 30, height: 30,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },

  title: {
    color: '#fff',
    fontSize: fontSize.xxl,
    fontWeight: '900',
    lineHeight: 30,
  },

  subtitle: {
    color: 'rgba(255,255,255,0.48)',
    fontSize: fontSize.sm,
    marginLeft: 39, // indent under icon pill (30px pill + 9px gap)
  },

  rightSlot: {
    marginLeft: spacing.sm,
    alignSelf: 'center',
  },

  below: {
    marginTop: 12,
  },
});
