/**
 * app/business-orders.tsx
 *
 * Merchant order inbox for Shop Shetland — one-tap state moves:
 *   paid → accepted → ready (collect) | posted (+tracking) → completed
 * Buyer gets a push on each move via notify-product-order.
 */

import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { fetchBusinessOrders, updateOrderStatus, type ProductOrder } from '@/lib/products-api';
import { formatPence } from '@/lib/local-api';

const S = SECTIONS.local;
const ACTIVE = ['paid', 'accepted', 'ready', 'handed_over', 'posted'];

const STATUS_LABEL: Record<string, string> = {
  paid: 'New order', accepted: 'Accepted', ready: 'Ready to collect',
  handed_over: 'Handed over', posted: 'Posted', completed: 'Completed',
  cancelled: 'Cancelled', refunded: 'Refunded',
};
const STATUS_COLOR: Record<string, string> = {
  paid: '#d97706', accepted: '#0284c7', ready: '#059669', posted: '#059669',
  handed_over: '#059669', completed: '#64748b', cancelled: '#e11d48', refunded: '#e11d48',
};
const NEXT: Record<string, { label: string; to: string; forFulfilment?: string }[]> = {
  paid: [{ label: 'Accept order', to: 'accepted' }],
  accepted: [
    { label: 'Ready to collect', to: 'ready', forFulfilment: 'collect' },
    { label: 'Mark as posted', to: 'posted', forFulfilment: 'post' },
  ],
  ready: [{ label: 'Collected — complete', to: 'completed' }],
  posted: [{ label: 'Complete', to: 'completed' }],
  handed_over: [{ label: 'Complete', to: 'completed' }],
};

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

function OrderCard({ o, onMoved }: { o: ProductOrder; onMoved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [tracking, setTracking] = useState(o.tracking_ref ?? '');
  const actions = (NEXT[o.status] ?? []).filter((a) => !a.forFulfilment || a.forFulfilment === o.fulfilment);

  async function move(to: string) {
    setBusy(true);
    try {
      await updateOrderStatus(o.id, to, tracking);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onMoved();
    } finally { setBusy(false); }
  }

  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <View style={[styles.pill, { backgroundColor: (STATUS_COLOR[o.status] ?? '#64748b') + '22' }]}>
          <Text style={[styles.pillText, { color: STATUS_COLOR[o.status] ?? '#64748b' }]}>{STATUS_LABEL[o.status] ?? o.status}</Text>
        </View>
        <View style={[styles.pill, { borderWidth: 1, borderColor: colors.border }]}>
          <Text style={[styles.pillText, { color: colors.textSecondary, textTransform: 'capitalize' }]}>{o.fulfilment}</Text>
        </View>
        <Text style={styles.when}>{fmt(o.paid_at ?? o.created_at)}</Text>
        <Text style={styles.total}>{formatPence(o.total_pence)}</Text>
      </View>

      {(o.items ?? []).map((it, i) => (
        <Text key={i} style={styles.itemLine}>{it.qty} × {it.title}{it.variant_name ? ` (${it.variant_name})` : ''}</Text>
      ))}
      {o.shipping_pence > 0 && <Text style={styles.itemDim}>Postage — {formatPence(o.shipping_pence)}</Text>}

      {o.fulfilment === 'post' && o.delivery_address && (
        <Text style={styles.address}>📮 {o.delivery_name} · {o.delivery_address}, {o.delivery_postcode}{o.contact_phone ? ` · ${o.contact_phone}` : ''}</Text>
      )}
      {!!o.buyer_note && <Text style={styles.note}>“{o.buyer_note}”</Text>}
      {!!o.tracking_ref && <Text style={styles.itemDim}>Tracking: {o.tracking_ref}</Text>}

      {actions.length > 0 && (
        <View style={styles.actionsRow}>
          {o.status === 'accepted' && o.fulfilment === 'post' && (
            <TextInput style={styles.trackInput} value={tracking} onChangeText={setTracking}
              placeholder="Tracking ref (optional)" placeholderTextColor={colors.textMuted} />
          )}
          {actions.map((a) => (
            <TouchableOpacity key={a.to} style={[styles.actionBtn, { backgroundColor: S.color }]} onPress={() => move(a.to)} disabled={busy}>
              <Text style={styles.actionText}>{a.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

export default function BusinessOrdersScreen() {
  const router = useRouter();
  const { businessId } = useLocalSearchParams<{ businessId: string }>();
  const [orders, setOrders] = useState<ProductOrder[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!businessId) return;
    try { setOrders(await fetchBusinessOrders(businessId)); }
    finally { setLoading(false); }
  }, [businessId]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const active = orders.filter((o) => ACTIVE.includes(o.status));
  const past = orders.filter((o) => !ACTIVE.includes(o.status));

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Shop orders</Text>
        <View style={{ width: 70 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content}>
          {active.length === 0 ? (
            <View style={styles.empty}>
              <View style={[styles.emptyIcon, { backgroundColor: S.light }]}>
                <FontAwesome5 name="box-open" size={26} color={S.color} />
              </View>
              <Text style={styles.emptyTitle}>No orders on the go</Text>
              <Text style={styles.emptySub}>New orders land here the moment they're paid — you'll get a notification too.</Text>
            </View>
          ) : active.map((o) => <OrderCard key={o.id} o={o} onMoved={load} />)}

          {past.length > 0 && (
            <>
              <Text style={styles.groupHeader}>Done &amp; dusted</Text>
              {past.slice(0, 20).map((o) => <OrderCard key={o.id} o={o} onMoved={load} />)}
            </>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: 2, backgroundColor: colors.cardBackground,
  },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, width: 70 },
  backText: { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { fontSize: fontSize.lg, fontWeight: '800', color: colors.textPrimary },
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xl * 2 },
  empty: { alignItems: 'center', paddingVertical: spacing.xl * 2, gap: spacing.sm },
  emptyIcon: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: fontSize.lg, fontWeight: '800', color: colors.textPrimary },
  emptySub: { fontSize: fontSize.sm, color: colors.textSecondary, textAlign: 'center', paddingHorizontal: spacing.lg },
  groupHeader: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, marginTop: spacing.lg },
  card: {
    backgroundColor: colors.cardBackground, borderRadius: radius.lg, padding: spacing.md,
    borderWidth: 1, borderColor: colors.border, gap: 4,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flexWrap: 'wrap' },
  pill: { paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: radius.full },
  pillText: { fontSize: fontSize.xs, fontWeight: '800' },
  when: { fontSize: fontSize.xs, color: colors.textMuted },
  total: { marginLeft: 'auto', fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  itemLine: { fontSize: fontSize.sm, color: colors.textPrimary },
  itemDim: { fontSize: fontSize.xs, color: colors.textSecondary },
  address: { fontSize: fontSize.sm, color: colors.textSecondary, backgroundColor: colors.screenBackground, borderRadius: radius.md, padding: spacing.sm, marginTop: 4 },
  note: { fontSize: fontSize.sm, fontStyle: 'italic', color: colors.textSecondary },
  actionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs, alignItems: 'center' },
  trackInput: {
    flexGrow: 1, minWidth: 140, backgroundColor: colors.screenBackground, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs + 2,
    fontSize: fontSize.sm, color: colors.textPrimary,
  },
  actionBtn: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.full },
  actionText: { color: '#fff', fontWeight: '800', fontSize: fontSize.sm },
});
