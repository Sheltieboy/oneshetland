/**
 * funeral-notice-submit.tsx — submit a Deaths & Funeral Notice for checking (submit_funeral_notice). Sign-in required.
 *
 * Everything is optional except what the contract requires (the name, who you are, a private way to reach you, and your authority to
 * announce). Funeral arrangements are asked for, and sent, ONLY behind the explicit "publish the funeral arrangements" choice.
 * Notification choices default to OFF. Nothing is public until our team has checked it with the family.
 */
import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, TextInput, Switch, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { FUNERAL } from '@/components/notices/FuneralTemplate';
import { AreaPicker } from '@/components/notices/AreaPicker';
import { EMPTY_SUBMISSION, SERVICE_KIND_LABEL, validateSubmission, type SubmissionForm } from '@/lib/funeral-notices';
import { submitFuneralNotice, loadAreas, type AreaOption } from '@/lib/notices-alerts-api';
import { useAuth } from '@/context/AuthContext';
import { useAlert } from '@/components/BrandedAlert';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 5 }}>
      <Text style={styles.label}>{label}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      {children}
    </View>
  );
}

export default function FuneralNoticeSubmitScreen() {
  const router = useRouter();
  const { screenWidth } = useAppLayout();
  const { profile } = useAuth();
  const { alert } = useAlert();
  const [f, setF] = useState<SubmissionForm>(EMPTY_SUBMISSION);
  const [areas, setAreas] = useState<AreaOption[]>([]);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof SubmissionForm>(k: K, v: SubmissionForm[K]) => setF((p) => ({ ...p, [k]: v }));
  const text = (k: keyof SubmissionForm, label: string, extra: object = {}) => (
    <TextInput value={String(f[k] ?? '')} onChangeText={(v) => set(k as any, v as any)} style={styles.input} accessibilityLabel={label} placeholderTextColor={colors.textLight} {...extra} />
  );
  const areaName = areas.find((a) => a.id === f.areaId)?.name ?? null;

  const openPicker = () => { if (areas.length === 0) loadAreas().then(setAreas).catch(() => {}); setPicker(true); };

  const submit = async () => {
    const problems = validateSubmission(f);
    if (problems.length) { alert({ title: 'Please check the form', message: problems.join('\n\n') }); return; }
    setBusy(true);
    try {
      await submitFuneralNotice(f);
      alert({
        title: 'Thank you',
        message: 'Your notice has been received. It is checked with the family or funeral director before anything is published, and nothing appears until then. You can follow it under My submissions.',
        actions: [{ label: 'View my submissions', style: 'primary', onPress: () => router.replace('/my-funeral-notices' as any) }],
      });
    } catch (e) {
      alert({ title: 'Not sent', message: e instanceof Error && e.message && e.message.length < 200 ? e.message : 'Something went wrong. Please try again.' });
    } finally { setBusy(false); }
  };

  return (
    <ScreenScaffold header={<ScreenHeader title="Submit a funeral notice" accent={FUNERAL.burgundy} onBack={() => (router.canGoBack() ? router.back() : router.replace('/notices' as any))} />}>
      {!profile ? (
        <View style={styles.center}>
          <Text style={styles.big}>Sign in to submit a notice</Text>
          <Text style={styles.hint}>We ask you to sign in so that notices can be checked with a real person, and so you can follow or withdraw yours.</Text>
          <Pressable onPress={() => router.push('/(auth)/sign-in' as any)} accessibilityRole="button" style={[styles.btn, styles.btnPrimary]}><Text style={[styles.btnText, { color: '#fff' }]}>Sign in</Text></Pressable>
        </View>
      ) : (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={[styles.content, contentContainer(screenWidth)]} keyboardShouldPersistTaps="handled">
            <View style={styles.notice}>
              <Text style={styles.noticeTitle}>Before you begin</Text>
              <Text style={styles.noticeText}>
                Every notice is checked by our team before it is published, usually by contacting the family or the funeral director. Nothing appears in the app until it has been checked.
                Your name and contact details are used only for that check and are never shown publicly.
              </Text>
            </View>

            <Text style={styles.section}>About the person</Text>
            <Field label="Full name (required)">{text('fullName', 'Full name')}</Field>
            <Field label="Known as (optional)">{text('preferredName', 'Known as')}</Field>
            <Field label="Date of birth (optional)" hint="DD/MM/YYYY">{text('bornOn', 'Date of birth', { keyboardType: 'numbers-and-punctuation', maxLength: 10 })}</Field>
            <Field label="Date of death (optional)" hint="DD/MM/YYYY">{text('diedOn', 'Date of death', { keyboardType: 'numbers-and-punctuation', maxLength: 10 })}</Field>
            <Field label="Area (optional)">
              <Pressable onPress={openPicker} accessibilityRole="button" style={[styles.input, { justifyContent: 'center' }]}><Text style={{ fontSize: fontSize.md, color: areaName ? colors.textPrimary : colors.textLight }}>{areaName ?? 'Choose an area'}</Text></Pressable>
              {f.areaId ? <Pressable onPress={() => set('areaId', null)} accessibilityRole="button" style={styles.textBtn}><Text style={styles.textBtnText}>Clear area</Text></Pressable> : null}
            </Field>
            <Field label="Announcement (optional)" hint="A few words in the family's own voice. Please leave web links out.">
              {text('announcement', 'Announcement', { multiline: true, style: [styles.input, { minHeight: 110 }], maxLength: 1500 })}
            </Field>
            <Field label="Photograph link (optional)" hint="A link starting https://">{text('photoUrl', 'Photograph link', { autoCapitalize: 'none', keyboardType: 'url' })}</Field>

            <Text style={styles.section}>Funeral arrangements</Text>
            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Publish the funeral arrangements</Text>
                <Text style={styles.hint}>Off by default. Switch on only if the family wants the service details shown publicly. Otherwise nothing about the arrangements is shown.</Text>
              </View>
              <Switch value={f.publishArrangements} onValueChange={(v) => set('publishArrangements', v)} accessibilityLabel="Publish the funeral arrangements" trackColor={{ false: colors.border, true: FUNERAL.slate }} />
            </View>
            {f.publishArrangements ? (
              <View style={{ gap: 14 }}>
                <Field label="Kind of service (optional)">
                  <View style={styles.pills}>
                    {Object.entries(SERVICE_KIND_LABEL).map(([k, label]) => (
                      <Pressable key={k} onPress={() => set('serviceKind', f.serviceKind === k ? null : k)} accessibilityRole="button" accessibilityState={{ selected: f.serviceKind === k }}
                        style={[styles.pill, f.serviceKind === k && { backgroundColor: FUNERAL.slate, borderColor: FUNERAL.slate }]}>
                        <Text style={[styles.pillText, f.serviceKind === k && { color: '#fff' }]}>{label}</Text>
                      </Pressable>
                    ))}
                  </View>
                </Field>
                <Field label="Place (optional)">{text('serviceVenue', 'Place of the service')}</Field>
                <Field label="Date (optional)" hint="DD/MM/YYYY">{text('serviceDate', 'Service date', { keyboardType: 'numbers-and-punctuation', maxLength: 10 })}</Field>
                <Field label="Time (optional)" hint="HH:MM, for example 14:00">{text('serviceTime', 'Service time', { keyboardType: 'numbers-and-punctuation', maxLength: 5 })}</Field>
                <Field label="Other details (optional)">{text('serviceNotes', 'Other service details', { multiline: true, style: [styles.input, { minHeight: 80 }] })}</Field>
              </View>
            ) : null}

            <Text style={styles.section}>Family requests and donations</Text>
            <Field label="Family requests (optional)" hint="For example, family flowers only.">{text('familyRequests', 'Family requests', { multiline: true, style: [styles.input, { minHeight: 80 }] })}</Field>
            <Field label="Donations (optional)" hint="A charity or cause, in words.">{text('donationInfo', 'Donation details', { multiline: true, style: [styles.input, { minHeight: 80 }] })}</Field>
            <Field label="Donation link (optional)" hint="A link starting https://">{text('donationUrl', 'Donation link', { autoCapitalize: 'none', keyboardType: 'url' })}</Field>

            <Text style={styles.section}>About you (private)</Text>
            <Field label="Your name (required)">{text('submitterName', 'Your name')}</Field>
            <Field label="Your relationship (optional)" hint="For example, daughter, or funeral director.">{text('submitterRelationship', 'Your relationship')}</Field>
            <Field label="Phone (a phone or an email is required)">{text('submitterPhone', 'Phone number', { keyboardType: 'phone-pad' })}</Field>
            <Field label="Email">{text('submitterEmail', 'Email address', { autoCapitalize: 'none', keyboardType: 'email-address' })}</Field>

            <Text style={styles.section}>Notifications</Text>
            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Let members who opted in be told when this is published</Text>
                <Text style={styles.hint}>Off by default. Only people who chose funeral notices in their settings would be told.</Text>
              </View>
              <Switch value={f.announceInNotifications} onValueChange={(v) => { set('announceInNotifications', v); if (!v) set('announceNameInPreview', false); }} accessibilityLabel="Let members who opted in be told when this is published" trackColor={{ false: colors.border, true: FUNERAL.slate }} />
            </View>
            {f.announceInNotifications ? (
              <View style={styles.switchRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>Show the name in the notification preview</Text>
                  <Text style={styles.hint}>Off by default. Otherwise the notification says only that a new notice has been published.</Text>
                </View>
                <Switch value={f.announceNameInPreview} onValueChange={(v) => set('announceNameInPreview', v)} accessibilityLabel="Show the name in the notification preview" trackColor={{ false: colors.border, true: FUNERAL.slate }} />
              </View>
            ) : null}

            <Text style={styles.section}>Confirmation</Text>
            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>I am authorised to make this announcement</Text>
                <Text style={styles.hint}>I am a member of the family, or a funeral director acting for the family.</Text>
              </View>
              <Switch value={f.familyAuthorised} onValueChange={(v) => set('familyAuthorised', v)} accessibilityLabel="I am authorised to make this announcement" trackColor={{ false: colors.border, true: FUNERAL.slate }} />
            </View>

            <Pressable onPress={submit} disabled={busy} accessibilityRole="button" style={[styles.btn, styles.btnPrimary, { alignSelf: 'stretch' }]}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={[styles.btnText, { color: '#fff' }]}>Send for checking</Text>}
            </Pressable>
            <Text style={styles.hint}>Sending does not publish anything. We will check the notice first.</Text>
          </ScrollView>
        </KeyboardAvoidingView>
      )}
      <AreaPicker visible={picker} title="Choose an area" areas={areas} selected={f.areaId ? [f.areaId] : []} onClose={() => setPicker(false)} onDone={(ids) => { setPicker(false); set('areaId', ids[0] ?? null); }} />
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md, gap: 16, paddingBottom: 80 },
  center: { flex: 1, padding: spacing.lg, gap: 14, justifyContent: 'center' },
  big: { fontSize: fontSize.xl, fontWeight: '800', color: colors.textPrimary },
  notice: { backgroundColor: FUNERAL.parchment, borderRadius: radius.md, borderWidth: 1, borderColor: FUNERAL.edge, padding: 14, gap: 4 },
  noticeTitle: { fontSize: fontSize.md, fontWeight: '800', color: FUNERAL.slate },
  noticeText: { fontSize: fontSize.sm, lineHeight: 20, color: FUNERAL.slateSoft },
  section: { fontSize: 12, fontWeight: '900', letterSpacing: 1.2, textTransform: 'uppercase', color: FUNERAL.burgundy, marginTop: 8 },
  label: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  hint: { fontSize: fontSize.xs, lineHeight: 17, color: colors.textMuted },
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, backgroundColor: '#fff', paddingHorizontal: 12, paddingVertical: 10, fontSize: fontSize.md, color: colors.textPrimary, textAlignVertical: 'top' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: 12, minHeight: 56 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: { minHeight: 40, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 99, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: '#fff' },
  pillText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary },
  textBtn: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  textBtnText: { fontSize: fontSize.sm, color: FUNERAL.burgundy, textDecorationLine: 'underline' },
  btn: { minHeight: 48, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: '#fff' },
  btnPrimary: { backgroundColor: FUNERAL.slate, borderColor: FUNERAL.slate },
  btnText: { fontSize: fontSize.md, fontWeight: '800', color: colors.navy },
});
