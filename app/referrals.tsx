/**
 * referrals.tsx — "Invite a friend": share your code, both get £5 wallet credit
 * when they first spend. App mirror of the web /account/referrals page.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, Share, RefreshControl, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { LoadingState } from '@/components/ui/LoadingState';
import { useAuth } from '@/context/AuthContext';
import { useAlert } from '@/components/BrandedAlert';
import {
  fetchMyReferrals, applyReferralCode, REFERRAL_REWARD_PENCE,
  type MyReferrals,
} from '@/lib/referrals';

const S = SECTIONS.local;
const reward = `£${(REFERRAL_REWARD_PENCE / 100).toFixed(0)}`;

const HOW = [
  { icon: 'share', text: `Share your code with a friend who's new to OneShetland.` },
  { icon: 'user-plus', text: 'They enter it and make their first purchase in the app.' },
  { icon: 'gift', text: `You each get ${reward} in your OneShetland wallet.` },
] as const;

export default function ReferralsScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const { screenWidth } = useAppLayout();
  const { alert } = useAlert();
  const [data, setData] = useState<MyReferrals | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [entry, setEntry] = useState('');
  const [applying, setApplying] = useState(false);

  const load = useCallback(async () => {
    if (!profile) return;
    try {
      setData(await fetchMyReferrals(profile.id));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [profile?.id]);

  useEffect(() => { load(); }, [load]);

  const share = async () => {
    if (!data) return;
    Haptics.selectionAsync();
    await Share.share({
      message: `Join me on OneShetland — everything Shetland in one app. Use my code ${data.code} and we'll both get ${reward} to spend locally. https://oneshetland.netlify.app`,
    });
  };

  const apply = async () => {
    const code = entry.trim();
    if (!code) return;
    setApplying(true);
    try {
      const res = await applyReferralCode(code);
      if (res.ok) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        alert({ title: 'Code applied! 🎉', message: `Make your first purchase and you'll both get ${reward}.` });
        setEntry('');
        load();
      } else {
        alert({ title: 'Couldn’t apply that code', message: res.error ?? 'Please check the code and try again.' });
      }
    } catch (e) {
      alert({ title: 'Something went wrong', message: e instanceof Error ? e.message : 'Please try again.' });
    } finally {
      setApplying(false);
    }
  };

  return (
    <ScreenScaffold header={<ScreenHeader title="Invite friends" accent={S.color} onBack={() => router.back()} />}>
      {loading ? (
        <LoadingState accent={S.color} />
      ) : (
        <ScrollView
          contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={S.color} />}
        >
          {/* Hero + code */}
          <View style={[styles.hero, { backgroundColor: S.color }]}>
            <Text style={styles.heroTitle}>Give {reward}, get {reward}</Text>
            <Text style={styles.heroBody}>
              Share your code. When a friend joins and makes their first purchase, you each get {reward} in your wallet.
            </Text>
            <View style={styles.codeBox}>
              <Text style={styles.codeLabel}>YOUR CODE</Text>
              <Text style={styles.code}>{data?.code ?? '—'}</Text>
            </View>
            <TouchableOpacity style={styles.shareBtn} onPress={share} activeOpacity={0.85}>
              <FontAwesome5 name="share" size={13} color={S.color} solid />
              <Text style={[styles.shareBtnText, { color: S.color }]}>Share your invite</Text>
            </TouchableOpacity>
          </View>

          {/* Earned so far */}
          {data && data.joined > 0 && (
            <View style={styles.statsRow}>
              <View style={styles.statBox}>
                <Text style={[styles.statNum, { color: S.color }]}>{data.joined}</Text>
                <Text style={styles.statLabel}>{data.joined === 1 ? 'friend joined' : 'friends joined'}</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={[styles.statNum, { color: S.color }]}>£{(data.earned_pence / 100).toFixed(0)}</Text>
                <Text style={styles.statLabel}>earned so far</Text>
              </View>
            </View>
          )}

          {/* How it works */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>How it works</Text>
            {HOW.map((h, i) => (
              <View key={i} style={styles.howRow}>
                <View style={[styles.howIcon, { backgroundColor: S.light }]}>
                  <FontAwesome5 name={h.icon} size={12} color={S.color} solid />
                </View>
                <Text style={styles.howText}>{h.text}</Text>
              </View>
            ))}
          </View>

          {/* Enter a code */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Got a friend’s code?</Text>
            <View style={styles.entryRow}>
              <TextInput
                style={styles.entryInput}
                value={entry}
                onChangeText={(t) => setEntry(t.toUpperCase())}
                placeholder="ENTER CODE"
                placeholderTextColor={colors.textLight}
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={12}
              />
              <TouchableOpacity
                style={[styles.applyBtn, { backgroundColor: S.color }, (applying || !entry.trim()) && { opacity: 0.5 }]}
                onPress={apply}
                disabled={applying || !entry.trim()}
              >
                {applying ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.applyBtnText}>Apply</Text>}
              </TouchableOpacity>
            </View>
            <Text style={styles.entryHint}>You can only use a code once, and not your own.</Text>
          </View>

          {/* Referral list */}
          {data && data.entries.length > 0 && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Your invites</Text>
              {data.entries.map((e) => (
                <View key={e.id} style={styles.inviteRow}>
                  <Text style={styles.inviteName} numberOfLines={1}>{e.name}</Text>
                  <View style={[styles.statusPill, { backgroundColor: e.status === 'rewarded' ? colors.successLight : S.light }]}>
                    <Text style={[styles.statusText, { color: e.status === 'rewarded' ? colors.successDark : S.color }]}>
                      {e.status === 'rewarded' ? `+£${(e.reward_pence / 100).toFixed(0)}` : 'Pending first purchase'}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      )}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: 100 },

  hero: { borderRadius: radius.lg, padding: 20 },
  heroTitle: { color: '#fff', fontSize: 24, fontWeight: '900' },
  heroBody: { color: 'rgba(255,255,255,0.92)', fontSize: fontSize.sm, marginTop: 6, lineHeight: 20 },
  codeBox: { backgroundColor: 'rgba(255,255,255,0.16)', borderRadius: radius.md, paddingVertical: 14, alignItems: 'center', marginTop: 16 },
  codeLabel: { color: 'rgba(255,255,255,0.85)', fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  code: { color: '#fff', fontSize: 30, fontWeight: '900', letterSpacing: 4, marginTop: 4 },
  shareBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#fff', borderRadius: radius.full, paddingVertical: 13, marginTop: 12 },
  shareBtnText: { fontSize: fontSize.sm, fontWeight: '800' },

  statsRow: { flexDirection: 'row', gap: spacing.md },
  statBox: { flex: 1, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, paddingVertical: 16, alignItems: 'center' },
  statNum: { fontSize: 26, fontWeight: '900' },
  statLabel: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '700', marginTop: 2 },

  card: { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 16, gap: 12 },
  cardTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary },

  howRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  howIcon: { width: 34, height: 34, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  howText: { flex: 1, fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 19 },

  entryRow: { flexDirection: 'row', gap: 8 },
  entryInput: { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, fontSize: fontSize.md, fontWeight: '800', letterSpacing: 2, color: colors.textPrimary },
  applyBtn: { borderRadius: radius.md, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center', minWidth: 84 },
  applyBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
  entryHint: { fontSize: fontSize.xs, color: colors.textLight },

  inviteRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  inviteName: { flex: 1, fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  statusPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.full },
  statusText: { fontSize: 11, fontWeight: '900' },
});
