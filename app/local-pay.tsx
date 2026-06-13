/**
 * local-pay.tsx
 *
 * Customer enters the business code + amount to pay from their wallet.
 * Two-step flow: 1) enter amount, 2) enter 6-digit code, then confirm.
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, TextInput,
  Alert, Keyboard, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import { fetchWalletBalance, payWithWallet, formatPence } from '@/lib/local-api';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { Button } from '@/components/ui/Button';
import { LoadingState } from '@/components/ui/LoadingState';

const S = SECTIONS.local;

type Step = 'amount' | 'code' | 'paying' | 'done';

export default function PayScreen() {
  const router = useRouter();
  const { profile } = useAuth();

  const [step, setStep]       = useState<Step>('amount');
  const [amount, setAmount]   = useState('');
  const [digits, setDigits]   = useState<string[]>(['', '', '', '', '', '']);
  const [balance, setBalance] = useState<number>(0);
  const [result, setResult]   = useState<{ balance_pence: number; cashback_pence: number } | null>(null);

  const inputs = useRef<(TextInput | null)[]>([]);

  useEffect(() => {
    if (profile) fetchWalletBalance(profile.id).then(setBalance);
  }, [profile?.id]);

  const amountPence = Math.round((parseFloat(amount) || 0) * 100);
  const amountValid = amountPence >= 50 && amountPence <= balance;

  const proceedToCode = () => {
    if (!amountValid) return;
    Haptics.selectionAsync();
    setStep('code');
    setTimeout(() => inputs.current[0]?.focus(), 200);
  };

  const handleDigit = (idx: number, val: string) => {
    const cleaned = val.replace(/\D/g, '').slice(-1);
    const next = [...digits];
    next[idx] = cleaned;
    setDigits(next);
    if (cleaned && idx < 5) inputs.current[idx + 1]?.focus();
    if (next.every(d => d.length === 1)) {
      Keyboard.dismiss();
      submitPayment(next.join(''));
    }
  };

  const handleKeyPress = (idx: number, key: string) => {
    if (key === 'Backspace' && !digits[idx] && idx > 0) {
      inputs.current[idx - 1]?.focus();
    }
  };

  const submitPayment = async (code: string) => {
    setStep('paying');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const res = await payWithWallet(code, amountPence);
      setResult(res);
      setStep('done');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Payment failed', e.message ?? 'Try again');
      setDigits(['', '', '', '', '', '']);
      setStep('code');
      setTimeout(() => inputs.current[0]?.focus(), 100);
    }
  };

  return (
    <ScreenScaffold
      header={<ScreenHeader title="Pay at till" accent={S.color} onBack={() => router.back()} />}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >

        {/* ── Step: amount ── */}
        {step === 'amount' && (
          <View style={styles.content}>
            <Text style={styles.label}>Amount to pay</Text>
            <View style={styles.amountWrap}>
              <Text style={styles.amountPrefix}>£</Text>
              <TextInput
                style={styles.amountInput}
                value={amount}
                onChangeText={setAmount}
                placeholder="0.00"
                placeholderTextColor={colors.textLight}
                keyboardType="decimal-pad"
                autoFocus
              />
            </View>
            <Text style={styles.balanceHint}>
              Balance: <Text style={{ fontWeight: '800' }}>{formatPence(balance)}</Text>
            </Text>
            {amount && !amountValid && amountPence < 50 && (
              <Text style={styles.errorText}>Minimum payment is £0.50</Text>
            )}
            {amount && amountPence > balance && (
              <Text style={styles.errorText}>Not enough credit — top up first</Text>
            )}

            <View style={styles.ctaWrap}>
              <Button
                label="Continue"
                onPress={proceedToCode}
                icon="arrow-right"
                color={S.color}
                disabled={!amountValid}
                fullWidth
              />
            </View>
          </View>
        )}

        {/* ── Step: code ── */}
        {step === 'code' && (
          <View style={styles.content}>
            <View style={[styles.iconWrap, { backgroundColor: S.light }]}>
              <FontAwesome5 name="qrcode" size={26} color={S.color} solid />
            </View>
            <Text style={styles.title}>Enter business code</Text>
            <Text style={styles.subtitle}>
              Ask staff for their till code · paying {formatPence(amountPence)}
            </Text>
            <View style={styles.digitsRow}>
              {digits.map((d, i) => (
                <TextInput
                  key={i}
                  ref={(r) => { inputs.current[i] = r; }}
                  style={[styles.digit, d && { borderColor: S.color, backgroundColor: S.light }]}
                  value={d}
                  onChangeText={(v) => handleDigit(i, v)}
                  onKeyPress={(e) => handleKeyPress(i, e.nativeEvent.key)}
                  keyboardType="number-pad"
                  maxLength={1}
                  selectTextOnFocus
                />
              ))}
            </View>

            <View style={styles.changeAmountBtn}>
              <Button
                label="← Change amount"
                onPress={() => setStep('amount')}
                variant="ghost"
                size="sm"
                haptic={false}
              />
            </View>
          </View>
        )}

        {/* ── Step: paying ── */}
        {step === 'paying' && (
          <View style={[styles.content, { justifyContent: 'center', alignItems: 'center' }]}>
            <LoadingState accent={S.color} />
            <Text style={[styles.title, { marginTop: 16 }]}>Processing payment…</Text>
          </View>
        )}

        {/* ── Step: done ── */}
        {step === 'done' && result && (
          <View style={[styles.content, { alignItems: 'center' }]}>
            <View style={[styles.iconWrap, { backgroundColor: colors.successLight }]}>
              <FontAwesome5 name="check" size={32} color={colors.success} solid />
            </View>
            <Text style={styles.title}>Paid!</Text>
            <Text style={styles.successAmount}>{formatPence(amountPence)}</Text>
            {result.cashback_pence > 0 && (
              <View style={styles.cashbackBanner}>
                <FontAwesome5 name="gift" size={11} color={S.color} solid />
                <Text style={[styles.cashbackText, { color: S.color }]}>
                  Earned {formatPence(result.cashback_pence)} cashback
                </Text>
              </View>
            )}
            <Text style={styles.subtitle}>New balance: {formatPence(result.balance_pence)}</Text>
            <View style={styles.doneCtaWrap}>
              <Button
                label="Done"
                onPress={() => router.back()}
                color={S.color}
                fullWidth
              />
            </View>
          </View>
        )}

      </KeyboardAvoidingView>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content:  { flex: 1, paddingTop: 32, paddingHorizontal: spacing.xl, gap: 14 },
  iconWrap: { width: 84, height: 84, borderRadius: 42, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
  title:    { fontSize: fontSize.xl, fontWeight: '900', color: colors.textPrimary, textAlign: 'center' },
  subtitle: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },
  label:    { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary, marginTop: 12 },

  amountWrap: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', gap: 6, marginTop: 12 },
  amountPrefix: { fontSize: 36, fontWeight: '900', color: colors.textMuted },
  amountInput: { fontSize: 52, fontWeight: '900', color: colors.textPrimary, minWidth: 120, textAlign: 'center' },
  balanceHint: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },
  errorText:   { fontSize: fontSize.sm, color: colors.error, textAlign: 'center', fontWeight: '600' },

  ctaWrap: { marginTop: 'auto', marginBottom: 24 },

  digitsRow: { flexDirection: 'row', gap: 8, marginTop: 16, justifyContent: 'center' },
  digit: {
    width: 44, height: 56, borderRadius: radius.md,
    borderWidth: 1.5, borderColor: colors.border,
    backgroundColor: '#fff',
    textAlign: 'center', fontSize: 24, fontWeight: '900', color: colors.textPrimary,
  },

  changeAmountBtn: { alignItems: 'center', marginTop: 16 },

  successAmount: { fontSize: 44, fontWeight: '900', color: colors.success, marginTop: 4 },
  cashbackBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: S.light, paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.full, marginTop: 4 },
  cashbackText: { fontSize: fontSize.sm, fontWeight: '800' },
  doneCtaWrap: { marginTop: 32, alignSelf: 'stretch' },
});
