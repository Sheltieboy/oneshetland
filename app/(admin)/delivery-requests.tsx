import React, { useEffect, useState, useCallback } from 'react';
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
import { StatusBadge } from '@/components/ui/StatusBadge';
import { colors, fontSize, spacing, radius } from '@/constants/theme';

interface DeliveryRequest {
  id: string;
  category_slug: string;
  pickup_name: string;
  destination_area: string | null;
  destination_address: string;
  status: string;
  created_at: string;
  customer: { full_name: string } | null;
}

const STATUS_FILTERS = ['all', 'pending', 'matched', 'collected', 'delivered', 'cancelled'] as const;
type StatusFilter = typeof STATUS_FILTERS[number];

const CATEGORY_ICONS: Record<string, string> = {
  takeaway: '🍕',
  pharmacy: '💊',
  parcel: '📦',
  shop: '🛍️',
  click_and_collect: '🛒',
  other: '📫',
};

export default function AdminDeliveryRequestsScreen() {
  const router = useRouter();
  const [requests, setRequests] = useState<DeliveryRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>('all');

  const fetchRequests = useCallback(async () => {
    let query = supabase
      .from('delivery_requests')
      .select('id, category_slug, pickup_name, destination_area, destination_address, status, created_at, customer:profiles!customer_id(full_name)')
      .order('created_at', { ascending: false })
      .limit(100);

    if (filter !== 'all') {
      query = query.eq('status', filter);
    }

    const { data } = await query;
    setRequests((data as DeliveryRequest[]) ?? []);
    setLoading(false);
    setRefreshing(false);
  }, [filter]);

  useEffect(() => {
    setLoading(true);
    fetchRequests();
  }, [fetchRequests]);

  function onRefresh() {
    setRefreshing(true);
    fetchRequests();
  }

  const counts = requests.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
        }
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backLink}>
            <Text style={styles.backLinkText}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Delivery requests</Text>
          <Text style={styles.subtitle}>All customer delivery requests.</Text>
        </View>

        {/* Filter tabs */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
        >
          {STATUS_FILTERS.map((s) => (
            <TouchableOpacity
              key={s}
              style={[styles.filterChip, filter === s && styles.filterChipActive]}
              onPress={() => setFilter(s)}
            >
              <Text style={[styles.filterChipText, filter === s && styles.filterChipTextActive]}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
                {s !== 'all' && counts[s] ? ` (${counts[s]})` : ''}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <View style={styles.body}>
          {loading ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyBody}>Loading…</Text>
            </Card>
          ) : requests.length === 0 ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyIcon}>📭</Text>
              <Text style={styles.emptyTitle}>No requests</Text>
              <Text style={styles.emptyBody}>
                {filter === 'all' ? 'No delivery requests yet.' : `No ${filter} requests.`}
              </Text>
            </Card>
          ) : (
            <>
              <Text style={styles.count}>
                {requests.length} request{requests.length !== 1 ? 's' : ''}
              </Text>
              {requests.map((req) => {
                const icon = CATEGORY_ICONS[req.category_slug] ?? '📫';
                return (
                  <Card key={req.id} style={styles.requestCard}>
                    <View style={styles.requestRow}>
                      <View style={styles.iconCircle}>
                        <Text style={styles.iconText}>{icon}</Text>
                      </View>
                      <View style={styles.requestInfo}>
                        <View style={styles.requestTopRow}>
                          <Text style={styles.customerName} numberOfLines={1}>
                            {req.customer?.full_name ?? 'Unknown customer'}
                          </Text>
                          <StatusBadge status={`request_${req.status}`} />
                        </View>
                        <Text style={styles.requestFrom} numberOfLines={1}>
                          From: {req.pickup_name}
                        </Text>
                        <Text style={styles.requestTo} numberOfLines={1}>
                          To:{' '}
                          {req.destination_area ? `${req.destination_area} — ` : ''}
                          {req.destination_address}
                        </Text>
                        <Text style={styles.requestDate}>
                          {new Date(req.created_at).toLocaleDateString('en-GB', {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </Text>
                      </View>
                    </View>
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
  filterChipActive: {
    backgroundColor: colors.navy,
    borderColor: colors.navy,
  },
  filterChipText: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.textMuted,
  },
  filterChipTextActive: {
    color: colors.white,
  },

  body: { padding: spacing.lg },
  count: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.textMuted,
    marginBottom: spacing.md,
  },

  emptyCard: { alignItems: 'center', paddingVertical: spacing.xxl },
  emptyIcon: { fontSize: 36, marginBottom: spacing.sm },
  emptyTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.navy, marginBottom: spacing.xs },
  emptyBody: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },

  requestCard: { marginBottom: spacing.sm },
  requestRow: { flexDirection: 'row', gap: spacing.md },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: radius.full,
    backgroundColor: colors.offWhite,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginTop: 2,
  },
  iconText: { fontSize: 20 },
  requestInfo: { flex: 1 },
  requestTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
    gap: spacing.sm,
  },
  customerName: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.navy,
    flex: 1,
  },
  requestFrom: { fontSize: fontSize.sm, color: colors.textPrimary, marginBottom: 2 },
  requestTo: { fontSize: fontSize.sm, color: colors.textMuted, marginBottom: 4 },
  requestDate: { fontSize: fontSize.xs, color: colors.textLight },
});
