import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { FontAwesome5 } from '@expo/vector-icons';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/Button';
import { colors, fontSize, spacing, radius } from '@/constants/theme';

type ConnectStatus = 'idle' | 'loading' | 'complete' | 'error' | 'pending';

function SuccessScreen({ onContinue }: { onContinue: () => void }) {
  const scale = useRef(new Animated.Value(0)).current;
  const fade  = useRef(new Animated.Value(0)).current;
  const slideY = useRef(new Animated.Value(24)).current;

  useEffect(() => {
    // Haptic success burst
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    // Bouncy check icon entrance
    Animated.spring(scale, {
      toValue: 1,
      friction: 4,
      tension: 80,
      useNativeDriver: true,
    }).start();

    // Fade + slide content in slightly after
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 400, delay: 200, useNativeDriver: true }),
      Animated.timing(slideY, { toValue: 0, duration: 400, delay: 200, useNativeDriver: true }),
    ]).start();
  }, []);

  return (
    <SafeAreaView style={successStyles.safe} edges={['top', 'bottom']}>
      {/* Navy header band */}
      <View style={successStyles.header}>
        <Animated.View style={[successStyles.iconWrap, { transform: [{ scale }] }]}>
          <FontAwesome5 name="check" size={34} color={colors.white} />
        </Animated.View>
      </View>

      {/* Body */}
      <Animated.View style={[successStyles.body, { opacity: fade, transform: [{ translateY: slideY }] }]}>
        <Text style={successStyles.title}>Bank account{'\n'}connected 🎉</Text>
        <Text style={successStyles.subtitle}>
          You're all set to receive payouts. Every time you complete a delivery,
          your earnings land in your bank within 2 working days.
        </Text>

        <View style={successStyles.card}>
          {[
            { icon: 'pound-sign', text: 'You keep 100% — no platform fee during the community launch' },
            { icon: 'clock',      text: 'Payouts within 2 working days of each delivery' },
            { icon: 'shield-alt', text: 'Payments handled securely by Stripe' },
          ].map((row, i) => (
            <View key={i} style={successStyles.row}>
              <View style={successStyles.rowIcon}>
                <FontAwesome5 name={row.icon as any} size={13} color={colors.navy} />
              </View>
              <Text style={successStyles.rowText}>{row.text}</Text>
            </View>
          ))}
        </View>

        <Button
          label="Go to dashboard"
          onPress={onContinue}
          variant="primary"
          size="lg"
          fullWidth
          style={{ marginTop: spacing.xl }}
        />
      </Animated.View>
    </SafeAreaView>
  );
}

const successStyles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  header: {
    backgroundColor: colors.navy,
    alignItems: 'center',
    paddingTop: spacing.xxl,
    paddingBottom: spacing.xxl + 20,
  },
  iconWrap: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: '#2E8B57',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 6,
  },
  body: {
    flex: 1,
    padding: spacing.xl,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: colors.navy,
    marginBottom: spacing.md,
    lineHeight: 34,
  },
  subtitle: {
    fontSize: fontSize.md,
    color: colors.textMuted,
    lineHeight: 24,
    marginBottom: spacing.xl,
  },
  card: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  rowIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#EEF4FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: { flex: 1, fontSize: fontSize.sm, color: colors.textMuted, lineHeight: 20 },
});

