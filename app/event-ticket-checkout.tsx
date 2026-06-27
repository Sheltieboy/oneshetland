/**
 * event-ticket-checkout.tsx — Ticket selection + purchase flow
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useStripe } from '@stripe/stripe-react-native';
import * as SecureStore from 'expo-secure-store';
import { colors, fontSize, spacing, radius, shadow } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import { useGoToSignIn } from '@/hooks/useGoToSignIn';
import { useAlert } from '@/components/BrandedAlert';
import { ConfirmPaymentSheet } from '@/components/ConfirmPaymentSheet';
import { fetchWalletBalance } from '@/lib/local-api';
import {
  fetchEvent,
  purchaseTickets, confirmTicketPurchase,
  ticketTypeOnSale, ticketTypeRemaining,
  type OsEvent, type EventTicketType, type LineItem,
} from '@/lib/events-api';

const S = SECTIONS.events;

// Persist raw tokens to SecureStore indexed by ticket ID.
// Runs fire-and-forget — failures are silent so they don't block the UI.
async function persistTokens(ticketIds: string[], tokens: string[]) {
  await Promise.all(
    ticketIds.map((id, i) =>
      tokens[i]
        ? SecureStore.setItemAsync(`event_ticket_token_${id}`, tokens[i]).catch(() => {})
        : Promise.resolve(),
    ),
  );
}

export default function EventTicketCheckoutScreen() {
  const { id }   = useLocalSearchParams<{ id: string }>();
  const router   = useRouter();
  const goToSignIn = useGoToSignIn();
  const { profile } = useAuth();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();
  const { alert } = useAlert();

  const [event,   setEvent]   = useState<OsEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [buying,  setBuying]  = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [purchased, setPurchased] = useState(false);   // inline success state
  const [boughtCount, setBoughtCount] = useState(0);

  useEffect(() => { if (profile?.id) fetchWalletBalance(profile.id).then(setWalletBalance).catch(() => {}); }, [profile?.id]);

  // qty per ticket type
  const [quantities, setQuantities] = useState<Record<string, number>>({});

  const load = useCallback(async () => {
    if (!id) return;
    const ev = await fetchEvent(id).catch(() => null);
    setEvent(ev);
    setLoading(false);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const adjust = (typeId: string, delta: number, max: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setQuantities(prev => {
      const cur = prev[typeId] ?? 0;
      const next = Math.max(0, Math.min(max, cur + delta));
      return { ...prev, [typeId]: next };
    });
  };

  const lineItems: LineItem[] = Object.entries(quantities)
    .filter(([, qty]) => qty > 0)
    .map(([ticket_type_id, quantity]) => ({ ticket_type_id, quantity }));

  const totalPence = lineItems.reduce((sum, li) => {
    const tt = event?.ticket_types?.find(t => t.id === li.ticket_type_id);
    return sum + (tt?.price_pence ?? 0) * li.quantity;
  }, 0);

  const totalTickets = lineItems.reduce((s, li) => s + li.quantity, 0);

  // Buyer-facing booking fee — flat 95p per ticket, free tickets exempt.
  // Must match BOOKING_FEE_PENCE in the create-event-ticket-intent edge function.
  const BOOKING_FEE_PENCE = 95;
  const bookingFeePence = totalPence > 0 ? BOOKING_FEE_PENCE * totalTickets : 0;
  const grandTotalPence = totalPence + bookingFeePence;

  // Paid tickets on a saved card charge silently off-session, so show a confirm
  // step first. Free tickets and the no-saved-card (PaymentSheet) path don't need it.
  const onBuyPress = () => {
    if (!profile) { goToSignIn(`/event-ticket-checkout?id=${id}`); return; }
    if (!event || lineItems.length === 0) return;
    // Paid tickets always open the confirm sheet (wallet AND card; the card
    // path uses Stripe's Payment Sheet which collects a card even if none is
    // saved). Free tickets skip straight through.
    if (grandTotalPence > 0) setConfirming(true);
    else runPurchase();
  };

  // One success confirmation for ALL pay paths (saved-card, PaymentSheet,
  // wallet) so the buyer is always told the tickets are booked + where to find
  // them, instead of being silently bounced back to the purchase sheet.
  const ticketSuccess = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    // Show success INLINE (a screen state), not as an alert. This screen is
    // presented as a modal and the alert lives at the app root, so iOS can't
    // present the alert over it — it gets silently swallowed. Flipping to an
    // in-screen success view (like the gift flow) is reliable.
    setBoughtCount(totalTickets);
    // The ConfirmPaymentSheet stays mounted (just hidden) in the same tree, so
    // it animates closed cleanly when these flip — no unmount-while-visible, so
    // no stuck overlay / frozen screen.
    setConfirming(false);
    setPurchased(true);
  };

  const runPurchase = async () => {
    if (!profile || !event || lineItems.length === 0) return;
    setBuying(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const result = await purchaseTickets({
        event_id:       event.id,
        line_items:     lineItems,
        use_saved_card: !!profile.has_payment_method,
      });

      // Persist each raw token in SecureStore keyed by ticket ID.
      // ticket_ids[i] and tokens[i] are parallel arrays from the edge function.
      await persistTokens(result.ticket_ids ?? [], result.tokens ?? []);

      if (result.free || result.charged) {
        setConfirming(false);
        ticketSuccess();
        return;
      }

      // Standard PaymentSheet flow
      const { clientSecret, order_id } = result;
      if (!clientSecret) throw new Error('Could not start payment');

      const { error: initErr } = await initPaymentSheet({
        merchantDisplayName: 'OneShetland Events',
        paymentIntentClientSecret: clientSecret,
        applePay: { merchantCountryCode: 'GB' },
      });
      if (initErr) throw new Error(initErr.message);

      const { error: sheetErr } = await presentPaymentSheet();
      if (sheetErr) {
        if (sheetErr.code !== 'Canceled') {
          alert({ title: 'Payment failed', message: sheetErr.message });
        }
        setBuying(false);
        return;
      }

      // Confirm server-side
      const piId = clientSecret.split('_secret_')[0];
      await confirmTicketPurchase({ order_id, payment_intent_id: piId });

      setConfirming(false);
      ticketSuccess();

    } catch (e: any) {
      alert({ title: 'Could not complete booking', message: e.message ?? 'Please try again' });
    } finally {
      setBuying(false);
      setConfirming(false);
    }
  };

  // Pay for tickets from the wallet (debits balance, transfers to the organiser).
  const runPurchaseWallet = async () => {
    if (!profile || !event || lineItems.length === 0) return;
    setBuying(true);
    try {
      const result = await purchaseTickets({ event_id: event.id, line_items: lineItems, pay_with_wallet: true });
      await persistTokens(result.ticket_ids ?? [], result.tokens ?? []);
      if (!result.charged) throw new Error('Wallet payment did not complete.');
      setConfirming(false);
      ticketSuccess();
    } catch (e: any) {
      alert({ title: 'Could not complete booking', message: e.message ?? 'Please try again' });
    } finally {
      setBuying(false);
      setConfirming(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      </SafeAreaView>
    );
  }

  if (!event) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}>
          <Text style={styles.errorText}>Event not found.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const ticketTypes = (event.ticket_types ?? []).filter(t => t.is_active);

  return (
    <SafeAreaView style={styles.safe} edges={[]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{purchased ? 'Tickets booked' : 'Get tickets'}</Text>
        <TouchableOpacity style={styles.closeBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="times" size={16} color={colors.textMuted} />
        </TouchableOpacity>
      </View>

      {purchased ? (
        <View style={styles.center}>
          <View style={styles.successIcon}>
            <FontAwesome5 name="ticket-alt" size={30} color={S.color} solid />
          </View>
          <Text style={styles.successTitle}>Tickets booked! 🎟</Text>
          <Text style={styles.successSub}>
            {boughtCount} ticket{boughtCount !== 1 ? 's' : ''} confirmed — you'll find {boughtCount !== 1 ? 'them' : 'it'} any time under My Tickets.
          </Text>
          <TouchableOpacity
            style={[styles.successBtn, { backgroundColor: S.color }]}
            onPress={() => router.replace({ pathname: '/my-event-tickets' } as any)}
            activeOpacity={0.85}
          >
            <Text style={styles.successBtnText}>View my tickets</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 14 }} hitSlop={8}>
            <Text style={styles.successDone}>Done</Text>
          </TouchableOpacity>
        </View>
      ) : (
      <>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>

        {/* Event summary */}
        <View style={styles.eventSummary}>
          <Text style={styles.eventName}>{event.title}</Text>
          <Text style={styles.eventDate}>
            {new Date(event.starts_at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
            {' · '}
            {new Date(event.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
          </Text>
          {event.venue && <Text style={styles.eventVenue}>{event.venue}</Text>}
        </View>

        {/* Ticket types */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Select tickets</Text>
          {ticketTypes.length === 0 ? (
            <View style={styles.noTickets}>
              <Text style={styles.noTicketsText}>No tickets available</Text>
            </View>
          ) : (
            <View style={{ gap: 10 }}>
              {ticketTypes.map(tt => {
                const onSale    = ticketTypeOnSale(tt);
                const remaining = ticketTypeRemaining(tt);
                const almostGone = remaining !== null && remaining <= 10 && remaining > 0;
                const maxQty    = Math.min(
                  tt.per_order_max,
                  remaining !== null ? remaining : tt.per_order_max,
                );
                const qty = quantities[tt.id] ?? 0;

                return (
                  <View key={tt.id} style={styles.ticketTypeRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.ttName}>{tt.name}</Text>
                      {tt.description && <Text style={styles.ttDesc}>{tt.description}</Text>}
                      <View style={{ flexDirection: 'row', gap: 8, marginTop: 4, alignItems: 'center' }}>
                        <Text style={[styles.ttPrice, { color: S.color }]}>
                          {tt.price_pence === 0 ? 'Free' : `£${(tt.price_pence / 100).toFixed(2)}`}
                        </Text>
                        {almostGone && <Text style={styles.almostGone}>Only {remaining} left</Text>}
                        {remaining === 0 && <Text style={styles.soldOut}>Sold out</Text>}
                        {!onSale && remaining !== 0 && <Text style={styles.offSale}>Not on sale</Text>}
                      </View>
                    </View>
                    {onSale && remaining !== 0 ? (
                      <View style={styles.qtyControl}>
                        <TouchableOpacity
                          style={[styles.qtyBtn, qty === 0 && styles.qtyBtnDisabled]}
                          onPress={() => adjust(tt.id, -1, maxQty)}
                          disabled={qty === 0}
                        >
                          <FontAwesome5 name="minus" size={11} color={qty === 0 ? colors.textLight : S.color} />
                        </TouchableOpacity>
                        <Text style={styles.qtyNum}>{qty}</Text>
                        <TouchableOpacity
                          style={[styles.qtyBtn, qty >= maxQty && styles.qtyBtnDisabled]}
                          onPress={() => adjust(tt.id, 1, maxQty)}
                          disabled={qty >= maxQty}
                        >
                          <FontAwesome5 name="plus" size={11} color={qty >= maxQty ? colors.textLight : S.color} />
                        </TouchableOpacity>
                      </View>
                    ) : (
                      <View style={styles.unavailablePill}>
                        <Text style={styles.unavailablePillText}>{remaining === 0 ? 'Sold out' : 'Unavailable'}</Text>
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          )}
        </View>

        {/* Fee breakdown */}
        {totalPence > 0 && totalTickets > 0 && (
          <View style={styles.feeBox}>
            <View style={styles.feeRow}>
              <Text style={styles.feeLabel}>Tickets ({totalTickets})</Text>
              <Text style={styles.feeVal}>£{(totalPence / 100).toFixed(2)}</Text>
            </View>
            <View style={styles.feeRow}>
              <Text style={styles.feeLabel}>Booking fee · 95p × {totalTickets}</Text>
              <Text style={styles.feeVal}>£{(bookingFeePence / 100).toFixed(2)}</Text>
            </View>
            <View style={[styles.feeRow, styles.feeTotalRow]}>
              <Text style={styles.feeTotalLabel}>Total</Text>
              <Text style={styles.feeTotalVal}>£{(grandTotalPence / 100).toFixed(2)}</Text>
            </View>
            <Text style={styles.feeNote}>
              A small 95p booking fee per ticket helps keep OneShetland running — organisers receive the full ticket price.
            </Text>
          </View>
        )}

        <View style={{ height: 100 }} />
      </ScrollView>

      {/* Checkout bar */}
      <View style={styles.ctaBar}>
        <View>
          <Text style={styles.ctaTotalLabel}>Total</Text>
          <Text style={styles.ctaTotal}>
            {totalPence === 0 && totalTickets > 0 ? 'Free' : `£${(grandTotalPence / 100).toFixed(2)}`}
          </Text>
          {totalTickets > 0 && (
            <Text style={styles.ctaTicketCount}>
              {totalTickets} ticket{totalTickets !== 1 ? 's' : ''}
            </Text>
          )}
        </View>
        <TouchableOpacity
          style={[
            styles.ctaBtn,
            { backgroundColor: totalTickets === 0 || buying ? colors.border : S.color },
          ]}
          onPress={onBuyPress}
          disabled={totalTickets === 0 || buying}
          activeOpacity={0.85}
        >
          {buying ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <>
              <FontAwesome5 name="ticket-alt" size={13} color={totalTickets === 0 ? colors.textMuted : '#fff'} solid />
              <Text style={[styles.ctaBtnText, totalTickets === 0 && { color: colors.textMuted }]}>
                {totalPence === 0 && totalTickets > 0 ? 'Reserve free tickets' : 'Confirm & pay'}
              </Text>
            </>
          )}
        </TouchableOpacity>
      </View>
      </>
      )}

      <ConfirmPaymentSheet
        visible={confirming}
        itemName={`${totalTickets} ticket${totalTickets !== 1 ? 's' : ''} — ${event.title}`}
        lineItems={[
          { label: 'Tickets', amountPence: totalPence },
          ...(bookingFeePence > 0 ? [{ label: 'Booking fee', amountPence: bookingFeePence, muted: true }] : []),
        ]}
        totalPence={grandTotalPence}
        payingWith="Saved card"
        policy={{ text: event.refund_policy || 'Tickets are non-refundable unless the event is cancelled.' }}
        loading={buying}
        onConfirm={runPurchase}
        onCancel={() => setConfirming(false)}
        walletBalancePence={walletBalance}
        onConfirmWallet={runPurchaseWallet}
        onTopUp={() => { setConfirming(false); router.push('/local-wallet' as any); }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.screenBackground },
  scroll: { flex: 1, backgroundColor: colors.screenBackground },
  content:{ paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.screenBackground },
  errorText: { fontSize: fontSize.md, color: colors.textMuted },

  successIcon: {
    width: 76, height: 76, borderRadius: 38, backgroundColor: '#EAF2FB',
    alignItems: 'center', justifyContent: 'center', marginBottom: spacing.lg,
  },
  successTitle: { fontSize: fontSize.xl, fontWeight: '900', color: colors.textPrimary, textAlign: 'center' },
  successSub: {
    fontSize: fontSize.sm, color: colors.textSecondary, textAlign: 'center',
    paddingHorizontal: spacing.xl, lineHeight: 22, marginTop: spacing.sm,
  },
  successBtn: {
    marginTop: spacing.xl, borderRadius: radius.lg,
    paddingVertical: 15, paddingHorizontal: spacing.xxl, alignItems: 'center',
  },
  successBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
  successDone: { color: colors.textMuted, fontSize: fontSize.sm, fontWeight: '700' },

  header: {
    backgroundColor: colors.screenBackground,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingTop: spacing.md, paddingBottom: 10,
  },
  headerTitle: { color: colors.textPrimary, fontSize: fontSize.lg, fontWeight: '900' },

  feeBox: {
    marginHorizontal: spacing.md, marginTop: spacing.lg,
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: 14, gap: 8,
  },
  feeRow:        { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  feeLabel:      { fontSize: fontSize.sm, color: colors.textSecondary },
  feeVal:        { fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: '700' },
  feeTotalRow:   { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 8, marginTop: 2 },
  feeTotalLabel: { fontSize: fontSize.md, color: colors.textPrimary, fontWeight: '900' },
  feeTotalVal:   { fontSize: fontSize.md, color: colors.textPrimary, fontWeight: '900' },
  feeNote:       { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 16, marginTop: 2 },
  closeBtn: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.border + '80',
  },

  eventSummary: {
    backgroundColor: colors.navy, paddingHorizontal: spacing.md,
    paddingBottom: spacing.lg, paddingTop: 4, gap: 3,
  },
  eventName:  { color: '#fff', fontSize: fontSize.lg, fontWeight: '900' },
  eventDate:  { color: S.color, fontSize: fontSize.sm, fontWeight: '700' },
  eventVenue: { color: 'rgba(255,255,255,0.6)', fontSize: fontSize.xs },

  section:      { padding: spacing.md, paddingBottom: 0 },
  sectionTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary, marginBottom: 10 },
  noTickets:    { padding: spacing.lg, alignItems: 'center' },
  noTicketsText:{ fontSize: fontSize.sm, color: colors.textMuted },

  ticketTypeRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: 12,
    ...shadow.card,
  },
  ttName:     { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  ttDesc:     { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
  ttPrice:    { fontSize: fontSize.sm, fontWeight: '900' },
  almostGone: { fontSize: fontSize.xs, color: colors.warning, fontWeight: '700' },
  soldOut:    { fontSize: fontSize.xs, color: colors.error,   fontWeight: '700' },
  offSale:    { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600' },

  qtyControl: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  qtyBtn: {
    width: 32, height: 32, borderRadius: 16,
    borderWidth: 1.5, borderColor: S.color + '60',
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: S.light,
  },
  qtyBtnDisabled: { borderColor: colors.border, backgroundColor: '#fff' },
  qtyNum: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary, minWidth: 20, textAlign: 'center' },

  unavailablePill: {
    paddingHorizontal: 10, paddingVertical: 6,
    backgroundColor: colors.border, borderRadius: radius.full,
  },
  unavailablePillText: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '700' },

  ctaBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingLeft: spacing.lg, paddingRight: spacing.md,
    paddingTop: 12, paddingBottom: 20,
    backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: colors.border,
    ...shadow.strong,
  },
  ctaTotalLabel: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '700' },
  ctaTotal:      { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary },
  ctaTicketCount:{ fontSize: fontSize.xs, color: colors.textMuted },
  ctaBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 20, paddingVertical: 14, borderRadius: radius.md, minWidth: 160,
    justifyContent: 'center',
  },
  ctaBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '900' },
});
