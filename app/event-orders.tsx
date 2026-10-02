/**
 * event-orders.tsx — Organiser ticket orders for one event.
 *
 * Who bought tickets, each order's detail, and — for the people allowed to move
 * the money — refunding an order.
 *
 * Params: id (event ID)
 *
 * Nothing sensitive is decided here. The list comes from get_event_orders, which
 * refuses anyone who may not manage the event; whether the Refund button
 * appears is the server's `refundable` flag for this viewer and this order; and
 * the refund itself is the existing refund-payment function, addressed by the
 * ORDER id, which re-checks authority, refunds the customer, reverses the
 * merchant transfer, refunds the platform fee and voids the tickets.
 */

import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Modal,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius, shadow } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAlert } from '@/components/BrandedAlert';
import {
  fetchOrganiserOrders, refundEventOrder, formatEventDate,
  type OrganiserOrder, type OrganiserOrders,
} from '@/lib/events-api';
import {
  pounds, purchaserLabel, ticketSummary, orderStatusBadge, checkedInLabel,
  ticketStatusLabel, refundConfirmation,
} from '@/lib/event-orders-utils';

const S = SECTIONS.events;

const TONE: Record<'ok' | 'warn' | 'muted' | 'danger', { fg: string; bg: string }> = {
  ok:     { fg: colors.successDark, bg: colors.successLight },
  warn:   { fg: colors.warningDark, bg: colors.warningLight },
  muted:  { fg: colors.textMuted,   bg: '#F3F4F6' },
  danger: { fg: '#991B1B',          bg: '#FEE2E2' },
};

