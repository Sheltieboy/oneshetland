import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';

const S = SECTIONS.shifts;

type EmployerForm = {
  business_name: string;
  description:   string;
};

const EMPTY: EmployerForm = { business_name: '', description: '' };

export default function EmployerProfileScreen() {
  const router = useRouter();
  const { profile } = useAuth();

  const [form, setForm]       = useState<EmployerForm>(EMPTY);
  const [original, setOriginal] = useState<EmployerForm>(EMPTY);
  const [fetching, setFetching] = useState(true);
  const [saving, setSaving]   = useState(false);

  const load = useCallback(async () => {
    if (!profile?.id) return;
    const { data } = await supabase
      .from('shift_employer_profiles')
      .select('business_name, description')
      .eq('id', profile.id)
      .maybeSingle();

    const loaded: EmployerForm = {
      business_name: data?.business_name ?? profile.full_name ?? '',
      description:   data?.description   ?? '',
    };
    setForm(loaded);
    setOriginal(loaded);
    setFetching(false);
  }, [profile?.id, profile?.full_name]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    if (!profile?.id) return;
    if (!form.business_name.trim()) {
      return Alert.alert('Required', 'Please enter a business or trading name.');
    }

    setSaving(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    const { error } = await supabase
      .from('shift_employer_profiles')
      .upsert({
        id:            profile.id,
        business_name: form.business_name.trim(),
        description:   form.description.trim() || null,
        is_verified:   false,
        logo_url:      null,
      }, { onConflict: 'id' });

    setSaving(false);

    if (error) {
      Alert.alert('Could not save', error.message);
    } else {
      setOriginal(form);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Saved', 'Your business profile has been updated.', [
        { text: 'OK', onPress: () => router.back() },
      ]);
    }
  };

  if (fetching) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={S.color} />
        </View>
      </SafeAreaView>
    );
  }

  const isDirty = JSON.stringify(form) !== JSON.stringify(original);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>

      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Business profile</Text>
        <View style={{ width: 60 }} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >

          {/* Info card */}
          <View style={styles.introCard}>
            <FontAwesome5 name="building" size={15} color={S.color} solid />
            <Text style={styles.introText}>
              This is what workers see on your shift listings. A clear business name and short
              description helps people trust your postings.
            </Text>
          </View>

          {/* Business name */}
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Business / trading name</Text>
            <Text style={styles.hint}>The name shown on all your shift cards.</Text>
            <View style={styles.inputWrap}>
              <TextInput
                style={styles.input}
                value={form.business_name}
                onChangeText={v => setForm(p => ({ ...p, business_name: v }))}
                placeholder="e.g. Lerwick Hotel, Shetland Fish Ltd…"
                placeholderTextColor={colors.textLight}
                autoCapitalize="words"
              />
            </View>
          </View>

          {/* Description */}
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>About your business</Text>
            <Text style={styles.hint}>
              Optional. A line or two about what your business does — helps workers decide if
              it is the right fit for them.
            </Text>
            <View style={[styles.inputWrap, { alignItems: 'flex-start' }]}>
              <TextInput
                style={[styles.input, { height: 100, textAlignVertical: 'top', paddingTop: 10 }]}
                value={form.description}
                onChangeText={v => setForm(p => ({ ...p, description: v }))}
                placeholder="e.g. Family-run hotel in the heart of Lerwick, operating since 1978. We offer flexible shifts across hospitality and kitchen roles."
                placeholderTextColor={colors.textLight}
                multiline
              />
            </View>
          </View>

          {/* Verified note */}
          <View style={styles.verifiedNote}>
            <FontAwesome5 name="info-circle" size={12} color={colors.textMuted} />
            <Text style={styles.verifiedText}>
              Verified badges are awarded manually. Contact OneShetland to request verification
              for your business.
            </Text>
          </View>

          {/* Save */}
          <TouchableOpacity
            style={[
              styles.saveBtn,
              { backgroundColor: S.color },
              (!isDirty || saving) && { opacity: 0.6 },
            ]}
            onPress={handleSave}
            disabled={!isDirty || saving}
            activeOpacity={0.85}
          >
            {saving
              ? <ActivityIndicator color="#fff" />
              : <>
                  <FontAwesome5 name="check" size={14} color="#fff" />
                  <Text style={styles.saveBtnText}>Save business profile</Text>
                </>
            }
          </TouchableOpacity>

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.screenBackground },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { flex: 1 },
  content: { padding: spacing.md, paddingBottom: 60 },

  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
    borderBottomWidth: 2,
  },
  backBtn:     { flexDirection: 'row', alignItems: 'center', gap: 8, width: 60 },
  backText:    { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },

  introCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    backgroundColor: S.light,
    borderRadius: radius.md, padding: 14,
    borderLeftWidth: 3, borderLeftColor: S.color,
    marginBottom: spacing.lg,
  },
  introText: { flex: 1, fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 20 },

  field:      { marginBottom: spacing.lg },
  fieldLabel: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary, marginBottom: 4 },
  hint:       { fontSize: fontSize.xs, color: colors.textMuted, marginBottom: 8, lineHeight: 16 },

  inputWrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#fff', borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, minHeight: 46,
  },
  input: { flex: 1, color: colors.textPrimary, fontSize: fontSize.sm, paddingVertical: 12 },

  verifiedNote: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    backgroundColor: colors.screenBackground,
    borderRadius: radius.md, padding: 12,
    marginBottom: spacing.lg,
  },
  verifiedText: { flex: 1, fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 16 },

  saveBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, height: 52, borderRadius: radius.lg,
  },
  saveBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
});
