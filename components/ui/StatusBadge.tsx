import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, fontSize, radius, spacing } from '@/constants/theme';

const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string }> = {
  // Driver statuses
  not_applied:        { label: 'Not applied',         bg: '#F3F4F6',          text: '#4B5563' },
  pending:            { label: 'Pending review',       bg: colors.warningLight, text: '#92400E' },
  approved:           { label: 'Approved',             bg: colors.successLight, text: '#065F46' },
  rejected:           { label: 'Application rejected', bg: colors.errorLight,   text: '#991B1B' },
  suspended:          { label: 'Account suspended',    bg: '#FEF3C7',          text: '#92400E' },
  // Run statuses
  open:               { label: 'Open',                 bg: colors.successLight, text: '#065F46' },
  full:               { label: 'Full',                 bg: '#FEF3C7',          text: '#92400E' },
  completed:          { label: 'Completed',             bg: '#F3F4F6',          text: '#4B5563' },
  cancelled:          { label: 'Cancelled',             bg: colors.errorLight,   text: '#991B1B' },
  // Request statuses (prefixed to avoid clash with driver 'pending')
  request_pending:    { label: 'Waiting for driver',   bg: '#FEF3C7',          text: '#92400E' },
  request_matched:    { label: 'Driver matched',        bg: '#EFF6FF',          text: '#1D4ED8' },
  request_collected:  { label: 'Collected',             bg: '#F0FBFF',          text: '#0E7490' },
  request_delivered:  { label: 'Delivered',             bg: colors.successLight, text: '#065F46' },
  request_cancelled:  { label: 'Cancelled',             bg: colors.errorLight,   text: '#991B1B' },
  // Keep unprefixed versions for the driver detail view
  matched:            { label: 'Matched',               bg: '#EFF6FF',          text: '#1D4ED8' },
  collected:          { label: 'Collected',             bg: '#F0FBFF',          text: '#0E7490' },
  delivered:          { label: 'Delivered',             bg: colors.successLight, text: '#065F46' },
};

interface StatusBadgeProps {
  status: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status] ?? { label: status, bg: '#F3F4F6', text: '#4B5563' };
  return (
    <View style={[styles.badge, { backgroundColor: config.bg }]}>
      <Text style={[styles.text, { color: config.text }]}>{config.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
  },
  text: {
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
});
