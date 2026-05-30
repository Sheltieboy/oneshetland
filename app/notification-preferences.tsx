/**
 * app/notification-preferences.tsx
 *
 * Per-user notification controls — master switch, per-module toggles,
 * and optional quiet-hours window.
 *
 * Phase 1a of the notifications foundation.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Switch,
  ActivityIndicator, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import DateTimePicker from '@react-native-community/datetimepicker';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { useAuth } from '@/context/AuthContext';
import {
  fetchPreferences, updatePreferences, NOTIFICATION_MODULES,
  type NotificationPreferences,
} from '@/lib/notification-prefs';

export default function NotificationPreferencesScreen() {
  const router = useRouter();
  const { profile } = useAuth();

  const [prefs, setPrefs]     = useState<NotificationPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [showStart, setShowStart] = useState(false);
  const [showEnd, setShowEnd]     = useState(false);

  const load = useCallback(async () => {
    if (!profile) { setLoading(false); return; }
    try {
      const p = await fetchPreferences(profile.id);
      setPrefs(p);
    } finally {
      setLoading(false);
    }
  }, [profile?.id]);

  useEffect(() => { load(); }, [load]);

  // Optimistic update — apply locally, save in background. Bad saves bounce back on next fetch.
  const updatePref = async (patch: Partial<NotificationPreferences>) => {
    if (!profile || !prefs) return;
    Haptics.selectionAsync();
    const next = { ...prefs, ...patch };
    setPrefs(next);
    try {
      await updatePreferences(profile.id, patch as any);
    } catch (e) {
      console.error('Pref update failed', e);
      load();
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <Header onBack={() => router.back()} />
        <View style={styles.center}><ActivityIndicator size="large" /></View>
      </SafeAreaView>
    );
  }

  if (!profile || !prefs) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <Header onBack={() => router.back()} />
        <View style={styles.center}>
          <Text style={styles.dim}>Sign in to manage notifications.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const quietConfigured = !!(prefs.quiet_hours_start && prefs.quiet_hours_end);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Header onBack={() => router.back()} />

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>

        {/* ── Master switch ── */}
        <View style={[styles.card, !prefs.enabled && styles.cardMuted]}>
          <View style={styles.row}>
            <View style={[styles.iconWrap, { backgroundColor: prefs.enabled ? colors.navy : colors.border }]}>
              <FontAwesome5 name="bell" size={14} color={prefs.enabled ? '#fff' : colors.textMuted} solid />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>All notifications</Text>
              <Text style={styles.rowSub}>
                {prefs.enabled ? 'You\'ll get pushes per the settings below' : 'Everything muted'}
              </Text>
            </View>
            <Switch
              value={prefs.enabled}
              onValueChange={v => updatePref({ enabled: v })}
              trackColor={{ false: colors.border, true: colors.navy }}
            />
          </View>
        </View>

        {/* ── Per-module section ── */}
        <View style={styles.sectionLabelWrap}>
          <Text style={styles.sectionLabel}>By feature</Text>
          <Text style={styles.sectionHint}>
            Urgent reminders (e.g. an appointment in 10 minutes) still come through.
          </Text>
        </View>

        <View style={[styles.card, !prefs.enabled && styles.cardDimmed]} pointerEvents={prefs.enabled ? 'auto' : 'none'}>
          {NOTIFICATION_MODULES.map((m, i) => (
            <View key={m.module} style={[styles.row, i > 0 && styles.rowBorder]}>
              <View style={[styles.iconWrap, { backgroundColor: m.color + '20' }]}>
                <FontAwesome5 name={m.icon as any} size={13} color={m.color} solid />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{m.label}</Text>
                <Text style={styles.rowSub} numberOfLines={2}>{m.description}</Text>
              </View>
              <Switch
                value={!!prefs[m.prefKey]}
                onValueChange={v => updatePref({ [m.prefKey]: v } as any)}
                trackColor={{ false: colors.border, true: m.color }}
                disabled={!prefs.enabled}
              />
            </View>
          ))}
        </View>

        {/* ── Quiet hours ── */}
        <View style={styles.sectionLabelWrap}>
          <Text style={styles.sectionLabel}>Quiet hours</Text>
          <Text style={styles.sectionHint}>
            Stop non-urgent notifications during a window each day.
          </Text>
        </View>

        <View style={[styles.card, !prefs.enabled && styles.cardDimmed]} pointerEvents={prefs.enabled ? 'auto' : 'none'}>
          <View style={styles.row}>
            <View style={[styles.iconWrap, { backgroundColor: colors.border }]}>
              <FontAwesome5 name="moon" size={13} color={colors.textMuted} solid />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>Do not disturb</Text>
              <Text style={styles.rowSub}>
                {quietConfigured
                  ? `${formatTime(prefs.quiet_hours_start)} – ${formatTime(prefs.quiet_hours_end)}`
                  : 'No quiet hours set'}
              </Text>
            </View>
            <Switch
              value={quietConfigured}
              onValueChange={v => updatePref({
                quiet_hours_start: v ? (prefs.quiet_hours_start ?? '22:00') : null,
                quiet_hours_end:   v ? (prefs.quiet_hours_end   ?? '07:00') : null,
              })}
              trackColor={{ false: colors.border, true: colors.navy }}
            />
          </View>

          {quietConfigured && (
            <>
              <TouchableOpacity style={[styles.row, styles.rowBorder]} onPress={() => setShowStart(true)}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle}>From</Text>
                  <Text style={styles.rowSub}>{formatTime(prefs.quiet_hours_start)}</Text>
                </View>
                <FontAwesome5 name="chevron-right" size={11} color={colors.textLight} />
              </TouchableOpacity>
              <TouchableOpacity style={[styles.row, styles.rowBorder]} onPress={() => setShowEnd(true)}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle}>To</Text>
                  <Text style={styles.rowSub}>{formatTime(prefs.quiet_hours_end)}</Text>
                </View>
                <FontAwesome5 name="chevron-right" size={11} color={colors.textLight} />
              </TouchableOpacity>

              {showStart && (
                <DateTimePicker
                  value={parseTime(prefs.quiet_hours_start)}
                  mode="time"
                  is24Hour
                  display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                  onChange={(_, d) => {
                    setShowStart(Platform.OS === 'ios');
                    if (d) updatePref({ quiet_hours_start: toHHMM(d) });
                  }}
                />
              )}
              {showEnd && (
                <DateTimePicker
                  value={parseTime(prefs.quiet_hours_end)}
                  mode="time"
                  is24Hour
                  display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                  onChange={(_, d) => {
                    setShowEnd(Platform.OS === 'ios');
                    if (d) updatePref({ quiet_hours_end: toHHMM(d) });
                  }}
                />
              )}
            </>
          )}
        </View>

        <Text style={styles.footnote}>
          Changes save automatically. Notifications will pick up the new settings within seconds.
        </Text>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Header ───────────────────────────────────────────────────────────────────

