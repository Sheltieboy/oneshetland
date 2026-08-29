/**
 * app/business-products.tsx
 *
 * Merchant side of Shop Shetland: manage the product catalogue + the
 * one-per-business fulfilment rate card. Reached from the Local business
 * dashboard → "Products". Mirrors the web /business/[id]/manage/products.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Switch, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { CommercialTermsGate } from '@/components/CommercialTermsGate';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { Sheet } from '@/components/ui/Sheet';
import { ImagePickerField } from '@/components/ImagePickerField';
import { uploadBusinessImage } from '@/lib/image-upload';
import { useAlert } from '@/components/BrandedAlert';
import {
  fetchMerchantProducts, fetchProductVariants, upsertProduct, setProductActive,
  deleteProduct, fetchShipping, saveShipping, PRODUCT_CATEGORIES,
  type Product, type ProductVariant, type BusinessShipping, type StockMode,
} from '@/lib/products-api';
import { formatPence } from '@/lib/local-api';

const S = SECTIONS.local;

const pounds = (pence: number | null | undefined) => (pence == null ? '' : (pence / 100).toFixed(2));
const toPence = (s: string): number | null => {
  const n = Number(String(s).replace(/[£\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

type VariantRow = { id?: string; name: string; delta: string; stock: string };

function BusinessProductsBody() {
  const router = useRouter();
  const { alert } = useAlert();
  const { businessId } = useLocalSearchParams<{ businessId: string }>();

  const [items, setItems] = useState<Product[]>([]);
  const [variantsBy, setVariantsBy] = useState<Record<string, ProductVariant[]>>({});
  const [shipping, setShipping] = useState<BusinessShipping | null>(null);
  const [loading, setLoading] = useState(true);
  const [showEditor, setShowEditor] = useState(false);

  // Editor state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('other');
  const [price, setPrice] = useState('');
  const [photo1, setPhoto1] = useState<string | null>(null);
  const [photo2, setPhoto2] = useState<string | null>(null);
  const [stockMode, setStockMode] = useState<StockMode>('tracked');
  const [stock, setStock] = useState('');
  const [leadDays, setLeadDays] = useState('14');
  const [collectOnly, setCollectOnly] = useState(false);
  const [freeUkPost, setFreeUkPost] = useState(false);
  const [variants, setVariants] = useState<VariantRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Shipping card state
  const [collect, setCollect] = useState(true);
  const [collectNote, setCollectNote] = useState('');
  const [post, setPost] = useState(false);
  const [fetchIt, setFetchIt] = useState(false);
  const [shet, setShet] = useState('');
  const [uk, setUk] = useState('');
  const [extra, setExtra] = useState('');
  const [freeOver, setFreeOver] = useState('');
  const [shipSaving, setShipSaving] = useState(false);
  const [shipMsg, setShipMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!businessId) return;
    try {
      const [rows, ship] = await Promise.all([fetchMerchantProducts(businessId), fetchShipping(businessId)]);
      setItems(rows);
      setVariantsBy(await fetchProductVariants(rows.map((r) => r.id)));
      setShipping(ship);
      if (ship) {
        setCollect(ship.collect_enabled); setCollectNote(ship.collect_note ?? '');
        setPost(ship.post_enabled); setFetchIt(ship.fetch_enabled); setShet(pounds(ship.post_shetland_pence));
        setUk(pounds(ship.post_uk_pence)); setExtra(pounds(ship.post_per_extra_item_pence));
        setFreeOver(pounds(ship.free_over_pence));
      }
    } finally { setLoading(false); }
  }, [businessId]);
  useEffect(() => { load(); }, [load]);

  function openNew() {
    setEditingId(null); setTitle(''); setDescription(''); setCategory('other'); setPrice('');
    setPhoto1(null); setPhoto2(null); setStockMode('tracked'); setStock(''); setLeadDays('14');
    setCollectOnly(false); setFreeUkPost(false); setVariants([]); setErr(null);
    setShowEditor(true);
  }
  function openEdit(p: Product) {
    setEditingId(p.id); setTitle(p.title); setDescription(p.description ?? '');
    setCategory(p.category ?? 'other'); setPrice(pounds(p.price_pence));
    setPhoto1(p.photos[0] ?? null); setPhoto2(p.photos[1] ?? null);
    setStockMode(p.stock_mode); setStock(p.stock == null ? '' : String(p.stock));
    setLeadDays(p.lead_time_days == null ? '14' : String(p.lead_time_days));
    setCollectOnly(p.collect_only); setFreeUkPost(p.free_uk_post);
    setVariants((variantsBy[p.id] ?? []).map((v) => ({ id: v.id, name: v.name, delta: v.price_delta_pence ? pounds(v.price_delta_pence) : '', stock: v.stock == null ? '' : String(v.stock) })));
    setErr(null); setShowEditor(true);
  }

  async function save() {
    const p = toPence(price);
    if (!title.trim()) { setErr('Give it a title'); return; }
    if (!p || p < 50) { setErr('Price needs to be at least £0.50'); return; }
    if (!photo1) { setErr("Add a photo — listings without photos don't sell"); return; }
    setSaving(true); setErr(null);
    try {
      await upsertProduct({
        id: editingId ?? undefined,
        business_id: businessId!,
        title: title.trim(),
        description: description.trim() || null,
        category,
        price_pence: p,
        photos: [photo1, photo2].filter(Boolean) as string[],
        stock_mode: stockMode,
        stock: stockMode === 'tracked' && stock !== '' ? Math.max(0, Math.floor(Number(stock))) : null,
        lead_time_days: stockMode === 'made_to_order' ? Math.min(90, Math.max(1, Math.floor(Number(leadDays) || 14))) : null,
        collect_only: collectOnly,
        free_uk_post: freeUkPost,
        is_active: true,
      }, variants.map((v) => ({ id: v.id, name: v.name, price_delta_pence: toPence(v.delta) ?? 0, stock: v.stock === '' ? null : Math.max(0, Math.floor(Number(v.stock))) })));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setShowEditor(false);
      load();
    } catch (e) { setErr(e instanceof Error ? e.message : "Couldn't save"); }
    finally { setSaving(false); }
  }

  function confirmDelete(p: Product) {
    alert({
      title: `Delete "${p.title}"?`,
      message: 'Past orders keep their receipt copy; the listing goes for good.',
      icon: 'trash', accent: colors.error,
      actions: [
        { label: 'Cancel', style: 'cancel' },
        { label: 'Delete', style: 'destructive', onPress: async () => { await deleteProduct(p.id); load(); } },
      ],
    });
  }

  async function saveShip() {
    if (post && toPence(uk) == null && toPence(shet) == null) { setShipMsg('Set at least one postage price'); return; }
    setShipSaving(true); setShipMsg(null);
    try {
      await saveShipping({
        business_id: businessId!,
        collect_enabled: collect,
        collect_note: collectNote.trim() || null,
        post_enabled: post,
        fetch_enabled: fetchIt,
        post_shetland_pence: toPence(shet),
        post_uk_pence: toPence(uk),
        post_per_extra_item_pence: toPence(extra) ?? 0,
        free_over_pence: toPence(freeOver),
      });
      setShipMsg('Saved');
    } catch (e) { setShipMsg(e instanceof Error ? e.message : "Couldn't save"); }
    finally { setShipSaving(false); }
  }

  const stockLabel = (p: Product) =>
    p.stock_mode === 'made_to_order' ? `Made to order · ${p.lead_time_days ?? 14}d`
    : p.stock_mode === 'one_off' ? (p.sold_at ? 'Sold' : 'One-off')
    : p.stock == null ? 'In stock' : `${Math.max(0, p.stock - p.reserved)} in stock`;

  if (!businessId) {
    return <SafeAreaView style={styles.safe} edges={['top']}><View style={styles.center}><Text style={styles.dim}>Missing business ID.</Text></View></SafeAreaView>;
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Products</Text>
        <TouchableOpacity onPress={openNew} hitSlop={12} style={{ width: 70, alignItems: 'flex-end' }}>
          <FontAwesome5 name="plus" size={16} color={S.color} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          {items.length === 0 ? (
            <View style={styles.empty}>
              <View style={[styles.emptyIcon, { backgroundColor: S.light }]}>
                <FontAwesome5 name="shopping-bag" size={28} color={S.color} solid />
              </View>
              <Text style={styles.emptyTitle}>Nothing for sale yet</Text>
              <Text style={styles.emptySub}>Add your first product — it appears on your listing and across OneShetland. 5% per sale, and we promote your shop.</Text>
              <TouchableOpacity style={[styles.primaryBtn, { backgroundColor: S.color }]} onPress={openNew} activeOpacity={0.85}>
                <FontAwesome5 name="plus" size={11} color="#fff" />
                <Text style={styles.primaryBtnText}>Add a product</Text>
              </TouchableOpacity>
            </View>
          ) : items.map((p) => (
            <View key={p.id} style={[styles.row, !p.is_active && { opacity: 0.55 }]}>
              {p.photos[0]
                ? <Image source={{ uri: p.photos[0] }} style={styles.rowImg} />
                : <View style={[styles.rowImg, { backgroundColor: S.light, alignItems: 'center', justifyContent: 'center' }]}><FontAwesome5 name="shopping-bag" size={16} color={S.color} /></View>}
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>{p.title}</Text>
                <Text style={styles.rowSub}>{formatPence(p.price_pence)} · {stockLabel(p)}{p.is_active ? '' : ' · hidden'}</Text>
              </View>
              <TouchableOpacity onPress={() => openEdit(p)} hitSlop={8} style={styles.iconBtn}>
                <FontAwesome5 name="pen" size={13} color={colors.textSecondary} />
              </TouchableOpacity>
              <TouchableOpacity onPress={async () => { await setProductActive(p.id, !p.is_active); load(); }} hitSlop={8} style={styles.iconBtn}>
                <FontAwesome5 name={p.is_active ? 'eye-slash' : 'eye'} size={13} color={colors.textSecondary} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => confirmDelete(p)} hitSlop={8} style={styles.iconBtn}>
                <FontAwesome5 name="trash" size={13} color={colors.error} />
              </TouchableOpacity>
            </View>
          ))}

          {/* ── Fulfilment rate card ─────────────────────────────────────── */}
          <View style={styles.shipCard}>
            <Text style={styles.shipTitle}>Getting orders to customers</Text>
            <Text style={styles.shipSub}>Set once — applies to every product.</Text>

            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Collect from us — free</Text>
              <Switch value={collect} onValueChange={setCollect} trackColor={{ true: S.color }} />
            </View>
            {collect && (
              <TextInput style={styles.input} value={collectNote} onChangeText={setCollectNote}
                placeholder="Pickup note — e.g. 'Commercial St, Mon–Sat 9–5'" placeholderTextColor={colors.textMuted} />
            )}

            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Post orders</Text>
              <Switch value={post} onValueChange={setPost} trackColor={{ true: S.color }} />
            </View>
            {post && (
              <View style={{ gap: spacing.sm }}>
                <PriceInput label="Within Shetland £" value={shet} onChange={setShet} placeholder="same as UK" />
                <PriceInput label="Rest of the UK £" value={uk} onChange={setUk} placeholder="4.95" />
                <PriceInput label="Each extra item +£" value={extra} onChange={setExtra} placeholder="0" />
                <PriceInput label="Free postage over £" value={freeOver} onChange={setFreeOver} placeholder="—" />
              </View>
            )}
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Fetch delivery 🚗</Text>
              <Switch value={fetchIt} onValueChange={setFetchIt} trackColor={{ true: S.color }} />
            </View>
            <Text style={styles.shipSub}>
              A OneShetland community driver collects the order from you and takes it to the buyer, usually within a day or two.
              The buyer pays the driver&rsquo;s fee — nothing for you to set up; just have the order ready when a driver&rsquo;s assigned.
            </Text>

            {shipMsg && <Text style={styles.shipMsg}>{shipMsg}</Text>}
            <TouchableOpacity style={[styles.primaryBtn, { backgroundColor: S.color, alignSelf: 'flex-end' }]} onPress={saveShip} disabled={shipSaving}>
              <Text style={styles.primaryBtnText}>{shipSaving ? 'Saving…' : 'Save'}</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      )}

      {/* ── Editor sheet ───────────────────────────────────────────────── */}
      <Sheet visible={showEditor} onClose={() => setShowEditor(false)} title={editingId ? 'Edit product' : 'New product'}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: spacing.xl, gap: spacing.sm }}>
          <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholder="Title" placeholderTextColor={colors.textMuted} maxLength={200} />
          <TextInput style={[styles.input, { minHeight: 70 }]} value={description} onChangeText={setDescription} multiline placeholder="A couple of sentences about it…" placeholderTextColor={colors.textMuted} />
          <PriceInput label="Price £" value={price} onChange={setPrice} placeholder="0.00" />

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.xs }}>
            {PRODUCT_CATEGORIES.map((c) => (
              <TouchableOpacity key={c.value} onPress={() => setCategory(c.value)}
                style={[styles.chip, category === c.value && { backgroundColor: S.color, borderColor: S.color }]}>
                <Text style={[styles.chipText, category === c.value && { color: '#fff' }]}>{c.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          <ImagePickerField label="Main photo" value={photo1} onChange={setPhoto1}
            upload={(f) => uploadBusinessImage(businessId!, 'product', f)} aspect={[1, 1]} />
          <ImagePickerField label="Second photo (optional)" value={photo2} onChange={setPhoto2}
            upload={(f) => uploadBusinessImage(businessId!, 'product', f)} aspect={[1, 1]} />

          <View style={{ flexDirection: 'row', gap: spacing.xs, flexWrap: 'wrap' }}>
            {([['tracked', 'I have stock'], ['made_to_order', 'Made to order'], ['one_off', 'One-off']] as [StockMode, string][]).map(([m, l]) => (
              <TouchableOpacity key={m} onPress={() => setStockMode(m)}
                style={[styles.chip, stockMode === m && { backgroundColor: S.color, borderColor: S.color }]}>
                <Text style={[styles.chipText, stockMode === m && { color: '#fff' }]}>{l}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {stockMode === 'tracked' && (
            <TextInput style={styles.input} value={stock} onChangeText={setStock} keyboardType="number-pad"
              placeholder="Quantity (blank = plenty)" placeholderTextColor={colors.textMuted} />
          )}
          {stockMode === 'made_to_order' && (
            <PriceInput label="Allow (days)" value={leadDays} onChange={setLeadDays} placeholder="14" />
          )}

          <Text style={styles.groupLabel}>Options (sizes, colours — optional)</Text>
          {variants.map((v, i) => (
            <View key={i} style={{ flexDirection: 'row', gap: spacing.xs, alignItems: 'center' }}>
              <TextInput style={[styles.input, { flex: 1 }]} value={v.name}
                onChangeText={(t) => setVariants(variants.map((x, j) => j === i ? { ...x, name: t } : x))}
                placeholder="e.g. Medium · Navy" placeholderTextColor={colors.textMuted} />
              <TextInput style={[styles.input, { width: 70 }]} value={v.delta}
                onChangeText={(t) => setVariants(variants.map((x, j) => j === i ? { ...x, delta: t } : x))}
                keyboardType="decimal-pad" placeholder="+£" placeholderTextColor={colors.textMuted} />
              <TextInput style={[styles.input, { width: 60 }]} value={v.stock}
                onChangeText={(t) => setVariants(variants.map((x, j) => j === i ? { ...x, stock: t } : x))}
                keyboardType="number-pad" placeholder="qty" placeholderTextColor={colors.textMuted} />
              <TouchableOpacity onPress={() => setVariants(variants.filter((_, j) => j !== i))} hitSlop={8}>
                <FontAwesome5 name="times" size={14} color={colors.error} />
              </TouchableOpacity>
            </View>
          ))}
          <TouchableOpacity onPress={() => setVariants([...variants, { name: '', delta: '', stock: '' }])}>
            <Text style={{ color: S.color, fontWeight: '700', fontSize: fontSize.sm }}>＋ Add option</Text>
          </TouchableOpacity>

          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Collect only (no posting)</Text>
            <Switch value={collectOnly} onValueChange={setCollectOnly} trackColor={{ true: S.color }} />
          </View>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Free UK postage</Text>
            <Switch value={freeUkPost} onValueChange={setFreeUkPost} trackColor={{ true: S.color }} />
          </View>

          {err && <Text style={{ color: colors.error, fontSize: fontSize.sm, fontWeight: '600' }}>{err}</Text>}
          <TouchableOpacity style={[styles.primaryBtn, { backgroundColor: S.color }]} onPress={save} disabled={saving} activeOpacity={0.85}>
            <Text style={styles.primaryBtnText}>{saving ? 'Saving…' : editingId ? 'Save changes' : 'Add product'}</Text>
          </TouchableOpacity>
        </ScrollView>
      </Sheet>
    </SafeAreaView>
  );
}

function PriceInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <View style={styles.priceRow}>
      <Text style={styles.priceLabel}>{label}</Text>
      <TextInput style={styles.priceInput} value={value} onChangeText={onChange} keyboardType="decimal-pad"
        placeholder={placeholder} placeholderTextColor={colors.textMuted} />
    </View>
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
  headerTitle: { fontSize: fontSize.lg, fontWeight: '800', color: colors.textPrimary },
  scroll: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xl * 2 },
  empty: { alignItems: 'center', paddingVertical: spacing.xl * 2, gap: spacing.sm },
  emptyIcon: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: fontSize.lg, fontWeight: '800', color: colors.textPrimary },
  emptySub: { fontSize: fontSize.sm, color: colors.textSecondary, textAlign: 'center', paddingHorizontal: spacing.lg },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2, borderRadius: radius.full, marginTop: spacing.sm,
  },
  primaryBtnText: { color: '#fff', fontWeight: '800', fontSize: fontSize.sm },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: colors.cardBackground,
    borderRadius: radius.lg, padding: spacing.sm, borderWidth: 1, borderColor: colors.border,
  },
  rowImg: { width: 52, height: 52, borderRadius: radius.md },
  rowTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.textPrimary },
  rowSub: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 2 },
  iconBtn: { padding: spacing.xs },
  shipCard: {
    marginTop: spacing.lg, backgroundColor: colors.cardBackground, borderRadius: radius.lg,
    padding: spacing.lg, borderWidth: 1, borderColor: colors.border, gap: spacing.sm,
  },
  shipTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  shipSub: { fontSize: fontSize.xs, color: colors.textSecondary },
  shipMsg: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textSecondary },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 },
  switchLabel: { fontSize: fontSize.sm, fontWeight: '600', color: colors.textPrimary, flex: 1, paddingRight: spacing.sm },
  input: {
    backgroundColor: colors.screenBackground, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2,
    fontSize: fontSize.sm, color: colors.textPrimary,
  },
  priceRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: spacing.md, backgroundColor: colors.screenBackground,
  },
  priceLabel: { fontSize: fontSize.sm, color: colors.textSecondary, fontWeight: '600' },
  priceInput: { width: 90, textAlign: 'right', paddingVertical: spacing.sm + 2, fontSize: fontSize.sm, color: colors.textPrimary },
  chip: {
    paddingHorizontal: spacing.md, paddingVertical: spacing.xs + 2, borderRadius: radius.full,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.cardBackground,
  },
  chipText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textSecondary },
  groupLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary, marginTop: spacing.xs },
});

/**
 * Commercial screen: the business must have accepted the business & selling
 * terms first. One acceptance covers every commercial screen for that business;
 * Directory management is never gated. Same RPCs, event type and version as the
 * website — see lib/commercial-terms.ts.
 */
export default function BusinessProductsScreen() {
  const { businessId } = useLocalSearchParams<{ businessId?: string }>();
  return (
    <CommercialTermsGate businessId={businessId} feature="Products">
      <BusinessProductsBody />
    </CommercialTermsGate>
  );
}
