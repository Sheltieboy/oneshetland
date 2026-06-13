/**
 * hub-events.tsx
 * A hub's events: create new ones and manage existing. Admin-only (owner /
 * committee). Pass ?id=<hubId>.
 */

import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { fetchHub, type Hub } from '@/lib/hubs-api';
import { fetchHubEvents, type OsEvent } from '@/lib/events-api';

const S = SECTIONS.community;

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
    + '  ·  ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Status + reach badge for a hub event. */
function eventBadge(ev: OsEvent): { label: string; color: string; bg: string } {
  if (ev.status === 'draft')     return { label: 'Draft',     color: '#475569', bg: '#E2E8F0' };
  if (ev.status === 'cancelled') return { label: 'Cancelled', color: '#991B1B', bg: '#FEE2E2' };
  switch (ev.hub_visibility) {
    case 'members': return { label: 'Members only', color: '#6D28D9', bg: '#F3E8FF' };
    case 'hub':     return { label: 'Hub page',     color: S.color,   bg: S.light };
    case 'islands': return ev.calendar_approved
      ? { label: 'On main calendar', color: '#15803D', bg: '#DCFCE7' }
      : { label: 'Awaiting approval', color: '#92400E', bg: '#FEF3C7' };
    default:        return { label: 'Published', color: '#15803D', bg: '#DCFCE7' };
  }
}

export default function HubEventsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const [hub, setHub]       = useState<Hub | null>(null);
  const [events, setEvents] = useState<OsEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [h, evs] = await Promise.all([fetchHub(id), fetchHubEvents(id)]);
      setHub(h);
      setEvents(evs);
    } finally { setLoading(false); }
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  const now = Date.now();
  const upcoming = events.filter(e => new Date(e.starts_at).getTime() >= now - 6 * 3600_000);
  const past     = events.filter(e => new Date(e.starts_at).getTime() <  now - 6 * 3600_000);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Events</Text>
        <View style={{ width: 70 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={S.color} /></View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={S.color} />}>

          <TouchableOpacity
            style={[styles.createCard, { backgroundColor: S.color }]}
            onPress={() => router.push(`/event-create?hubId=${id}`)}
            activeOpacity={0.9}
          >
            <View style={styles.createIcon}><FontAwesome5 name="plus" size={16} color={S.color} solid /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.createTitle}>New event</Text>
              <Text style={styles.createSub}>Free or ticketed — you choose who sees it</Text>
            </View>
            <FontAwesome5 name="chevron-right" size={14} color="rgba(255,255,255,0.85)" />
          </TouchableOpacity>

          {events.length === 0 ? (
            <View style={styles.empty}>
              <FontAwesome5 name="calendar-alt" size={28} color={S.color} />
              <Text style={styles.emptyTitle}>No events yet</Text>
              <Text style={styles.emptyBody}>Create your first event — a social, a fundraiser, a gig.</Text>
            </View>
          ) : (
            <>
              {upcoming.length > 0 ? (
                <>
                  <Text style={styles.groupLabel}>Upcoming</Text>
                  {upcoming.map(ev => <EventRow key={ev.id} ev={ev} onPress={() => router.push(`/event-manage?id=${ev.id}`)} />)}
                </>
              ) : null}
              {past.length > 0 ? (
                <>
                  <Text style={styles.groupLabel}>Past</Text>
                  {past.map(ev => <EventRow key={ev.id} ev={ev} onPress={() => router.push(`/event-manage?id=${ev.id}`)} />)}
                </>
              ) : null}
            </>
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function EventRow({ ev, onPress }: { ev: OsEvent; onPress: () => void }) {
  const b = eventBadge(ev);
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.8}>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle} numberOfLines={1}>{ev.title}</Text>
        <Text style={styles.rowWhen}>{fmtWhen(ev.starts_at)}</Text>
        <View style={styles.rowMeta}>
          <View style={[styles.statusPill, { backgroundColor: b.bg }]}>
            <Text style={[styles.statusPillText, { color: b.color }]}>{b.label}</Text>
          </View>
          {ev.has_tickets ? (
            <Text style={styles.rowStat}>
              <FontAwesome5 name="ticket-alt" size={10} color={colors.textMuted} solid />{'  '}
              {ev.tickets_sold} sold
            </Text>
          ) : null}
        </View>
      </View>
      <FontAwesome5 name="chevron-right" size={13} color={colors.textLight} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingBottom: spacing.sm, borderBottomWidth: 2, backgroundColor: '#fff',
  },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, width: 70 },
  backText: { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },

  content: { padding: spacing.md, gap: spacing.sm },
  createCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.xs,
  },
  createIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  createTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
  createSub: { color: 'rgba(255,255,255,0.85)', fontSize: fontSize.xs, marginTop: 1 },

  groupLabel: { fontSize: 11, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: spacing.md, marginBottom: 2 },

  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  rowTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  rowWhen: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 },
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  statusPillText: { fontSize: 10, fontWeight: '800' },
  rowStat: { fontSize: fontSize.xs, color: colors.textMuted },

  empty: { alignItems: 'center', gap: 8, padding: spacing.xl, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, marginTop: spacing.sm },
  emptyTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  emptyBody: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', lineHeight: 19 },
});
