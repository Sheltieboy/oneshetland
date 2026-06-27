import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, Modal, FlatList, LogBox } from 'react-native';

LogBox.ignoreLogs(['VirtualizedLists should never be nested']);
import { haptic } from '@/lib/haptics';
import {
  GooglePlacesAutocomplete as GooglePlacesAutocompleteRaw,
  type GooglePlaceData,
  type GooglePlaceDetail,
} from 'react-native-google-places-autocomplete';

// This package version's type defs omit `flatListProps` (valid at runtime —
// needed so the results dropdown scrolls correctly inside the form ScrollView).
const GooglePlacesAutocomplete = GooglePlacesAutocompleteRaw as unknown as React.ComponentType<any>;

const GOOGLE_KEY = process.env.EXPO_PUBLIC_GOOGLE_PLACES_KEY ?? '';

import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useRequest } from '@/context/RequestContext';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
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
    const fullAddress = addr.postcode
      ? `${addr.address} ${addr.postcode}`
      : addr.address;
    update({
      destinationAddress: fullAddress,
      destinationPostcode: addr.postcode ?? '',
      deliveryNotes: addr.delivery_instructions ?? formData.deliveryNotes,
    });
    setShowPicker(false);
    setErrors((e) => ({ ...e, destinationAddress: '' }));
  }

  function validate() {
    const e: Record<string, string> = {};
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
      {/* Nav header — matches other steps */}
      <View style={styles.navHeader}>
        <Pressable onPress={() => { haptic.light(); router.back(); }} hitSlop={12}>
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
        <StepIndicator current={3} />
      </View>

      <FormScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="always"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.categoryBadge}>
          <Text style={styles.categoryBadgeText}>{formData.categoryName}</Text>
        </View>

        <View style={styles.headingRow}>
          <View style={styles.headingIcon}>
            <Text style={{ fontSize: 22 }}>📍</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.heading}>Delivery details</Text>
            <Text style={styles.subheading}>Where should this be delivered to?</Text>
          </View>
        </View>

        {/* Saved address shortcut */}
        {savedAddresses.length > 0 && (
          <Pressable
            style={({ pressed }) => [styles.savedBtn, pressed && styles.savedBtnPressed]}
            onPress={() => { haptic.light(); setShowPicker(true); }}
          >
            <Text style={{ fontSize: 18 }}>🏠</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.savedBtnTitle}>Use a saved address</Text>
              <Text style={styles.savedBtnHint}>Pick from your saved locations</Text>
            </View>
            <Text style={styles.savedBtnArrow}>›</Text>
          </Pressable>
        )}

        {/* Google Places autocomplete for delivery address */}
        <View style={styles.placesWrapper}>
          <Text style={styles.fieldLabel}>Delivery address *</Text>
          <Text style={styles.fieldHint}>Search by street, postcode or landmark</Text>
          {errors.destinationAddress ? <Text style={styles.errorText}>{errors.destinationAddress}</Text> : null}
          <GooglePlacesAutocomplete
            placeholder="e.g. 4 Harbour View, Scalloway"
            minLength={2}
            onPress={(data: GooglePlaceData, details: GooglePlaceDetail | null) => {
              const full = details?.formatted_address ?? data.description;
              const postcode = (details?.address_components ?? [])
                .find((c: any) => c.types.includes('postal_code'))?.long_name ?? '';
              const lat = details?.geometry?.location?.lat ?? null;
              const lng = details?.geometry?.location?.lng ?? null;
              update({ destinationAddress: full, destinationPostcode: postcode, destinationLat: lat, destinationLng: lng });
              setErrors((e) => ({ ...e, destinationAddress: '' }));
              haptic.select();
            }}
            query={{
              key: GOOGLE_KEY,
              language: 'en',
              components: 'country:gb',
              location: '60.155,-1.145',
              radius: '50000',
              types: 'address',
            }}
            textInputProps={{
              value: formData.destinationAddress,
              onChangeText: (v: string) => {
                update({ destinationAddress: v });
                setErrors((e) => ({ ...e, destinationAddress: '' }));
              },
              placeholderTextColor: colors.textLight,
              autoCorrect: false,
              autoCapitalize: 'none',
            }}
            styles={{
              textInputContainer: { backgroundColor: 'transparent' },
              textInput: {
                backgroundColor: colors.white,
                borderWidth: 1.5,
                borderColor: errors.destinationAddress ? colors.error : colors.border,
                borderRadius: radius.md,
                fontSize: fontSize.md,
                color: colors.textPrimary,
                paddingHorizontal: spacing.md,
                height: 48,
                marginBottom: 0,
              },
              listView: {
                backgroundColor: colors.white,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: colors.border,
                marginTop: 4,
                elevation: 6,
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 3 },
                shadowOpacity: 0.12,
                shadowRadius: 10,
              },
              row: {
                paddingVertical: spacing.md,
                paddingHorizontal: spacing.md,
                borderBottomWidth: 1,
                borderBottomColor: colors.border,
              },
              description: { fontSize: fontSize.sm, color: colors.textPrimary },
              poweredContainer: { display: 'none' },
            }}
            flatListProps={{ nestedScrollEnabled: true, keyboardShouldPersistTaps: 'always' }}
            fetchDetails={true}
            enablePoweredByContainer={false}
            keepResultsAfterBlur={false}
            debounce={300}
          />
        </View>

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
                </Pressable>
              )}
            />
          </SafeAreaView>
        </Modal>

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

  navHeader: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  backText: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.sm, fontWeight: '500' },

  steps: { flexDirection: 'row', gap: 6 },
  stepDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.25)' },
  stepDotActive: { backgroundColor: colors.accent, width: 24, borderRadius: 4 },
  stepDotDone: { backgroundColor: 'rgba(255,255,255,0.6)' },

  categoryBadge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.navy,
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    marginBottom: spacing.md,
  },
  categoryBadgeText: { fontSize: fontSize.xs, color: colors.white, fontWeight: '700' },

  headingRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    marginBottom: spacing.xl,
  },
  headingIcon: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.accentLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
    flexShrink: 0,
  },
  heading: { fontSize: fontSize.xxl, fontWeight: '800', color: colors.navy, marginBottom: 4 },
  subheading: { fontSize: fontSize.sm, color: colors.textMuted, lineHeight: 20 },

  fieldLabel: { fontSize: fontSize.sm, fontWeight: '600', color: colors.navy, marginBottom: 2 },
  fieldHint: { fontSize: fontSize.xs, color: colors.textMuted, marginBottom: 6 },
  errorText: { fontSize: fontSize.xs, color: colors.error, marginBottom: 4 },
  placesWrapper: { marginBottom: spacing.sm, zIndex: 10 },

  savedBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.white,
    borderWidth: 1.5,
    borderColor: colors.border,
    marginBottom: spacing.lg,
    gap: spacing.md,
  },
  savedBtnPressed: { backgroundColor: colors.offWhite },
  savedBtnTitle: { fontSize: fontSize.sm, fontWeight: '700', color: colors.navy },
  savedBtnHint: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  savedBtnArrow: { fontSize: 22, color: colors.textLight },
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
