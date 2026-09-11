/**
 * local-verify.tsx — staff redeem a reward the customer has already earned.
 *
 * THREE STEPS, AND ONLY ONE OF THEM SPENDS ANYTHING.
 *
 *   scan     the customer's one-time reward QR, or type their 4-character code
 *   preview  READ-ONLY: what it is, and what is left on it right now
 *   done     the result, as the server reported it
 *
 * It used to call the MUTATING verify the instant a QR entered the camera frame,
 * then show a panel headed "Not valid" or a tick — after the use had already
 * been taken. Staff could not tell whether they had spent the customer's credit
 * or were about to, and a mis-aimed camera spent it for them. The database was
 * never wrong; the screen was. The website was fixed for exactly this reason
 * (see components/business/RedeemVerify.tsx and preview_redemption); this screen
 * was the last one left on the old behaviour.
 *
 * Nothing here computes a balance. The preview shows what preview_redemption
 * read; the result shows what the atomic spender returned. The backend, its
 * replay protection and its concurrency locks are untouched.
 *
 * A member card scanned here never reaches the network: it is recognised by
 * shape and answered with a pointer to the Loyalty till. See lib/redemption-ux.
 *
 * BUSINESS CONTEXT. This screen operates as ONE business, named on screen and
 * sent with every call. It used to take no route parameter at all while the
 * backend authorised against every business the caller owned, so an owner of
 * two could stand in Anderson & Co and redeem a reward belonging to the other
 * — the only merchant route in that dashboard block not passing a businessId.
 * The server is the authority (preview_redemption, loyalty_redeem_code_atomic
 * and redeem_pass_atomic all take p_business now); this screen's job is to know
 * which business it is, say so, and refuse to guess when it cannot.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, spacing, radius, fontSize } from '@/constants/theme';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { CommercialTermsGate } from '@/components/CommercialTermsGate';
import { previewRedemption, verifyRedemption, fetchMyBusinesses, type LocalBusiness } from '@/lib/local-api';
import { useAuth } from '@/context/AuthContext';
import { classifyScan, redemptionErrorState, wrongScannerState, type MerchantState } from '@/lib/redemption-ux';

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

/** What the merchant is holding, resolved but NOT yet spent. */
type Pending = { code?: string; token?: string; title: string; subtitle?: string };

