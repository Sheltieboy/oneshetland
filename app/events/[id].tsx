/**
 * events/[id].tsx — Public event detail page
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  ActivityIndicator, Linking, Share,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius, shadow } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { BusinessLocationMap } from '@/components/BusinessLocationMap';
import { extractBrandColor, readableAccent } from '@/lib/image-upload';
import { useAuth } from '@/context/AuthContext';
import {
  fetchEvent,
  formatEventDate, formatTime,
  lowestTicketPrice, isFreeEvent, ticketTypeOnSale,
  UPDATE_KIND_LABELS,
  type OsEvent, type EventTicketType, type EventUpdate,
} from '@/lib/events-api';

const S = SECTIONS.events;
const SE = SECTIONS.local;

export default function EventDetailScreen() {
  const { id }   = useLocalSearchParams<{ id: string }>();
  const router   = useRouter();
  const { profile } = useAuth();
  const { isTablet, screenWidth, screenHeight } = useAppLayout();
  const twoPane = isTablet && screenWidth > screenHeight;

  const [event,   setEvent]   = useState<OsEvent | null>(null);
  const [loading, setLoading] = useState(true);
  // Page accent — extracted from the cover image, tints highlights throughout.
  const [accent, setAccent] = useState<string>(S.color);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const ev = await fetchEvent(id);
      setEvent(ev);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Pull the dominant colour from the cover image → contrast-safe page accent.
  useEffect(() => {
    if (!event?.cover_url) { setAccent(S.color); return; }
    let active = true;
    extractBrandColor(event.cover_url)
      .then(c => { if (active) setAccent(readableAccent(c, S.color)); })
      .catch(() => {});
    return () => { active = false; };
  }, [event?.cover_url]);

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
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtnFull}>
            <Text style={[styles.backBtnFullText, { color: S.color }]}>Go back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const isOwner = profile?.id === event.organiser_user_id ||
    (event.business && profile?.id === (event.business as any).owner_id);

  const ticketTypes    = event.ticket_types ?? [];
  const updates        = event.updates ?? [];
  const hasTickets     = event.has_tickets && ticketTypes.length > 0;
  const ticketsOnSale  = ticketTypes.some(ticketTypeOnSale);
  const priceLabel     = hasTickets
    ? (isFreeEvent(ticketTypes) ? 'Free' : (() => { const l = lowestTicketPrice(ticketTypes); return l !== null ? `From £${(l / 100).toFixed(2)}` : null; })())
    : (event.price_text ?? null);

  const isCancelled = event.status === 'cancelled';
  const isPostponed = event.status === 'postponed';
  // Organiser must have a connected, payout-ready Stripe account to sell tickets.
  const payoutReady = !!(event.business as any)?.payout_enabled;

  const urgentUpdate = updates.find(u => u.is_urgent);

  // ── Section blocks (composed differently on tablet vs phone) ──────────────
  const coverBlock = (
    <View style={[styles.coverCard, { height: twoPane ? 340 : 230 }]}>
      {event.cover_url ? (
        <Image source={{ uri: event.cover_url }} style={StyleSheet.absoluteFill as any} resizeMode="cover" blurRadius={18} />
      ) : null}
      <View style={styles.coverScrim} />
      {event.cover_url ? (
        <Image source={{ uri: event.cover_url }} style={styles.coverImg} resizeMode="contain" />
      ) : (
        <FontAwesome5 name="calendar-alt" size={44} color="#fff" />
      )}
    </View>
  );

  const bannersBlock = (
    <>
      {(isCancelled || isPostponed) && (
        <View style={[styles.statusBanner, { backgroundColor: isCancelled ? colors.errorLight : colors.warningLight }]}>
          <FontAwesome5 name={isCancelled ? 'times-circle' : 'clock'} size={13} color={isCancelled ? colors.error : colors.warning} solid />
          <Text style={[styles.statusBannerText, { color: isCancelled ? colors.error : colors.warning }]}>
            {isCancelled ? 'This event has been cancelled' : 'This event has been postponed'}
          </Text>
        </View>
      )}
      {urgentUpdate && !isCancelled && (
        <View style={styles.urgentBanner}>
          <FontAwesome5 name="exclamation-triangle" size={13} color="#fff" solid />
          <View style={{ flex: 1 }}>
            <Text style={styles.urgentTitle}>{urgentUpdate.title}</Text>
            <Text style={styles.urgentBody}>{urgentUpdate.body}</Text>
          </View>
        </View>
      )}
    </>
  );

  const titleBlock = (
    <View style={styles.titleBlock}>
      {event.category && (
        <Text style={[styles.category, { color: accent }]}>{event.category}</Text>
      )}
      <Text style={styles.title}>{event.title}</Text>
      {event.business && (
        <TouchableOpacity
          onPress={() => router.push({ pathname: '/local-business-detail', params: { id: event.organiser_business_id! } })}
          style={styles.organiserRow}
          activeOpacity={0.7}
        >
          <FontAwesome5 name="store" size={11} color={SE.color} />
          <Text style={[styles.organiserText, { color: SE.color }]}>{event.business.name}</Text>
          <FontAwesome5 name="chevron-right" size={9} color={SE.color} />
        </TouchableOpacity>
      )}
    </View>
  );

  const factsBlock = (
    <View style={styles.infoCard}>
      <InfoRow icon="calendar" accent={accent} label={formatEventDate(event.starts_at, event.ends_at)} />
      {event.doors_open_at && (
        <InfoRow icon="door-open" accent={accent} label={`Doors open ${formatTime(event.doors_open_at)}`} />
      )}
      {(event.venue || event.formatted_address) && (
        <InfoRow
          icon="map-marker-alt"
          accent={accent}
          label={[event.venue, event.locality ?? event.formatted_address].filter(Boolean).join(' · ')}
          onPress={event.formatted_address
            ? () => Linking.openURL(`maps://?q=${encodeURIComponent(event.formatted_address!)}`)
            : undefined}
          actionIcon={event.formatted_address ? 'directions' : undefined}
        />
      )}
      {event.age_restriction && <InfoRow icon="id-badge" accent={accent} label={event.age_restriction} />}
      {event.accessibility_info && <InfoRow icon="wheelchair" accent={accent} label={event.accessibility_info} last />}
    </View>
  );

  const mapBlock = (event.lat != null && event.lng != null) ? (
    <View style={styles.mapWrap}>
      <BusinessLocationMap
        lat={event.lat}
        lng={event.lng}
        name={event.venue ?? event.title}
        address={event.formatted_address}
        color={accent}
        height={twoPane ? 190 : 160}
      />
    </View>
  ) : null;

  const aboutBlock = event.description ? (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>About</Text>
      <Text style={styles.description}>{event.description}</Text>
    </View>
  ) : null;

  const ticketsBlock = hasTickets && !isCancelled ? (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Tickets</Text>
      <View style={{ gap: 8 }}>
        {ticketTypes.map(tt => {
          const onSale  = ticketTypeOnSale(tt);
          const remaining = tt.quantity_available !== null ? Math.max(0, tt.quantity_available - tt.quantity_sold) : null;
          const almostGone = remaining !== null && remaining <= 10 && remaining > 0;
          return (
            <View key={tt.id} style={styles.ticketTypeRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.ticketTypeName}>{tt.name}</Text>
                {tt.description && <Text style={styles.ticketTypeDesc}>{tt.description}</Text>}
                <View style={styles.ticketTypeMeta}>
                  <Text style={[styles.ticketTypePrice, { color: accent }]}>
                    {tt.price_pence === 0 ? 'Free' : `£${(tt.price_pence / 100).toFixed(2)}`}
                  </Text>
                  {almostGone && <Text style={styles.almostGone}>· Only {remaining} left</Text>}
                  {remaining === 0 && <Text style={styles.soldOut}>· Sold out</Text>}
                </View>
              </View>
              {!onSale && <Text style={styles.ticketOffSale}>Not on sale</Text>}
            </View>
          );
        })}
      </View>
      {event.refund_policy && <Text style={styles.refundPolicy}>{event.refund_policy}</Text>}
    </View>
  ) : null;

  const galleryBlock = (event.gallery_urls ?? []).length > 0 ? (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Photos</Text>
      <View style={styles.galleryGrid}>
        {(event.gallery_urls ?? []).map((url, i) => (
          <Image key={i} source={{ uri: url }} style={styles.galleryTile} />
        ))}
      </View>
    </View>
  ) : null;

  const updatesBlock = updates.length > 0 ? (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Updates</Text>
      <View style={{ gap: 8 }}>
        {updates.map(u => <UpdateRow key={u.id} update={u} />)}
      </View>
    </View>
  ) : null;

  const contactBlock = (event.contact_info || event.event_notes) ? (
    <View style={styles.section}>
      {event.contact_info && <InfoRow icon="envelope" accent={accent} label={event.contact_info} card />}
      {event.event_notes && <Text style={styles.eventNotes}>{event.event_notes}</Text>}
    </View>
  ) : null;

  const ownerBlock = isOwner ? (
    <View style={styles.ownerActions}>
      <TouchableOpacity style={styles.ownerBtn} onPress={() => router.push({ pathname: '/event-manage', params: { id: event.id } })} activeOpacity={0.85}>
        <FontAwesome5 name="cog" size={13} color={SE.color} />
        <Text style={[styles.ownerBtnText, { color: SE.color }]}>Manage event</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.ownerBtn} onPress={() => router.push({ pathname: '/event-scanner', params: { id: event.id } })} activeOpacity={0.85}>
        <FontAwesome5 name="qrcode" size={13} color={SE.color} />
        <Text style={[styles.ownerBtnText, { color: SE.color }]}>Scan tickets</Text>
      </TouchableOpacity>
    </View>
  ) : null;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => { if (router.canGoBack()) router.back(); else router.replace('/(tabs)/whats-on'); }}
          hitSlop={12}
        >
          <FontAwesome5 name="chevron-left" size={14} color={accent} />
          <Text style={[styles.backText, { color: accent }]}>What's On</Text>
        </TouchableOpacity>
        <TouchableOpacity
          hitSlop={12}
          onPress={() => Share.share({ message: `${event.title} — ${formatEventDate(event.starts_at, event.ends_at)}` })}
        >
          <FontAwesome5 name="share-alt" size={15} color={accent} />
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        {twoPane ? (
          <View style={styles.twoCol}>
            <View style={styles.colLeft}>
              {coverBlock}
              {factsBlock}
              {mapBlock}
              {contactBlock}
            </View>
            <View style={styles.colRight}>
              {bannersBlock}
              {titleBlock}
              {aboutBlock}
              {galleryBlock}
              {ticketsBlock}
              {updatesBlock}
              {ownerBlock}
            </View>
          </View>
        ) : (
          <View style={[isTablet && styles.portraitWrap]}>
            {coverBlock}
            {bannersBlock}
            {titleBlock}
            {factsBlock}
            {mapBlock}
            {aboutBlock}
            {galleryBlock}
            {ticketsBlock}
            {updatesBlock}
            {contactBlock}
            {ownerBlock}
          </View>
        )}
        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Buy tickets CTA — only when the organiser can actually receive payouts */}
      {hasTickets && ticketsOnSale && !isCancelled && !isOwner && (
        payoutReady ? (
          <View style={styles.ctaBar}>
            {priceLabel && (
              <Text style={styles.ctaPrice}>{priceLabel}</Text>
            )}
            <TouchableOpacity
              style={[styles.ctaBtn, { backgroundColor: accent }]}
              onPress={() => router.push({ pathname: '/event-ticket-checkout', params: { id: event.id } })}
              activeOpacity={0.85}
            >
              <FontAwesome5 name="ticket-alt" size={13} color="#fff" solid />
              <Text style={styles.ctaBtnText}>Get tickets</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.ctaBarMuted}>
            <FontAwesome5 name="clock" size={13} color={colors.textMuted} />
            <Text style={styles.ctaSoonText}>Tickets coming soon</Text>
          </View>
        )
      )}
    </SafeAreaView>
  );
}

