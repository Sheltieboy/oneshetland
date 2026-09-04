/**
 * event-scanner.tsx — Business QR scanner for event check-in
 *
 * Uses expo-camera CameraView (SDK 55). Requires camera permission.
 * Falls back to manual backup code entry if camera unavailable.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ActivityIndicator, Vibration,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
// expo-camera requires a native build — lazy-load so a missing native module
// degrades gracefully to backup-code-only mode instead of crashing the app.
let _CameraView: React.ComponentType<any> = View;
let _useCameraPermissions: () => [any, () => Promise<any>] = () => [null, async () => ({})];
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cam = require('expo-camera');
  _CameraView = cam.CameraView;
  _useCameraPermissions = cam.useCameraPermissions;
} catch { /* native module not available in this build */ }
const CameraView         = _CameraView;
const useCameraPermissions = _useCameraPermissions;
const CAMERA_NATIVE_AVAILABLE = _CameraView !== View;

import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { useAlert } from '@/components/BrandedAlert';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import { fetchScannerStats, type ScannerStats } from '@/lib/events-api';
import { supabase } from '@/lib/supabase';

const S = SECTIONS.events;

type ScanResult = {
  result: string;
  ticket_type_name?: string;
  attendee_name?: string;
  checked_in_at?: string;
};

const RESULT_COLORS: Record<string, string> = {
  valid:            colors.success,
  already_used:     colors.warning,
  wrong_event:      colors.error,
  cancelled:        colors.error,
  refunded:         colors.error,
  not_found:        colors.error,
  payment_incomplete: colors.warning,
  invalid_token:    colors.error,
};

const RESULT_LABELS: Record<string, string> = {
  valid:             '✓ Valid — let them in',
  already_used:      '⚠ Already scanned',
  wrong_event:       '✗ Wrong event',
  cancelled:         '✗ Ticket cancelled',
  refunded:          '✗ Ticket refunded',
  not_found:         '✗ Not found',
  payment_incomplete:'⚠ Payment incomplete',
  invalid_token:     '✗ Invalid QR code',
};