function Header({ onBack }: { onBack: () => void }) {
  return (
    <View style={styles.header}>
      <TouchableOpacity style={styles.backBtn} onPress={onBack} hitSlop={12}>
        <FontAwesome5 name="chevron-left" size={14} color="#fff" />
        <Text style={styles.backText}>Back</Text>
      </TouchableOpacity>
      <Text style={styles.headerTitle}>Notifications</Text>
      <View style={{ width: 70 }} />
    </View>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(t: string | null): string {
  if (!t) return '—';
  return t.slice(0, 5);
}
function parseTime(t: string | null): Date {
  const d = new Date();
  if (!t) return d;
  const [h, m] = t.split(':').map(Number);
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}
function toHHMM(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.screenBackground },
  scroll: { flex: 1 },
  content:{ padding: spacing.md, gap: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  dim:    { color: colors.textMuted },

  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
  },
  backBtn:     { flexDirection: 'row', alignItems: 'center', gap: 8, width: 70 },
  backText:    { color: '#fff', fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '800', flex: 1, textAlign: 'center' },

  sectionLabelWrap: { paddingHorizontal: spacing.xs, gap: 3 },
  sectionLabel:     { fontSize: 11, fontWeight: '900', color: colors.textMuted, letterSpacing: 1, textTransform: 'uppercase' },
  sectionHint:      { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 17 },

  card:       { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  cardMuted:  { borderColor: colors.border, backgroundColor: '#f6f6f6' },
  cardDimmed: { opacity: 0.5 },

  row:       { flexDirection: 'row', alignItems: 'center', gap: 12, padding: spacing.md },
  rowBorder: { borderTopWidth: 1, borderTopColor: colors.border },
  iconWrap:  { width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  rowTitle:  { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  rowSub:    { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2, lineHeight: 17 },

  footnote: { fontSize: 11, color: colors.textLight, textAlign: 'center', paddingHorizontal: spacing.lg, marginTop: 4 },
});
