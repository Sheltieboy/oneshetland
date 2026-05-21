import React, { useState } from 'react';
import { View, Text, ScrollView, Pressable, Switch, StyleSheet } from 'react-native';
import { haptic } from '@/lib/haptics';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useRequest } from '@/context/RequestContext';
import { Input, KeyboardDoneBar } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { FormScrollView } from '@/components/ui/FormScrollView';
import { colors, fontSize, spacing, radius } from '@/constants/theme';

export default function RequestStep2() {
  const router = useRouter();
  const { formData, update } = useRequest();
  const [errors, setErrors] = useState<Record<string, string>>({});

  function validate() {
    const e: Record<string, string> = {};
    if (!formData.pickupName.trim()) e.pickupName = 'Enter the shop or place name';
    if (!formData.pickupLocation.trim()) e.pickupLocation = 'Enter the pickup address';
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
          <StepIndicator current={2} />
        </View>

        <View style={styles.categoryBadge}>
          <Text style={styles.categoryBadgeText}>
            {formData.categoryName || 'Collection'}
          </Text>
        </View>

        <Text style={styles.heading}>Pickup details</Text>
        <Text style={styles.subheading}>Tell us where to collect from in Lerwick.</Text>

        <Input
          label="Shop or place name *"
          placeholder="e.g. Lerwick Co-op, Anderson & Co Pharmacy"
          value={formData.pickupName}
          onChangeText={(v) => { update({ pickupName: v }); setErrors((e) => ({ ...e, pickupName: '' })); }}
          error={errors.pickupName}
          autoCapitalize="words"
        />

        <Input
          label="Pickup address *"
          placeholder="e.g. 16 Commercial Street, Lerwick"
          value={formData.pickupLocation}
          onChangeText={(v) => { update({ pickupLocation: v }); setErrors((e) => ({ ...e, pickupLocation: '' })); }}
          error={errors.pickupLocation}
          autoCapitalize="words"
        />

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

function ToggleRow({
  label, hint, value, onValueChange,
}: {
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  text: { flex: 1 },
  label: { fontSize: fontSize.md, fontWeight: '600', color: colors.navy, marginBottom: 2 },
  hint: { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 16 },
});

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

  toggleSection: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  divider: { height: 1, backgroundColor: colors.border },
});
