/**
 * components/RouteSigns.tsx
 *
 * Pickup ➜ destination as two Shetland road signs, separated by an arrow.
 *
 * Drop-in for any Fetch screen that shows a route — driver dashboard cards,
 * customer step-4 confirm, request history, admin run overview.
 *
 *   <RouteSigns from="Lerwick" to="Hillswick" />
 *   <RouteSigns from="Brae" to="Cullivoe" stacked />
 */

import React from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { ShetlandSign, ShetlandSignSize } from './ShetlandSign';
import { colors, spacing } from '@/constants/theme';

interface RouteSignsProps {
  from:     string;
  to:       string;
  size?:    ShetlandSignSize;
  /** Stack signs vertically (with a downward arrow) instead of side-by-side. */
  stacked?: boolean;
  style?:   ViewStyle;
}

export function RouteSigns({ from, to, size = 'sm', stacked = false, style }: RouteSignsProps) {
  if (stacked) {
    return (
      <View style={[styles.stack, style]}>
        <ShetlandSign name={from} size={size} />
        <FontAwesome5
          name="arrow-down"
          size={size === 'lg' ? 22 : size === 'md' ? 18 : 14}
          color={colors.fetch}
          style={{ marginVertical: spacing.xs }}
        />
        <ShetlandSign name={to} size={size} />
      </View>
    );
  }

  return (
    <View style={[styles.row, style]}>
      <ShetlandSign name={from} size={size} />
      <FontAwesome5
        name="arrow-right"
        size={size === 'lg' ? 22 : size === 'md' ? 18 : 14}
        color={colors.fetch}
        style={{ marginHorizontal: spacing.sm }}
      />
      <ShetlandSign name={to} size={size} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  stack: {
    alignItems: 'center',
  },
});

export default RouteSigns;
