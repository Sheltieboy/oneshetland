/**
 * funeral-notice.tsx — one published Deaths & Funeral Notice, in the traditional template (components/notices/FuneralTemplate.tsx).
 * Reads get_funeral_notice(p_id): only public fields come back; arrangements only when the family approved them.
 * A signed-in reader can ask for a correction or takedown (request_funeral_notice_change).
 */
import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, TextInput, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { LoadingState } from '@/components/ui/LoadingState';
import { EmptyState } from '@/components/ui/EmptyState';
import { FuneralAnnouncement, FUNERAL } from '@/components/notices/FuneralTemplate';
import { loadFuneralNotice, requestFuneralChange } from '@/lib/notices-alerts-api';
import type { FuneralNoticeModel, ChangeKind } from '@/lib/funeral-notices';
import { useAuth } from '@/context/AuthContext';
import { useAlert } from '@/components/BrandedAlert';

export default function FuneralNoticeScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { screenWidth } = useAppLayout();
  const { profile } = useAuth();
  const { alert } = useAlert();
  const [f, setF] = useState<FuneralNoticeModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [kind, setKind] = useState<ChangeKind | null>(null);
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    if (!id) { setLoading(false); return; }
    setLoading(true); setFailed(false);
    try { setF(await loadFuneralNotice(String(id))); } catch { setFailed(true); } finally { setLoading(false); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const send = async () => {
    if (!f || !kind) return;
    setSending(true);
    try {
      await requestFuneralChange(f.id, kind, message, contact);
      setKind(null); setMessage(''); setContact('');
      alert({ title: 'Request sent', message: 'Thank you. Our team will look at this and contact you if we need anything further.' });
    } catch (e) {
      alert({ title: 'Not sent', message: e instanceof Error && e.message.length < 160 ? e.message : 'Something went wrong. Please try again.' });
    } finally { setSending(false); }
  };

  return (
    <ScreenScaffold header={<ScreenHeader title="Funeral notice" accent={FUNERAL.burgundy} onBack={() => (router.canGoBack() ? router.back() : router.replace('/notices' as any))} />}>
      <ScrollView contentContainerStyle={[styles.content, contentContainer(screenWidth)]}>
        {loading ? <LoadingState accent={FUNERAL.burgundy} /> : failed ? (
          <EmptyState icon="exclamation-circle" title="This notice did not load" body="Check your connection and try again." accent={FUNERAL.burgundy} variant="card" actionLabel="Try again" onAction={load} />
        ) : !f ? (
          <EmptyState icon="feather" title="This notice is no longer displayed." accent={FUNERAL.burgundy} variant="card" />
        ) : (
          <>
            <FuneralAnnouncement f={f} />
            <View style={styles.change}>
              {!profile ? (
                <Text style={styles.small}>Sign in if you need to ask for a correction or for this notice to be taken down.</Text>
              ) : kind === null ? (
                <>
                  <Text style={styles.small}>If something here is wrong, or the family would like this notice removed, you can ask us. A member of our team will check and act.</Text>
                  <View style={styles.row}>
                    <Pressable onPress={() => setKind('correction')} accessibilityRole="button" style={styles.btn}><Text style={styles.btnText}>Ask for a correction</Text></Pressable>
                    <Pressable onPress={() => setKind('takedown')} accessibilityRole="button" style={styles.btn}><Text style={styles.btnText}>Ask for it to be taken down</Text></Pressable>
                  </View>
                </>
              ) : (
                <>
                  <Text style={styles.label}>{kind === 'correction' ? 'What needs to be corrected?' : 'Why should this notice be taken down?'}</Text>
                  <TextInput value={message} onChangeText={setMessage} multiline style={[styles.input, { minHeight: 96 }]} accessibilityLabel="Your message" maxLength={1000} />
                  <Text style={styles.label}>How can we reach you? (optional)</Text>
                  <TextInput value={contact} onChangeText={setContact} style={styles.input} accessibilityLabel="Contact details" autoCapitalize="none" maxLength={200} />
                  <View style={styles.row}>
                    <Pressable onPress={send} disabled={sending} accessibilityRole="button" style={[styles.btn, styles.btnPrimary]}>
                      {sending ? <ActivityIndicator color="#fff" /> : <Text style={[styles.btnText, { color: '#fff' }]}>Send request</Text>}
                    </Pressable>
                    <Pressable onPress={() => setKind(null)} accessibilityRole="button" style={styles.btn}><Text style={styles.btnText}>Cancel</Text></Pressable>
                  </View>
                </>
              )}
            </View>
          </>
        )}
      </ScrollView>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: 60 },
  change: { gap: 10, paddingHorizontal: 4 },
  small: { fontSize: fontSize.sm, lineHeight: 19, color: colors.textMuted },
  label: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, backgroundColor: '#fff', paddingHorizontal: 12, paddingVertical: 10, fontSize: fontSize.md, color: colors.textPrimary, textAlignVertical: 'top' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  btn: { minHeight: 44, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: '#fff' },
  btnPrimary: { backgroundColor: FUNERAL.slate, borderColor: FUNERAL.slate },
  btnText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.navy },
});
