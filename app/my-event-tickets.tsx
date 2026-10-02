/**
 * my-event-tickets.tsx — Wallet: list of the user's event tickets
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  RefreshControl, Image,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius, shadow, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { TicketCelebration } from '@/components/TicketCelebration';
import { ticketCelebrations } from '@/lib/ticket-celebration-store';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingState } from '@/components/ui/LoadingState';
import {
  fetchMyEventTickets,
  formatShortDate, formatTime,
  type EventTicket,
} from '@/lib/events-api';
import {
  splitTickets, ticketLifecycle, ticketHistoryLines,
  type TicketLifecycle, type TicketState,
} from '@/lib/ticket-lifecycle';

const S = SECTIONS.events;

// The pill colour for each lifecycle state. The WORDS come from ticketLifecycle()
// so web and mobile cannot drift; only the colour is this screen's.
const STATE_COLOR: Record<TicketState, string> = {
  valid:           colors.success,
  postponed:       colors.warning,
  checked_in:      colors.success,
  refunded:        colors.textMuted,
  void:            colors.error,
  event_cancelled: colors.error,
  event_ended:     colors.textMuted,
};

const longDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' });

export default function MyEventTicketsScreen() {
  const router    = useRouter();
  const { profile } = useAuth();
  const { screenWidth } = useAppLayout();

  const [tickets,   setTickets]   = useState<EventTicket[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [refreshing,setRefreshing]= useState(false);

  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const [celebrate, setCelebrate] = useState(false);

  const load = useCallback(async () => {
    if (!profile) return;
    try {
      const data = await fetchMyEventTickets(profile.id);
      setTickets(data);
      // Same once-only rule as the ticket screen: a valid → used change this
      // device saw celebrates once; a ticket met already used never does.
      // Only while focused: when a ticket is open on top of this list, THAT screen
      // must be the one to claim the celebration, or it would play unseen down here.
      const wins = await Promise.all(data
        .filter((t) => t.status === 'valid' || focusedRef.current)
        .map((t) => ticketCelebrations.observe(t)));
      if (wins.some(Boolean)) setCelebrate(true);
    } catch {}
    setLoading(false);
    setRefreshing(false);
  }, [profile?.id]);

  // Refetch whenever the screen regains focus, so a ticket that was just checked
  // in at the door shows as "Used" when the holder returns to this screen.
  const focusedRef = useRef(false);
  useFocusEffect(useCallback(() => {
    focusedRef.current = true;
    load();
    return () => { focusedRef.current = false; };
  }, [load]));

  // Live update: the moment one of the holder's tickets changes (e.g. scanned →
  // 'used'), the DB pushes it here and the list refreshes on its own.
  useEffect(() => {
    if (!profile) return;
    const channel = supabase
      .channel(`my-event-tickets-${profile.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'event_tickets', filter: `holder_id=eq.${profile.id}` },
        (payload) => {
          const prev = (payload.old as { status?: string } | null)?.status;
          const rowId = (payload.new as { id?: string } | null)?.id;
          void (async () => {
            if (prev === 'valid' && rowId) await ticketCelebrations.markSeenValid(rowId);
            await load();
          })();
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [profile?.id, load]);

  // "Has the event ended?" is a question about the clock, so re-ask it: a screen
  // left open across the end of an event moves the ticket to Past by itself.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // One rule for both tabs (ticketLifecycle): a refunded, void or checked-in ticket,
  // or one for a cancelled/ended event, is Past — a refunded ticket for a FUTURE
  // event included. Tickets are never dropped for being refunded.
  const { upcoming, past } = splitTickets(tickets, (t) => t, nowMs);
  const filtered = tab === 'upcoming' ? upcoming : past;

  return (
    <ScreenScaffold header={<ScreenHeader title="My Tickets" accent={S.color} />}>
      <TicketCelebration visible={celebrate} onDone={() => setCelebrate(false)} />
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
            <TicketRow
              ticket={item}
              nowMs={nowMs}
              viewerId={profile?.id ?? ''}
              onPress={() => router.push({ pathname: '/my-event-ticket', params: { id: item.id } })}
            />
          )}
        />
      )}
    </ScreenScaffold>
  );
}

function TicketRow({ ticket, nowMs, viewerId, onPress }: { ticket: EventTicket; nowMs: number; viewerId: string; onPress: () => void }) {
  const event = ticket.event;
  const life  = ticketLifecycle(ticket, nowMs) as TicketLifecycle;
  const isPast = life.bucket === 'past';
  const color = STATE_COLOR[life.state];
  // Money lines belong to Past: that is where the customer comes to ask "what
  // happened to my money". Built from the buyer's own order; absent for a gifted ticket.
  const lines = isPast ? ticketHistoryLines(ticket.order, viewerId, longDate) : null;

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
          <Text style={styles.ticketTypeName} numberOfLines={1}>
            {[ticket.ticket_type?.name, lines?.quantity].filter(Boolean).join(' · ')}
          </Text>
          <View style={[styles.statusPill, { backgroundColor: color + '20' }]}>
            <Text style={[styles.statusPillText, { color }]}>{life.label}</Text>
          </View>
        </View>
        {lines?.paid ? <Text style={styles.historyLine}>{lines.paid}</Text> : null}
        {lines?.refund ? <Text style={[styles.historyLine, styles.historyRefund]}>{lines.refund}</Text> : null}
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
  historyLine:    { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 3 },
  historyRefund:  { color: colors.textPrimary, fontWeight: '700' },
});
