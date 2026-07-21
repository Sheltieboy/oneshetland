/**
 * local-redeem.tsx — customer "show at till" screen.
 *
 * Starts a redemption via the backbone (local-redeem-start), shows a big code +
 * QR for staff to verify, counts down the 15-minute window, and polls until
 * staff confirm — then flips to a success state. Nothing on the customer's
 * balances changes until staff verify. Works for offers, stamp rewards, passes
 * and points.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import QRCode from 'react-native-qrcode-svg';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, spacing, radius, fontSize } from '@/constants/theme';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { startRedemption, getRedemptionStatus, type RedemptionTicket, type RedeemKind } from '@/lib/local-api';

const ACCENT = '#4F46E5';

export default function LocalRedeemScreen() {
  const params = useLocalSearchParams<{ kind: RedeemKind; ref_id: string; amount?: string }>();
  const [ticket, setTicket] = useState<RedemptionTicket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(15 * 60);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const t = await startRedemption(params.kind, params.ref_id, params.amount ? Number(params.amount) : undefined);
        if (alive) setTicket(t);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Could not start.');
      }
    })();
    return () => {
      alive = false;
      if (pollRef.current) clearInterval(pollRef.current);
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, []);

  useEffect(() => {
    if (!ticket) return;
    tickRef.current = setInterval(() => {
      const s = Math.max(0, Math.round((new Date(ticket.expires_at).getTime() - Date.now()) / 1000));
      setSecondsLeft(s);
      if (s <= 0 && tickRef.current) clearInterval(tickRef.current);
    }, 1000);
    pollRef.current = setInterval(async () => {
      const st = await getRedemptionStatus(ticket.id);
      if (st === 'consumed') {
        if (pollRef.current) clearInterval(pollRef.current);
        if (tickRef.current) clearInterval(tickRef.current);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setDone(true);
      }
    }, 2500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [ticket]);

  const mm = Math.floor(secondsLeft / 60);
  const ss = String(secondsLeft % 60).padStart(2, '0');

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScreenHeader title="Show at till" onClose={() => router.back()} accent={ACCENT} />
      <View style={styles.body}>
        {error ? (
          <View style={styles.center}>
            <FontAwesome5 name="exclamation-circle" size={34} color={colors.textLight} />
            <Text style={styles.errTitle}>Can’t redeem</Text>
            <Text style={styles.errMsg}>{error}</Text>
            <TouchableOpacity style={[styles.btn, { backgroundColor: ACCENT }]} onPress={() => router.back()}>
              <Text style={styles.btnText}>Back</Text>
            </TouchableOpacity>
          </View>
        ) : done ? (
          <View style={styles.center}>
            <View style={[styles.tick, { backgroundColor: ACCENT }]}><FontAwesome5 name="check" size={34} color="#fff" /></View>
            <Text style={styles.doneTitle}>Redeemed!</Text>
            <Text style={styles.doneMsg}>{ticket?.detail?.title ?? 'Enjoy'} — confirmed by staff. 🎉</Text>
            <TouchableOpacity style={[styles.btn, { backgroundColor: ACCENT }]} onPress={() => router.back()}>
              <Text style={styles.btnText}>Done</Text>
            </TouchableOpacity>
          </View>
        ) : !ticket ? (
          <View style={styles.center}><ActivityIndicator color={ACCENT} /></View>
        ) : (
          <View style={styles.center}>
            <Text style={styles.thing}>{ticket.detail?.title ?? 'Redemption'}</Text>
            {!!ticket.detail?.subtitle && <Text style={styles.thingSub}>{ticket.detail.subtitle}</Text>}
            <View style={styles.qrWrap}><QRCode value={ticket.token} size={196} /></View>
            <Text style={styles.orLabel}>or read this code to staff</Text>
            <Text style={[styles.code, { color: ACCENT }]}>{ticket.code}</Text>
            <Text style={styles.hint}>Staff scan the code or type it in to confirm. Expires in {mm}:{ss}.</Text>
            <View style={styles.waiting}>
              <ActivityIndicator size="small" color={colors.textLight} />
              <Text style={styles.waitingText}>Waiting for staff to confirm…</Text>
            </View>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  body: { flex: 1, backgroundColor: colors.screenBackground },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, gap: 10 },
  thing: { fontSize: fontSize.xxl, fontWeight: '800', color: colors.textPrimary, textAlign: 'center' },
  thingSub: { fontSize: fontSize.md, color: colors.textMuted, marginTop: -4 },
  qrWrap: { backgroundColor: '#fff', padding: 16, borderRadius: radius.lg, marginTop: 14, shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 3 },
  orLabel: { fontSize: fontSize.xs, color: colors.textLight, textTransform: 'uppercase', letterSpacing: 1, marginTop: 16 },
  code: { fontSize: 46, fontWeight: '900', letterSpacing: 8, marginTop: 2 },
  hint: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', paddingHorizontal: spacing.md, marginTop: 6 },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 18 },
  waitingText: { fontSize: fontSize.sm, color: colors.textLight },
  tick: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  doneTitle: { fontSize: fontSize.xxxl, fontWeight: '900', color: colors.textPrimary },
  doneMsg: { fontSize: fontSize.md, color: colors.textMuted, textAlign: 'center', paddingHorizontal: spacing.lg },
  errTitle: { fontSize: fontSize.xl, fontWeight: '800', color: colors.textPrimary, marginTop: 6 },
  errMsg: { fontSize: fontSize.md, color: colors.textMuted, textAlign: 'center', paddingHorizontal: spacing.lg },
  btn: { marginTop: 18, borderRadius: radius.full, paddingHorizontal: 32, paddingVertical: 13 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: fontSize.md },
});
