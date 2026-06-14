/**
 * local-wallet.tsx — Local Wallet: balance, top-up, history, pay
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useStripe } from '@stripe/stripe-react-native';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { useAlert } from '@/components/BrandedAlert';
import { EmptyState } from '@/components/ui/EmptyState';
import { useAppLayout } from '@/hooks/useAppLayout';
import { useAuth } from '@/context/AuthContext';
import { ConfirmPaymentSheet } from '@/components/ConfirmPaymentSheet';
import { fetchMyHubMemberships, type HubMember } from '@/lib/hubs-api';
import {
  fetchWalletBalance, fetchWalletTransactions,
  startWalletTopUp, confirmWalletTopUp,
  fetchMyPasses, fetchMyGiftsReceived, fetchMyLoyaltyCards,
  formatPence,
  type WalletTransaction, type MyPass, type MyGiftReceived, type LoyaltyCard,
} from '@/lib/local-api';
import { fetchMyBookings, type BookBooking } from '@/lib/book-api';
import {
  fetchWorkSummary, fetchFetchSummary,
  type WorkSummary, type FetchSummary,
} from '@/lib/wallet-hub';
import { fetchMyUpcomingEventTickets, type EventTicket } from '@/lib/events-api';

const S = SECTIONS.local;

const TOP_UP_AMOUNTS = [
  { pence: 1000,  label: '£10' },
  { pence: 2000,  label: '£20' },
  { pence: 5000,  label: '£50' },
  { pence: 10000, label: '£100' },
];

export default function WalletScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();
  const { screenWidth } = useAppLayout();
  const { alert } = useAlert();

  const [balance, setBalance]   = useState<number>(0);
  const [txs, setTxs]           = useState<WalletTransaction[]>([]);
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [toppingUp, setToppingUp] = useState<number | null>(null);
  const [confirmAmount, setConfirmAmount] = useState<number | null>(null);

  // Tapping an amount: if there's a saved card it would charge off-session with
  // no Stripe UI, so show our confirm step first. With no card on file, fall
  // through to handleTopUp which prompts to add one (or opens the Payment Sheet).
  const requestTopUp = (amountPence: number) => {
    if (profile?.has_payment_method) setConfirmAmount(amountPence);
    else handleTopUp(amountPence);
  };

  // My Wallet hub sections — each loads independently; failures degrade to empty.
  const [passes, setPasses]                 = useState<MyPass[]>([]);
  const [giftsToClaim, setGiftsToClaim]     = useState<MyGiftReceived[]>([]);
  const [upcomingBookings, setUpcomingBookings] = useState<BookBooking[]>([]);
  const [loyaltyCards, setLoyaltyCards]     = useState<LoyaltyCard[]>([]);
  const [work, setWork]   = useState<WorkSummary  | null>(null);
  const [fetch_, setFetch_] = useState<FetchSummary | null>(null);
  const [upcomingEventTickets, setUpcomingEventTickets] = useState<EventTicket[]>([]);
  const [membershipsCount, setMembershipsCount] = useState(0);

  const load = useCallback(async () => {
    if (!profile) return;
    try {
      // Each fetcher wrapped in .catch so a single failure (RLS, network) only
      // empties its own section, doesn't blank the screen.
      const [b, t, ps, gs, bks, lcs, ws, fs, evTickets, mships] = await Promise.all([
        fetchWalletBalance(profile.id),
        fetchWalletTransactions(profile.id),
        fetchMyPasses(profile.id).catch(() => [] as MyPass[]),
        fetchMyGiftsReceived(profile.id).catch(() => [] as MyGiftReceived[]),
        fetchMyBookings(profile.id).catch(() => [] as BookBooking[]),
        fetchMyLoyaltyCards(profile.id).catch(() => [] as LoyaltyCard[]),
        fetchWorkSummary(profile.id).catch(() => null),
        fetchFetchSummary(profile.id).catch(() => null),
        fetchMyUpcomingEventTickets(profile.id).catch(() => [] as EventTicket[]),
        fetchMyHubMemberships(profile.id).catch(() => [] as HubMember[]),
      ]);
      setMembershipsCount(mships.length);
      setBalance(b);
      setTxs(t);
      setPasses(ps);
      // Only show booking gifts that still need a slot picked
      setGiftsToClaim(gs.filter(g => g.kind === 'booking' && g.status === 'claimed'));
      // Only upcoming + confirmed bookings
      const nowMs = Date.now();
      setUpcomingBookings(
        bks
          .filter(b => b.status === 'confirmed' && new Date(b.starts_at).getTime() > nowMs)
          .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime()),
      );
      setLoyaltyCards(lcs);
      setWork(ws);
      setFetch_(fs);
      setUpcomingEventTickets(evTickets);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [profile?.id]);

  useEffect(() => { load(); }, [load]);

  const handleTopUp = async (amountPence: number) => {
    // Pre-flight: card must be set up centrally in Me before topping up
    if (!profile?.has_payment_method) {
      alert({
        title: 'Payment card needed',
        message: 'Add a payment card in your account before topping up your wallet.',
        actions: [
          { label: 'Not now', style: 'cancel' },
          { label: 'Add card', style: 'primary', onPress: () => router.push('/payment-setup') },
        ],
      });
      return;
    }

    setToppingUp(amountPence);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      // Try the off-session saved-card path first (the user has a card on
      // file because the pre-flight above passed). The server falls back to
      // PaymentSheet if it can't find a saved card on the Stripe Customer.
      const startRes = await startWalletTopUp(amountPence, true);

      let piId: string;

      if (startRes.charged) {
        // Saved card succeeded — no PaymentSheet needed.
        piId = startRes.payment_intent_id;
      } else {
        // No saved card / new-card path → present the PaymentSheet.
        const clientSecret = startRes.clientSecret;
        if (!clientSecret) throw new Error('Top-up could not be started.');
        piId = clientSecret.split('_secret_')[0];

        const initRes = await initPaymentSheet({
          merchantDisplayName: 'OneShetland Local',
          paymentIntentClientSecret: clientSecret,
          applePay: { merchantCountryCode: 'GB' },
        });
        if (initRes.error) throw new Error(initRes.error.message);

        const sheetRes = await presentPaymentSheet();
        if (sheetRes.error) {
          if (sheetRes.error.code !== 'Canceled') {
            throw new Error(sheetRes.error.message);
          }
          return;
        }
      }

      const { balance_pence } = await confirmWalletTopUp(piId);
      setBalance(balance_pence);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      alert({ title: 'Topped up!', message: `New balance: ${formatPence(balance_pence)}` });
      load();
    } catch (e: any) {
      alert({ title: 'Top-up failed', message: e.message ?? 'Try again' });
    } finally {
      setToppingUp(null);
    }
  };

  return (
    <ScreenScaffold
      header={
        <ScreenHeader
          title="My Wallet"
          accent={S.color}
          onBack={() => router.back()}
        />
      }
    >
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={S.color} />}
      >
        {/* Balance card */}
        <View style={[styles.balanceCard, { backgroundColor: S.color }]}>
          <Text style={styles.balanceLabel}>Available balance</Text>
          <Text style={styles.balanceAmount}>{formatPence(balance)}</Text>
          <TouchableOpacity
            style={styles.payAtTillBtn}
            onPress={() => router.push('/local-pay')}
            activeOpacity={0.85}
          >
            <FontAwesome5 name="qrcode" size={13} color="#fff" />
            <Text style={styles.payAtTillText}>Pay at till</Text>
          </TouchableOpacity>
        </View>

        {/* Top-up section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Top up</Text>
          <Text style={styles.sectionHint}>Add credit to spend at participating businesses</Text>
          <View style={styles.topUpRow}>
            {TOP_UP_AMOUNTS.map(amt => (
              <TouchableOpacity
                key={amt.pence}
                style={[styles.topUpBtn, toppingUp === amt.pence && { opacity: 0.7 }]}
                onPress={() => requestTopUp(amt.pence)}
                disabled={!!toppingUp}
                activeOpacity={0.8}
              >
                {toppingUp === amt.pence
                  ? <ActivityIndicator color={S.color} size="small" />
                  : <Text style={[styles.topUpBtnText, { color: S.color }]}>{amt.label}</Text>
                }
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* ── My Wallet hub sections ──────────────────────────────────────
            Each section hides entirely if it has nothing — keeps the screen
            tidy for users who haven't bought / been gifted / booked yet. */}

        {passes.length > 0 && (
          <HubSection
            icon="ticket-alt"
            title="Passes & vouchers"
            countLabel={`${passes.length} active`}
            onPress={() => router.push('/local-my-passes' as any)}
          />
        )}

        {membershipsCount > 0 && (
          <HubSection
            icon="id-card"
            title="My memberships"
            countLabel={`${membershipsCount} ${membershipsCount === 1 ? 'hub' : 'hubs'}`}
            onPress={() => router.push('/hub-my-memberships' as any)}
          />
        )}

        {giftsToClaim.length > 0 && (
          <HubSection
            icon="gift"
            title="Gifts to claim"
            countLabel={`${giftsToClaim.length} waiting`}
            onPress={() => router.push('/local-my-gifts' as any)}
          />
        )}

        {upcomingBookings.length > 0 && (
          <HubSection
            icon="calendar-alt"
            title="Upcoming bookings"
            countLabel={`${upcomingBookings.length} ${upcomingBookings.length === 1 ? 'booking' : 'bookings'}`}
            onPress={() => router.push('/local-my-bookings')}
          />
        )}

        {upcomingEventTickets.length > 0 && (
          <HubSection
            icon="ticket-alt"
            title="Event tickets"
            countLabel={`${upcomingEventTickets.length} upcoming`}
            onPress={() => router.push('/my-event-tickets' as any)}
          />
        )}

        {loyaltyCards.length > 0 && (
          <HubSection
            icon="star"
            title="Loyalty cards"
            countLabel={(() => {
              const ready = loyaltyCards.filter(c => c.program?.type === 'stamps' && (c.program?.stamps_required ?? 0) > 0 && c.stamps_collected >= (c.program?.stamps_required ?? 0)).length;
              const base  = `${loyaltyCards.length} ${loyaltyCards.length === 1 ? 'card' : 'cards'}`;
              return ready > 0 ? `${base} · ${ready} reward${ready === 1 ? '' : 's'} ready` : base;
            })()}
            onPress={() => router.push('/local-my-cards')}
          />
        )}

        {/* ── Work (worker + employer) ── */}
        {work?.hasAny && (
          <HubSection
            icon="briefcase"
            title="Work"
            countLabel={workCountLabel(work)}
            onPress={() => {
              // Prefer the side they're more active on.
              if (work.worker.appCount >= work.employer.activeShifts) {
                router.push('/my-shift-applications');
              } else {
                router.push('/my-posted-shifts');
              }
            }}
            footChildren={
              <>
                {(work.worker.hasWorkerProfile || work.worker.appCount > 0) && (
                  <HubFootLink
                    label="Worker profile"
                    onPress={() => router.push('/shift-worker-profile')}
                  />
                )}
                {work.employer.activeShifts > 0 && (
                  <HubFootLink
                    label="Employer profile"
                    onPress={() => router.push('/employer-profile')}
                  />
                )}
              </>
            }
          />
        )}

        {/* ── Fetch (customer + driver) ── */}
        {fetch_?.hasAny && (
          <HubSection
            icon="truck"
            title="Fetch"
            countLabel={fetchCountLabel(fetch_)}
            onPress={() => {
              if (fetch_.driver.isDriver && fetch_.driver.activeRuns >= fetch_.customer.activeCount) {
                router.push('/(driver)/dashboard');
              } else {
                router.push('/(customer)/previous-requests');
              }
            }}
            footChildren={
              <>
                <HubFootLink
                  label="Saved addresses"
                  onPress={() => router.push('/(customer)/saved-addresses')}
                />
                {!fetch_.driver.isDriver && (
                  <HubFootLink
                    label="Become a driver"
                    onPress={() => router.push('/(customer)/apply-driver')}
                  />
                )}
              </>
            }
          />
        )}

        {/* Transactions */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Recent activity</Text>
          {loading ? (
            <ActivityIndicator color={S.color} style={{ marginTop: 20 }} />
          ) : txs.length === 0 ? (
            <EmptyState
              icon="receipt"
              title="No transactions yet"
              accent={S.color}
              variant="card"
            />
          ) : (
            <View style={styles.txList}>
              {txs.map(tx => <TransactionRow key={tx.id} tx={tx} />)}
            </View>
          )}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>

      <ConfirmPaymentSheet
        visible={confirmAmount != null}
        title="Top up your wallet"
        itemName="OneShetland wallet top-up"
        lineItems={[{ label: 'Top-up amount', amountPence: confirmAmount ?? 0 }]}
        totalPence={confirmAmount ?? 0}
        payingWith="your saved card"
        policy={{ text: 'Wallet credit is non-refundable but can be spent at any participating Shetland business.' }}
        loading={toppingUp != null}
        onConfirm={() => { const amt = confirmAmount; setConfirmAmount(null); if (amt != null) handleTopUp(amt); }}
        onCancel={() => setConfirmAmount(null)}
      />
    </ScreenScaffold>
  );
}

