/**
 * local-stamp-scanner.tsx
 *
 * Code-entry screen: the user types in the 6-digit code shown by the business
 * to collect a stamp. (No camera library installed, so we use rotating codes.)
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, TextInput,
  ActivityIndicator, Keyboard,
} from 'react-native';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { collectStamp } from '@/lib/local-api';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { useAlert } from '@/components/BrandedAlert';

const S = SECTIONS.local;

export default function StampScannerScreen() {
  const router = useRouter();
  const { alert } = useAlert();
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [submitting, setSubmitting] = useState(false);
  const inputs = useRef<(TextInput | null)[]>([]);

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
      const result = await collectStamp(code);
      if (result.reward_ready) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        alert({
          title: '🎉 Reward unlocked!',
          message: `You have ${result.stamps} of ${result.needed} stamps. Show your card to claim your reward!`,
          actions: [
            { label: 'View card', style: 'primary', onPress: () => router.replace('/local-my-cards') },
          ],
        });
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        alert({
          title: 'Stamp collected!',
          message: `${result.stamps} of ${result.needed} stamps.`,
          actions: [
            { label: 'Done', style: 'primary', onPress: () => router.back() },
          ],
        });
      }
    } catch (e: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      alert({ title: 'Could not collect stamp', message: e.message ?? 'Try again.' });
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
            Codes expire after 60 seconds. If yours doesn't work, ask staff for a fresh one.
          </Text>
        </View>
      </View>
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
});
