/**
 * app/business-events.tsx — Events management list.
 *
 * Reached from the Business Dashboard's Run events card ("Manage events").
 * Manage events means manage ALL of a business's events, not whichever one
 * the dashboard happened to pick as "next" — that picking (still exactly
 * right for Scan tickets, which genuinely does need one specific event) was
 * being reused for Manage events too, which left every event except the
 * next upcoming one — including any draft — unreachable from the main
 * management flow.
 *
 * Three groups, in this fixed order: drafts/needs attention, upcoming
 * published, past/cancelled. See groupEventsForManagement in
 * lib/events-api.ts for the exact rule each group uses, and
 * oneshetland-web's lib/events-manage.ts for the parity claim.
 */

import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius, shadow } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { supabase } from '@/lib/supabase';
import { useAlert } from '@/components/BrandedAlert';
import { CommercialTermsGate } from '@/components/CommercialTermsGate';
import {
  fetchBusinessEventsForManagement, groupEventsForManagement, eventHasActivePaidTicket,
  formatEventDate, type OsEvent, type EventStatus,
} from '@/lib/events-api';
import { startOrResumePayoutSetup, payoutOnboardingErrorAlert } from '@/lib/payout-readiness';

const S = SECTIONS.events;

const STATUS_CFG: Record<EventStatus, { label: string; color: string }> = {
  draft:     { label: 'Draft',     color: colors.textMuted },
  published: { label: 'Published', color: colors.success   },
  cancelled: { label: 'Cancelled', color: colors.error     },
  postponed: { label: 'Postponed', color: colors.warning   },
  archived:  { label: 'Archived',  color: colors.textMuted },
};

