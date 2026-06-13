/**
 * app/work-profile.tsx — the shared worker profile (the candidate's CV) +
 * a small saved cover-letter library. One profile feeds both Jobs and Shifts.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, Switch,
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import {
  ensureWorkerProfile, upsertWorkerProfile,
  fetchCvDocuments, saveCvDocument, deleteCvDocument,
  type WorkerProfile, type CvDocument,
} from '@/lib/jobs-api';

const S = SECTIONS.jobs;
const splitList = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);

export default function WorkProfileScreen() {
  const router = useRouter();
  const { profile } = useAuth();

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

  const load = useCallback(async () => {
    if (!profile) { setLoading(false); return; }
    try {
      const [wp, cvs] = await Promise.all([ensureWorkerProfile(profile.id), fetchCvDocuments(profile.id)]);
      setHeadline(wp.headline ?? '');
      setSummary(wp.summary ?? '');
      setSkills((wp.skills ?? []).join(', '));
      setQuals((wp.qualifications ?? []).join(', '));
      setPay(wp.desired_pay_text ?? '');
      setRelocate(wp.willing_to_relocate);
      setDiaspora(wp.is_diaspora);
      setDocs(cvs.filter(d => d.kind === 'cover_letter'));
    } finally { setLoading(false); }
  }, [profile?.id]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!profile) return;
    setSaving(true);
    try {
      await upsertWorkerProfile(profile.id, {
        headline: headline.trim() || null,
        summary: summary.trim() || null,
        skills: splitList(skills),
        qualifications: splitList(quals),
        desired_pay_text: pay.trim() || null,
        willing_to_relocate: relocate,
        is_diaspora: diaspora,
      } as Partial<WorkerProfile>);
      Alert.alert('Saved', 'Your work profile is up to date.');
    } catch (e: any) {
      Alert.alert('Could not save', e?.message ?? '');
    } finally { setSaving(false); }
  };

  const addCoverLetter = () => {
    Alert.prompt?.('Saved cover letter', 'Give it a name (e.g. "Hospitality"):', async (label?: string) => {
      if (!label?.trim() || !profile) return;
      try {
        const d = await saveCvDocument(profile.id, { kind: 'cover_letter', label: label.trim(), body: '' });
        setDocs(prev => [d, ...prev]);
      } catch (e: any) { Alert.alert('Failed', e?.message ?? ''); }
    });
  };

  const removeDoc = (d: CvDocument) => {
    Alert.alert('Delete?', `Remove "${d.label}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { try { await deleteCvDocument(d.id); setDocs(prev => prev.filter(x => x.id !== d.id)); } catch {} } },
    ]);
  };

  if (!profile) {
    return <SafeAreaView style={[styles.safe, styles.center]}><Text style={styles.muted}>Sign in to build your work profile.</Text></SafeAreaView>;
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My work profile</Text>
        <View style={{ width: 70 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={S.color} /></View>
      ) : (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Text style={styles.intro}>This is your CV across OneShetland — it's sent with every job application. Fill it out once.</Text>

            <Field label="Headline"><TextInput style={styles.input} value={headline} onChangeText={setHeadline} placeholder="e.g. Experienced chef · Lerwick" placeholderTextColor={colors.textLight} /></Field>
            <Field label="About you"><TextInput style={[styles.input, styles.multi]} value={summary} onChangeText={setSummary} placeholder="A short summary of your experience and what you're looking for…" placeholderTextColor={colors.textLight} multiline /></Field>
            <Field label="Skills (comma separated)"><TextInput style={styles.input} value={skills} onChangeText={setSkills} placeholder="Cooking, Food hygiene, Rota planning" placeholderTextColor={colors.textLight} /></Field>
            <Field label="Qualifications (comma separated)"><TextInput style={styles.input} value={quals} onChangeText={setQuals} placeholder="SVQ2 Professional Cookery, Elementary Food Hygiene" placeholderTextColor={colors.textLight} /></Field>
            <Field label="Pay expectation (optional)"><TextInput style={styles.input} value={pay} onChangeText={setPay} placeholder="e.g. £13–15/hr or negotiable" placeholderTextColor={colors.textLight} /></Field>

            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}><Text style={styles.switchLabel}>Willing to relocate to Shetland</Text><Text style={styles.switchHint}>Shows you to employers offering relocation</Text></View>
              <Switch value={relocate} onValueChange={setRelocate} trackColor={{ true: S.color }} />
            </View>
            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}><Text style={styles.switchLabel}>I'm a Shetlander living away</Text><Text style={styles.switchHint}>Open to moving home for the right role</Text></View>
              <Switch value={diaspora} onValueChange={setDiaspora} trackColor={{ true: S.color }} />
            </View>

            <TouchableOpacity style={[styles.saveBtn, { backgroundColor: S.color, opacity: saving ? 0.5 : 1 }]} onPress={save} disabled={saving} activeOpacity={0.9}>
              {saving ? <ActivityIndicator color="#fff" /> : <><FontAwesome5 name="check" size={14} color="#fff" /><Text style={styles.saveBtnText}>Save profile</Text></>}
            </TouchableOpacity>

            {/* Saved cover letters */}
            <View style={styles.sectionHead}>
              <Text style={styles.sectionTitle}>Saved cover letters</Text>
              {Platform.OS === 'ios' ? (
                <TouchableOpacity onPress={addCoverLetter} hitSlop={8} style={styles.addBtn}><FontAwesome5 name="plus" size={11} color={S.color} solid /><Text style={[styles.addBtnText, { color: S.color }]}>Add</Text></TouchableOpacity>
              ) : null}
            </View>
            <Text style={styles.intro}>Reusable templates. You can also draft a tailored one with AI when you apply.</Text>
            {docs.length === 0 ? (
              <Text style={styles.muted}>None yet.</Text>
            ) : docs.map(d => (
              <View key={d.id} style={styles.docRow}>
                <FontAwesome5 name="file-alt" size={14} color={S.color} solid />
                <Text style={styles.docLabel} numberOfLines={1}>{d.label}{d.generated_by_ai ? '  · AI' : ''}</Text>
                <TouchableOpacity onPress={() => removeDoc(d)} hitSlop={8}><FontAwesome5 name="trash-alt" size={13} color={colors.textLight} /></TouchableOpacity>
              </View>
            ))}

            <View style={{ height: 40 }} />
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <View style={styles.field}><Text style={styles.fieldLabel}>{label}</Text>{children}</View>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  muted: { color: colors.textMuted, fontSize: fontSize.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md, paddingBottom: spacing.sm, borderBottomWidth: 2, backgroundColor: '#fff' },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, width: 70 },
  backText: { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },

  content: { padding: spacing.md },
  intro: { fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 20, marginBottom: spacing.md },
  field: { marginBottom: spacing.md },
  fieldLabel: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary, marginBottom: 6 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: fontSize.md, color: colors.textPrimary, backgroundColor: '#fff' },
  multi: { minHeight: 96, textAlignVertical: 'top' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: spacing.sm },
  switchLabel: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  switchHint: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
  saveBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: spacing.md, borderRadius: 999, marginTop: spacing.sm },
  saveBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },

  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.xl, marginBottom: 4 },
  sectionTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  addBtnText: { fontSize: fontSize.sm, fontWeight: '800' },
  docRow: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: spacing.sm },
  docLabel: { flex: 1, fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
});
