/**
 * notice-submit.tsx - a signed-in member posts a notice (submit_person_notice) or edits one of their own (?edit=<id>, edit_my_person_notice).
 * It is checked by our team before anyone else can see it; editing a published notice sends it back to be checked. Members cannot make a notice urgent,
 * an Essential Alert, or post as a hub / business. Where it applies is ONE explicit choice: Shetland-wide, or particular places. Sign-in required.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, TextInput, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { AreaPicker } from '@/components/notices/AreaPicker';
import { loadAreas, loadCategories, FALLBACK_CATEGORIES, type AreaOption, type CategoryOption } from '@/lib/notices-alerts-api';
import { loadMyNotices, submitMyNotice, editMyNotice } from '@/lib/member-notices-api';
import { EMPTY_NOTICE_FORM, validateNoticeForm, formFromNotice, friendlyError, TITLE_MAX, BODY_MAX, AREAS_MAX, EXPIRY_DEFAULT_DAYS, EXPIRY_MAX_DAYS, type NoticeForm } from '@/lib/member-notices';
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

export default function NoticeSubmitScreen() {
  const router = useRouter();
  const { screenWidth } = useAppLayout();
  const { profile } = useAuth();
  const { alert } = useAlert();
  const params = useLocalSearchParams<{ edit?: string }>();
  const editId = typeof params.edit === 'string' && params.edit ? params.edit : null;
  const [f, setF] = useState<NoticeForm>(EMPTY_NOTICE_FORM);
  const [wasPublished, setWasPublished] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(!!editId);
  const [loadFailed, setLoadFailed] = useState(false);
  const [areas, setAreas] = useState<AreaOption[]>([]);
  const [categories, setCategories] = useState<CategoryOption[]>(FALLBACK_CATEGORIES);
  const [picker, setPicker] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof NoticeForm>(k: K, v: NoticeForm[K]) => setF((p) => ({ ...p, [k]: v }));
  const areaNames = f.areaIds.map((id) => areas.find((a) => a.id === id)?.name ?? id);

  useEffect(() => { loadCategories().then(setCategories).catch(() => {}); loadAreas().then(setAreas).catch(() => {}); }, []);
  useEffect(() => {
    if (!editId || !profile) return;
    let alive = true;
    loadMyNotices()
      .then((rows) => { if (!alive) return; const n = rows.find((r) => r.id === editId); if (n && n.canEdit) { setF(formFromNotice(n)); setWasPublished(n.state === 'published'); } else setLoadFailed(true); })
      .catch(() => { if (alive) setLoadFailed(true); })
      .finally(() => { if (alive) setLoadingEdit(false); });
    return () => { alive = false; };
  }, [editId, profile?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    const p = validateNoticeForm(f, categories);
    setProblems(p);
    if (p.length) return;
    setBusy(true);
    try {
      if (editId) await editMyNotice(editId, f); else await submitMyNotice(f);
      alert({
        title: editId ? 'Changes saved' : 'Thank you',
        message: editId
          ? 'Your notice has gone back to our team to be checked again. The earlier wording stays out of sight until then.'
          : 'Your notice has been received and is awaiting approval. Only you can see it until our team has checked it.',
        actions: [{ label: 'See my notices', style: 'primary', onPress: () => router.replace('/my-notices' as any) }],
      });
    } catch (e) {
      alert({ title: 'Not sent', message: friendlyError((e as { message?: string } | null)?.message) });
    } finally { setBusy(false); }
  };

  return (
    <ScreenScaffold header={<ScreenHeader title={editId ? 'Edit your notice' : 'Post a notice'} onBack={() => (router.canGoBack() ? router.back() : router.replace('/notices' as any))} />}>
      {!profile ? (
        <View style={styles.center}>
          <Text style={styles.big}>Sign in to post a notice</Text>
          <Text style={styles.hint}>We ask you to sign in so that notices come from real people and you can change or withdraw yours.</Text>
          <Pressable onPress={() => router.push({ pathname: '/(auth)/sign-in', params: { next: '/notice-submit' } } as any)} accessibilityRole="button" style={[styles.btn, styles.btnPrimary]}><Text style={[styles.btnText, { color: '#fff' }]}>Sign in</Text></Pressable>
        </View>
      ) : editId && loadingEdit ? (
        <View style={styles.center}><ActivityIndicator /></View>
      ) : editId && loadFailed ? (
        <View style={styles.center}>
          <Text style={styles.big}>This notice cannot be edited</Text>
          <Text style={styles.hint}>It may have been withdrawn, not approved, or reached its end date.</Text>
          <Pressable onPress={() => router.replace('/my-notices' as any)} accessibilityRole="button" style={styles.btn}><Text style={styles.btnText}>My notices</Text></Pressable>
        </View>
      ) : (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={[styles.content, contentContainer(screenWidth)]} keyboardShouldPersistTaps="handled">
            <View style={styles.notice}>
              <Text style={styles.noticeTitle}>{editId ? (wasPublished ? 'This notice is published' : 'Before you save') : 'Before you begin'}</Text>
              <Text style={styles.noticeText}>
                {editId && wasPublished
                  ? 'If you save changes it goes back to our team to be checked again, and the notice is hidden until they approve it.'
                  : 'Our team checks every notice before anyone else can see it.'}
                {' '}Once it is approved it shows as “Posted by {profile.display_name || profile.full_name || 'your name'}”. Notices from members are never urgent alerts.
              </Text>
            </View>

            <Field label="Title (required)" hint={`${TITLE_MAX} characters at most.`}>
              <TextInput value={f.title} onChangeText={(v) => set('title', v)} style={styles.input} accessibilityLabel="Notice title" placeholderTextColor={colors.textLight} maxLength={TITLE_MAX} />
            </Field>
            <Field label="What is happening? (required)" hint={`${BODY_MAX} characters at most.`}>
              <TextInput value={f.body} onChangeText={(v) => set('body', v)} style={[styles.input, { minHeight: 130, textAlignVertical: 'top' }]} multiline accessibilityLabel="Notice text" placeholderTextColor={colors.textLight} maxLength={BODY_MAX} />
            </Field>

            <Field label="Category (required)">
              <View style={styles.pills}>
                {categories.map((c) => (
                  <Pressable key={c.id} onPress={() => set('category', f.category === c.id ? null : c.id)} accessibilityRole="button" accessibilityState={{ selected: f.category === c.id }} accessibilityLabel={`Category: ${c.label}`}
                    style={[styles.pill, f.category === c.id && styles.pillOn]}>
                    <Text style={[styles.pillText, f.category === c.id && { color: '#fff' }]}>{c.label}</Text>
                  </Pressable>
                ))}
              </View>
            </Field>

            <Field label="Where is it relevant? (required)" hint="Choose all of Shetland, or particular places.">
              <View style={styles.pills}>
                <Pressable onPress={() => setF((p) => ({ ...p, scope: 'wide', areaIds: [] }))} accessibilityRole="button" accessibilityState={{ selected: f.scope === 'wide' }} accessibilityLabel="Shetland-wide"
                  style={[styles.pill, f.scope === 'wide' && styles.pillOn]}><Text style={[styles.pillText, f.scope === 'wide' && { color: '#fff' }]}>Shetland-wide</Text></Pressable>
                <Pressable onPress={() => { setF((p) => ({ ...p, scope: 'specific' })); setPicker(true); }} accessibilityRole="button" accessibilityState={{ selected: f.scope === 'specific' }} accessibilityLabel="Particular places"
                  style={[styles.pill, f.scope === 'specific' && styles.pillOn]}><Text style={[styles.pillText, f.scope === 'specific' && { color: '#fff' }]}>Particular places</Text></Pressable>
              </View>
              {f.scope === 'specific' ? (
                <View style={{ gap: 6 }}>
                  <Text style={styles.chosen} accessibilityLabel="Chosen places">{f.areaIds.length ? areaNames.join(', ') : 'No places chosen yet'}</Text>
                  <Pressable onPress={() => setPicker(true)} accessibilityRole="button" style={styles.textBtn}><Text style={styles.textBtnText}>{f.areaIds.length ? 'Change places' : 'Choose places'} (up to {AREAS_MAX})</Text></Pressable>
                </View>
              ) : null}
            </Field>

            <Field label="Show until (optional)" hint={`DD/MM/YYYY. Leave blank and it runs for ${EXPIRY_DEFAULT_DAYS} days; the longest is ${EXPIRY_MAX_DAYS} days.`}>
              <TextInput value={f.expiry} onChangeText={(v) => set('expiry', v)} style={styles.input} accessibilityLabel="Show until" placeholderTextColor={colors.textLight} keyboardType="numbers-and-punctuation" maxLength={10} />
            </Field>

            {problems.length ? (
              <View style={styles.problems} accessibilityRole="alert">
                <Text style={styles.problemsTitle}>Please check</Text>
                {problems.map((p) => <Text key={p} style={styles.problemText}>• {p}</Text>)}
              </View>
            ) : null}

            <Pressable onPress={submit} disabled={busy} accessibilityRole="button" style={[styles.btn, styles.btnPrimary, { alignSelf: 'stretch' }]}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={[styles.btnText, { color: '#fff' }]}>{editId ? 'Save and send for checking again' : 'Send for checking'}</Text>}
            </Pressable>
            <Text style={styles.hint}>Sending does not publish anything. We will check the notice first.</Text>
          </ScrollView>
        </KeyboardAvoidingView>
      )}
      <AreaPicker visible={picker} title="Choose places" areas={areas} selected={f.areaIds} multi max={AREAS_MAX} onClose={() => { setPicker(false); if (f.areaIds.length === 0) set('scope', null); }}
        onDone={(ids) => { setPicker(false); setF((p) => ({ ...p, scope: ids.length ? 'specific' : null, areaIds: ids })); }} />
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md, gap: 16, paddingBottom: 80 },
  center: { flex: 1, padding: spacing.lg, gap: 14, justifyContent: 'center' },
  big: { fontSize: fontSize.xl, fontWeight: '800', color: colors.textPrimary },
  notice: { backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: 14, gap: 4 },
  noticeTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.navy },
  noticeText: { fontSize: fontSize.sm, lineHeight: 20, color: colors.textSecondary },
  label: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  hint: { fontSize: fontSize.xs, lineHeight: 17, color: colors.textMuted },
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, backgroundColor: '#fff', paddingHorizontal: 12, paddingVertical: 10, fontSize: fontSize.md, color: colors.textPrimary },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: { minHeight: 40, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 99, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: '#fff' },
  pillOn: { backgroundColor: colors.navy, borderColor: colors.navy },
  pillText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary },
  chosen: { fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: '600' },
  textBtn: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  textBtnText: { fontSize: fontSize.sm, color: colors.navy, textDecorationLine: 'underline', fontWeight: '700' },
  problems: { backgroundColor: '#FDECEA', borderRadius: radius.md, padding: 12, gap: 4, borderLeftWidth: 4, borderLeftColor: '#B3261E' },
  problemsTitle: { fontSize: fontSize.sm, fontWeight: '800', color: '#7F1D1D' },
  problemText: { fontSize: fontSize.sm, color: '#7F1D1D', lineHeight: 19 },
  btn: { minHeight: 48, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: '#fff' },
  btnPrimary: { backgroundColor: colors.navy, borderColor: colors.navy },
  btnText: { fontSize: fontSize.md, fontWeight: '800', color: colors.navy },
});