// ── My Wallet hub-section building blocks ────────────────────────────────────

/**
 * A single-row index entry. Tap anywhere on the row to navigate to the full
 * list. Optional foot-buttons (Work / Fetch sections) sit underneath for
 * secondary destinations like "Worker profile" or "Saved addresses".
 */
function HubSection({
  icon, title, countLabel, onPress, footChildren,
}: {
  icon:          string;
  title:         string;
  countLabel?:   string;
  onPress:       () => void;
  footChildren?: React.ReactNode;
}) {
  return (
    <View style={styles.hubSection}>
      <TouchableOpacity
        style={styles.hubHeader}
        onPress={onPress}
        activeOpacity={0.7}
      >
        <View style={[styles.hubIcon, { backgroundColor: S.color + '18' }]}>
          <FontAwesome5 name={icon as any} size={13} color={S.color} solid />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.hubTitle}>{title}</Text>
          {countLabel && <Text style={styles.hubCount}>{countLabel}</Text>}
        </View>
        <FontAwesome5 name="chevron-right" size={12} color={S.color} />
      </TouchableOpacity>
      {footChildren && (
        <View style={styles.hubFootRow}>{footChildren}</View>
      )}
    </View>
  );
}

function HubFootLink({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.hubFootLink} onPress={onPress} activeOpacity={0.7}>
      <Text style={[styles.hubFootLinkText, { color: S.color }]}>{label}</Text>
      <FontAwesome5 name="chevron-right" size={9} color={S.color} />
    </TouchableOpacity>
  );
}

