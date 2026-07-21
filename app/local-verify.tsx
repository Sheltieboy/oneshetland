/**
 * local-verify.tsx — staff "confirm a redemption" screen (business side).
 *
 * Staff scan the customer's QR (expo-camera) or type their short code, and the
 * backbone (local-redeem-verify) applies the effect — records the offer/reward,
 * decrements the pass, or spends the points — and reports back what it was. This
 * is the proof-of-presence step that replaces the honour system.
 */
import React, { useRef, useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, spacing, radius, fontSize } from '@/constants/theme';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { verifyRedemption } from '@/lib/local-api';

// Soft-load expo-camera so a build without the native module still renders the
// manual-code path (mirrors event-scanner.tsx).
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

const ACCENT = '#4F46E5';

export default function LocalVerifyScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; title: string; subtitle?: string } | null>(null);
  const lockRef = useRef(false);

  async function verify(input: { code?: string; token?: string }) {
    if (lockRef.current) return;
    lockRef.current = true;
    setBusy(true);
    try {
      const r = await verifyRedemption(input);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setResult({ ok: true, title: r.detail?.title ?? 'Redeemed', subtitle: r.detail?.subtitle });
    } catch (e) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setResult({ ok: false, title: 'Not valid', subtitle: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setResult(null);
    setManual('');
    lockRef.current = false;
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScreenHeader title="Confirm a redemption" subtitle="Scan the customer’s code" onClose={() => router.back()} accent={ACCENT} />
      <View style={styles.body}>
        {result ? (
          <View style={styles.center}>
            <View style={[styles.tick, { backgroundColor: result.ok ? '#16a34a' : '#dc2626' }]}>
              <FontAwesome5 name={result.ok ? 'check' : 'times'} size={32} color="#fff" />
            </View>
            <Text style={styles.resTitle}>{result.title}</Text>
            {!!result.subtitle && <Text style={styles.resSub}>{result.subtitle}</Text>}
            <TouchableOpacity style={[styles.btn, { backgroundColor: ACCENT }]} onPress={reset}>
              <Text style={styles.btnText}>Confirm another</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {/* Camera scanner */}
            <View style={styles.scannerBox}>
              {CAMERA_AVAILABLE && permission?.granted ? (
                <CameraView
                  style={StyleSheet.absoluteFill}
                  barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                  onBarcodeScanned={({ data }: { data: string }) => { if (!lockRef.current && data) verify({ token: data }); }}
                />
              ) : (
                <View style={styles.scannerPlaceholder}>
                  <FontAwesome5 name="qrcode" size={40} color={colors.textLight} />
                  <Text style={styles.scannerHint}>
                    {CAMERA_AVAILABLE ? 'Camera access is needed to scan' : 'Scanning needs the latest app build'}
                  </Text>
                  {CAMERA_AVAILABLE && (
                    <TouchableOpacity style={[styles.btn, { backgroundColor: ACCENT }]} onPress={() => requestPermission()}>
                      <Text style={styles.btnText}>Allow camera</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}
            </View>

            {/* Manual code */}
            <View style={styles.manualWrap}>
              <Text style={styles.manualLabel}>…or type their code</Text>
              <View style={styles.manualRow}>
                <TextInput
                  style={styles.manualInput}
                  value={manual}
                  onChangeText={(t) => setManual(t.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
                  placeholder="ABCD"
                  placeholderTextColor={colors.textLight}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={4}
                />
                <TouchableOpacity
                  style={[styles.confirmBtn, { backgroundColor: ACCENT, opacity: manual.length === 4 && !busy ? 1 : 0.4 }]}
                  disabled={manual.length !== 4 || busy}
                  onPress={() => verify({ code: manual })}
                >
                  {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Confirm</Text>}
                </TouchableOpacity>
              </View>
            </View>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  body: { flex: 1, backgroundColor: colors.screenBackground, padding: spacing.md, gap: 16 },
  scannerBox: { aspectRatio: 1, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: '#000' },
  scannerPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: colors.offWhite },
  scannerHint: { color: colors.textMuted, fontSize: fontSize.sm, textAlign: 'center', paddingHorizontal: spacing.lg },
  manualWrap: { backgroundColor: '#fff', borderRadius: radius.lg, padding: spacing.md, gap: 10 },
  manualLabel: { color: colors.textMuted, fontSize: fontSize.sm, fontWeight: '600' },
  manualRow: { flexDirection: 'row', gap: 10 },
  manualInput: { flex: 1, borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, fontSize: 24, fontWeight: '800', letterSpacing: 6, color: colors.textPrimary, textAlign: 'center' },
  confirmBtn: { borderRadius: radius.md, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  tick: { width: 74, height: 74, borderRadius: 37, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  resTitle: { fontSize: fontSize.xxl, fontWeight: '900', color: colors.textPrimary, textAlign: 'center' },
  resSub: { fontSize: fontSize.md, color: colors.textMuted, textAlign: 'center', paddingHorizontal: spacing.lg },
  btn: { borderRadius: radius.full, paddingHorizontal: 28, paddingVertical: 12, marginTop: 14 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: fontSize.md },
});
