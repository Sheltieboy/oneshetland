/**
 * NoticePreferences — the "Notices & alerts" block of the notification preferences screen.
 * Areas (my_notice_areas / set_my_notice_areas) and four independent opt-ins (my_notice_prefs / set_my_notice_prefs), every one OFF until the
 * member turns it on. Choosing areas never turns anything on. Saves optimistically and restores the saved value if the save fails
 * (same pattern as the rest of the screen); the error is surfaced through `onError`.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Switch, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { AreaPicker } from './AreaPicker';
import { loadAreas, loadCategories, FALLBACK_CATEGORIES, type AreaOption, type CategoryOption } from '@/lib/notices-alerts-api';
import {
  fetchMyNoticeAreas, saveMyNoticeAreas, fetchNoticePrefs, saveNoticePrefs, applyPrefChange, toggleCategory, friendlyPrefError,
  NOTICE_PREF_DEFAULTS, MAX_NOTICE_AREAS, type NoticePrefs, type NoticePrefChange,
} from '@/lib/notice-prefs';

type AudienceRow = { key: 'essential_alerts' | 'official_notices' | 'community_notices' | 'funeral_notices'; title: string; sub: string; icon: string; color: string };
const ROWS: AudienceRow[] = [
  { key: 'essential_alerts', title: 'Essential alerts', sub: 'Roads, ferries, power, water and safety alerts from verified organisations.', icon: 'exclamation-triangle', color: '#B3261E' },
  { key: 'official_notices', title: 'Health & official', sub: 'Notices from the council, NHS Shetland and other official sources.', icon: 'landmark', color: '#0E6EA6' },
  { key: 'community_notices', title: 'Community', sub: 'Notices from hubs, local businesses and neighbours.', icon: 'users', color: '#6B47BF' },
  { key: 'funeral_notices', title: 'Deaths & funeral', sub: 'Funeral notices, only after the family has agreed to their publication.', icon: 'feather', color: '#7A3B45' },
];

export function NoticePreferences({ onError, masterOn }: { onError: (message: string) => void; masterOn: boolean }) {
  const [prefs, setPrefs] = useState<NoticePrefs | null>(null);
  const [myAreas, setMyAreas] = useState<string[]>([]);
  const [areas, setAreas] = useState<AreaOption[]>([]);
  const [categories, setCategories] = useState<CategoryOption[]>(FALLBACK_CATEGORIES);
  const [picker, setPicker] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([fetchNoticePrefs(), fetchMyNoticeAreas()]);
      setPrefs(p); setMyAreas(a);
    } catch { setPrefs(null); } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    load();
    loadAreas().then(setAreas).catch(() => {});
    loadCategories().then(setCategories).catch(() => {});
  }, [load]);

  const change = async (c: NoticePrefChange) => {
    if (!prefs) return;
    Haptics.selectionAsync();
    const before = prefs;
    setPrefs(applyPrefChange(prefs, c));
    setSaving(true);
    try { setPrefs(await saveNoticePrefs(c)); }
    catch (e) { setPrefs(before); onError(friendlyPrefError(e)); }
    finally { setSaving(false); }
  };

  const saveAreas = async (ids: string[]) => {
    setPicker(false);
    const before = myAreas;
    setMyAreas(ids);
    setSaving(true);
    try { setMyAreas(await saveMyNoticeAreas(ids)); }
    catch (e) { setMyAreas(before); onError(friendlyPrefError(e)); }
    finally { setSaving(false); }
  };

  if (loading) return <View style={[styles.card, styles.pad]}><ActivityIndicator /></View>;
  if (!prefs) {
    return (
      <View style={[styles.card, styles.pad]}>
        <Text style={styles.sub}>Notice settings could not be loaded.</Text>
        <Pressable onPress={() => { setLoading(true); load(); }} accessibilityRole="button" style={styles.retry}><Text style={styles.retryText}>Try again</Text></Pressable>
      </View>
    );
  }

  const names = myAreas.map((id) => areas.find((a) => a.id === id)?.name ?? id);
  const areaLine = names.length === 0 ? 'No areas chosen' : names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
  const cats = prefs.community_categories;

  return (
    <>
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={[styles.icon, { backgroundColor: colors.navy + '14' }]}><FontAwesome5 name="map-marker-alt" size={13} color={colors.navy} solid /></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Your areas</Text>
            <Text style={styles.sub}>{areaLine}</Text>
          </View>
          <Pressable onPress={() => setPicker(true)} accessibilityRole="button" accessibilityLabel="Choose your areas" style={styles.change}><Text style={styles.changeText}>{myAreas.length ? 'Change' : 'Choose'}</Text></Pressable>
        </View>
        <View style={[styles.note, styles.border]}>
          <Text style={styles.noteText}>
            Choosing areas does not turn any notifications on; use the switches below for that. If you choose no areas you will only be told about Shetland-wide notices, never everything.
          </Text>
        </View>
      </View>

      <View style={[styles.card, !masterOn && { opacity: 0.6 }]}>
        {ROWS.map((r, i) => (
          <View key={r.key}>
            <View style={[styles.row, i > 0 && styles.border]}>
              <View style={[styles.icon, { backgroundColor: r.color + '20' }]}><FontAwesome5 name={r.icon as any} size={13} color={r.color} solid /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>{r.title}</Text>
                <Text style={styles.sub}>{r.sub}</Text>
              </View>
              <Switch
                value={prefs[r.key]}
                onValueChange={(v) => change({ [r.key]: v } as NoticePrefChange)}
                disabled={saving}
                accessibilityLabel={`Notify me about ${r.title}`}
                trackColor={{ false: colors.border, true: r.color }}
              />
            </View>
            {r.key === 'community_notices' && prefs.community_notices ? (
              <View style={styles.chips}>
                <Text style={styles.chipsLabel}>Which kinds? Leave all unselected for every kind.</Text>
                <View style={styles.chipWrap}>
                  <Pressable onPress={() => change({ community_categories: null })} disabled={saving} accessibilityRole="button" accessibilityState={{ selected: cats === null }} style={[styles.chip, cats === null && styles.chipOn]}>
                    <Text style={[styles.chipText, cats === null && { color: '#fff' }]}>All kinds</Text>
                  </Pressable>
                  {categories.map((c) => {
                    const on = !!cats && cats.includes(c.id);
                    return (
                      <Pressable key={c.id} onPress={() => change({ community_categories: toggleCategory(cats, c.id) })} disabled={saving} accessibilityRole="button" accessibilityState={{ selected: on }} style={[styles.chip, on && styles.chipOn]}>
                        <Text style={[styles.chipText, on && { color: '#fff' }]}>{c.label}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : null}
          </View>
        ))}
        <View style={[styles.note, styles.border]}>
          <Text style={styles.noteText}>
            Every switch starts off. The master switch above, the Notices &amp; safety setting and your quiet hours still apply to these. Notices and alerts stay readable in the app whether or not you receive notifications.
          </Text>
        </View>
      </View>

      <AreaPicker visible={picker} title="Your areas" areas={areas} selected={myAreas} multi max={MAX_NOTICE_AREAS} onClose={() => setPicker(false)} onDone={saveAreas} />
    </>
  );
}

export const NOTICE_PREFS_DEFAULTS = NOTICE_PREF_DEFAULTS;

const styles = StyleSheet.create({
  card: { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  pad: { padding: spacing.md, alignItems: 'center', gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: spacing.md },
  border: { borderTopWidth: 1, borderTopColor: colors.border },
  icon: { width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  sub: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2, lineHeight: 17 },
  change: { minHeight: 44, minWidth: 64, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong },
  changeText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.navy },
  note: { paddingHorizontal: spacing.md, paddingVertical: 12, backgroundColor: '#fafbfc' },
  noteText: { fontSize: fontSize.xs, lineHeight: 17, color: colors.textMuted },
  chips: { paddingHorizontal: spacing.md, paddingBottom: spacing.md, gap: 8, backgroundColor: '#fafbfc' },
  chipsLabel: { fontSize: fontSize.xs, color: colors.textMuted, paddingTop: 10 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 40, paddingHorizontal: 12, justifyContent: 'center', borderRadius: 99, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: '#fff' },
  chipOn: { backgroundColor: '#6B47BF', borderColor: '#6B47BF' },
  chipText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textSecondary },
  retry: { minHeight: 44, justifyContent: 'center' },
  retryText: { color: colors.navy, fontWeight: '700', textDecorationLine: 'underline' },
});