export default function EventOrdersScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { alert } = useAlert();

  const [data, setData]             = useState<OrganiserOrders | null>(null);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refunding, setRefunding]   = useState(false);

  const load = useCallback(async () => {
    try {
      if (!id) { setError('No event was given.'); return; }
      setData(await fetchOrganiserOrders(id));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load ticket orders.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const selected = data?.orders.find((o) => o.id === selectedId) ?? null;

  const confirmRefund = (order: OrganiserOrder) => {
    if (refunding) return;
    const c = refundConfirmation(order);
    alert({
      title: c.title,
      message: c.message,
      icon: 'undo',
      accent: '#991B1B',
      dismissible: false,
      actions: [
        { label: 'Cancel', style: 'cancel' },
        {
          label: c.confirmLabel, style: 'destructive',
          onPress: async () => {
            setRefunding(true);
            try {
              await refundEventOrder(order.id);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
              await load();
              alert({
                title: 'Refunded',
                message: `${pounds(order.total_pence)} has been refunded to ${purchaserLabel(order)}. Their ${order.tickets_count === 1 ? 'ticket is' : 'tickets are'} no longer valid.`,
              });
            } catch (e) {
              alert({ title: 'Refund failed', message: e instanceof Error ? e.message : 'The refund could not be completed.' });
              await load();
            } finally {
              setRefunding(false);
            }
          },
        },
      ],
    });
  };

  if (loading) {
    return <View style={styles.center}><ActivityIndicator color={S.color} /></View>;
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Ticket orders</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={S.color} />}
      >
        {error ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>Could not load orders</Text>
            <Text style={styles.emptyText}>{error}</Text>
          </View>
        ) : data && data.orders.length === 0 ? (
          <View style={styles.emptyCard}>
            <FontAwesome5 name="ticket-alt" size={22} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>No ticket orders yet</Text>
            <Text style={styles.emptyText}>Orders appear here as soon as someone buys tickets.</Text>
          </View>
        ) : data ? (
          <>
            <Text style={styles.countLine}>
              {data.total_orders} order{data.total_orders === 1 ? '' : 's'}
              {data.total_orders > data.orders.length ? ` · showing the latest ${data.orders.length}` : ''}
            </Text>
            {data.orders.map((o) => {
              const badge = orderStatusBadge(o);
              const checked = checkedInLabel(o);
              return (
                <TouchableOpacity key={o.id} style={styles.card} activeOpacity={0.85} onPress={() => setSelectedId(o.id)}>
                  <View style={styles.cardTop}>
                    <Text style={styles.name} numberOfLines={1}>{purchaserLabel(o)}</Text>
                    <View style={[styles.badge, { backgroundColor: TONE[badge.tone].bg }]}>
                      <Text style={[styles.badgeText, { color: TONE[badge.tone].fg }]}>{badge.label}</Text>
                    </View>
                  </View>
                  {o.purchaser.name && o.purchaser.email ? <Text style={styles.email} numberOfLines={1}>{o.purchaser.email}</Text> : null}
                  <Text style={styles.meta}>{ticketSummary(o)}</Text>
                  <View style={styles.cardBottom}>
                    <Text style={styles.amount}>{pounds(o.total_pence)}</Text>
                    <Text style={styles.metaSmall}>
                      {formatEventDate(o.paid_at ?? o.created_at)}
                      {checked ? `  ·  ${checked}` : ''}
                    </Text>
                  </View>
                  {o.status === 'refunded' && o.refunded_at
                    ? <Text style={styles.refundedLine}>Refunded {formatEventDate(o.refunded_at)}</Text>
                    : null}
                </TouchableOpacity>
              );
            })}
          </>
        ) : null}
      </ScrollView>

      <Modal visible={!!selected} animationType="slide" transparent onRequestClose={() => setSelectedId(null)}>
        <View style={styles.sheetBackdrop}>
          <View style={styles.sheet}>
            {selected ? (
              <OrderDetail
                order={selected}
                canRefundAny={!!data?.can_refund}
                isAdmin={!!data?.is_admin}
                refunding={refunding}
                onClose={() => setSelectedId(null)}
                onRefund={() => confirmRefund(selected)}
              />
            ) : null}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function OrderDetail({ order, canRefundAny, isAdmin, refunding, onClose, onRefund }: {
  order: OrganiserOrder; canRefundAny: boolean; isAdmin: boolean; refunding: boolean;
  onClose: () => void; onRefund: () => void;
}) {
  const badge = orderStatusBadge(order);
  return (
    <>
      <View style={styles.sheetHeader}>
        <Text style={styles.sheetTitle}>Order</Text>
        <TouchableOpacity onPress={onClose} hitSlop={12}><FontAwesome5 name="times" size={18} color={colors.textMuted} /></TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        <View style={styles.rowBetween}>
          <Text style={styles.name}>{purchaserLabel(order)}</Text>
          <View style={[styles.badge, { backgroundColor: TONE[badge.tone].bg }]}>
            <Text style={[styles.badgeText, { color: TONE[badge.tone].fg }]}>{badge.label}</Text>
          </View>
        </View>
        {order.purchaser.email ? <Text style={styles.email}>{order.purchaser.email}</Text> : null}

        <Text style={styles.sectionLabel}>Payment</Text>
        <Row label="Paid" value={pounds(order.total_pence)} strong />
        {order.total_pence > 0 ? <Row label="Tickets" value={pounds(order.ticket_subtotal_pence)} /> : null}
        {order.booking_fee_pence > 0 ? <Row label="Booking fee" value={pounds(order.booking_fee_pence)} /> : null}
        <Row label="Purchased" value={formatEventDate(order.paid_at ?? order.created_at)} />
        {order.status === 'refunded' ? (
          <Row label="Refunded" value={order.refunded_at ? `${pounds(order.total_pence)} · ${formatEventDate(order.refunded_at)}` : pounds(order.total_pence)} />
        ) : null}
        <Row label="Order" value={order.id.slice(0, 8)} />
        {isAdmin && order.payment_intent_id ? <Row label="Payment ref" value={order.payment_intent_id} /> : null}
        {isAdmin && order.reconciliation_state ? <Row label="Reconciliation" value={order.reconciliation_state} /> : null}

        <Text style={styles.sectionLabel}>Tickets ({order.tickets_count})</Text>
        {order.tickets.map((t) => (
          <View key={t.id} style={styles.ticketRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.ticketName}>{t.ticket_type ?? 'Ticket'}</Text>
              {t.attendee_name || t.attendee_email ? (
                <Text style={styles.metaSmall}>{[t.attendee_name, t.attendee_email].filter(Boolean).join(' · ')}</Text>
              ) : null}
              {t.checked_in_at ? <Text style={styles.metaSmall}>Checked in {formatEventDate(t.checked_in_at)}</Text> : null}
            </View>
            <Text style={[styles.ticketStatus, t.status === 'refunded' && { color: '#991B1B' }]}>{ticketStatusLabel(t.status)}</Text>
          </View>
        ))}
      </ScrollView>

      {order.refundable ? (
        <TouchableOpacity
          style={[styles.refundBtn, refunding && { opacity: 0.5 }]}
          disabled={refunding}
          activeOpacity={0.85}
          onPress={onRefund}
        >
          {refunding ? <ActivityIndicator color="#fff" /> : <Text style={styles.refundBtnText}>Refund order</Text>}
        </TouchableOpacity>
      ) : order.status === 'paid' && order.total_pence > 0 && !canRefundAny ? (
        <Text style={styles.noRefundNote}>Only the business owner, or OneShetland, can refund this order.</Text>
      ) : null}
    </>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.rowBetween}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, strong && { fontWeight: '900' }]} selectable>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: colors.navy },
  scroll:  { flex: 1, backgroundColor: colors.screenBackground },
  content: { padding: spacing.md, paddingBottom: 40, gap: 10 },
  center:  { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.screenBackground },

  header: {
    backgroundColor: colors.navy, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
  },
  backBtn:     { flexDirection: 'row', alignItems: 'center', gap: 8, width: 60 },
  backText:    { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { flex: 1, color: '#fff', fontSize: fontSize.md, fontWeight: '800', textAlign: 'center', marginHorizontal: 8 },

  countLine: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '700' },
  card: {
    backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    padding: 14, gap: 4, ...shadow.card,
  },
  cardTop:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  cardBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  name:       { flex: 1, fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary },
  email:      { fontSize: fontSize.sm, color: colors.textMuted },
  meta:       { fontSize: fontSize.sm, color: colors.textSecondary, fontWeight: '600' },
  metaSmall:  { fontSize: fontSize.xs, color: colors.textMuted },
  amount:     { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary },
  refundedLine: { fontSize: fontSize.xs, color: '#991B1B', fontWeight: '700' },
  badge:      { paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.full },
  badgeText:  { fontSize: fontSize.xs, fontWeight: '800' },

  emptyCard: {
    backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    padding: 24, alignItems: 'center', gap: 8,
  },
  emptyTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary },
  emptyText:  { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },

  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: spacing.md, maxHeight: '85%',
  },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  sheetTitle:  { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary },
  sectionLabel: { marginTop: 16, marginBottom: 6, fontSize: fontSize.xs, fontWeight: '900', color: colors.textMuted, textTransform: 'uppercase' },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 3 },
  rowLabel:   { fontSize: fontSize.sm, color: colors.textMuted },
  rowValue:   { fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: '700', flexShrink: 1, textAlign: 'right' },
  ticketRow:  { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border },
  ticketName: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  ticketStatus: { fontSize: fontSize.xs, fontWeight: '800', color: colors.textSecondary },

  refundBtn: {
    marginTop: 8, backgroundColor: '#991B1B', borderRadius: radius.lg, paddingVertical: 14, alignItems: 'center',
  },
  refundBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '900' },
  noRefundNote:  { marginTop: 8, fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },
});
