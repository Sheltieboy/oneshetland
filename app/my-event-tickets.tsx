/**
 * my-event-tickets.tsx — Wallet: list of the user's event tickets
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  RefreshControl, Image,
} from 'react-native';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius, shadow, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { useAuth } from '@/context/AuthContext';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingState } from '@/components/ui/LoadingState';
import {
  fetchMyEventTickets,
  formatShortDate, formatTime,
  type EventTicket,
} from '@/lib/events-api';

const S = SECTIONS.events;

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  valid:           { label: 'Valid',            color: colors.success },
  used:            { label: 'Used',             color: colors.textMuted },
  pending_payment: { label: 'Awaiting payment', color: colors.warning },
  cancelled:       { label: 'Cancelled',        color: colors.error },
  refunded:        { label: 'Refunded',         color: colors.textMuted },
};

export default function MyEventTicketsScreen() {
  const router    = useRouter();
  const { profile } = useAuth();
  const { screenWidth } = useAppLayout();

  const [tickets,   setTickets]   = useState<EventTicket[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [refreshing,setRefreshing]= useState(false);

  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');

  const load = useCallback(async () => {
    if (!profile) return;
    try {
      const data = await fetchMyEventTickets(profile.id);
      setTickets(data);
    } catch {}
    setLoading(false);
    setRefreshing(false);
  }, [profile?.id]);

  useEffect(() => { load(); }, [load]);

  const now = new Date().toISOString();
  const filtered = tickets.filter(t => {
    const starts = t.event?.starts_at ?? '';
    return tab === 'upcoming' ? starts >= now : starts < now;
  });

  return (
    <ScreenScaffold header={<ScreenHeader title="My Tickets" accent={S.color} />}>
      {/* Tabs */}
      <View style={styles.tabRow}>
        {(['upcoming', 'past'] as const).map(t => (
          <TouchableOpacity
            key={t}
            style={[styles.tabBtn, tab === t && { borderBottomColor: S.color, borderBottomWidth: 2 }]}
            onPress={() => setTab(t)}
            activeOpacity={0.8}
          >
            <Text style={[styles.tabText, tab === t && { color: S.color }]}>
              {t === 'upcoming' ? 'Upcoming' : 'Past'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <LoadingState accent={S.color} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="ticket-alt"
          title={`No ${tab} tickets`}
          accent={S.color}
          variant="card"
          actionLabel={tab === 'upcoming' ? "Browse What's On" : undefined}
          onAction={tab === 'upcoming' ? () => router.push('/(tabs)/whats-on') : undefined}
        />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={item => item.id}
          contentContainerStyle={[styles.list, contentContainer(screenWidth)]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={S.color} />}
          renderItem={({ item }) => (
            <TicketRow ticket={item} onPress={() => router.push({ pathname: '/my-event-ticket', params: { id: item.id } })} />
          )}
        />
      )}
    </ScreenScaffold>
  );
}

function TicketRow({ ticket, onPress }: { ticket: EventTicket; onPress: () => void }) {
  const event     = ticket.event;
  const statusCfg = STATUS_CONFIG[ticket.status] ?? { label: ticket.status, color: colors.textMuted };
  const isPast    = event?.starts_at && event.starts_at < new Date().toISOString();

  return (
    <TouchableOpacity style={[styles.ticketRow, isPast && styles.ticketRowPast]} onPress={onPress} activeOpacity={0.85}>
      {event?.cover_url ? (
        <Image source={{ uri: event.cover_url }} style={styles.ticketThumb} />
      ) : (
        <View style={[styles.ticketThumb, { backgroundColor: S.color + '20', alignItems: 'center', justifyContent: 'center' }]}>
          <FontAwesome5 name="calendar-alt" size={18} color={S.color} />
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Text style={styles.ticketTitle} numberOfLines={2}>{event?.title ?? 'Event'}</Text>
        {event?.starts_at && (
          <Text style={styles.ticketDate}>
            {formatShortDate(event.starts_at)} · {formatTime(event.starts_at)}
          </Text>
        )}
        {event?.venue && <Text style={styles.ticketVenue} numberOfLines={1}>{event.venue}</Text>}
        <View style={styles.ticketMeta}>
          <Text style={styles.ticketTypeName}>{ticket.ticket_type?.name}</Text>
          <View style={[styles.statusPill, { backgroundColor: statusCfg.color + '20' }]}>
            <Text style={[styles.statusPillText, { color: statusCfg.color }]}>{statusCfg.label}</Text>
          </View>
        </View>
      </View>
      <FontAwesome5 name="chevron-right" size={11} color={colors.textLight} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  tabRow:  { flexDirection: 'row', backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: colors.border },
  tabBtn:  { flex: 1, alignItems: 'center', paddingVertical: 12, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textMuted },

  list: { padding: spacing.md, gap: 10, backgroundColor: colors.screenBackground },

  ticketRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, overflow: 'hidden',
    padding: 10,
    ...shadow.card,
  },
  ticketRowPast:  { opacity: 0.7 },
  ticketThumb:    { width: 60, height: 60, borderRadius: radius.md, resizeMode: 'cover', flexShrink: 0 },
  ticketTitle:    { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary, lineHeight: 18 },
  ticketDate:     { fontSize: fontSize.xs, color: S.color, fontWeight: '700', marginTop: 2 },
  ticketVenue:    { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  ticketMeta:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  ticketTypeName: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600' },
  statusPill:     { paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.full },
  statusPillText: { fontSize: 10, fontWeight: '800' },
});