function LocalVerifyBody() {
  const { businessId: routeBusinessId } = useLocalSearchParams<{ businessId?: string }>();
  const { profile } = useAuth();
  const [permission, requestPermission] = useCameraPermissions();
  /**
   * null while we are still working out which business this is; a business once
   * we know; 'none' when we cannot know and must not guess. Both merchant entry
   * points pass a businessId, so 'none' means a deep link or a stale route — and
   * for an owner of several businesses, guessing one would be the very defect
   * this screen exists to close.
   */
  const [business, setBusiness] = useState<LocalBusiness | null | 'none'>(null);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [result, setResult] = useState<{ ok: boolean; title: string; message?: string } | null>(null);

  // Guards the camera, which fires continuously. It is raised while a scan is
  // being resolved AND for as long as a preview or result is on screen, so the
  // camera can never overwrite what staff are reading or act a second time.
  const lockRef = useRef(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!profile) { if (alive) setBusiness('none'); return; }
      const mine = await fetchMyBusinesses(profile.id).catch(() => [] as LocalBusiness[]);
      if (!alive) return;
      // The id must be present AND one of the caller's own. Anything else is
      // 'none' — never a guess, and never another business the caller happens
      // to own, which is the whole defect this screen was changed to close.
      const named = routeBusinessId ? mine.find((b) => b.id === routeBusinessId) : undefined;
      setBusiness(named ?? 'none');
    })();
    return () => { alive = false; };
  }, [profile?.id, routeBusinessId]);

  /** Step 1 — look, don't spend. */
  async function look(input: { code?: string; token?: string }) {
    const biz = business;
    if (!biz || biz === 'none') return;   // the render blocks this, belt and braces
    if (lockRef.current) return;
    lockRef.current = true;
    setBusy(true);
    try {
      const p = await previewRedemption({ ...input, businessId: biz.id });
      Haptics.selectionAsync();
      setPending({ ...input, title: p.detail?.title ?? 'Reward', subtitle: p.detail?.subtitle });
    } catch (e) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  /** Step 2 — the only call that consumes anything, and only staff start it. */
  async function confirm() {
    const biz = business;
    if (!biz || biz === 'none') return;
    if (!pending || busy) return;
    setBusy(true);
    const { code, token } = pending;
    try {
      const r = await verifyRedemption(code ? { code, businessId: biz.id } : { token, businessId: biz.id });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setPending(null);
      setResult({ ok: true, title: r.detail?.title ?? 'Reward', message: r.detail?.subtitle });
    } catch (e) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setPending(null);
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  /** Every failure path goes through here, so no raw text can reach the screen. */
  function fail(e: unknown) {
    const s = redemptionErrorState(e);
    if (s.detail) console.warn('[local-verify]', s.detail);
    setResult({ ok: false, title: s.title, message: s.message });
  }

  /** A wrong-kind scan: answered from its shape, without contacting anything. */
  function refuse(s: MerchantState) {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    lockRef.current = true;
    setResult({ ok: false, title: s.title, message: s.message });
  }

  function onScan(data: string) {
    if (lockRef.current || !data) return;
    const kind = classifyScan(data);
    const wrong = wrongScannerState('redemption', kind);
    if (wrong) { refuse(wrong); return; }
    look({ token: data.trim() });
  }

  /** Cancel and Next customer are the same thing: drop everything, spend nothing. */
  function reset() {
    setPending(null);
    setResult(null);
    setManual('');
    lockRef.current = false;
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScreenHeader
        title="Redeem a reward"
        subtitle={business && business !== 'none' ? business.name : 'Scan the customer’s reward QR'}
        onClose={() => router.back()}
        accent={ACCENT}
      />
      <View style={styles.body}>
        {business === null ? (
          <View style={styles.center}><ActivityIndicator color={ACCENT} /></View>
        ) : business === 'none' ? (
          /* No context, and more than one business to be wrong about. Guessing
             one is exactly the defect this screen was changed to close. */
          <View style={styles.center}>
            <View style={[styles.tick, { backgroundColor: '#B45309' }]}>
              <FontAwesome5 name="store" size={30} color="#fff" solid />
            </View>
            <Text style={styles.resTitle}>Which business?</Text>
            <Text style={styles.resSub}>
              Open the business you’re serving from your dashboard, then tap Redeem a reward. A
              reward can only be redeemed by the business that issued it.
            </Text>
            <TouchableOpacity style={[styles.btn, { backgroundColor: ACCENT }]} onPress={() => router.back()}>
              <Text style={styles.btnText}>Go back</Text>
            </TouchableOpacity>
          </View>
        ) : result ? (
          <View style={styles.center}>
            <View style={[styles.tick, { backgroundColor: result.ok ? '#16a34a' : '#dc2626' }]}>
              <FontAwesome5 name={result.ok ? 'check' : 'times'} size={32} color="#fff" />
            </View>
            <Text style={styles.resTitle}>{result.ok ? `${result.title} — redeemed` : result.title}</Text>
            {!!result.message && <Text style={styles.resSub}>{result.message}</Text>}
            <TouchableOpacity style={[styles.btn, { backgroundColor: ACCENT }]} onPress={reset}>
              <Text style={styles.btnText}>Next customer</Text>
            </TouchableOpacity>
          </View>
        ) : pending ? (
          /* Nothing has been consumed at this point. */
          <View style={styles.center}>
            <Text style={styles.aboutLabel}>ABOUT TO REDEEM</Text>
            <Text style={styles.aboutTitle}>{pending.title}</Text>
            {!!pending.subtitle && <Text style={styles.aboutSub}>{pending.subtitle}</Text>}
            <Text style={styles.aboutBiz}>at {business.name}</Text>
            <Text style={styles.aboutNote}>Nothing has been used yet.</Text>
            <TouchableOpacity
              style={[styles.wideBtn, { backgroundColor: ACCENT, opacity: busy ? 0.5 : 1 }]}
              disabled={busy}
              onPress={confirm}
            >
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Redeem reward</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={styles.ghostBtn} disabled={busy} onPress={reset}>
              <Text style={styles.ghostText}>Cancel</Text>
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
                  onBarcodeScanned={({ data }: { data: string }) => onScan(data)}
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

            <Text style={styles.leadIn}>
              Redeeming for <Text style={styles.leadInBiz}>{business.name}</Text>. Passes, vouchers,
              loyalty rewards and offers. Nothing is used until you confirm.
            </Text>

            {/* Manual code */}
            <View style={styles.manualWrap}>
              <Text style={styles.manualLabel}>…or type their 4-character code</Text>
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
                  onPress={() => look({ code: manual })}
                >
                  {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Look up</Text>}
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
  leadIn: { color: colors.textMuted, fontSize: fontSize.sm, textAlign: 'center', paddingHorizontal: spacing.sm, marginTop: -4 },
  leadInBiz: { fontWeight: '800', color: colors.textPrimary },
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

  aboutLabel: { fontSize: 11, fontWeight: '800', color: colors.textMuted, letterSpacing: 1.2 },
  aboutTitle: { fontSize: fontSize.xxl, fontWeight: '900', color: colors.textPrimary, textAlign: 'center', paddingHorizontal: spacing.lg },
  aboutSub: { fontSize: fontSize.md, color: colors.textMuted, textAlign: 'center', paddingHorizontal: spacing.lg },
  aboutBiz: { fontSize: fontSize.sm, fontWeight: '800', color: ACCENT, marginTop: 2 },
  aboutNote: { fontSize: fontSize.sm, color: colors.textLight, marginTop: 2 },
  wideBtn: { alignSelf: 'stretch', marginHorizontal: spacing.lg, marginTop: 20, height: 54, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center' },
  ghostBtn: { paddingVertical: 12, paddingHorizontal: 24 },
  ghostText: { color: colors.textMuted, fontWeight: '800', fontSize: fontSize.sm },
});

/**
 * Commercial screen: the business must have accepted the business & selling
 * terms first, exactly as the Loyalty till does. Redeeming spends something the
 * customer paid for — a pass is a purchased product — so it belongs on the same
 * side of that gate as the till it sits beside. One acceptance covers every
 * commercial screen for a business, so a merchant already using the till sees
 * no new step here.
 */
export default function LocalVerifyScreen() {
  const { businessId } = useLocalSearchParams<{ businessId?: string }>();
  return (
    <CommercialTermsGate businessId={businessId} feature="Loyalty">
      <LocalVerifyBody />
    </CommercialTermsGate>
  );
}
