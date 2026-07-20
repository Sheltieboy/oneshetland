/**
 * app/work-profile.tsx — the one unified worker profile (the candidate's CV) +
 * a small saved cover-letter library. ONE profile feeds both Jobs and Shifts,
 * plus the "notify me of matching shifts" (shift_alerts) config.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, Switch,
  Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { Button } from '@/components/ui/Button';
import { useAlert } from '@/components/BrandedAlert';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingState } from '@/components/ui/LoadingState';
import {
  ensureWorkerProfile, upsertWorkerProfile,
  fetchCvDocuments, saveCvDocument, deleteCvDocument,
  type WorkerProfile, type CvDocument,
} from '@/lib/jobs-api';

const S = SECTIONS.jobs;
const SHIFTS = SECTIONS.shifts;
const splitList = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);

// Shift-alert option lists (reused from the former shift-worker-profile screen).
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

export default function WorkProfileScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const { screenWidth } = useAppLayout();
  const { alert } = useAlert();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [headline, setHeadline]   = useState('');
  const [summary, setSummary]     = useState('');
  const [skills, setSkills]       = useState('');
  const [quals, setQuals]         = useState('');
  const [pay, setPay]             = useState('');
  const [relocate, setRelocate]   = useState(false);
  const [diaspora, setDiaspora]   = useState(false);
  const [docs, setDocs]           = useState<CvDocument[]>([]);

  // Shift-side fields (same worker_profiles row).
  const [experience, setExperience] = useState('');
  const [rateMin, setRateMin]       = useState('');
  const [rateMax, setRateMax]       = useState('');

  // "Notify me of matching shifts" — the shift_alerts row.
  const [alertActive, setAlertActive]         = useState(false);
  const [alertCategories, setAlertCategories] = useState<string[]>([]);
  const [alertUrgency, setAlertUrgency]       = useState<string[]>([]);
  const [alertMinPay, setAlertMinPay]         = useState('');

  const load = useCallback(async () => {
    if (!profile) { setLoading(false); return; }
    try {
      const [wp, cvs, alertRes] = await Promise.all([
        ensureWorkerProfile(profile.id),
        fetchCvDocuments(profile.id),
        supabase.from('shift_alerts')
          .select('is_active, categories, urgency, min_pay')
          .eq('user_id', profile.id)
          .maybeSingle(),
      ]);
      setHeadline(wp.headline ?? '');
      setSummary(wp.summary ?? '');
      setSkills((wp.skills ?? []).join(', '));
      setQuals((wp.qualifications ?? []).join(', '));
      setPay(wp.desired_pay_text ?? '');
      setRelocate(wp.willing_to_relocate);
      setDiaspora(wp.is_diaspora);
      setExperience(wp.experience_summary ?? '');
      setRateMin(wp.hourly_rate_min != null ? String(wp.hourly_rate_min) : '');
      setRateMax(wp.hourly_rate_max != null ? String(wp.hourly_rate_max) : '');
      setDocs(cvs.filter(d => d.kind === 'cover_letter'));

      const a = alertRes.data;
      if (a) {
        setAlertActive(a.is_active ?? false);
        setAlertCategories(a.categories ?? []);
        setAlertUrgency(a.urgency ?? []);
        setAlertMinPay(a.min_pay != null ? String(a.min_pay) : '');
      }
    } finally { setLoading(false); }
  }, [profile?.id]);

  useEffect(() => { void load(); }, [load]);

  const toggleAlertChip = (list: string[], setList: (v: string[]) => void, value: string) => {
    setList(list.includes(value) ? list.filter(v => v !== value) : [...list, value]);
  };

  const save = async () => {
    if (!profile) return;
    setSaving(true);
    try {
      // The unified worker_profiles row — Jobs fields + Shift fields together.
      // WorkerProfile includes experience_summary / hourly_rate_min / hourly_rate_max,
      // so all fields go through the helper (no separate direct upsert needed).
      await upsertWorkerProfile(profile.id, {
        headline: headline.trim() || null,
        summary: summary.trim() || null,
        skills: splitList(skills),
        qualifications: splitList(quals),
        desired_pay_text: pay.trim() || null,
        willing_to_relocate: relocate,
        is_diaspora: diaspora,
        experience_summary: experience.trim() || null,
        hourly_rate_min: rateMin ? parseFloat(rateMin) : null,
        hourly_rate_max: rateMax ? parseFloat(rateMax) : null,
      } as Partial<WorkerProfile>);

      const { error: alertError } = await supabase.from('shift_alerts').upsert({
        user_id:    profile.id,
        is_active:  alertActive,
        categories: alertCategories,
        urgency:    alertUrgency,
        min_pay:    alertMinPay ? parseFloat(alertMinPay) : null,
      }, { onConflict: 'user_id' });
      if (alertError) throw alertError;

      alert({ title: 'Saved', message: 'Your work profile is up to date.' });
    } catch (e: any) {
      alert({ title: 'Could not save', message: e?.message ?? '' });
    } finally { setSaving(false); }
  };

  const addCoverLetter = () => {
    Alert.prompt?.('Saved cover letter', 'Give it a name (e.g. "Hospitality"):', async (label?: string) => {
      if (!label?.trim() || !profile) return;
      try {
        const d = await saveCvDocument(profile.id, { kind: 'cover_letter', label: label.trim(), body: '' });
        setDocs(prev => [d, ...prev]);
      } catch (e: any) { alert({ title: 'Failed', message: e?.message ?? '' }); }
    });
  };

  const removeDoc = (d: CvDocument) => {
    alert({
      title: 'Delete?',
      message: `Remove "${d.label}"?`,
      actions: [
        { label: 'Cancel', style: 'cancel' },
        { label: 'Delete', style: 'destructive', onPress: async () => { try { await deleteCvDocument(d.id); setDocs(prev => prev.filter(x => x.id !== d.id)); } catch (e: any) { alert({ title: 'Could not delete', message: e?.message ?? 'Please try again.' }); } } },
      ],
    });
  };

  if (!profile) {
    return (
      <ScreenScaffold header={<ScreenHeader title="My work profile" accent={S.color} onBack={() => router.back()} />}>
        <EmptyState
          icon="id-badge"
          title="Sign in required"
          body="Sign in to build your work profile."
          accent={S.color}
          variant="card"
        />
      </ScreenScaffold>
    );
  }

  return (
    <ScreenScaffold header={<ScreenHeader title="My work profile" accent={S.color} onBack={() => router.back()} />}>
      {loading ? (
        <LoadingState accent={S.color} />
      ) : (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={[styles.content, contentContainer(screenWidth)]} keyboardShouldPersistTaps="handled">
            <Text style={styles.intro}>This is your one work profile — what employers see whether you apply for a job or a shift. Fill it out once.</Text>

            {/* ── 1. About you ─────────────────────────────────────────────── */}
            <Text style={styles.groupTitle}>About you</Text>
            <Field label="Headline"><TextInput style={styles.input} value={headline} onChangeText={setHeadline} placeholder="e.g. Experienced chef · Lerwick" placeholderTextColor={colors.textLight} /></Field>
            <Field label="About you"><TextInput style={[styles.input, styles.multi]} value={summary} onChangeText={setSummary} placeholder="A short summary of your experience and what you're looking for…" placeholderTextColor={colors.textLight} multiline /></Field>
            <Field label="Skills (comma separated)"><TextInput style={styles.input} value={skills} onChangeText={setSkills} placeholder="Cooking, Food hygiene, Rota planning" placeholderTextColor={colors.textLight} /></Field>
            <Field label="Qualifications (comma separated)"><TextInput style={styles.input} value={quals} onChangeText={setQuals} placeholder="SVQ2 Professional Cookery, Elementary Food Hygiene" placeholderTextColor={colors.textLight} /></Field>

            {/* ── 2. For jobs ──────────────────────────────────────────────── */}
            <Text style={styles.groupTitle}>For jobs</Text>
            <Field label="Pay expectation (optional)"><TextInput style={styles.input} value={pay} onChangeText={setPay} placeholder="e.g. £13–15/hr or negotiable" placeholderTextColor={colors.textLight} /></Field>

            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}><Text style={styles.switchLabel}>Willing to relocate to Shetland</Text><Text style={styles.switchHint}>Shows you to employers offering relocation</Text></View>
              <Switch value={relocate} onValueChange={setRelocate} trackColor={{ true: S.color }} />
            </View>
            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}><Text style={styles.switchLabel}>I'm a Shetlander living away</Text><Text style={styles.switchHint}>Open to moving home for the right role</Text></View>
              <Switch value={diaspora} onValueChange={setDiaspora} trackColor={{ true: S.color }} />
            </View>

            {/* Saved cover letters */}
            <View style={styles.sectionHead}>
              <Text style={styles.sectionTitle}>Saved cover letters</Text>
              {Platform.OS === 'ios' ? (
                <TouchableOpacity onPress={addCoverLetter} hitSlop={8} style={styles.addBtn}><FontAwesome5 name="plus" size={11} color={S.color} solid /><Text style={[styles.addBtnText, { color: S.color }]}>Add</Text></TouchableOpacity>
              ) : null}
            </View>
            <Text style={styles.intro}>Reusable templates. You can also draft a tailored one with Peerie Bot when you apply.</Text>
            {docs.length === 0 ? (
              <EmptyState icon="file-alt" title="No saved cover letters" body="None yet." accent={S.color} variant="card" />
            ) : docs.map(d => (
              <View key={d.id} style={styles.docRow}>
                <FontAwesome5 name="file-alt" size={14} color={S.color} solid />
                <Text style={styles.docLabel} numberOfLines={1}>{d.label}{d.generated_by_ai ? '  · AI' : ''}</Text>
                <TouchableOpacity onPress={() => removeDoc(d)} hitSlop={8}><FontAwesome5 name="trash-alt" size={13} color={colors.textLight} /></TouchableOpacity>
              </View>
            ))}

            {/* ── 3. For shifts ────────────────────────────────────────────── */}
            <Text style={styles.groupTitle}>For shifts</Text>
            <Field label="Experience summary"><TextInput style={[styles.input, styles.multi]} value={experience} onChangeText={setExperience} placeholder="e.g. 3 years kitchen porter, 2 years bar work, seasonal fish farm work…" placeholderTextColor={colors.textLight} multiline /></Field>
            <Field label="Hourly rate expectation (optional)">
              <View style={styles.rateRow}>
                <View style={styles.rateInputWrap}>
                  <Text style={styles.ratePrefix}>£</Text>
                  <TextInput style={styles.rateInput} value={rateMin} onChangeText={setRateMin} placeholder="Min" placeholderTextColor={colors.textLight} keyboardType="decimal-pad" />
                  <Text style={styles.rateSuffix}>/hr</Text>
                </View>
                <Text style={styles.rateSep}>–</Text>
                <View style={styles.rateInputWrap}>
                  <Text style={styles.ratePrefix}>£</Text>
                  <TextInput style={styles.rateInput} value={rateMax} onChangeText={setRateMax} placeholder="Max" placeholderTextColor={colors.textLight} keyboardType="decimal-pad" />
                  <Text style={styles.rateSuffix}>/hr</Text>
                </View>
              </View>
            </Field>

            {/* ── 4. Notify me of matching shifts ──────────────────────────── */}
            <Text style={styles.groupTitle}>Notify me of matching shifts</Text>
            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}><Text style={styles.switchLabel}>Active</Text><Text style={styles.switchHint}>{alertActive ? 'Notifying you of matching shifts' : 'Off — turn on to get shift alerts'}</Text></View>
              <Switch value={alertActive} onValueChange={setAlertActive} trackColor={{ true: SHIFTS.color }} />
            </View>

            {alertActive ? (
              <>
                <Field label="Categories">
                  <Text style={styles.hint}>Leave all unselected to match any category.</Text>
                  <View style={styles.chipRow}>
                    {CATEGORY_OPTIONS.map(opt => (
                      <Chip key={opt.value} label={opt.label} active={alertCategories.includes(opt.value)} color={SHIFTS.color} onPress={() => toggleAlertChip(alertCategories, setAlertCategories, opt.value)} />
                    ))}
                  </View>
                </Field>
                <Field label="Urgency">
                  <Text style={styles.hint}>Leave all unselected to match any urgency.</Text>
                  <View style={styles.chipRow}>
                    {URGENCY_OPTIONS.map(opt => (
                      <Chip key={opt.value} label={opt.label} active={alertUrgency.includes(opt.value)} color={SHIFTS.color} onPress={() => toggleAlertChip(alertUrgency, setAlertUrgency, opt.value)} />
                    ))}
                  </View>
                </Field>
                <Field label="Minimum hourly pay (optional)">
                  <View style={[styles.rateInputWrap, { maxWidth: 140 }]}>
                    <Text style={styles.ratePrefix}>£</Text>
                    <TextInput style={styles.rateInput} value={alertMinPay} onChangeText={setAlertMinPay} placeholder="e.g. 12" placeholderTextColor={colors.textLight} keyboardType="decimal-pad" />
                    <Text style={styles.rateSuffix}>/hr</Text>
                  </View>
                </Field>
              </>
            ) : null}

            <Button label="Save profile" icon="check" color={S.color} fullWidth onPress={save} loading={saving} style={styles.saveBtn} />

            <View style={{ height: 40 }} />
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </ScreenScaffold>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <View style={styles.field}><Text style={styles.fieldLabel}>{label}</Text>{children}</View>;
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

