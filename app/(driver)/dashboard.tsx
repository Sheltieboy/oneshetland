import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  StyleSheet,
  Pressable,
  Alert,
  Animated,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '@/context/AuthContext';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { DriverProfile } from '@/types/database';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonCard } from '@/components/ui/Skeleton';
import { colors, fontSize, spacing, radius, shadow, fontWeight } from '@/constants/theme';
import { haptic } from '@/lib/haptics';

interface Run {
  id: string;
  departure_start: string;
  departure_end: string;
  status: string;
  ferry_crossing: boolean;
  notes: string | null;
  categories_accepted: string[];
}

interface PendingRequest {
  id: string;
  category_slug: string;
  pickup_name: string;
  pickup_location: string;
  destination_area: string | null;
  destination_address: string;
  already_paid: boolean;
  ready_for_collection: boolean;
  created_at: string;
  base_fee_pence: number | null;
}

interface MatchedRequest {
  id: string;
  category_slug: string;
  pickup_name: string;
  pickup_location: string;
  destination_area: string | null;
  destination_address: string;
  delivery_notes: string | null;
  status: string;
  already_paid: boolean;
  base_fee_pence: number | null;
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export default function DriverDashboard() {
  const router = useRouter();
  const { profile, signOut } = useAuth();

  const [driverProfile, setDriverProfile] = useState<DriverProfile | null>(null);
  const [loadingDriver, setLoadingDriver] = useState(true);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
  const [loadingPending, setLoadingPending] = useState(true);
  const [accepting, setAccepting] = useState<string | null>(null);
  const [matchedRequests, setMatchedRequests] = useState<MatchedRequest[]>([]);
  const [loadingMatched, setLoadingMatched] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
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
      setLoadingDriver(false);
      setLoadingRuns(false);
      setLoadingPending(false);
      setLoadingMatched(false);
      return;
    }
    const now = new Date().toISOString();
    const [driverRes, runsRes, pendingRes, matchedRes] = await Promise.all([
      supabase.from('driver_profiles').select('*').eq('id', profile.id).single(),
      supabase.from('runs')
        .select('id, departure_start, departure_end, status, ferry_crossing, notes, categories_accepted')
        .eq('driver_id', profile.id).gte('departure_end', now).order('departure_start', { ascending: true }),
      supabase.from('delivery_requests')
        .select('id, category_slug, pickup_name, pickup_location, destination_area, destination_address, already_paid, ready_for_collection, created_at, base_fee_pence')
        .eq('status', 'pending').order('created_at', { ascending: true }),
      supabase.from('delivery_requests')
        .select('id, category_slug, pickup_name, pickup_location, destination_area, destination_address, delivery_notes, status, already_paid, base_fee_pence, run_id, runs!inner(driver_id)')
        .in('status', ['matched', 'collected']).eq('runs.driver_id', profile.id).order('created_at', { ascending: false }),
    ]);
    setDriverProfile(driverRes.data as DriverProfile | null);
    setRuns((runsRes.data as Run[]) ?? []);
    setPendingRequests((pendingRes.data as PendingRequest[]) ?? []);
    setMatchedRequests((matchedRes.data as MatchedRequest[]) ?? []);
    setLoadingDriver(false);
    setLoadingRuns(false);
    setLoadingPending(false);
    setLoadingMatched(false);
  }, [profile?.id]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  }, [fetchData]);

  async function handleAccept(requestId: string) {
    const openRuns = runs.filter((r) => r.status === 'open');

    if (openRuns.length === 0) {
      const req = pendingRequests.find((r) => r.id === requestId);
      const destination = req?.destination_area || req?.destination_address?.split(',')[0] || 'Unknown';

      Alert.alert(
        'Accept this delivery?',
        `We'll create a run to ${destination} and assign this delivery to it.`,
        [
          {
            text: 'Accept & start run',
            onPress: async () => {
              const now = new Date();
              const threeHoursLater = new Date(now.getTime() + 3 * 60 * 60 * 1000);
              const { data: newRun, error: runError } = await supabase
                .from('runs')
                .insert({
                  driver_id: profile!.id,
                  departure_start: now.toISOString(),
                  departure_end: threeHoursLater.toISOString(),
                  status: 'open',
                  ferry_crossing: false,
                  categories_accepted: ['takeaway', 'grocery', 'pharmacy', 'parcel', 'other'],
                  notes: `Origin: Lerwick\nDestination: ${destination}`,
                })
                .select('id')
                .single();
              if (runError || !newRun) {
                Alert.alert('Could not create run', runError?.message ?? 'Unknown error');
                return;
              }
              setRuns((prev) => [...prev, {
                id: newRun.id,
                departure_start: now.toISOString(),
                departure_end: threeHoursLater.toISOString(),
                status: 'open',
                ferry_crossing: false,
                notes: `Origin: Lerwick\nDestination: ${destination}`,
                categories_accepted: ['takeaway', 'grocery', 'pharmacy', 'parcel', 'other'],
              }]);
              acceptRequest(requestId, newRun.id);
            },
          },
          { text: 'Cancel', style: 'cancel' },
        ],
      );
      return;
    }

    if (openRuns.length > 1) {
      Alert.alert(
        'Which run?',
        'Choose the run to link this request to:',
        [
          ...openRuns.map((run) => {
            const noteLines = (run.notes ?? '').split('\n');
            const dest = noteLines.find((l) => l.startsWith('Destination:'))?.replace('Destination: ', '') ?? 'Unknown';
            const time = new Date(run.departure_start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
            return { text: `→ ${dest} at ${time}`, onPress: () => acceptRequest(requestId, run.id) };
          }),
          { text: 'Cancel', style: 'cancel' as const },
        ],
      );
      return;
    }

    acceptRequest(requestId, openRuns[0].id);
  }

  async function updateRequestStatus(requestId: string, newStatus: 'collected' | 'delivered') {
    setUpdating(requestId);

    if (newStatus === 'delivered') {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch(
          'https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/capture-payment',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
            body: JSON.stringify({ request_id: requestId }),
          },
        );
        const result = await res.json();
        setUpdating(null);
        if (!res.ok) {
          Alert.alert('Payment capture failed', result?.error ?? `Error ${res.status}`);
          return;
        }
        setMatchedRequests((prev) => prev.filter((r) => r.id !== requestId));
        haptic.success();
        const total = result.total_fee_pence ? `£${(result.total_fee_pence / 100).toFixed(2)} charged.` : 'Payment captured.';
        Alert.alert('Delivered! 🎉', `The customer has been notified. ${total}`);
      } catch (e) {
        setUpdating(null);
        Alert.alert('Payment capture failed', e instanceof Error ? e.message : 'Network error');
      }
      return;
    }

    const { error } = await supabase
      .from('delivery_requests')
      .update({ status: newStatus })
      .eq('id', requestId);
    setUpdating(null);
    if (error) { Alert.alert('Could not update status', error.message); return; }
    setMatchedRequests((prev) => prev.map((r) => (r.id === requestId ? { ...r, status: newStatus } : r)));
    haptic.medium();

    const { data: { session } } = await supabase.auth.getSession();
    fetch('https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/notify-collected', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({ request_id: requestId }),
    }).catch(() => {/* non-fatal */});
  }

  async function acceptRequest(requestId: string, runId: string) {
    setAccepting(requestId);
    const { data: updated, error } = await supabase
      .from('delivery_requests')
      .update({ status: 'matched', run_id: runId })
      .eq('id', requestId)
      .eq('status', 'pending')
      .select('id');

    if (error) { setAccepting(null); Alert.alert('Could not accept request', error.message); return; }
    if (!updated || updated.length === 0) {
      setAccepting(null);
      setPendingRequests((prev) => prev.filter((r) => r.id !== requestId));
      Alert.alert('Already taken', 'Another driver accepted this just now.');
      return;
    }

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) {
        const res = await fetch(
          'https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/authorise-payment',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
            body: JSON.stringify({ request_id: requestId }),
          },
        );
        if (!res.ok) { const err = await res.json(); console.warn('[authorise-payment]', err); }
      }
    } catch (e) { console.warn('[authorise-payment] network error', e); }

    setAccepting(null);
    setPendingRequests((prev) => prev.filter((r) => r.id !== requestId));
    haptic.success();
    Alert.alert('Request accepted! 📦', 'The customer has been notified and their card pre-authorised.');
  }

  const isApproved = driverProfile?.driver_status === 'approved';
  const isBankConnected = driverProfile?.stripe_onboarding_complete && driverProfile?.stripe_payouts_enabled;
  const canAccept = isApproved && isBankConnected;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
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
              <View>
                <Text style={styles.brandName}>OneShetland Fetch</Text>
                <Text style={styles.brandRole}>Driver</Text>
              </View>
            </View>
            <Pressable
              onPress={() => { haptic.light(); router.push('/account'); }}
              hitSlop={12}
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>
                  {(profile?.full_name ?? 'D')[0].toUpperCase()}
                </Text>
              </View>
            </Pressable>
          </View>

          <Animated.View style={{ opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}>
            <Text style={styles.greeting}>{getGreeting()},</Text>
            <Text style={styles.greetingName}>{firstName} 🚗</Text>
          </Animated.View>
        </View>

        {/* ── Driver status strip ── */}
        <View style={styles.statusStrip}>
          <Text style={styles.statusStripLabel}>Driver status</Text>
          <View style={styles.statusStripRight}>
            {!loadingDriver && (
              <StatusBadge status={driverProfile?.driver_status ?? 'not_applied'} />
            )}
          </View>
        </View>

        {/* ── Status notice for unapproved ── */}
        {!isApproved && (
          <View style={styles.statusNoticeCard}>
            {!driverProfile || driverProfile.driver_status === 'not_applied' ? (
              <>
                <Text style={styles.statusNoticeTitle}>Want to drive for OneShetland?</Text>
                <Text style={styles.statusNoticeBody}>
                  Apply to become an approved driver. Your application will be reviewed by our team. Once approved, you can start creating runs.
                </Text>
                <Button
                  label="Apply to become a driver"
                  onPress={() => router.push('/(customer)/apply-driver')}
                  variant="secondary"
                  size="md"
                  style={{ marginTop: spacing.md }}
                  fullWidth
                />
              </>
            ) : driverProfile.driver_status === 'pending' ? (
              <View style={styles.statusPendingRow}>
                <Text style={styles.statusPendingIcon}>⏳</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.statusNoticeTitle}>Application under review</Text>
                  <Text style={styles.statusNoticeBody}>We'll be in touch shortly.</Text>
                </View>
              </View>
            ) : driverProfile.driver_status === 'rejected' ? (
              <Text style={styles.statusNoticeBody}>
                Your application was not approved. Contact us if you have questions.
              </Text>
            ) : driverProfile.driver_status === 'suspended' ? (
              <Text style={styles.statusNoticeBody}>
                Your account has been suspended. Contact support for assistance.
              </Text>
            ) : null}
          </View>
        )}

        {/* ── Bank connect banner ── */}
        {isApproved && !driverProfile?.stripe_onboarding_complete && (
          <Pressable
            style={({ pressed }) => [styles.bankBanner, pressed && styles.bankBannerPressed]}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onPress={() => { haptic.medium(); router.push('/(driver)/connect-bank' as any); }}
          >
            <View style={styles.bankBannerIcon}>
              <Text style={styles.bankBannerEmoji}>🏦</Text>
            </View>
            <View style={styles.bankBannerBody}>
              <Text style={styles.bankBannerTitle}>Connect your bank account</Text>
              <Text style={styles.bankBannerSub}>Required to receive payment for deliveries</Text>
            </View>
            <Text style={styles.bankBannerArrow}>›</Text>
          </Pressable>
        )}

        {/* ── Create run CTA ── */}
        {isApproved && (
          <View style={styles.ctaSection}>
            <Button
              label="+ Create a new run"
              onPress={() => {
                if (!isBankConnected) {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  router.push('/(driver)/connect-bank' as any);
                  return;
                }
                router.push('/(driver)/create-run');
              }}
              variant="secondary"
              size="lg"
              fullWidth
            />
            <Text style={styles.ctaHint}>
              {isBankConnected
                ? 'Let customers know you\'re heading somewhere — they\'ll match their requests to your run.'
                : 'Connect your bank account above to start creating runs.'}
            </Text>
          </View>
        )}

        {/* ── Upcoming runs ── */}
        <View style={styles.section}>
          <View style={styles.sectionRow}>
            <Text style={styles.sectionTitle}>Your upcoming runs</Text>
            {runs.length > 0 && (
              <View style={styles.countBadge}>
                <Text style={styles.countBadgeText}>{runs.length}</Text>
              </View>
            )}
          </View>
          {loadingRuns ? (
            <>
              <SkeletonCard />
              <SkeletonCard />
            </>
          ) : runs.length === 0 ? (
            <Card padded={false}>
              <EmptyState
                icon="🚗"
                title="No upcoming runs"
                body={isApproved
                  ? 'Create a run above to start accepting delivery requests.'
                  : "Your runs will appear here once you're approved."}
              />
            </Card>
          ) : (
            runs.map((run) => {
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
                    <View style={styles.categoryRow}>
                      {run.categories_accepted.slice(0, 4).map((c) => (
                        <View key={c} style={styles.categoryChip}>
                          <Text style={styles.categoryText}>{c}</Text>
                        </View>
                      ))}
                      {run.categories_accepted.length > 4 && (
                        <Text style={styles.categoryMore}>+{run.categories_accepted.length - 4}</Text>
                      )}
                    </View>
                  )}
                  <View style={styles.runStatusRow}>
                    <StatusBadge status={run.status} />
                  </View>
                </Card>
              );
            })
          )}
        </View>

        {/* ── Pending requests to accept ── */}
        {isApproved && (
          <View style={styles.section}>
            <View style={styles.sectionRow}>
              <Text style={styles.sectionTitle}>Open requests</Text>
              {pendingRequests.length > 0 && (
                <View style={[styles.countBadge, styles.countBadgeAccent]}>
                  <Text style={styles.countBadgeText}>{pendingRequests.length}</Text>
                </View>
              )}
            </View>
            <Text style={styles.sectionSub}>
              {isBankConnected
                ? 'Accept a request to add it to one of your runs.'
                : 'Connect your bank account to start accepting requests.'}
            </Text>
            {loadingPending ? (
              <>
                <SkeletonCard />
                <SkeletonCard />
              </>
            ) : pendingRequests.length === 0 ? (
              <Card padded={false}>
                <EmptyState
                  icon="📭"
                  title="No open requests"
                  body="New delivery requests from customers will appear here."
                />
              </Card>
            ) : (
              pendingRequests.map((req) => (
                <Card key={req.id} style={styles.pendingCard}>
                  <View style={styles.pendingHeader}>
                    <Text style={styles.pendingCategory}>{req.category_slug.toUpperCase()}</Text>
                    <View style={styles.badgeRow}>
                      {req.ready_for_collection && (
                        <View style={styles.readyBadge}>
                          <Text style={styles.readyBadgeText}>Ready now</Text>
                        </View>
                      )}
                      {req.base_fee_pence != null ? (
                        <View style={styles.feeBadge}>
                          <Text style={styles.feeBadgeText}>£{(req.base_fee_pence / 100).toFixed(2)}</Text>
                        </View>
                      ) : (
                        <View style={[styles.feeBadge, styles.feeBadgeMuted]}>
                          <Text style={[styles.feeBadgeText, styles.feeBadgeMutedText]}>Fee TBC</Text>
                        </View>
                      )}
                    </View>
                  </View>

                  <View style={styles.routeBlock}>
                    <View style={styles.routeRow}>
                      <View style={styles.routeDot} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.routeLabel}>Collection</Text>
                        <Text style={styles.routeName}>{req.pickup_name}</Text>
                        <Text style={styles.routeAddress}>{req.pickup_location}</Text>
                      </View>
                    </View>
                    <View style={styles.routeLine} />
                    <View style={styles.routeRow}>
                      <View style={[styles.routeDot, styles.routeDotDest]} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.routeLabel}>Delivery</Text>
                        <Text style={styles.routeName}>
                          {req.destination_area ? `${req.destination_area} · ` : ''}{req.destination_address}
                        </Text>
                      </View>
                    </View>
                  </View>

                  {req.already_paid && (
                    <View style={styles.paidBadge}>
                      <Text style={styles.paidBadgeText}>✓ Already paid at collection</Text>
                    </View>
                  )}

                  {req.base_fee_pence != null && (
                    <Text style={styles.feeNote}>
                      Customer charged £{(req.base_fee_pence / 100).toFixed(2)} on delivery
                    </Text>
                  )}

                  <Button
                    label={accepting === req.id ? 'Accepting…' : 'Accept this request'}
                    onPress={() => handleAccept(req.id)}
                    loading={accepting === req.id}
                    disabled={!canAccept}
                    variant="secondary"
                    size="sm"
                    fullWidth
                    style={styles.acceptButton}
                  />
                </Card>
              ))
            )}
          </View>
        )}

        {/* ── Matched / active deliveries ── */}
        <View style={styles.section}>
          <View style={styles.sectionRow}>
            <Text style={styles.sectionTitle}>Active deliveries</Text>
            {matchedRequests.length > 0 && (
              <View style={[styles.countBadge, styles.countBadgeSuccess]}>
                <Text style={styles.countBadgeText}>{matchedRequests.length}</Text>
              </View>
            )}
          </View>
          {loadingMatched ? (
            <>
              <SkeletonCard />
            </>
          ) : matchedRequests.length === 0 ? (
            <Card padded={false}>
              <EmptyState
                icon="📦"
                title="No active deliveries"
                body="Requests you accept will appear here to track and complete."
              />
            </Card>
          ) : (
            matchedRequests.map((req) => (
              <Card
                key={req.id}
                style={styles.matchedCard}
                onPress={() => router.push({ pathname: '/(driver)/request-detail', params: { id: req.id } })}
              >
                <View style={styles.matchedHeader}>
                  <Text style={styles.matchedCategory}>{req.category_slug.toUpperCase()}</Text>
                  <View style={styles.badgeRow}>
                    {req.base_fee_pence != null && (
                      <View style={styles.feeBadge}>
                        <Text style={styles.feeBadgeText}>£{(req.base_fee_pence / 100).toFixed(2)}</Text>
                      </View>
                    )}
                    <StatusBadge status={req.status} />
                  </View>
                </View>

                <View style={styles.routeBlock}>
                  <View style={styles.routeRow}>
                    <View style={styles.routeDot} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.routeLabel}>Collection</Text>
                      <Text style={styles.routeName}>{req.pickup_name}</Text>
                      <Text style={styles.routeAddress}>{req.pickup_location}</Text>
                    </View>
                  </View>
                  <View style={styles.routeLine} />
                  <View style={styles.routeRow}>
                    <View style={[styles.routeDot, styles.routeDotDest]} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.routeLabel}>Delivery</Text>
                      <Text style={styles.routeName}>
                        {req.destination_area ? `${req.destination_area} · ` : ''}{req.destination_address}
                      </Text>
                    </View>
                  </View>
                </View>

                <Text style={styles.matchedTap}>Tap to update status ›</Text>
              </Card>
            ))
          )}
        </View>

        {/* ── Bank connected badge ── */}
        {driverProfile?.stripe_onboarding_complete && driverProfile?.stripe_payouts_enabled && (
          <View style={styles.payoutBadge}>
            <Text style={styles.payoutBadgeIcon}>✅</Text>
            <Text style={styles.payoutBadgeText}>Bank account connected — payouts active</Text>
          </View>
        )}

        {/* ── Footer ── */}
        <View style={styles.footer}>
          <Button
            label="Switch to customer view"
            onPress={() => router.push('/(customer)/dashboard')}
            variant="outline"
            size="sm"
            style={{ marginBottom: spacing.sm }}
          />
          <Button label="Sign out" onPress={signOut} variant="ghost" size="sm" />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

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
    color: 'rgba(255,255,255,0.85)',
    fontSize: fontSize.sm,
    fontWeight: '700',
    letterSpacing: 0.1,
  },
  brandRole: {
    color: colors.accent,
    fontSize: fontSize.xs,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginTop: 1,
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
  avatarText: { color: colors.white, fontWeight: '700', fontSize: fontSize.md },
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

  // ── Status strip ──
  statusStrip: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.white,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  statusStripLabel: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  statusStripRight: { flexDirection: 'row', alignItems: 'center' },

  // ── Status notice ──
  statusNoticeCard: {
    backgroundColor: colors.white,
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    borderRadius: radius.lg,
    padding: spacing.lg,
    ...shadow.card,
  },
  statusPendingRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  statusPendingIcon: { fontSize: 24, marginTop: 2 },
  statusNoticeTitle: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: spacing.xs,
  },
  statusNoticeBody: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    lineHeight: 20,
  },

  // ── Bank banner ──
  bankBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFBEB',
    borderBottomWidth: 1,
    borderBottomColor: '#FDE68A',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  bankBannerPressed: { opacity: 0.85 },
  bankBannerIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: '#FEF3C7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bankBannerEmoji: { fontSize: 22 },
  bankBannerBody: { flex: 1 },
  bankBannerTitle: { fontSize: fontSize.sm, fontWeight: '700', color: '#92400E', marginBottom: 2 },
  bankBannerSub: { fontSize: fontSize.xs, color: '#B45309', lineHeight: 16 },
  bankBannerArrow: { fontSize: fontSize.xl, color: '#D97706', fontWeight: '300' },

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
    lineHeight: 18,
  },

  // ── Sections ──
  section: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
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
  countBadge: {
    backgroundColor: colors.navy,
    borderRadius: radius.full,
    minWidth: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  countBadgeAccent: { backgroundColor: colors.accent },
  countBadgeSuccess: { backgroundColor: colors.success },
  countBadgeText: { color: colors.white, fontSize: fontSize.xs, fontWeight: '700' },

  // ── Run cards ──
  runCard: { marginBottom: spacing.sm },
  runHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  runRouteContainer: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  runOrigin: { fontSize: fontSize.md, fontWeight: '700', color: colors.textPrimary },
  runArrow: { fontSize: fontSize.md, color: colors.textMuted, fontWeight: '300' },
  runDest: { fontSize: fontSize.md, fontWeight: '700', color: colors.navy },
  runTimeRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
  runDay: { fontSize: fontSize.sm, fontWeight: '600', color: colors.textSecondary },
  runTimeSep: { color: colors.textLight, fontSize: fontSize.sm },
  runTime: { fontSize: fontSize.sm, color: colors.textMuted },
  ferryBadge: {
    backgroundColor: colors.infoLight,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.full,
  },
  ferryText: { fontSize: fontSize.xs, color: colors.infoDark, fontWeight: '600' },
  categoryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: spacing.sm },
  categoryChip: {
    backgroundColor: colors.offWhite,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
  },
  categoryText: { fontSize: fontSize.xs, color: colors.textSecondary, fontWeight: '500' },
  categoryMore: { fontSize: fontSize.xs, color: colors.textLight, alignSelf: 'center' },
  runStatusRow: { alignItems: 'flex-start' },

  // ── Pending / matched cards shared ──
  pendingCard: { marginBottom: spacing.sm },
  pendingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  pendingCategory: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.accent,
    letterSpacing: 0.8,
  },
  matchedCard: { marginBottom: spacing.sm },
  matchedHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  matchedCategory: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.navy,
    letterSpacing: 0.8,
  },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  feeBadge: {
    backgroundColor: '#DCFCE7',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: '#BBF7D0',
  },
  feeBadgeText: { fontSize: fontSize.sm, fontWeight: '800', color: '#15803D' },
  feeBadgeMuted: { backgroundColor: colors.offWhite, borderColor: colors.border },
  feeBadgeMutedText: { color: colors.textMuted, fontWeight: '600' },
  feeNote: {
    fontSize: fontSize.xs,
    color: '#15803D',
    marginBottom: spacing.xs,
    fontWeight: '500',
  },
  readyBadge: {
    backgroundColor: colors.successLight,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  readyBadgeText: { fontSize: fontSize.xs, fontWeight: '600', color: colors.successDark },
  paidBadge: {
    backgroundColor: colors.successLight,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    marginBottom: spacing.xs,
    alignSelf: 'flex-start',
  },
  paidBadgeText: { fontSize: fontSize.xs, color: colors.successDark, fontWeight: '600' },

  // ── Route block (shared pickup → delivery layout) ──
  routeBlock: { marginBottom: spacing.sm },
  routeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  routeDot: {
    width: 10,
    height: 10,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    marginTop: 4,
  },
  routeDotDest: { backgroundColor: colors.navy },
  routeLine: {
    width: 2,
    height: 16,
    backgroundColor: colors.border,
    marginLeft: 4,
    marginVertical: 2,
  },
  routeLabel: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '500', marginBottom: 1 },
  routeName: { fontSize: fontSize.md, fontWeight: '700', color: colors.textPrimary },
  routeAddress: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 1 },

  acceptButton: { marginTop: spacing.sm },
  matchedTap: {
    fontSize: fontSize.xs,
    color: colors.accent,
    fontWeight: '600',
    marginTop: spacing.xs,
  },

  // ── Payout badge ──
  payoutBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.successLight,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    borderRadius: radius.md,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
  },
  payoutBadgeIcon: { fontSize: 16 },
  payoutBadgeText: { fontSize: fontSize.sm, color: colors.successDark, fontWeight: '500' },

  // ── Footer ──
  footer: {
    alignItems: 'center',
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
});