function InfoRow({ icon, label, onPress, actionIcon, last, card, accent = S.color }: { icon: string; label: string; onPress?: () => void; actionIcon?: string; last?: boolean; card?: boolean; accent?: string }) {
  const inner = (
    <View style={[styles.infoRow, (last || card) && { borderBottomWidth: 0 }, card && styles.infoRowCard]}>
      <FontAwesome5 name={icon as any} size={13} color={accent} style={{ width: 18, marginTop: 1 }} />
      <Text style={styles.infoRowText}>{label}</Text>
      {actionIcon && <FontAwesome5 name={actionIcon as any} size={12} color={accent} />}
    </View>
  );
  if (onPress) return <TouchableOpacity onPress={onPress} activeOpacity={0.7}>{inner}</TouchableOpacity>;
  return inner;
}

function UpdateRow({ update }: { update: EventUpdate }) {
  const kindLabel = UPDATE_KIND_LABELS[update.kind] ?? update.kind;
  const isUrgent  = update.is_urgent || update.kind === 'urgent' || update.kind === 'cancellation';
  const dotColor  = isUrgent ? colors.error : S.color;
  return (
    <View style={styles.updateRow}>
      <View style={[styles.updateDot, { backgroundColor: dotColor }]} />
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <Text style={[styles.updateKind, { color: dotColor }]}>{kindLabel}</Text>
          <Text style={styles.updateDate}>
            {new Date(update.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
          </Text>
        </View>
        <Text style={styles.updateTitle}>{update.title}</Text>
        {update.body && <Text style={styles.updateBody}>{update.body}</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.navy },
  scroll: { flex: 1, backgroundColor: colors.screenBackground },
  content:{ paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12, backgroundColor: colors.screenBackground },
  errorText:      { fontSize: fontSize.md, color: colors.textMuted },
  backBtnFull:    { marginTop: 8 },
  backBtnFullText:{ fontSize: fontSize.sm, fontWeight: '700' },

  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
  },
  backBtn:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  backText:  { fontSize: fontSize.sm, fontWeight: '700' },

  // Layout
  content2:    {},
  portraitWrap:{ maxWidth: 720, alignSelf: 'center', width: '100%' },
  twoCol:      { flexDirection: 'row', gap: spacing.lg, maxWidth: 1180, alignSelf: 'center', width: '100%', paddingHorizontal: spacing.md, paddingTop: spacing.md },
  colLeft:     { width: '40%' },
  colRight:    { flex: 1, minWidth: 0 },

  // Cover — contained poster on a blurred fill so nothing is cropped
  coverCard: {
    marginHorizontal: spacing.md, marginTop: spacing.md,
    borderRadius: radius.lg, overflow: 'hidden', backgroundColor: colors.navy,
    alignItems: 'center', justifyContent: 'center',
  },
  coverScrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(8,20,40,0.45)' },
  coverImg:   { width: '100%', height: '100%' },

  mapWrap: { paddingHorizontal: spacing.md, marginTop: spacing.md },
  galleryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  galleryTile: { width: 96, height: 96, borderRadius: radius.md, resizeMode: 'cover' },
  infoRowCard: { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border },

  statusBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: spacing.md, marginTop: spacing.md,
    padding: 12, borderRadius: radius.md,
  },
  statusBannerText: { fontSize: fontSize.sm, fontWeight: '700' },

  urgentBanner: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    backgroundColor: colors.error, margin: spacing.md,
    padding: 12, borderRadius: radius.md,
  },
  urgentTitle: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
  urgentBody:  { color: 'rgba(255,255,255,0.9)', fontSize: fontSize.xs, marginTop: 2 },

  titleBlock: { padding: spacing.md, paddingBottom: 4 },
  category:   { fontSize: fontSize.xs, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  title:      { fontSize: fontSize.xxl, fontWeight: '900', color: colors.textPrimary, lineHeight: 32 },
  organiserRow:{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  organiserText:{ fontSize: fontSize.xs, fontWeight: '700' },

  infoCard: {
    marginHorizontal: spacing.md, marginTop: 12,
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, overflow: 'hidden',
  },
  infoRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    padding: 12, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  infoRowText: { flex: 1, fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: '600' },

  section:      { paddingHorizontal: spacing.md, marginTop: spacing.lg },
  sectionTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary, marginBottom: 10 },
  description:  { fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 20 },

  ticketTypeRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#fff', borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, padding: 12,
  },
  ticketTypeName:  { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  ticketTypeDesc:  { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
  ticketTypeMeta:  { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  ticketTypePrice: { fontSize: fontSize.sm, fontWeight: '900' },
  almostGone:      { fontSize: fontSize.xs, color: colors.warning, fontWeight: '700' },
  soldOut:         { fontSize: fontSize.xs, color: colors.error, fontWeight: '700' },
  ticketOffSale:   { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600' },
  refundPolicy:    { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 10, fontStyle: 'italic' },

  galleryThumb: { width: 120, height: 90, borderRadius: radius.md, resizeMode: 'cover' },

  updateRow: {
    flexDirection: 'row', gap: 10, alignItems: 'flex-start',
    backgroundColor: '#fff', borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, padding: 12,
  },
  updateDot:   { width: 8, height: 8, borderRadius: 4, marginTop: 4, flexShrink: 0 },
  updateKind:  { fontSize: fontSize.xs, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.3 },
  updateDate:  { fontSize: fontSize.xs, color: colors.textMuted },
  updateTitle: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  updateBody:  { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 2, lineHeight: 18 },

  eventNotes: { fontSize: fontSize.xs, color: colors.textMuted, fontStyle: 'italic', lineHeight: 18 },

  ownerActions: {
    flexDirection: 'row', gap: 10,
    marginHorizontal: spacing.md, marginTop: spacing.lg,
  },
  ownerBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 12, borderRadius: radius.md,
    borderWidth: 1.5, borderColor: SE.color + '60',
    backgroundColor: SE.color + '10',
  },
  ownerBtnText: { fontSize: fontSize.sm, fontWeight: '800' },

  ctaBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
    backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: colors.border,
    ...shadow.strong,
  },
  ctaBarMuted: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingHorizontal: spacing.md, paddingVertical: 16,
    backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: colors.border,
  },
  ctaSoonText: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textMuted },
  ctaPrice:    { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary },
  ctaBtn:      { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingVertical: 13, borderRadius: radius.md },
  ctaBtnText:  { color: '#fff', fontSize: fontSize.sm, fontWeight: '900' },
});
