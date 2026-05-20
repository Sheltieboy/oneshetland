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
      setError(
        'Supabase is not configured. Add your EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to your .env file. See README.md.',
      );
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
      // Common Supabase errors made readable
      if (authError.includes('Invalid login credentials')) {
        setError('Email address or password is incorrect. Please try again.');
      } else if (authError.includes('Email not confirmed')) {
        setError('Please confirm your email address first. Check your inbox for a verification link, or turn off email confirmation in your Supabase dashboard while building.');
      } else {
        setError(authError);
      }
    }
    // On success, _layout.tsx handles the redirect to the correct dashboard
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardDoneBar />
      <FormScrollView contentContainerStyle={styles.content}>
          {/* Header */}
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
            <Text style={styles.title}>Sign in to OneShetland</Text>
            <Text style={styles.subtitle}>
              Use your OneShetland account to access Fetch and all other OneShetland services.
            </Text>
          </View>

          {/* Form */}
          <View style={styles.form}>
            {error && (
              <View style={styles.errorBox}>
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

            <Button
              label="Sign in"
              onPress={handleSignIn}
              loading={loading}
              fullWidth
              size="lg"
              style={styles.submitButton}
            />

            <TouchableOpacity
              onPress={() => router.push('/(auth)/sign-up')}
              style={styles.switchLink}
            >
              <Text style={styles.switchText}>
                Not yet a member?{' '}
                <Text style={styles.switchTextBold}>Create an account</Text>
              </Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.legalNote}>
            OneShetland Fetch is a community platform. Members must be 18 or over.
            Goods only — no alcohol, tobacco, vapes, cash, or passengers.
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
  backLink: {
    marginBottom: spacing.md,
  },
  backLinkText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: fontSize.sm,
  },
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
  form: {
    padding: spacing.lg,
  },
  errorBox: {
    backgroundColor: colors.errorLight,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  errorText: {
    color: colors.error,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  submitButton: {
    marginTop: spacing.sm,
  },
  switchLink: {
    alignItems: 'center',
    marginTop: spacing.lg,
  },
  switchText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  },
  switchTextBold: {
    color: colors.navy,
    fontWeight: '600',
  },
  legalNote: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    fontSize: fontSize.xs,
    color: colors.textLight,
    textAlign: 'center',
    lineHeight: 18,
  },
});
