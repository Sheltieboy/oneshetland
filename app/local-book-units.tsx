/**
 * app/local-book-units.tsx
 *
 * Business-side: manage the non-time-based things this business sells —
 * tickets, class packs, day passes, gift vouchers. Reached from the Local
 * business dashboard → "Bookings" card → "Units".
 *
 * Optional finite stock, optional expiry from purchase, optional multi-use.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, Switch, Modal, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import {
  fetchBusinessUnitItems, createUnitItem, updateUnitItem, deleteUnitItem,
  formatPence,
  type BookUnitItem, type UnitItemUpsertInput,
} from '@/lib/book-api';
import { useAlert } from '@/components/BrandedAlert';

const S = SECTIONS.local;

export default function BookUnitsScreen() {
  const router = useRouter();
  const { alert } = useAlert();
  const { businessId } = useLocalSearchParams<{ businessId: string }>();

  const [items, setItems]     = useState<BookUnitItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<BookUnitItem | null>(null);
  const [showEditor, setShowEditor] = useState(false);

  const load = useCallback(async () => {
    if (!businessId) return;
    try {
      const rows = await fetchBusinessUnitItems(businessId, true);
      setItems(rows);
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => { load(); }, [load]);

  const openNew  = () => { setEditing(null);  setShowEditor(true); };
  const openEdit = (it: BookUnitItem) => { setEditing(it); setShowEditor(true); };

  const handleDelete = (it: BookUnitItem) => {
    alert({
      title:   `Remove "${it.name}"?`,
      message: 'It won\'t appear to new customers. Existing purchases stay as-is.',
      icon:    'trash',
      accent:  colors.error,
      actions: [
        { label: 'Cancel', style: 'cancel' },
        { label: 'Remove', style: 'destructive', onPress: async () => {
          await deleteUnitItem(it.id);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          load();
        }},
      ],
    });
  };

  if (!businessId) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}><Text style={styles.dim}>Missing business ID.</Text></View>
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
        <Text style={styles.headerTitle}>Units</Text>
        <TouchableOpacity
          onPress={openNew}
          hitSlop={12}
          style={{ width: 70, alignItems: 'flex-end' }}
        >
          <FontAwesome5 name="plus" size={16} color={S.color} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={S.color} />
        </View>
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>

          {items.length === 0 ? (
            <View style={styles.empty}>
              <View style={[styles.emptyIcon, { backgroundColor: S.light }]}>
                <FontAwesome5 name="ticket-alt" size={28} color={S.color} solid />
              </View>
              <Text style={styles.emptyTitle}>No units yet</Text>
              <Text style={styles.emptySub}>
                Sell tickets, class packs, day passes, or gift vouchers — things that aren't tied to a specific time slot.
              </Text>
              <TouchableOpacity
                style={[styles.primaryBtn, { backgroundColor: S.color }]}
                onPress={openNew}
                activeOpacity={0.85}
              >
                <FontAwesome5 name="plus" size={11} color="#fff" />
                <Text style={styles.primaryBtnText}>Add your first unit</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              {items.map(it => (
                <View key={it.id} style={[styles.itemCard, !it.is_active && { opacity: 0.55 }]}>
                  <View style={{ flex: 1 }}>
                    <View style={styles.itemRow}>
                      <Text style={styles.itemName}>{it.name}</Text>
                      {!it.is_active && (
                        <View style={styles.inactivePill}>
                          <Text style={styles.inactivePillText}>Hidden</Text>
                        </View>
                      )}
                    </View>
                    {it.description ? (
                      <Text style={styles.itemDesc} numberOfLines={2}>{it.description}</Text>
                    ) : null}
                    <View style={styles.itemMetaRow}>
                      <View style={styles.itemMeta}>
                        <FontAwesome5 name="pound-sign" size={9} color={colors.textMuted} />
                        <Text style={styles.itemMetaText}>{formatPence(it.price_pence)}</Text>
                      </View>
                      <View style={styles.itemMeta}>
                        <FontAwesome5 name="cubes" size={9} color={colors.textMuted} />
                        <Text style={styles.itemMetaText}>
                          {it.stock === null ? 'Unlimited' : `${it.stock} left`}
                        </Text>
                      </View>
                      {it.uses_per_purchase > 1 && (
                        <View style={styles.itemMeta}>
                          <FontAwesome5 name="redo" size={9} color={S.color} />
                          <Text style={[styles.itemMetaText, { color: S.color, fontWeight: '700' }]}>
                            {it.uses_per_purchase} uses each
                          </Text>
                        </View>
                      )}
                      {it.valid_days !== null && (
                        <View style={styles.itemMeta}>
                          <FontAwesome5 name="hourglass-half" size={9} color={colors.textMuted} />
                          <Text style={styles.itemMetaText}>{it.valid_days}d validity</Text>
                        </View>
                      )}
                    </View>
                  </View>
                  <View style={styles.itemActions}>
                    <TouchableOpacity onPress={() => openEdit(it)} hitSlop={10}>
                      <FontAwesome5 name="pen" size={12} color={S.color} />
                    </TouchableOpacity>
                    {it.is_active && (
                      <TouchableOpacity onPress={() => handleDelete(it)} hitSlop={10}>
                        <FontAwesome5 name="trash" size={12} color={colors.textMuted} />
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              ))}

              <TouchableOpacity
                style={[styles.addMoreBtn, { borderColor: S.color }]}
                onPress={openNew}
                activeOpacity={0.85}
              >
                <FontAwesome5 name="plus" size={11} color={S.color} />
                <Text style={[styles.addMoreText, { color: S.color }]}>Add another unit</Text>
              </TouchableOpacity>
            </>
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      )}

      <UnitEditor
        visible={showEditor}
        businessId={businessId}
        item={editing}
        onClose={() => setShowEditor(false)}
        onSaved={() => { setShowEditor(false); load(); }}
      />
    </SafeAreaView>
  );
}

// ── Unit editor modal ────────────────────────────────────────────────────────

function UnitEditor({
  visible, businessId, item, onClose, onSaved,
}: {
  visible: boolean;
  businessId: string;
  item: BookUnitItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = !item;

  const [name, setName]           = useState('');
  const [description, setDesc]    = useState('');
  const [priceText, setPrice]     = useState('');
  const [limitStock, setLimitStk] = useState(false);
  const [stockText, setStock]     = useState('');
  const [hasExpiry, setHasExpiry] = useState(false);
  const [validDaysText, setVd]    = useState('');
  const [usesText, setUses]       = useState('1');
  const [saving, setSaving]       = useState(false);

  useEffect(() => {
    if (visible) {
      setName(item?.name ?? '');
      setDesc(item?.description ?? '');
      setPrice(item ? (item.price_pence / 100).toFixed(2) : '');
      setLimitStk(item?.stock !== null && item?.stock !== undefined);
      setStock(item?.stock !== null && item?.stock !== undefined ? String(item.stock) : '');
      setHasExpiry(item?.valid_days !== null && item?.valid_days !== undefined);
      setVd(item?.valid_days !== null && item?.valid_days !== undefined ? String(item.valid_days) : '');
      setUses(String(item?.uses_per_purchase ?? 1));
    }
  }, [visible, item]);

  const save = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) return Alert.alert('Name required', 'Give your unit a short name.');

    const priceNum = parseFloat(priceText || '0');
    if (Number.isNaN(priceNum) || priceNum <= 0) {
      return Alert.alert('Invalid price', 'Enter a price greater than zero.');
    }
    const pricePence = Math.round(priceNum * 100);

    let stock: number | null = null;
    if (limitStock) {
      const stockNum = parseInt(stockText);
      if (Number.isNaN(stockNum) || stockNum < 0) {
        return Alert.alert('Stock needed', 'Enter a stock number, or turn the stock limit off.');
      }
      stock = stockNum;
    }

    let validDays: number | null = null;
    if (hasExpiry) {
      const vd = parseInt(validDaysText);
      if (Number.isNaN(vd) || vd <= 0) {
        return Alert.alert('Validity needed', 'Enter how many days the unit is valid, or turn the expiry off.');
      }
      validDays = vd;
    }

    const uses = parseInt(usesText) || 1;
    if (uses < 1 || uses > 999) {
      return Alert.alert('Invalid uses', 'Between 1 and 999.');
    }

    const payload: UnitItemUpsertInput = {
      name:              trimmedName,
      description:       description.trim() || null,
      price_pence:       pricePence,
      stock,
      valid_days:        validDays,
      uses_per_purchase: uses,
      is_active:         true,
    };

    setSaving(true);
    try {
      if (isNew) await createUnitItem(businessId, payload);
      else       await updateUnitItem(item!.id, payload);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onSaved();
    } catch (e: any) {
      Alert.alert('Save failed', e?.message ?? 'Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={modalStyles.overlay}>
          <View style={modalStyles.sheet}>
            <View style={modalStyles.handle} />
            <Text style={modalStyles.title}>
              {isNew ? 'New unit' : 'Edit unit'}
            </Text>

            <ScrollView style={{ maxHeight: 500 }} keyboardShouldPersistTaps="handled">
              <Text style={modalStyles.label}>Name</Text>
              <TextInput
                style={modalStyles.input}
                value={name} onChangeText={setName}
                placeholder="e.g. Day pass · 10-class pack · Festival ticket"
                placeholderTextColor={colors.textLight}
                maxLength={80}
              />

              <Text style={modalStyles.label}>Description (optional)</Text>
              <TextInput
                style={[modalStyles.input, { height: 70, textAlignVertical: 'top' }]}
                value={description} onChangeText={setDesc}
                placeholder="What does buying this give them?"
                placeholderTextColor={colors.textLight}
                multiline
                maxLength={240}
              />

              <Text style={modalStyles.label}>Price (£)</Text>
              <TextInput
                style={modalStyles.input}
                value={priceText} onChangeText={setPrice}
                keyboardType="decimal-pad"
                placeholder="0.00"
                placeholderTextColor={colors.textLight}
              />

              <Text style={modalStyles.label}>Uses per purchase</Text>
              <TextInput
                style={modalStyles.input}
                value={usesText} onChangeText={setUses}
                keyboardType="number-pad"
                placeholder="1"
                placeholderTextColor={colors.textLight}
              />
              <Text style={modalStyles.hintText}>
                1 = single use (one ticket). Higher for class packs (e.g. 10 uses = a 10-class pack).
              </Text>

              <View style={modalStyles.toggleRow}>
                <View style={{ flex: 1 }}>
                  <Text style={modalStyles.label}>Limit stock</Text>
                  <Text style={modalStyles.toggleSub}>
                    On for finite stock (e.g. 50 tickets). Off for unlimited supply.
                  </Text>
                </View>
                <Switch
                  value={limitStock}
                  onValueChange={setLimitStk}
                  trackColor={{ false: colors.border, true: S.color }}
                />
              </View>
              {limitStock && (
                <TextInput
                  style={modalStyles.input}
                  value={stockText} onChangeText={setStock}
                  keyboardType="number-pad"
                  placeholder="e.g. 50"
                  placeholderTextColor={colors.textLight}
                />
              )}

              <View style={modalStyles.toggleRow}>
                <View style={{ flex: 1 }}>
                  <Text style={modalStyles.label}>Expires after purchase</Text>
                  <Text style={modalStyles.toggleSub}>
                    On to set a validity window (e.g. 90 days). Off for no expiry.
                  </Text>
                </View>
                <Switch
                  value={hasExpiry}
                  onValueChange={setHasExpiry}
                  trackColor={{ false: colors.border, true: S.color }}
                />
              </View>
              {hasExpiry && (
                <>
                  <TextInput
                    style={modalStyles.input}
                    value={validDaysText} onChangeText={setVd}
                    keyboardType="number-pad"
                    placeholder="e.g. 90"
                    placeholderTextColor={colors.textLight}
                  />
                  <Text style={modalStyles.hintText}>Number of days from purchase before the unit expires.</Text>
                </>
              )}
            </ScrollView>

            <View style={modalStyles.actions}>
              <TouchableOpacity onPress={onClose} style={modalStyles.cancelBtn}>
                <Text style={modalStyles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[modalStyles.saveBtn, { backgroundColor: S.color }, saving && { opacity: 0.7 }]}
                onPress={save}
                disabled={saving}
                activeOpacity={0.85}
              >
                {saving
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={modalStyles.saveText}>{isNew ? 'Add unit' : 'Save changes'}</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: colors.navy },
  scroll:  { flex: 1, backgroundColor: colors.screenBackground },
  content: { padding: spacing.md, gap: 10 },
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

  empty:     { alignItems: 'center', gap: 10, paddingVertical: 40 },
  emptyIcon: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  emptyTitle:{ fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, marginTop: 4 },
  emptySub:  { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', paddingHorizontal: spacing.lg },

  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 12, paddingHorizontal: 18, borderRadius: radius.md, marginTop: 8,
  },
  primaryBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },

  itemCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: spacing.md, borderWidth: 1, borderColor: colors.border,
  },
  itemRow:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  itemName:  { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, flexShrink: 1 },
  itemDesc:  { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 3, lineHeight: 17 },

  itemMetaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8 },
  itemMeta:    { flexDirection: 'row', alignItems: 'center', gap: 4 },
  itemMetaText:{ fontSize: 11, color: colors.textMuted, fontWeight: '600' },

  itemActions: { gap: 14, alignItems: 'center', paddingTop: 4 },

  inactivePill:     { backgroundColor: colors.border, paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.full },
  inactivePillText: { fontSize: 9, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },

  addMoreBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 12, borderRadius: radius.md, borderWidth: 1.5, borderStyle: 'dashed',
    marginTop: 4,
  },
  addMoreText: { fontSize: fontSize.sm, fontWeight: '800' },
});

const modalStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet:   { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: spacing.lg, paddingBottom: 40, gap: 10 },
  handle:  { width: 36, height: 4, backgroundColor: colors.border, borderRadius: 2, alignSelf: 'center', marginBottom: 8 },
  title:   { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary, marginBottom: 4 },

  label:    { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary, marginTop: 8, marginBottom: 4 },
  hintText: { fontSize: 11, color: colors.textMuted, marginTop: 6, lineHeight: 16, fontStyle: 'italic' },
  input:    { backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 10, fontSize: fontSize.sm, color: colors.textPrimary },

  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 },
  toggleSub: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2, lineHeight: 16 },

  actions:    { flexDirection: 'row', gap: 10, marginTop: 16 },
  cancelBtn:  { flex: 1, alignItems: 'center', paddingVertical: 12 },
  cancelText: { fontSize: fontSize.sm, color: colors.textMuted, fontWeight: '700' },
  saveBtn:    { flex: 2, paddingVertical: 12, borderRadius: radius.md, alignItems: 'center' },
  saveText:   { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
});
