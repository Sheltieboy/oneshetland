import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Image,
  KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Button } from '@/components/ui/Button';
import { Input, KeyboardDoneBar } from '@/components/ui/Input';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';

// The reset link opens the OneShetland website reset page, which completes the
// password change. Keeps the flow robust without app deep-link handling.
const RESET_REDIRECT = 'https://oneshetland.com/reset-password';

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const { next } = useLocalSearchParams<{ next?: string }>();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSend() {
    setError(null);
    if (!isSupabaseConfigured) { setError('Supabase is not configured. Check your .env file.'); return; }
    if (!email.trim()) { setError('Please enter your email address.'); return; }
    setLoading(true);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      email.trim().toLowerCase(),
      { redirectTo: RESET_REDIRECT },
    );
    setLoading(false);
    // Always show success even if the email isn't registered, so we don't reveal
    // which addresses have accounts.
    if (resetError && !/rate limit/i.test(resetError.message)) {
      setError(resetError.message);
      return;
    }
    setSent(true);
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardDoneBar />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.hero}>
            <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
              <Text style={styles.backText}>‹ Back</Text>
            </TouchableOpacity>
            <View style={styles.heroContent}>
              <Image source={require('../../assets/icon.png')} style={styles.logo} resizeMode="contain" />
              <Text style={styles.heroTitle}>OneShetland</Text>
            </View>
          </View>

          <View style={styles.card}>
            {sent ? (
              <>
                <Text style={styles.cardTitle}>Check your email</Text>
                <Text style={styles.cardSubtitle}>
                  If an account exists for {email.trim().toLowerCase()}, we&apos;ve sent a link to reset your password. Open it on this device to set a new one, then come back and sign in.
                </Text>
                <Button label="Back to sign in" onPress={() => router.replace({ pathname: '/(auth)/sign-in', params: next ? { next } : {} })} fullWidth size="lg" style={styles.submitBtn} />
              </>
            ) : (
              <>
                <Text style={styles.cardTitle}>Reset your password</Text>
                <Text style={styles.cardSubtitle}>Enter your email and we&apos;ll send you a link to set a new password.</Text>

                {error && (
                  <View style={styles.errorBox}>
                    <Text style={styles.errorIcon}>⚠️</Text>
                    <Text style={styles.errorText}>{error}</Text>
                  </View>
                )}

                <Input
                  label="Email address"
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@example.com"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="email"
                  returnKeyType="done"
                  onSubmitEditing={handleSend}
                />

                <Button label="Send reset link" onPress={handleSend} loading={loading} fullWidth size="lg" style={styles.submitBtn} />
              </>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  flex: { flex: 1 },
  scroll: { flexGrow: 1 },
  hero: { backgroundColor: colors.navy, paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xxxl },
  backBtn: { marginBottom: spacing.lg },
  backText: { color: 'rgba(255,255,255,0.6)', fontSize: fontSize.sm },
  heroContent: { alignItems: 'center', paddingTop: spacing.md },
  logo: { width: 72, height: 72, borderRadius: 18, marginBottom: spacing.md },
  heroTitle: { color: colors.white, fontSize: fontSize.xxxl, fontWeight: '800', letterSpacing: -0.5 },
  card: {
    backgroundColor: colors.white, borderTopLeftRadius: radius.xxl, borderTopRightRadius: radius.xxl,
    marginTop: -radius.xxl, padding: spacing.lg, paddingTop: spacing.xl, flex: 1,
  },
  cardTitle: { fontSize: fontSize.xxl, fontWeight: '800', color: colors.navy, marginBottom: spacing.xs },
  cardSubtitle: { fontSize: fontSize.sm, color: colors.textMuted, marginBottom: spacing.lg, lineHeight: 20 },
  errorBox: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: colors.errorLight, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md, gap: spacing.sm },
  errorIcon: { fontSize: 14, marginTop: 1 },
  errorText: { flex: 1, color: colors.error, fontSize: fontSize.sm, lineHeight: 20 },
  submitBtn: { marginTop: spacing.md },
});
