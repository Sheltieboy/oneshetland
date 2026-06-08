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
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { Card } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { colors, fontSize, spacing, radius } from '@/constants/theme';

interface PastRequest {
  id: string;
  category_slug: string;
  pickup_name: string;
  destination_area: string | null;
  destination_address: string;
  status: string;
  created_at: string;
}

const CATEGORY_ICONS: Record<string, string> = {
  takeaway: '🍕',
  pharmacy: '💊',
  parcel: '📦',
  shop: '🛍️',
  click_and_collect: '🛒',
  other: '📫',
};

export default function PreviousRequestsScreen() {
  const router = useRouter();
  const { profile } = useAuth();

  const [requests, setRequests] = useState<PastRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchRequests = useCallback(async () => {
    if (!profile?.id) return;

    const { data } = await supabase
      .from('delivery_requests')
      .select('id, category_slug, pickup_name, destination_area, destination_address, status, created_at')
      .eq('customer_id', profile.id)
      .in('status', ['delivered', 'cancelled'])
      .order('created_at', { ascending: false });

    setRequests((data as PastRequest[]) ?? []);
    setLoading(false);
    setRefreshing(false);
  }, [profile?.id]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  function onRefresh() {
    setRefreshing(true);
    fetchRequests();
  }

  // Group by month
  const grouped = requests.reduce<Record<string, PastRequest[]>>((acc, req) => {
    const date = new Date(req.created_at);
    const key = date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    if (!acc[key]) acc[key] = [];
    acc[key].push(req);
    return acc;
  }, {});

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accent}
          />
        }
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backLink}>
            <Text style={styles.backLinkText}>‹ Back</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Previous requests</Text>
          <Text style={styles.subtitle}>
            Your completed and cancelled delivery requests.
          </Text>
        </View>

        <View style={styles.body}>
          {loading ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyBody}>Loading…</Text>
            </Card>
          ) : requests.length === 0 ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyIcon}>📭</Text>
              <Text style={styles.emptyTitle}>No previous requests</Text>
              <Text style={styles.emptyBody}>
                Completed and cancelled deliveries will appear here.
              </Text>
            </Card>
          ) : (
            Object.entries(grouped).map(([month, monthRequests]) => (
              <View key={month}>
                <Text style={styles.monthLabel}>{month}</Text>
                {monthRequests.map((req) => {
                  const icon = CATEGORY_ICONS[req.category_slug] ?? '📫';
                  return (
                    <Card
                      key={req.id}
                      style={styles.requestCard}
                      onPress={() =>
                        router.push({
                          pathname: '/(customer)/request-detail',
                          params: {
                            id: req.id,
                            pickup_name: req.pickup_name,
                            destination_area: req.destination_area ?? '',
                            destination_address: req.destination_address,
                            status: req.status,
                          },
                        })
                      }
                    >
                      <View style={styles.requestRow}>
                        <View style={styles.iconCircle}>
                          <Text style={styles.iconText}>{icon}</Text>
                        </View>
                        <View style={styles.requestInfo}>
                          <Text style={styles.requestFrom} numberOfLines={1}>
                            From: {req.pickup_name}
                          </Text>
                          <Text style={styles.requestTo} numberOfLines={1}>
                            To:{' '}
                            {req.destination_area
                              ? `${req.destination_area} — `
                              : ''}
                            {req.destination_address}
                          </Text>
                          <Text style={styles.requestDate}>
                            {new Date(req.created_at).toLocaleDateString('en-GB', {
                              day: 'numeric',
                              month: 'short',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </Text>
                        </View>
                        <View style={styles.badgeCol}>
                          <StatusBadge status={`request_${req.status}`} />
                        </View>
                      </View>
                    </Card>
                  );
                })}
              </View>
            ))
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
  title: {
    color: colors.white,
    fontSize: fontSize.xxl,
    fontWeight: '800',
    marginBottom: spacing.xs,
  },
  subtitle: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.sm, lineHeight: 20 },

  body: { padding: spacing.lg },

  emptyCard: { alignItems: 'center', paddingVertical: spacing.xxl },
  emptyIcon: { fontSize: 36, marginBottom: spacing.sm },
  emptyTitle: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.navy,
    marginBottom: spacing.xs,
  },
  emptyBody: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },

  monthLabel: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },

  requestCard: { marginBottom: spacing.sm },
  requestRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: radius.full,
    backgroundColor: colors.offWhite,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  iconText: { fontSize: 20 },
  requestInfo: { flex: 1 },
  requestFrom: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.navy,
    marginBottom: 2,
  },
  requestTo: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    marginBottom: 2,
  },
  requestDate: { fontSize: fontSize.xs, color: colors.textLight },
  badgeCol: { flexShrink: 0 },
});
