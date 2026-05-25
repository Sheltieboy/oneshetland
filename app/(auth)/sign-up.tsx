import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/Button';
import { Input, KeyboardDoneBar } from '@/components/ui/Input';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { isSupabaseConfigured } from '@/lib/supabase';

export default function SignUpScreen() {
  const router = useRouter();
  const { signUp } = useAuth();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSignUp() {
    setError(null);

    if (!isSupabaseConfigured) {
      setError('Supabase is not configured. Check your .env file.');
      return;
    }
    if (!fullName.trim()) { setError('Please enter your full name.'); return; }
    if (!email.trim()) { setError('Please enter your email address.'); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (password !== confirmPassword) { setError('Passwords do not match.'); return; }

    setLoading(true);
    const { error: authError } = await signUp(
      email.trim().toLowerCase(),
      password,
      fullName.trim(),
      phone.trim() || undefined,
    );
    setLoading(false);

    if (authError) {
      setError(authError);
    } else {
      setSuccess(true);
    }
  }

  // ── Success state ──────────────────────────────────────────────────────────

  if (success) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.successHero}>
          <Image
            source={require('../../assets/icon.png')}
            style={styles.successLogo}
            resizeMode="contain"
          />
        </View>
        <View style={styles.successCard}>
          <Text style={styles.successEmoji}>📬</Text>
          <Text style={styles.successTitle}>Check your inbox</Text>
          <Text style={styles.successBody}>
            We've sent a confirmation link to{'\n'}
            <Text style={styles.successEmail}>{email}</Text>
            {'\n\n'}
            Click the link to activate your account, then come back and sign in.
          </Text>
          <Button
            label="Go to sign in"
            onPress={() => router.replace('/(auth)/sign-in')}
            variant="primary"
            size="lg"
            fullWidth
            style={styles.successBtn}
          />
          <TouchableOpacity
            onPress={() => setSuccess(false)}
            style={styles.resendLink}
          >
            <Text style={styles.resendText}>Didn't get it? Try again</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ── Form ──────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardDoneBar />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* ── Hero ── */}
          <View style={styles.hero}>
            <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
              <Text style={styles.backText}>← Back</Text>
            </TouchableOpacity>
            <View style={styles.heroContent}>
              <Image
                source={require('../../assets/icon.png')}
                style={styles.logo}
                resizeMode="contain"
              />
              <Text style={styles.heroTitle}>Join OneShetland</Text>
              <Text style={styles.heroTagline}>One account. Your whole community.</Text>
            </View>
          </View>

          {/* ── Form card ── */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Create your account</Text>
            <Text style={styles.cardSubtitle}>Free to join — takes less than a minute</Text>

            {error && (
              <View style={styles.errorBox}>
                <Text style={styles.errorIcon}>⚠️</Text>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            <View style={styles.fields}>
              <Input
                label="Full name"
                value={fullName}
                onChangeText={setFullName}
                placeholder="Your full name"
                autoCapitalize="words"
                autoComplete="name"
                returnKeyType="next"
              />

              <Input
                label="Email address"
                value={email}
                onChangeText={setEmail}
                placeholder="you@example.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                returnKeyType="next"
              />

              <Input
                label="Phone number"
                value={phone}
                onChangeText={setPhone}
                placeholder="+44 7700 000000"
                keyboardType="phone-pad"
                autoComplete="tel"
                returnKeyType="next"
                hint="Optional — used to contact you about deliveries"
              />

              <Input
                label="Password"
                value={password}
                onChangeText={setPassword}
                placeholder="At least 8 characters"
                secureTextEntry
                autoComplete="new-password"
                returnKeyType="next"
                hint="Minimum 8 characters"
              />

              <Input
                label="Confirm password"
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                placeholder="Repeat your password"
                secureTextEntry
                returnKeyType="done"
                onSubmitEditing={handleSignUp}
              />
            </View>

            <Button
              label="Create account"
              onPress={handleSignUp}
              loading={loading}
              fullWidth
              size="lg"
              style={styles.submitBtn}
            />

            <View style={styles.divider}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>Already a member?</Text>
              <View style={styles.dividerLine} />
            </View>

            <TouchableOpacity
              style={styles.secondaryBtn}
              onPress={() => router.push('/(auth)/sign-in')}
            >
              <Text style={styles.secondaryBtnText}>Sign in instead</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.legal}>
            By creating an account you agree to our terms of service. You must be 18 or over.
            Fetch is for goods only — no alcohol, tobacco, vapes, cash, or passengers.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  flex: { flex: 1 },
  scroll: { flexGrow: 1 },

  // Hero
  hero: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxxl,
  },
  backBtn: { marginBottom: spacing.lg },
  backText: { color: 'rgba(255,255,255,0.6)', fontSize: fontSize.sm },
  heroContent: { alignItems: 'center', paddingTop: spacing.sm },
  logo: {
    width: 64,
    height: 64,
    borderRadius: 16,
    marginBottom: spacing.md,
  },
  heroTitle: {
    color: colors.white,
    fontSize: fontSize.xxl,
    fontWeight: '800',
    marginBottom: spacing.xs,
    letterSpacing: -0.5,
  },
  heroTagline: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: fontSize.sm,
    fontWeight: '500',
  },

  // Card
  card: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    marginTop: -radius.xxl,
    padding: spacing.lg,
    paddingTop: spacing.xl,
    flex: 1,
  },
  cardTitle: {
    fontSize: fontSize.xxl,
    fontWeight: '800',
    color: colors.navy,
    marginBottom: spacing.xs,
  },
  cardSubtitle: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },

  // Error
  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: colors.errorLight,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  errorIcon: { fontSize: 14, marginTop: 1 },
  errorText: { flex: 1, color: colors.error, fontSize: fontSize.sm, lineHeight: 20 },

  fields: { gap: spacing.xs, marginBottom: spacing.sm },
  submitBtn: { marginTop: spacing.md },

  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginVertical: spacing.lg,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { fontSize: fontSize.xs, color: colors.textLight, fontWeight: '500' },

  secondaryBtn: {
    borderWidth: 1.5,
    borderColor: colors.navy,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  secondaryBtnText: {
    color: colors.navy,
    fontSize: fontSize.md,
    fontWeight: '700',
  },

  legal: {
    backgroundColor: colors.white,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl,
    fontSize: fontSize.xs,
    color: colors.textLight,
    textAlign: 'center',
    lineHeight: 18,
  },

  // Success state
  successHero: {
    backgroundColor: colors.navy,
    alignItems: 'center',
    paddingTop: spacing.xxl,
    paddingBottom: spacing.xxxl,
  },
  successLogo: {
    width: 72,
    height: 72,
    borderRadius: 18,
  },
  successCard: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    marginTop: -radius.xxl,
    padding: spacing.lg,
    paddingTop: spacing.xl,
    flex: 1,
    alignItems: 'center',
  },
  successEmoji: { fontSize: 48, marginBottom: spacing.md },
  successTitle: {
    fontSize: fontSize.xxl,
    fontWeight: '800',
    color: colors.navy,
    marginBottom: spacing.md,
    textAlign: 'center',
  },
  successBody: {
    fontSize: fontSize.md,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 26,
    marginBottom: spacing.lg,
  },
  successEmail: {
    color: colors.navy,
    fontWeight: '700',
  },
  successBtn: { width: '100%' },
  resendLink: { marginTop: spacing.lg },
  resendText: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    textDecorationLine: 'underline',
  },
});
