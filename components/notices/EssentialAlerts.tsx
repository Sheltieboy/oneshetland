/**
 * EssentialAlerts — the reserved top slot of Home. The ONLY place in the app with the red / urgent treatment.
 * Driven solely by get_essential_alerts (see lib/notices-alerts.ts composeHome). With nothing to show it returns null: no heading, no gap.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet, Linking } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import type { NoticeModel } from '@/lib/notices-alerts';

const RED = '#B3261E', RED_DARK = '#7F1D1D', RED_TINT = '#FDECEA', MAX_SHOWN = 3;

export function EssentialAlerts({ alerts, onOpen, onSeeAll, sideInset = 16 }: {
  alerts: NoticeModel[]; onOpen: (n: NoticeModel) => void; onSeeAll: () => void; sideInset?: number;
}) {
  if (!alerts || alerts.length === 0) return null;
  const shown = alerts.slice(0, MAX_SHOWN);
  const more = alerts.length - shown.length;
  return (
    <View style={{ paddingHorizontal: sideInset, paddingTop: 12, gap: 10 }} accessibilityRole="alert" accessibilityLabel={`${alerts.length} essential ${alerts.length === 1 ? 'alert' : 'alerts'}`}>
      {shown.map((n) => <EssentialAlertCard key={n.id} n={n} onOpen={() => onOpen(n)} />)}
      {more > 0 && (
        <Pressable onPress={onSeeAll} accessibilityRole="button" style={s.more}>
          <Text style={s.moreText}>{more} more essential {more === 1 ? 'alert' : 'alerts'}</Text>
          <FontAwesome5 name="chevron-right" size={11} color={RED_DARK} />
        </Pressable>
      )}
    </View>
  );
}

export function EssentialAlertCard({ n, onOpen }: { n: NoticeModel; onOpen: () => void }) {
  const areas = n.areaNames.join(', ');
  const link = n.linkUrl ?? n.attribution.source_url;
  return (
    <View style={s.card}>
      <View style={s.head}>
        <FontAwesome5 name="exclamation-triangle" size={13} color="#fff" solid />
        <Text style={s.label}>ESSENTIAL ALERT</Text>
      </View>
      <View style={s.body}>
        <Text style={s.title} accessibilityRole="header">{n.title}</Text>
        {n.body ? <Text style={s.text} numberOfLines={4}>{n.body}</Text> : null}
        {n.actionText ? (
          <View style={s.todo}>
            <Text style={s.todoLabel}>What to do</Text>
            <Text style={s.todoText} numberOfLines={4}>{n.actionText}</Text>
          </View>
        ) : null}
        {areas ? <Text style={s.meta}><Text style={s.metaStrong}>Affects: </Text>{areas}</Text> : null}
        <Text style={s.meta}>{n.attribution.byline}</Text>
        <View style={s.actions}>
          <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={`Read the full notice: ${n.title}`} style={s.primary}>
            <Text style={s.primaryText}>Read full notice</Text>
            <FontAwesome5 name="chevron-right" size={11} color="#fff" />
          </Pressable>
          {link ? (
            <Pressable onPress={() => { Linking.openURL(link).catch(() => {}); }} accessibilityRole="link" accessibilityLabel={`Open the source for ${n.title}`} style={s.link} hitSlop={6}>
              <Text style={s.linkText}>View at source</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: { borderRadius: 18, overflow: 'hidden', backgroundColor: RED_TINT, borderWidth: 1.5, borderColor: RED },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: RED, paddingHorizontal: 14, paddingVertical: 9 },
  label: { color: '#fff', fontSize: 12, fontWeight: '900', letterSpacing: 1.2 },
  body: { padding: 14, gap: 8 },
  title: { color: RED_DARK, fontSize: 19, lineHeight: 24, fontWeight: '800' },
  text: { color: '#3B1210', fontSize: 14.5, lineHeight: 21 },
  todo: { backgroundColor: '#fff', borderRadius: 12, padding: 11, borderLeftWidth: 4, borderLeftColor: RED },
  todoLabel: { color: RED, fontSize: 11, fontWeight: '900', letterSpacing: 0.8, textTransform: 'uppercase' },
  todoText: { color: '#1F1F1F', fontSize: 14, lineHeight: 20, marginTop: 2, fontWeight: '600' },
  meta: { color: '#5B2A27', fontSize: 12.5, lineHeight: 18 },
  metaStrong: { fontWeight: '800' },
  actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 14, marginTop: 4 },
  primary: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: RED, borderRadius: 99, paddingHorizontal: 18 },
  primaryText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  link: { minHeight: 44, justifyContent: 'center' },
  linkText: { color: RED_DARK, fontSize: 13.5, fontWeight: '800', textDecorationLine: 'underline' },
  more: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 14, borderWidth: 1, borderColor: RED, backgroundColor: RED_TINT },
  moreText: { color: RED_DARK, fontSize: 13.5, fontWeight: '800' },
});
