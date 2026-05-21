import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, Modal, FlatList } from 'react-native';
import { haptic } from '@/lib/haptics';

import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useRequest } from '@/context/RequestContext';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { REGIONS } from '@/constants/regions';
import { Input, KeyboardDoneBar } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { FormScrollView } from '@/components/ui/FormScrollView';
import { colors, fontSize, spacing, radius } from '@/constants/theme';

interface SavedAddress {
  id: string;
  label: string;
  address: string;
  postcode: string | null;
  delivery_instructions: string | null;
}

export default function RequestStep3() {
  const router = useRouter();
  const { formData, update } = useRequest();
  const { profile } = useAuth();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savedAddresses, setSavedAddresses] = useState<SavedAddress[]>([]);
  const [showPicker, setShowPicker] = useState(false);

  useEffect(() => {
    if (!profile?.id) return;
    supabase
      .from('saved_addresses')
      .select('id, label, address, postcode, delivery_instructions')
      .eq('user_id', profile.id)
      .order('created_at', { ascending: false })
      .then(({ data }) => setSavedAddresses((data as SavedAddress[]) ?? []));
  }, [profile?.id]);

  function applySavedAddress(addr: SavedAddress) {
    // Find the region slug that best matches — default to empty if no match
    const fullAddress = addr.postcode
      ? `${addr.address} ${addr.postcode}`
      : addr.address;

    update({
      destinationAddress: fullAddress,
      deliveryNotes: addr.delivery_instructions ?? formData.deliveryNotes,
    });
    setShowPicker(false);
    setErrors((e) => ({ ...e, destinationAddress: '' }));
  }

  function validate() {
    const e: Record<string, string> = {};
    if (!formData.destinationRegionSlug) e.region = 'Select a delivery area';
    if (!formData.destinationAddress.trim()) e.destinationAddress = 'Enter a delivery address';
    return e;
  }

  function next() {
    const e = validate();
    if (Object.keys(e).length > 0) { setErrors(e); return; }
    router.push('/(customer)/request/step-4');
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardDoneBar />
      <FormScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Pressable onPress={() => { haptic.light(); router.back(); }} style={styles.backBtn} hitSlop={12}>
            <Text style={styles.backText}>‹ Back</Text>
          </Pressable>
          <StepIndicator current={3} />
        </View>

        <View style={styles.categoryBadge}>
          <Text style={styles.categoryBadgeText}>{formData.categoryName}</Text>
        </View>

        <Text style={styles.heading}>Delivery details</Text>
        <Text style={styles.subheading}>Where should this be delivered to?</Text>

        {/* Region picker */}
        <Text style={styles.fieldLabel}>Delivery area *</Text>
        {errors.region ? <Text style={styles.errorText}>{errors.region}</Text> : null}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.regionScroll}
          contentContainerStyle={styles.regionRow}
        >
          {REGIONS.map((r) => {
            const selected = formData.destinationRegionSlug === r.slug;
            return (
              <Pressable
                key={r.slug}
                style={({ pressed }) => [
                  styles.regionChip,
                  selected && styles.regionChipSelected,
                  pressed && styles.regionChipPressed,
                ]}
                onPress={() => {
                  haptic.select();
                  update({ destinationRegionSlug: r.slug });
                  setErrors((e) => ({ ...e, region: '' }));
                }}
              >
                <Text style={[styles.regionChipText, selected && styles.regionChipTextSelected]}>
                  {r.name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {/* Saved address picker */}
        {savedAddresses.length > 0 && (
          <Pressable
            style={({ pressed }) => [styles.savedBtn, pressed && { opacity: 0.8 }]}
            onPress={() => { haptic.light(); setShowPicker(true); }}
          >
            <Text style={styles.savedBtnText}>📍 Use a saved address</Text>
          </Pressable>
        )}

        <Input
          label="Delivery address *"
          placeholder="e.g. 4 Harbour View, Scalloway"
          value={formData.destinationAddress}
          onChangeText={(v) => {
            update({ destinationAddress: v });
            setErrors((e) => ({ ...e, destinationAddress: '' }));
          }}
          error={errors.destinationAddress}
          autoCapitalize="words"
        />

        {/* Saved address modal */}
        <Modal visible={showPicker} animationType="slide" presentationStyle="pageSheet">
          <SafeAreaView style={modal.safe} edges={['top', 'bottom']}>
            <View style={modal.header}>
              <Text style={modal.title}>Saved addresses</Text>
              <Pressable onPress={() => { haptic.light(); setShowPicker(false); }} hitSlop={12}>
                <Text style={modal.close}>Done</Text>
              </Pressable>
            </View>
            <FlatList
              data={savedAddresses}
              keyExtractor={(item) => item.id}
              contentContainerStyle={modal.list}
              renderItem={({ item }) => (
                <Pressable
                  style={({ pressed }) => [modal.item, pressed && { opacity: 0.85 }]}
                  onPress={() => { haptic.select(); applySavedAddress(item); }}
                >
                  <View style={modal.itemIcon}>
                    <Text style={{ fontSize: 20 }}>📍</Text>
                  </View>
                  <View style={modal.itemInfo}>
                    <Text style={modal.itemLabel}>{item.label}</Text>
                    <Text style={modal.itemAddress}>{item.address}</Text>
                    {item.postcode && (
                      <Text style={modal.itemPostcode}>{item.postcode}</Text>
                    )}
                    {item.delivery_instructions && (
                      <Text style={modal.itemInstructions}>💬 {item.delivery_instructions}</Text>
                    )}
                  </View>
                  <Text style={modal.itemArrow}>›</Text>
                </TouchableOpacity>
              )}
            />
          </SafeAreaView>
        </Modal>

        <Input
          label="Area or village (optional)"
          placeholder="e.g. Near the pier"
          value={formData.destinationArea}
          onChangeText={(v) => update({ destinationArea: v })}
        />

        <Input
          label="Delivery notes (optional)"
          placeholder="e.g. Leave at the door, call on arrival"
          value={formData.deliveryNotes}
          onChangeText={(v) => update({ deliveryNotes: v })}
          multiline
          numberOfLines={3}
          style={{ minHeight: 80, textAlignVertical: 'top' }}
        />

        <Input
          label="Contact phone (optional)"
          placeholder="e.g. 07700 900000"
          value={formData.contactPhone}
          onChangeText={(v) => update({ contactPhone: v })}
          keyboardType="phone-pad"
          hint="In case the driver needs to reach you"
        />

        <Button
          label="Review & confirm →"
          onPress={next}
          variant="secondary"
          size="lg"
          fullWidth
          style={{ marginTop: spacing.xl }}
        />
      </FormScrollView>
    </SafeAreaView>
  );
}

function StepIndicator({ current }: { current: number }) {
  return (
    <View style={styles.steps}>
      {[1, 2, 3, 4].map((n) => (
        <View
          key={n}
          style={[
            styles.stepDot,
            n === current && styles.stepDotActive,
            n < current && styles.stepDotDone,
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  scroll: { flex: 1, backgroundColor: colors.screenBackground },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xl,
  },
  backBtn: { padding: 4 },
  backText: { fontSize: fontSize.sm, color: colors.navy, fontWeight: '600' },

  steps: { flexDirection: 'row', gap: 6 },
  stepDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.border },
  stepDotActive: { backgroundColor: colors.accent, width: 24 },
  stepDotDone: { backgroundColor: colors.navy },

  categoryBadge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.navy,
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    marginBottom: spacing.md,
  },
  categoryBadgeText: { fontSize: fontSize.xs, color: colors.white, fontWeight: '700' },

  heading: { fontSize: fontSize.xxl, fontWeight: '800', color: colors.navy, marginBottom: spacing.sm },
  subheading: { fontSize: fontSize.md, color: colors.textMuted, lineHeight: 22, marginBottom: spacing.xl },

  fieldLabel: { fontSize: fontSize.sm, fontWeight: '600', color: colors.navy, marginBottom: 8 },
  errorText: { fontSize: fontSize.xs, color: colors.error, marginBottom: spacing.sm },

  regionScroll: { marginBottom: spacing.md },
  regionRow: { flexDirection: 'row', gap: spacing.sm, paddingBottom: 4 },
  regionChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    backgroundColor: colors.white,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  regionChipSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  regionChipPressed: { opacity: 0.8 },
  regionChipText: { fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: '500' },
  regionChipTextSelected: { color: colors.white, fontWeight: '700' },

  savedBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.offWhite,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
    alignSelf: 'flex-start',
  },
  savedBtnText: { fontSize: fontSize.sm, color: colors.navy, fontWeight: '600' },
});

const modal = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: { fontSize: fontSize.lg, fontWeight: '700', color: colors.navy },
  close: { fontSize: fontSize.md, color: colors.accent, fontWeight: '600' },
  list: { padding: spacing.lg, gap: spacing.sm },
  item: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.md,
  },
  itemIcon: { paddingTop: 2 },
  itemInfo: { flex: 1 },
  itemLabel: { fontSize: fontSize.md, fontWeight: '700', color: colors.navy, marginBottom: 2 },
  itemAddress: { fontSize: fontSize.sm, color: colors.textPrimary, marginBottom: 2 },
  itemPostcode: { fontSize: fontSize.sm, color: colors.textMuted },
  itemInstructions: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 4 },
  itemArrow: { fontSize: 20, color: colors.textLight, alignSelf: 'center' },
});
