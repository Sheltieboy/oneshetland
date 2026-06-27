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
import { useRouter, useLocalSearchParams } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { logCompliance } from '@/lib/compliance';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/Button';
import { Input, KeyboardDoneBar } from '@/components/ui/Input';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';

export default function SignUpScreen() {
  const router = useRouter();
  const { next } = useLocalSearchParams<{ next?: string }>();
  const signInTarget = { pathname: '/(auth)/sign-in' as const, params: next ? { next } : {} };
  const { signUp } = useAuth();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [marketingOptIn, setMarketingOptIn] = useState(false); // GDPR: unticked by default
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendMsg, setResendMsg] = useState<string | null>(null);

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
      marketingOptIn,
      next,
    );
    setLoading(false);

    if (authError) {
      setError(authError);
    } else {
      // Log compliance events — fire and forget, non-blocking. (Marketing
      // consent is also stored in the sign-up metadata so it survives email
      // confirmation even if there's no session yet to write the log.)
      logCompliance({ eventType: 'terms.accepted',   documentVersion: '1.0', description: 'Accepted OneShetland Terms of Service at sign-up', metadata: { screen: 'sign-up' } });
      logCompliance({ eventType: 'privacy.accepted', documentVersion: '1.0', description: 'Accepted OneShetland Privacy Policy at sign-up',   metadata: { screen: 'sign-up' } });
      logCompliance({ eventType: 'age.confirmed',                             description: 'Confirmed 18 or over at account creation',         metadata: { screen: 'sign-up' } });
      logCompliance({
        eventType:   marketingOptIn ? 'marketing.opted_in' : 'marketing.opted_out',
        description: marketingOptIn ? 'Opted in to marketing emails at sign-up' : 'Did not opt in to marketing emails at sign-up',
        metadata:    { screen: 'sign-up' },
      });
      setSuccess(true);
    }
  }

  // Resend the confirmation email to the address the user just signed up with.
  // Guarded against double-taps with a short sending state and a 30s cooldown.
  async function handleResend() {
    if (resending) return;
    setResendMsg(null);

    if (!isSupabaseConfigured) {
      setResendMsg('Supabase is not configured. Check your .env file.');
      return;
    }

    setResending(true);
    const { error: resendError } = await supabase.auth.resend({
      type: 'signup',
      email: email.trim().toLowerCase(),
      options: {
        emailRedirectTo: next
          ? `oneshetland-fetch://auth/confirm?next=${encodeURIComponent(next)}`
          : 'oneshetland-fetch://auth/confirm',
      },
    });

    if (resendError) {
      setResendMsg(resendError.message || "Couldn't resend just now — please try again shortly.");
      setResending(false);
    } else {
      setResendMsg('Sent — check your inbox again.');
      // Keep the button disabled briefly so people don't fire off a burst.
      setTimeout(() => setResending(false), 30000);
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
            onPress={() => router.replace(signInTarget)}
            variant="primary"
            size="lg"
            fullWidth
            style={styles.successBtn}
          />

          <Text style={styles.resendPrompt}>Didn't get the email?</Text>

          <Button
            label={resending ? 'Sent — check your inbox' : 'Resend confirmation email'}
            onPress={handleResend}
            variant="secondary"
            size="lg"
            fullWidth
            loading={resending && !resendMsg}
            disabled={resending}
            style={styles.resendBtn}
          />

          {resendMsg && <Text style={styles.resendMsg}>{resendMsg}</Text>}

          <TouchableOpacity
            onPress={() => setSuccess(false)}
            style={styles.resendLink}
          >
            <Text style={styles.resendText}>Wrong email address? Go back</Text>
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
              <Text style={styles.backText}>‹ Back</Text>
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

            {/* GDPR marketing opt-in — explicit, unticked by default */}
            <TouchableOpacity
              style={styles.optInRow}
              onPress={() => setMarketingOptIn(v => !v)}
              activeOpacity={0.7}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: marketingOptIn }}
            >
              <View style={[styles.checkbox, marketingOptIn && styles.checkboxOn]}>
                {marketingOptIn && <FontAwesome5 name="check" size={11} color="#fff" solid />}
              </View>
              <Text style={styles.optInText}>
                Email me occasional OneShetland news, offers and updates.{' '}
                <Text style={styles.optInOptional}>Optional — change it any time in settings.</Text>
              </Text>
            </TouchableOpacity>

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
              onPress={() => router.push(signInTarget)}
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

  // Marketing opt-in checkbox
  optInRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: spacing.sm },
  checkbox: {
    width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center', marginTop: 1,
  },
  checkboxOn: { backgroundColor: colors.navy, borderColor: colors.navy },
  optInText: { flex: 1, fontSize: fontSize.sm, color: colors.textMuted, lineHeight: 19 },
  optInOptional: { color: colors.textLight },

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
  resendPrompt: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  resendBtn: { width: '100%' },
  resendMsg: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.md,
  },
  resendLink: { marginTop: spacing.lg },
  resendText: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    textDecorationLine: 'underline',
  },
});
