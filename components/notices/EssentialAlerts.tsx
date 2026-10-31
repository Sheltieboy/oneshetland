/**
 * EssentialAlerts — the reserved top slot of Home, shown as ONE compact red strip. The ONLY place in the app with the red / urgent treatment.
 * Driven solely by get_essential_alerts (see lib/notices-alerts.ts composeHome). With nothing to show it returns null: no heading, no gap.
 * The strip carries a headline, the area and a count only; the full text, "what to do" and source live on the Notices screen it opens.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { splitEssential, type NoticeModel } from '@/lib/notices-alerts';

const RED = '#B3261E';

/**
 * One alert: the strip opens that alert. Several: the strip shows the lead alert (the member's areas first, then newest) with an
 * "N active alerts" count and opens the essential list, where every alert is reachable. The height is the same either way.
 */
export function EssentialAlerts({ alerts, onOpen, onSeeAll, sideInset = 16 }: {
  alerts: NoticeModel[]; onOpen: (n: NoticeModel) => void; onSeeAll: () => void; sideInset?: number;
}) {
  if (!alerts || alerts.length === 0) return null;
  const { lead, others } = splitEssential(alerts);
  if (!lead) return null;
  const many = others.length > 0;
  const area = lead.areaNames[0] ? (lead.areaNames.length > 1 ? `${lead.areaNames[0]} +${lead.areaNames.length - 1}` : lead.areaNames[0]) : '';
  return (
    <View style={{ paddingHorizontal: sideInset, paddingTop: 12 }}>
      <Pressable
        onPress={() => (many ? onSeeAll() : onOpen(lead))}
        accessibilityRole="button"
        accessibilityLabel={many
          ? `${alerts.length} active essential alerts. Latest: ${lead.title}${area ? `. ${area}` : ''}. Opens all essential alerts.`
          : `Essential alert: ${lead.title}${area ? `. ${area}` : ''}. Opens the full alert.`}
        style={({ pressed }) => [s.strip, pressed && { opacity: 0.88 }]}
      >
        <View style={s.icon}><FontAwesome5 name="exclamation" size={12} color={RED} solid /></View>
        <View style={s.text}>
          <Text style={s.label} numberOfLines={1}>{many ? `ESSENTIAL ALERT · ${alerts.length} ACTIVE` : 'ESSENTIAL ALERT'}</Text>
          <Text style={s.title} numberOfLines={1}>{lead.title}</Text>
          {area ? <Text style={s.area} numberOfLines={1}>{area}</Text> : null}
        </View>
        <FontAwesome5 name="chevron-right" size={12} color="#fff" />
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  strip: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: RED, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 },
  icon: { width: 26, height: 26, borderRadius: 13, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1 },
  label: { color: 'rgba(255,255,255,0.88)', fontSize: 10.5, fontWeight: '900', letterSpacing: 1 },
  title: { color: '#fff', fontSize: 14.5, lineHeight: 19, fontWeight: '800' },
  area: { color: 'rgba(255,255,255,0.88)', fontSize: 12, lineHeight: 16 },
});