const styles = StyleSheet.create({
  content: { padding: spacing.md },
  intro: { fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 20, marginBottom: spacing.md },
  groupTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary, marginTop: spacing.lg, marginBottom: spacing.sm },
  field: { marginBottom: spacing.md },
  fieldLabel: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary, marginBottom: 6 },
  hint: { fontSize: fontSize.xs, color: colors.textMuted, marginBottom: 8, lineHeight: 16 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: fontSize.md, color: colors.textPrimary, backgroundColor: '#fff' },
  multi: { minHeight: 96, textAlignVertical: 'top' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: spacing.sm },
  switchLabel: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  switchHint: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
  saveBtn: { marginTop: spacing.md },

  // Hourly-rate inputs
  rateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rateInputWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, minHeight: 46 },
  rateInput: { flex: 1, color: colors.textPrimary, fontSize: fontSize.md, paddingVertical: 10 },
  ratePrefix: { color: colors.textMuted, fontSize: fontSize.sm, fontWeight: '600', marginRight: 2 },
  rateSuffix: { color: colors.textMuted, fontSize: fontSize.xs, marginLeft: 2 },
  rateSep: { fontSize: fontSize.md, color: colors.textMuted, fontWeight: '600' },

  // Chips (shift-alert multi-selects)
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 7, backgroundColor: '#fff', borderRadius: radius.full, borderWidth: 1.5, borderColor: colors.border },
  chipText: { fontSize: fontSize.xs, fontWeight: '600', color: colors.textMuted },

  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.xl, marginBottom: 4 },
  sectionTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  addBtnText: { fontSize: fontSize.sm, fontWeight: '800' },
  docRow: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: spacing.sm },
  docLabel: { flex: 1, fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
});
