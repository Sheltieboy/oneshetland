import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { Card } from '@/components/ui/Card';
import { colors, fontSize, spacing, radius } from '@/constants/theme';

interface PaymentRow {
  id: string;
  customer_id: string;
  pickup_name: string;
  destination_address: string;
  destination_area: string | null;
  payment_status: string;
  base_fee_pence: number | null;
  waiting_fee_pence: number;
  total_fee_pence: number | null;
  payment_intent_id: string | null;
  created_at: string;
  customer_name: string;
}

const PAYMENT_FILTERS = ['all', 'captured', 'authorised', 'unpaid', 'refunded', 'failed'] as const;
type PaymentFilter = typeof PAYMENT_FILTERS[number];

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  captured:   { bg: '#F0FDF4', text: '#166534' },
  authorised: { bg: '#EFF6FF', text: '#1D4ED8' },
  unpaid:     { bg: '#FFF7ED', text: '#92400E' },
  refunded:   { bg: '#F5F3FF', text: '#5B21B6' },
  failed:     { bg: '#FFF1F2', text: '#9F1239' },
};

function pence(p: number | null): string {
  if (p == null) return '—';
  return `£${(p / 100).toFixed(2)}`;
}

export default function AdminPaymentsScreen() {
  const router = useRouter();
  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<PaymentFilter>('all');

  const fetchPayments = useCallback(async () => {
    let query = supabase
      .from('delivery_requests')
      .select(
        'id, customer_id, pickup_name, destination_address, destination_area, payment_status, base_fee_pence, waiting_fee_pence, total_fee_pence, payment_intent_id, created_at',
      )
      .order('created_at', { ascending: false })
      .limit(200);

    if (filter !== 'all') {
      query = query.eq('payment_status', filter);
    }

    const { data } = await query;
    const rows = (data as any[]) ?? [];

    // Fetch customer names separately
    const customerIds = [...new Set(rows.map((r) => r.customer_id).filter(Boolean))];
    let namesMap: Record<string, string> = {};
    if (customerIds.length > 0) {
      const { data: profileData } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', customerIds);
      (profileData ?? []).forEach((p: { id: string; full_name: string | null }) => {
        if (p.full_name) namesMap[p.id] = p.full_name;
      });
    }

    setRows(rows.map((r) => ({ ...r, customer_name: namesMap[r.customer_id] ?? 'Unknown' })));
    setLoading(false);
    setRefreshing(false);
  }, [filter]);

  useEffect(() => {
    setLoading(true);
    fetchPayments();
  }, [fetchPayments]);

  // Summary totals
  const captured = rows.filter((r) => r.payment_status === 'captured');
  const totalRevenue = captured.reduce((s, r) => s + (r.total_fee_pence ?? 0), 0);
  const pendingAuth = rows.filter((r) => r.payment_status === 'authorised').length;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchPayments(); }} tintColor={colors.accent} />
        }
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backLink}>
            <Text style={styles.backLinkText}>‹ Back</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Payments</Text>
          <Text style={styles.subtitle}>Delivery fees and Stripe transaction status.</Text>
        </View>

        {/* Summary */}
        <View style={styles.summaryRow}>
          <View style={[styles.summaryCard, styles.summaryCardBorder]}>
            <Text style={styles.summaryValue}>{pence(totalRevenue)}</Text>
            <Text style={styles.summaryLabel}>Total captured</Text>
          </View>
          <View style={[styles.summaryCard, styles.summaryCardBorder]}>
            <Text style={[styles.summaryValue, pendingAuth > 0 && styles.summaryAlert]}>
              {pendingAuth}
            </Text>
            <Text style={styles.summaryLabel}>Pending capture</Text>
          </View>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryValue}>{captured.length}</Text>
            <Text style={styles.summaryLabel}>Completed</Text>
          </View>
        </View>

        {/* Filters */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
          {PAYMENT_FILTERS.map((f) => (
            <TouchableOpacity
              key={f}
              style={[styles.filterChip, filter === f && styles.filterChipActive]}
              onPress={() => setFilter(f)}
            >
              <Text style={[styles.filterChipText, filter === f && styles.filterChipTextActive]}>
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <View style={styles.body}>
          {loading ? (
            <Card style={styles.emptyCard}><Text style={styles.emptyBody}>Loading…</Text></Card>
          ) : rows.length === 0 ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyIcon}>💳</Text>
              <Text style={styles.emptyTitle}>No payments</Text>
              <Text style={styles.emptyBody}>{filter === 'all' ? 'No payment records yet.' : `No ${filter} payments.`}</Text>
            </Card>
          ) : (
            <>
              <Text style={styles.count}>{rows.length} record{rows.length !== 1 ? 's' : ''}</Text>
              {rows.map((row) => {
                const cfg = STATUS_COLORS[row.payment_status] ?? STATUS_COLORS.unpaid;
                return (
                  <Card key={row.id} style={styles.payCard}>
                    <View style={styles.payTopRow}>
                      <Text style={styles.payCustomer} numberOfLines={1}>
                        {row.customer_name}
                      </Text>
                      <View style={[styles.statusBadge, { backgroundColor: cfg.bg }]}>
                        <Text style={[styles.statusBadgeText, { color: cfg.text }]}>
                          {row.payment_status}
                        </Text>
                      </View>
                    </View>

                    <Text style={styles.payRoute} numberOfLines={1}>
                      {row.pickup_name} → {row.destination_area ? `${row.destination_area}, ` : ''}{row.destination_address}
                    </Text>

                    <View style={styles.feeRow}>
                      <View style={styles.feeItem}>
                        <Text style={styles.feeLabel}>Base</Text>
                        <Text style={styles.feeValue}>{pence(row.base_fee_pence)}</Text>
                      </View>
                      <View style={styles.feeItem}>
                        <Text style={styles.feeLabel}>Waiting</Text>
                        <Text style={styles.feeValue}>{pence(row.waiting_fee_pence)}</Text>
                      </View>
                      <View style={styles.feeItem}>
                        <Text style={[styles.feeLabel, { fontWeight: '700' }]}>Total</Text>
                        <Text style={[styles.feeValue, styles.feeTotal]}>{pence(row.total_fee_pence)}</Text>
                      </View>
                    </View>

                    <Text style={styles.payDate}>
                      {new Date(row.created_at).toLocaleDateString('en-GB', {
                        day: 'numeric', month: 'short', year: 'numeric',
                        hour: '2-digit', minute: '2-digit',
                      })}
                    </Text>

                    {row.payment_intent_id && (
                      <Text style={styles.payIntentId} numberOfLines={1}>
                        {row.payment_intent_id}
                      </Text>
                    )}
                  </Card>
                );
              })}
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  content: { backgroundColor: colors.screenBackground, paddingBottom: spacing.xxl, flexGrow: 1 },

  header: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
  },
  backLink: { marginBottom: spacing.md },
  backLinkText: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.sm },
  title: { color: colors.white, fontSize: fontSize.xxl, fontWeight: '800', marginBottom: spacing.xs },
  subtitle: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.sm, lineHeight: 20 },

  summaryRow: {
    flexDirection: 'row',
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  summaryCard: { flex: 1, alignItems: 'center', paddingVertical: spacing.lg },
  summaryCardBorder: { borderRightWidth: 1, borderRightColor: colors.border },
  summaryValue: { fontSize: fontSize.xl, fontWeight: '800', color: colors.navy, marginBottom: 4 },
  summaryAlert: { color: colors.accent },
  summaryLabel: { fontSize: fontSize.xs, color: colors.textMuted, textAlign: 'center' },

  filterRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.full,
    backgroundColor: colors.offWhite,
    borderWidth: 1,
    borderColor: colors.border,
  },
  filterChipActive: { backgroundColor: colors.navy, borderColor: colors.navy },
  filterChipText: { fontSize: fontSize.sm, fontWeight: '600', color: colors.textMuted },
  filterChipTextActive: { color: colors.white },

  body: { padding: spacing.lg },
  count: { fontSize: fontSize.sm, fontWeight: '600', color: colors.textMuted, marginBottom: spacing.md },

  emptyCard: { alignItems: 'center', paddingVertical: spacing.xxl },
  emptyIcon: { fontSize: 36, marginBottom: spacing.sm },
  emptyTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.navy, marginBottom: spacing.xs },
  emptyBody: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },

  payCard: { marginBottom: spacing.sm },
  payTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  payCustomer: { fontSize: fontSize.sm, fontWeight: '700', color: colors.navy, flex: 1, marginRight: spacing.sm },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full },
  statusBadgeText: { fontSize: fontSize.xs, fontWeight: '700' },
  payRoute: { fontSize: fontSize.sm, color: colors.textMuted, marginBottom: spacing.sm },

  feeRow: {
    flexDirection: 'row',
    backgroundColor: colors.offWhite,
    borderRadius: radius.md,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  feeItem: { flex: 1, alignItems: 'center' },
  feeLabel: { fontSize: fontSize.xs, color: colors.textMuted, marginBottom: 2 },
  feeValue: { fontSize: fontSize.sm, fontWeight: '600', color: colors.textPrimary },
  feeTotal: { color: colors.navy },

  payDate: { fontSize: fontSize.xs, color: colors.textLight },
  payIntentId: { fontSize: 10, color: colors.textLight, fontFamily: 'monospace', marginTop: 2 },
});
