import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  StyleSheet,
  Pressable,
  Animated,
  LayoutAnimation,
  Platform,
  UIManager,
  Image,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/context/AuthContext';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonCard } from '@/components/ui/Skeleton';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius, shadow, contentContainer } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { SECTIONS } from '@/constants/sections';
import { haptic } from '@/lib/haptics';
import { useAlert } from '@/components/BrandedAlert';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// Typed-routes workaround
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PAYMENT_SETUP_HREF = '/payment-setup' as any;

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
  const { screenWidth } = useAppLayout();
  const { alert } = useAlert();

  const [requests, setRequests] = useState<DeliveryRequest[]>([]);
  const [loadingRequests, setLoadingRequests] = useState(true);
  const [availableRuns, setAvailableRuns] = useState<AvailableRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Per-card fade animations (keyed by request id)
  const cardAnims = useRef<Record<string, Animated.Value>>({});
  function getCardAnim(id: string) {
    if (!cardAnims.current[id]) {
      cardAnims.current[id] = new Animated.Value(1);
    }
    return cardAnims.current[id];
  }

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

  // Fade out a card, then slide remaining cards up smoothly
  const fadeOutRequest = useCallback((id: string) => {
    const anim = getCardAnim(id);
    Animated.timing(anim, { toValue: 0, duration: 350, useNativeDriver: true }).start(() => {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setRequests((prev) => prev.filter((r) => r.id !== id));
      delete cardAnims.current[id];
    });
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

  // Initial fetch
  useEffect(() => { fetchData(); }, [fetchData]);

  // Realtime — fade out when a request is cancelled or delivered
  const realtimeChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  useEffect(() => {
    if (!profile?.id) return;
    const pid = profile.id;

    // Always remove any existing channel before creating a new one
    if (realtimeChannelRef.current) {
      supabase.removeChannel(realtimeChannelRef.current);
      realtimeChannelRef.current = null;
    }

    const channel = supabase
      .channel(`customer-dashboard-${pid}-${Date.now()}`)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'delivery_requests', filter: `customer_id=eq.${pid}` },
        (payload) => {
          const updated = payload.new as DeliveryRequest;
          if (updated.status === 'cancelled' || updated.status === 'delivered') {
            fadeOutRequest(updated.id);
          } else {
            setRequests((prev) =>
              prev.map((r) => r.id === updated.id ? { ...r, status: updated.status } : r)
            );
          }
        },
      )
      .subscribe();

    realtimeChannelRef.current = channel;
    return () => {
      supabase.removeChannel(channel);
      realtimeChannelRef.current = null;
    };
  }, [profile?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  }, [fetchData]);

  return (
    <ScreenScaffold>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accent}
          />
        }
      >
        {/* ── Header ── */}
        <View style={styles.header}>
          {/* Back button removed — the customer dashboard is rendered
              inline in the Fetch tab, so the bottom tab bar is the way out. */}
          <Animated.View style={[styles.headerInner, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.greeting}>{getGreeting()}, <Text style={styles.greetingName}>{firstName} 👋</Text></Text>
              <Text style={styles.brandName}>OneShetland Fetch</Text>
              <Pressable
                onPress={() => { haptic.light(); router.push('/fetch-about'); }}
                hitSlop={8}
                style={({ pressed }) => [styles.aboutPill, pressed && { opacity: 0.85 }]}
              >
                <FontAwesome5 name="info-circle" size={12} color="#fff" solid />
                <Text style={styles.aboutPillText}>How Fetch works</Text>
                <FontAwesome5 name="chevron-right" size={9} color="#fff" />
              </Pressable>
            </View>
            <Pressable
              onPress={() => { haptic.light(); router.push('/account'); }}
              hitSlop={12}
            >
              <View style={styles.avatarStack}>
                <View style={styles.iconCircle}>
                  <Image source={require('../../assets/icon.png')} style={styles.iconImage} resizeMode="contain" />
                </View>
                <View style={styles.initialBadge}>
                  <Text style={styles.initialText}>
                    {(profile?.full_name ?? 'U')[0].toUpperCase()}
                  </Text>
                </View>
              </View>
            </Pressable>
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
                icon="inbox"
                title="No active requests"
                body="Your in-progress deliveries will appear here."
              />
            </Card>
          ) : (
            requests.map((req) => (
              <Animated.View key={req.id} style={{ opacity: getCardAnim(req.id) }}>
              <Pressable
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
                    <View style={styles.requestTopRight}>
                      <StatusBadge status={`request_${req.status}`} />
                      <Text style={styles.requestChevron}>›</Text>
                    </View>
                  </View>
                  <Text style={styles.requestTo} numberOfLines={1}>
                    → {req.destination_area ? `${req.destination_area} · ` : ''}{req.destination_address}
                  </Text>
                  <View style={styles.requestFooter}>
                    <Text style={styles.requestStatusLabel}>
                      {STATUS_LABEL[req.status] ?? req.status}
                    </Text>
                    {(req.status === 'pending' || req.status === 'matched') && (
                      <Pressable
                        onPress={(e) => {
                          e.stopPropagation();
                          haptic.warning();
                          const isMatched = req.status === 'matched';
                          alert({
                            title: 'Cancel this request?',
                            message: isMatched
                              ? 'A driver has already accepted this. They will be notified of the cancellation.'
                              : 'This will remove your request and no driver will be sent.',
                            actions: [
                              { label: 'Keep it', style: 'cancel' },
                              {
                                label: 'Yes, cancel',
                                style: 'destructive',
                                onPress: async () => {
                                  await supabase
                                    .from('delivery_requests')
                                    .update({ status: 'cancelled' })
                                    .eq('id', req.id);
                                  if (isMatched) {
                                    const { data: { session } } = await supabase.auth.getSession();
                                    fetch('https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/notify-drivers', {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
                                      body: JSON.stringify({ request_id: req.id, event: 'cancelled' }),
                                    }).catch(() => {});
                                  }
                                  fadeOutRequest(req.id);
                                },
                              },
                            ],
                          });
                        }}
                        hitSlop={8}
                        style={({ pressed }) => [styles.cancelChip, pressed && { opacity: 0.7 }]}
                      >
                        <Text style={styles.cancelChipText}>Cancel</Text>
                      </Pressable>
                    )}
                  </View>
                </View>
              </Pressable>
              </Animated.View>
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
                icon="car"
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
          <View style={styles.linkGroup}>
            {QUICK_LINKS.map(({ icon, label, route }, i) => (
              <Pressable
                key={label}
                style={({ pressed }) => [
                  styles.linkRow,
                  i < QUICK_LINKS.length - 1 && styles.linkRowBorder,
                  pressed && styles.linkRowPressed,
                ]}
                onPress={() => { haptic.light(); router.push(route as any); }}
              >
                <Text style={styles.linkIcon}>{icon}</Text>
                <Text style={styles.linkLabel}>{label}</Text>
                <Text style={styles.linkArrow}>›</Text>
              </Pressable>
            ))}
            <Pressable
              style={({ pressed }) => [styles.linkRow, styles.linkRowBorder, pressed && styles.linkRowPressed]}
              onPress={() => { haptic.light(); router.push(PAYMENT_SETUP_HREF); }}
            >
              <Text style={styles.linkIcon}>💳</Text>
              <Text style={styles.linkLabel}>
                {profile?.has_payment_method ? 'Update payment method' : 'Set up payment'}
              </Text>
              <Text style={styles.linkArrow}>›</Text>
            </Pressable>
            {profile?.role !== 'driver' && (
              <Pressable
                style={({ pressed }) => [styles.linkRow, styles.linkRowDriver, pressed && styles.linkRowPressed]}
                onPress={() => { haptic.light(); router.push('/(customer)/apply-driver'); }}
              >
                <Text style={styles.linkIcon}>🚗</Text>
                <Text style={[styles.linkLabel, styles.linkLabelDriver]}>Apply to become a driver</Text>
                <Text style={[styles.linkArrow, { color: colors.accent }]}>›</Text>
              </Pressable>
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
    </ScreenScaffold>
  );
}

const QUICK_LINKS = [
  { icon: '📍', label: 'Saved addresses', route: '/(customer)/saved-addresses' },
  { icon: '📋', label: 'Previous requests', route: '/(customer)/previous-requests' },
  { icon: '👤', label: 'Account settings', route: '/account' },
];

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: colors.screenBackground },
  content: { paddingBottom: spacing.xxl },

  // ── Header ──
  header: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  backToHome: { marginBottom: spacing.xs },
  backToHomeText: { color: 'rgba(255,255,255,0.6)', fontSize: fontSize.sm, fontWeight: '500' },
  headerInner: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  greeting: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: fontSize.md,
    fontWeight: '400',
  },
  greetingName: {
    color: colors.white,
    fontWeight: '700',
  },
  brandName: {
    color: colors.accent,
    fontSize: fontSize.xs,
    fontWeight: '600',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    marginTop: 2,
  },
  aboutPill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.full,
    backgroundColor: SECTIONS.fetch.color,
    shadowColor: SECTIONS.fetch.color,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 3,
  },
  aboutPillText: {
    color: '#fff',
    fontSize: fontSize.xs,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  avatarStack: {
    width: 44,
    height: 44,
  },
  iconCircle: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 3,
  },
  iconImage: {
    width: 36,
    height: 36,
    borderRadius: 9,
  },
  initialBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 20,
    height: 20,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.navy,
  },
  initialText: { color: colors.white, fontWeight: '800', fontSize: 9 },

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
  requestTopRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  requestChevron: {
    fontSize: 20,
    color: colors.textLight,
    fontWeight: '300',
  },
  cancelChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.full,
    backgroundColor: colors.errorLight,
    borderWidth: 1,
    borderColor: colors.error,
  },
  cancelChipText: {
    fontSize: fontSize.xs,
    color: colors.error,
    fontWeight: '600',
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

  // ── Quick links grouped list ──
  linkGroup: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    overflow: 'hidden',
    ...shadow.card,
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    gap: spacing.md,
    backgroundColor: colors.white,
  },
  linkRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  linkRowPressed: { backgroundColor: colors.offWhite },
  linkRowDriver: {
    backgroundColor: colors.accentLight,
  },
  linkIcon: { fontSize: 19, width: 26, textAlign: 'center' },
  linkLabel: {
    flex: 1,
    fontSize: fontSize.md,
    color: colors.textPrimary,
    fontWeight: '500',
  },
  linkLabelDriver: { color: colors.navy, fontWeight: '600' },
  linkArrow: {
    fontSize: 20,
    color: colors.textLight,
    fontWeight: '300',
  },

  // ── Footer ──
  footer: {
    alignItems: 'center',
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
});
