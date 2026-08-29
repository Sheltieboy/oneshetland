/**
 * local-counter.tsx — Counter mode: the "serve a customer" surface.
 *
 * The business dashboard is for MANAGING (owner, occasional, private). This is
 * for OPERATING (owner or staff, many times a day, safe to hand over): a
 * dedicated screen a shop can leave propped on the counter all day. It shows
 * the rotating till code big enough to read across a counter, and gives one
 * button for the only other thing staff do — scan the customer's member card.
 *
 * The kiosk lock is why this screen exists rather than just linking to the
 * till: with a PIN set, leaving Counter mode needs the PIN, so the owner can
 * hand a staff member the tablet without handing over their takings, payouts
 * and subscription too. The PIN is deliberately device-local (SecureStore, per
 * business) — it guards the screen in front of you, not the account, so it
 * needs no backend and can't lock anyone out of their own data. Signing out or
 * reinstalling clears it; that's the intended escape hatch.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, AppState, BackHandler, Modal, StyleSheet, Text,
  TextInput, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { CommercialTermsGate } from '@/components/CommercialTermsGate';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';
import { colors, fontSize, radius, spacing } from '@/constants/theme';
import { useAuth } from '@/context/AuthContext';
import { useAlert } from '@/components/BrandedAlert';
import {
  fetchBusiness, fetchMyBusinesses, fetchBusinessCode, refreshBusinessCode,
  type LocalBusiness, type BusinessCode,
} from '@/lib/local-api';

const ACCENT = '#7C3AED';
const PIN_KEY = (businessId: string) => `counter_pin_${businessId}`;
/** The code is valid 90s; refresh comfortably inside that. */
const CODE_REFRESH_MS = 60_000;

