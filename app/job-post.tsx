/**
 * app/job-post.tsx — create or edit a job. Pass ?businessId= (required) and
 * optional ?jobId= to edit.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, Switch,
  ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { Button } from '@/components/ui/Button';
import { useAlert } from '@/components/BrandedAlert';
import { useAuth } from '@/context/AuthContext';
import {
  fetchJob, createJob, updateJob,
  JOB_CATEGORIES, CONTRACT_LABELS, REMOTE_LABELS,
  type ContractType, type RemoteMode, type PayPeriod, type JobInput,
} from '@/lib/jobs-api';
import { track } from '@/lib/analytics';

const S = SECTIONS.jobs;
const CONTRACTS: ContractType[] = ['full-time', 'part-time', 'casual', 'apprenticeship', 'freelance', 'volunteer'];
const REMOTES:   RemoteMode[]   = ['on_site', 'hybrid', 'remote'];
const PERIODS:   PayPeriod[]    = ['hour', 'day', 'week', 'month', 'year'];
const PERIOD_LABEL: Record<PayPeriod, string> = { hour: 'per hour', day: 'per day', week: 'per week', month: 'per month', year: 'per year', total: 'total' };
const EXPIRY = [{ label: 'No close date', days: 0 }, { label: '30 days', days: 30 }, { label: '60 days', days: 60 }, { label: '90 days', days: 90 }];

export default function JobPostScreen() {
  const { businessId, jobId } = useLocalSearchParams<{ businessId: string; jobId?: string }>();
  const router = useRouter();
  const { alert } = useAlert();
  const { profile } = useAuth();
  const { screenWidth } = useAppLayout();
  const isEdit = !!jobId;

  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving]   = useState(false);

  const [title, setTitle]       = useState('');
  const [desc, setDesc]         = useState('');
  const [category, setCategory] = useState<string>('Hospitality');
  const [location, setLocation] = useState('');
  const [contract, setContract] = useState<ContractType>('full-time');
  const [remote, setRemote]     = useState<RemoteMode>('on_site');
  const [payHidden, setPayHidden] = useState(false);
  const [payMin, setPayMin]     = useState('');
  const [payMax, setPayMax]     = useState('');
  const [payPeriod, setPayPeriod] = useState<PayPeriod>('year');
  const [payText, setPayText]   = useState('');
  const [relocation, setRelocation] = useState(false);
  const [housing, setHousing]   = useState(false);
  const [seasonal, setSeasonal] = useState(false);
  const [seasonLabel, setSeasonLabel] = useState('');
  const [applyUrl, setApplyUrl] = useState('');
  const [applyEmail, setApplyEmail] = useState('');
  const [expiryDays, setExpiryDays] = useState(0);

  const load = useCallback(async () => {
    if (!jobId) return;
    const j = await fetchJob(jobId);
    if (!j) { setLoading(false); return; }
    setTitle(j.title); setDesc(j.description ?? ''); setCategory(j.category ?? 'Hospitality');
    setLocation(j.locality ?? j.location ?? ''); setContract(j.contract_type); setRemote(j.remote_mode);
    setPayHidden(j.pay_hidden);
    setPayMin(j.pay_min != null ? String(j.pay_min) : ''); setPayMax(j.pay_max != null ? String(j.pay_max) : '');
    if (j.pay_period) setPayPeriod(j.pay_period);
    setPayText(j.pay_text ?? '');
    setRelocation(j.relocation_support); setHousing(j.housing_available);
    setSeasonal(j.is_seasonal); setSeasonLabel(j.season_label ?? '');
    setApplyUrl(j.apply_url ?? ''); setApplyEmail(j.apply_email ?? '');
    setLoading(false);
  }, [jobId]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!title.trim()) { alert({ title: 'Title needed', message: 'Give the role a title.' }); return; }
    if (!profile) return;
    setSaving(true);
    try {
      const expires = expiryDays > 0 ? new Date(Date.now() + expiryDays * 86_400_000).toISOString() : null;
      const payload: JobInput = {
        posted_as_business_id: businessId,
        title: title.trim(),
        description: desc.trim() || null,
        category,
        location: location.trim() || null,
        locality: location.trim() || null,
        contract_type: contract,
        remote_mode: remote,
        pay_hidden: payHidden,
        pay_min: !payHidden && payMin ? Number(payMin) : null,
        pay_max: !payHidden && payMax ? Number(payMax) : null,
        pay_period: !payHidden ? payPeriod : null,
        pay_text: payHidden ? (payText.trim() || null) : null,
        relocation_support: relocation,
        housing_available: housing,
        is_seasonal: seasonal,
        season_label: seasonal ? (seasonLabel.trim() || null) : null,
        apply_url: applyUrl.trim() || null,
        apply_email: applyEmail.trim() || null,
        expires_at: expires,
        is_hidden: false,
        status: 'open',
      };
      let targetId = jobId as string | undefined;
      if (isEdit && jobId) await updateJob(jobId, payload);
      else { const j = await createJob(profile.id, payload); targetId = j.id; track('job_posted', { objectType: 'job', objectId: j.id, businessId: businessId ?? null }); }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace(`/job-applicants?jobId=${targetId}`);
    } catch (e: any) {
      alert({ title: 'Could not save', message: e?.message ?? '' });
    } finally { setSaving(false); }
  };

  if (loading) {
    return <SafeAreaView style={[styles.safe, styles.center]}><ActivityIndicator color={S.color} size="large" /></SafeAreaView>;
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScreenHeader title={isEdit ? 'Edit job' : 'Post a job'} onClose={() => router.back()} accent={S.color} />

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={[styles.content, contentContainer(screenWidth)]} keyboardShouldPersistTaps="handled">
          <Field label="Job title *"><TextInput style={styles.input} value={title} onChangeText={setTitle} placeholder="e.g. Sous Chef" placeholderTextColor={colors.textLight} /></Field>
          <Field label="Description"><TextInput style={[styles.input, styles.multi]} value={desc} onChangeText={setDesc} placeholder="The role, who you're looking for, hours, perks…" placeholderTextColor={colors.textLight} multiline /></Field>

          <Field label="Category">
            <ChipRow items={JOB_CATEGORIES as readonly string[]} value={category} onPick={setCategory} />
          </Field>
          <Field label="Contract type">
            <ChipRow items={CONTRACTS} value={contract} label={(c) => CONTRACT_LABELS[c as ContractType]} onPick={(v) => setContract(v as ContractType)} />
          </Field>
          <Field label="Working location">
            <ChipRow items={REMOTES} value={remote} label={(r) => REMOTE_LABELS[r as RemoteMode]} onPick={(v) => setRemote(v as RemoteMode)} />
          </Field>
          <Field label="Where (locality)"><TextInput style={styles.input} value={location} onChangeText={setLocation} placeholder="e.g. Lerwick" placeholderTextColor={colors.textLight} /></Field>

          {/* Pay */}
          <View style={styles.payToggleRow}>
            <View style={{ flex: 1 }}><Text style={styles.fieldLabel}>Show a salary</Text><Text style={styles.hint}>89% more likely to get applicants when pay is shown.</Text></View>
            <Switch value={!payHidden} onValueChange={(v) => setPayHidden(!v)} trackColor={{ true: S.color }} />
          </View>
          {!payHidden ? (
            <>
              <View style={styles.payRow}>
                <View style={{ flex: 1 }}><TextInput style={styles.input} value={payMin} onChangeText={setPayMin} keyboardType="number-pad" placeholder="From £" placeholderTextColor={colors.textLight} /></View>
                <View style={{ flex: 1 }}><TextInput style={styles.input} value={payMax} onChangeText={setPayMax} keyboardType="number-pad" placeholder="To £" placeholderTextColor={colors.textLight} /></View>
              </View>
              <ChipRow items={PERIODS} value={payPeriod} label={(p) => PERIOD_LABEL[p as PayPeriod]} onPick={(v) => setPayPeriod(v as PayPeriod)} />
            </>
          ) : (
            <Field label="Pay note (optional)"><TextInput style={styles.input} value={payText} onChangeText={setPayText} placeholder="e.g. Competitive / DOE" placeholderTextColor={colors.textLight} /></Field>
          )}

          {/* Shetland levers */}
          <Toggle label="Relocation support" hint="Help with moving to Shetland" value={relocation} onChange={setRelocation} />
          <Toggle label="Housing available" hint="Accommodation comes with the role" value={housing} onChange={setHousing} />
          <Toggle label="Seasonal role" hint="Tourism / fishing season etc." value={seasonal} onChange={setSeasonal} />
          {seasonal ? <Field label="Season"><TextInput style={styles.input} value={seasonLabel} onChangeText={setSeasonLabel} placeholder="e.g. Summer 2026" placeholderTextColor={colors.textLight} /></Field> : null}

          <Field label="Auto-close listing"><ChipRow items={EXPIRY.map(e => String(e.days))} value={String(expiryDays)} label={(d) => EXPIRY.find(e => String(e.days) === d)!.label} onPick={(v) => setExpiryDays(Number(v))} /></Field>

          <Field label="Apply on a website (optional)"><TextInput style={styles.input} value={applyUrl} onChangeText={setApplyUrl} autoCapitalize="none" placeholder="https://…" placeholderTextColor={colors.textLight} /></Field>
          <Field label="Apply by email (optional)"><TextInput style={styles.input} value={applyEmail} onChangeText={setApplyEmail} autoCapitalize="none" keyboardType="email-address" placeholder="jobs@…" placeholderTextColor={colors.textLight} /></Field>

          <Button label={isEdit ? 'Save changes' : 'Publish job'} icon="check" color={S.color} fullWidth loading={saving} disabled={saving} onPress={save} style={styles.saveBtn} />
          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <View style={styles.field}><Text style={styles.fieldLabel}>{label}</Text>{children}</View>;
}
function Toggle({ label, hint, value, onChange }: { label: string; hint: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={styles.payToggleRow}>
      <View style={{ flex: 1 }}><Text style={styles.fieldLabel}>{label}</Text><Text style={styles.hint}>{hint}</Text></View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: S.color }} />
    </View>
  );
}
function ChipRow({ items, value, onPick, label }: { items: readonly string[]; value: string; onPick: (v: string) => void; label?: (v: string) => string }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 2 }}>
      {items.map(it => {
        const on = value === it;
        return (
          <TouchableOpacity key={it} style={[styles.chip, on && { backgroundColor: S.color, borderColor: S.color }]} onPress={() => onPick(it)} activeOpacity={0.8}>
            <Text style={[styles.chipText, on && { color: '#fff' }]}>{label ? label(it) : it}</Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: spacing.md },
  field: { marginBottom: spacing.md },
  fieldLabel: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary, marginBottom: 6 },
  hint: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: fontSize.md, color: colors.textPrimary, backgroundColor: '#fff' },
  multi: { minHeight: 110, textAlignVertical: 'top' },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border },
  chipText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary },
  payToggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: spacing.sm },
  payRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm },
  saveBtn: { marginTop: spacing.sm },
});
