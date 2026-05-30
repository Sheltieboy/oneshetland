/**
 * app/(admin)/config.tsx
 *
 * Admin-editable platform config. Rows are stored in the admin_config table
 * (see migration 018). Edge functions read these values via the shared
 * getConfig() helper instead of hardcoded env vars.
 *
 * What belongs here: anything non-secret the app owner wants to change
 * without a redeploy — Stripe price IDs, default fees, feature flags.
 * True secrets (API keys) stay in env vars.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, RefreshControl, KeyboardAvoidingView, Platform, Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';

interface ConfigRow {
  key:         string;
  value:       string;
  description: string | null;
  category:    string;
  is_secret:   boolean;
  updated_at:  string;
  updated_by:  string | null;
}

// Friendly labels for known categories
const CATEGORY_META: Record<string, { label: string; icon: string; color: string }> = {
  stripe:        { label: 'Stripe',        icon: 'credit-card', color: '#635BFF' },
  fees:          { label: 'Fees',          icon: 'pound-sign',  color: '#E8A020' },
  limits:        { label: 'Limits',        icon: 'sliders-h',   color: '#0EA5E9' },
  notifications: { label: 'Notifications', icon: 'bell',        color: '#7C3AED' },
};

// Friendlier per-key labels for known config rows.
// Anything not listed here falls back to the key itself.
const KEY_LABELS: Record<string, string> = {
  'stripe.price.local_pro':     'Local Pro · price ID',
  'stripe.price.local_premium': 'Local Premium · price ID',
};

// Per-key input placeholders and helper hints (used in the edit modal).
function placeholderForKey(key: string): string {
  if (key.startsWith('stripe.price.')) return 'price_1Q…';
  return 'Paste the value here';
}
function hintForKey(key: string): string | null {
  if (key.startsWith('stripe.price.')) {
    return 'This is the Stripe Price ID (starts with "price_"), NOT the £ amount. Find it in Stripe → Products → click the product → Pricing → copy the ID next to the £/month line.';
  }
  return null;
}

export default function AdminConfigScreen() {
  const router = useRouter();
  const { profile } = useAuth();

  const [rows, setRows]           = useState<ConfigRow[]>([]);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing]     = useState<ConfigRow | null>(null);

  const load = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('admin_config')
        .select('*')
        .order('category')
        .order('key');
      if (error) throw error;
      setRows((data ?? []) as ConfigRow[]);
    } catch (e: any) {
      Alert.alert('Could not load config', e?.message ?? 'Try again.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Restrict to admins
  if (profile && profile.role !== 'admin') {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <Header onBack={() => router.back()} />
        <View style={styles.center}>
          <Text style={styles.dim}>Admins only.</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <Header onBack={() => router.back()} />
        <View style={styles.center}><ActivityIndicator size="large" /></View>
      </SafeAreaView>
    );
  }

  // Group by category
  const byCategory: Record<string, ConfigRow[]> = {};
  for (const r of rows) {
    if (!byCategory[r.category]) byCategory[r.category] = [];
    byCategory[r.category].push(r);
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Header onBack={() => router.back()} />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
      >
        <View style={styles.intro}>
          <Text style={styles.introTitle}>Platform config</Text>
          <Text style={styles.introSub}>
            Non-secret values edge functions read at runtime. Tap a row to change it — saves immediately.
          </Text>
        </View>

        {rows.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.dim}>No config rows yet.</Text>
          </View>
        ) : (
          Object.entries(byCategory).map(([category, items]) => {
            const meta = CATEGORY_META[category] ?? { label: category.toUpperCase(), icon: 'cog', color: colors.textMuted };
            return (
              <View key={category} style={styles.categorySection}>
                <View style={styles.categoryHeader}>
                  <View style={[styles.categoryIcon, { backgroundColor: meta.color + '20' }]}>
                    <FontAwesome5 name={meta.icon as any} size={11} color={meta.color} solid />
                  </View>
                  <Text style={styles.categoryLabel}>{meta.label}</Text>
                </View>
                <View style={styles.categoryCard}>
                  {items.map((row, i) => (
                    <ConfigRowItem
                      key={row.key}
                      row={row}
                      last={i === items.length - 1}
                      onPress={() => setEditing(row)}
                    />
                  ))}
                </View>
              </View>
            );
          })
        )}

        <View style={styles.legend}>
          <FontAwesome5 name="info-circle" size={11} color={colors.textMuted} />
          <Text style={styles.legendText}>
            True secrets (API keys, service role keys) stay in Supabase env vars, not here.
          </Text>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>

      <EditModal
        row={editing}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); load(); }}
        userId={profile?.id ?? null}
      />
    </SafeAreaView>
  );
}

// ── Row ──────────────────────────────────────────────────────────────────────

function ConfigRowItem({
  row, last, onPress,
}: {
  row: ConfigRow;
  last: boolean;
  onPress: () => void;
}) {
  const isSet = !!row.value && row.value.trim().length > 0;
  const friendlyLabel = KEY_LABELS[row.key] ?? row.key;

  // Preview the current value when set: mask if secret, else show first 10 chars + …
  let preview: string | null = null;
  if (isSet) {
    if (row.is_secret) preview = '••••••••';
    else if (row.value.length > 14) preview = row.value.slice(0, 12) + '…';
    else preview = row.value;
  }

  return (
    <TouchableOpacity
      style={[styles.row, !last && styles.rowBorder]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={{ flex: 1, gap: 3 }}>
        <View style={styles.rowTopLine}>
          <Text style={styles.rowLabel} numberOfLines={1}>{friendlyLabel}</Text>
          {isSet ? (
            <View style={[styles.statusPill, styles.statusPillSet]}>
              <FontAwesome5 name="check" size={8} color="#fff" solid />
              <Text style={styles.statusPillText}>Set</Text>
            </View>
          ) : (
            <View style={[styles.statusPill, styles.statusPillEmpty]}>
              <Text style={[styles.statusPillText, { color: '#fff' }]}>Empty</Text>
            </View>
          )}
        </View>

        {row.description ? (
          <Text style={styles.rowDesc} numberOfLines={2}>{row.description}</Text>
        ) : null}

        {preview ? (
          <Text style={styles.rowPreview} numberOfLines={1}>{preview}</Text>
        ) : (
          <Text style={styles.rowPlaceholder}>Tap to set</Text>
        )}

        <Text style={styles.rowKey}>{row.key}</Text>
      </View>
      <FontAwesome5 name="chevron-right" size={11} color={colors.textLight} />
    </TouchableOpacity>
  );
}

// ── Edit modal ───────────────────────────────────────────────────────────────

function EditModal({
  row, onClose, onSaved, userId,
}: {
  row: ConfigRow | null;
  onClose: () => void;
  onSaved: () => void;
  userId: string | null;
}) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { setValue(row?.value ?? ''); }, [row]);

  if (!row) return null;

  const save = async () => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from('admin_config')
        .update({ value: value.trim(), updated_by: userId })
        .eq('key', row.key);
      if (error) throw error;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onSaved();
    } catch (e: any) {
      Alert.alert('Could not save', e?.message ?? 'Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={modalStyles.overlay}>
          <View style={modalStyles.sheet}>
            <View style={modalStyles.handle} />
            <Text style={modalStyles.title}>{row.key}</Text>
            {row.description ? (
              <Text style={modalStyles.subtitle}>{row.description}</Text>
            ) : null}

            <Text style={modalStyles.label}>Value</Text>
            <TextInput
              style={modalStyles.input}
              value={value}
              onChangeText={setValue}
              placeholder={placeholderForKey(row.key)}
              placeholderTextColor={colors.textLight}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={row.is_secret}
              multiline={value.length > 60}
            />
            {hintForKey(row.key) && (
              <Text style={modalStyles.hint}>{hintForKey(row.key)}</Text>
            )}

            {row.updated_at && (
              <Text style={modalStyles.meta}>
                Last updated {new Date(row.updated_at).toLocaleString('en-GB')}
              </Text>
            )}

            <View style={modalStyles.actions}>
              <TouchableOpacity onPress={onClose} style={modalStyles.cancelBtn}>
                <Text style={modalStyles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[modalStyles.saveBtn, saving && { opacity: 0.7 }]}
                onPress={save}
                disabled={saving}
                activeOpacity={0.85}
              >
                {saving
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={modalStyles.saveText}>Save</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
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
      <Text style={styles.headerTitle}>Config</Text>
      <View style={{ width: 70 }} />
    </View>
  );
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

  intro:      { gap: 4, paddingHorizontal: spacing.xs },
  introTitle: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary },
  introSub:   { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 18 },

  empty: { padding: spacing.xl, alignItems: 'center' },

  categorySection: { gap: 8 },
  categoryHeader:  { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: spacing.xs },
  categoryIcon:    { width: 22, height: 22, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  categoryLabel:   { fontSize: 11, fontWeight: '900', color: colors.textMuted, letterSpacing: 1, textTransform: 'uppercase' },
  categoryCard:    { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },

  row:        { flexDirection: 'row', alignItems: 'center', gap: 10, padding: spacing.md },
  rowBorder:  { borderBottomWidth: 1, borderBottomColor: colors.border },
  rowTopLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowLabel:   { flex: 1, fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  rowDesc:    { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 17 },
  rowPreview: { fontSize: 11, color: colors.textPrimary, fontFamily: 'monospace', marginTop: 4 },
  rowPlaceholder: { fontSize: 11, color: colors.textLight, fontStyle: 'italic', marginTop: 4 },
  rowKey:     { fontSize: 10, color: colors.textLight, fontFamily: 'monospace', marginTop: 4 },

  statusPill:      { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 3, borderRadius: radius.full },
  statusPillSet:   { backgroundColor: '#10B981' },
  statusPillEmpty: { backgroundColor: '#9CA3AF' },
  statusPillText:  { color: '#fff', fontSize: 10, fontWeight: '900', letterSpacing: 0.5 },

  legend:     { flexDirection: 'row', gap: 8, alignItems: 'flex-start', paddingHorizontal: spacing.xs },
  legendText: { flex: 1, fontSize: 11, color: colors.textMuted, lineHeight: 16 },
});

const modalStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet:   { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: spacing.lg, paddingBottom: 40, gap: 8 },
  handle:  { width: 36, height: 4, backgroundColor: colors.border, borderRadius: 2, alignSelf: 'center', marginBottom: 8 },
  title:   { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary, fontFamily: 'monospace' },
  subtitle:{ fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 18, marginBottom: 6 },

  label:   { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary, marginTop: 8, marginBottom: 4 },
  input:   { backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 10, fontSize: fontSize.sm, color: colors.textPrimary, fontFamily: 'monospace' },

  hint:    { fontSize: 11, color: colors.textMuted, lineHeight: 16, marginTop: 6, fontStyle: 'italic' },
  meta:    { fontSize: 11, color: colors.textLight, marginTop: 8 },

  actions:    { flexDirection: 'row', gap: 10, marginTop: 16 },
  cancelBtn:  { flex: 1, alignItems: 'center', paddingVertical: 12 },
  cancelText: { fontSize: fontSize.sm, color: colors.textMuted, fontWeight: '700' },
  saveBtn:    { flex: 2, paddingVertical: 12, borderRadius: radius.md, alignItems: 'center', backgroundColor: colors.navy },
  saveText:   { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
});
