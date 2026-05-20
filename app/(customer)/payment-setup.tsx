import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useStripe } from '@stripe/stripe-react-native';
import { FontAwesome5, FontAwesome6 } from '@expo/vector-icons';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/Button';
import { colors, fontSize, spacing, radius } from '@/constants/theme';

export default function PaymentSetupScreen() {
  const router = useRouter();
  const { profile, refreshProfile, session } = useAuth();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSetUpPayment = useCallback(async () => {
    setError(null);
    setLoading(true);

    try {
      const { data, error: fnError } = await supabase.functions.invoke(
        'create-setup-intent',
        { headers: { Authorization: `Bearer ${session?.access_token}` } },
      );

      if (fnError || !data?.client_secret) {
        throw new Error(fnError?.message ?? 'Could not initialise payment setup.');
      }

      const { error: initError } = await initPaymentSheet({
        setupIntentClientSecret: data.client_secret,
        merchantDisplayName: 'OneShetland Fetch',
        customerId: data.customer_id,
        returnURL: 'oneshetland-fetch://payment-return',
        applePay: { merchantCountryCode: 'GB' },
        googlePay: { merchantCountryCode: 'GB', testEnv: true },
        style: 'automatic',
        appearance: {
          colors: {
            primary: '#032F4C',
            background: '#FBF8F3',
            componentBackground: '#FFFFFF',
            componentBorder: '#E2D9CE',
            componentDivider: '#E2D9CE',
            primaryText: '#1C2B35',
            secondaryText: '#6B8494',
            componentText: '#1C2B35',
          },
        },
      });

      if (initError) throw new Error(initError.message);

      const { error: presentError } = await presentPaymentSheet();

      if (presentError) {
        if (presentError.code === 'Canceled') { setLoading(false); return; }
        throw new Error(presentError.message);
      }

      await supabase
        .from('profiles')
        .update({ has_payment_method: true })
        .eq('id', profile!.id);

      await refreshProfile();
      router.back();

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [session, profile, initPaymentSheet, presentPaymentSheet, refreshProfile, router]);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backRow}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Set up payment</Text>
        <Text style={styles.subtitle}>
          Add a payment method so drivers can be paid when they complete your delivery.
        </Text>
      </View>

      {/* Body */}
      <View style={styles.body}>

        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* Stripe security note */}
        <View style={styles.securityRow}>
          <FontAwesome5 name="lock" size={13} color="#1B5E34" />
          <Text style={styles.securityText}>
            Secured by Stripe — OneShetland never stores your card details
          </Text>
        </View>

        {/* CTA */}
        <Button
          label="Set up payment method"
          onPress={handleSetUpPayment}
          loading={loading}
          fullWidth
          size="lg"
        />

        {/* Accepted methods — purely informational */}
        <View style={styles.methodsRow}>
          {Platform.OS === 'ios' ? (
            <View style={styles.methodItem}>
              <FontAwesome5 name="cc-apple-pay" size={24} color={colors.textMuted} />
              <Text style={styles.methodLabel}>Apple Pay</Text>
            </View>
          ) : (
            <View style={styles.methodItem}>
              <FontAwesome6 name="google-pay" size={24} color={colors.textMuted} />
              <Text style={styles.methodLabel}>Google Pay</Text>
            </View>
          )}
          <View style={styles.divider} />
          <View style={styles.methodItem}>
            <FontAwesome5 name="credit-card" size={20} color={colors.textMuted} />
            <Text style={styles.methodLabel}>Debit / Credit card</Text>
          </View>
        </View>

        <Text style={styles.legalNote}>
          By adding a payment method you authorise OneShetland Fetch to charge your card
          for completed deliveries. You can update or remove it at any time from account settings.
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
  backText: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.sm },
  title: {
    color: colors.white,
    fontSize: fontSize.xxl,
    fontWeight: '800',
    marginBottom: spacing.sm,
  },
  subtitle: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: fontSize.sm,
    lineHeight: 20,
  },

  body: {
    flex: 1,
    padding: spacing.lg,
    gap: spacing.lg,
  },

  errorBox: {
    backgroundColor: colors.errorLight,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  errorText: { color: colors.error, fontSize: fontSize.sm, lineHeight: 20 },

  securityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: '#EAF7EF',
    borderRadius: radius.md,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
  },
  securityText: {
    flex: 1,
    fontSize: fontSize.sm,
    color: '#1B5E34',
    lineHeight: 18,
  },

  methodsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    paddingVertical: spacing.sm,
  },
  methodItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  methodLabel: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    fontWeight: '500',
  },
  divider: {
    width: 1,
    height: 18,
    backgroundColor: colors.border,
  },

  legalNote: {
    fontSize: fontSize.xs,
    color: colors.textLight,
    textAlign: 'center',
    lineHeight: 18,
  },
});
