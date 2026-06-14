import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Switch,
  ActivityIndicator,
} from 'react-native';
import { haptic } from '@/lib/haptics';
import { useAlert } from '@/components/BrandedAlert';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useRequest } from '@/context/RequestContext';
import { useAuth } from '@/context/AuthContext';
import { logCompliance } from '@/lib/compliance';
import { Button } from '@/components/ui/Button';
import { FormScrollView } from '@/components/ui/FormScrollView';
import { Card } from '@/components/ui/Card';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';

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

/** Haversine distance in miles between two lat/lng points */
function haversinemiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const PRICE_PER_MILE_PENCE = 95;
const MIN_FEE_PENCE = 400;
const ROAD_FACTOR = 1.4;

export default function Step4ReviewScreen() {
  const router = useRouter();
  const { formData, update, reset } = useRequest();
  const { profile } = useAuth();
  const { alert } = useAlert();

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [feePence, setFeePence] = useState<number | null>(null);
  const [distanceMiles, setDistanceMiles] = useState<number | null>(null);
  const [feeLoading, setFeeLoading] = useState(false);
  const [feeError, setFeeError] = useState<string | null>(null);

  const calculateFee = useCallback(() => {
    setFeeLoading(true);
    setFeeError(null);
    setFeePence(null);

    // Preferred path: use lat/lng from Places Details (no network call needed)
    if (
      formData.pickupLat != null && formData.pickupLng != null &&
      formData.destinationLat != null && formData.destinationLng != null
    ) {
      const straightMiles = haversinemiles(
        formData.pickupLat, formData.pickupLng,
        formData.destinationLat, formData.destinationLng,
      );
      const roadMiles = straightMiles * ROAD_FACTOR;
      const fee = Math.max(MIN_FEE_PENCE, Math.round(roadMiles * PRICE_PER_MILE_PENCE));
      setFeePence(fee);
      setDistanceMiles(Math.round(roadMiles * 10) / 10);
      setFeeLoading(false);
      return;
    }

    // Fallback: use postcodes via edge function (e.g. saved addresses without coords)
    const pickupPostcode = formData.pickupPostcode || extractPostcode(formData.pickupLocation);
    const destPostcode   = formData.destinationPostcode || extractPostcode(formData.destinationAddress);

    if (!pickupPostcode || !destPostcode) {
      setFeeError('Select both addresses from the suggestions to get a fee estimate.');
      setFeeLoading(false);
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

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
  }, [formData.pickupLat, formData.pickupLng, formData.destinationLat, formData.destinationLng,
      formData.pickupPostcode, formData.pickupLocation, formData.destinationPostcode, formData.destinationAddress]);

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
      alert({
        title: 'Supabase not configured',
        message: 'Add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to your .env file. See README.md for setup instructions.',
        actions: [{ label: 'OK', style: 'primary' }],
      });
      return;
    }

    if (!profile?.id) {
      setSubmitError('You must be signed in to submit a request.');
      return;
    }

    setSubmitting(true);

    // Log liability acknowledgement before the request is created
    if (formData.liabilityAcknowledged) {
      logCompliance({
        eventType:   'fetch.liability_ack',
        description: 'Acknowledged Fetch delivery liability on request submission',
        metadata:    { pickup: formData.pickupName, destination: formData.destinationAddress },
      });
    }

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
    haptic.success();
    alert({
      title: 'Request submitted! 🎉',
      message: "Your delivery request is live. You'll be notified when a driver picks it up.",
      actions: [
        {
          label: 'Back to dashboard',
          style: 'primary',
          onPress: () => router.replace('/(customer)/dashboard'),
        },
      ],
    });
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Compact nav strip — matches steps 1–3 */}
      <View style={styles.navHeader}>
        <Pressable onPress={() => { haptic.light(); router.back(); }} hitSlop={12}>
          <Text style={styles.backLinkText}>‹ Back</Text>
        </Pressable>
        <View style={styles.progressRow}>
          {[1, 2, 3, 4].map((s) => (
            <View
              key={s}
              style={[styles.progressDot, s <= 4 && styles.progressDotDone, s === 4 && styles.progressDotCurrent]}
            />
          ))}
        </View>
      </View>

      <FormScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.body}>
          <View style={styles.pageHeader}>
            <Text style={styles.categoryBadgeText}>{formData.categoryName}</Text>
          </View>
          <Text style={styles.title}>Review & submit</Text>
          <Text style={styles.subtitle}>Check everything looks right before sending.</Text>
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
                <Pressable onPress={calculateFee} style={styles.retryBtn}>
                  <Text style={styles.retryBtnText}>Try again</Text>
                </Pressable>
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

  // Compact nav strip — matches steps 1–3
  navHeader: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  backLinkText: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.sm, fontWeight: '500' },
  progressRow: { flexDirection: 'row', gap: 6 },
  progressDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.25)' },
  progressDotDone: { backgroundColor: 'rgba(255,255,255,0.6)' },
  progressDotCurrent: { backgroundColor: colors.accent, width: 24, borderRadius: 4 },

  // Page heading — lives in scroll content like steps 1–3
  pageHeader: {
    alignSelf: 'flex-start',
    backgroundColor: colors.navy,
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    marginBottom: spacing.md,
  },
  categoryBadgeText: { fontSize: fontSize.xs, color: colors.white, fontWeight: '700' },
  title: {
    color: colors.navy,
    fontSize: fontSize.xxl,
    fontWeight: '800',
    marginBottom: spacing.sm,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: fontSize.md,
    lineHeight: 22,
    marginBottom: spacing.xl,
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