// Auto-format the backup code as XXXX-XXXX. The attendee's ticket shows the dash,
// but staff should only need to type the 8 characters — the dash appears itself
// after the 4th. Backspacing works naturally (the dash re-derives from the clean
// characters). The server strips non-alphanumerics anyway, so this is cosmetic.
function formatBackupCode(raw: string): string {
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

export default function EventScannerScreen() {
  const { id: eventId } = useLocalSearchParams<{ id: string }>();
  const router           = useRouter();
  const { profile }      = useAuth();
  const { alert }        = useAlert();

  const [permission, requestPermission] = useCameraPermissions();
  const [scanning,  setScanning]  = useState(true);
  const [mode,      setMode]      = useState<'qr' | 'backup'>('qr');
  const [backupCode,setBackupCode]= useState('');
  const [busy,      setBusy]      = useState(false);
  const [lastResult,setLastResult]= useState<ScanResult | null>(null);
  const [stats,     setStats]     = useState<ScannerStats | null>(null);

  const cooldownRef = useRef(false);

  const loadStats = useCallback(async () => {
    if (!eventId) return;
    const s = await fetchScannerStats(eventId).catch(() => null);
    setStats(s);
  }, [eventId]);

  useEffect(() => { loadStats(); }, [loadStats]);

  const handleValidate = useCallback(async (rawToken?: string, backup?: string) => {
    if (!eventId || !profile || busy) return;
    if (cooldownRef.current) return;
    cooldownRef.current = true;
    setBusy(true);
    setScanning(false);

    try {
      const body: Record<string, string> = { event_id: eventId };
      if (rawToken) body.raw_token = rawToken;
      else if (backup) body.backup_code = backup.toUpperCase().replace(/[^A-Z0-9]/g, '');

      const { data, error } = await supabase.functions.invoke('validate-event-ticket', { body });
      if (error) {
        let msg = error.message;
        try {
          const c = (error as any)?.context;
          if (c?.json) { const b = await c.json(); if (b?.error) msg = b.error; }
        } catch { /* keep generic */ }
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);

      const result: ScanResult = data;
      setLastResult(result);

      if (result.result === 'valid') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Vibration.vibrate(200);
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }

      loadStats();
    } catch (e: any) {
      alert({ title: 'Scan error', message: e.message ?? 'Try again' });
    } finally {
      setBusy(false);
      // Allow rescanning after 2.5s
      setTimeout(() => {
        cooldownRef.current = false;
        setScanning(true);
        setBackupCode('');
      }, 2500);
    }
  }, [eventId, profile, busy, loadStats]);

  const handleBarcode = useCallback(({ data }: { data: string }) => {
    if (!scanning || cooldownRef.current) return;
    handleValidate(data, undefined);
  }, [scanning, handleValidate]);

  // No event to scan against. Every code read would be silently discarded by
  // the guard in handleValidate, so the camera would look like it was working
  // and simply never respond. Say so instead of miming.
  if (!eventId) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
            <FontAwesome5 name="chevron-left" size={14} color={S.color} />
            <Text style={[styles.backText, { color: S.color }]}>Back</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Scan tickets</Text>
        </View>
        <View style={styles.center}>
          <Text style={styles.permText}>
            No event chosen. Open the event you are scanning for, then start the scanner.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  // Native camera module not yet installed — degrade to backup-code mode only
  if (!CAMERA_NATIVE_AVAILABLE) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
            <FontAwesome5 name="chevron-left" size={14} color={S.color} />
            <Text style={[styles.backText, { color: S.color }]}>Back</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Scan Tickets</Text>
          <View style={{ width: 60 }} />
        </View>
        {stats && (
          <View style={styles.statsRow}>
            <StatPill label="Sold"       value={stats.tickets_sold} color={S.color} />
            <StatPill label="Checked in" value={stats.checked_in}   color={colors.success} />
            <StatPill label="Remaining"  value={Math.max(0, stats.tickets_sold - stats.checked_in)} color={colors.textMuted} />
          </View>
        )}
        <View style={[styles.backupInput, { flex: 1 }]}>
          <View style={styles.nativeBanner}>
            <FontAwesome5 name="info-circle" size={16} color={colors.warning} />
            <Text style={styles.nativeBannerText}>
              QR scanning requires a new build.{'\n'}Use backup codes below until then.
            </Text>
          </View>
          <Text style={styles.backupLabel}>Enter backup code</Text>
          <Text style={styles.backupHint}>The XXXX-XXXX code from the attendee's ticket</Text>
          <TextInput
            style={styles.backupField}
            value={backupCode}
            onChangeText={t => setBackupCode(t.toUpperCase())}
            placeholder="XXXX-XXXX"
            placeholderTextColor={colors.textLight}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={9}
          />
          <TouchableOpacity
            style={[styles.validateBtn, { backgroundColor: backupCode.length < 9 || busy ? colors.darkCard : S.color }]}
            onPress={() => handleValidate(undefined, backupCode)}
            disabled={backupCode.length < 9 || busy}
            activeOpacity={0.85}
          >
            {busy
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={[styles.validateBtnText, backupCode.length < 9 && { color: colors.textMuted }]}>Validate</Text>
            }
          </TouchableOpacity>
        </View>
        {lastResult && (
          <View style={[styles.resultBanner, { backgroundColor: RESULT_COLORS[lastResult.result] ?? colors.textMuted }]}>
            <Text style={styles.resultLabel}>{RESULT_LABELS[lastResult.result] ?? lastResult.result}</Text>
            {lastResult.ticket_type_name && <Text style={styles.resultSub}>{lastResult.ticket_type_name}</Text>}
          </View>
        )}
        {busy && (
          <View style={styles.busyOverlay}>
            <ActivityIndicator size="large" color="#fff" />
          </View>
        )}
      </SafeAreaView>
    );
  }

  // Camera permission still loading
  if (!permission) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}><ActivityIndicator color={S.color} /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Scan Tickets</Text>
        <View style={{ width: 60 }} />
      </View>

      {/* Stats strip */}
      {stats && (
        <View style={styles.statsRow}>
          <StatPill label="Sold"      value={stats.tickets_sold}   color={S.color} />
          <StatPill label="Checked in" value={stats.checked_in}   color={colors.success} />
          <StatPill label="Remaining"  value={Math.max(0, stats.tickets_sold - stats.checked_in)} color={colors.textMuted} />
        </View>
      )}

      {/* Mode toggle */}
      <View style={styles.modeRow}>
        <TouchableOpacity
          style={[styles.modeBtn, mode === 'qr' && { backgroundColor: S.color }]}
          onPress={() => setMode('qr')}
          activeOpacity={0.8}
        >
          <FontAwesome5 name="qrcode" size={13} color={mode === 'qr' ? '#fff' : colors.textMuted} />
          <Text style={[styles.modeBtnText, mode === 'qr' && { color: '#fff' }]}>QR Scan</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.modeBtn, mode === 'backup' && { backgroundColor: S.color }]}
          onPress={() => setMode('backup')}
          activeOpacity={0.8}
        >
          <FontAwesome5 name="keyboard" size={13} color={mode === 'backup' ? '#fff' : colors.textMuted} />
          <Text style={[styles.modeBtnText, mode === 'backup' && { color: '#fff' }]}>Backup Code</Text>
        </TouchableOpacity>
      </View>

      {/* Camera / backup input */}
      <View style={styles.scanArea}>
        {mode === 'qr' ? (
          !permission.granted ? (
            <View style={styles.center}>
              <FontAwesome5 name="camera-slash" size={40} color={colors.textLight} />
              <Text style={styles.permText}>Camera access needed to scan tickets</Text>
              <TouchableOpacity
                style={[styles.permBtn, { backgroundColor: S.color }]}
                onPress={requestPermission}
                activeOpacity={0.85}
              >
                <Text style={styles.permBtnText}>Grant access</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              onBarcodeScanned={scanning && !cooldownRef.current ? handleBarcode : undefined}
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            >
              {/* Viewfinder overlay */}
              <View style={styles.viewfinderWrap}>
                <View style={styles.viewfinder}>
                  <View style={[styles.corner, styles.cornerTL]} />
                  <View style={[styles.corner, styles.cornerTR]} />
                  <View style={[styles.corner, styles.cornerBL]} />
                  <View style={[styles.corner, styles.cornerBR]} />
                </View>
                <Text style={styles.viewfinderHint}>Point camera at attendee's QR code</Text>
              </View>
            </CameraView>
          )
        ) : (
          <View style={styles.backupInput}>
            <Text style={styles.backupLabel}>Enter backup code</Text>
            <Text style={styles.backupHint}>The XXXX-XXXX code from the attendee's ticket</Text>
            <TextInput
              style={styles.backupField}
              value={backupCode}
              onChangeText={t => setBackupCode(formatBackupCode(t))}
              placeholder="XXXX-XXXX"
              placeholderTextColor={colors.textLight}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={9}
              keyboardType="default"
            />
            <TouchableOpacity
              style={[styles.validateBtn, { backgroundColor: backupCode.length < 9 || busy ? colors.border : S.color }]}
              onPress={() => handleValidate(undefined, backupCode)}
              disabled={backupCode.length < 9 || busy}
              activeOpacity={0.85}
            >
              {busy
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={[styles.validateBtnText, backupCode.length < 9 && { color: colors.textMuted }]}>Validate</Text>
              }
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Result overlay */}
      {lastResult && (
        <View style={[styles.resultBanner, { backgroundColor: RESULT_COLORS[lastResult.result] ?? colors.textMuted }]}>
          <Text style={styles.resultLabel}>{RESULT_LABELS[lastResult.result] ?? lastResult.result}</Text>
          {lastResult.ticket_type_name && (
            <Text style={styles.resultSub}>{lastResult.ticket_type_name}</Text>
          )}
          {lastResult.attendee_name && (
            <Text style={styles.resultSub}>{lastResult.attendee_name}</Text>
          )}
        </View>
      )}

      {busy && (
        <View style={styles.busyOverlay}>
          <ActivityIndicator size="large" color="#fff" />
        </View>
      )}
    </SafeAreaView>
  );
}

