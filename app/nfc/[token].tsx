/**
 * app/nfc/[token].tsx
 *
 * Universal-link target for a OneShetland NFC tile. A customer taps the tile
 * with their OWN phone; the app opens here. We resolve the business from the
 * token and offer what they can do right now:
 *   • Collect a loyalty stamp (GPS-verified they're present — anti-fraud)
 *   • Pay from their wallet (they enter + approve the amount; points auto-earn)
 * Everything runs on the customer's phone — no business device needed.
 *
 * Universal link format: https://oneshetland.com/t/{token}
 * App deep link:          oneshetland-fetch://nfc/{token}
 */
import React, { useEffect, useState, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Animated, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import { collectStampViaNfc, resolveNfcTile, payWithWalletViaTile, fetchWalletBalance, formatPence, type ResolvedTile } from '@/lib/local-api';

const S = SECTIONS.local;

type Phase = 'resolving' | 'menu' | 'locating' | 'stamping' | 'stampDone' | 'amount' | 'paying' | 'payDone' | 'error';
interface StampResult { stamps: number; needed: number; reward_ready: boolean; business_name: string; business_id: string; }

export default function NfcTapScreen() {
  const router = useRouter();
  const { token } = useLocalSearchParams<{ token: string }>();
  const { profile, session, loading: authLoading } = useAuth();

  const [phase, setPhase] = useState<Phase>('resolving');
  const [tile, setTile] = useState<ResolvedTile | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [stampResult, setStampResult] = useState<StampResult | null>(null);
  const [amount, setAmount] = useState('');
  const [balance, setBalance] = useState(0);
  const [payResult, setPayResult] = useState<{ balance_pence: number; cashback_pence: number } | null>(null);
  const successScale = useRef(new Animated.Value(0.7)).current;

  useEffect(() => {
    if (authLoading) return;
    if (!profile) { router.replace('/'); return; }
    resolve();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, profile?.id, token]);

  async function resolve() {
    if (!token) { setPhase('error'); setErrorMsg('No tile token in the link.'); return; }
    setPhase('resolving');
    try {
      const t = await resolveNfcTile(token);
      if (!t) { setPhase('error'); setErrorMsg('This tile isn\'t recognised.'); return; }
      setTile(t);
      setPhase('menu');
      Haptics.selectionAsync();
    } catch (e) { setPhase('error'); setErrorMsg(e instanceof Error ? e.message : 'Could not read the tile.'); }
  }

  const pop = () => { Animated.spring(successScale, { toValue: 1, friction: 5, useNativeDriver: true }).start(); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); };

  async function doStamp() {
    successScale.setValue(0.7);
    try {
      const Location = await import('expo-location').catch(() => null);
      if (!Location) { setPhase('error'); setErrorMsg('Location module unavailable.'); return; }
      setPhase('locating');
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') { setPhase('error'); setErrorMsg('Location is needed to verify you\'re at the business.'); return; }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setPhase('stamping'); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const data = await collectStampViaNfc(token, loc.coords.latitude, loc.coords.longitude);
      setStampResult(data); setPhase('stampDone'); pop();
    } catch (e) { setPhase('error'); setErrorMsg(e instanceof Error ? e.message : 'Couldn\'t stamp.'); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); }
  }

  async function openPay() {
    if (session?.user?.id) setBalance(await fetchWalletBalance(session.user.id).catch(() => 0));
    setAmount(''); setPhase('amount');
  }

  const amountPence = Math.round((parseFloat(amount) || 0) * 100);
  const amountValid = amountPence >= 50 && amountPence <= balance;

  async function doPay() {
    if (!amountValid) return;
    successScale.setValue(0.7);
    setPhase('paying'); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const r = await payWithWalletViaTile(token, amountPence);
      setPayResult(r); setPhase('payDone'); pop();
    } catch (e) { setPhase('error'); setErrorMsg(e instanceof Error ? e.message : 'Payment failed.'); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); }
  }

  const canStamp = !!tile?.has_loyalty && tile?.program_type === 'stamps';
  const canPay = !!tile?.accepts_wallet && !!tile?.payout_ready;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity style={styles.closeBtn} onPress={() => router.replace('/(tabs)/local')} hitSlop={12}>
          <FontAwesome5 name="times" size={16} color={S.color} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>OneShetland Local</Text>
        <View style={{ width: 32 }} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.content}>

          {phase === 'resolving' && <Loading icon="wifi" title="Tap detected!" subtitle="Reading the tile…" />}
          {phase === 'locating' && <Loading icon="location-arrow" title="Finding you…" subtitle="Verifying you're here" />}
          {phase === 'stamping' && <Loading icon="stamp" title="Stamping…" subtitle="Almost there" />}
          {phase === 'paying' && <Loading icon="wallet" title="Paying…" subtitle="One moment" />}

          {/* ── Choice menu ── */}
          {phase === 'menu' && tile && (
            <View style={{ alignItems: 'center', gap: 14, alignSelf: 'stretch' }}>
              <View style={[styles.bigIcon, { backgroundColor: S.light }]}><FontAwesome5 name="store" size={34} color={S.color} solid /></View>
              <Text style={styles.subtitle}>You&apos;re at</Text>
              <Text style={styles.title}>{tile.business_name}</Text>
              <View style={{ alignSelf: 'stretch', gap: 10, marginTop: 8 }}>
                {canStamp && (
                  <TouchableOpacity style={[styles.action, { backgroundColor: S.color }]} onPress={doStamp}>
                    <FontAwesome5 name="stamp" size={15} color="#fff" solid /><Text style={styles.actionText}>Collect a stamp</Text>
                  </TouchableOpacity>
                )}
                {canPay && (
                  <TouchableOpacity style={[styles.action, { backgroundColor: '#0E7490' }]} onPress={openPay}>
                    <FontAwesome5 name="wallet" size={15} color="#fff" solid /><Text style={styles.actionText}>Pay from wallet{tile.cashback_percent ? ` · ${tile.cashback_percent}% back` : ''}</Text>
                  </TouchableOpacity>
                )}
                {!canStamp && !canPay && (
                  <Text style={styles.hint}>This business hasn&apos;t switched on stamps or wallet payments yet.</Text>
                )}
                <TouchableOpacity style={styles.secondaryBtn} onPress={() => router.replace({ pathname: '/local-business-detail', params: { id: tile.business_id } })}>
                  <Text style={styles.secondaryBtnText}>View business</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* ── Pay: amount ── */}
          {phase === 'amount' && tile && (
            <View style={{ alignItems: 'center', gap: 8, alignSelf: 'stretch' }}>
              <Text style={styles.subtitle}>Pay {tile.business_name}</Text>
              <View style={styles.amountWrap}>
                <Text style={styles.amountPrefix}>£</Text>
                <TextInput style={styles.amountInput} value={amount} onChangeText={setAmount} placeholder="0.00" placeholderTextColor={colors.textLight} keyboardType="decimal-pad" autoFocus />
              </View>
              <Text style={styles.hint}>Balance: <Text style={{ fontWeight: '800' }}>{formatPence(balance)}</Text></Text>
              {amount !== '' && amountPence < 50 && <Text style={styles.err}>Minimum is £0.50</Text>}
              {amountPence > balance && <Text style={styles.err}>Not enough credit — top up first</Text>}
              <View style={{ alignSelf: 'stretch', gap: 8, marginTop: 16 }}>
                <TouchableOpacity style={[styles.action, { backgroundColor: '#0E7490', opacity: amountValid ? 1 : 0.4 }]} disabled={!amountValid} onPress={doPay}>
                  <Text style={styles.actionText}>Pay {formatPence(amountPence)}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.secondaryBtn} onPress={() => setPhase('menu')}><Text style={styles.secondaryBtnText}>← Back</Text></TouchableOpacity>
              </View>
            </View>
          )}

          {/* ── Stamp done ── */}
          {phase === 'stampDone' && stampResult && (
            <Animated.View style={{ alignItems: 'center', gap: 12, transform: [{ scale: successScale }] }}>
              <View style={[styles.bigIcon, { backgroundColor: stampResult.reward_ready ? colors.successLight : S.light }]}>
                <FontAwesome5 name={stampResult.reward_ready ? 'gift' : 'check'} size={40} color={stampResult.reward_ready ? colors.success : S.color} solid />
              </View>
              <Text style={styles.title}>{stampResult.reward_ready ? '🎉 Reward unlocked!' : 'Stamp collected!'}</Text>
              <Text style={styles.subtitle}>at {stampResult.business_name}</Text>
              <View style={[styles.stampCount, { backgroundColor: S.light }]}>
                <Text style={[styles.stampCountNum, { color: S.color }]}>{stampResult.stamps}</Text>
                <Text style={styles.stampCountTotal}> / {stampResult.needed}</Text>
              </View>
              <DoneRow onDone={() => router.replace('/(tabs)/local')} />
            </Animated.View>
          )}

          {/* ── Pay done ── */}
          {phase === 'payDone' && payResult && tile && (
            <Animated.View style={{ alignItems: 'center', gap: 12, transform: [{ scale: successScale }] }}>
              <View style={[styles.bigIcon, { backgroundColor: colors.successLight }]}><FontAwesome5 name="check" size={40} color={colors.success} solid /></View>
              <Text style={styles.title}>Paid {formatPence(amountPence)}</Text>
              <Text style={styles.subtitle}>to {tile.business_name}</Text>
              {payResult.cashback_pence > 0 && <Text style={[styles.hint, { color: S.color, fontWeight: '800' }]}>Earned {formatPence(payResult.cashback_pence)} cashback</Text>}
              {tile.program_type === 'points' && <Text style={styles.hint}>Loyalty points added to your card ✨</Text>}
              <Text style={styles.hint}>New balance: {formatPence(payResult.balance_pence)}</Text>
              <DoneRow onDone={() => router.replace('/(tabs)/local')} />
            </Animated.View>
          )}

          {/* ── Error ── */}
          {phase === 'error' && (
            <View style={{ alignItems: 'center', gap: 14 }}>
              <View style={[styles.bigIcon, { backgroundColor: '#FEE2E2' }]}><FontAwesome5 name="exclamation-triangle" size={34} color={colors.error} solid /></View>
              <Text style={[styles.title, { color: colors.error }]}>Something went wrong</Text>
              <Text style={styles.errBody}>{errorMsg}</Text>
              <View style={styles.actionRow}>
                <TouchableOpacity style={[styles.primaryBtn, { backgroundColor: S.color }]} onPress={resolve}><Text style={styles.primaryBtnText}>Try again</Text></TouchableOpacity>
                <TouchableOpacity style={styles.secondaryBtn} onPress={() => router.replace('/(tabs)/local')}><Text style={styles.secondaryBtnText}>Back to Local</Text></TouchableOpacity>
              </View>
            </View>
          )}

        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Loading({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) {
  return (
    <View style={{ alignItems: 'center', gap: 14 }}>
      <View style={[styles.bigIcon, { backgroundColor: S.light }]}><FontAwesome5 name={icon as any} size={34} color={S.color} solid /></View>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{subtitle}</Text>
      <ActivityIndicator color={S.color} style={{ marginTop: 4 }} />
    </View>
  );
}
function DoneRow({ onDone }: { onDone: () => void }) {
  return (
    <View style={styles.actionRow}>
      <TouchableOpacity style={[styles.primaryBtn, { backgroundColor: S.color }]} onPress={onDone}><Text style={styles.primaryBtnText}>Done</Text></TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  header: { backgroundColor: colors.navy, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md, paddingVertical: 12, borderBottomWidth: 2 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl },
  bigIcon: { width: 108, height: 108, borderRadius: 54, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: fontSize.xl, fontWeight: '900', color: colors.textPrimary, textAlign: 'center' },
  subtitle: { fontSize: fontSize.md, color: colors.textMuted, fontWeight: '600', textAlign: 'center' },
  hint: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },
  err: { fontSize: fontSize.sm, color: colors.error, fontWeight: '700', textAlign: 'center' },
  action: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, borderRadius: radius.full, paddingVertical: 15 },
  actionText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
  amountWrap: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', gap: 6, marginTop: 8 },
  amountPrefix: { fontSize: 34, fontWeight: '900', color: colors.textMuted },
  amountInput: { fontSize: 50, fontWeight: '900', color: colors.textPrimary, minWidth: 120, textAlign: 'center' },
  stampCount: { flexDirection: 'row', alignItems: 'baseline', paddingHorizontal: 22, paddingVertical: 12, borderRadius: radius.full, marginTop: 4 },
  stampCountNum: { fontSize: 32, fontWeight: '900' },
  stampCountTotal: { fontSize: fontSize.lg, color: colors.textMuted, fontWeight: '700' },
  errBody: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', lineHeight: 20, paddingHorizontal: 12 },
  actionRow: { flexDirection: 'row', gap: 10, marginTop: 8 },
  primaryBtn: { paddingHorizontal: 22, paddingVertical: 12, borderRadius: radius.full },
  primaryBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
  secondaryBtn: { paddingVertical: 12, alignItems: 'center' },
  secondaryBtnText: { color: colors.textMuted, fontSize: fontSize.sm, fontWeight: '700' },
});