function workCountLabel(work: WorkSummary): string {
  const parts: string[] = [];
  if (work.worker.appCount > 0)        parts.push(`${work.worker.appCount} app${work.worker.appCount === 1 ? '' : 's'}`);
  if (work.employer.activeShifts > 0)  parts.push(`${work.employer.activeShifts} posted`);
  return parts.join(' · ') || 'Set up';
}

function fetchCountLabel(fs: FetchSummary): string {
  const parts: string[] = [];
  if (fs.customer.activeCount > 0)      parts.push(`${fs.customer.activeCount} in progress`);
  else if (fs.customer.recentCount > 0) parts.push(`${fs.customer.recentCount} recent`);
  if (fs.driver.activeRuns > 0)         parts.push(`${fs.driver.activeRuns} run${fs.driver.activeRuns === 1 ? '' : 's'}`);
  return parts.join(' · ') || 'Get started';
}

function TransactionRow({ tx }: { tx: WalletTransaction }) {
  const isCredit = tx.amount_pence > 0;
  const config = {
    topup:    { icon: 'arrow-down', color: colors.success, label: 'Top-up' },
    spend:    { icon: 'arrow-up',   color: colors.error,   label: tx.business?.name ?? 'Payment' },
    cashback: { icon: 'gift',       color: S.color,        label: 'Cashback' },
    refund:   { icon: 'undo',       color: colors.warning, label: 'Refund' },
  }[tx.type] ?? { icon: 'circle', color: colors.textMuted, label: tx.type };

  return (
    <View style={styles.txRow}>
      <View style={[styles.txIcon, { backgroundColor: config.color + '18' }]}>
        <FontAwesome5 name={config.icon as any} size={11} color={config.color} solid />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.txLabel} numberOfLines={1}>{config.label}</Text>
        <Text style={styles.txDate}>
          {new Date(tx.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
          {tx.description && ` · ${tx.description}`}
        </Text>
      </View>
      <Text style={[styles.txAmount, { color: isCredit ? colors.success : colors.textPrimary }]}>
        {isCredit ? '+' : ''}{formatPence(tx.amount_pence)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll:  { flex: 1, backgroundColor: colors.screenBackground },
  content:{ paddingBottom: 40 },

  balanceCard: {
    margin: spacing.md, padding: spacing.lg, gap: 12,
    borderRadius: radius.xl,
    shadowColor: '#7C3AED', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 12, elevation: 4,
  },
  balanceLabel:  { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.xs, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  balanceAmount: { color: '#fff', fontSize: 40, fontWeight: '900' },
  payAtTillBtn:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: 'rgba(255,255,255,0.18)', paddingVertical: 12, borderRadius: radius.md, marginTop: 8 },
  payAtTillText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },

  section:      { paddingHorizontal: spacing.md, marginTop: spacing.lg },
  sectionTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary },
  sectionHint:  { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2, marginBottom: 12 },

  topUpRow: { flexDirection: 'row', gap: 8 },
  topUpBtn: {
    flex: 1, paddingVertical: 14, borderRadius: radius.md,
    backgroundColor: S.light, borderWidth: 1.5, borderColor: S.color + '44',
    alignItems: 'center', justifyContent: 'center',
  },
  topUpBtnText: { fontSize: fontSize.sm, fontWeight: '900' },

  txList: { gap: 8 },
  txRow:  {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', borderRadius: radius.md, padding: 12,
    borderWidth: 1, borderColor: colors.border,
  },
  txIcon:   { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  txLabel:  { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  txDate:   { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
  txAmount: { fontSize: fontSize.sm, fontWeight: '900' },

  // ── My Wallet hub sections ───────────────────────────────────────────────
  hubSection: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    overflow: 'hidden',
  },
  hubHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: spacing.md,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  hubIcon:     { width: 32, height: 32, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  hubTitle:    { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary },
  hubCount:    { fontSize: 12, color: colors.textMuted, fontWeight: '600', marginTop: 2 },

  hubFootRow:  { backgroundColor: '#fff', flexDirection: 'row', gap: 6, padding: spacing.md, paddingTop: 6, flexWrap: 'wrap', borderTopWidth: 1, borderTopColor: colors.border },
  hubFootLink: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.full, borderWidth: 1, borderColor: S.color + '40', backgroundColor: S.color + '10' },
  hubFootLinkText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.2 },
});
