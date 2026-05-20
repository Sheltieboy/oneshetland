import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,

  StyleSheet,
  TouchableOpacity,
  Switch,
  Alert,
  ActivityIndicator,
  Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useRequest } from '@/context/RequestContext';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/Button';
import { FormScrollView } from '@/components/ui/FormScrollView';
import { Card } from '@/components/ui/Card';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { getRegionName } from '@/constants/regions';

const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
import { colors, fontSize, spacing, radius } from '@/constants/theme';

/** Extract the first UK postcode found in a free-text address string */
function extractPostcode(address: string): string | null {
  const match = address.match(/[A-Z]{1,2}\d[\dA-Z]?\s?\d[A-Z]{2}/i);
  return match ? match[0].toUpperCase() : null;
}

function penceToGBP(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

export default function Step4ReviewScreen() {
  const router = useRouter();
  const { formData, update, reset } = useRequest();
  const { profile } = useAuth();

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [feePence, setFeePence] = useState<number | null>(null);
  const [distanceMiles, setDistanceMiles] = useState<number | null>(null);
  const [feeLoading, setFeeLoading] = useState(false);
  const [feeError, setFeeError] = useState<string | null>(null);

  const calculateFee = useCallback(() => {
    const pickupPostcode = extractPostcode(formData.pickupLocation);
    const destPostcode   = extractPostcode(formData.destinationAddress);

    if (!pickupPostcode || !destPostcode) {
      setFeeError('Could not read postcodes from your addresses — make sure both include a postcode.');
      return;
    }

    setFeeLoading(true);
    setFeeError(null);
    setFeePence(null);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15s — allows for cold start

    fetch('https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/calculate-fee', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        pickup_postcode: pickupPostcode,
        destination_postcode: destPostcode,
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setFeePence(data.fee_pence);
        setDistanceMiles(data.distance_miles);
      })
      .catch((err) => {
        const msg = err.name === 'AbortError' ? 'timed out' : err.message;
        setFeeError(`Fee estimate unavailable (${msg}).`);
      })
      .finally(() => { clearTimeout(timeout); setFeeLoading(false); });
  }, [formData.pickupLocation, formData.destinationAddress]);

  // Calculate fee on mount
  useEffect(() => { calculateFee(); }, [calculateFee]);

  const needsLiability =
    formData.categorySlug === 'pharmacy' ||
    formData.categorySlug === 'takeaway';

  async function handleSubmit() {
    setSubmitError(null);

    if (needsLiability && !formData.liabilityAcknowledged) {
      setSubmitError(
        'Please acknowledge the liability notice before submitting.',
      );
      return;
    }

    if (!isSupabaseConfigured) {
      Alert.alert(
        'Supabase not configured',
        'Add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to your .env file. See README.md for setup instructions.',
        [{ text: 'OK' }],
      );
      return;
    }

    if (!profile?.id) {
      setSubmitError('You must be signed in to submit a request.');
      return;
    }

    setSubmitting(true);

    try {
      // Race the insert against a 12-second timeout so we never hang silently
      const insertPromise = supabase.from('delivery_requests').insert({
        customer_id: profile.id,
        category_slug: formData.categorySlug,
        pickup_name: formData.pickupName,
        pickup_location: formData.pickupLocation,
        pickup_notes: formData.pickupNotes || null,
        already_paid: formData.alreadyPaid,
        ready_for_collection: formData.readyForCollection,
        destination_region_id: null,
        destination_area: formData.destinationArea || null,
        destination_address: formData.destinationAddress,
        contact_phone: formData.contactPhone || null,
        delivery_notes: formData.deliveryNotes || null,
        liability_acknowledged: formData.liabilityAcknowledged,
        base_fee_pence: feePence ?? null,
        status: 'pending',
      });

      const timeoutPromise = new Promise<{ error: Error }>(
        (_, reject) => setTimeout(() => reject(new Error('Request timed out after 12 seconds')), 12000),
      );

      const { data: inserted, error } = await Promise.race([
        insertPromise.select('id').single(),
        timeoutPromise,
      ]) as { data: { id: string } | null; error: { message: string } | null };

      setSubmitting(false);

      if (error) {
        setSubmitError(`Could not submit request: ${error.message}`);
        return;
      }

      // Notify all approved drivers about the new request (non-blocking)
      if (inserted?.id) {
        const { data: { session } } = await supabase.auth.getSession();
        fetch('https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/notify-drivers', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session?.access_token}`,
          },
          body: JSON.stringify({ request_id: inserted.id }),
        }).catch(() => {/* non-fatal */});
      }
    } catch (e) {
      setSubmitting(false);
      setSubmitError(e instanceof Error ? e.message : 'Unknown error — please try again.');
      return;
    }

    reset();
    Alert.alert(
      'Request submitted!',
      "Your delivery request has been submitted. You'll be notified when a driver picks it up.",
      [
        {
          text: 'Back to dashboard',
          onPress: () => router.replace('/(customer)/dashboard'),
        },
      ],
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <FormScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backLink}>
            <Text style={styles.backLinkText}>← Back</Text>
          </TouchableOpacity>
          <View style={styles.progressRow}>
            {[1, 2, 3, 4].map((s) => (
              <View
                key={s}
                style={[styles.progressDot, styles.progressDotActive, s === 4 && styles.progressDotCurrent]}
              />
            ))}
          </View>
          <Text style={styles.stepLabel}>Step 4 of 4</Text>
          <Text style={styles.title}>Review & submit</Text>
          <Text style={styles.subtitle}>Check everything looks right before sending.</Text>
        </View>

        <View style={styles.body}>
          {submitError && (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{submitError}</Text>
            </View>
          )}

          {/* ── Delivery fee estimate — shown first, most important ── */}
          <Card style={styles.feeCard}>
            <Text style={styles.feeSectionLabel}>Estimated delivery fee</Text>
            {feeLoading && (
              <View style={styles.feeLoadingRow}>
                <ActivityIndicator size="small" color={colors.accent} />
                <Text style={styles.feeLoadingText}>Calculating based on distance…</Text>
              </View>
            )}
            {!feeLoading && feeError && (
              <View style={styles.feeRetryRow}>
                <Text style={styles.feeErrorText}>{feeError}</Text>
                <TouchableOpacity onPress={calculateFee} style={styles.retryBtn}>
                  <Text style={styles.retryBtnText}>Try again</Text>
                </TouchableOpacity>
              </View>
            )}
            {!feeLoading && feePence != null && (
              <>
                <Text style={styles.feeAmount}>{penceToGBP(feePence)}</Text>
                {distanceMiles != null && (
                  <Text style={styles.feeDetail}>~{distanceMiles} miles (road estimate)</Text>
                )}
                <Text style={styles.feeNote}>
                  Priced at 95p/mile with a £4.00 minimum. Your card is pre-authorised
                  now and only charged when your item is delivered.
                </Text>
              </>
            )}
          </Card>

          {/* Summary card */}
          <Card style={styles.summaryCard}>
            <Text style={styles.summarySection}>Collection</Text>
            <Row label="Category" value={formData.categoryName} />
            <Row label="From" value={formData.pickupName} />
            <Row label="Address" value={formData.pickupLocation} />
            {formData.pickupNotes ? <Row label="Notes" value={formData.pickupNotes} /> : null}
            <Row label="Already paid" value={formData.alreadyPaid ? 'Yes' : 'No'} />
            <Row label="Ready to collect" value={formData.readyForCollection ? 'Yes' : 'Not yet'} />

            <View style={styles.divider} />

            <Text style={styles.summarySection}>Delivery</Text>
            <Row label="Region" value={getRegionName(formData.destinationRegionSlug)} />
            {formData.destinationArea ? (
              <Row label="Area" value={formData.destinationArea} />
            ) : null}
            <Row label="Address" value={formData.destinationAddress} />
            {formData.contactPhone ? (
              <Row label="Phone" value={formData.contactPhone} />
            ) : null}
            {formData.deliveryNotes ? (
              <Row label="Notes" value={formData.deliveryNotes} />
            ) : null}
          </Card>

          {/* Liability notice */}
          {needsLiability && (
            <Card style={styles.liabilityCard}>
              <Text style={styles.liabilityTitle}>⚠️ Liability notice</Text>
              <Text style={styles.liabilityBody}>
                Chilled, frozen, or high-value items are carried at your own risk. OneShetland
                Fetch is a community platform and cannot guarantee the condition of items during
                transit. Drivers are volunteers, not professional couriers.
              </Text>
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>
                  I understand and accept these conditions
                </Text>
                <Switch
                  value={formData.liabilityAcknowledged}
                  onValueChange={(v) => update({ liabilityAcknowledged: v })}
                  trackColor={{ false: colors.border, true: colors.accent }}
                  thumbColor={colors.white}
                />
              </View>
            </Card>
          )}

          <Button
            label={feeLoading ? 'Calculating fee…' : 'Submit delivery request'}
            onPress={handleSubmit}
            loading={submitting}
            disabled={feeLoading}
            variant="secondary"
            size="lg"
            fullWidth
            style={styles.submitButton}
          />

          <Text style={styles.disclaimer}>
            By submitting you agree to the OneShetland Fetch community guidelines.
            No alcohol, tobacco, vapes, cash, or passengers.
          </Text>
        </View>
      </FormScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={rowStyles.row}>
      <Text style={rowStyles.label}>{label}</Text>
      <Text style={rowStyles.value}>{value || '—'}</Text>
    </View>
  );
}

const rowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    gap: spacing.md,
  },
  label: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    flexShrink: 0,
    width: 110,
  },
  value: {
    fontSize: fontSize.sm,
    color: colors.textPrimary,
    fontWeight: '500',
    flex: 1,
    textAlign: 'right',
  },
});

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  content: {
    backgroundColor: colors.screenBackground,
    paddingBottom: spacing.xxl,
    flexGrow: 1,
  },
  header: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
  },
  backLink: { marginBottom: spacing.md },
  backLinkText: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.sm },
  progressRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  progressDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
  progressDotActive: { backgroundColor: 'rgba(255,255,255,0.6)' },
  progressDotCurrent: { backgroundColor: colors.accent, width: 24 },
  stepLabel: {
    color: colors.accent,
    fontSize: fontSize.xs,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.sm,
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

  body: { padding: spacing.lg },

  errorBox: {
    backgroundColor: colors.errorLight,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  errorText: { color: colors.error, fontSize: fontSize.sm, lineHeight: 20 },

  summaryCard: { marginBottom: spacing.md },
  summarySection: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: spacing.xs,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.md,
  },

  liabilityCard: {
    marginBottom: spacing.md,
    backgroundColor: colors.warningLight,
  },
  liabilityTitle: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: '#92400E',
    marginBottom: spacing.sm,
  },
  liabilityBody: {
    fontSize: fontSize.sm,
    color: '#78350F',
    lineHeight: 20,
    marginBottom: spacing.md,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  toggleLabel: {
    flex: 1,
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: '#92400E',
    lineHeight: 18,
  },

  submitButton: { marginBottom: spacing.md },
  disclaimer: {
    fontSize: fontSize.xs,
    color: colors.textLight,
    textAlign: 'center',
    lineHeight: 18,
  },

  feeCard: { marginBottom: spacing.md, borderColor: colors.accent, borderWidth: 1 },
  feeSectionLabel: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: spacing.sm,
  },
  feeLoadingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  feeLoadingText: { fontSize: fontSize.sm, color: colors.textMuted },
  feeAmount: { fontSize: 28, fontWeight: '800', color: colors.navy, marginBottom: 2 },
  feeDetail: { fontSize: fontSize.sm, color: colors.textMuted, marginBottom: spacing.sm },
  feeNote: { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 16 },
  feeRetryRow: { gap: spacing.sm },
  feeErrorText: { fontSize: fontSize.sm, color: colors.textMuted, lineHeight: 18, fontStyle: 'italic' },
  retryBtn: {
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  retryBtnText: { fontSize: fontSize.sm, color: colors.white, fontWeight: '600' },
});
