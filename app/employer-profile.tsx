import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView,
  TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { Button } from '@/components/ui/Button';
import { LoadingState } from '@/components/ui/LoadingState';
import { useAppLayout } from '@/hooks/useAppLayout';
import { useAlert } from '@/components/BrandedAlert';

const S = SECTIONS.shifts;

type EmployerForm = {
  business_name: string;
  description:   string;
};

const EMPTY: EmployerForm = { business_name: '', description: '' };

export default function EmployerProfileScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const { screenWidth } = useAppLayout();
  const { alert } = useAlert();

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
      return alert({ title: 'Required', message: 'Please enter a business or trading name.' });
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
      alert({ title: 'Could not save', message: error.message });
    } else {
      setOriginal(form);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      alert({
        title: 'Saved',
        message: 'Your business profile has been updated.',
        actions: [
          { label: 'OK', style: 'primary', onPress: () => router.back() },
        ],
      });
    }
  };

  if (fetching) {
    return (
      <ScreenScaffold header={<ScreenHeader title="Business profile" accent={S.color} />}>
        <LoadingState accent={S.color} />
      </ScreenScaffold>
    );
  }

  const isDirty = JSON.stringify(form) !== JSON.stringify(original);

  return (
    <ScreenScaffold header={<ScreenHeader title="Business profile" accent={S.color} />}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
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
          <Button
            label="Save business profile"
            onPress={handleSave}
            icon="check"
            color={S.color}
            fullWidth
            loading={saving}
            disabled={!isDirty}
          />

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  scroll:  { flex: 1, backgroundColor: colors.screenBackground },
  content: { padding: spacing.md, paddingBottom: 60 },

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
});
