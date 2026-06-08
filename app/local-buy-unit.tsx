/**
 * app/local-buy-unit.tsx
 *
 * Customer-facing screen to buy a Book unit item — a ticket, class pack,
 * day pass, gift voucher, etc. Non-time-based purchase.
 *
 * If the user has a saved card on file, charges off-session immediately
 * (no PaymentSheet). Otherwise initialises a PaymentSheet and writes the
 * book_unit_purchases row via the confirm-unit-purchase edge function.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { useStripe } from '@stripe/stripe-react-native';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import { useAlert } from '@/components/BrandedAlert';
import { supabase } from '@/lib/supabase';
import { fetchBusiness, type LocalBusiness } from '@/lib/local-api';
import { formatPence, type BookUnitItem } from '@/lib/book-api';

const S = SECTIONS.local;

export default function BuyUnitScreen() {
  const router = useRouter();
  const { profile, session } = useAuth();
  const { alert } = useAlert();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();
  const { itemId } = useLocalSearchParams<{ itemId: string }>();

  const [item, setItem]         = useState<BookUnitItem | null>(null);
  const [business, setBusiness] = useState<LocalBusiness | null>(null);
  const [loading, setLoading]   = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    (async () => {
      if (!itemId) { setLoading(false); return; }
      try {
        const { data } = await supabase
          .from('book_unit_items')
          .select('*')
          .eq('id', itemId)
          .single();
        if (!data) return;
        setItem(data as BookUnitItem);
        const biz = await fetchBusiness(data.business_id);
        setBusiness(biz);
      } finally {
        setLoading(false);
      }
    })();
  }, [itemId]);

  const buy = useCallback(async () => {
    if (!session || !profile || !item) return;
    if (!profile.has_payment_method) {
      alert({
        title:   'Add a payment card',
        message: 'Add a card to your account before buying.',
        icon:    'credit-card',
        accent:  S.color,
        actions: [
          { label: 'Cancel', style: 'cancel' },
          { label: 'Add card', onPress: () => router.push('/payment-setup') },
        ],
      });
      return;
    }

    setSubmitting(true);
    try {
      // 1. Create the PaymentIntent
      const { data: intent, error: intentErr } = await supabase.functions.invoke(
        'create-unit-purchase-intent',
        {
          body:    { unit_item_id: item.id, use_saved_card: true },
          headers: { Authorization: `Bearer ${session.access_token}` },
        },
      );

      if (intentErr || !intent) {
        throw new Error(intentErr?.message ?? 'Could not start payment.');
      }
      if (intent.error) throw new Error(intent.error);

      let paymentIntentId: string | undefined = intent.payment_intent_id;

      // 2a. Off-session charge succeeded — record straight away
      if (intent.charged) {
        // already paid, payment_intent_id returned
      }
      // 2b. PaymentSheet path (no saved card / fallback)
      else if (intent.clientSecret) {
        const { error: initErr } = await initPaymentSheet({
          paymentIntentClientSecret: intent.clientSecret,
          merchantDisplayName:       business?.name ?? 'OneShetland',
          returnURL:                 'oneshetland-fetch://payment-return',
          style:                     'automatic',
        });
        if (initErr) throw new Error(initErr.message);
        const { error: presentErr } = await presentPaymentSheet();
        if (presentErr) {
          if (presentErr.code === 'Canceled') { setSubmitting(false); return; }
          throw new Error(presentErr.message);
        }
      } else {
        throw new Error('Unexpected response from payment service.');
      }

      if (!paymentIntentId) throw new Error('Missing payment reference.');

      // 3. Record the purchase
      const { data: confirm, error: confirmErr } = await supabase.functions.invoke(
        'confirm-unit-purchase',
        {
          body:    { unit_item_id: item.id, payment_intent_id: paymentIntentId },
          headers: { Authorization: `Bearer ${session.access_token}` },
        },
      );

      if (confirmErr || !confirm?.ok) {
        throw new Error(confirmErr?.message ?? confirm?.error ?? 'Could not record purchase.');
      }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDone(true);
    } catch (e: any) {
      Alert.alert('Purchase failed', e?.message ?? 'Please try again.');
    } finally {
      setSubmitting(false);
    }
  }, [session, profile, item, business, alert, initPaymentSheet, presentPaymentSheet, router]);

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      </SafeAreaView>
    );
  }
  if (!item || !business) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}><Text style={styles.dim}>Item not found.</Text></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{done ? 'Purchased' : 'Confirm purchase'}</Text>
        <View style={{ width: 70 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {done ? (
          <View style={styles.successCard}>
            <View style={[styles.successIcon, { backgroundColor: S.light }]}>
              <FontAwesome5 name="check" size={28} color={S.color} solid />
            </View>
            <Text style={styles.successTitle}>You're all set</Text>
            <Text style={styles.successSub}>
              {item.uses_per_purchase > 1
                ? `${item.uses_per_purchase} uses added to your account.`
                : `Added to your account.`}
              {item.valid_days ? ` Valid for ${item.valid_days} days.` : ''}
            </Text>
            <TouchableOpacity
              style={[styles.primaryBtn, { backgroundColor: S.color }]}
              onPress={() => router.back()}
              activeOpacity={0.85}
            >
              <Text style={styles.primaryBtnText}>Done</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <View style={styles.card}>
              <Text style={styles.itemName}>{item.name}</Text>
              <Text style={styles.bizName}>{business.name}</Text>
              {item.description ? (
                <Text style={styles.itemDesc}>{item.description}</Text>
              ) : null}

              <View style={styles.divider} />

              <View style={styles.row}>
                <Text style={styles.rowLabel}>Price</Text>
                <Text style={styles.rowValue}>{formatPence(item.price_pence)}</Text>
              </View>

              {item.uses_per_purchase > 1 && (
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Uses</Text>
                  <Text style={styles.rowValue}>{item.uses_per_purchase}</Text>
                </View>
              )}

              {item.valid_days !== null && (
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Valid for</Text>
                  <Text style={styles.rowValue}>{item.valid_days} days from purchase</Text>
                </View>
              )}

              {item.stock !== null && item.stock <= 10 && (
                <View style={styles.row}>
                  <Text style={[styles.rowLabel, { color: colors.error }]}>Stock</Text>
                  <Text style={[styles.rowValue, { color: colors.error }]}>
                    Only {item.stock} left
                  </Text>
                </View>
              )}
            </View>

            <Text style={styles.legal}>
              By tapping Confirm you authorise OneShetland to charge your saved card{' '}
              {formatPence(item.price_pence)} for this purchase.
            </Text>

            <TouchableOpacity
              style={[styles.primaryBtn, { backgroundColor: S.color }, submitting && { opacity: 0.7 }]}
              onPress={buy}
              disabled={submitting}
              activeOpacity={0.85}
            >
              {submitting
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.primaryBtnText}>Confirm — {formatPence(item.price_pence)}</Text>}
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.giftBtn, { borderColor: S.color }]}
              onPress={() => router.replace({ pathname: '/local-gift', params: { kind: 'unit', itemId: item.id } })}
              activeOpacity={0.85}
            >
              <FontAwesome5 name="gift" size={12} color={S.color} solid />
              <Text style={[styles.giftBtnText, { color: S.color }]}>Send as a gift instead</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: colors.navy },
  content: { padding: spacing.md, gap: 16 },
  center:  { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  dim:     { color: colors.textMuted },

  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
    borderBottomWidth: 2,
  },
  backBtn:     { flexDirection: 'row', alignItems: 'center', gap: 8, width: 70 },
  backText:    { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '800', flex: 1, textAlign: 'center' },

  card: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: spacing.lg, borderWidth: 1, borderColor: colors.border,
    gap: 8,
  },
  itemName: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary },
  bizName:  { fontSize: fontSize.sm, color: colors.textMuted, fontWeight: '600' },
  itemDesc: { fontSize: fontSize.sm, color: colors.textPrimary, marginTop: 4, lineHeight: 20 },

  divider: { height: 1, backgroundColor: colors.border, marginVertical: 8 },

  row:      { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  rowLabel: { fontSize: fontSize.sm, color: colors.textMuted, fontWeight: '600' },
  rowValue: { fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: '800' },

  legal:    { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 16, paddingHorizontal: 4 },

  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: radius.md,
  },
  primaryBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },

  giftBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 12, borderRadius: radius.md, borderWidth: 1.5,
  },
  giftBtnText: { fontSize: fontSize.sm, fontWeight: '800' },

  secondaryBtn: {
    alignItems: 'center', paddingVertical: 12,
  },
  secondaryBtnText: { fontSize: fontSize.sm, fontWeight: '700' },

  successCard: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: spacing.lg, alignItems: 'center', gap: 12,
    borderWidth: 1, borderColor: colors.border,
  },
  successIcon: {
    width: 72, height: 72, borderRadius: 36,
    alignItems: 'center', justifyContent: 'center',
  },
  successTitle: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary },
  successSub:   { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', paddingHorizontal: 12 },
});