export default function ConnectBankScreen() {
  const router = useRouter();
  const { profile } = useAuth();

  const [status, setStatus] = useState<ConnectStatus>('idle');
  const [alreadyComplete, setAlreadyComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkedOnce, setCheckedOnce] = useState(false);

  // Check status on mount — read from profiles (source of truth).
  // driver_profiles is kept in sync for backward compat with driver dashboards.
  useEffect(() => {
    async function checkStatus() {
      if (!profile?.id) return;
      const { data } = await supabase
        .from('profiles')
        .select('stripe_account_id, stripe_onboarding_complete, stripe_payouts_enabled')
        .eq('id', profile.id)
        .single();

      if (data?.stripe_onboarding_complete && data?.stripe_payouts_enabled) {
        setAlreadyComplete(true);
      } else if (data?.stripe_account_id && !data?.stripe_onboarding_complete) {
        setStatus('pending');
      }
    }
    checkStatus();
  }, [profile?.id]);

  async function handleConnect() {
    setError(null);
    setStatus('loading');

    try {
      // Use supabase.functions.invoke so the client handles token refresh automatically.
      // Raw fetch with session?.access_token can fail if the token has been refreshed
      // since the component mounted, returning a stale/undefined value.
      const { data, error: fnError } = await supabase.functions.invoke(
        'create-connect-account',
      );
      if (fnError) {
        // supabase.functions.invoke wraps non-2xx responses as a FunctionsHttpError whose
        // .context property is the raw Response — extract the actual message from the body.
        let message = 'Could not start bank setup. Please try again.';
        try {
          const body = await (fnError as any).context?.json?.();
          if (body?.error) message = body.error;
        } catch {}
        throw new Error(message);
      }

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

      // Always check status when browser closes — onboarding may have completed
      // even if the deep link redirect didn't fire perfectly
      await refreshConnectStatus();

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setStatus('error');
    }
  }

  async function refreshConnectStatus() {
    if (!profile?.id) return;
    setChecking(true);

    // profiles is the source of truth; webhook now writes here + driver_profiles
    const { data } = await supabase
      .from('profiles')
      .select('stripe_onboarding_complete, stripe_payouts_enabled')
      .eq('id', profile.id)
      .single();

    setChecking(false);
    setCheckedOnce(true);

    if (data?.stripe_onboarding_complete) {
      setAlreadyComplete(true);
      setStatus('complete');
    } else {
      setStatus('pending');
    }
  }

  if (alreadyComplete || status === 'complete') {
    return <SuccessScreen onContinue={() => router.replace('/(driver)/dashboard')} />;
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

        {/* Error banner — only for actual failures */}
        {status === 'error' && error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* Pending banner — shown after returning from Stripe before webhook confirms */}
        {status === 'pending' && (
          <View style={styles.pendingBox}>
            <FontAwesome5 name="clock" size={15} color="#92610A" style={{ marginTop: 1 }} />
            <View style={{ flex: 1 }}>
              <Text style={styles.pendingTitle}>Verification in progress</Text>
              <Text style={styles.pendingText}>
                Stripe is reviewing your details — this usually takes a few minutes.
                You'll be able to receive payouts once it's confirmed.
              </Text>
              {checkedOnce && (
                <Text style={[styles.pendingText, { marginTop: 6, fontStyle: 'italic' }]}>
                  Not verified yet — check again in a minute.
                </Text>
              )}
            </View>
          </View>
        )}

        {/* What to expect — hide once pending */}
        {status !== 'pending' && (
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
        )}

        {/* Website tip — only before starting */}
        {status !== 'pending' && (
          <View style={styles.tipBox}>
            <FontAwesome5 name="info-circle" size={13} color={colors.navy} style={{ marginTop: 2 }} />
            <Text style={styles.tipText}>
              If Stripe asks for a business website, tap{' '}
              <Text style={styles.tipBold}>"Don't have a website?"</Text>
              {' '}and continue — you don't need one.
            </Text>
          </View>
        )}

        {/* Stripe trust badge */}
        <View style={styles.stripeBadge}>
          <FontAwesome5 name="lock" size={12} color="#635BFF" />
          <Text style={styles.stripeText}>
            Powered by Stripe — your bank details are never shared with OneShetland
          </Text>
        </View>

        {status === 'pending' ? (
          <>
            <Button
              label={checking ? 'Checking…' : 'Check verification status'}
              onPress={refreshConnectStatus}
              loading={checking}
              variant="secondary"
              fullWidth
              size="lg"
            />
            <TouchableOpacity
              onPress={handleConnect}
              style={styles.reopenLink}
            >
              <Text style={styles.reopenLinkText}>Didn't finish? Re-open Stripe setup →</Text>
            </TouchableOpacity>
          </>
        ) : (
          <Button
            label={status === 'loading' ? 'Opening Stripe…' : 'Connect bank account'}
            onPress={handleConnect}
            loading={status === 'loading'}
            fullWidth
            size="lg"
          />
        )}

        <Text style={styles.legalNote}>
          OneShetland takes no platform fee during the current community launch period.
          You receive the full delivery fee for every completed run.
        </Text>

      </View>

    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },

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

  pendingBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    backgroundColor: '#FFF8ED',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#F5C96A',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  pendingTitle: { fontSize: fontSize.sm, fontWeight: '700', color: '#92610A', marginBottom: 4 },
  pendingText: { fontSize: fontSize.sm, color: '#92610A', lineHeight: 19 },

  tipBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: '#EEF4FF',
    borderRadius: radius.md,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
  },
  tipText: { flex: 1, fontSize: fontSize.sm, color: colors.textMuted, lineHeight: 19 },
  tipBold: { fontWeight: '700', color: colors.navy },

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

  reopenLink: { alignItems: 'center', paddingVertical: spacing.sm },
  reopenLinkText: { fontSize: fontSize.sm, color: colors.navy, textDecorationLine: 'underline' },

  legalNote: {
    fontSize: fontSize.xs,
    color: colors.textLight,
    textAlign: 'center',
    lineHeight: 18,
  },

});
