/**
 * hub-notice-compose.tsx
 * Post a notice as a Hub. Pass ?hub=<id>. Choose public or members-only.
 */

import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { createHubNotice, type NoticeVisibility } from '@/lib/hubs-api';

const S = SECTIONS.community;

const EXPIRY_OPTIONS: { label: string; days: number | null }[] = [
  { label: '1 week', days: 7 },
  { label: '2 weeks', days: 14 },
  { label: '1 month', days: 30 },
  { label: 'No expiry', days: null },
];

export default function HubNoticeComposeScreen() {
  const { hub } = useLocalSearchParams<{ hub: string }>();
  const router = useRouter();

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<NoticeVisibility>('public');
  const [expiryDays, setExpiryDays] = useState<number | null>(14);
  const [saving, setSaving] = useState(false);

  const post = async () => {
    if (!hub) return;
    if (!title.trim()) { Alert.alert('Title needed', 'Give your notice a title.'); return; }
    setSaving(true);
    try {
      const expires_at = expiryDays != null ? new Date(Date.now() + expiryDays * 86_400_000).toISOString() : null;
      await createHubNotice(hub, { title: title.trim(), body: body.trim() || null, visibility, expires_at });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (e: any) {
      Alert.alert('Could not post', e?.message ?? 'Please try again.');
    } finally { setSaving(false); }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={{ width: 70 }}>
          <Text style={[styles.cancel, { color: S.color }]}>Cancel</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>New notice</Text>
        <View style={{ width: 70 }} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.label}>Title</Text>
          <TextInput style={styles.input} value={title} onChangeText={setTitle}
            placeholder="e.g. No session this Friday" placeholderTextColor={colors.textLight} />

          <Text style={styles.label}>Details</Text>
          <TextInput style={[styles.input, styles.textarea]} value={body} onChangeText={setBody}
            placeholder="Add any details…" placeholderTextColor={colors.textLight} multiline />

          <Text style={styles.label}>Who can see this?</Text>
          <View style={styles.segment}>
            {(['public', 'members'] as NoticeVisibility[]).map(v => (
              <TouchableOpacity key={v} style={[styles.segBtn, visibility === v && { backgroundColor: S.color }]}
                onPress={() => setVisibility(v)} activeOpacity={0.85}>
                <FontAwesome5 name={v === 'public' ? 'globe' : 'lock'} size={12} color={visibility === v ? '#fff' : colors.textMuted} solid />
                <Text style={[styles.segText, visibility === v && { color: '#fff' }]}>{v === 'public' ? 'Everyone' : 'Members only'}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.label}>Remove after</Text>
          <View style={styles.expiryRow}>
            {EXPIRY_OPTIONS.map(o => (
              <TouchableOpacity key={o.label} style={[styles.chip, expiryDays === o.days && { backgroundColor: S.color, borderColor: S.color }]}
                onPress={() => setExpiryDays(o.days)} activeOpacity={0.8}>
                <Text style={[styles.chipText, expiryDays === o.days && { color: '#fff' }]}>{o.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity style={[styles.postBtn, { backgroundColor: S.color }, saving && { opacity: 0.6 }]}
            onPress={post} disabled={saving} activeOpacity={0.85}>
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.postText}>Post notice</Text>}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingBottom: spacing.sm, borderBottomWidth: 2, backgroundColor: '#fff',
  },
  cancel: { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },

  content: { padding: spacing.md },
  label: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary, marginBottom: 6, marginTop: spacing.md },
  input: {
    backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: 14, paddingVertical: 12, fontSize: fontSize.md, color: colors.textPrimary,
  },
  textarea: { minHeight: 110, textAlignVertical: 'top' },

  segment: { flexDirection: 'row', gap: 10 },
  segBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingVertical: 12,
  },
  segText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary },

  expiryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border },
  chipText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary },

  postBtn: { marginTop: spacing.xl, borderRadius: radius.lg, paddingVertical: 16, alignItems: 'center' },
  postText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
});
