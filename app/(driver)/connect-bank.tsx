import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { FontAwesome5 } from '@expo/vector-icons';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/Button';
import { colors, fontSize, spacing, radius } from '@/constants/theme';

type ConnectStatus = 'idle' | 'loading' | 'complete' | 'error';

export default function ConnectBankScreen() {
  const router = useRouter();
  const { session, profile } = useAuth();

  const [status, setStatus] = useState<ConnectStatus>('idle');
  const [alreadyComplete, setAlreadyComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check if onboarding is already done when screen mounts
  useEffect(() => {
    async function checkStatus() {
      if (!profile?.id) return;
      const { data } = await supabase
        .from('driver_profiles')
        .select('stripe_onboarding_complete, stripe_payouts_enabled')
        .eq('id', profile.id)
        .single();

      if (data?.stripe_onboarding_complete && data?.stripe_payouts_enabled) {
        setAlreadyComplete(true);
      }
    }
    checkStatus();
  }, [profile?.id]);

  async function handleConnect() {
    setError(null);
    setStatus('loading');

    try {
      // Use fetch directly so we can read the error body on non-2xx responses
      const res = await fetch(
        'https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/create-connect-account',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session?.access_token}`,
          },
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);

      if (data.already_complete) {
        setAlreadyComplete(true);
        setStatus('complete');
        return;
      }

      if (!data.url) throw new Error('No onboarding URL returned.');

      // Open Stripe's hosted onboarding inside an in-app browser
      const result = await WebBrowser.openAuthSessionAsync(
        data.url,
        'oneshetland-fetch://driver/connect-return',
      );

      if (result.type === 'success') {
        // Stripe redirected back — check if onboarding completed
        await refreshConnectStatus();
      } else {
        // User closed the browser without finishing
        setStatus('idle');
      }

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setStatus('error');
    }
  }

  async function refreshConnectStatus() {
    if (!profile?.id) return;
    setStatus('loading');

    const { data } = await supabase
      .from('driver_profiles')
      .select('stripe_onboarding_complete, stripe_payouts_enabled')
      .eq('id', profile.id)
      .single();

    if (data?.stripe_onboarding_complete) {
      setAlreadyComplete(true);
      setStatus('complete');
    } else {
      // Stripe onboarding may still be processing — webhook will update when ready
      setStatus('idle');
      setError(
        'Your details are being verified by Stripe. This usually takes a few minutes. ' +
        'You\'ll be able to receive payouts once verification is complete.',
      );
    }
  }

  if (alreadyComplete || status === 'complete') {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.successContainer}>
          <View style={styles.successIcon}>
            <FontAwesome5 name="check" size={32} color={colors.white} />
          </View>
          <Text style={styles.successTitle}>Bank account connected</Text>
          <Text style={styles.successBody}>
            You're all set to receive payouts. Payments will land in your bank account
            within 2 working days of each completed delivery.
          </Text>
          <Button
            label="Back to dashboard"
            onPress={() => router.replace('/(driver)/dashboard')}
            variant="primary"
            size="lg"
            fullWidth
            style={{ marginTop: spacing.xl }}
          />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>

      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backRow}>
          <Text style={styles.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Connect your bank account</Text>
        <Text style={styles.subtitle}>
          Set up payouts so you get paid directly when you complete a delivery.
        </Text>
      </View>

      <View style={styles.body}>

        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* What to expect */}
        <View style={styles.stepsCard}>
          <Text style={styles.stepsTitle}>What happens next</Text>
          {[
            { icon: 'id-card',      text: 'Verify your identity with Stripe (takes ~5 mins)' },
            { icon: 'university',   text: 'Enter your UK bank account details' },
            { icon: 'check-circle', text: 'Payouts land within 2 working days of each delivery' },
          ].map((step, i) => (
            <View key={i} style={styles.stepRow}>
              <View style={styles.stepIconWrap}>
                <FontAwesome5 name={step.icon as any} size={15} color={colors.navy} />
              </View>
              <Text style={styles.stepText}>{step.text}</Text>
            </View>
          ))}
        </View>

        {/* Stripe trust badge */}
        <View style={styles.stripeBadge}>
          <FontAwesome5 name="lock" size={12} color="#635BFF" />
          <Text style={styles.stripeText}>
            Powered by Stripe — your bank details are never shared with OneShetland
          </Text>
        </View>

        <Button
          label={status === 'loading' ? 'Opening Stripe…' : 'Connect bank account'}
          onPress={handleConnect}
          loading={status === 'loading'}
          fullWidth
          size="lg"
        />

        <Text style={styles.legalNote}>
          OneShetland takes no platform fee during the current community launch period.
          You receive the full delivery fee for every completed run.
        </Text>

      </View>

    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },

  header: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
  },
  backRow: { marginBottom: spacing.md },
  backText: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.sm, fontWeight: '500' },
  title: { color: colors.white, fontSize: fontSize.xxl, fontWeight: '800', marginBottom: spacing.sm },
  subtitle: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.sm, lineHeight: 20 },

  body: { flex: 1, padding: spacing.lg, gap: spacing.lg },

  errorBox: {
    backgroundColor: colors.errorLight,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  errorText: { color: colors.error, fontSize: fontSize.sm, lineHeight: 20 },

  stepsCard: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  stepsTitle: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.navy,
    marginBottom: 4,
  },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  stepIconWrap: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#EEF4FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepText: { flex: 1, fontSize: fontSize.sm, color: colors.textMuted, lineHeight: 20 },

  stripeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: '#F3F2FF',
    borderRadius: radius.md,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
  },
  stripeText: { flex: 1, fontSize: fontSize.sm, color: '#4B44CC', lineHeight: 18 },

  legalNote: {
    fontSize: fontSize.xs,
    color: colors.textLight,
    textAlign: 'center',
    lineHeight: 18,
  },

  successContainer: {
    flex: 1,
    padding: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  successIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#2E8B57',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
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
