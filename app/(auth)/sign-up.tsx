import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/Button';
import { Input, KeyboardDoneBar } from '@/components/ui/Input';
import { FormScrollView } from '@/components/ui/FormScrollView';
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
      setError(
        'Supabase is not configured. Add your EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to your .env file.',
      );
      return;
    }

    if (!fullName.trim()) {
      setError('Please enter your full name.');
      return;
    }
    if (!email.trim()) {
      setError('Please enter your email address.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

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

  if (success) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.successContainer}>
          <Text style={styles.successEmoji}>✅</Text>
          <Text style={styles.successTitle}>Check your email</Text>
          <Text style={styles.successBody}>
            We've sent a confirmation link to {email}. Click it to activate your account, then
            sign in.
          </Text>
          <Button
            label="Go to sign in"
            onPress={() => router.replace('/(auth)/sign-in')}
            variant="primary"
            size="lg"
            fullWidth
            style={{ marginTop: spacing.lg }}
          />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardDoneBar />
      <FormScrollView contentContainerStyle={styles.content}>
          <View style={styles.header}>
            <TouchableOpacity onPress={() => router.back()} style={styles.backLink}>
              <Text style={styles.backLinkText}>← Back</Text>
            </TouchableOpacity>
            <View style={styles.logoCircle}>
              <Image
                source={require('../../assets/icon.png')}
                style={styles.logoImage}
                resizeMode="contain"
              />
            </View>
            <Text style={styles.title}>Create your OneShetland account</Text>
            <Text style={styles.subtitle}>
              One account for all of OneShetland — Delivers, events, jobs, and more.
              Already have an account? Just sign in.
            </Text>
          </View>

          <View style={styles.form}>
            {error && (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

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
              label="Phone number (optional)"
              value={phone}
              onChangeText={setPhone}
              placeholder="+44 7700 000000"
              keyboardType="phone-pad"
              autoComplete="tel"
              returnKeyType="next"
              hint="Used to contact you about your deliveries"
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

            <Button
              label="Create account"
              onPress={handleSignUp}
              loading={loading}
              fullWidth
              size="lg"
              style={styles.submitButton}
            />

            <TouchableOpacity
              onPress={() => router.push('/(auth)/sign-in')}
              style={styles.switchLink}
            >
              <Text style={styles.switchText}>
                Already a member?{' '}
                <Text style={styles.switchTextBold}>Sign in</Text>
              </Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.legalNote}>
            By creating an account you agree to our terms of service. You must be 18 or over.
            OneShetland Fetch is for goods only — no alcohol, tobacco, vapes, cash, or
            passengers.
          </Text>
      </FormScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  content: {
    flexGrow: 1,
    backgroundColor: colors.screenBackground,
    paddingBottom: spacing.xxl,
  },
  header: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
  },
  backLink: { marginBottom: spacing.md },
  backLinkText: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.sm },
  logoCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 4,
    marginBottom: spacing.md,
  },
  logoImage: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  title: {
    color: colors.white,
    fontSize: fontSize.xxl,
    fontWeight: '800',
    marginBottom: spacing.sm,
  },
  subtitle: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  form: { padding: spacing.lg },
  errorBox: {
    backgroundColor: colors.errorLight,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  errorText: { color: colors.error, fontSize: fontSize.sm, lineHeight: 20 },
  submitButton: { marginTop: spacing.sm },
  switchLink: { alignItems: 'center', marginTop: spacing.lg },
  switchText: { color: colors.textMuted, fontSize: fontSize.sm },
  switchTextBold: { color: colors.navy, fontWeight: '600' },
  legalNote: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    fontSize: fontSize.xs,
    color: colors.textLight,
    textAlign: 'center',
    lineHeight: 18,
  },
  successContainer: {
    flex: 1,
    backgroundColor: colors.screenBackground,
    padding: spacing.xl,
    justifyContent: 'center',
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
    lineHeight: 24,
  },
});