function LocalCounterBody() {
  const { businessId: paramId } = useLocalSearchParams<{ businessId?: string }>();
  const { profile } = useAuth();
  const { alert } = useAlert();

  const [business, setBusiness] = useState<LocalBusiness | null>(null);
  const [code, setCode] = useState<BusinessCode | null>(null);
  const [loading, setLoading] = useState(true);

  const [pin, setPin] = useState<string | null>(null);
  const [asking, setAsking] = useState<null | 'set' | 'exit'>(null);
  const [entry, setEntry] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);

  // ── Load the business (explicit id, else the owner's first) ────────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const biz = paramId
          ? await fetchBusiness(paramId)
          : (profile ? (await fetchMyBusinesses(profile.id))[0] ?? null : null);
        if (!alive) return;
        setBusiness(biz);
        if (biz) setPin(await SecureStore.getItemAsync(PIN_KEY(biz.id)));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [paramId, profile?.id]);

  // ── Keep the till code fresh ──────────────────────────────────────────────
  const refresh = useCallback(async (bizId: string) => {
    try { setCode(await refreshBusinessCode(bizId)); }
    catch { /* a stale code still shows; the next tick retries */ }
  }, []);

  useEffect(() => {
    if (!business) return;
    let alive = true;
    (async () => {
      const existing = await fetchBusinessCode(business.id).catch(() => null);
      if (!alive) return;
      // Reuse a code that still has life in it, so re-entering Counter mode
      // doesn't invalidate the number a customer is halfway through typing.
      if (existing && new Date(existing.expires_at).getTime() - Date.now() > 15_000) setCode(existing);
      else await refresh(business.id);
    })();
    const t = setInterval(() => refresh(business.id), CODE_REFRESH_MS);
    return () => { alive = false; clearInterval(t); };
  }, [business?.id, refresh]);

  // Drives the visible countdown; the code itself refreshes on its own timer.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Refresh on return to foreground — a backgrounded tablet's code has lapsed.
  useEffect(() => {
    if (!business) return;
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') refresh(business.id); });
    return () => sub.remove();
  }, [business?.id, refresh]);

  // ── The lock ──────────────────────────────────────────────────────────────
  const leave = useCallback(() => {
    if (router.canGoBack()) router.back(); else router.replace('/local-business-dashboard');
  }, []);

  const tryLeave = useCallback(() => {
    if (!pin) { leave(); return; }
    setEntry(''); setPinError(null); setAsking('exit');
  }, [pin, leave]);

  // Android's hardware back must respect the lock too, or it's not a lock.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { tryLeave(); return true; });
    return () => sub.remove();
  }, [tryLeave]);

  const submitPin = async () => {
    if (!business) return;
    if (!/^\d{4}$/.test(entry)) { setPinError('Four digits.'); return; }
    if (asking === 'set') {
      await SecureStore.setItemAsync(PIN_KEY(business.id), entry);
      setPin(entry); setAsking(null); setEntry('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      return;
    }
    if (entry !== pin) {
      setPinError('That’s not the PIN.');
      setEntry('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    setAsking(null); setEntry('');
    leave();
  };

  const clearPin = async () => {
    if (!business) return;
    await SecureStore.deleteItemAsync(PIN_KEY(business.id));
    setPin(null);
    alert({ title: 'PIN removed', message: 'Counter mode can now be left without a PIN.' });
  };

  // ── Render ────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <SafeAreaView style={[styles.safe, styles.center]}>
        <ActivityIndicator size="large" color={ACCENT} />
      </SafeAreaView>
    );
  }

  if (!business) {
    return (
      <SafeAreaView style={[styles.safe, styles.center, { padding: spacing.lg }]}>
        <Text style={styles.emptyTitle}>No business yet</Text>
        <Text style={styles.emptyBody}>Counter mode is for a business you run. Register one first.</Text>
        <TouchableOpacity style={styles.primary} onPress={() => router.replace('/local-business-register')}>
          <Text style={styles.primaryText}>Register a business</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const secondsLeft = code ? Math.max(0, Math.round((new Date(code.expires_at).getTime() - Date.now()) / 1000)) : 0;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      {/* Deliberately not a ScreenHeader: no back chevron, because leaving is
          the one action that goes through the lock. */}
      <View style={styles.topBar}>
        <View style={{ flex: 1 }}>
          <Text style={styles.bizName} numberOfLines={1}>{business.name}</Text>
          <Text style={styles.mode}>Counter mode</Text>
        </View>
        <TouchableOpacity onPress={tryLeave} style={styles.exitBtn} accessibilityRole="button" accessibilityLabel="Leave Counter mode">
          <FontAwesome5 name={pin ? 'lock' : 'times'} size={14} color="#fff" solid />
          <Text style={styles.exitText}>Exit</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.body}>
        <Text style={styles.codeLabel}>TILL CODE</Text>
        <Text style={styles.code} accessibilityLabel={`Till code ${code?.current_code?.split('').join(' ') ?? ''}`}>
          {code?.current_code ?? '––––––'}
        </Text>
        <Text style={styles.codeHint}>
          {secondsLeft > 0
            ? `Customers enter this in their wallet to pay · refreshes in ${secondsLeft}s`
            : 'Refreshing…'}
        </Text>

        <TouchableOpacity
          style={styles.scanBtn}
          activeOpacity={0.88}
          onPress={() => router.push(`/local-till?businessId=${business.id}`)}
          accessibilityRole="button"
          accessibilityLabel="Scan a member card"
        >
          <FontAwesome5 name="qrcode" size={20} color="#fff" solid />
          <Text style={styles.scanText}>Scan a member card</Text>
        </TouchableOpacity>
        <Text style={styles.scanHint}>Stamps, points, rewards, offers and card payments</Text>
      </View>

      <View style={styles.footer}>
        {pin ? (
          <TouchableOpacity onPress={clearPin}><Text style={styles.footerLink}>Remove staff PIN</Text></TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={() => { setEntry(''); setPinError(null); setAsking('set'); }}>
            <Text style={styles.footerLink}>Set a staff PIN to lock this screen</Text>
          </TouchableOpacity>
        )}
      </View>

      <Modal visible={asking !== null} transparent animationType="fade" onRequestClose={() => setAsking(null)}>
        <View style={styles.modalWrap}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{asking === 'set' ? 'Choose a 4-digit PIN' : 'Enter the staff PIN'}</Text>
            <Text style={styles.modalBody}>
              {asking === 'set'
                ? 'Staff will need this to leave Counter mode. It’s stored on this device only.'
                : 'Counter mode is locked.'}
            </Text>
            <TextInput
              style={styles.pinInput}
              value={entry}
              onChangeText={(t) => { setEntry(t.replace(/\D/g, '').slice(0, 4)); setPinError(null); }}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={4}
              autoFocus
              textAlign="center"
            />
            {pinError ? <Text style={styles.pinError}>{pinError}</Text> : null}
            <View style={styles.modalRow}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => { setAsking(null); setEntry(''); }}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalOk} onPress={submitPin}>
                <Text style={styles.modalOkText}>{asking === 'set' ? 'Save PIN' : 'Unlock'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: '#0B0620' },
  center: { alignItems: 'center', justifyContent: 'center', gap: spacing.md },

  topBar:  { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  bizName: { color: '#fff', fontSize: fontSize.lg, fontWeight: '900' },
  mode:    { color: 'rgba(255,255,255,0.55)', fontSize: fontSize.xs, fontWeight: '800', letterSpacing: 1.2, textTransform: 'uppercase' },
  exitBtn:  { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: 'rgba(255,255,255,0.14)', paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.full },
  exitText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },

  body:      { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg },
  codeLabel: { color: 'rgba(255,255,255,0.5)', fontSize: fontSize.xs, fontWeight: '900', letterSpacing: 2 },
  code:      { color: '#fff', fontSize: 68, fontWeight: '900', letterSpacing: 10, marginLeft: 10 },
  codeHint:  { color: 'rgba(255,255,255,0.6)', fontSize: fontSize.sm, textAlign: 'center', marginBottom: spacing.xl },

  scanBtn:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.md, backgroundColor: ACCENT, borderRadius: radius.lg, paddingVertical: 22, paddingHorizontal: 32, alignSelf: 'stretch' },
  scanText: { color: '#fff', fontSize: fontSize.xl, fontWeight: '900' },
  scanHint: { color: 'rgba(255,255,255,0.5)', fontSize: fontSize.xs, marginTop: spacing.sm },

  footer:     { alignItems: 'center', paddingVertical: spacing.md },
  footerLink: { color: 'rgba(255,255,255,0.6)', fontSize: fontSize.xs, fontWeight: '700', textDecorationLine: 'underline' },

  emptyTitle: { color: '#fff', fontSize: fontSize.xl, fontWeight: '900' },
  emptyBody:  { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.sm, textAlign: 'center' },
  primary:     { backgroundColor: ACCENT, borderRadius: radius.lg, paddingVertical: 14, paddingHorizontal: 24 },
  primaryText: { color: '#fff', fontWeight: '800', fontSize: fontSize.md },

  modalWrap:  { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  modalCard:  { backgroundColor: '#fff', borderRadius: radius.lg, padding: spacing.lg, width: '100%', maxWidth: 360, gap: spacing.sm },
  modalTitle: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary },
  modalBody:  { fontSize: fontSize.sm, color: colors.textMuted, lineHeight: 19 },
  pinInput:   { borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.md, fontSize: 30, fontWeight: '900', letterSpacing: 12, paddingVertical: 12, color: colors.textPrimary },
  pinError:   { color: colors.error, fontSize: fontSize.sm, fontWeight: '700' },
  modalRow:   { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  modalCancel:     { flex: 1, alignItems: 'center', paddingVertical: 13, borderRadius: radius.full, borderWidth: 1, borderColor: colors.border },
  modalCancelText: { fontWeight: '800', color: colors.textPrimary, fontSize: fontSize.sm },
  modalOk:     { flex: 1, alignItems: 'center', paddingVertical: 13, borderRadius: radius.full, backgroundColor: ACCENT },
  modalOkText: { fontWeight: '800', color: '#fff', fontSize: fontSize.sm },
});

/**
 * Commercial screen: the business must have accepted the business & selling
 * terms first. One acceptance covers every commercial screen for that business;
 * Directory management is never gated. Same RPCs, event type and version as the
 * website — see lib/commercial-terms.ts.
 */
export default function LocalCounterScreen() {
  const { businessId } = useLocalSearchParams<{ businessId?: string }>();
  return (
    <CommercialTermsGate businessId={businessId} feature="Counter mode">
      <LocalCounterBody />
    </CommercialTermsGate>
  );
}