function StatPill({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={styles.statPill}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const CORNER_SIZE = 24;
const CORNER_THICK = 3;

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },

  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
  },
  backBtn:     { flexDirection: 'row', alignItems: 'center', gap: 8, width: 60 },
  backText:    { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },

  statsRow: {
    flexDirection: 'row', justifyContent: 'center', gap: 20,
    backgroundColor: colors.navy, paddingBottom: 10,
  },
  statPill:  { alignItems: 'center' },
  statValue: { fontSize: fontSize.xl, fontWeight: '900' },
  statLabel: { fontSize: 10, color: 'rgba(255,255,255,0.6)', fontWeight: '700', textTransform: 'uppercase' },

  modeRow: {
    flexDirection: 'row', backgroundColor: colors.darkCard,
    padding: 4, margin: spacing.md, borderRadius: radius.md, gap: 4,
  },
  modeBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 10, borderRadius: radius.sm,
  },
  modeBtnText: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textMuted },

  scanArea: { flex: 1, position: 'relative', overflow: 'hidden' },

  viewfinderWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 20 },
  viewfinder: { width: 240, height: 240, position: 'relative' },
  corner: {
    position: 'absolute', width: CORNER_SIZE, height: CORNER_SIZE,
    borderColor: '#fff', borderWidth: CORNER_THICK,
  },
  cornerTL: { top: 0,    left: 0,    borderRightWidth: 0, borderBottomWidth: 0 },
  cornerTR: { top: 0,    right: 0,   borderLeftWidth: 0,  borderBottomWidth: 0 },
  cornerBL: { bottom: 0, left: 0,    borderRightWidth: 0, borderTopWidth: 0    },
  cornerBR: { bottom: 0, right: 0,   borderLeftWidth: 0,  borderTopWidth: 0    },
  viewfinderHint: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.xs, fontWeight: '600' },

  permText:    { color: '#fff', fontSize: fontSize.sm, textAlign: 'center', paddingHorizontal: 40 },
  permBtn:     { marginTop: 8, paddingHorizontal: 24, paddingVertical: 12, borderRadius: radius.md },
  permBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },

  nativeBanner: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    backgroundColor: colors.darkCard, padding: 14, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.warning + '40', marginBottom: 8,
    width: '100%', maxWidth: 320,
  },
  nativeBannerText: { flex: 1, color: colors.warning, fontSize: fontSize.xs, lineHeight: 18 },

  backupInput: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl, gap: 12 },
  backupLabel: { color: '#fff', fontSize: fontSize.lg, fontWeight: '900' },
  backupHint:  { color: 'rgba(255,255,255,0.6)', fontSize: fontSize.xs, textAlign: 'center' },
  backupField: {
    width: '100%', maxWidth: 280,
    backgroundColor: colors.darkCard, color: '#fff',
    fontSize: fontSize.xxl, fontWeight: '900', textAlign: 'center',
    letterSpacing: 6, borderRadius: radius.lg,
    padding: 16, borderWidth: 1.5, borderColor: S.color + '60',
    fontFamily: 'monospace',
  },
  validateBtn: {
    width: '100%', maxWidth: 280,
    paddingVertical: 14, borderRadius: radius.md, alignItems: 'center',
  },
  validateBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '900' },

  resultBanner: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    padding: spacing.md, alignItems: 'center', gap: 4,
  },
  resultLabel: { color: '#fff', fontSize: fontSize.lg, fontWeight: '900' },
  resultSub:   { color: 'rgba(255,255,255,0.8)', fontSize: fontSize.sm },

  busyOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
});
