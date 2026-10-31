/**
 * NoticeCards — the two card forms for Notices & Alerts.
 *   HomeNoticeCard  equal-sized card for Home (same minimum height, clamped body, at most six on Home).
 *   NoticeListCard  the Notices-screen card: full attribution, expandable, destination only when a real one exists.
 * Neither uses the red/urgent treatment: that belongs to the Essential slot (EssentialAlerts.tsx). On the Notices screen an
 * active essential alert is the one exception, marked with a quiet "Essential alert" tag so it matches its Home banner.
 */
import React, { useState } from 'react';
import { View, Text, Image, Pressable, StyleSheet, Linking } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, radius, spacing } from '@/constants/theme';
import { areaSummary, formatNoticeTime, type NoticeModel, type NoticeDestination, type AttributionMark } from '@/lib/notices-alerts';

export const HOME_CARD_HEIGHT = 214;
const PURPLE = '#6B47BF';

export function markIcon(mark: AttributionMark): string {
  if (mark === 'person') return 'user';
  if (mark === 'official-source') return 'landmark';
  if (mark === 'official') return 'shield-alt';
  if (mark === 'hub') return 'users';
  if (mark === 'business') return 'store';
  return 'bullhorn';
}

const DEST_LABEL: Record<NoticeDestination['type'], string> = { campaign: 'View fundraiser', event: 'View event', hub: 'Visit hub', business: 'View business' };

function Mark({ n, size = 34 }: { n: NoticeModel; size?: number }) {
  const a = n.attribution;
  const bg = a.brand_color ?? (a.kind === 'official' || a.mark === 'official-source' ? '#0E6EA6' : PURPLE);
  return (
    <View style={[s.mark, { width: size, height: size, borderRadius: size / 3, backgroundColor: bg }]} accessibilityElementsHidden importantForAccessibility="no">
      {a.logo_url ? <Image source={{ uri: a.logo_url }} style={{ width: size, height: size }} /> : <FontAwesome5 name={markIcon(a.mark)} size={size * 0.4} color="#fff" solid />}
    </View>
  );
}

