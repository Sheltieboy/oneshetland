import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Alert,
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
import { colors, fontSize, spacing, radius } from '@/constants/theme';

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

  const firstName = profile?.full_name?.split(' ')[0] ?? 'there';

  useEffect(() => {
    if (!profile?.id || !isSupabaseConfigured) {
      setLoadingDriver(false);
      setLoadingRuns(false);
      return;
    }

    // Fetch driver profile
    supabase
      .from('driver_profiles')
      .select('*')
      .eq('id', profile.id)
      .single()
      .then(({ data }) => {
        setDriverProfile(data as DriverProfile | null);
        setLoadingDriver(false);
      });

    // Fetch all upcoming runs for this driver
    const now = new Date().toISOString();
    supabase
      .from('runs')
      .select('id, departure_start, departure_end, status, ferry_crossing, notes, categories_accepted')
      .eq('driver_id', profile.id)
      .gte('departure_end', now)
      .order('departure_start', { ascending: true })
      .then(({ data }) => {
        setRuns((data as Run[]) ?? []);
        setLoadingRuns(false);
      });

    // Fetch all pending delivery requests
    supabase
      .from('delivery_requests')
      .select('id, category_slug, pickup_name, pickup_location, destination_area, destination_address, already_paid, ready_for_collection, created_at, base_fee_pence')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        setPendingRequests((data as PendingRequest[]) ?? []);
        setLoadingPending(false);
      });

    // Fetch matched requests on this driver's runs
    supabase
      .from('delivery_requests')
      .select('id, category_slug, pickup_name, pickup_location, destination_area, destination_address, delivery_notes, status, already_paid, base_fee_pence, run_id, runs!inner(driver_id)')
      .in('status', ['matched', 'collected'])
      .eq('runs.driver_id', profile.id)
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        setMatchedRequests((data as MatchedRequest[]) ?? []);
        setLoadingMatched(false);
      });
  }, [profile?.id]);

  async function handleAccept(requestId: string) {
    const openRuns = runs.filter((r) => r.status === 'open');

    if (openRuns.length === 0) {
      const req = pendingRequests.find((r) => r.id === requestId);
      const destination = req?.destination_area || req?.destination_address?.split(',')[0] || 'Unknown';

      // No open run — offer to auto-create one and immediately accept
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
                Alert.alert('Could not create run', runError?.message ?? runError?.details ?? runError?.hint ?? 'Unknown error');
                return;
              }

              setRuns((prev) => [
                ...prev,
                {
                  id: newRun.id,
                  departure_start: now.toISOString(),
                  departure_end: threeHoursLater.toISOString(),
                  status: 'open',
                  ferry_crossing: false,
                  notes: `Origin: Lerwick\nDestination: ${destination}`,
                  categories_accepted: ['takeaway', 'grocery', 'pharmacy', 'parcel', 'other'],
                },
              ]);

              acceptRequest(requestId, newRun.id);
            },
          },
          { text: 'Cancel', style: 'cancel' },
        ],
      );
      return;
    }

    // If multiple open runs, ask which one to link to
    if (openRuns.length > 1) {
      Alert.alert(
        'Which run?',
        'Choose the run to link this request to:',
        [
          ...openRuns.map((run) => {
            const noteLines = (run.notes ?? '').split('\n');
            const dest = noteLines.find((l) => l.startsWith('Destination:'))?.replace('Destination: ', '') ?? 'Unknown';
            const time = new Date(run.departure_start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
            return {
              text: `→ ${dest} at ${time}`,
              onPress: () => acceptRequest(requestId, run.id),
            };
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
      // Capture payment via Edge Function — it also sets status = 'delivered'
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch(
          'https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/capture-payment',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${session?.access_token}`,
            },
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
        const total = result.total_fee_pence
          ? `£${(result.total_fee_pence / 100).toFixed(2)} charged to customer.`
          : 'Payment captured.';
        Alert.alert('Delivered! 🎉', `The customer has been notified. ${total}`);

      } catch (e) {
        setUpdating(null);
        Alert.alert('Payment capture failed', e instanceof Error ? e.message : 'Network error');
      }
      return;
    }

    // For 'collected' — update status then notify the customer
    const { error } = await supabase
      .from('delivery_requests')
      .update({ status: newStatus })
      .eq('id', requestId);
    setUpdating(null);

    if (error) {
      Alert.alert('Could not update status', error.message);
      return;
    }
    setMatchedRequests((prev) =>
      prev.map((r) => (r.id === requestId ? { ...r, status: newStatus } : r)),
    );

    // Notify the customer their item has been collected (non-blocking)
    const { data: { session } } = await supabase.auth.getSession();
    fetch('https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/notify-collected', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session?.access_token}`,
      },
      body: JSON.stringify({ request_id: requestId }),
    }).catch(() => {/* non-fatal */});
  }

  async function acceptRequest(requestId: string, runId: string) {
    setAccepting(requestId);

    // 1. Match the request to this run — only if still pending (race condition guard)
    const { data: updated, error } = await supabase
      .from('delivery_requests')
      .update({ status: 'matched', run_id: runId })
      .eq('id', requestId)
      .eq('status', 'pending')   // atomic guard: fails if another driver already accepted
      .select('id');

    if (error) {
      setAccepting(null);
      Alert.alert('Could not accept request', error.message);
      return;
    }

    if (!updated || updated.length === 0) {
      setAccepting(null);
      setPendingRequests((prev) => prev.filter((r) => r.id !== requestId));
      Alert.alert('Already taken', 'Another driver accepted this request just now. It has been removed from your list.');
      return;
    }

    // 2. Pre-authorise the customer's payment card
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) {
        const res = await fetch(
          'https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/authorise-payment',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({ request_id: requestId }),
          },
        );
        if (!res.ok) {
          const err = await res.json();
          console.warn('[authorise-payment]', err);
          // Non-blocking: request is matched even if payment auth fails
          // (admin can handle manually — common if customer has no card on file)
        }
      }
    } catch (e) {
      console.warn('[authorise-payment] network error', e);
    }

    setAccepting(null);
    setPendingRequests((prev) => prev.filter((r) => r.id !== requestId));
    Alert.alert('Request accepted! 📦', 'The customer has been notified and their card pre-authorised.');
  }

  const isApproved    = driverProfile?.driver_status === 'approved';
  const isBankConnected = driverProfile?.stripe_onboarding_complete && driverProfile?.stripe_payouts_enabled;
  const canAccept     = isApproved && isBankConnected;

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
            <View>
              <Text style={styles.greeting}>Hello, {firstName} 👋</Text>
              <Text style={styles.headerSub}>Driver dashboard</Text>
            </View>
            <TouchableOpacity onPress={() => router.push('/account')} style={styles.avatarButton}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>
                  {(profile?.full_name ?? 'D')[0].toUpperCase()}
                </Text>
              </View>
            </TouchableOpacity>
          </View>
        </View>

        {/* Driver status banner */}
        <View style={styles.statusSection}>
          <View style={styles.statusRow}>
            <Text style={styles.statusTitle}>Driver status</Text>
            {!loadingDriver && driverProfile && (
              <StatusBadge status={driverProfile.driver_status} />
            )}
            {!loadingDriver && !driverProfile && (
              <StatusBadge status="not_applied" />
            )}
          </View>

          {!isApproved && (
            <View style={styles.statusNotice}>
              {!driverProfile || driverProfile.driver_status === 'not_applied' ? (
                <>
                  <Text style={styles.statusNoticeTitle}>Want to drive for OneShetland?</Text>
                  <Text style={styles.statusNoticeBody}>
                    Apply to become an approved driver. Your application will be reviewed by our
                    team. Once approved, you can start creating runs.
                  </Text>
                  <Button
                    label="Apply to become a driver"
                    onPress={() => router.push('/(customer)/apply-driver')}
                    variant="secondary"
                    size="md"
                    style={{ marginTop: spacing.sm }}
                  />
                </>
              ) : driverProfile.driver_status === 'pending' ? (
                <Text style={styles.statusNoticeBody}>
                  Your application is being reviewed. We'll be in touch shortly. You cannot create
                  runs until your application is approved.
                </Text>
              ) : driverProfile.driver_status === 'rejected' ? (
                <Text style={styles.statusNoticeBody}>
                  Your application was not approved at this time. Contact us if you have questions.
                </Text>
              ) : driverProfile.driver_status === 'suspended' ? (
                <Text style={styles.statusNoticeBody}>
                  Your account has been suspended. Contact support for assistance.
                </Text>
              ) : null}
            </View>
          )}
        </View>

        {/* Create run CTA — only for approved drivers */}
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
              disabled={!isBankConnected}
            />
            {isBankConnected ? (
              <Text style={styles.ctaHint}>
                Let customers know you're heading somewhere — they'll match their requests to your run.
              </Text>
            ) : (
              <TouchableOpacity
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onPress={() => router.push('/(driver)/connect-bank' as any)}
              >
                <Text style={styles.ctaHintLink}>
                  🏦 Connect your bank account first to create runs →
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Upcoming runs */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Your upcoming runs</Text>
          {loadingRuns ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyBody}>Loading runs…</Text>
            </Card>
          ) : runs.length === 0 ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyIcon}>🚗</Text>
              <Text style={styles.emptyTitle}>No upcoming runs</Text>
              <Text style={styles.emptyBody}>
                {isApproved
                  ? "Create a run to start accepting delivery requests."
                  : "Your runs will appear here once you're approved."}
              </Text>
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

              // Extract origin/destination from notes (stored as "Origin: X\nDestination: Y")
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
                    <View style={styles.categoryRow}>
                      {run.categories_accepted.slice(0, 3).map((c) => (
                        <View key={c} style={styles.categoryChip}>
                          <Text style={styles.categoryText}>{c}</Text>
                        </View>
                      ))}
                      {run.categories_accepted.length > 3 && (
                        <Text style={styles.categoryMore}>+{run.categories_accepted.length - 3} more</Text>
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

        {/* Pending requests — available to accept */}
        {isApproved && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Requests waiting for a driver</Text>
            {isBankConnected ? (
              <Text style={styles.sectionSub}>Accept a request to add it to one of your runs.</Text>
            ) : (
              <TouchableOpacity
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onPress={() => router.push('/(driver)/connect-bank' as any)}
                style={{ marginBottom: spacing.md }}
              >
                <Text style={styles.ctaHintLink}>
                  🏦 Connect your bank account to accept requests →
                </Text>
              </TouchableOpacity>
            )}
            {loadingPending ? (
              <Card style={styles.emptyCard}>
                <Text style={styles.emptyBody}>Loading…</Text>
              </Card>
            ) : pendingRequests.length === 0 ? (
              <Card style={styles.emptyCard}>
                <Text style={styles.emptyIcon}>📭</Text>
                <Text style={styles.emptyTitle}>No pending requests</Text>
                <Text style={styles.emptyBody}>
                  New delivery requests will appear here.
                </Text>
              </Card>
            ) : (
              pendingRequests.map((req) => (
                <Card key={req.id} style={styles.pendingCard}>
                  {/* Fee + category row */}
                  <View style={styles.pendingHeader}>
                    <Text style={styles.pendingCategory}>{req.category_slug}</Text>
                    <View style={styles.feeRow}>
                      {req.ready_for_collection && (
                        <View style={styles.readyBadge}>
                          <Text style={styles.readyBadgeText}>Ready now</Text>
                        </View>
                      )}
                      {req.base_fee_pence != null ? (
                        <View style={styles.feeBadge}>
                          <Text style={styles.feeBadgeText}>
                            £{(req.base_fee_pence / 100).toFixed(2)}
                          </Text>
                        </View>
                      ) : (
                        <View style={[styles.feeBadge, styles.feeBadgeUnknown]}>
                          <Text style={[styles.feeBadgeText, styles.feeBadgeTextUnknown]}>Fee TBC</Text>
                        </View>
                      )}
                    </View>
                  </View>

                  {/* Route */}
                  <Text style={styles.pendingPickup}>📍 {req.pickup_name}</Text>
                  <Text style={styles.pendingAddress}>{req.pickup_location}</Text>
                  <Text style={styles.pendingArrow}>↓</Text>
                  <Text style={styles.pendingDest}>
                    🏠 {req.destination_area ? `${req.destination_area} — ` : ''}{req.destination_address}
                  </Text>

                  {req.already_paid && (
                    <Text style={styles.pendingPaid}>✅ Already paid at collection</Text>
                  )}

                  {req.base_fee_pence != null && (
                    <Text style={styles.feeNote}>
                      Customer's card will be charged £{(req.base_fee_pence / 100).toFixed(2)} on delivery
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

        {/* Matched requests */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Matched requests</Text>
          {loadingMatched ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyBody}>Loading…</Text>
            </Card>
          ) : matchedRequests.length === 0 ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyIcon}>📦</Text>
              <Text style={styles.emptyTitle}>No matched requests</Text>
              <Text style={styles.emptyBody}>Requests you accept will appear here.</Text>
            </Card>
          ) : (
            matchedRequests.map((req) => (
              <Card
                key={req.id}
                style={styles.matchedCard}
                onPress={() => router.push({ pathname: '/(driver)/request-detail', params: { id: req.id } })}
              >
                <View style={styles.matchedHeader}>
                  <Text style={styles.matchedCategory}>{req.category_slug}</Text>
                  <View style={styles.feeRow}>
                    {req.base_fee_pence != null && (
                      <View style={styles.feeBadge}>
                        <Text style={styles.feeBadgeText}>
                          £{(req.base_fee_pence / 100).toFixed(2)}
                        </Text>
                      </View>
                    )}
                    <StatusBadge status={req.status} />
                  </View>
                </View>
                <Text style={styles.matchedPickup}>📍 {req.pickup_name}</Text>
                <Text style={styles.matchedAddress}>{req.pickup_location}</Text>
                <Text style={styles.pendingArrow}>↓</Text>
                <Text style={styles.matchedDest}>
                  🏠 {req.destination_area ? `${req.destination_area} — ` : ''}{req.destination_address}
                </Text>
                <Text style={styles.matchedTap}>Tap for directions & status updates ›</Text>
              </Card>
            ))
          )}
        </View>

        {/* Bank account / payouts */}
        {driverProfile?.stripe_onboarding_complete ? (
          <View style={styles.payoutBadge}>
            <Text style={styles.payoutBadgeIcon}>✅</Text>
            <Text style={styles.payoutBadgeText}>Bank account connected — payouts active</Text>
          </View>
        ) : (
          <TouchableOpacity
            style={styles.connectBanner}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onPress={() => router.push('/(driver)/connect-bank' as any)}
            activeOpacity={0.8}
          >
            <Text style={styles.connectBannerIcon}>🏦</Text>
            <View style={styles.connectBannerBody}>
              <Text style={styles.connectBannerTitle}>Connect your bank account</Text>
              <Text style={styles.connectBannerSub}>Required to receive payment for deliveries</Text>
            </View>
            <Text style={styles.connectBannerArrow}>›</Text>
          </TouchableOpacity>
        )}

        <View style={styles.signOutRow}>
          <Button
            label="Switch to customer view"
            onPress={() => router.push('/(customer)/dashboard')}
            variant="ghost"
            size="sm"
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
    marginBottom: 4,
  },
  headerSub: { color: 'rgba(255,255,255,0.6)', fontSize: fontSize.sm },
  avatarButton: {},
  avatar: {
    width: 40,
    height: 40,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.white, fontWeight: '700', fontSize: fontSize.md },

  statusSection: {
    backgroundColor: colors.white,
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  statusTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.navy },
  statusNotice: {
    backgroundColor: colors.offWhite,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  statusNoticeTitle: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.navy,
    marginBottom: spacing.xs,
  },
  statusNoticeBody: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    lineHeight: 20,
  },

  ctaSection: {
    padding: spacing.lg,
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  ctaHintLink: {
    fontSize: fontSize.sm,
    color: '#B45309',
    fontWeight: '600',
    textAlign: 'center',
    marginTop: spacing.sm,
    textDecorationLine: 'underline',
  },
  ctaHint: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.sm,
  },

  section: { padding: spacing.lg },
  sectionTitle: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.navy,
    marginBottom: spacing.sm,
  },

  emptyCard: { alignItems: 'center', paddingVertical: spacing.xl },
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
    lineHeight: 20,
  },

  signOutRow: { alignItems: 'center', paddingBottom: spacing.lg },

  sectionSub: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    marginBottom: spacing.md,
    marginTop: -spacing.xs,
  },

  pendingCard: { marginBottom: spacing.sm },
  pendingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  pendingCategory: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.accent,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  feeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  feeBadge: {
    backgroundColor: '#DCFCE7',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: '#BBF7D0',
  },
  feeBadgeText: {
    fontSize: fontSize.sm,
    fontWeight: '800',
    color: '#15803D',
  },
  feeBadgeUnknown: {
    backgroundColor: colors.offWhite,
    borderColor: colors.border,
  },
  feeBadgeTextUnknown: {
    color: colors.textMuted,
    fontWeight: '600',
  },
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
  readyBadgeText: { fontSize: fontSize.xs, fontWeight: '600', color: '#065F46' },
  pendingPickup: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.navy,
  },
  pendingAddress: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    marginBottom: spacing.xs,
  },
  pendingArrow: {
    fontSize: fontSize.sm,
    color: colors.textLight,
    marginVertical: 2,
  },
  pendingDest: {
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.navy,
    marginBottom: spacing.xs,
  },
  pendingPaid: {
    fontSize: fontSize.xs,
    color: '#065F46',
    marginBottom: spacing.xs,
  },
  acceptButton: { marginTop: spacing.sm },

  matchedCard: { marginBottom: spacing.sm },
  matchedHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  matchedCategory: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.accent,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  matchedPickup: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.navy,
  },
  matchedAddress: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    marginBottom: spacing.xs,
  },
  matchedDest: {
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.navy,
    marginBottom: spacing.xs,
  },
  matchedNotes: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    fontStyle: 'italic',
    marginBottom: spacing.xs,
  },
  matchedActions: { marginTop: spacing.sm },
  matchedTap: {
    fontSize: fontSize.xs,
    color: colors.accent,
    marginTop: spacing.sm,
    fontWeight: '600',
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
  categoryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: spacing.sm,
  },
  categoryChip: {
    backgroundColor: colors.offWhite,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  categoryText: { fontSize: fontSize.xs, color: colors.textMuted },
  categoryMore: { fontSize: fontSize.xs, color: colors.textLight, alignSelf: 'center' },
  runStatusRow: { alignItems: 'flex-start' },

  bankWarningLink: {
    marginBottom: spacing.sm,
    alignItems: 'center',
  },
  bankWarningLinkText: {
    fontSize: fontSize.sm,
    color: '#B45309',
    fontWeight: '600',
    textAlign: 'center',
    textDecorationLine: 'underline',
  },

  connectBanner: {
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
  connectBannerIcon: { fontSize: 24 },
  connectBannerBody: { flex: 1 },
  connectBannerTitle: { fontSize: fontSize.sm, fontWeight: '700', color: '#92400E', marginBottom: 2 },
  connectBannerSub: { fontSize: fontSize.xs, color: '#B45309', lineHeight: 16 },
  connectBannerArrow: { fontSize: fontSize.xl, color: '#B45309' },

  payoutBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: '#EAF7EF',
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    borderRadius: radius.md,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
  },
  payoutBadgeIcon: { fontSize: 16 },
  payoutBadgeText: { fontSize: fontSize.sm, color: '#1B5E34', fontWeight: '500' },
});
