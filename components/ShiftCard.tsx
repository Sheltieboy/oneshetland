/**
 * components/ShiftCard.tsx
 * Listing card for a casual Shift — styled to match JobCard so the Work hub
 * reads as one product across the Jobs and Shifts tiers.
 */

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import {
  Shift, shiftDisplayBusiness, formatPay, formatDuration, formatShiftDate,
  URGENCY_CONFIG, CATEGORY_LABELS,
} from '@/lib/shifts-api';

const S = SECTIONS.shifts;

export function ShiftCard({ shift, onPress }: { shift: Shift; onPress: () => void }) {
  const biz = shiftDisplayBusiness(shift);
  const featured = shift.boosted_until != null && new Date(shift.boosted_until) > new Date();
  const urg = URGENCY_CONFIG[shift.urgency];
  const left = Math.max(0, shift.positions_total - shift.positions_filled);

  return (
    <TouchableOpacity style={[styles.card, featured && { borderColor: S.color + '66' }]} onPress={onPress} activeOpacity={0.85}>
      <View style={[styles.logo, { backgroundColor: S.color + '14' }]}>
        {biz.logo_url
          ? <Image source={{ uri: biz.logo_url }} style={styles.logoImg} />
          : <FontAwesome5 name="briefcase" size={18} color={S.color} solid />}
      </View>

      <View style={{ flex: 1 }}>
        <View style={styles.topRow}>
          {urg ? <View style={[styles.urgPill, { backgroundColor: urg.bg }]}><Text style={[styles.urgText, { color: urg.color }]}>{urg.label}</Text></View> : null}
          {featured ? <View style={[styles.urgPill, { backgroundColor: S.color }]}><FontAwesome5 name="star" size={8} color="#fff" solid /><Text style={[styles.urgText, { color: '#fff' }]}>Boosted</Text></View> : null}
        </View>
        <Text style={styles.title} numberOfLines={2}>{shift.title}</Text>
        <Text style={styles.org} numberOfLines={1}>
          {biz.name}{biz.is_verified ? '  ·  ✓ Verified' : ''}
        </Text>

        <View style={styles.chips}>
          <Chip icon="calendar-day" label={formatShiftDate(shift.start_at)} />
          <Chip icon="hourglass-half" label={formatDuration(shift.start_at, shift.end_at)} />
          {shift.location_text ? <Chip icon="map-marker-alt" label={shift.location_text} /> : null}
          {CATEGORY_LABELS[shift.category] ? <Chip icon="tag" label={CATEGORY_LABELS[shift.category]} /> : null}
        </View>

        <View style={styles.footer}>
          <Text style={[styles.pay, { color: S.color }]}>{formatPay(shift.pay_type, shift.pay_amount)}</Text>
          {shift.positions_total > 1 ? (<><Text style={styles.dot}>·</Text><Text style={styles.posted}>{left} of {shift.positions_total} left</Text></>) : null}
        </View>
      </View>

      <FontAwesome5 name="chevron-right" size={13} color={colors.textLight} />
    </TouchableOpacity>
  );
}

function Chip({ icon, label }: { icon: string; label: string }) {
  return (
    <View style={styles.chip}>
      <FontAwesome5 name={icon as any} size={9} color={colors.textMuted} solid />
      <Text style={styles.chipText} numberOfLines={1}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', gap: 12, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.md, alignItems: 'flex-start' },
  logo: { width: 46, height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  logoImg: { width: 46, height: 46 },
  topRow: { flexDirection: 'row', gap: 6, marginBottom: 4 },
  urgPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999 },
  urgText: { fontSize: 9, fontWeight: '800' },
  title: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, lineHeight: 21 },
  org: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: colors.offWhite, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, maxWidth: 170 },
  chipText: { fontSize: 11, fontWeight: '700', color: colors.textSecondary },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' },
  pay: { fontSize: fontSize.sm, fontWeight: '800' },
  dot: { color: colors.textLight },
  posted: { fontSize: fontSize.xs, color: colors.textMuted },
});

export default ShiftCard;