function BusinessEventsBody() {
  const { businessId } = useLocalSearchParams<{ businessId: string }>();
  const router = useRouter();
  const { alert } = useAlert();

  const [events,     setEvents]     = useState<OsEvent[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [connectingStripe, setConnectingStripe] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Draft event id -> payout_ready. Resolved only for drafts that have an
  // active paid ticket type — the one case this list needs to say more than
  // "Draft" (see the row render below). A plain or already-ready draft never
  // needs this, so most businesses never trigger any of these calls at all.
  const [draftPayoutReady, setDraftPayoutReady] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      if (!businessId) { setEvents([]); return; }
      const rows = await fetchBusinessEventsForManagement(businessId);
      setEvents(rows);
      const needsPayoutCheck = rows.filter(e => e.status === 'draft' && eventHasActivePaidTicket(e.ticket_types ?? []));
      if (needsPayoutCheck.length > 0) {
        const entries = await Promise.all(needsPayoutCheck.map(async e => {
          const { data } = await supabase.rpc('event_payout_ready', { p_event_id: e.id });
          return [e.id, data === true] as const;
        }));
        setDraftPayoutReady(Object.fromEntries(entries));
      } else {
        setDraftPayoutReady({});
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [businessId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Launches the correct Stripe onboarding flow directly for this business
  // (see startOrResumePayoutSetup) instead of sending the merchant to the
  // dashboard's Money tab — a draft row here already knows exactly which
  // business it needs connected.
  const goConnectStripe = async () => {
    // All draft rows on this screen share one business, so one flag
    // correctly disables every row's link while a launch is in flight.
    if (connectingStripe) return;
    setConnectingStripe(true);
    try {
      await startOrResumePayoutSetup(businessId ?? '');
    } catch (e: any) {
      alert(payoutOnboardingErrorAlert(e));
    } finally {
      setConnectingStripe(false);
      load();
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      </SafeAreaView>
    );
  }

  const { drafts, upcoming, past } = groupEventsForManagement(events);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Events</Text>
        <TouchableOpacity
          hitSlop={12}
          style={{ width: 60, alignItems: 'flex-end' }}
          onPress={() => router.push({ pathname: '/event-create', params: { businessId: businessId ?? '' } })}
        >
          <FontAwesome5 name="plus" size={16} color={S.color} />
        </TouchableOpacity>
      </View>

      {events.length === 0 ? (
        <View style={styles.empty}>
          <View style={[styles.emptyIcon, { backgroundColor: S.light }]}>
            <FontAwesome5 name="calendar-alt" size={28} color={S.color} solid />
          </View>
          <Text style={styles.emptyTitle}>No events yet</Text>
          <Text style={styles.emptySub}>Put something on — you can add tickets if you want to sell them, or keep it free.</Text>
          <TouchableOpacity
            style={[styles.primaryBtn, { backgroundColor: S.color }]}
            onPress={() => router.push({ pathname: '/event-create', params: { businessId: businessId ?? '' } })}
            activeOpacity={0.85}
          >
            <FontAwesome5 name="plus" size={11} color="#fff" />
            <Text style={styles.primaryBtnText}>Create event</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={S.color} />}
        >
          {drafts.length > 0 && (
            <EventGroup title="Drafts · needs attention">
              {drafts.map(e => (
                <EventRow
                  key={e.id}
                  event={e}
                  onPress={() => router.push({ pathname: '/event-manage', params: { id: e.id } })}
                  notReadyPaidDraft={eventHasActivePaidTicket(e.ticket_types ?? []) && draftPayoutReady[e.id] !== true}
                  onConnectStripe={goConnectStripe}
                  connectingStripe={connectingStripe}
                />
              ))}
            </EventGroup>
          )}

          {upcoming.length > 0 && (
            <EventGroup title="Upcoming">
              {upcoming.map(e => (
                <EventRow key={e.id} event={e} onPress={() => router.push({ pathname: '/event-manage', params: { id: e.id } })} />
              ))}
            </EventGroup>
          )}

          {past.length > 0 && (
            <EventGroup title="Past" quiet>
              {past.map(e => (
                <EventRow key={e.id} event={e} onPress={() => router.push({ pathname: '/event-manage', params: { id: e.id } })} quiet />
              ))}
            </EventGroup>
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

/**
 * Commercial screen: the business must have accepted the business & selling
 * terms first — the same gate, with the same "Events" label, that the web
 * Events management page (app/business/[id]/manage/events/page.tsx) sits
 * behind. One acceptance covers every commercial screen for that business;
 * Directory management is never gated. The gate only decides whether this
 * screen renders — it changes nothing about which events are listed, how they
 * are grouped, who owns them, or any payout/ticketing rule.
 */
export default function BusinessEventsScreen() {
  const { businessId } = useLocalSearchParams<{ businessId?: string }>();
  return (
    <CommercialTermsGate businessId={businessId} feature="Events">
      <BusinessEventsBody />
    </CommercialTermsGate>
  );
}

function EventGroup({ title, quiet, children }: { title: string; quiet?: boolean; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, quiet && { color: colors.textMuted }]}>{title}</Text>
      <View style={{ gap: 8 }}>{children}</View>
    </View>
  );
}

function EventRow({ event, onPress, notReadyPaidDraft, onConnectStripe, connectingStripe, quiet }: {
  event: OsEvent;
  onPress: () => void;
  notReadyPaidDraft?: boolean;
  onConnectStripe?: () => void;
  connectingStripe?: boolean;
  quiet?: boolean;
}) {
  const cfg = STATUS_CFG[event.status] ?? STATUS_CFG.draft;
  return (
    <TouchableOpacity style={[styles.row, quiet && { opacity: 0.7 }]} onPress={onPress} activeOpacity={0.8}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.rowTitle} numberOfLines={1}>{event.title}</Text>
        <Text style={styles.rowDate}>{formatEventDate(event.starts_at, event.ends_at)}</Text>
        <View style={styles.rowMetaRow}>
          <View style={[styles.statusPill, { backgroundColor: cfg.color + '18' }]}>
            <View style={[styles.statusDot, { backgroundColor: cfg.color }]} />
            <Text style={[styles.statusPillText, { color: cfg.color }]}>
              {notReadyPaidDraft ? `${cfg.label} · Not published` : cfg.label}
            </Text>
          </View>
          {event.has_tickets && (
            <Text style={styles.rowMetaText}>{event.tickets_sold} sold</Text>
          )}
        </View>
        {notReadyPaidDraft && onConnectStripe && (
          <TouchableOpacity
            onPress={onConnectStripe}
            disabled={connectingStripe}
            hitSlop={8}
            style={[styles.connectStripeLink, connectingStripe && { opacity: 0.6 }]}
          >
            {connectingStripe
              ? <ActivityIndicator size="small" color={colors.warningDark} />
              : <FontAwesome5 name="university" size={10} color={colors.warningDark} solid />}
            <Text style={styles.connectStripeLinkText}>{connectingStripe ? 'Opening Stripe…' : 'Connect Stripe to publish'}</Text>
          </TouchableOpacity>
        )}
      </View>
      <FontAwesome5 name="chevron-right" size={12} color={colors.textLight} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.screenBackground },
  scroll: { flex: 1 },
  content:{ paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
    borderBottomWidth: 1, backgroundColor: colors.screenBackground,
  },
  backBtn:     { flexDirection: 'row', alignItems: 'center', gap: 6, width: 60 },
  backText:    { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyIcon: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md },
  emptyTitle: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary },
  emptySub: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', marginTop: 6, lineHeight: 20 },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 20, paddingVertical: 13, borderRadius: radius.full, marginTop: spacing.lg,
  },
  primaryBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },

  section:      { padding: spacing.md, paddingBottom: 0 },
  sectionTitle: { fontSize: fontSize.xs, fontWeight: '900', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 10 },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: 14,
    ...shadow.card,
  },
  rowTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  rowDate:  { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
  rowMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full },
  statusDot:  { width: 6, height: 6, borderRadius: 3 },
  statusPillText: { fontSize: fontSize.xs, fontWeight: '800' },
  rowMetaText: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '700' },

  connectStripeLink: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  connectStripeLinkText: { fontSize: fontSize.xs, fontWeight: '800', color: colors.warningDark },
});
