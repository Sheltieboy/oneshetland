import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Switch,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAlert } from '@/components/BrandedAlert';
import { useAuth } from '@/context/AuthContext';
import { logCompliance } from '@/lib/compliance';
import { track } from '@/lib/analytics';
import { supabase } from '@/lib/supabase';
import { Input, KeyboardDoneBar } from '@/components/ui/Input';
import { FormScrollView } from '@/components/ui/FormScrollView';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';

const S = SECTIONS.fetch;

const VEHICLE_TYPES = [
  'Car',
  'Estate car',
  'SUV / 4x4',
  'Van',
  'Pickup truck',
  'Minibus',
];

export default function ApplyDriverScreen() {
  const router = useRouter();
  const { alert } = useAlert();
  const { profile, refreshProfile } = useAuth();
  const { screenWidth } = useAppLayout();

  const [vehicleType, setVehicleType] = useState('');
  const [vehicleReg, setVehicleReg] = useState('');
  const [statement, setStatement] = useState('');
  const [declarationTicked, setDeclarationTicked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!vehicleType.trim()) e.vehicleType = 'Please enter your vehicle type.';
    if (!vehicleReg.trim()) e.vehicleReg = 'Please enter your vehicle registration.';
    if (statement.trim().length < 20)
      e.statement = 'Please tell us a little more about yourself (at least 20 characters).';
    if (!declarationTicked)
      e.declaration = 'You must confirm you hold a valid licence and insurance.';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSubmit() {
    const valid = validate();
    if (!valid) return;

    if (!profile?.id) {
      alert({ title: 'Not signed in', message: 'Could not find your profile. Please sign out and back in.' });
      return;
    }

    setSubmitting(true);

    // Submit via the become-driver edge function. This MUST be server-side:
    // migration 064 locks profiles.role on user-initiated updates, so a
    // client-side role write is silently reverted (the old bug). The function
    // (service role) creates the driver_profiles row + promotes role to driver.
    const { data: result, error: fnError } = await supabase.functions.invoke('become-driver', {
      body: { vehicle_type: vehicleType.trim(), vehicle_reg: vehicleReg.trim(), statement: statement.trim() },
    });
    if (fnError || (result as any)?.error) {
      let msg = (result as any)?.error ?? fnError?.message ?? 'Could not submit application.';
      try {
        const ctx = (fnError as any)?.context;
        if (ctx && typeof ctx.json === 'function') { const b = await ctx.json(); if (b?.error) msg = b.error; }
      } catch { /* keep generic */ }
      setSubmitting(false);
      alert({ title: 'Could not submit application', message: msg });
      return;
    }

    track('driver_application_submitted', {});

    // Log compliance — driver terms accepted at point of application
    logCompliance({ eventType: 'driver.terms_accepted', documentVersion: '1.0', description: 'Accepted Fetch driver terms at application', metadata: { screen: 'apply-driver' } });

    // 4. Refresh profile in context so the app re-routes correctly
    await refreshProfile();
    setSubmitting(false);

    // Land back in the Fetch SECTION on the Driver view (keeps the bottom nav —
    // the standalone /(driver)/dashboard has its own "‹ OneShetland" back and no
    // tab bar, which made it feel like a separate app). The embedded driver view
    // shows the "pending review" status with the rest of OneShetland intact.
    router.replace({ pathname: '/(tabs)/fetch', params: { view: 'driver' } } as any);
  }

  return (
    <ScreenScaffold
      header={
        <ScreenHeader
          title="Apply to drive"
          subtitle="Become a Fetch driver"
          accent={S.color}
          onBack={() => router.back()}
        />
      }
    >
      <KeyboardDoneBar />
      <FormScrollView contentContainerStyle={[styles.content, contentContainer(screenWidth)]}>
          <View style={styles.body}>
            <Text style={styles.intro}>
              Tell us about yourself and your vehicle. Applications are reviewed by our team
              — you'll be able to create runs once approved.
            </Text>

            {/* What drivers do */}
            <Card style={styles.infoCard}>
              <Text style={styles.infoTitle}>What OneShetland drivers do</Text>
              {[
                "🚗  Create runs when you're already travelling somewhere",
                "📦  Collect goods from Lerwick for customers along your route",
                "💷  Earn a fair contribution for each delivery",
                "🕒  You choose when and where — no obligations",
              ].map((line) => (
                <Text key={line} style={styles.infoLine}>{line}</Text>
              ))}
              <Text style={styles.infoSmall}>
                Goods only. No alcohol, tobacco, vapes, cash, or passengers.
              </Text>
            </Card>

            {/* Vehicle type */}
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Vehicle type</Text>
              <View style={styles.vehicleGrid}>
                {VEHICLE_TYPES.map((type) => (
                  <TouchableOpacity
                    key={type}
                    style={[
                      styles.vehicleChip,
                      vehicleType === type && styles.vehicleChipSelected,
                    ]}
                    onPress={() => {
                      setVehicleType(type);
                      if (errors.vehicleType) setErrors((e) => ({ ...e, vehicleType: '' }));
                    }}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[
                        styles.vehicleChipText,
                        vehicleType === type && styles.vehicleChipTextSelected,
                      ]}
                    >
                      {type}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              {errors.vehicleType ? (
                <Text style={styles.fieldError}>{errors.vehicleType}</Text>
              ) : null}
            </View>

            <Input
              label="Vehicle registration"
              value={vehicleReg}
              onChangeText={(v) => {
                setVehicleReg(v.toUpperCase());
                if (errors.vehicleReg) setErrors((e) => ({ ...e, vehicleReg: '' }));
              }}
              placeholder="e.g. SY24 ABC"
              autoCapitalize="characters"
              error={errors.vehicleReg}
              hint="Used to verify your vehicle insurance. Not shown publicly."
            />

            <Input
              label="Your typical routes"
              value={statement}
              onChangeText={(v) => {
                setStatement(v);
                if (errors.statement) setErrors((e) => ({ ...e, statement: '' }));
              }}
              placeholder="Where do you regularly travel to and from? E.g. Lerwick to Scalloway most days, or regular trips north. This helps us match you with requests along your route."
              multiline
              numberOfLines={5}
              style={{ height: 120, textAlignVertical: 'top' }}
              error={errors.statement}
            />

            {/* Declaration */}
            <Card
              style={[
                styles.declarationCard,
                errors.declaration ? styles.declarationCardError : null,
              ]}
            >
              <View style={styles.declarationRow}>
                <View style={styles.declarationText}>
                  <Text style={styles.declarationTitle}>Driver declaration</Text>
                  <Text style={styles.declarationBody}>
                    I confirm that I hold a valid UK driving licence, have appropriate
                    vehicle insurance that covers carrying goods, and am legally entitled
                    to drive in the UK.
                  </Text>
                </View>
                <Switch
                  value={declarationTicked}
                  onValueChange={(v) => {
                    setDeclarationTicked(v);
                    if (errors.declaration) setErrors((e) => ({ ...e, declaration: '' }));
                  }}
                  trackColor={{ false: colors.border, true: colors.accent }}
                  thumbColor={colors.white}
                />
              </View>
              {errors.declaration ? (
                <Text style={styles.fieldError}>{errors.declaration}</Text>
              ) : null}
            </Card>

            <Button
              label="Submit application"
              onPress={handleSubmit}
              loading={submitting}
              variant="secondary"
              size="lg"
              fullWidth
              style={styles.submitButton}
            />

            <Text style={styles.disclaimer}>
              Applications are usually reviewed within 1–2 working days. You'll be able to
              see your application status on your driver dashboard.
            </Text>
          </View>
      </FormScrollView>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: spacing.xxl,
    flexGrow: 1,
  },
  intro: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },

  body: { padding: spacing.lg, gap: spacing.md },

  infoCard: { backgroundColor: '#EFF6FF' },
  infoTitle: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: '#1D4ED8',
    marginBottom: spacing.sm,
  },
  infoLine: {
    fontSize: fontSize.sm,
    color: '#1E40AF',
    lineHeight: 24,
  },
  infoSmall: {
    fontSize: fontSize.xs,
    color: '#3B82F6',
    marginTop: spacing.sm,
  },

  fieldGroup: { marginBottom: spacing.xs },
  fieldLabel: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.navy,
    marginBottom: spacing.sm,
  },
  vehicleGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  vehicleChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.white,
  },
  vehicleChipSelected: {
    borderColor: colors.accent,
    backgroundColor: '#F0FBFF',
  },
  vehicleChipText: {
    fontSize: fontSize.sm,
    color: colors.textPrimary,
    fontWeight: '500',
  },
  vehicleChipTextSelected: {
    color: colors.accent,
    fontWeight: '700',
  },
  fieldError: {
    fontSize: fontSize.xs,
    color: colors.error,
    marginTop: spacing.xs,
  },

  declarationCard: {},
  declarationCardError: {
    borderWidth: 1.5,
    borderColor: colors.error,
  },
  declarationRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  declarationText: { flex: 1 },
  declarationTitle: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.navy,
    marginBottom: spacing.xs,
  },
  declarationBody: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    lineHeight: 20,
  },

  submitButton: { marginTop: spacing.xs },
  disclaimer: {
    fontSize: fontSize.xs,
    color: colors.textLight,
    textAlign: 'center',
    lineHeight: 18,
  },
});
