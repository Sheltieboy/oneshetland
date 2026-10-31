/**
 * my-funeral-notices.tsx — the notices I have submitted: status, any message from our team, withdraw, and (for a published notice) a request
 * for a correction or for it to be taken down. my_funeral_submissions / withdraw_my_funeral_notice / request_funeral_notice_change.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, TextInput, ActivityIndicator, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { LoadingState } from '@/components/ui/LoadingState';
import { EmptyState } from '@/components/ui/EmptyState';
import { FUNERAL } from '@/components/notices/FuneralTemplate';
import { loadMyFuneralSubmissions, withdrawFuneralNotice, requestFuneralChange } from '@/lib/notices-alerts-api';
import type { SubmissionModel, ChangeKind } from '@/lib/funeral-notices';
import { formatNoticeTime } from '@/lib/notices-alerts';
import { useAuth } from '@/context/AuthContext';
import { useAlert } from '@/components/BrandedAlert';

export default function MyFuneralNoticesScreen() {
  const router = useRouter();
  const { screenWidth } = useAppLayout();
  const { profile } = useAuth();
  const { alert } = useAlert();
  const [rows, setRows] = useState<SubmissionModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [change, setChange] = useState<{ id: string; kind: ChangeKind } | null>(null);
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');

  const load = useCallback(async () => {
    if (!profile) { setLoading(false); return; }
    try { setRows(await loadMyFuneralSubmissions()); setError(false); } catch { setError(true); } finally { setLoading(false); }
  }, [profile?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  const withdraw = (r: SubmissionModel) => alert({
    title: 'Withdraw this notice?',
    message: r.status === 'approved' ? 'It will no longer be displayed.' : 'It will not be published.',
    actions: [
      { label: 'Keep it', style: 'cancel' },
      { label: 'Withdraw', style: 'destructive', onPress: async () => {
        setBusy(r.id);
        try { await withdrawFuneralNotice(r.id); await load(); }
        catch (e) { alert({ title: 'Not withdrawn', message: e instanceof Error && e.message.length < 160 ? e.message : 'Something went wrong. Please try again.' }); }
        finally { setBusy(null); }
      } },
    ],
  });

  const sendChange = async () => {
    if (!change) return;
    setBusy(change.id);
    try {
      await requestFuneralChange(change.id, change.kind, message, contact);
      setChange(null); setMessage(''); setContact('');
      alert({ title: 'Request sent', message: 'Thank you. Our team will look at this and contact you if we need anything further.' });
    } catch (e) {
      alert({ title: 'Not sent', message: e instanceof Error && e.message.length < 160 ? e.message : 'Something went wrong. Please try again.' });
    } finally { setBusy(null); }
  };

  return (
    <ScreenScaffold header={<ScreenHeader title="My funeral notices" accent={FUNERAL.burgundy} onBack={() => (router.canGoBack() ? router.back() : router.replace('/notices' as any))} />}>
      <ScrollView contentContainerStyle={[styles.content, contentContainer(screenWidth)]} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
        {!profile ? (
          <EmptyState icon="user" title="Sign in to see your submissions" accent={FUNERAL.burgundy} variant="card" actionLabel="Sign in" onAction={() => router.push('/(auth)/sign-in' as any)} />
        ) : loading ? <LoadingState accent={FUNERAL.burgundy} /> : error ? (
          <EmptyState icon="exclamation-circle" title="Your submissions did not load" body="Check your connection and try again." accent={FUNERAL.burgundy} variant="card" actionLabel="Try again" onAction={() => { setLoading(true); load(); }} />
        ) : rows.length === 0 ? (
          <EmptyState icon="feather" title="You have not submitted a notice." accent={FUNERAL.burgundy} variant="card" actionLabel="Submit a notice" onAction={() => router.push('/funeral-notice-submit' as any)} />
        ) : rows.map((r) => (
          <View key={r.id} style={styles.card}>
            <Text style={styles.name}>{r.fullName}</Text>
            <Text style={styles.status} accessibilityLabel={`Status: ${r.statusLabel}`}>{r.statusLabel}</Text>
            <Text style={styles.meta}>Sent {formatNoticeTime(r.createdAt)}{r.publishedAt ? `  ·  Published ${formatNoticeTime(r.publishedAt)}` : ''}</Text>
            {r.staffMessage ? (
              <View style={styles.msg}><Text style={styles.msgLabel}>Message from our team</Text><Text style={styles.msgText}>{r.staffMessage}</Text></View>
            ) : null}
            <View style={styles.row}>
              {r.status === 'approved' ? <Pressable onPress={() => router.push({ pathname: '/funeral-notice', params: { id: r.id } } as any)} accessibilityRole="button" style={styles.btn}><Text style={styles.btnText}>View</Text></Pressable> : null}
              {r.canEdit ? <Pressable onPress={() => router.push({ pathname: '/funeral-notice-submit', params: { edit: r.id } } as any)} accessibilityRole="button" style={styles.btn}><Text style={styles.btnText}>{r.status === 'needs_info' ? 'Add the information' : 'Edit'}</Text></Pressable> : null}
              {r.canRequestChange ? <Pressable onPress={() => { setChange({ id: r.id, kind: 'correction' }); setMessage(''); }} accessibilityRole="button" style={styles.btn}><Text style={styles.btnText}>Ask for a correction</Text></Pressable> : null}
              {r.canRequestChange ? <Pressable onPress={() => { setChange({ id: r.id, kind: 'takedown' }); setMessage(''); }} accessibilityRole="button" style={styles.btn}><Text style={styles.btnText}>Ask for it to be taken down</Text></Pressable> : null}
              {r.canWithdraw ? <Pressable onPress={() => withdraw(r)} disabled={busy === r.id} accessibilityRole="button" style={styles.btn}>{busy === r.id ? <ActivityIndicator /> : <Text style={styles.btnText}>Withdraw</Text>}</Pressable> : null}
            </View>
            {change?.id === r.id ? (
              <View style={{ gap: 8, marginTop: 6 }}>
                <Text style={styles.label}>{change.kind === 'correction' ? 'What needs to be corrected?' : 'Why should this notice be taken down?'}</Text>
                <TextInput value={message} onChangeText={setMessage} multiline style={[styles.input, { minHeight: 90 }]} accessibilityLabel="Your message" maxLength={1000} />
                <Text style={styles.label}>How can we reach you? (optional)</Text>
                <TextInput value={contact} onChangeText={setContact} style={styles.input} accessibilityLabel="Contact details" autoCapitalize="none" maxLength={200} />
                <View style={styles.row}>
                  <Pressable onPress={sendChange} disabled={busy === r.id} accessibilityRole="button" style={[styles.btn, styles.btnPrimary]}><Text style={[styles.btnText, { color: '#fff' }]}>Send request</Text></Pressable>
                  <Pressable onPress={() => setChange(null)} accessibilityRole="button" style={styles.btn}><Text style={styles.btnText}>Cancel</Text></Pressable>
                </View>
              </View>
            ) : null}
          </View>
        ))}
      </ScrollView>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md, gap: spacing.sm, paddingBottom: 60 },
  card: { backgroundColor: FUNERAL.parchment, borderRadius: 6, borderWidth: 1, borderColor: FUNERAL.edge, padding: 16, gap: 6 },
  name: { fontSize: fontSize.lg, fontWeight: '700', color: FUNERAL.slate },
  status: { fontSize: fontSize.sm, fontWeight: '800', color: FUNERAL.burgundy },
  meta: { fontSize: fontSize.xs, color: FUNERAL.slateSoft },
  msg: { backgroundColor: '#fff', borderRadius: radius.md, padding: 10, borderLeftWidth: 3, borderLeftColor: FUNERAL.burgundy },
  msgLabel: { fontSize: 11, fontWeight: '900', letterSpacing: 0.8, textTransform: 'uppercase', color: FUNERAL.burgundy },
  msgText: { fontSize: fontSize.sm, lineHeight: 19, color: FUNERAL.slate, marginTop: 2 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  label: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, backgroundColor: '#fff', paddingHorizontal: 12, paddingVertical: 10, fontSize: fontSize.md, color: colors.textPrimary, textAlignVertical: 'top' },
  btn: { minHeight: 44, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: '#fff' },
  btnPrimary: { backgroundColor: FUNERAL.slate, borderColor: FUNERAL.slate },
  btnText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.navy },
});