export function HomeNoticeCard({ n, width, onPress, now }: { n: NoticeModel; width?: number; onPress: () => void; now?: Date }) {
  const areas = areaSummary(n.areaNames);
  const when = formatNoticeTime(n.publishedAt, now);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${n.attribution.byline}. ${n.categoryLabel ? n.categoryLabel + '. ' : ''}${n.title}`}
      style={({ pressed }) => [s.homeCard, width ? { width } : { alignSelf: 'stretch' }, pressed && { opacity: 0.85 }]}
    >
      <View style={s.row}>
        <Mark n={n} size={30} />
        <Text style={s.byline} numberOfLines={1}>{n.attribution.byline}</Text>
      </View>
      {n.categoryLabel ? <Text style={s.cat} numberOfLines={1}>{n.categoryLabel}</Text> : null}
      <Text style={s.homeTitle} numberOfLines={2}>{n.title}</Text>
      {n.body ? <Text style={s.homeBody} numberOfLines={3}>{n.body}</Text> : null}
      <View style={{ flex: 1 }} />
      <Text style={s.foot} numberOfLines={1}>{[areas, when].filter(Boolean).join('  ·  ')}</Text>
    </Pressable>
  );
}

export function NoticeListCard({ n, highlighted, adminAction, onOpenDestination }: {
  n: NoticeModel; highlighted?: boolean; adminAction?: React.ReactNode; onOpenDestination: (d: NoticeDestination) => void;
}) {
  const [expanded, setExpanded] = useState(!!highlighted);
  const d = n.destination;
  const open = d !== null;
  // A card with a destination shows a trimmed preview (tap = go there); one without shows the WHOLE notice so nothing hides behind a missing link.
  const clamped = open && !expanded;
  const canExpand = open && (n.body.length > 140 || !!n.actionText);
  const areas = n.areaNames.join(', ');
  const meta = [n.categoryLabel, formatNoticeTime(n.publishedAt)].filter(Boolean).join('  ·  ');
  const showLinkRow = !!n.linkUrl || !!n.attribution.source_url;
  const Card: any = open ? Pressable : View;
  const cardProps = open ? { onPress: () => onOpenDestination(d as NoticeDestination), accessibilityRole: 'button' as const, accessibilityLabel: `${n.title}. ${DEST_LABEL[(d as NoticeDestination).type]}` } : {};
  return (
    <Card style={[s.listCard, highlighted && s.listCardHi, n.isEssential && s.listCardEssential]} {...cardProps}>
      <View style={s.row}>
        <Mark n={n} size={42} />
        <View style={{ flex: 1 }}>
          {n.isEssential ? <Text style={s.essTag}>ESSENTIAL ALERT</Text> : null}
          <Text style={s.listTitle} numberOfLines={clamped ? 2 : undefined}>{n.title}</Text>
          <Text style={s.meta} numberOfLines={clamped ? 2 : undefined}>{n.attribution.byline}</Text>
          {meta ? <Text style={s.meta}>{meta}</Text> : null}
        </View>
      </View>
      {n.body ? <Text style={s.listBody} numberOfLines={clamped ? 3 : undefined}>{n.body}</Text> : null}
      {!clamped && n.actionText ? (
        <View style={s.todo}><Text style={s.todoLabel}>What to do</Text><Text style={s.todoText}>{n.actionText}</Text></View>
      ) : null}
      {!clamped && areas ? <Text style={s.areas}><Text style={{ fontWeight: '800' }}>Areas: </Text>{areas}</Text> : null}
      {!clamped && n.expiresAt ? <Text style={s.areas}>Until {formatNoticeTime(n.expiresAt, 0)}</Text> : null}
      {showLinkRow && !clamped ? (
        <Pressable onPress={() => { Linking.openURL((n.linkUrl ?? n.attribution.source_url) as string).catch(() => {}); }} hitSlop={8} accessibilityRole="link" style={s.linkBtn}>
          <Text style={s.sourceLink}>View at source</Text>
        </Pressable>
      ) : null}
      {canExpand ? (
        <Pressable onPress={() => setExpanded((v) => !v)} hitSlop={8} accessibilityRole="button" accessibilityState={{ expanded }} style={s.linkBtn}>
          <Text style={s.sourceLink}>{expanded ? 'Show less' : 'Read in full'}</Text>
        </Pressable>
      ) : null}
      {open ? <Text style={s.dest}>{DEST_LABEL[(d as NoticeDestination).type]} {'›'}</Text> : null}
      {adminAction}
    </Card>
  );
}

const s = StyleSheet.create({
  mark: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },

  homeCard: { minHeight: HOME_CARD_HEIGHT, borderRadius: 20, padding: 16, backgroundColor: '#EDE9FE', borderWidth: 1, borderColor: '#DDD6FE' },
  byline: { flex: 1, color: '#4C1D95', fontSize: 11.5, fontWeight: '800' },
  cat: { color: '#6D28D9', fontSize: 10.5, fontWeight: '900', letterSpacing: 0.8, textTransform: 'uppercase', marginTop: 10 },
  homeTitle: { color: '#2E1065', fontSize: 18, lineHeight: 22, fontWeight: '800', marginTop: 4 },
  homeBody: { color: '#4C1D95', fontSize: 13.5, lineHeight: 19, marginTop: 5 },
  foot: { color: '#5B21B6', fontSize: 11.5, fontWeight: '700', marginTop: 8 },

  listCard: { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  listCardHi: { borderColor: PURPLE, borderWidth: 2 },
  listCardEssential: { borderColor: '#B3261E', borderWidth: 1.5 },
  essTag: { fontSize: 10, fontWeight: '900', color: '#B3261E', letterSpacing: 0.8 },
  listTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  meta: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  listBody: { fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 20, marginTop: spacing.sm },
  todo: { marginTop: spacing.sm, backgroundColor: colors.offWhite, borderRadius: radius.md, padding: 10 },
  todoLabel: { fontSize: 11, fontWeight: '900', color: colors.textMuted, letterSpacing: 0.8, textTransform: 'uppercase' },
  todoText: { fontSize: fontSize.sm, color: colors.textPrimary, lineHeight: 19, marginTop: 2 },
  areas: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 6, lineHeight: 17 },
  linkBtn: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  sourceLink: { fontSize: fontSize.xs, color: PURPLE, fontWeight: '800', textDecorationLine: 'underline' },
  dest: { fontSize: fontSize.sm, color: PURPLE, fontWeight: '800', marginTop: 4 },
});
