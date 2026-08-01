/**
 * app/product-detail.tsx — buyer view of a Shop Shetland product.
 * Variant chips, quantity, honest fulfilment promises, then → checkout.
 */

import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image, ActivityIndicator, useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { formatPence } from '@/lib/local-api';
import {
  fetchProduct, availableQty,
  type Product, type ProductVariant, type BusinessShipping,
} from '@/lib/products-api';

const S = SECTIONS.local;

export default function ProductDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { width } = useWindowDimensions();

  const [loading, setLoading] = useState(true);
  const [product, setProduct] = useState<Product | null>(null);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [shipping, setShipping] = useState<BusinessShipping | null>(null);
  const [businessName, setBusinessName] = useState('');
  const [variantId, setVariantId] = useState<string | null>(null);
  const [qty, setQty] = useState(1);

  useEffect(() => {
    if (!id) return;
    fetchProduct(id).then((d) => {
      if (d) {
        setProduct(d.product); setVariants(d.variants); setShipping(d.shipping);
        setBusinessName(d.businessName); setVariantId(d.variants[0]?.id ?? null);
      }
    }).finally(() => setLoading(false));
  }, [id]);

  if (loading) return <SafeAreaView style={styles.safe}><View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View></SafeAreaView>;
  if (!product || !product.is_active) {
    return <SafeAreaView style={styles.safe}><View style={styles.center}><Text style={styles.dim}>This product isn't available any more.</Text></View></SafeAreaView>;
  }

  const variant = variants.find((v) => v.id === variantId) ?? null;
  const avail = availableQty(product, variant);
  const unit = product.price_pence + (variant?.price_delta_pence ?? 0);
  const imgSize = Math.min(width, 560);

  const promises: string[] = [];
  if (shipping?.collect_enabled ?? true) promises.push(`Collect from ${businessName} — free${shipping?.collect_note ? ` (${shipping.collect_note})` : ''}`);
  if (!product.collect_only && shipping?.post_enabled) {
    promises.push(product.free_uk_post ? 'Free UK postage'
      : `UK postage from ${formatPence(shipping.post_shetland_pence ?? shipping.post_uk_pence ?? 0)}${shipping.free_over_pence ? ` · free over ${formatPence(shipping.free_over_pence)}` : ''}`);
  }
  if (product.collect_only) promises.push('Collect only — too precious to post');

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{businessName}</Text>
        <View style={{ width: 70 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false} style={{ alignSelf: 'center', width: imgSize }}>
          {(product.photos.length ? product.photos : [null]).map((p, i) => (
            p ? <Image key={i} source={{ uri: p }} style={{ width: imgSize, height: imgSize, borderRadius: radius.lg }} />
              : <View key={i} style={{ width: imgSize, height: imgSize, borderRadius: radius.lg, backgroundColor: S.light, alignItems: 'center', justifyContent: 'center' }}>
                  <FontAwesome5 name="shopping-bag" size={40} color={S.color} />
                </View>
          ))}
        </ScrollView>

        <Text style={styles.title}>{product.title}</Text>
        <Text style={[styles.price, { color: S.color }]}>{formatPence(unit)}</Text>
        {!!product.description && <Text style={styles.desc}>{product.description}</Text>}

        {variants.length > 0 && (
          <View style={styles.chipsRow}>
            {variants.map((v) => {
              const on = v.id === variantId;
              const vAvail = availableQty(product, v);
              return (
                <TouchableOpacity key={v.id} disabled={vAvail === 0}
                  onPress={() => { setVariantId(v.id); setQty(1); }}
                  style={[styles.chip, on && { backgroundColor: S.color, borderColor: S.color }, vAvail === 0 && { opacity: 0.4 }]}>
                  <Text style={[styles.chipText, on && { color: '#fff' }]}>
                    {v.name}{v.price_delta_pence ? ` +${formatPence(v.price_delta_pence)}` : ''}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {avail === 0 ? (
          <View style={styles.soldOut}><Text style={styles.soldOutText}>Sold out{product.stock_mode === 'one_off' ? ' — it was a one-off' : ''}</Text></View>
        ) : (
          <View style={styles.buyRow}>
            <View style={styles.qtyBox}>
              <TouchableOpacity onPress={() => setQty(Math.max(1, qty - 1))} hitSlop={8} style={styles.qtyBtn}><Text style={styles.qtyBtnText}>−</Text></TouchableOpacity>
              <Text style={styles.qtyText}>{qty}</Text>
              <TouchableOpacity onPress={() => setQty(Math.min(avail, qty + 1))} hitSlop={8} style={styles.qtyBtn}><Text style={styles.qtyBtnText}>＋</Text></TouchableOpacity>
            </View>
            <TouchableOpacity
              style={[styles.buyBtn, { backgroundColor: S.color }]}
              activeOpacity={0.85}
              onPress={() => router.push({
                pathname: '/product-checkout',
                params: { productId: product.id, variantId: variantId ?? '', qty: String(qty) },
              } as never)}
            >
              <Text style={styles.buyText}>Buy · {formatPence(unit * qty)}</Text>
            </TouchableOpacity>
          </View>
        )}

        {product.stock_mode === 'made_to_order' && (
          <Text style={styles.hint}>Made to order — allow about {product.lead_time_days ?? 14} days.</Text>
        )}
        {product.stock_mode === 'tracked' && avail <= 3 && avail < 99 && avail > 0 && (
          <Text style={[styles.hint, { color: '#b45309', fontWeight: '700' }]}>Only {avail} left.</Text>
        )}

        {promises.length > 0 && (
          <View style={styles.promises}>
            {promises.map((p) => <Text key={p} style={styles.promiseLine}>· {p}</Text>)}
          </View>
        )}
        <Text style={styles.smallPrint}>Sold by {businessName} · payment held safely by Stripe.</Text>
      </ScrollView>
    </SafeAreaView>
  );
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
  headerTitle: { flex: 1, textAlign: 'center', fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xl * 2 },
  title: { fontSize: fontSize.xl, fontWeight: '800', color: colors.textPrimary, marginTop: spacing.sm },
  price: { fontSize: fontSize.lg, fontWeight: '800' },
  desc: { fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 21 },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs },
  chip: {
    paddingHorizontal: spacing.md, paddingVertical: spacing.xs + 2, borderRadius: radius.full,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.cardBackground,
  },
  chipText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary },
  soldOut: { backgroundColor: colors.cardBackground, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.sm },
  soldOutText: { fontWeight: '800', color: colors.textSecondary },
  buyRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  qtyBox: {
    flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.full, backgroundColor: colors.cardBackground,
  },
  qtyBtn: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  qtyBtnText: { fontSize: fontSize.md, fontWeight: '800', color: colors.textSecondary },
  qtyText: { minWidth: 22, textAlign: 'center', fontWeight: '800', color: colors.textPrimary },
  buyBtn: { flex: 1, alignItems: 'center', paddingVertical: spacing.md, borderRadius: radius.full },
  buyText: { color: '#fff', fontWeight: '800', fontSize: fontSize.md },
  hint: { fontSize: fontSize.sm, color: colors.textSecondary },
  promises: {
    backgroundColor: colors.cardBackground, borderRadius: radius.md, padding: spacing.md,
    borderWidth: 1, borderColor: colors.border, marginTop: spacing.sm, gap: 3,
  },
  promiseLine: { fontSize: fontSize.sm, color: colors.textSecondary },
  smallPrint: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: spacing.xs },
});
