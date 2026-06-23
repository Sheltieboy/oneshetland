/**
 * app/local-gift.tsx
 *
 * Gift purchase flow — buy a Book unit item or a bookable service for
 * someone else. Captures recipient details + a personal message, charges
 * the buyer via Stripe, then fires an email with a claim link.
 *
 * Params:
 *   kind        — 'unit' | 'booking'
 *   itemId      — when kind = 'unit'
 *   serviceId   — when kind = 'booking'
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, KeyboardAvoidingView, Platform,
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
import { ConfirmPaymentSheet } from '@/components/ConfirmPaymentSheet';
import { supabase } from '@/lib/supabase';
import { fetchBusiness, fetchWalletBalance, type LocalBusiness } from '@/lib/local-api';
import { formatPence, type BookUnitItem, type BookService } from '@/lib/book-api';

const S = SECTIONS.local;

type GiftKind = 'unit' | 'booking';

export default function GiftScreen() {
  const router = useRouter();
  const { profile, session } = useAuth();
  const { alert } = useAlert();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();
  const params = useLocalSearchParams<{ kind: GiftKind; itemId?: string; serviceId?: string }>();

  const kind = params.kind;
  const targetId = kind === 'unit' ? params.itemId : params.serviceId;

  const [item, setItem]         = useState<BookUnitItem | BookService | null>(null);
  const [business, setBusiness] = useState<LocalBusiness | null>(null);
  const [loading, setLoading]   = useState(true);

  const [recipientName, setRecipientName]   = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [message, setMessage]               = useState('');
  const [submitting, setSubmitting]         = useState(false);
  const [confirming, setConfirming]         = useState(false);
  const [walletBalance, setWalletBalance]   = useState<number | null>(null);

  useEffect(() => { if (profile?.id) fetchWalletBalance(profile.id).then(setWalletBalance).catch(() => {}); }, [profile?.id]);

  const [doneState, setDoneState] = useState<{ code: string; recipientEmail: string; emailed: boolean } | null>(null);

  useEffect(() => {
    (async () => {
      if (!kind || !targetId) { setLoading(false); return; }
      try {
        const table = kind === 'unit' ? 'book_unit_items' : 'book_services';
        const { data } = await supabase
          .from(table)
          .select('*')
          .eq('id', targetId)
          .single();
        if (!data) return;
        setItem(data as any);
        const biz = await fetchBusiness((data as any).business_id);
        setBusiness(biz);
      } finally {
        setLoading(false);
      }
    })();
  }, [kind, targetId]);

  const price = (item as any)?.price_pence as number | undefined;
  const itemName = (item as any)?.name as string | undefined;

  // Validate + gate, then show the confirm step (gifts always charge a saved
  // card off-session, so a single tap would otherwise move money silently).
  const submit = useCallback(() => {
    if (!session || !profile || !item || !kind || !targetId) return;

    const emailTrim = recipientEmail.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(emailTrim)) {
      return alert({ title: 'Email needed', message: 'Please enter the recipient\'s email address.' });
    }

    if (!profile.has_payment_method) {
      alert({
        title:   'Add a payment card',
        message: 'Add a card to your account before sending a gift.',
        icon:    'credit-card',
        accent:  S.color,
        actions: [
          { label: 'Cancel', style: 'cancel' },
          { label: 'Add card', onPress: () => router.push('/payment-setup') },
        ],
      });
      return;
    }

    setConfirming(true);
  }, [session, profile, item, kind, targetId, recipientEmail, router, alert]);

  const runGift = useCallback(async (viaWallet = false) => {
    if (!session || !profile || !item || !kind || !targetId) return;
    const emailTrim = recipientEmail.trim().toLowerCase();

    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        kind,
        recipient_email: emailTrim,
        recipient_name:  recipientName.trim() || null,
        message:         message.trim() || null,
        ...(viaWallet ? { pay_with_wallet: true } : { use_saved_card: true }),
      };
      if (kind === 'unit')    body.unit_item_id = targetId;
      if (kind === 'booking') body.service_id   = targetId;

      // 1. Create gift + PaymentIntent
      const { data: intent, error: intentErr } = await supabase.functions.invoke(
        'create-gift-intent',
        { body, headers: { Authorization: `Bearer ${session.access_token}` } },
      );

      if (intentErr || !intent) {
        // supabase.functions.invoke gives a generic "non-2xx" message — the real
        // reason is in the response body. Surface it.
        let msg = intentErr?.message ?? 'Could not start gift.';
        try {
          const ctx = (intentErr as any)?.context;
          if (ctx && typeof ctx.json === 'function') { const b = await ctx.json(); if (b?.error) msg = b.error; }
        } catch { /* keep generic */ }
        throw new Error(msg);
      }
      if (intent.error) throw new Error(intent.error);

      let paymentIntentId: string | undefined = intent.payment_intent_id;

      if (!intent.charged) {
        if (!intent.clientSecret) throw new Error('Unexpected response from payment service.');
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
      }

      if (!paymentIntentId) throw new Error('Missing payment reference.');

      // 2. Confirm gift — generates code + sends email
      const { data: confirm, error: confirmErr } = await supabase.functions.invoke(
        'confirm-gift',
        {
          body:    { gift_id: intent.gift_id, payment_intent_id: paymentIntentId },
          headers: { Authorization: `Bearer ${session.access_token}` },
        },
      );

      if (confirmErr || !confirm?.ok) {
        throw new Error(confirmErr?.message ?? confirm?.error ?? 'Could not finalise gift.');
      }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Only claim the email went out if the server actually sent it. The
      // already-sent (idempotent) path doesn't re-send, so treat that as "share
      // the code yourself" too — don't over-promise (QA L5).
      const emailed = confirm.email_sent === true;
      setDoneState({ code: confirm.code, recipientEmail: emailTrim, emailed });
    } catch (e: any) {
      alert({ title: 'Gift failed', message: e?.message ?? 'Please try again.' });
    } finally {
      setSubmitting(false);
      setConfirming(false);
    }
  }, [
    session, profile, item, kind, targetId, recipientEmail, recipientName, message,
    business, initPaymentSheet, presentPaymentSheet, router, alert,
  ]);

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      </SafeAreaView>
    );
  }
  if (!item || !business || !kind || !targetId) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}><Text style={styles.dim}>Gift not available.</Text></View>
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
        <Text style={styles.headerTitle}>{doneState ? 'Gift sent' : 'Send as a gift'}</Text>
        <View style={{ width: 70 }} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">

          {doneState ? (
            <View style={styles.successCard}>
              <View style={[styles.successIcon, { backgroundColor: S.light }]}>
                <FontAwesome5 name="gift" size={28} color={S.color} solid />
              </View>
              <Text style={styles.successTitle}>Gift on its way</Text>
              <Text style={styles.successSub}>
                {doneState.emailed ? (
                  <>We've emailed <Text style={{ fontWeight: '900' }}>{doneState.recipientEmail}</Text> with a claim link.</>
                ) : (
                  <>Your gift is paid for. We couldn't confirm the email to <Text style={{ fontWeight: '900' }}>{doneState.recipientEmail}</Text> went out — share the code below with them so they can claim it.</>
                )}
              </Text>
              <View style={styles.codeBox}>
                <Text style={styles.codeLabel}>Their code</Text>
                <Text style={[styles.codeValue, { color: S.color }]}>{doneState.code}</Text>
              </View>
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
                <Text style={styles.preLabel}>You're gifting</Text>
                <Text style={styles.itemName}>{itemName}</Text>
                <Text style={styles.bizName}>{business.name}</Text>
                <View style={styles.divider} />
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Total to charge</Text>
                  <Text style={[styles.rowValue, { color: S.color }]}>{formatPence(price ?? 0)}</Text>
                </View>
              </View>

              <View style={styles.card}>
                <Text style={styles.preLabel}>Recipient</Text>

                <Text style={styles.fieldLabel}>Their name (optional)</Text>
                <TextInput
                  style={styles.input}
                  value={recipientName}
                  onChangeText={setRecipientName}
                  placeholder="e.g. Anna"
                  placeholderTextColor={colors.textLight}
                  autoCapitalize="words"
                  maxLength={80}
                />

                <Text style={styles.fieldLabel}>Their email</Text>
                <TextInput
                  style={styles.input}
                  value={recipientEmail}
                  onChangeText={setRecipientEmail}
                  placeholder="anna@example.com"
                  placeholderTextColor={colors.textLight}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={120}
                />

                <Text style={styles.fieldLabel}>Personal message (optional)</Text>
                <TextInput
                  style={[styles.input, { height: 90, textAlignVertical: 'top' }]}
                  value={message}
                  onChangeText={setMessage}
                  placeholder="Happy birthday — enjoy!"
                  placeholderTextColor={colors.textLight}
                  multiline
                  maxLength={280}
                />
                <Text style={styles.hint}>{message.length}/280 characters</Text>
              </View>

              <Text style={styles.legal}>
                By tapping Send you authorise OneShetland to charge your saved card{' '}
                {formatPence(price ?? 0)}. The recipient gets an email with a short code to claim the gift.
              </Text>

              <TouchableOpacity
                style={[styles.primaryBtn, { backgroundColor: S.color }, submitting && { opacity: 0.7 }]}
                onPress={submit}
                disabled={submitting}
                activeOpacity={0.85}
              >
                {submitting
                  ? <ActivityIndicator color="#fff" />
                  : <>
                      <FontAwesome5 name="gift" size={13} color="#fff" solid />
                      <Text style={styles.primaryBtnText}> Send gift — {formatPence(price ?? 0)}</Text>
                    </>}
              </TouchableOpacity>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      <ConfirmPaymentSheet
        visible={confirming}
        itemName={`Gift: ${item?.name ?? 'item'}${business ? ` — ${business.name}` : ''}`}
        lineItems={[{ label: 'Gift', amountPence: price ?? 0 }]}
        totalPence={price ?? 0}
        payingWith="Saved card"
        policy={{ text: 'Gifts are non-refundable once sent.' }}
        loading={submitting}
        onConfirm={() => runGift(false)}
        onCancel={() => setConfirming(false)}
        walletBalancePence={walletBalance}
        onConfirmWallet={() => runGift(true)}
        onTopUp={() => { setConfirming(false); router.push('/local-wallet'); }}
      />
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
    gap: 6,
  },
  preLabel: { fontSize: 11, color: colors.textMuted, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1 },
  itemName: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary, marginTop: 4 },
  bizName:  { fontSize: fontSize.sm, color: colors.textMuted, fontWeight: '600' },

  divider: { height: 1, backgroundColor: colors.border, marginVertical: 12 },
  row:      { flexDirection: 'row', justifyContent: 'space-between' },
  rowLabel: { fontSize: fontSize.sm, color: colors.textMuted, fontWeight: '600' },
  rowValue: { fontSize: fontSize.md, fontWeight: '900' },

  fieldLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary, marginTop: 12, marginBottom: 6 },
  input:      { backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 10, fontSize: fontSize.sm, color: colors.textPrimary },
  hint:       { fontSize: 11, color: colors.textMuted, marginTop: 6 },

  legal: { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 16, paddingHorizontal: 4 },

  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    paddingVertical: 14, borderRadius: radius.md,
  },
  primaryBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },

  successCard: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: spacing.lg, alignItems: 'center', gap: 14,
    borderWidth: 1, borderColor: colors.border,
  },
  successIcon: {
    width: 72, height: 72, borderRadius: 36,
    alignItems: 'center', justifyContent: 'center',
  },
  successTitle: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary },
  successSub:   { fontSize: fontSize.sm, color: colors.textPrimary, textAlign: 'center', paddingHorizontal: 12, lineHeight: 22 },

  codeBox: {
    backgroundColor: colors.screenBackground, borderRadius: radius.md,
    paddingVertical: 14, paddingHorizontal: 24, alignItems: 'center', gap: 4,
    marginVertical: 4, alignSelf: 'stretch',
  },
  codeLabel: { fontSize: 11, color: colors.textMuted, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1.5 },
  codeValue: { fontSize: 28, fontWeight: '900', letterSpacing: 4, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
});
