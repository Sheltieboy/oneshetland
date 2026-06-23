/**
 * Brush — painterly strokes drawn from the OneShetland logo language.
 *
 * BrushAccent  — a short vertical hand-painted stroke for section-header marks
 *                (replaces the flat coloured bar), tinted to the section colour.
 * BrushDivider — a thin horizontal dry-brush stroke between sections
 *                (replaces the flat 1px line).
 *
 * Both are react-native-svg, so they stay crisp at any density.
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { spacing } from '@/constants/theme';

export function BrushAccent({ color }: { color: string }) {
  return (
    <Svg width={12} height={26} viewBox="0 0 12 26">
      {/* thick core */}
      <Path d="M6 2 C 4 8, 8 15, 5.5 24" fill="none" stroke={color} strokeWidth={4.4} strokeLinecap="round" />
      {/* thin satellite for a dry-brush edge */}
      <Path d="M7.6 3.4 C 6.8 9, 8.9 16, 7 22.6" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeOpacity={0.55} />
    </Svg>
  );
}

export function BrushDivider({ color = '#032F4C' }: { color?: string }) {
  return (
    <View style={styles.dividerWrap}>
      <Svg width="100%" height={12} viewBox="0 0 340 12" preserveAspectRatio="none">
        <Path
          d="M4 7 C 70 3, 130 11, 190 6 S 300 4, 336 8"
          fill="none" stroke={color} strokeOpacity={0.2} strokeWidth={2.2}
          strokeLinecap="round" strokeDasharray="46 6 20 9 34 5 28 7"
        />
        <Path
          d="M4 8 C 80 5, 150 12, 210 7 S 310 6, 336 9"
          fill="none" stroke={color} strokeOpacity={0.1} strokeWidth={1.2}
          strokeLinecap="round"
        />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  dividerWrap: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.md,
  },
});
