/**
 * my-event-tickets.tsx — Wallet: list of the user's event tickets
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius, shadow } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
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
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My Tickets</Text>
        <View style={{ width: 60 }} />
      </View>

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
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      ) : filtered.length === 0 ? (
        <View style={styles.center}>
          <FontAwesome5 name="ticket-alt" size={36} color={S.color + '60'} solid />
          <Text style={styles.emptyTitle}>No {tab} tickets</Text>
          {tab === 'upcoming' && (
            <TouchableOpacity
              style={[styles.exploreBtn, { backgroundColor: S.color }]}
              onPress={() => router.push('/(tabs)/whats-on')}
              activeOpacity={0.85}
            >
              <Text style={styles.exploreBtnText}>Browse What's On</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={S.color} />}
          renderItem={({ item }) => (
            <TicketRow ticket={item} onPress={() => router.push({ pathname: '/my-event-ticket', params: { id: item.id } })} />
          )}
        />
      )}
    </SafeAreaView>
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
  safe:   { flex: 1, backgroundColor: colors.navy },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12, backgroundColor: colors.screenBackground },

  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12, borderBottomWidth: 2,
  },
  backBtn:     { flexDirection: 'row', alignItems: 'center', gap: 8, width: 60 },
  backText:    { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },

  tabRow:  { flexDirection: 'row', backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: colors.border },
  tabBtn:  { flex: 1, alignItems: 'center', paddingVertical: 12, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textMuted },

  emptyTitle:    { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  exploreBtn:    { marginTop: 8, paddingHorizontal: 20, paddingVertical: 12, borderRadius: radius.md },
  exploreBtnText:{ color: '#fff', fontSize: fontSize.sm, fontWeight: '900' },

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
