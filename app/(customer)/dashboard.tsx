import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  StyleSheet,
  Pressable,
  Animated,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '@/context/AuthContext';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonCard } from '@/components/ui/Skeleton';
import { colors, fontSize, spacing, radius, shadow, fontWeight } from '@/constants/theme';
import { haptic } from '@/lib/haptics';

// Typed-routes workaround
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

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Waiting for driver',
  matched: 'Driver on the way',
  collected: 'Out for delivery',
};

export default function CustomerDashboard() {
  const router = useRouter();
  const { profile, signOut } = useAuth();

  const [requests, setRequests] = useState<DeliveryRequest[]>([]);
  const [loadingRequests, setLoadingRequests] = useState(true);
  const [availableRuns, setAvailableRuns] = useState<AvailableRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const firstName = profile?.full_name?.split(' ')[0] ?? 'there';

  // Entrance animation
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(16)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 500, useNativeDriver: true }),
      Animated.spring(slideAnim, { toValue: 0, speed: 14, bounciness: 4, useNativeDriver: true }),
    ]).start();
  }, []);

  const fetchData = useCallback(async () => {
    if (!profile?.id || !isSupabaseConfigured) {
      setLoadingRequests(false);
      setLoadingRuns(false);
      return;
    }
    const now = new Date().toISOString();
    const [reqRes, runsRes] = await Promise.all([
      supabase
        .from('delivery_requests')
        .select('id, category_slug, pickup_name, destination_area, destination_address, status, created_at')
        .eq('customer_id', profile.id)
        .in('status', ['pending', 'matched', 'collected'])
        .order('created_at', { ascending: false }),
      supabase
        .from('runs')
        .select('id, departure_start, departure_end, ferry_crossing, notes, categories_accepted')
        .eq('status', 'open')
        .gte('departure_end', now)
        .order('departure_start', { ascending: true }),
    ]);
    setRequests((reqRes.data as DeliveryRequest[]) ?? []);
    setAvailableRuns((runsRes.data as AvailableRun[]) ?? []);
    setLoadingRequests(false);
    setLoadingRuns(false);
  }, [profile?.id]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  }, [fetchData]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        style={styles.scroll}
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
        {/* ── Hero header ── */}
        <View style={styles.header}>
          <View style={styles.headerTop}>
            <View style={styles.brandRow}>
              <View style={styles.logoCircle}>
                <Image
                  source={require('../../assets/icon.png')}
                  style={styles.logoImage}
                  resizeMode="contain"
                />
              </View>
              <Text style={styles.brandName}>OneShetland Fetch</Text>
            </View>
            <Pressable
              onPress={() => { haptic.light(); router.push('/account'); }}
              hitSlop={12}
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>
                  {(profile?.full_name ?? 'U')[0].toUpperCase()}
                </Text>
              </View>
            </Pressable>
          </View>

          <Animated.View style={{ opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}>
            <Text style={styles.greeting}>{getGreeting()},</Text>
            <Text style={styles.greetingName}>{firstName} 👋</Text>
          </Animated.View>
        </View>

        {/* ── Payment method banner ── */}
        {profile && !profile.has_payment_method && (
          <Pressable
            style={({ pressed }) => [styles.paymentBanner, pressed && styles.paymentBannerPressed]}
            onPress={() => { haptic.medium(); router.push(PAYMENT_SETUP_HREF); }}
          >
            <View style={styles.paymentBannerIcon}>
              <Text style={styles.paymentBannerEmoji}>💳</Text>
            </View>
            <View style={styles.paymentBannerBody}>
              <Text style={styles.paymentBannerTitle}>Set up payment to get started</Text>
              <Text style={styles.paymentBannerSub}>Add a card — takes 30 seconds</Text>
            </View>
            <Text style={styles.paymentBannerArrow}>›</Text>
          </Pressable>
        )}

        {/* ── Primary CTA ── */}
        <View style={styles.ctaSection}>
          <Button
            label="+ New delivery request"
            onPress={() => router.push('/(customer)/request/step-1')}
            variant="secondary"
            size="lg"
            fullWidth
            disabled={!profile?.has_payment_method}
          />
          {profile?.has_payment_method ? (
            <View style={styles.ctaStatsRow}>
              <View style={styles.ctaStat}>
                <Text style={styles.ctaStatValue}>~2 min</Text>
                <Text style={styles.ctaStatLabel}>to book</Text>
              </View>
              <View style={styles.ctaStatDivider} />
              <View style={styles.ctaStat}>
                <Text style={styles.ctaStatValue}>Local</Text>
                <Text style={styles.ctaStatLabel}>drivers</Text>
              </View>
              <View style={styles.ctaStatDivider} />
              <View style={styles.ctaStat}>
                <Text style={styles.ctaStatValue}>Free</Text>
                <Text style={styles.ctaStatLabel}>to sign up</Text>
              </View>
            </View>
          ) : (
            <Text style={styles.ctaHint}>Add a payment method above to start requesting deliveries</Text>
          )}
        </View>

        {/* ── Active requests ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Active requests</Text>
          {loadingRequests ? (
            <>
              <SkeletonCard />
              <SkeletonCard />
            </>
          ) : requests.length === 0 ? (
            <Card padded={false}>
              <EmptyState
                icon="📭"
                title="No active requests"
                body="Your in-progress deliveries will appear here."
              />
            </Card>
          ) : (
            requests.map((req) => (
              <Pressable
                key={req.id}
                onPress={() => {
                  haptic.light();
                  router.push({
                    pathname: '/(customer)/request-detail',
                    params: {
                      id: req.id,
                      pickup_name: req.pickup_name,
                      destination_area: req.destination_area ?? '',
                      destination_address: req.destination_address,
                      status: req.status,
                    },
                  });
                }}
                style={({ pressed }) => [styles.requestCard, pressed && styles.requestCardPressed]}
              >
                <View style={[styles.requestAccent, styles[`accent_${req.status}` as keyof typeof styles] as object]} />
                <View style={styles.requestBody}>
                  <View style={styles.requestTopRow}>
                    <Text style={styles.requestFrom} numberOfLines={1}>{req.pickup_name}</Text>
                    <StatusBadge status={`request_${req.status}`} />
                  </View>
                  <Text style={styles.requestTo} numberOfLines={1}>
                    → {req.destination_area ? `${req.destination_area} · ` : ''}{req.destination_address}
                  </Text>
                  <View style={styles.requestFooter}>
                    <Text style={styles.requestStatusLabel}>
                      {STATUS_LABEL[req.status] ?? req.status}
                    </Text>
                    <Text style={styles.requestDate}>
                      {new Date(req.created_at).toLocaleDateString('en-GB', {
                        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                      })}
                    </Text>
                  </View>
                </View>
              </Pressable>
            ))
          )}
        </View>

        {/* ── Available runs ── */}
        <View style={styles.section}>
          <View style={styles.sectionRow}>
            <Text style={styles.sectionTitle}>Runs today</Text>
            {availableRuns.length > 0 && (
              <View style={styles.runCountBadge}>
                <Text style={styles.runCountText}>{availableRuns.length}</Text>
              </View>
            )}
          </View>
          <Text style={styles.sectionSub}>Browse runs, then start a delivery request to be matched.</Text>

          {loadingRuns ? (
            <>
              <SkeletonCard />
              <SkeletonCard />
            </>
          ) : availableRuns.length === 0 ? (
            <Card padded={false}>
              <EmptyState
                icon="⛵"
                title="No runs right now"
                body="Check back soon — drivers post new runs daily."
              />
            </Card>
          ) : (
            availableRuns.map((run) => {
              const start = new Date(run.departure_start);
              const end = new Date(run.departure_end);
              const today = new Date();
              const isToday = start.toDateString() === today.toDateString();
              const dayLabel = isToday
                ? 'Today'
                : start.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
              const timeRange = `${start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} – ${end.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
              const noteLines = (run.notes ?? '').split('\n');
              const originLine = noteLines.find((l) => l.startsWith('Origin:'))?.replace('Origin: ', '') ?? 'Lerwick';
              const destLine = noteLines.find((l) => l.startsWith('Destination:'))?.replace('Destination: ', '') ?? '—';

              return (
                <Card key={run.id} style={styles.runCard}>
                  <View style={styles.runHeader}>
                    <View style={styles.runRouteContainer}>
                      <Text style={styles.runOrigin}>{originLine}</Text>
                      <Text style={styles.runArrow}> → </Text>
                      <Text style={styles.runDest}>{destLine}</Text>
                    </View>
                    {run.ferry_crossing && (
                      <View style={styles.ferryBadge}>
                        <Text style={styles.ferryText}>⛴ Ferry</Text>
                      </View>
                    )}
                  </View>
                  <View style={styles.runTimeRow}>
                    <Text style={styles.runDay}>{dayLabel}</Text>
                    <Text style={styles.runTimeSep}> · </Text>
                    <Text style={styles.runTime}>{timeRange}</Text>
                  </View>
                  {run.categories_accepted?.length > 0 && (
                    <View style={styles.runCategoryRow}>
                      {run.categories_accepted.slice(0, 4).map((c) => (
                        <View key={c} style={styles.runCategoryChip}>
                          <Text style={styles.runCategoryText}>{c}</Text>
                        </View>
                      ))}
                      {run.categories_accepted.length > 4 && (
                        <Text style={styles.runCategoryMore}>+{run.categories_accepted.length - 4}</Text>
                      )}
                    </View>
                  )}
                </Card>
              );
            })
          )}
        </View>

        {/* ── My account quick links ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>My account</Text>
          <View style={styles.quickLinks}>
            {QUICK_LINKS.map(({ icon, label, route }) => (
              <Card
                key={label}
                style={styles.quickLink}
                onPress={() => router.push(route as any)}
              >
                <Text style={styles.quickLinkIcon}>{icon}</Text>
                <Text style={styles.quickLinkLabel}>{label}</Text>
                <Text style={styles.quickLinkArrow}>›</Text>
              </Card>
            ))}
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
                <Text style={[styles.quickLinkArrow, { color: colors.accent }]}>›</Text>
              </Card>
            )}
          </View>
        </View>

        {/* ── Footer actions ── */}
        <View style={styles.footer}>
          {profile?.role === 'driver' && (
            <Button
              label="Switch to driver view"
              onPress={() => router.push('/(driver)/dashboard')}
              variant="outline"
              size="sm"
              style={{ marginBottom: spacing.sm }}
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

const QUICK_LINKS = [
  { icon: '📍', label: 'Saved addresses', route: '/(customer)/saved-addresses' },
  { icon: '📋', label: 'Previous requests', route: '/(customer)/previous-requests' },
  { icon: '👤', label: 'Account settings', route: '/account' },
];

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  scroll: { flex: 1, backgroundColor: colors.screenBackground },
  content: { paddingBottom: spacing.xxl },

  // ── Header ──
  header: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
  },
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  logoCircle: {
    width: 32,
    height: 32,
    borderRadius: radius.full,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 2,
  },
  logoImage: { width: 28, height: 28, borderRadius: 14 },
  brandName: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: fontSize.sm,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.accent,
  },
  avatarText: {
    color: colors.white,
    fontWeight: '700',
    fontSize: fontSize.md,
  },
  greeting: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: fontSize.md,
    fontWeight: '400',
  },
  greetingName: {
    color: colors.white,
    fontSize: fontSize.xxl,
    fontWeight: '800',
    letterSpacing: -0.5,
    marginTop: 2,
  },

  // ── Payment banner ──
  paymentBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFBEB',
    borderBottomWidth: 1,
    borderBottomColor: '#FDE68A',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  paymentBannerPressed: { opacity: 0.85 },
  paymentBannerIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: '#FEF3C7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  paymentBannerEmoji: { fontSize: 22 },
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
    color: '#D97706',
    fontWeight: '300',
  },

  // ── CTA ──
  ctaSection: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
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
  ctaStatsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  ctaStat: { alignItems: 'center', flex: 1 },
  ctaStatValue: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.navy,
  },
  ctaStatLabel: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginTop: 2,
  },
  ctaStatDivider: {
    width: 1,
    height: 24,
    backgroundColor: colors.border,
  },

  // ── Sections ──
  section: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  sectionTitle: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.textPrimary,
    letterSpacing: -0.2,
  },
  sectionSub: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    marginBottom: spacing.md,
    lineHeight: 18,
  },
  runCountBadge: {
    backgroundColor: colors.accent,
    borderRadius: radius.full,
    minWidth: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  runCountText: {
    color: colors.white,
    fontSize: fontSize.xs,
    fontWeight: '700',
  },

  // ── Request cards ──
  requestCard: {
    flexDirection: 'row',
    backgroundColor: colors.cardBackground,
    borderRadius: radius.lg,
    marginBottom: spacing.sm,
    overflow: 'hidden',
    ...shadow.card,
  },
  requestCardPressed: { opacity: 0.9, transform: [{ scale: 0.99 }] },
  requestAccent: {
    width: 4,
    borderTopLeftRadius: radius.lg,
    borderBottomLeftRadius: radius.lg,
  },
  accent_pending: { backgroundColor: colors.warning },
  accent_matched: { backgroundColor: colors.accent },
  accent_collected: { backgroundColor: colors.success },
  requestBody: {
    flex: 1,
    padding: spacing.md,
  },
  requestTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  requestFrom: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.textPrimary,
    flex: 1,
    marginRight: spacing.sm,
  },
  requestTo: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
  },
  requestFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  requestStatusLabel: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    fontWeight: '500',
  },
  requestDate: {
    fontSize: fontSize.xs,
    color: colors.textLight,
  },

  // ── Runs ──
  runCard: { marginBottom: spacing.sm },
  runHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  runRouteContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  runOrigin: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  runArrow: {
    fontSize: fontSize.md,
    color: colors.textMuted,
    fontWeight: '300',
  },
  runDest: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.navy,
  },
  runTimeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  runDay: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  runTimeSep: { color: colors.textLight, fontSize: fontSize.sm },
  runTime: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
  },
  ferryBadge: {
    backgroundColor: colors.infoLight,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.full,
  },
  ferryText: { fontSize: fontSize.xs, color: colors.infoDark, fontWeight: '600' },
  runCategoryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  runCategoryChip: {
    backgroundColor: colors.offWhite,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
  },
  runCategoryText: { fontSize: fontSize.xs, color: colors.textSecondary, fontWeight: '500' },
  runCategoryMore: {
    fontSize: fontSize.xs,
    color: colors.textLight,
    alignSelf: 'center',
    paddingLeft: 4,
  },

  // ── Quick links ──
  quickLinks: { gap: spacing.sm },
  quickLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  quickLinkIcon: { fontSize: 20, width: 28, textAlign: 'center' },
  quickLinkLabel: {
    flex: 1,
    fontSize: fontSize.md,
    color: colors.textPrimary,
    fontWeight: '500',
  },
  quickLinkArrow: {
    fontSize: 20,
    color: colors.textLight,
    fontWeight: '300',
  },
  quickLinkDriver: {
    backgroundColor: colors.accentLight,
    borderWidth: 1,
    borderColor: 'rgba(18,179,214,0.2)',
  },
  quickLinkDriverLabel: {
    color: colors.navy,
    fontWeight: '600',
  },

  // ── Footer ──
  footer: {
    alignItems: 'center',
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
});
