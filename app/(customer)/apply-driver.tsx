import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Switch,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { Input, KeyboardDoneBar } from '@/components/ui/Input';
import { FormScrollView } from '@/components/ui/FormScrollView';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { colors, fontSize, spacing, radius } from '@/constants/theme';

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
  const { profile, refreshProfile } = useAuth();

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
    console.log('[apply-driver] validate():', valid, 'errors:', errors);
    if (!valid) return;

    console.log('[apply-driver] profile:', profile?.id);
    if (!profile?.id) {
      Alert.alert('Not signed in', 'Could not find your profile. Please sign out and back in.');
      return;
    }

    setSubmitting(true);

    // 1. Create the driver_profiles row
    const { error: dpError } = await supabase
      .from('driver_profiles')
      .upsert({
        id: profile.id,
        driver_status: 'pending',
        vehicle_type: vehicleType.trim(),
        vehicle_reg: vehicleReg.trim().toUpperCase(),
        notes: statement.trim(),
      });

    console.log('[apply-driver] upsert error:', dpError);

    if (dpError) {
      setSubmitting(false);
      Alert.alert('Could not submit application', dpError.message);
      return;
    }

    // 2. Update profile role to driver
    const { error: profileError } = await supabase
      .from('profiles')
      .update({ role: 'driver' })
      .eq('id', profile.id);

    console.log('[apply-driver] profile update error:', profileError);

    if (profileError) {
      setSubmitting(false);
      Alert.alert('Could not update profile', profileError.message);
      return;
    }

    // 3. Refresh profile in context so the app re-routes correctly
    await refreshProfile();
    setSubmitting(false);

    // Navigate to driver dashboard — they'll see pending status there
    router.replace('/(driver)/dashboard');
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardDoneBar />
      <FormScrollView contentContainerStyle={styles.content}>
          {/* Header */}
          <View style={styles.header}>
            <TouchableOpacity onPress={() => router.back()} style={styles.backLink}>
              <Text style={styles.backLinkText}>← Back</Text>
            </TouchableOpacity>
            <Text style={styles.title}>Apply to drive</Text>
            <Text style={styles.subtitle}>
              Tell us about yourself and your vehicle. Applications are reviewed by our team
              — you'll be able to create runs once approved.
            </Text>
          </View>

          <View style={styles.body}>

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
              label="About you"
              value={statement}
              onChangeText={(v) => {
                setStatement(v);
                if (errors.statement) setErrors((e) => ({ ...e, statement: '' }));
              }}
              placeholder="Tell us a little about yourself and why you'd like to drive for OneShetland Fetch. Where do you usually travel to?"
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  content: {
    backgroundColor: colors.screenBackground,
    paddingBottom: spacing.xxl,
    flexGrow: 1,
  },
  header: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
  },
  backLink: { marginBottom: spacing.md },
  backLinkText: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.sm },
  title: {
    color: colors.white,
    fontSize: fontSize.xxl,
    fontWeight: '800',
    marginBottom: spacing.sm,
  },
  subtitle: {
    color: 'rgba(255,255,255,0.7)',
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
