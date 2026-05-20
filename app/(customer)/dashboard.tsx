import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '@/context/AuthContext';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { colors, fontSize, spacing, radius } from '@/constants/theme';

// Typed-routes workaround — payment-setup is a new file; type is generated at Expo start
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PAYMENT_SETUP_HREF = '/(customer)/payment-setup' as any;

interface AvailableRun {
  id: string;
  departure_start: string;
  departure_end: string;
  ferry_crossing: boolean;
  notes: string | null;
  categories_accepted: string[];
}

interface DeliveryRequest {
  id: string;
  category_slug: string;
  pickup_name: string;
  destination_area: string | null;
  destination_address: string;
  status: string;
  created_at: string;
}

export default function CustomerDashboard() {
  const router = useRouter();
  const { profile, signOut } = useAuth();

  const [requests, setRequests] = useState<DeliveryRequest[]>([]);
  const [loadingRequests, setLoadingRequests] = useState(true);
  const [availableRuns, setAvailableRuns] = useState<AvailableRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);

  const firstName = profile?.full_name?.split(' ')[0] ?? 'there';

  useEffect(() => {
    if (!profile?.id || !isSupabaseConfigured) {
      setLoadingRequests(false);
      return;
    }
    supabase
      .from('delivery_requests')
      .select('id, category_slug, pickup_name, destination_area, destination_address, status, created_at')
      .eq('customer_id', profile.id)
      .in('status', ['pending', 'matched', 'collected'])
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        setRequests((data as DeliveryRequest[]) ?? []);
        setLoadingRequests(false);
      });

    // Fetch open runs available today
    const now = new Date().toISOString();
    supabase
      .from('runs')
      .select('id, departure_start, departure_end, ferry_crossing, notes, categories_accepted')
      .eq('status', 'open')
      .gte('departure_end', now)
      .order('departure_start', { ascending: true })
      .then(({ data }) => {
        setAvailableRuns((data as AvailableRun[]) ?? []);
        setLoadingRuns(false);
      });
  }, [profile?.id]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.brandRow}>
            <View style={styles.logoCircle}>
              <Image source={require('../../assets/icon.png')} style={styles.logoImage} resizeMode="contain" />
            </View>
            <Text style={styles.brandName}>OneShetland Fetch</Text>
          </View>
          <View style={styles.headerBottom}>
            <Text style={styles.greeting}>Hello, {firstName} 👋</Text>
          <TouchableOpacity onPress={() => router.push('/account')} style={styles.avatarButton}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>
                  {(profile?.full_name ?? 'U')[0].toUpperCase()}
                </Text>
              </View>
            </TouchableOpacity>
          </View>
        </View>

        {/* Primary CTA */}
        <View style={styles.ctaSection}>
          <Button
            label="+ New delivery request"
            onPress={() => router.push('/(customer)/request/step-1')}
            variant="secondary"
            size="lg"
            fullWidth
            disabled={!profile?.has_payment_method}
          />
          <Text style={styles.ctaHint}>
            {profile?.has_payment_method
              ? 'Collections from Lerwick and deliveries across Shetland'
              : 'Add a payment method below to start requesting deliveries'}
          </Text>
        </View>

        {/* Payment method banner — shown until the customer sets one up */}
        {profile && !profile.has_payment_method && (
          <TouchableOpacity
            style={styles.paymentBanner}
            onPress={() => router.push(PAYMENT_SETUP_HREF)}
            activeOpacity={0.8}
          >
            <Text style={styles.paymentBannerIcon}>💳</Text>
            <View style={styles.paymentBannerBody}>
              <Text style={styles.paymentBannerTitle}>Set up payment to request deliveries</Text>
              <Text style={styles.paymentBannerSub}>Add a card so drivers can be paid — takes 30 seconds</Text>
            </View>
            <Text style={styles.paymentBannerArrow}>›</Text>
          </TouchableOpacity>
        )}

        {/* Active requests */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Active requests</Text>
          {loadingRequests ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyBody}>Loading…</Text>
            </Card>
          ) : requests.length === 0 ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyIcon}>📭</Text>
              <Text style={styles.emptyTitle}>No active requests</Text>
              <Text style={styles.emptyBody}>
                Your in-progress deliveries will appear here.
              </Text>
            </Card>
          ) : (
            requests.map((req) => (
              <Card
                key={req.id}
                style={styles.requestCard}
                onPress={() => router.push({
                  pathname: '/(customer)/request-detail',
                  params: {
                    id: req.id,
                    pickup_name: req.pickup_name,
                    destination_area: req.destination_area ?? '',
                    destination_address: req.destination_address,
                    status: req.status,
                  },
                })}
              >
                <View style={styles.requestHeader}>
                  <Text style={styles.requestFrom} numberOfLines={1}>
                    From: {req.pickup_name}
                  </Text>
                  <StatusBadge status={`request_${req.status}`} />
                </View>
                <Text style={styles.requestTo} numberOfLines={1}>
                  To: {req.destination_area ? `${req.destination_area} — ` : ''}{req.destination_address}
                </Text>
                <Text style={styles.requestDate}>
                  {new Date(req.created_at).toLocaleDateString('en-GB', {
                    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                  })} ›
                </Text>
              </Card>
            ))
          )}
        </View>

        {/* Quick links */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>My account</Text>
          <View style={styles.quickLinks}>
            <Card
              style={styles.quickLink}
              onPress={() => router.push('/(customer)/saved-addresses')}
            >
              <Text style={styles.quickLinkIcon}>📍</Text>
              <Text style={styles.quickLinkLabel}>Saved addresses</Text>
              <Text style={styles.quickLinkArrow}>›</Text>
            </Card>
            <Card
              style={styles.quickLink}
              onPress={() => router.push('/(customer)/previous-requests')}
            >
              <Text style={styles.quickLinkIcon}>📋</Text>
              <Text style={styles.quickLinkLabel}>Previous requests</Text>
              <Text style={styles.quickLinkArrow}>›</Text>
            </Card>
            <Card
              style={styles.quickLink}
              onPress={() => router.push('/account')}
            >
              <Text style={styles.quickLinkIcon}>👤</Text>
              <Text style={styles.quickLinkLabel}>Account settings</Text>
              <Text style={styles.quickLinkArrow}>›</Text>
            </Card>
            <Card
              style={styles.quickLink}
              onPress={() => router.push(PAYMENT_SETUP_HREF)}
            >
              <Text style={styles.quickLinkIcon}>💳</Text>
              <Text style={styles.quickLinkLabel}>
                {profile?.has_payment_method ? 'Update payment method' : 'Set up payment'}
              </Text>
              <Text style={styles.quickLinkArrow}>›</Text>
            </Card>
            {profile?.role !== 'driver' && (
              <Card
                style={[styles.quickLink, styles.quickLinkDriver]}
                onPress={() => router.push('/(customer)/apply-driver')}
              >
                <Text style={styles.quickLinkIcon}>🚗</Text>
                <Text style={[styles.quickLinkLabel, styles.quickLinkDriverLabel]}>
                  Apply to become a driver
                </Text>
                <Text style={styles.quickLinkArrow}>›</Text>
              </Card>
            )}
          </View>
        </View>

        {/* Available runs */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Runs available today</Text>
          <Text style={styles.sectionSub}>
            Browse runs, then start a delivery request to be matched.
          </Text>
          {loadingRuns ? (
            <Card style={styles.runsPlaceholder}>
              <Text style={styles.runsPlaceholderText}>Loading runs…</Text>
            </Card>
          ) : availableRuns.length === 0 ? (
            <Card style={styles.runsPlaceholder}>
              <Text style={styles.runsPlaceholderText}>
                ⛵ No runs available right now — check back soon.
              </Text>
            </Card>
          ) : (
            availableRuns.map((run) => {
              const start = new Date(run.departure_start);
              const end = new Date(run.departure_end);
              const today = new Date();
              const isToday = start.toDateString() === today.toDateString();
              const dayLabel = isToday ? 'Today' : start.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
              const timeRange = `${start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} – ${end.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
              const noteLines = (run.notes ?? '').split('\n');
              const originLine = noteLines.find((l) => l.startsWith('Origin:'))?.replace('Origin: ', '') ?? 'Lerwick';
              const destLine = noteLines.find((l) => l.startsWith('Destination:'))?.replace('Destination: ', '') ?? '—';

              return (
                <Card key={run.id} style={styles.runCard}>
                  <View style={styles.runHeader}>
                    <Text style={styles.runRoute}>{originLine} → {destLine}</Text>
                    {run.ferry_crossing && (
                      <View style={styles.ferryBadge}>
                        <Text style={styles.ferryText}>⛴ Ferry</Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.runTime}>{dayLabel}, {timeRange}</Text>
                  {run.categories_accepted?.length > 0 && (
                    <View style={styles.runCategoryRow}>
                      {run.categories_accepted.slice(0, 3).map((c) => (
                        <View key={c} style={styles.runCategoryChip}>
                          <Text style={styles.runCategoryText}>{c}</Text>
                        </View>
                      ))}
                      {run.categories_accepted.length > 3 && (
                        <Text style={styles.runCategoryMore}>+{run.categories_accepted.length - 3} more</Text>
                      )}
                    </View>
                  )}
                </Card>
              );
            })
          )}
        </View>

        <View style={styles.signOutRow}>
          {profile?.role === 'driver' && (
            <Button
              label="Switch to driver view"
              onPress={() => router.push('/(driver)/dashboard')}
              variant="ghost"
              size="sm"
            />
          )}
          <Button
            label="Sign out"
            onPress={signOut}
            variant="ghost"
            size="sm"
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  scroll: { flex: 1, backgroundColor: colors.screenBackground },
  content: { paddingBottom: spacing.xxl },

  header: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  logoCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 2,
  },
  logoImage: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  brandName: {
    color: colors.white,
    fontSize: fontSize.sm,
    fontWeight: '700',
    opacity: 0.9,
  },
  headerBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  greeting: {
    color: colors.white,
    fontSize: fontSize.xl,
    fontWeight: '700',
  },
  avatarButton: {},
  avatar: {
    width: 40,
    height: 40,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: colors.white,
    fontWeight: '700',
    fontSize: fontSize.md,
  },

  ctaSection: {
    padding: spacing.lg,
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  ctaHint: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.sm,
  },

  section: {
    padding: spacing.lg,
  },
  sectionTitle: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.navy,
    marginBottom: spacing.sm,
  },
  sectionSub: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    marginBottom: spacing.md,
  },

  emptyCard: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
  },
  emptyIcon: { fontSize: 36, marginBottom: spacing.sm },
  emptyTitle: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.navy,
    marginBottom: spacing.xs,
  },
  emptyBody: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    textAlign: 'center',
  },

  quickLinkDriver: {
    borderColor: colors.accent,
    backgroundColor: '#F0FBFF',
  },
  quickLinkDriverLabel: {
    color: colors.accent,
    fontWeight: '600',
  },
  requestCard: { marginBottom: spacing.sm },
  requestHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  requestFrom: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.navy,
    flex: 1,
    marginRight: spacing.sm,
  },
  requestTo: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    marginBottom: 4,
  },
  requestDate: {
    fontSize: fontSize.xs,
    color: colors.textLight,
  },

  quickLinks: { gap: spacing.sm },
  quickLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  quickLinkIcon: { fontSize: 20, width: 28 },
  quickLinkLabel: {
    flex: 1,
    fontSize: fontSize.md,
    color: colors.textPrimary,
    fontWeight: '500',
  },
  quickLinkArrow: {
    fontSize: fontSize.xl,
    color: colors.textLight,
  },

  runsPlaceholder: { padding: spacing.md },
  runsPlaceholderText: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    textAlign: 'center',
  },

  runCard: { marginBottom: spacing.sm },
  runHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  runRoute: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.navy,
    flex: 1,
  },
  runTime: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  ferryBadge: {
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  ferryText: { fontSize: fontSize.xs, color: '#1D4ED8', fontWeight: '600' },
  runCategoryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  runCategoryChip: {
    backgroundColor: colors.offWhite,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  runCategoryText: { fontSize: fontSize.xs, color: colors.textMuted },
  runCategoryMore: { fontSize: fontSize.xs, color: colors.textLight, alignSelf: 'center' },

  signOutRow: {
    alignItems: 'center',
    paddingBottom: spacing.lg,
  },

  paymentBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFF7ED',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#FED7AA',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  paymentBannerIcon: { fontSize: 24 },
  paymentBannerBody: { flex: 1 },
  paymentBannerTitle: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: '#92400E',
    marginBottom: 2,
  },
  paymentBannerSub: {
    fontSize: fontSize.xs,
    color: '#B45309',
    lineHeight: 16,
  },
  paymentBannerArrow: {
    fontSize: fontSize.xl,
    color: '#B45309',
  },
});
