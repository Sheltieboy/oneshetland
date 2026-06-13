import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, Alert, KeyboardAvoidingView, Platform, Switch,
} from 'react-native';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { Button } from '@/components/ui/Button';
import { LoadingState } from '@/components/ui/LoadingState';

const S = SECTIONS.shifts;

const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: 'hospitality', label: 'Hospitality' },
  { value: 'maritime',    label: 'Maritime & Fishing' },
  { value: 'oil_gas',     label: 'Oil & Gas' },
  { value: 'aquaculture', label: 'Aquaculture' },
  { value: 'crofting',    label: 'Crofting' },
  { value: 'care',        label: 'Care & Support' },
  { value: 'events',      label: 'Events' },
  { value: 'retail',      label: 'Retail & Admin' },
  { value: 'driving',     label: 'Driving' },
  { value: 'trades',      label: 'Trades' },
  { value: 'education',   label: 'Education' },
  { value: 'tourism',     label: 'Tourism' },
];

const URGENCY_OPTIONS: { value: string; label: string }[] = [
  { value: 'asap',      label: 'ASAP' },
  { value: 'today',     label: 'Today' },
  { value: 'this_week', label: 'This week' },
  { value: 'planned',   label: 'Planned' },
];

const SKILL_OPTIONS = [
  'Customer service', 'Food preparation', 'Cash handling', 'Stock management',
  'Forklift operation', 'HGV driving', 'First aid', 'Manual handling',
  'Health & safety', 'Team leadership', 'Administration', 'IT / Computer skills',
  'Cleaning', 'Catering', 'Bar work', 'Event management',
  'Fishing / Maritime', 'Agriculture / Crofting', 'Care & support', 'Childcare',
];

const QUALIFICATION_OPTIONS = [
  'Driving licence', 'Food hygiene cert', 'STCW', 'PVG / Disclosure',
  'First aid certificate', 'Manual handling cert', 'Health & safety cert',
  'Forklift licence', 'HGV licence', 'CSCS card', 'SIA licence',
];

type WorkerProfile = {
  bio:                string;
  experience_summary: string;
  skills:             string[];
  qualifications:     string[];
  hourly_rate_min:    string;
  hourly_rate_max:    string;
};

type AlertConfig = {
  is_active:  boolean;
  categories: string[];
  urgency:    string[];
  min_pay:    string;
};

const EMPTY: WorkerProfile = {
  bio:                '',
  experience_summary: '',
  skills:             [],
  qualifications:     [],
  hourly_rate_min:    '',
  hourly_rate_max:    '',
};

const EMPTY_ALERT: AlertConfig = {
  is_active:  false,
  categories: [],
  urgency:    [],
  min_pay:    '',
};

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      {children}
    </View>
  );
}

function Chip({ label, active, color, onPress }: {
  label: string; active: boolean; color: string; onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.chip, active && { backgroundColor: color, borderColor: color }]}
      onPress={onPress}
      activeOpacity={0.75}
    >
      {active && <FontAwesome5 name="check" size={9} color="#fff" style={{ marginRight: 4 }} />}
      <Text style={[styles.chipText, active && { color: '#fff' }]}>{label}</Text>
    </TouchableOpacity>
  );
}

