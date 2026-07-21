/**
 * local-till.tsx — the unified "one member card" till (business side).
 *
 * Staff scan the customer's ONE member code (or type it), see their status at
 * THIS business, then act: add a stamp, add points, redeem a ready reward, or
 * apply an offer. Backed by the loyalty-till edge function.
 */
import React, { useRef, useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, ActivityIndicator, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, spacing, radius, fontSize } from '@/constants/theme';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { tillLookup, tillAction, type TillLookup } from '@/lib/member-card';

// Soft-load expo-camera (mirrors local-verify.tsx).
let _CameraView: React.ComponentType<any> = View;
let _useCameraPermissions: () => [{ granted: boolean } | null, () => Promise<{ granted: boolean }>] = () => [null, async () => ({ granted: false })];
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cam = require('expo-camera');
  _CameraView = cam.CameraView;
  _useCameraPermissions = cam.useCameraPermissions;
} catch { /* native module absent */ }
const CameraView = _CameraView;
const useCameraPermissions = _useCameraPermissions;
const CAMERA_AVAILABLE = _CameraView !== View;

const ACCENT = '#7C3AED';

export default function LocalTillScreen() {
  const { businessId } = useLocalSearchParams<{ businessId?: string }>();
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<TillLookup | null>(null);
  const [code, setCode] = useState('');
  const [amount, setAmount] = useState('');
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  const lockRef = useRef(false);

  async function lookup(memberCode: string) {
    if (lockRef.current) return;
    lockRef.current = true; setBusy(true); setToast(null);
    try {
      const res = await tillLookup(memberCode.toUpperCase().trim(), businessId);
      setData(res); setCode(memberCode.toUpperCase().trim());
      Haptics.selectionAsync();
    } catch (e) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setToast({ ok: false, text: e instanceof Error ? e.message : 'Not found' });
    } finally { setBusy(false); lockRef.current = false; }
  }

  async function act(action: 'stamp' | 'points' | 'redeem_reward' | 'redeem_offer', extra: { amountPence?: number; offerId?: string } = {}) {
    setBusy(true); setToast(null);
    try {
      const res = await tillAction(action, code, { businessId, ...extra });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setToast({ ok: true, text: res.message });
      await lookupSilent();   // refresh status
    } catch (e) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setToast({ ok: false, text: e instanceof Error ? e.message : 'Failed' });
    } finally { setBusy(false); }
  }
  async function lookupSilent() {
    try { setData(await tillLookup(code, businessId)); } catch { /* keep */ }
  }

  function reset() { setData(null); setCode(''); setManual(''); setAmount(''); setToast(null); lockRef.current = false; }

  const program = data?.program;
  const card = data?.card;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScreenHeader title="Loyalty till" subtitle={data ? data.business.name : 'Scan a member’s card'} onClose={() => router.back()} accent={ACCENT} />
      <ScrollView contentContainerStyle={styles.body}>
        {!data ? (
          <>
            <View style={styles.scannerBox}>
              {CAMERA_AVAILABLE && permission?.granted ? (
                <CameraView style={StyleSheet.absoluteFill} barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                  onBarcodeScanned={({ data: d }: { data: string }) => { if (!lockRef.current && d) lookup(d); }} />
              ) : (
                <View style={styles.scannerPlaceholder}>
                  <FontAwesome5 name="qrcode" size={40} color={colors.textLight} />
                  <Text style={styles.scannerHint}>{CAMERA_AVAILABLE ? 'Camera access is needed to scan' : 'Scanning needs the latest app build'}</Text>
                  {CAMERA_AVAILABLE && (
                    <TouchableOpacity style={[styles.btn, { backgroundColor: ACCENT }]} onPress={() => requestPermission()}>
                      <Text style={styles.btnText}>Allow camera</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}
            </View>
            <Text style={styles.manualLabel}>…or type their member code</Text>
            <View style={styles.manualRow}>
              <TextInput style={styles.manualInput} value={manual}
                onChangeText={(t) => setManual(t.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8))}
                placeholder="ABCD1234" placeholderTextColor={colors.textLight} autoCapitalize="characters" autoCorrect={false} maxLength={8} />
              <TouchableOpacity style={[styles.confirmBtn, { backgroundColor: ACCENT, opacity: manual.length >= 6 && !busy ? 1 : 0.4 }]}
                disabled={manual.length < 6 || busy} onPress={() => lookup(manual)}>
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Find</Text>}
              </TouchableOpacity>
            </View>
            {toast && <Text style={[styles.toast, { color: toast.ok ? '#16a34a' : '#dc2626' }]}>{toast.text}</Text>}
          </>
        ) : (
          <>
            <View style={styles.statusCard}>
              <Text style={styles.custName}>{data.customer.name}</Text>
              {program ? (
                program.type === 'points'
                  ? <Text style={styles.statusLine}>{card?.points_balance ?? 0} points</Text>
                  : <Text style={styles.statusLine}>{card?.stamps_collected ?? 0}{program.reward_tiers.length ? ` / ${program.reward_tiers[program.reward_tiers.length - 1].stamps}` : ` / ${program.stamps_required ?? 0}`} stamps</Text>
              ) : <Text style={styles.statusLine}>No loyalty card here yet</Text>}
              {data.ready_reward && (
                <View style={styles.readyPill}><FontAwesome5 name="gift" size={10} color="#fff" solid /><Text style={styles.readyText}>Reward ready: {data.ready_reward.reward}</Text></View>
              )}
            </View>

            {toast && <Text style={[styles.toast, { color: toast.ok ? '#16a34a' : '#dc2626' }]}>{toast.text}</Text>}

            {/* Actions */}
            {program?.type === 'stamps' && (
              <TouchableOpacity style={[styles.action, { backgroundColor: ACCENT }]} disabled={busy} onPress={() => act('stamp')}>
                <FontAwesome5 name="stamp" size={14} color="#fff" solid /><Text style={styles.actionText}>Add a stamp</Text>
              </TouchableOpacity>
            )}

            {program?.type === 'points' && (
              <View style={styles.pointsRow}>
                <TextInput style={styles.amountInput} value={amount} onChangeText={(t) => setAmount(t.replace(/[^0-9.]/g, ''))} placeholder="£ spent" placeholderTextColor={colors.textLight} keyboardType="decimal-pad" />
                <TouchableOpacity style={[styles.action, { backgroundColor: ACCENT, flex: 1, opacity: parseFloat(amount) > 0 && !busy ? 1 : 0.4 }]}
                  disabled={!(parseFloat(amount) > 0) || busy} onPress={() => act('points', { amountPence: Math.round(parseFloat(amount) * 100) })}>
                  <FontAwesome5 name="coins" size={14} color="#fff" solid /><Text style={styles.actionText}>Add points</Text>
                </TouchableOpacity>
              </View>
            )}

            {data.ready_reward && (
              <TouchableOpacity style={[styles.action, { backgroundColor: '#16a34a' }]} disabled={busy} onPress={() => act('redeem_reward')}>
                <FontAwesome5 name="gift" size={14} color="#fff" solid /><Text style={styles.actionText}>Give reward: {data.ready_reward.reward}</Text>
              </TouchableOpacity>
            )}

            {data.offers.filter((o) => !o.claimed).map((o) => (
              <TouchableOpacity key={o.id} style={[styles.action, { backgroundColor: '#D97706' }]} disabled={busy} onPress={() => act('redeem_offer', { offerId: o.id })}>
                <FontAwesome5 name="tag" size={13} color="#fff" solid /><Text style={styles.actionText}>Apply offer: {o.title} ({o.badge})</Text>
              </TouchableOpacity>
            ))}

            {busy && <ActivityIndicator color={ACCENT} style={{ marginTop: 8 }} />}

            <TouchableOpacity style={styles.nextBtn} onPress={reset}>
              <Text style={styles.nextText}>Next customer</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  body: { padding: spacing.md, gap: 12, paddingBottom: 60 },
  scannerBox: { aspectRatio: 1, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: '#000' },
  scannerPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: '#fff' },
  scannerHint: { color: colors.textMuted, fontSize: fontSize.sm, textAlign: 'center', paddingHorizontal: 24 },
  manualLabel: { fontSize: fontSize.sm, color: colors.textMuted, fontWeight: '700', marginTop: 4 },
  manualRow: { flexDirection: 'row', gap: 8 },
  manualInput: { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, fontSize: fontSize.md, fontWeight: '800', letterSpacing: 2, color: colors.textPrimary },
  confirmBtn: { borderRadius: radius.md, paddingHorizontal: 22, alignItems: 'center', justifyContent: 'center' },
  btn: { borderRadius: radius.md, paddingHorizontal: 20, paddingVertical: 12, alignItems: 'center' },
  btnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
  toast: { fontSize: fontSize.sm, fontWeight: '800', textAlign: 'center', paddingVertical: 4 },

  statusCard: { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 16, alignItems: 'center', gap: 6 },
  custName: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary },
  statusLine: { fontSize: fontSize.md, color: colors.textSecondary, fontWeight: '700' },
  readyPill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#16a34a', paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.full, marginTop: 4 },
  readyText: { color: '#fff', fontSize: 11, fontWeight: '800' },

  action: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: radius.md, paddingVertical: 15 },
  actionText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
  pointsRow: { flexDirection: 'row', gap: 8, alignItems: 'stretch' },
  amountInput: { width: 96, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 12, fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  nextBtn: { paddingVertical: 14, alignItems: 'center', marginTop: 8 },
  nextText: { color: colors.textMuted, fontSize: fontSize.sm, fontWeight: '800' },
});
