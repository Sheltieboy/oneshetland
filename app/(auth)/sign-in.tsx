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

export default function SignInScreen() {
  const router = useRouter();
  const { signIn } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn() {
    setError(null);

    if (!isSupabaseConfigured) {
      setError('Supabase is not configured. Check your .env file.');
      return;
    }
    if (!email.trim() || !password) {
      setError('Please enter your email address and password.');
      return;
    }

    setLoading(true);
    const { error: authError } = await signIn(email.trim().toLowerCase(), password);
    setLoading(false);

    if (authError) {
      if (authError.includes('Invalid login credentials')) {
        setError('Email address or password is incorrect. Please try again.');
      } else if (authError.includes('Email not confirmed')) {
        setError('Please confirm your email address first. Check your inbox for a verification link.');
      } else {
        setError(authError);
      }
    }
  }

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
              <Text style={styles.heroTitle}>OneShetland</Text>
              <Text style={styles.heroTagline}>
                Your community. One account.
              </Text>
            </View>
          </View>

          {/* ── Form card ── */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Welcome back</Text>
            <Text style={styles.cardSubtitle}>Sign in to your OneShetland account</Text>

            {error && (
              <View style={styles.errorBox}>
                <Text style={styles.errorIcon}>⚠️</Text>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            <View style={styles.fields}>
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
                label="Password"
                value={password}
                onChangeText={setPassword}
                placeholder="Your password"
                secureTextEntry
                autoComplete="password"
                returnKeyType="done"
                onSubmitEditing={handleSignIn}
              />
            </View>

            <Button
              label="Sign in"
              onPress={handleSignIn}
              loading={loading}
              fullWidth
              size="lg"
              style={styles.submitBtn}
            />

            <View style={styles.divider}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>New to OneShetland?</Text>
              <View style={styles.dividerLine} />
            </View>

            <TouchableOpacity
              style={styles.secondaryBtn}
              onPress={() => router.push('/(auth)/sign-up')}
            >
              <Text style={styles.secondaryBtnText}>Create a free account</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.legal}>
            Members must be 18 or over. Fetch is for goods only — no alcohol, tobacco, vapes, cash, or passengers.
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
  heroContent: { alignItems: 'center', paddingTop: spacing.md },
  logo: {
    width: 72,
    height: 72,
    borderRadius: 18,
    marginBottom: spacing.md,
  },
  heroTitle: {
    color: colors.white,
    fontSize: fontSize.xxxl,
    fontWeight: '800',
    marginBottom: spacing.xs,
    letterSpacing: -0.5,
  },
  heroTagline: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: fontSize.md,
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

  // Fields
  fields: { gap: spacing.xs, marginBottom: spacing.sm },

  submitBtn: { marginTop: spacing.md },

  // Divider
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginVertical: spacing.lg,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { fontSize: fontSize.xs, color: colors.textLight, fontWeight: '500' },

  // Secondary button
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
    paddingTop: 0,
    paddingBottom: spacing.xl,
    fontSize: fontSize.xs,
    color: colors.textLight,
    textAlign: 'center',
    lineHeight: 18,
  },
});
