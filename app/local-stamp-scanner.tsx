/**
 * local-stamp-scanner.tsx
 *
 * Code-entry screen: the user types in the 6-digit code shown by the business
 * to collect a stamp. (No camera library installed, so we use rotating codes.)
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  Alert, ActivityIndicator, Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { collectStamp } from '@/lib/local-api';

const S = SECTIONS.local;

export default function StampScannerScreen() {
  const router = useRouter();
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
        Alert.alert(
          '🎉 Reward unlocked!',
          `You have ${result.stamps} of ${result.needed} stamps. Show your card to claim your reward!`,
          [{ text: 'View card', onPress: () => router.replace('/local-my-cards') }],
        );
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert(
          'Stamp collected!',
          `${result.stamps} of ${result.needed} stamps.`,
          [{ text: 'Done', onPress: () => router.back() }],
        );
      }
    } catch (e: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Could not collect stamp', e.message ?? 'Try again.');
      setDigits(['', '', '', '', '', '']);
      setTimeout(() => inputs.current[0]?.focus(), 100);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Collect a stamp</Text>
        <View style={{ width: 70 }} />
      </View>

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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },

  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
    borderBottomWidth: 2,
  },
  backBtn:     { flexDirection: 'row', alignItems: 'center', gap: 8, width: 70 },
  backText:    { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },

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
