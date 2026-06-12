/**
 * ConfirmPaymentSheet
 *
 * A confirmation step shown BEFORE an off-session / saved-card charge — the
 * flows where Stripe shows no UI of its own, so a single tap would otherwise
 * move money silently. Shows a price breakdown, the total, what card is being
 * used, and a contextual policy line + link. The CTA is labelled "Pay £X.XX"
 * to make the payment obligation explicit (UK consumer-law button rule).
 *
 * Presentational only — the caller decides what happens onConfirm (and logs any
 * compliance event there). Do NOT use this in front of Stripe Payment Sheet
 * flows; the Sheet is already the confirmation.
 *
 *   <ConfirmPaymentSheet
 *     visible={confirming}
 *     itemName="Day pass to The Hood Wink"
 *     lineItems={[{ label: 'Day pass', amountPence: 1000 }]}
 *     totalPence={1000}
 *     payingWith="Saved card"
 *     policy={{ text: 'Passes are non-refundable once purchased.', url: TERMS_URL }}
 *     loading={paying}
 *     onConfirm={charge}
 *     onCancel={() => setConfirming(false)}
 *   />
 */

import React from 'react';
import {
  Modal, View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Linking,
} from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { formatPence } from '@/lib/local-api';

export interface PayLineItem {
  label: string;
  amountPence: number;
  /** Render muted (e.g. a fee line). */
  muted?: boolean;
}

interface Props {
  visible: boolean;
  title?: string;
  itemName: string;
  lineItems: PayLineItem[];
  totalPence: number;
  payingWith?: string;
  policy?: { text: string; url?: string };
  confirmLabel?: string;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmPaymentSheet({
  visible, title = 'Confirm payment', itemName, lineItems, totalPence,
  payingWith, policy, confirmLabel, loading = false, onConfirm, onCancel,
}: Props) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View style={styles.scrim}>
        <TouchableOpacity style={styles.scrimTap} activeOpacity={1} onPress={loading ? undefined : onCancel} />
        <View style={styles.sheet}>
          <View style={styles.grabber} />

          <Text style={styles.title}>{title}</Text>
          <Text style={styles.item} numberOfLines={2}>{itemName}</Text>

          <View style={styles.breakdown}>
            {lineItems.map((li, i) => (
              <View key={i} style={styles.row}>
                <Text style={[styles.rowLabel, li.muted && styles.muted]} numberOfLines={1}>{li.label}</Text>
                <Text style={[styles.rowAmount, li.muted && styles.muted]}>{formatPence(li.amountPence)}</Text>
              </View>
            ))}
            <View style={styles.divider} />
            <View style={styles.row}>
              <Text style={styles.totalLabel}>Total</Text>
              <Text style={styles.totalAmount}>{formatPence(totalPence)}</Text>
            </View>
          </View>

          {payingWith ? (
            <View style={styles.payingWith}>
              <FontAwesome5 name="credit-card" size={12} color={colors.textMuted} solid />
              <Text style={styles.payingWithText}>Paying with {payingWith}</Text>
            </View>
          ) : null}

          {policy ? (
            <Text style={styles.policy}>
              {policy.text}{' '}
              {policy.url ? (
                <Text style={styles.policyLink} onPress={() => Linking.openURL(policy.url!)}>View terms</Text>
              ) : null}
            </Text>
          ) : null}

          <TouchableOpacity
            style={[styles.payBtn, loading && { opacity: 0.7 }]}
            onPress={onConfirm}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.payText}>{confirmLabel ?? `Pay ${formatPence(totalPence)}`}</Text>}
          </TouchableOpacity>

          <TouchableOpacity style={styles.cancelBtn} onPress={onCancel} disabled={loading} hitSlop={8}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  scrimTap: { ...StyleSheet.absoluteFillObject },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: radius.xxl, borderTopRightRadius: radius.xxl,
    paddingHorizontal: spacing.lg, paddingTop: 10, paddingBottom: spacing.xl,
  },
  grabber: { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: spacing.md },

  title: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary },
  item: { fontSize: fontSize.md, color: colors.textSecondary, marginTop: 4 },

  breakdown: {
    marginTop: spacing.lg, backgroundColor: colors.screenBackground,
    borderRadius: radius.lg, padding: spacing.md, gap: 8,
  },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowLabel: { fontSize: fontSize.sm, color: colors.textSecondary, flexShrink: 1, marginRight: 12 },
  rowAmount: { fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: '600' },
  muted: { color: colors.textMuted },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 2 },
  totalLabel: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  totalAmount: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary },

  payingWith: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: spacing.md },
  payingWithText: { fontSize: fontSize.xs, color: colors.textMuted },

  policy: { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 18, marginTop: spacing.md },
  policyLink: { color: colors.accent, fontWeight: '700', textDecorationLine: 'underline' },

  payBtn: {
    marginTop: spacing.lg, backgroundColor: colors.navy, borderRadius: radius.lg,
    paddingVertical: 16, alignItems: 'center', justifyContent: 'center',
  },
  payText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
  cancelBtn: { marginTop: spacing.sm, alignItems: 'center', paddingVertical: 10 },
  cancelText: { color: colors.textMuted, fontSize: fontSize.sm, fontWeight: '700' },
});
