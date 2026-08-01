/**
 * app/product-checkout.tsx — Shop Shetland checkout (single product + options).
 *
 * Fulfilment picker (collect / post with live postage quote), then payment:
 *   wallet → instant (edge fn finalises), card → PaymentSheet; the Stripe
 *   webhook finalises the order, so after a successful sheet we're done.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { useStripe } from '@stripe/stripe-react-native';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import { formatPence, fetchWalletBalance } from '@/lib/local-api';
import {
  fetchProduct, createProductOrder, shippingQuote,
  type Product, type ProductVariant, type BusinessShipping,
} from '@/lib/products-api';

const S = SECTIONS.local;

export default function ProductCheckoutScreen() {
  const router = useRouter();
  const { session, profile } = useAuth();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();
  const { productId, variantId, qty: qtyParam } = useLocalSearchParams<{ productId: string; variantId?: string; qty?: string }>();
  const qty = Math.max(1, Math.min(99, Math.floor(Number(qtyParam) || 1)));

  const [loading, setLoading] = useState(true);
  const [product, setProduct] = useState<Product | null>(null);
  const [variant, setVariant] = useState<ProductVariant | null>(null);
  const [shipping, setShipping] = useState<BusinessShipping | null>(null);
  const [businessName, setBusinessName] = useState('');
  const [walletPence, setWalletPence] = useState(0);

  const [fulfilment, setFulfilment] = useState<'collect' | 'post'>('collect');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [postcode, setPostcode] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!productId) return;
    Promise.all([fetchProduct(productId), profile ? fetchWalletBalance(profile.id).catch(() => 0) : Promise.resolve(0)]).then(([d, bal]) => {
      if (d) {
        setProduct(d.product);
        setVariant(d.variants.find((v) => v.id === variantId) ?? null);
        setShipping(d.shipping);
        setBusinessName(d.businessName);
        if (!(d.shipping?.collect_enabled ?? true) && d.shipping?.post_enabled) setFulfilment('post');
      }
      setWalletPence(typeof bal === 'number' ? bal : 0);
    }).finally(() => setLoading(false));
  }, [productId, variantId, profile?.id]);

  const unit = (product?.price_pence ?? 0) + (variant?.price_delta_pence ?? 0);
  const itemsPence = unit * qty;
  const postOk = !!shipping?.post_enabled && !product?.collect_only;
  const collectOk = shipping?.collect_enabled ?? true;
  const eff = fulfilment === 'post' && postOk ? 'post' : 'collect';
  const quote = useMemo(() =>
    eff === 'post' ? shippingQuote(shipping, itemsPence, qty, postcode || 'XX', !!product?.free_uk_post) : 0,
  [eff, shipping, itemsPence, qty, postcode, product?.free_uk_post]);
  const total = itemsPence + quote;

  function validate(): string | null {
    if (!session) return 'Sign in to buy — it takes a minute.';
    if (eff === 'post' && (!name.trim() || !address.trim() || !postcode.trim())) {
      return 'Fill in the delivery name, address and postcode first.';
    }
    return null;
  }

  const orderBody = (payWith: 'card' | 'wallet', useSaved: boolean) => ({
    business_id: product!.business_id,
    items: [{ product_id: product!.id, variant_id: variant?.id ?? null, qty }],
    fulfilment: eff as 'collect' | 'post',
    delivery: eff === 'post' ? { name, address, postcode, phone } : undefined,
    note: note || undefined,
    pay_with: payWith,
    use_saved_card: useSaved,
  });

  async function payWallet() {
    const v = validate(); if (v) { setErr(v); return; }
    setBusy(true); setErr(null);
    try {
      await createProductOrder(orderBody('wallet', false));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDone(true);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Payment failed'); }
    finally { setBusy(false); }
  }

  async function payCard() {
    const v = validate(); if (v) { setErr(v); return; }
    setBusy(true); setErr(null);
    try {
      const useSaved = !!profile?.has_payment_method;
      const res = await createProductOrder(orderBody('card', useSaved));
      if (res.charged) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setDone(true);
        return;
      }
      if (!res.clientSecret) throw new Error("Couldn't start the payment");
      const init = await initPaymentSheet({
        merchantDisplayName: businessName || 'OneShetland',
        paymentIntentClientSecret: res.clientSecret,
        applePay: { merchantCountryCode: 'GB' },
      });
      if (init.error) throw new Error(init.error.message);
      const sheet = await presentPaymentSheet();
      if (sheet.error) {
        if (sheet.error.code === 'Canceled') return; // stock releases on TTL
        throw new Error(sheet.error.message);
      }
      // Webhook finalises the order — from the buyer's side, it's placed.
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDone(true);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Payment failed'); }
    finally { setBusy(false); }
  }

  if (loading) return <SafeAreaView style={styles.safe}><View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View></SafeAreaView>;
  if (!product) return <SafeAreaView style={styles.safe}><View style={styles.center}><Text style={styles.dim}>Product not found.</Text></View></SafeAreaView>;

  if (done) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={[styles.center, { padding: spacing.xl, gap: spacing.sm }]}>
          <Text style={{ fontSize: 44 }}>🎉</Text>
          <Text style={styles.doneTitle}>Order placed!</Text>
          <Text style={styles.doneSub}>{businessName} has been told, and you&rsquo;ll get updates as it moves. Thanks for buying local.</Text>
          <TouchableOpacity style={[styles.payBtn, { backgroundColor: S.color, alignSelf: 'stretch' }]} onPress={() => router.replace('/my-orders' as never)}>
            <Text style={styles.payText}>Track your order</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.back()}><Text style={{ color: S.color, fontWeight: '700' }}>Keep browsing</Text></TouchableOpacity>
        </View>
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
        <Text style={styles.headerTitle}>Checkout</Text>
        <View style={{ width: 70 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Text style={styles.lineTitle}>{qty} × {product.title}{variant ? ` (${variant.name})` : ''}</Text>
          <Text style={styles.lineSub}>from {businessName}</Text>
        </View>

        <Text style={styles.groupLabel}>How would you like it?</Text>
        {collectOk && (
          <TouchableOpacity style={[styles.option, eff === 'collect' && { borderColor: S.color, borderWidth: 2 }]} onPress={() => setFulfilment('collect')}>
            <Text style={styles.optionTitle}>Collect from {businessName} — free</Text>
            {!!shipping?.collect_note && <Text style={styles.optionSub}>{shipping.collect_note}</Text>}
          </TouchableOpacity>
        )}
        {postOk && (
          <TouchableOpacity style={[styles.option, eff === 'post' && { borderColor: S.color, borderWidth: 2 }]} onPress={() => setFulfilment('post')}>
            <Text style={styles.optionTitle}>Post it — {product.free_uk_post || quote === 0 && postcode ? 'free' : postcode ? formatPence(quote) : 'enter postcode for price'}</Text>
            {eff === 'post' && (
              <View style={{ gap: spacing.xs, marginTop: spacing.xs }}>
                <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Name" placeholderTextColor={colors.textMuted} />
                <TextInput style={styles.input} value={address} onChangeText={setAddress} placeholder="Address" placeholderTextColor={colors.textMuted} />
                <View style={{ flexDirection: 'row', gap: spacing.xs }}>
                  <TextInput style={[styles.input, { flex: 1 }]} value={postcode} onChangeText={setPostcode} autoCapitalize="characters" placeholder="Postcode" placeholderTextColor={colors.textMuted} />
                  <TextInput style={[styles.input, { flex: 1 }]} value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="Phone (optional)" placeholderTextColor={colors.textMuted} />
                </View>
              </View>
            )}
          </TouchableOpacity>
        )}
        <TextInput style={[styles.input, { minHeight: 56 }]} value={note} onChangeText={setNote} multiline
          placeholder="A note for the shop (optional)" placeholderTextColor={colors.textMuted} />

        <View style={styles.card}>
          <Row label="Items" value={formatPence(itemsPence)} />
          <Row label={eff === 'post' ? 'Postage' : 'Collection'} value={quote === 0 ? 'Free' : formatPence(quote)} />
          <View style={styles.totalRow}><Text style={styles.totalLabel}>Total</Text><Text style={styles.totalValue}>{formatPence(total)}</Text></View>
        </View>

        {err && <Text style={styles.err}>{err}</Text>}

        <TouchableOpacity style={[styles.payBtn, { backgroundColor: S.color }]} onPress={payCard} disabled={busy} activeOpacity={0.85}>
          <Text style={styles.payText}>{busy ? 'One sec…' : `Pay by card · ${formatPence(total)}`}</Text>
        </TouchableOpacity>
        {walletPence >= total && total > 0 && (
          <TouchableOpacity style={[styles.payBtn, styles.walletBtn, { borderColor: S.color }]} onPress={payWallet} disabled={busy} activeOpacity={0.85}>
            <Text style={[styles.payText, { color: S.color }]}>Pay with wallet ({formatPence(walletPence)})</Text>
          </TouchableOpacity>
        )}
        <Text style={styles.smallPrint}>Sold by {businessName}. Payments processed by Stripe; OneShetland takes a small fee from the shop, never from you.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <View style={styles.row}><Text style={styles.rowLabel}>{label}</Text><Text style={styles.rowValue}>{value}</Text></View>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  dim: { color: colors.textSecondary },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: 2, backgroundColor: colors.cardBackground,
  },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, width: 70 },
  backText: { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { fontSize: fontSize.lg, fontWeight: '800', color: colors.textPrimary },
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xl * 2 },
  card: {
    backgroundColor: colors.cardBackground, borderRadius: radius.lg, padding: spacing.md,
    borderWidth: 1, borderColor: colors.border, gap: 4,
  },
  lineTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  lineSub: { fontSize: fontSize.sm, color: colors.textSecondary },
  groupLabel: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, marginTop: spacing.xs },
  option: {
    backgroundColor: colors.cardBackground, borderRadius: radius.lg, padding: spacing.md,
    borderWidth: 1, borderColor: colors.border,
  },
  optionTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  optionSub: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 2 },
  input: {
    backgroundColor: colors.screenBackground, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2,
    fontSize: fontSize.sm, color: colors.textPrimary,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  rowLabel: { fontSize: fontSize.sm, color: colors.textSecondary },
  rowValue: { fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: '600' },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.xs, marginTop: spacing.xs },
  totalLabel: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  totalValue: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  err: { color: colors.error, fontWeight: '700', fontSize: fontSize.sm },
  payBtn: { alignItems: 'center', paddingVertical: spacing.md, borderRadius: radius.full },
  walletBtn: { backgroundColor: 'transparent', borderWidth: 2 },
  payText: { color: '#fff', fontWeight: '800', fontSize: fontSize.md },
  doneTitle: { fontSize: fontSize.xl, fontWeight: '800', color: colors.textPrimary },
  doneSub: { fontSize: fontSize.sm, color: colors.textSecondary, textAlign: 'center' },
  smallPrint: { fontSize: fontSize.xs, color: colors.textMuted },
});
