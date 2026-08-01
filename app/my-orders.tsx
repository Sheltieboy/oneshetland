/**
 * app/my-orders.tsx — the buyer's Shop Shetland orders (mirrors web /account/orders).
 */

import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { fetchMyOrders, BUYER_STATUS_LABEL, type ProductOrder } from '@/lib/products-api';
import { formatPence } from '@/lib/local-api';

const S = SECTIONS.local;

const STATUS_COLOR: Record<string, string> = {
  paid: '#d97706', accepted: '#0284c7', ready: '#059669', posted: '#059669',
  handed_over: '#059669', completed: '#64748b', cancelled: '#e11d48', refunded: '#e11d48',
};

export default function MyOrdersScreen() {
  const router = useRouter();
  const [orders, setOrders] = useState<ProductOrder[]>([]);
  const [loading, setLoading] = useState(true);

  useFocusEffect(useCallback(() => {
    fetchMyOrders().then(setOrders).finally(() => setLoading(false));
  }, []));

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Your orders</Text>
        <View style={{ width: 70 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      ) : orders.length === 0 ? (
        <View style={[styles.center, { padding: spacing.xl, gap: spacing.xs }]}>
          <View style={[styles.emptyIcon, { backgroundColor: S.light }]}>
            <FontAwesome5 name="shopping-bag" size={26} color={S.color} />
          </View>
          <Text style={styles.emptyTitle}>No orders yet</Text>
          <Text style={styles.emptySub}>When you buy from a Shetland shop it'll show up here.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {orders.map((o) => (
            <View key={o.id} style={styles.card}>
              <View style={styles.cardTop}>
                <View style={[styles.pill, { backgroundColor: (STATUS_COLOR[o.status] ?? '#64748b') + '22' }]}>
                  <Text style={[styles.pillText, { color: STATUS_COLOR[o.status] ?? '#64748b' }]}>
                    {BUYER_STATUS_LABEL[o.status] ?? o.status}
                  </Text>
                </View>
                <Text style={styles.when}>
                  {new Date(o.paid_at ?? o.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                </Text>
                <Text style={styles.total}>{formatPence(o.total_pence)}</Text>
              </View>
              <Text style={styles.items} numberOfLines={2}>
                {(o.items ?? []).map((it) => `${it.qty} × ${it.title}${it.variant_name ? ` (${it.variant_name})` : ''}`).join(' · ')}
              </Text>
              {o.status === 'posted' && !!o.tracking_ref && (
                <Text style={styles.tracking}>Tracking: {o.tracking_ref}</Text>
              )}
            </View>
          ))}
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
  emptyIcon: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: fontSize.lg, fontWeight: '800', color: colors.textPrimary },
  emptySub: { fontSize: fontSize.sm, color: colors.textSecondary, textAlign: 'center' },
  card: {
    backgroundColor: colors.cardBackground, borderRadius: radius.lg, padding: spacing.md,
    borderWidth: 1, borderColor: colors.border, gap: 4,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  pill: { paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: radius.full },
  pillText: { fontSize: fontSize.xs, fontWeight: '800' },
  when: { fontSize: fontSize.xs, color: colors.textMuted },
  total: { marginLeft: 'auto', fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  items: { fontSize: fontSize.sm, color: colors.textSecondary },
  tracking: { fontSize: fontSize.xs, color: colors.textMuted },
});
