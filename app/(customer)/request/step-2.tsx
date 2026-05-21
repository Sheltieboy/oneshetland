import React, { useState } from 'react';
import { View, Text, Pressable, Switch, StyleSheet, LogBox } from 'react-native';

LogBox.ignoreLogs(['VirtualizedLists should never be nested']);
import { haptic } from '@/lib/haptics';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useRequest } from '@/context/RequestContext';
import { Input, KeyboardDoneBar } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { FormScrollView } from '@/components/ui/FormScrollView';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { GooglePlacesAutocomplete } from 'react-native-google-places-autocomplete';

const GOOGLE_KEY = process.env.EXPO_PUBLIC_GOOGLE_PLACES_KEY ?? '';

export default function RequestStep2() {
  const router = useRouter();
  const { formData, update } = useRequest();
  const [errors, setErrors] = useState<Record<string, string>>({});

  function validate() {
    const e: Record<string, string> = {};
    if (!formData.pickupLocation.trim()) e.pickupLocation = 'Search for the pickup location';
    return e;
  }

  function next() {
    const e = validate();
    if (Object.keys(e).length > 0) { setErrors(e); return; }
    router.push('/(customer)/request/step-3');
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardDoneBar />
      <View style={styles.navHeader}>
        <Pressable onPress={() => { haptic.light(); router.back(); }} hitSlop={12}>
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
        <StepIndicator current={2} />
      </View>

      <FormScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="always"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.categoryBadge}>
          <Text style={styles.categoryBadgeText}>
            {formData.categoryName || 'Collection'}
          </Text>
        </View>

        <Text style={styles.heading}>Pickup details</Text>
        <Text style={styles.subheading}>Where should the driver collect from?</Text>

        {/* Unified place search */}
        <View style={styles.placesWrapper}>
          <Text style={styles.fieldLabel}>Shop or pickup address *</Text>
          <Text style={styles.fieldHint}>Search by shop name, street, or postcode</Text>
          {errors.pickupLocation ? <Text style={styles.errorText}>{errors.pickupLocation}</Text> : null}
          <GooglePlacesAutocomplete
            placeholder="e.g. Lerwick Co-op, 16 Commercial Street…"
            minLength={2}
            onPress={(data, details) => {
              const full = details?.formatted_address ?? data.description;
              const name = data.structured_formatting?.main_text ?? data.description.split(',')[0].trim();
              const postcode = (details?.address_components ?? [])
                .find((c: any) => c.types.includes('postal_code'))?.long_name ?? '';
              const lat = details?.geometry?.location?.lat ?? null;
              const lng = details?.geometry?.location?.lng ?? null;
              update({ pickupLocation: full, pickupName: name, pickupPostcode: postcode, pickupLat: lat, pickupLng: lng });
              setErrors((e) => ({ ...e, pickupLocation: '' }));
              haptic.select();
            }}
            query={{
              key: GOOGLE_KEY,
              language: 'en',
              components: 'country:gb',
              location: '60.155,-1.145',
              radius: '50000',
            }}
            textInputProps={{
              value: formData.pickupLocation,
              onChangeText: (v: string) => {
                update({ pickupLocation: v, pickupName: v });
                setErrors((e) => ({ ...e, pickupLocation: '' }));
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
                borderColor: errors.pickupLocation ? colors.error : colors.border,
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
            nearbyPlacesAPI="GooglePlacesSearch"
            debounce={300}
          />
        </View>

        <Input
          label="Collection notes (optional)"
          placeholder="e.g. Ask for the order under Smith, ring the side bell"
          value={formData.pickupNotes}
          onChangeText={(v) => update({ pickupNotes: v })}
          multiline
          numberOfLines={3}
          style={{ minHeight: 80, textAlignVertical: 'top' }}
        />

        <View style={styles.toggleSection}>
          <ToggleRow
            label="Already paid"
            hint="The item is paid for — the driver just needs to collect."
            value={formData.alreadyPaid}
            onValueChange={(v) => update({ alreadyPaid: v })}
          />
          <View style={styles.divider} />
          <ToggleRow
            label="Ready for collection"
            hint="The item is packaged and waiting to be picked up now."
            value={formData.readyForCollection}
            onValueChange={(v) => update({ readyForCollection: v })}
          />
        </View>

        <Button
          label="Continue to delivery details →"
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

function ToggleRow({ label, hint, value, onValueChange }: {
  label: string; hint: string; value: boolean; onValueChange: (v: boolean) => void;
}) {
  return (
    <View style={toggleStyles.row}>
      <View style={toggleStyles.text}>
        <Text style={toggleStyles.label}>{label}</Text>
        <Text style={toggleStyles.hint}>{hint}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: colors.border, true: colors.accent }}
        thumbColor={colors.white}
      />
    </View>
  );
}

const toggleStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.md, gap: spacing.md },
  text: { flex: 1 },
  label: { fontSize: fontSize.md, fontWeight: '600', color: colors.navy, marginBottom: 2 },
  hint: { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 16 },
});

function StepIndicator({ current }: { current: number }) {
  return (
    <View style={styles.steps}>
      {[1, 2, 3, 4].map((n) => (
        <View key={n} style={[styles.stepDot, n === current && styles.stepDotActive, n < current && styles.stepDotDone]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  scroll: { flex: 1, backgroundColor: colors.screenBackground },

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

  content: { padding: spacing.lg, paddingBottom: spacing.xxl },

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

  placesWrapper: { marginBottom: spacing.md, zIndex: 10 },
  fieldLabel: { fontSize: fontSize.sm, fontWeight: '600', color: colors.navy, marginBottom: 2 },
  fieldHint: { fontSize: fontSize.xs, color: colors.textMuted, marginBottom: 6 },
  errorText: { fontSize: fontSize.xs, color: colors.error, marginBottom: 4 },

  toggleSection: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  divider: { height: 1, backgroundColor: colors.border },
});