export default function ShiftWorkerProfileScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const { screenWidth } = useAppLayout();

  const [form, setForm]         = useState<WorkerProfile>(EMPTY);
  const [original, setOriginal] = useState<WorkerProfile>(EMPTY);
  const [alert, setAlert]       = useState<AlertConfig>(EMPTY_ALERT);
  const [origAlert, setOrigAlert] = useState<AlertConfig>(EMPTY_ALERT);
  const [loading, setSaving]    = useState(false);
  const [fetching, setFetching] = useState(true);

  const load = useCallback(async () => {
    if (!profile?.id) return;
    const [{ data }, { data: alertData }] = await Promise.all([
      supabase
        .from('shift_worker_profiles')
        .select('bio, experience_summary, skills, qualifications, hourly_rate_min, hourly_rate_max')
        .eq('user_id', profile.id)
        .maybeSingle(),
      supabase
        .from('shift_alerts')
        .select('is_active, categories, urgency, min_pay')
        .eq('user_id', profile.id)
        .maybeSingle(),
    ]);

    if (data) {
      const loaded: WorkerProfile = {
        bio:                data.bio                ?? '',
        experience_summary: data.experience_summary ?? '',
        skills:             data.skills             ?? [],
        qualifications:     data.qualifications     ?? [],
        hourly_rate_min:    data.hourly_rate_min    != null ? String(data.hourly_rate_min) : '',
        hourly_rate_max:    data.hourly_rate_max    != null ? String(data.hourly_rate_max) : '',
      };
      setForm(loaded);
      setOriginal(loaded);
    }

    if (alertData) {
      const loadedAlert: AlertConfig = {
        is_active:  alertData.is_active  ?? false,
        categories: alertData.categories ?? [],
        urgency:    alertData.urgency    ?? [],
        min_pay:    alertData.min_pay    != null ? String(alertData.min_pay) : '',
      };
      setAlert(loadedAlert);
      setOrigAlert(loadedAlert);
    }

    setFetching(false);
  }, [profile?.id]);

  useEffect(() => { load(); }, [load]);

  const toggle = (field: 'skills' | 'qualifications', value: string) => {
    Haptics.selectionAsync();
    setForm(prev => {
      const arr = prev[field];
      return {
        ...prev,
        [field]: arr.includes(value) ? arr.filter(v => v !== value) : [...arr, value],
      };
    });
  };

  const handleSave = async () => {
    if (!profile?.id) return;
    setSaving(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    const payload = {
      user_id:            profile.id,
      bio:                form.bio.trim() || null,
      experience_summary: form.experience_summary.trim() || null,
      skills:             form.skills,
      qualifications:     form.qualifications,
      hourly_rate_min:    form.hourly_rate_min ? parseFloat(form.hourly_rate_min) : null,
      hourly_rate_max:    form.hourly_rate_max ? parseFloat(form.hourly_rate_max) : null,
    };

    const alertPayload = {
      user_id:    profile.id,
      is_active:  alert.is_active,
      categories: alert.categories,
      urgency:    alert.urgency,
      min_pay:    alert.min_pay ? parseFloat(alert.min_pay) : null,
    };

    const [{ error }, { error: alertError }] = await Promise.all([
      supabase.from('shift_worker_profiles').upsert(payload, { onConflict: 'user_id' }),
      supabase.from('shift_alerts').upsert(alertPayload, { onConflict: 'user_id' }),
    ]);

    setSaving(false);

    if (error || alertError) {
      Alert.alert('Could not save', (error ?? alertError)!.message);
    } else {
      setOriginal(form);
      setOrigAlert(alert);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Saved', 'Your shift profile has been updated.', [
        { text: 'OK', onPress: () => router.back() },
      ]);
    }
  };

  if (fetching) {
    return (
      <ScreenScaffold
        header={<ScreenHeader title="Shift profile" accent={S.color} onBack={() => router.back()} />}
      >
        <LoadingState accent={S.color} />
      </ScreenScaffold>
    );
  }

  const toggleAlertChip = (field: 'categories' | 'urgency', value: string) => {
    Haptics.selectionAsync();
    setAlert(prev => {
      const arr = prev[field];
      return { ...prev, [field]: arr.includes(value) ? arr.filter(v => v !== value) : [...arr, value] };
    });
  };

  const isDirty = JSON.stringify(form)  !== JSON.stringify(original)
               || JSON.stringify(alert) !== JSON.stringify(origAlert);

  // ── Completeness ──────────────────────────────────────────────────────────
  const completenessItems = [
    { key: 'bio',    label: 'About you',        done: form.bio.trim().length >= 20 },
    { key: 'exp',    label: 'Experience',        done: form.experience_summary.trim().length >= 20 },
    { key: 'rate',   label: 'Pay expectation',   done: !!(form.hourly_rate_min || form.hourly_rate_max) },
    { key: 'skills', label: 'Skills (2+ needed)',done: form.skills.length >= 2 },
    { key: 'quals',  label: 'Qualifications',    done: form.qualifications.length >= 1 },
  ];
  const doneCount = completenessItems.filter(i => i.done).length;
  const pct = Math.round((doneCount / completenessItems.length) * 100);
  const barColor = pct >= 80 ? colors.jobs : pct >= 40 ? '#D97706' : '#DC2626';
  const tagline  = pct === 100
    ? 'Great — your profile is fully complete!'
    : pct >= 60
    ? 'Almost there — fill in the remaining sections.'
    : 'Complete your profile to improve your chances.';

  return (
    <ScreenScaffold
      header={<ScreenHeader title="Shift profile" accent={S.color} onBack={() => router.back()} />}
    >
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
          showsVerticalScrollIndicator={false}
        >
          {/* ── Completeness card ─────────────────────────────────────────── */}
          <View style={styles.completenessCard}>

            {/* Header row */}
            <View style={styles.completenessHeader}>
              <View style={styles.completenessHeaderLeft}>
                <Text style={styles.completenessPct}>
                  <Text style={[styles.completenessPctNum, { color: barColor }]}>{pct}%</Text>
                  {' '}complete
                </Text>
                <Text style={styles.completenessTagline}>{tagline}</Text>
              </View>
              <View style={[styles.completenessRing, { borderColor: barColor }]}>
                <Text style={[styles.completenessRingNum, { color: barColor }]}>{doneCount}</Text>
                <Text style={styles.completenessRingDen}>/{completenessItems.length}</Text>
              </View>
            </View>

            {/* Progress bar */}
            <View style={styles.progressTrack}>
              <View style={[
                styles.progressFill,
                { width: `${pct}%` as any, backgroundColor: barColor },
              ]} />
            </View>

            {/* Item checklist */}
            <View style={styles.checkList}>
              {completenessItems.map(item => (
                <View key={item.key} style={styles.checkRow}>
                  <View style={[
                    styles.checkIcon,
                    { backgroundColor: item.done ? barColor + '22' : colors.border + '66',
                      borderColor:     item.done ? barColor          : colors.border },
                  ]}>
                    <FontAwesome5
                      name={item.done ? 'check' : 'circle'}
                      size={8}
                      color={item.done ? barColor : colors.textLight}
                      solid={item.done}
                    />
                  </View>
                  <Text style={[
                    styles.checkLabel,
                    { color: item.done ? colors.textPrimary : colors.textMuted },
                  ]}>
                    {item.label}
                  </Text>
                </View>
              ))}
            </View>

          </View>

          <Field label="About you" hint="A short paragraph about yourself — your background, what work you enjoy, what makes you reliable.">
            <View style={[styles.inputWrap, { height: 100, alignItems: 'flex-start' }]}>
              <TextInput
                style={[styles.input, { height: 90, textAlignVertical: 'top', paddingTop: 8 }]}
                value={form.bio}
                onChangeText={v => setForm(p => ({ ...p, bio: v }))}
                placeholder="e.g. I'm a hospitality worker with 5 years experience in Shetland's tourism sector…"
                placeholderTextColor={colors.textLight}
                multiline
              />
            </View>
          </Field>

          <Field label="Experience summary" hint="Any relevant previous roles, industries or specific experience.">
            <View style={[styles.inputWrap, { height: 80, alignItems: 'flex-start' }]}>
              <TextInput
                style={[styles.input, { height: 70, textAlignVertical: 'top', paddingTop: 8 }]}
                value={form.experience_summary}
                onChangeText={v => setForm(p => ({ ...p, experience_summary: v }))}
                placeholder="e.g. 3 years kitchen porter, 2 years bar work, seasonal fish farm work…"
                placeholderTextColor={colors.textLight}
                multiline
              />
            </View>
          </Field>

          <Field label="Hourly rate expectation" hint="Optional. Helps employers know if the shift pay matches your expectations.">
            <View style={styles.rateRow}>
              <View style={[styles.inputWrap, { flex: 1 }]}>
                <Text style={styles.ratePrefix}>£</Text>
                <TextInput
                  style={styles.input}
                  value={form.hourly_rate_min}
                  onChangeText={v => setForm(p => ({ ...p, hourly_rate_min: v }))}
                  placeholder="Min"
                  placeholderTextColor={colors.textLight}
                  keyboardType="decimal-pad"
                />
                <Text style={styles.rateSuffix}>/hr</Text>
              </View>
              <Text style={styles.rateSep}>–</Text>
              <View style={[styles.inputWrap, { flex: 1 }]}>
                <Text style={styles.ratePrefix}>£</Text>
                <TextInput
                  style={styles.input}
                  value={form.hourly_rate_max}
                  onChangeText={v => setForm(p => ({ ...p, hourly_rate_max: v }))}
                  placeholder="Max"
                  placeholderTextColor={colors.textLight}
                  keyboardType="decimal-pad"
                />
                <Text style={styles.rateSuffix}>/hr</Text>
              </View>
            </View>
          </Field>

          <Field label="Skills" hint="Select all that apply.">
            <View style={styles.chipRow}>
              {SKILL_OPTIONS.map(skill => (
                <Chip
                  key={skill}
                  label={skill}
                  active={form.skills.includes(skill)}
                  color={S.color}
                  onPress={() => toggle('skills', skill)}
                />
              ))}
            </View>
          </Field>

          <Field label="Qualifications & certificates" hint="Only tick ones you actually hold.">
            <View style={styles.chipRow}>
              {QUALIFICATION_OPTIONS.map(q => (
                <Chip
                  key={q}
                  label={q}
                  active={form.qualifications.includes(q)}
                  color={colors.jobs}
                  onPress={() => toggle('qualifications', q)}
                />
              ))}
            </View>
          </Field>

          {/* ── Shift alert ──────────────────────────────────────────── */}
          <View style={styles.alertCard}>
            {/* Header row with toggle */}
            <View style={styles.alertHeader}>
              <View style={styles.alertHeaderLeft}>
                <View style={[styles.alertIconWrap, { backgroundColor: S.color + '22' }]}>
                  <FontAwesome5 name="bell" size={13} color={S.color} solid />
                </View>
                <View>
                  <Text style={styles.alertTitle}>Shift alert</Text>
                  <Text style={styles.alertSubtitle}>
                    {alert.is_active ? 'Notifying you of matching shifts' : 'Off — tap to enable'}
                  </Text>
                </View>
              </View>
              <Switch
                value={alert.is_active}
                onValueChange={v => { Haptics.selectionAsync(); setAlert(p => ({ ...p, is_active: v })); }}
                trackColor={{ false: colors.border, true: S.color + '88' }}
                thumbColor={alert.is_active ? S.color : '#fff'}
              />
            </View>

            {alert.is_active && (
              <View style={styles.alertBody}>

                <View style={styles.alertSection}>
                  <Text style={styles.alertSectionLabel}>Categories</Text>
                  <Text style={styles.alertSectionHint}>Leave all unselected to match any category.</Text>
                  <View style={styles.chipRow}>
                    {CATEGORY_OPTIONS.map(opt => (
                      <Chip
                        key={opt.value}
                        label={opt.label}
                        active={alert.categories.includes(opt.value)}
                        color={S.color}
                        onPress={() => toggleAlertChip('categories', opt.value)}
                      />
                    ))}
                  </View>
                </View>

                <View style={styles.alertSection}>
                  <Text style={styles.alertSectionLabel}>Urgency</Text>
                  <Text style={styles.alertSectionHint}>Leave all unselected to match any urgency.</Text>
                  <View style={styles.chipRow}>
                    {URGENCY_OPTIONS.map(opt => (
                      <Chip
                        key={opt.value}
                        label={opt.label}
                        active={alert.urgency.includes(opt.value)}
                        color={S.color}
                        onPress={() => toggleAlertChip('urgency', opt.value)}
                      />
                    ))}
                  </View>
                </View>

                <View style={styles.alertSection}>
                  <Text style={styles.alertSectionLabel}>Minimum hourly pay</Text>
                  <Text style={styles.alertSectionHint}>Optional. Only notifies you of hourly shifts at or above this rate.</Text>
                  <View style={[styles.inputWrap, { maxWidth: 140 }]}>
                    <Text style={styles.ratePrefix}>£</Text>
                    <TextInput
                      style={styles.input}
                      value={alert.min_pay}
                      onChangeText={v => setAlert(p => ({ ...p, min_pay: v }))}
                      placeholder="e.g. 12"
                      placeholderTextColor={colors.textLight}
                      keyboardType="decimal-pad"
                    />
                    <Text style={styles.rateSuffix}>/hr</Text>
                  </View>
                </View>

              </View>
            )}
          </View>

          <Button
            label="Save shift profile"
            icon="check"
            color={S.color}
            fullWidth
            onPress={handleSave}
            disabled={!isDirty || loading}
            loading={loading}
            style={styles.saveBtn}
          />

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  scroll:  { flex: 1 },

  content: { padding: spacing.md, gap: 0, paddingBottom: 60 },

  // Completeness card
  completenessCard: {
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.lg,
    gap: 12,
  },
  completenessHeader:    { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  completenessHeaderLeft: { flex: 1, gap: 3 },
  completenessPct:       { fontSize: fontSize.sm, fontWeight: '600', color: colors.textMuted },
  completenessPctNum:    { fontSize: fontSize.lg, fontWeight: '900' },
  completenessTagline:   { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 16 },

  completenessRing: {
    width: 44, height: 44, borderRadius: 22,
    borderWidth: 2.5, alignItems: 'center', justifyContent: 'center',
    flexDirection: 'row', gap: 1,
  },
  completenessRingNum: { fontSize: fontSize.md, fontWeight: '900' },
  completenessRingDen: { fontSize: fontSize.xs,  fontWeight: '600', color: colors.textMuted, alignSelf: 'flex-end', marginBottom: 1 },

  progressTrack: {
    height: 6, backgroundColor: colors.border,
    borderRadius: radius.full, overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: radius.full },

  checkList: { gap: 7 },
  checkRow:  { flexDirection: 'row', alignItems: 'center', gap: 10 },
  checkIcon: {
    width: 20, height: 20, borderRadius: 10,
    borderWidth: 1.5, alignItems: 'center', justifyContent: 'center',
  },
  checkLabel: { fontSize: fontSize.xs, fontWeight: '600' },

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

  rateRow:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ratePrefix: { color: colors.textMuted, fontSize: fontSize.sm, fontWeight: '600', marginRight: 2 },
  rateSuffix: { color: colors.textMuted, fontSize: fontSize.xs, marginLeft: 2 },
  rateSep:    { fontSize: fontSize.md, color: colors.textMuted, fontWeight: '600' },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 7,
    backgroundColor: '#fff', borderRadius: radius.full,
    borderWidth: 1.5, borderColor: colors.border,
  },
  chipText: { fontSize: fontSize.xs, fontWeight: '600', color: colors.textMuted },

  // Alert card
  alertCard: {
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    overflow: 'hidden',
    marginBottom: spacing.lg,
  },
  alertHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: spacing.md,
  },
  alertHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  alertIconWrap: { width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  alertTitle:    { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  alertSubtitle: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  alertBody: { paddingHorizontal: spacing.md, paddingBottom: spacing.md, gap: 16 },
  alertSection: { gap: 6 },
  alertSectionLabel: { fontSize: fontSize.xs, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  alertSectionHint:  { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 15 },

  saveBtn: { marginTop: 8 },
});
