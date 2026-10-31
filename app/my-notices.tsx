/**
 * my-notices.tsx - the notices I have posted: where each one stands (awaiting approval / published / ended / withdrawn / not approved, with our team's
 * reason), and Edit / Withdraw. my_person_notices / withdraw_my_person_notice. Only the signed-in member's own notices are ever returned.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, ActivityIndicator, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { LoadingState } from '@/components/ui/LoadingState';
import { EmptyState } from '@/components/ui/EmptyState';
import { loadMyNotices, withdrawMyNotice } from '@/lib/member-notices-api';
import { STATE_LABEL, STATE_HELP, STATE_TONE, areaScopeLabel, friendlyError, type MyNotice } from '@/lib/member-notices';
import { formatNoticeTime } from '@/lib/notices-alerts';
import { useAuth } from '@/context/AuthContext';
import { useAlert } from '@/components/BrandedAlert';

const TONE = { amber: { bg: colors.warningLight, fg: colors.warningDark }, green: { bg: colors.successLight, fg: colors.successDark }, grey: { bg: '#E5E7EB', fg: '#374151' }, red: { bg: '#FDECEA', fg: '#7F1D1D' } } as const;

export default function MyNoticesScreen() {
  const router = useRouter();
  const { screenWidth } = useAppLayout();
  const { profile } = useAuth();
  const { alert } = useAlert();
  const [rows, setRows] = useState<MyNotice[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile) { setLoading(false); return; }
    try { setRows(await loadMyNotices()); setError(false); } catch { setError(true); } finally { setLoading(false); }
  }, [profile?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  const withdraw = (n: MyNotice) => alert({
    title: 'Withdraw this notice?',
    message: n.state === 'published' ? 'It will no longer be shown to anyone.' : 'It will not be published.',
    actions: [
      { label: 'Keep it', style: 'cancel' },
      { label: 'Withdraw', style: 'destructive', onPress: async () => {
        setBusy(n.id);
        try { await withdrawMyNotice(n.id); await load(); }
        catch (e) { alert({ title: 'Not withdrawn', message: friendlyError((e as { message?: string } | null)?.message) }); }
        finally { setBusy(null); }
      } },
    ],
  });

  return (
    <ScreenScaffold header={<ScreenHeader title="My notices" onBack={() => (router.canGoBack() ? router.back() : router.replace('/notices' as any))} />}>
      <ScrollView contentContainerStyle={[styles.content, contentContainer(screenWidth)]} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
        {!profile ? (
          <EmptyState icon="user" title="Sign in to see your notices" variant="card" actionLabel="Sign in" onAction={() => router.push({ pathname: '/(auth)/sign-in', params: { next: '/my-notices' } } as any)} />
        ) : loading ? <LoadingState /> : error ? (
          <EmptyState icon="exclamation-circle" title="Your notices did not load" body="Check your connection and try again." variant="card" actionLabel="Try again" onAction={() => { setLoading(true); load(); }} />
        ) : rows.length === 0 ? (
          <EmptyState icon="feather" title="You have not posted a notice." body="Notices are checked by our team before anyone else sees them." variant="card" actionLabel="Post a notice" onAction={() => router.push('/notice-submit' as any)} />
        ) : (
          <>
            <Pressable onPress={() => router.push('/notice-submit' as any)} accessibilityRole="button" style={[styles.btn, styles.btnPrimary]}><Text style={[styles.btnText, { color: '#fff' }]}>Post a notice</Text></Pressable>
            {rows.map((n) => {
              const tone = TONE[STATE_TONE[n.state]];
              const where = areaScopeLabel(n.areaIds, n.areaNames);
              return (
                <View key={n.id} style={styles.card}>
                  <View style={[styles.badge, { backgroundColor: tone.bg }]}><Text style={[styles.badgeText, { color: tone.fg }]} accessibilityLabel={`Status: ${STATE_LABEL[n.state]}`}>{STATE_LABEL[n.state]}</Text></View>
                  <Text style={styles.title}>{n.title}</Text>
                  <Text style={styles.body} numberOfLines={3}>{n.body}</Text>
                  <Text style={styles.meta}>{[n.categoryLabel, where, `Sent ${formatNoticeTime(n.createdAt)}`, n.expiresAt ? `Until ${new Date(n.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : null].filter(Boolean).join('  ·  ')}</Text>
                  <Text style={styles.help}>{STATE_HELP[n.state]}</Text>
                  {n.state === 'declined' && n.declineReason ? (
                    <View style={styles.msg}><Text style={styles.msgLabel}>Message from our team</Text><Text style={styles.msgText}>{n.declineReason}</Text></View>
                  ) : null}
                  {n.canEdit || n.canWithdraw ? (
                    <View style={styles.row}>
                      {n.canEdit ? <Pressable onPress={() => router.push({ pathname: '/notice-submit', params: { edit: n.id } } as any)} accessibilityRole="button" accessibilityLabel={`Edit ${n.title}`} style={styles.btn}><Text style={styles.btnText}>Edit</Text></Pressable> : null}
                      {n.canWithdraw ? <Pressable onPress={() => withdraw(n)} disabled={busy === n.id} accessibilityRole="button" accessibilityLabel={`Withdraw ${n.title}`} style={styles.btn}>{busy === n.id ? <ActivityIndicator /> : <Text style={styles.btnText}>Withdraw</Text>}</Pressable> : null}
                    </View>
                  ) : null}
                </View>
              );
            })}
          </>
        )}
      </ScrollView>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md, gap: spacing.sm, paddingBottom: 60 },
  card: { backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: 16, gap: 6 },
  badge: { alignSelf: 'flex-start', borderRadius: 99, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { fontSize: 12, fontWeight: '800' },
  title: { fontSize: fontSize.lg, fontWeight: '800', color: colors.textPrimary },
  body: { fontSize: fontSize.sm, lineHeight: 20, color: colors.textSecondary },
  meta: { fontSize: fontSize.xs, color: colors.textMuted },
  help: { fontSize: fontSize.xs, color: colors.textMuted, fontStyle: 'italic' },
  msg: { backgroundColor: '#FDECEA', borderRadius: radius.md, padding: 10, borderLeftWidth: 3, borderLeftColor: '#B3261E' },
  msgLabel: { fontSize: 11, fontWeight: '900', letterSpacing: 0.8, textTransform: 'uppercase', color: '#7F1D1D' },
  msgText: { fontSize: fontSize.sm, lineHeight: 19, color: '#7F1D1D', marginTop: 2 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  btn: { minHeight: 44, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: '#fff' },
  btnPrimary: { backgroundColor: colors.navy, borderColor: colors.navy },
  btnText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.navy },
});
