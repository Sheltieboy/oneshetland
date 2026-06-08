import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { Card } from '@/components/ui/Card';
import { colors, fontSize, spacing, radius } from '@/constants/theme';

interface DisputeRow {
  id: string;
  request_id: string;
  arrived_at: string;
  collected_at: string | null;
  waiting_fee_pence: number;
  customer_confirmed: boolean | null;
  dispute_raised: boolean;
  created_at: string;
  delivery_request: {
    pickup_name: string;
    destination_address: string;
    destination_area: string | null;
    customer: { full_name: string | null } | null;
  } | null;
  driver: { full_name: string | null } | null;
}

type DisputeFilter = 'open' | 'resolved' | 'all';
const FILTERS: DisputeFilter[] = ['open', 'resolved', 'all'];

function pence(p: number): string {
  return `£${(p / 100).toFixed(2)}`;
}

function minutesBetween(a: string, b: string | null): string {
  if (!b) return '—';
  const mins = Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
  return `${mins} min`;
}

export default function AdminDisputesScreen() {
  const router = useRouter();
  const [rows, setRows] = useState<DisputeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<DisputeFilter>('open');
  const [resolving, setResolving] = useState<string | null>(null);

  const fetchDisputes = useCallback(async () => {
    let query = supabase
      .from('waiting_events')
      .select(
        `id, request_id, arrived_at, collected_at, waiting_fee_pence, customer_confirmed, dispute_raised, created_at,
         delivery_request:delivery_requests!request_id(pickup_name, destination_address, destination_area, customer:profiles(full_name)),
         driver:profiles(full_name)`,
      )
      .eq('dispute_raised', true)
      .order('created_at', { ascending: false })
      .limit(200);

    if (filter === 'open') {
      query = query.is('customer_confirmed', null);
    } else if (filter === 'resolved') {
      query = query.not('customer_confirmed', 'is', null);
    }

    const { data } = await query;
    setRows((data as unknown as DisputeRow[]) ?? []);
    setLoading(false);
    setRefreshing(false);
  }, [filter]);

  useEffect(() => {
    setLoading(true);
    fetchDisputes();
  }, [fetchDisputes]);

  async function handleResolve(id: string, confirm: boolean) {
    Alert.alert(
      confirm ? 'Confirm fee' : 'Waive fee',
      confirm
        ? 'Mark the waiting fee as confirmed and accepted by the customer?'
        : 'Dismiss this dispute and waive the waiting fee?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: confirm ? 'Confirm fee' : 'Waive fee',
          style: confirm ? 'default' : 'destructive',
          onPress: async () => {
            setResolving(id);
            const updates: Record<string, unknown> = { customer_confirmed: confirm };
            if (!confirm) updates.waiting_fee_pence = 0;
            const { error } = await supabase
              .from('waiting_events')
              .update(updates)
              .eq('id', id);
            setResolving(null);
            if (error) {
              Alert.alert('Error', error.message);
            } else {
              fetchDisputes();
            }
          },
        },
      ],
    );
  }

  const openCount = rows.filter((r) => r.customer_confirmed === null).length;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); fetchDisputes(); }}
            tintColor={colors.accent}
          />
        }
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backLink}>
            <Text style={styles.backLinkText}>‹ Back</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Disputes</Text>
          <Text style={styles.subtitle}>Waiting fee disputes raised by customers or drivers.</Text>
        </View>

        {/* Summary */}
        <View style={styles.summaryRow}>
          <View style={[styles.summaryCard, styles.summaryCardBorder]}>
            <Text style={[styles.summaryValue, openCount > 0 && styles.summaryAlert]}>
              {openCount}
            </Text>
            <Text style={styles.summaryLabel}>Open disputes</Text>
          </View>
          <View style={[styles.summaryCard, styles.summaryCardBorder]}>
            <Text style={styles.summaryValue}>
              {rows.filter((r) => r.customer_confirmed === true).length}
            </Text>
            <Text style={styles.summaryLabel}>Fee confirmed</Text>
          </View>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryValue}>
              {rows.filter((r) => r.customer_confirmed === false).length}
            </Text>
            <Text style={styles.summaryLabel}>Fee waived</Text>
          </View>
        </View>

        {/* Filters */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
        >
          {FILTERS.map((f) => (
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
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyBody}>Loading…</Text>
            </Card>
          ) : rows.length === 0 ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyIcon}>⚠️</Text>
              <Text style={styles.emptyTitle}>No disputes</Text>
              <Text style={styles.emptyBody}>
                {filter === 'open' ? 'No open disputes.' : `No ${filter} disputes.`}
              </Text>
            </Card>
          ) : (
            <>
              <Text style={styles.count}>
                {rows.length} record{rows.length !== 1 ? 's' : ''}
              </Text>
              {rows.map((row) => {
                const isOpen = row.customer_confirmed === null;
                const isConfirmed = row.customer_confirmed === true;
                const statusLabel = isOpen ? 'Open' : isConfirmed ? 'Fee confirmed' : 'Fee waived';
                const statusStyle = isOpen
                  ? styles.badgeOpen
                  : isConfirmed
                    ? styles.badgeConfirmed
                    : styles.badgeWaived;
                const statusTextStyle = isOpen
                  ? styles.badgeOpenText
                  : isConfirmed
                    ? styles.badgeConfirmedText
                    : styles.badgeWaivedText;

                return (
                  <Card key={row.id} style={styles.disputeCard}>
                    {/* Top row */}
                    <View style={styles.topRow}>
                      <View style={styles.topLeft}>
                        <Text style={styles.customerName} numberOfLines={1}>
                          {row.delivery_request?.customer?.full_name ?? 'Unknown customer'}
                        </Text>
                        <Text style={styles.driverName} numberOfLines={1}>
                          Driver: {row.driver?.full_name ?? 'Unknown'}
                        </Text>
                      </View>
                      <View style={[styles.statusBadge, statusStyle]}>
                        <Text style={[styles.statusBadgeText, statusTextStyle]}>
                          {statusLabel}
                        </Text>
                      </View>
                    </View>

                    {/* Route */}
                    {row.delivery_request && (
                      <Text style={styles.route} numberOfLines={1}>
                        {row.delivery_request.pickup_name} →{' '}
                        {row.delivery_request.destination_area
                          ? `${row.delivery_request.destination_area}, `
                          : ''}
                        {row.delivery_request.destination_address}
                      </Text>
                    )}

                    {/* Timing + fee */}
                    <View style={styles.detailRow}>
                      <View style={styles.detailItem}>
                        <Text style={styles.detailLabel}>Arrived</Text>
                        <Text style={styles.detailValue}>
                          {new Date(row.arrived_at).toLocaleTimeString('en-GB', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </Text>
                      </View>
                      <View style={styles.detailItem}>
                        <Text style={styles.detailLabel}>Collected</Text>
                        <Text style={styles.detailValue}>
                          {row.collected_at
                            ? new Date(row.collected_at).toLocaleTimeString('en-GB', {
                                hour: '2-digit',
                                minute: '2-digit',
                              })
                            : '—'}
                        </Text>
                      </View>
                      <View style={styles.detailItem}>
                        <Text style={styles.detailLabel}>Wait</Text>
                        <Text style={styles.detailValue}>
                          {minutesBetween(row.arrived_at, row.collected_at)}
                        </Text>
                      </View>
                      <View style={styles.detailItem}>
                        <Text style={[styles.detailLabel, { fontWeight: '700' }]}>Fee</Text>
                        <Text style={[styles.detailValue, styles.feeValue]}>
                          {pence(row.waiting_fee_pence)}
                        </Text>
                      </View>
                    </View>

                    <Text style={styles.date}>
                      {new Date(row.created_at).toLocaleDateString('en-GB', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </Text>

                    {/* Actions — only for open disputes */}
                    {isOpen && (
                      <View style={styles.actions}>
                        <TouchableOpacity
                          style={[styles.actionBtn, styles.actionWaive]}
                          onPress={() => handleResolve(row.id, false)}
                          disabled={resolving === row.id}
                        >
                          <Text style={styles.actionWaiveText}>Waive fee</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.actionBtn, styles.actionConfirm]}
                          onPress={() => handleResolve(row.id, true)}
                          disabled={resolving === row.id}
                        >
                          <Text style={styles.actionConfirmText}>Confirm fee</Text>
                        </TouchableOpacity>
                      </View>
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

  disputeCard: { marginBottom: spacing.sm },

  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 4,
  },
  topLeft: { flex: 1, marginRight: spacing.sm },
  customerName: { fontSize: fontSize.sm, fontWeight: '700', color: colors.navy },
  driverName: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },

  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full },
  statusBadgeText: { fontSize: fontSize.xs, fontWeight: '700' },
  badgeOpen: { backgroundColor: '#FFF7ED' },
  badgeOpenText: { color: '#92400E' },
  badgeConfirmed: { backgroundColor: '#F0FDF4' },
  badgeConfirmedText: { color: '#166534' },
  badgeWaived: { backgroundColor: '#F5F3FF' },
  badgeWaivedText: { color: '#5B21B6' },

  route: { fontSize: fontSize.sm, color: colors.textMuted, marginBottom: spacing.sm },

  detailRow: {
    flexDirection: 'row',
    backgroundColor: colors.offWhite,
    borderRadius: radius.md,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  detailItem: { flex: 1, alignItems: 'center' },
  detailLabel: { fontSize: fontSize.xs, color: colors.textMuted, marginBottom: 2 },
  detailValue: { fontSize: fontSize.sm, fontWeight: '600', color: colors.textPrimary },
  feeValue: { color: colors.navy },

  date: { fontSize: fontSize.xs, color: colors.textLight, marginBottom: spacing.sm },

  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    alignItems: 'center',
    borderWidth: 1.5,
  },
  actionWaive: { borderColor: colors.border, backgroundColor: colors.white },
  actionWaiveText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textMuted },
  actionConfirm: { borderColor: colors.navy, backgroundColor: colors.navy },
  actionConfirmText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.white },
});
