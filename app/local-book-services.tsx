/**
 * app/local-book-services.tsx
 *
 * Business-side: manage the bookable services this business offers.
 * Reached from the Local business dashboard → "Bookings" card → "Services".
 *
 * Phase 1 of OneShetland Book.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { Sheet } from '@/components/ui/Sheet';
import { SECTIONS } from '@/constants/sections';
import {
  fetchBusinessServices, createService, updateService, deleteService,
  formatPence, formatDuration,
  type BookService, type ServiceUpsertInput,
} from '@/lib/book-api';
import { useAlert } from '@/components/BrandedAlert';

const S = SECTIONS.local;

export default function BookServicesScreen() {
  const router = useRouter();
  const { alert } = useAlert();
  const { businessId } = useLocalSearchParams<{ businessId: string }>();

  const [services, setServices] = useState<BookService[]>([]);
  const [loading, setLoading]   = useState(true);
  const [editing, setEditing]   = useState<BookService | null>(null);
  const [showEditor, setShowEditor] = useState(false);

  const load = useCallback(async () => {
    if (!businessId) return;
    try {
      const rows = await fetchBusinessServices(businessId, true);
      setServices(rows);
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => { load(); }, [load]);

  const openNew = () => { setEditing(null); setShowEditor(true); };
  const openEdit = (svc: BookService) => { setEditing(svc); setShowEditor(true); };

  const handleDelete = (svc: BookService) => {
    alert({
      title:   `Remove "${svc.name}"?`,
      message: 'It won\'t appear to new customers. Existing bookings stay as-is.',
      icon:    'trash',
      accent:  colors.error,
      actions: [
        { label: 'Cancel', style: 'cancel' },
        { label: 'Remove', style: 'destructive', onPress: async () => {
          await deleteService(svc.id);
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
        <Text style={styles.headerTitle}>Services</Text>
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

          {services.length === 0 ? (
            <View style={styles.empty}>
              <View style={[styles.emptyIcon, { backgroundColor: S.light }]}>
                <FontAwesome5 name="concierge-bell" size={28} color={S.color} solid />
              </View>
              <Text style={styles.emptyTitle}>No services yet</Text>
              <Text style={styles.emptySub}>
                Add the things people can book — a Ladies Cut, a Pedicure, a Table for 2…
              </Text>
              <TouchableOpacity
                style={[styles.primaryBtn, { backgroundColor: S.color }]}
                onPress={openNew}
                activeOpacity={0.85}
              >
                <FontAwesome5 name="plus" size={11} color="#fff" />
                <Text style={styles.primaryBtnText}>Add your first service</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              {services.map(svc => (
                <View key={svc.id} style={[styles.svcCard, !svc.is_active && { opacity: 0.55 }]}>
                  <View style={{ flex: 1 }}>
                    <View style={styles.svcRow}>
                      <Text style={styles.svcName}>{svc.name}</Text>
                      {!svc.is_active && (
                        <View style={styles.inactivePill}>
                          <Text style={styles.inactivePillText}>Hidden</Text>
                        </View>
                      )}
                    </View>
                    {svc.description ? (
                      <Text style={styles.svcDesc} numberOfLines={2}>{svc.description}</Text>
                    ) : null}
                    <View style={styles.svcMetaRow}>
                      <View style={styles.svcMeta}>
                        <FontAwesome5 name="clock" size={9} color={colors.textMuted} />
                        <Text style={styles.svcMetaText}>{formatDuration(svc.duration_minutes)}</Text>
                      </View>
                      {svc.buffer_minutes > 0 && (
                        <View style={styles.svcMeta}>
                          <FontAwesome5 name="hourglass-half" size={9} color={colors.textMuted} />
                          <Text style={styles.svcMetaText}>+{svc.buffer_minutes}m buffer</Text>
                        </View>
                      )}
                      {svc.capacity > 1 && (
                        <View style={styles.svcMeta}>
                          <FontAwesome5 name="users" size={9} color={colors.textMuted} />
                          <Text style={styles.svcMetaText}>{svc.capacity} at once</Text>
                        </View>
                      )}
                      <View style={styles.svcMeta}>
                        <FontAwesome5 name="pound-sign" size={9} color={colors.textMuted} />
                        <Text style={styles.svcMetaText}>{formatPence(svc.price_pence)}</Text>
                      </View>
                      {svc.requires_deposit && svc.deposit_pence > 0 && (
                        <View style={styles.svcMeta}>
                          <FontAwesome5 name="lock" size={9} color={S.color} />
                          <Text style={[styles.svcMetaText, { color: S.color, fontWeight: '700' }]}>
                            {formatPence(svc.deposit_pence)} deposit
                          </Text>
                        </View>
                      )}
                    </View>
                  </View>
                  <View style={styles.svcActions}>
                    <TouchableOpacity onPress={() => openEdit(svc)} hitSlop={10}>
                      <FontAwesome5 name="pen" size={12} color={S.color} />
                    </TouchableOpacity>
                    {svc.is_active && (
                      <TouchableOpacity onPress={() => handleDelete(svc)} hitSlop={10}>
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
                <Text style={[styles.addMoreText, { color: S.color }]}>Add another service</Text>
              </TouchableOpacity>
            </>
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      )}

      <ServiceEditor
        visible={showEditor}
        businessId={businessId}
        service={editing}
        onClose={() => setShowEditor(false)}
        onSaved={() => { setShowEditor(false); load(); }}
      />
    </SafeAreaView>
  );
}

// ── Service editor modal ─────────────────────────────────────────────────────

function ServiceEditor({
  visible, businessId, service, onClose, onSaved,
}: {
  visible: boolean;
  businessId: string;
  service: BookService | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = !service;
  const { alert } = useAlert();

  const [name, setName]           = useState('');
  const [description, setDesc]    = useState('');
  const [durationMin, setDur]     = useState('30');
  const [bufferMin, setBuffer]    = useState('0');
  const [capacityText, setCap]    = useState('1');
  const [priceText, setPrice]     = useState('');
  const [requiresDep, setReqDep]  = useState(false);
  const [depositText, setDeposit] = useState('');
  const [saving, setSaving]       = useState(false);

  useEffect(() => {
    if (visible) {
      setName(service?.name ?? '');
      setDesc(service?.description ?? '');
      setDur(String(service?.duration_minutes ?? 30));
      setBuffer(String(service?.buffer_minutes ?? 0));
      setCap(String(service?.capacity ?? 1));
      setPrice(service ? (service.price_pence / 100).toFixed(2) : '');
      setReqDep(service?.requires_deposit ?? false);
      setDeposit(service ? (service.deposit_pence / 100).toFixed(2) : '');
    }
  }, [visible, service]);

  const save = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) return alert({ title: 'Name required', message: 'Give your service a short name.' });

    const duration = parseInt(durationMin);
    if (!duration || duration < 5 || duration > 600) {
      return alert({ title: 'Invalid duration', message: 'Between 5 minutes and 10 hours.' });
    }
    const buffer = parseInt(bufferMin) || 0;
    if (buffer < 0) return alert({ title: 'Invalid buffer' });

    const capacity = parseInt(capacityText) || 1;
    if (capacity < 1 || capacity > 999) {
      return alert({ title: 'Invalid capacity', message: 'Between 1 and 999.' });
    }

    const priceNum = parseFloat(priceText || '0');
    if (Number.isNaN(priceNum) || priceNum < 0) return alert({ title: 'Invalid price' });
    const pricePence = Math.round(priceNum * 100);

    let depositPence = 0;
    if (requiresDep) {
      const depNum = parseFloat(depositText || '0');
      if (Number.isNaN(depNum) || depNum <= 0) {
        return alert({ title: 'Deposit needed', message: 'Enter a deposit amount, or turn the deposit toggle off.' });
      }
      depositPence = Math.round(depNum * 100);
      if (pricePence > 0 && depositPence > pricePence) {
        return alert({ title: 'Deposit too high', message: 'Deposit can\'t exceed the service price.' });
      }
    }

    const payload: ServiceUpsertInput = {
      name:             trimmedName,
      description:      description.trim() || null,
      duration_minutes: duration,
      buffer_minutes:   buffer,
      capacity,
      price_pence:      pricePence,
      requires_deposit: requiresDep,
      deposit_pence:    depositPence,
      is_active:        true,
    };

    setSaving(true);
    try {
      if (isNew) await createService(businessId, payload);
      else        await updateService(service!.id, payload);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onSaved();
    } catch (e: any) {
      alert({ title: 'Save failed', message: e?.message ?? 'Try again.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={isNew ? 'New service' : 'Edit service'}>
            <ScrollView style={{ maxHeight: 460 }} keyboardShouldPersistTaps="handled">
              <Text style={modalStyles.label}>Name</Text>
              <TextInput
                style={modalStyles.input}
                value={name} onChangeText={setName}
                placeholder="e.g. Ladies cut & blow-dry"
                placeholderTextColor={colors.textLight}
                maxLength={80}
              />

              <Text style={modalStyles.label}>Description (optional)</Text>
              <TextInput
                style={[modalStyles.input, { height: 70, textAlignVertical: 'top' }]}
                value={description} onChangeText={setDesc}
                placeholder="Include anything customers should know — what's included, prep required, etc."
                placeholderTextColor={colors.textLight}
                multiline
                maxLength={240}
              />

              <View style={modalStyles.row2}>
                <View style={{ flex: 1 }}>
                  <Text style={modalStyles.label}>Duration (mins)</Text>
                  <TextInput
                    style={modalStyles.input}
                    value={durationMin} onChangeText={setDur}
                    keyboardType="number-pad"
                    placeholder="30"
                    placeholderTextColor={colors.textLight}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={modalStyles.label}>Buffer after (mins)</Text>
                  <TextInput
                    style={modalStyles.input}
                    value={bufferMin} onChangeText={setBuffer}
                    keyboardType="number-pad"
                    placeholder="0"
                    placeholderTextColor={colors.textLight}
                  />
                </View>
              </View>

              <Text style={modalStyles.label}>How many can you serve at once?</Text>
              <TextInput
                style={modalStyles.input}
                value={capacityText} onChangeText={setCap}
                keyboardType="number-pad"
                placeholder="1"
                placeholderTextColor={colors.textLight}
              />
              <Text style={modalStyles.hintText}>
                1 = single resource (one table, one room). Higher = multiple tables / chairs / staff that can take bookings at the same time.
              </Text>

              <Text style={modalStyles.label}>Price (£)</Text>
              <TextInput
                style={modalStyles.input}
                value={priceText} onChangeText={setPrice}
                keyboardType="decimal-pad"
                placeholder="0.00  (leave 0 for 'price on request')"
                placeholderTextColor={colors.textLight}
              />

              <View style={modalStyles.depositRow}>
                <View style={{ flex: 1 }}>
                  <Text style={modalStyles.label}>Require a deposit</Text>
                  <Text style={modalStyles.depositSub}>
                    Customers pay the deposit to lock the slot. Refundable per your cancellation policy.
                  </Text>
                </View>
                <Switch
                  value={requiresDep}
                  onValueChange={setReqDep}
                  trackColor={{ false: colors.border, true: S.color }}
                />
              </View>

              {requiresDep && (
                <>
                  <Text style={modalStyles.label}>Deposit amount (£)</Text>
                  <TextInput
                    style={modalStyles.input}
                    value={depositText} onChangeText={setDeposit}
                    keyboardType="decimal-pad"
                    placeholder="e.g. 5.00"
                    placeholderTextColor={colors.textLight}
                  />
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
                  : <Text style={modalStyles.saveText}>{isNew ? 'Add service' : 'Save changes'}</Text>}
              </TouchableOpacity>
            </View>
    </Sheet>
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

  // Empty state
  empty:     { alignItems: 'center', gap: 10, paddingVertical: 40 },
  emptyIcon: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  emptyTitle:{ fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, marginTop: 4 },
  emptySub:  { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', paddingHorizontal: spacing.lg },

  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 12, paddingHorizontal: 18, borderRadius: radius.md, marginTop: 8,
  },
  primaryBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },

  // Service card
  svcCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: spacing.md, borderWidth: 1, borderColor: colors.border,
  },
  svcRow:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  svcName:  { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, flexShrink: 1 },
  svcDesc:  { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 3, lineHeight: 17 },

  svcMetaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8 },
  svcMeta:    { flexDirection: 'row', alignItems: 'center', gap: 4 },
  svcMetaText:{ fontSize: 11, color: colors.textMuted, fontWeight: '600' },

  svcActions: { gap: 14, alignItems: 'center', paddingTop: 4 },

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
  label:   { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary, marginTop: 8, marginBottom: 4 },
  hintText:{ fontSize: 11, color: colors.textMuted, marginTop: 6, lineHeight: 16, fontStyle: 'italic' },
  input:   { backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 10, fontSize: fontSize.sm, color: colors.textPrimary },

  row2:    { flexDirection: 'row', gap: 10 },

  depositRow:   { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8 },
  depositSub:   { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2, lineHeight: 16 },

  actions:    { flexDirection: 'row', gap: 10, marginTop: 16 },
  cancelBtn:  { flex: 1, alignItems: 'center', paddingVertical: 12 },
  cancelText: { fontSize: fontSize.sm, color: colors.textMuted, fontWeight: '700' },
  saveBtn:    { flex: 2, paddingVertical: 12, borderRadius: radius.md, alignItems: 'center' },
  saveText:   { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
});
