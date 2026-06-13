/**
 * local-offer-new.tsx — business owner creates a new offer
 */

import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  Alert, KeyboardAvoidingView, Platform, Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { Button } from '@/components/ui/Button';
import { SECTIONS } from '@/constants/sections';
import { createOffer, type DiscountType } from '@/lib/local-api';

const S = SECTIONS.local;

const DISCOUNT_TYPES: { id: DiscountType; label: string; icon: string }[] = [
  { id: 'percent',  label: '% off',      icon: 'percent' },
  { id: 'fixed',    label: '£ off',      icon: 'pound-sign' },
  { id: 'freebie',  label: 'Freebie',    icon: 'gift' },
  { id: 'bogo',     label: '2 for 1',    icon: 'plus-square' },
  { id: 'other',    label: 'Other',      icon: 'star' },
];

export default function NewOfferScreen() {
  const router = useRouter();
  const { screenWidth } = useAppLayout();
  const { businessId } = useLocalSearchParams<{ businessId: string }>();

  const [title, setTitle]             = useState('');
  const [description, setDescription] = useState('');
  const [type, setType]               = useState<DiscountType>('percent');
  const [value, setValue]             = useState('');
  const [validUntil, setValidUntil]   = useState<Date>(new Date(Date.now() + 7 * 86_400_000));
  const [maxRedemptions, setMaxRedemptions] = useState('');
  const [terms, setTerms]             = useState('');
  const [showDate, setShowDate]       = useState(false);
  const [saving, setSaving]           = useState(false);

  const valueNeeded = type === 'percent' || type === 'fixed';

  const submit = async () => {
    if (!businessId) return;
    if (!title.trim())  return Alert.alert('Title required', 'Give your offer a short title.');
    if (valueNeeded && !value) return Alert.alert('Value required', 'Enter the discount amount.');
    if (validUntil < new Date()) return Alert.alert('End date in the past', 'Pick a future date.');

    setSaving(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await createOffer(businessId, {
        title: title.trim(),
        description: description.trim() || null,
        discount_type: type,
        discount_value: valueNeeded ? parseFloat(value) : null,
        valid_from: new Date().toISOString(),
        valid_until: validUntil.toISOString(),
        terms: terms.trim() || null,
        max_redemptions: maxRedemptions ? parseInt(maxRedemptions) : null,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Offer live!', 'Followers have been notified.', [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } catch (e: any) {
      Alert.alert('Could not save', e.message ?? 'Try again');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScreenHeader title="New offer" onClose={() => router.back()} accent={S.color} />

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, contentContainer(screenWidth)]} keyboardShouldPersistTaps="handled">

          <View>
            <Text style={styles.label}>Title *</Text>
            <TextInput
              style={styles.input}
              value={title} onChangeText={setTitle}
              placeholder="e.g. Half-price Tuesday lunches"
              placeholderTextColor={colors.textLight}
            />
          </View>

          <View>
            <Text style={styles.label}>Description</Text>
            <TextInput
              style={[styles.input, { height: 80, textAlignVertical: 'top' }]}
              value={description} onChangeText={setDescription}
              placeholder="What's the offer? Any conditions?"
              placeholderTextColor={colors.textLight}
              multiline
            />
          </View>

          <View>
            <Text style={styles.label}>Discount type *</Text>
            <View style={styles.typeGrid}>
              {DISCOUNT_TYPES.map(d => {
                const active = type === d.id;
                return (
                  <TouchableOpacity
                    key={d.id}
                    style={[styles.typeBtn, active && { backgroundColor: S.color, borderColor: S.color }]}
                    onPress={() => { Haptics.selectionAsync(); setType(d.id); }}
                  >
                    <FontAwesome5 name={d.icon as any} size={12} color={active ? '#fff' : S.color} solid />
                    <Text style={[styles.typeText, active && { color: '#fff' }]}>{d.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {valueNeeded && (
            <View>
              <Text style={styles.label}>Value *</Text>
              <View style={styles.valueWrap}>
                <Text style={styles.valuePrefix}>{type === 'percent' ? '%' : '£'}</Text>
                <TextInput
                  style={styles.valueInput}
                  value={value} onChangeText={setValue}
                  placeholder={type === 'percent' ? '25' : '5.00'}
                  placeholderTextColor={colors.textLight}
                  keyboardType="decimal-pad"
                />
              </View>
            </View>
          )}

          <View>
            <Text style={styles.label}>Ends</Text>
            <TouchableOpacity style={styles.dateBtn} onPress={() => setShowDate(true)}>
              <FontAwesome5 name="calendar" size={13} color={S.color} solid />
              <Text style={styles.dateText}>
                {validUntil.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
              </Text>
            </TouchableOpacity>
          </View>

          <View>
            <Text style={styles.label}>Max redemptions (optional)</Text>
            <TextInput
              style={styles.input}
              value={maxRedemptions} onChangeText={setMaxRedemptions}
              placeholder="Leave blank for unlimited"
              placeholderTextColor={colors.textLight}
              keyboardType="number-pad"
            />
          </View>

          <View>
            <Text style={styles.label}>Terms (optional)</Text>
            <TextInput
              style={[styles.input, { height: 60, textAlignVertical: 'top' }]}
              value={terms} onChangeText={setTerms}
              placeholder="e.g. Dine-in only, not valid with other offers"
              placeholderTextColor={colors.textLight}
              multiline
            />
          </View>

          <Button
            label="Publish & notify followers"
            icon="bullhorn"
            color={S.color}
            fullWidth
            loading={saving}
            disabled={saving}
            onPress={submit}
            style={styles.saveBtn}
          />

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal visible={showDate} transparent animationType="slide" onRequestClose={() => setShowDate(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setShowDate(false)} />
        <View style={styles.modalSheet}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setShowDate(false)}>
              <Text style={styles.modalCancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Offer ends</Text>
            <TouchableOpacity onPress={() => setShowDate(false)}>
              <Text style={[styles.modalDone, { color: S.color }]}>Done</Text>
            </TouchableOpacity>
          </View>
          <DateTimePicker
            value={validUntil}
            mode="date"
            display="spinner"
            onChange={(_, d) => { if (d) setValidUntil(d); }}
            minimumDate={new Date()}
            style={{ height: 220 }}
          />
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.navy },
  scroll:  { flex: 1, backgroundColor: colors.screenBackground },
  content:{ padding: spacing.md, gap: spacing.md },

  label: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary, marginBottom: 8 },
  input: {
    backgroundColor: '#fff', borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, paddingVertical: 12,
    fontSize: fontSize.sm, color: colors.textPrimary,
  },

  typeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  typeBtn:  { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border },
  typeText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textPrimary },

  valueWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12 },
  valuePrefix: { fontSize: fontSize.lg, color: colors.textMuted, fontWeight: '700' },
  valueInput:  { flex: 1, paddingVertical: 12, fontSize: fontSize.md, color: colors.textPrimary, fontWeight: '700' },

  dateBtn: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 12 },
  dateText: { fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: '700' },

  saveBtn: {
    marginTop: 12,
  },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  modalSheet: { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 32 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border },
  modalCancel: { fontSize: fontSize.sm, color: colors.textMuted, fontWeight: '600' },
  modalTitle:  { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  modalDone:   { fontSize: fontSize.sm, fontWeight: '800' },
});
