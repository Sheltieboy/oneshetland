/**
 * EssentialAlerts — the reserved top slot of Home, shown as ONE single-line red strip: [!]  ESSENTIAL ALERT  headline  (count)  [×].
 * The ONLY place in the app with the red / urgent treatment. Driven solely by get_essential_alerts (see lib/notices-alerts.ts composeHome).
 * With nothing to show (none active, or all dismissed) it returns null: no placeholder, no gap.
 *
 * ONE LINE, always: every Text is numberOfLines={1}, the height is fixed, and text scaling inside the strip is capped so it cannot grow.
 * The full title, areas and everything else are in the accessibility label and on the notice / Notices screen it opens. Dismissal is
 * presentation only (lib/essential-dismiss.ts) and is stored on this device; it never changes the notice or any preference.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { FontAwesome5 } from '@expo/vector-icons';
import { splitEssential, type NoticeModel } from '@/lib/notices-alerts';
import { DISMISSED_KEY, parseDismissed, undismissed, dismissAll } from '@/lib/essential-dismiss';

const RED = '#B3261E', HEIGHT = 52, NARROW = 360;
const SCALE_CAP = 1.15; // the strip stays one line: the full text is in the accessibility label

/**
 * One undismissed alert: the strip opens it. Several: the strip shows the lead (the member's areas first, then newest) with the count and
 * opens the essential list. The × is a separate control and never navigates.
 */
export function EssentialAlerts({ alerts, onOpen, onSeeAll, sideInset = 16 }: {
  alerts: NoticeModel[]; onOpen: (n: NoticeModel) => void; onSeeAll: () => void; sideInset?: number;
}) {
  const [dismissed, setDismissed] = useState<string[] | null>(null); // null = not read yet: render nothing rather than flash
  const { width } = useWindowDimensions();
  useEffect(() => {
    let live = true;
    AsyncStorage.getItem(DISMISSED_KEY).then((raw) => { if (live) setDismissed(parseDismissed(raw)); }).catch(() => { if (live) setDismissed([]); });
    return () => { live = false; };
  }, []);
  const active = alerts ?? [];
  const shown = dismissed ? undismissed(active, dismissed) : [];
  const onDismiss = useCallback(() => {
    const next = dismissAll(dismissed ?? [], active);
    setDismissed(next);
    AsyncStorage.setItem(DISMISSED_KEY, JSON.stringify(next)).catch(() => {});
  }, [dismissed, active]);

  if (shown.length === 0) return null;
  const { lead, others } = splitEssential(shown);
  if (!lead) return null;
  const many = others.length > 0;
  const area = lead.areaNames.join(', ');
  const narrow = width < NARROW;
  const name = `${many ? `Essential alert, ${shown.length} active. Latest: ` : 'Essential alert. '}${lead.title}${area ? `. ${area}` : ''}`;
  return (
    <View style={{ paddingHorizontal: sideInset, paddingTop: 12 }}>
      <View style={s.strip}>
        <Pressable
          onPress={() => (many ? onSeeAll() : onOpen(lead))}
          accessibilityRole="button" accessibilityLabel={name} accessibilityHint={many ? 'Opens all essential alerts' : 'Opens the full alert'}
          style={({ pressed }) => [s.main, pressed && { opacity: 0.88 }]}
        >
          <View style={s.icon} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"><FontAwesome5 name="exclamation" size={12} color={RED} solid /></View>
          <View style={s.row} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Text style={s.label} numberOfLines={1} maxFontSizeMultiplier={SCALE_CAP}>{narrow ? 'ALERT' : 'ESSENTIAL ALERT'}</Text>
            <Text style={s.title} numberOfLines={1} maxFontSizeMultiplier={SCALE_CAP}>{lead.title}</Text>
            {many ? <Text style={s.count} numberOfLines={1} maxFontSizeMultiplier={SCALE_CAP}>{narrow ? `${shown.length}` : `${shown.length} active`}</Text> : null}
          </View>
        </Pressable>
        <Pressable onPress={onDismiss} accessibilityRole="button" accessibilityLabel="Dismiss Essential Alert" accessibilityHint="Hides this strip on Home. The alert stays in Notices."
          hitSlop={{ top: 4, bottom: 4, left: 0, right: 4 }} style={({ pressed }) => [s.close, pressed && { opacity: 0.7 }]}>
          <FontAwesome5 name="times" size={15} color="#fff" />
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  strip: { height: HEIGHT, flexDirection: 'row', alignItems: 'center', backgroundColor: RED, borderRadius: 14, overflow: 'hidden' },
  main: { flex: 1, minWidth: 0, height: HEIGHT, flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 12 },
  icon: { width: 26, height: 26, borderRadius: 13, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  row: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { flexShrink: 0, color: 'rgba(255,255,255,0.9)', fontSize: 10.5, fontWeight: '900', letterSpacing: 0.8 },
  title: { flex: 1, minWidth: 0, color: '#fff', fontSize: 14.5, fontWeight: '800' },
  count: { flexShrink: 0, color: 'rgba(255,255,255,0.9)', fontSize: 12, fontWeight: '800' },
  close: { width: 48, height: HEIGHT, alignItems: 'center', justifyContent: 'center' },
});
