/**
 * local-stamp-scanner.tsx
 *
 * Code-entry screen: the user types in the 6-digit code shown by the business
 * to collect a stamp. (No camera library installed, so we use rotating codes.)
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, TextInput,
  ActivityIndicator, Keyboard, Animated, Easing, TouchableOpacity,
} from 'react-native';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { collectStamp } from '@/lib/local-api';
import { supabase } from '@/lib/supabase';
import { useGoToSignIn } from '@/hooks/useGoToSignIn';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { useAlert } from '@/components/BrandedAlert';

const S = SECTIONS.local;

export default function StampScannerScreen() {
  const router = useRouter();
  const { alert } = useAlert();
  const goToSignIn = useGoToSignIn();
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [submitting, setSubmitting] = useState(false);
  const inputs = useRef<(TextInput | null)[]>([]);

  // Celebration overlay shown the moment a stamp lands (the dopamine hit).
  const [celebration, setCelebration] = useState<{ stamps: number; needed: number; rewardReady: boolean } | null>(null);
  const popScale = useRef(new Animated.Value(0)).current;
  const burst = useRef(new Animated.Value(0)).current;
  const confetti = useRef(
    Array.from({ length: 14 }, (_, i) => ({
      angle: (i / 14) * Math.PI * 2 + (i % 2 ? 0.22 : 0),
      color: ['#F59E0B', '#10B981', '#3B82F6', '#EF4444', '#8B5CF6', '#EC4899'][i % 6],
    })),
  ).current;

  const runCelebration = () => {
    popScale.setValue(0);
    burst.setValue(0);
    Animated.parallel([
      Animated.spring(popScale, { toValue: 1, friction: 5, tension: 80, useNativeDriver: true }),
      Animated.timing(burst, { toValue: 1, duration: 950, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]).start();
  };

  const collectAnother = () => {
    setCelebration(null);
    setDigits(['', '', '', '', '', '']);
    setTimeout(() => inputs.current[0]?.focus(), 100);
  };

  useEffect(() => {
    setTimeout(() => inputs.current[0]?.focus(), 200);
  }, []);

  const handleChange = (idx: number, val: string) => {
    const cleaned = val.replace(/\D/g, '').slice(-1);
    const next = [...digits];
    next[idx] = cleaned;
    setDigits(next);

    if (cleaned && idx < 5) {
      inputs.current[idx + 1]?.focus();
    }
    if (next.every(d => d.length === 1)) {
      Keyboard.dismiss();
      submit(next.join(''));
    }
  };

  const handleKeyPress = (idx: number, key: string) => {
    if (key === 'Backspace' && !digits[idx] && idx > 0) {
      inputs.current[idx - 1]?.focus();
    }
  };

  const submit = async (code: string) => {
    if (submitting) return;
    setSubmitting(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      // The collect endpoint needs a live user token. If we're signed out — or the
      // cached token has expired — refresh it first so we don't fire a request that
      // comes back as a confusing "Unauthorised".
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('AUTH_REQUIRED');
      if (session.expires_at && session.expires_at * 1000 < Date.now() + 30_000) {
        const { error: refreshErr } = await supabase.auth.refreshSession();
        if (refreshErr) throw new Error('AUTH_REQUIRED');
      }

      const result = await collectStamp(code);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Keyboard.dismiss();
      // Celebrate right here so the new stamp "appears" with a little fanfare,
      // instead of a plain alert + leaving the screen to see it.
      setCelebration({ stamps: result.stamps ?? 0, needed: result.needed ?? 0, rewardReady: !!result.reward_ready });
      runCelebration();
    } catch (e: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const msg: string = e?.message ?? '';
      if (msg === 'AUTH_REQUIRED' || /unauthor/i.test(msg)) {
        alert({
          title: 'Sign in to collect stamps',
          message: 'You need to be signed in to your OneShetland account to collect and keep loyalty stamps. Please sign in and try again.',
          actions: [
            { label: 'Sign in', style: 'primary', onPress: () => goToSignIn('/local-stamp-scanner') },
            { label: 'Not now', style: 'cancel' },
          ],
        });
      } else {
        alert({ title: 'Could not collect stamp', message: msg || 'Try again.' });
      }
      setDigits(['', '', '', '', '', '']);
      setTimeout(() => inputs.current[0]?.focus(), 100);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScreenScaffold
      header={<ScreenHeader title="Collect a stamp" accent={S.color} onBack={() => router.back()} />}
    >
      <View style={styles.content}>
        <View style={[styles.iconWrap, { backgroundColor: S.light }]}>
          <FontAwesome5 name="stamp" size={28} color={S.color} solid />
        </View>

        <Text style={styles.title}>Enter the 6-digit code</Text>
        <Text style={styles.subtitle}>
          Ask staff for the code shown on their till — it refreshes every minute.
        </Text>

        <View style={styles.digitsRow}>
          {digits.map((d, i) => (
            <TextInput
              key={i}
              ref={(r) => { inputs.current[i] = r; }}
              style={[styles.digit, d && { borderColor: S.color, backgroundColor: S.light }]}
              value={d}
              onChangeText={(v) => handleChange(i, v)}
              onKeyPress={(e) => handleKeyPress(i, e.nativeEvent.key)}
              keyboardType="number-pad"
              maxLength={1}
              selectTextOnFocus
              editable={!submitting}
            />
          ))}
        </View>

        {submitting && (
          <View style={{ marginTop: 24, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <ActivityIndicator color={S.color} />
            <Text style={styles.submittingText}>Checking code…</Text>
          </View>
        )}

        <View style={styles.tip}>
          <FontAwesome5 name="info-circle" size={11} color={colors.textMuted} />
          <Text style={styles.tipText}>
            Codes refresh every minute. If yours doesn't work, ask staff to show a fresh one.
          </Text>
        </View>
      </View>

      {celebration && (
        <View style={styles.celebrateOverlay}>
          {confetti.map((c, i) => {
            const dist = 175;
            return (
              <Animated.View
                key={i}
                style={[
                  styles.confetti,
                  {
                    backgroundColor: c.color,
                    opacity: burst.interpolate({ inputRange: [0, 0.75, 1], outputRange: [1, 1, 0] }),
                    transform: [
                      { translateX: burst.interpolate({ inputRange: [0, 1], outputRange: [0, Math.cos(c.angle) * dist] }) },
                      { translateY: burst.interpolate({ inputRange: [0, 1], outputRange: [0, Math.sin(c.angle) * dist + 70] }) },
                      { scale: burst.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 1, 0.5] }) },
                      { rotate: burst.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${(i % 2 ? 1 : -1) * 220}deg`] }) },
                    ],
                  },
                ]}
              />
            );
          })}

          <Animated.View
            style={[
              styles.celebrateBadge,
              {
                backgroundColor: celebration.rewardReady ? '#F59E0B' : S.color,
                transform: [
                  { scale: popScale },
                  { rotate: popScale.interpolate({ inputRange: [0, 1], outputRange: ['-25deg', '0deg'] }) },
                ],
              },
            ]}
          >
            <FontAwesome5 name={celebration.rewardReady ? 'gift' : 'stamp'} size={40} color="#fff" solid />
          </Animated.View>

          <Text style={styles.celebrateTitle}>{celebration.rewardReady ? '🎉 Reward unlocked!' : 'Stamp collected!'}</Text>
          <Text style={styles.celebrateCount}>{celebration.stamps} of {celebration.needed} stamps</Text>

          <View style={styles.pips}>
            {Array.from({ length: Math.min(celebration.needed, 12) }, (_, i) => (
              <View key={i} style={[styles.pip, i < celebration.stamps && { backgroundColor: S.color, borderColor: S.color }]} />
            ))}
          </View>

          {celebration.rewardReady && (
            <Text style={styles.celebrateReward}>Show your card to staff to claim your reward.</Text>
          )}

          <View style={styles.celebrateBtns}>
            <TouchableOpacity style={[styles.celebrateBtn, { backgroundColor: S.color }]} onPress={() => router.replace('/local-my-cards')} activeOpacity={0.85}>
              <Text style={styles.celebrateBtnText}>View my card</Text>
            </TouchableOpacity>
            {!celebration.rewardReady && (
              <TouchableOpacity style={styles.celebrateBtnGhost} onPress={collectAnother} activeOpacity={0.85}>
                <Text style={[styles.celebrateBtnText, { color: S.color }]}>Collect another</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content:  { flex: 1, alignItems: 'center', paddingTop: 48, paddingHorizontal: spacing.xl, gap: 12 },
  iconWrap: { width: 84, height: 84, borderRadius: 42, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  title:    { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary, marginTop: 4 },
  subtitle: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },

  digitsRow: { flexDirection: 'row', gap: 8, marginTop: 24 },
  digit: {
    width: 44, height: 56, borderRadius: radius.md,
    borderWidth: 1.5, borderColor: colors.border,
    backgroundColor: '#fff',
    textAlign: 'center', fontSize: 24, fontWeight: '900', color: colors.textPrimary,
  },

  submittingText: { fontSize: fontSize.sm, color: colors.textMuted, fontWeight: '600' },

  tip: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    marginTop: 'auto', marginBottom: 32, padding: 12,
    backgroundColor: '#fff', borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
  },
  tipText: { flex: 1, fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 16 },

  // Celebration overlay
  celebrateOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255,255,255,0.98)',
    alignItems: 'center', justifyContent: 'center', padding: spacing.xl,
  },
  confetti: { position: 'absolute', top: '40%', left: '50%', width: 11, height: 11, borderRadius: 2, marginLeft: -5.5, marginTop: -5.5 },
  celebrateBadge: {
    width: 112, height: 112, borderRadius: 56, alignItems: 'center', justifyContent: 'center', marginBottom: 22,
    shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 14, shadowOffset: { width: 0, height: 8 }, elevation: 6,
  },
  celebrateTitle: { fontSize: 24, fontWeight: '900', color: colors.textPrimary, textAlign: 'center' },
  celebrateCount: { fontSize: fontSize.md, fontWeight: '700', color: colors.textSecondary, marginTop: 6 },
  pips: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: 18, maxWidth: 260 },
  pip: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: colors.border, backgroundColor: '#fff' },
  celebrateReward: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 14, textAlign: 'center' },
  celebrateBtns: { marginTop: 28, width: '100%', gap: 10 },
  celebrateBtn: { height: 52, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' },
  celebrateBtnGhost: { height: 52, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: S.color },
  celebrateBtnText: { fontSize: fontSize.md, fontWeight: '800', color: '#fff' },
});
