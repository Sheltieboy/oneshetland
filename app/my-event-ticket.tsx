/**
 * my-event-ticket.tsx — Individual ticket with QR code and backup code
 *
 * The raw_token for QR display is loaded from SecureStore (persisted after
 * purchase). If not present (e.g. older purchase) we show backup code only.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Share,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import QRCode from 'react-native-qrcode-svg';
import { colors, fontSize, spacing, radius, shadow, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { IconButton } from '@/components/ui/IconButton';
import { LoadingState } from '@/components/ui/LoadingState';
import { EmptyState } from '@/components/ui/EmptyState';
import { useAuth } from '@/context/AuthContext';
import { useAlert } from '@/components/BrandedAlert';
import {
  fetchTicketWithToken,
  formatEventDate,
  type EventTicket,
} from '@/lib/events-api';

const S  = SECTIONS.events;
const SE = SECTIONS.local;

function ticketTokenKey(ticketId: string) { return `event_ticket_token_${ticketId}`; }

export async function persistTicketToken(ticketId: string, rawToken: string) {
  try { await SecureStore.setItemAsync(ticketTokenKey(ticketId), rawToken); } catch {}
}

export default function MyEventTicketScreen() {
  const { id }    = useLocalSearchParams<{ id: string }>();
  const router    = useRouter();
  const { profile } = useAuth();
  const { screenWidth } = useAppLayout();
  const { alert } = useAlert();

  const [ticket,   setTicket]   = useState<EventTicket | null>(null);
  const [rawToken, setRawToken] = useState<string | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [brightness, setBrightness] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [t, tok] = await Promise.all([
        fetchTicketWithToken(id),
        SecureStore.getItemAsync(ticketTokenKey(id)).catch(() => null),
      ]);
      setTicket(t);
      setRawToken(tok);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <ScreenScaffold header={<ScreenHeader title="My Ticket" accent={S.color} />}>
        <LoadingState accent={S.color} />
      </ScreenScaffold>
    );
  }

  if (!ticket) {
    return (
      <ScreenScaffold header={<ScreenHeader title="My Ticket" accent={S.color} />}>
        <EmptyState
          icon="ticket-alt"
          title="Ticket not found"
          accent={S.color}
          variant="card"
          actionLabel="Go back"
          onAction={() => router.back()}
        />
      </ScreenScaffold>
    );
  }

  const event        = ticket.event;
  const ticketType   = ticket.ticket_type;
  const isUsed       = ticket.status === 'used';
  const isCancelled  = ticket.status === 'cancelled' || ticket.status === 'refunded';
  const isPending    = ticket.status === 'pending_payment';

  return (
    <ScreenScaffold
      header={
        <ScreenHeader
          title="My Ticket"
          accent={S.color}
          rightElement={
            <IconButton
              icon="share-alt"
              color={S.color}
              onPress={() => Share.share({ message: `My ticket for ${event?.title ?? 'an event'}. Backup code: ${ticket.backup_code}` })}
              accessibilityLabel="Share ticket"
            />
          }
        />
      }
    >
      <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, contentContainer(screenWidth)]}>

        {/* Status banners */}
        {isPending && (
          <View style={[styles.banner, { backgroundColor: colors.warningLight }]}>
            <FontAwesome5 name="clock" size={13} color={colors.warning} />
            <Text style={[styles.bannerText, { color: colors.warning }]}>
              Payment pending — ticket not yet valid
            </Text>
          </View>
        )}
        {isUsed && (
          <View style={[styles.banner, { backgroundColor: colors.border }]}>
            <FontAwesome5 name="check-circle" size={13} color={colors.textMuted} />
            <Text style={[styles.bannerText, { color: colors.textMuted }]}>
              This ticket was scanned on{' '}
              {ticket.checked_in_at
                ? new Date(ticket.checked_in_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
                : 'entry'}
            </Text>
          </View>
        )}
        {isCancelled && (
          <View style={[styles.banner, { backgroundColor: colors.errorLight }]}>
            <FontAwesome5 name="times-circle" size={13} color={colors.error} />
            <Text style={[styles.bannerText, { color: colors.error }]}>
              This ticket has been {ticket.status}
            </Text>
          </View>
        )}

        {/* QR code */}
        <View style={styles.qrSection}>
          <View style={[styles.qrCard, (isUsed || isCancelled) && styles.qrCardDimmed]}>
            {rawToken && !isCancelled && !isPending ? (
              <>
                <QRCode
                  value={rawToken}
                  size={220}
                  color={isUsed ? colors.textMuted : colors.textPrimary}
                  backgroundColor="#fff"
                />
                {isUsed && (
                  <View style={styles.usedOverlay}>
                    <FontAwesome5 name="check-circle" size={48} color={colors.success} solid />
                    <Text style={styles.usedOverlayText}>Scanned</Text>
                  </View>
                )}
              </>
            ) : isPending ? (
              <View style={styles.qrPending}>
                <FontAwesome5 name="lock" size={40} color={colors.textLight} />
                <Text style={styles.qrPendingText}>Awaiting payment</Text>
              </View>
            ) : (
              <View style={styles.qrPending}>
                <FontAwesome5 name="ticket-alt" size={40} color={colors.textLight} solid />
                <Text style={styles.qrPendingText}>QR not available{'\n'}Use backup code below</Text>
              </View>
            )}
          </View>

          {!isCancelled && !isPending && (
            <Text style={styles.qrHint}>
              {isUsed ? 'Already scanned at entry' : 'Show QR code to staff at entry'}
            </Text>
          )}
        </View>

        {/* Backup code */}
        {!isCancelled && !isPending && (
          <View style={styles.backupSection}>
            <Text style={styles.backupLabel}>Backup code</Text>
            <TouchableOpacity
              onPress={() => {
                alert({ title: 'Backup code', message: ticket.backup_code, actions: [{ label: 'OK', style: 'primary' }] });
              }}
              activeOpacity={0.8}
            >
              <Text style={styles.backupCode}>{ticket.backup_code}</Text>
            </TouchableOpacity>
            <Text style={styles.backupHint}>Tell staff this code if QR doesn't scan</Text>
          </View>
        )}

        {/* Event info */}
        <View style={styles.eventInfoCard}>
          <Text style={styles.eventTitle}>{event?.title ?? 'Event'}</Text>
          {event?.starts_at && (
            <View style={styles.eventInfoRow}>
              <FontAwesome5 name="calendar" size={12} color={S.color} />
              <Text style={styles.eventInfoText}>
                {formatEventDate(event.starts_at)}
              </Text>
            </View>
          )}
          {event?.venue && (
            <View style={styles.eventInfoRow}>
              <FontAwesome5 name="map-marker-alt" size={12} color={S.color} />
              <Text style={styles.eventInfoText}>{event.venue}</Text>
            </View>
          )}
          <View style={styles.divider} />
          <View style={styles.ticketDetailRow}>
            <Text style={styles.ticketDetailLabel}>Ticket type</Text>
            <Text style={styles.ticketDetailValue}>{ticketType?.name ?? '—'}</Text>
          </View>
          {ticket.attendee_name && (
            <View style={styles.ticketDetailRow}>
              <Text style={styles.ticketDetailLabel}>Name</Text>
              <Text style={styles.ticketDetailValue}>{ticket.attendee_name}</Text>
            </View>
          )}
          <View style={styles.ticketDetailRow}>
            <Text style={styles.ticketDetailLabel}>Price paid</Text>
            <Text style={styles.ticketDetailValue}>
              {ticket.price_pence === 0 ? 'Free' : `£${(ticket.price_pence / 100).toFixed(2)}`}
            </Text>
          </View>
          <View style={styles.ticketDetailRow}>
            <Text style={styles.ticketDetailLabel}>Order ref</Text>
            <Text style={[styles.ticketDetailValue, { fontFamily: 'monospace', fontSize: fontSize.xs }]}>
              {ticket.order_id.slice(0, 8).toUpperCase()}
            </Text>
          </View>
        </View>

        {/* View event button */}
        {event && (
          <TouchableOpacity
            style={styles.viewEventBtn}
            onPress={() => router.push({ pathname: '/events/[id]', params: { id: event.id } })}
            activeOpacity={0.8}
          >
            <FontAwesome5 name="calendar-alt" size={12} color={S.color} />
            <Text style={[styles.viewEventBtnText, { color: S.color }]}>View event details</Text>
            <FontAwesome5 name="chevron-right" size={10} color={S.color} />
          </TouchableOpacity>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: colors.screenBackground },
  content:{ paddingBottom: 40 },

  banner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: spacing.md, marginTop: spacing.md,
    padding: 12, borderRadius: radius.md,
  },
  bannerText: { fontSize: fontSize.xs, fontWeight: '700', flex: 1 },

  qrSection: { alignItems: 'center', paddingVertical: spacing.xl, gap: 12 },
  qrCard: {
    backgroundColor: '#fff',
    padding: 20, borderRadius: radius.xl,
    borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
    ...shadow.card,
  },
  qrCardDimmed: { opacity: 0.5 },
  usedOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.85)',
    borderRadius: radius.xl, gap: 8,
  },
  usedOverlayText: { fontSize: fontSize.md, fontWeight: '900', color: colors.success },
  qrPending: { width: 220, height: 220, alignItems: 'center', justifyContent: 'center', gap: 12 },
  qrPendingText: { fontSize: fontSize.xs, color: colors.textMuted, textAlign: 'center', fontWeight: '600' },
  qrHint: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600' },

  backupSection: { alignItems: 'center', gap: 4, paddingBottom: spacing.lg },
  backupLabel:   { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  backupCode: {
    fontSize: fontSize.xl, fontWeight: '900', color: colors.textPrimary,
    letterSpacing: 4, fontFamily: 'monospace',
    backgroundColor: '#fff', borderWidth: 1.5, borderColor: S.color + '40',
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: radius.md,
    marginVertical: 4,
  },
  backupHint: { fontSize: fontSize.xs, color: colors.textMuted },

  eventInfoCard: {
    marginHorizontal: spacing.md, marginBottom: spacing.md,
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: spacing.md, gap: 8,
    ...shadow.card,
  },
  eventTitle:     { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary },
  eventInfoRow:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  eventInfoText:  { fontSize: fontSize.xs, color: colors.textSecondary, flex: 1 },
  divider:        { height: 1, backgroundColor: colors.border, marginVertical: 4 },
  ticketDetailRow:{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  ticketDetailLabel: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600' },
  ticketDetailValue: { fontSize: fontSize.xs, color: colors.textPrimary, fontWeight: '800' },

  viewEventBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    marginHorizontal: spacing.md,
    paddingVertical: 12, borderRadius: radius.md,
    borderWidth: 1.5, borderColor: S.color + '60',
    backgroundColor: S.color + '10',
  },
  viewEventBtnText: { fontSize: fontSize.sm, fontWeight: '700' },
});
