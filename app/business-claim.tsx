/**
 * business-claim.tsx
 * "Claim this business" — a user requests ownership of a seeded directory
 * listing. Submits a business_claims row (status: pending). An admin then
 * verifies and approves, which assigns ownership and unlocks editing/upgrade.
 */

import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView,
  TextInput, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { Button } from '@/components/ui/Button';
import { useAlert } from '@/components/BrandedAlert';
import { useAuth } from '@/context/AuthContext';
import {
  fetchBusiness, fetchMyClaim, submitBusinessClaim,
  type LocalBusiness, type BusinessClaim,
} from '@/lib/local-api';

const S = SECTIONS.local;

export default function BusinessClaimScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { profile } = useAuth();
  const { screenWidth } = useAppLayout();
  const { alert } = useAlert();

  const [business, setBusiness] = useState<LocalBusiness | null>(null);
  const [existing, setExisting] = useState<BusinessClaim | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);

  const [contactName,  setContactName]  = useState(profile?.full_name ?? '');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState(profile?.phone ?? '');
  const [role,         setRole]         = useState('');
  const [evidence,     setEvidence]     = useState('');

  useEffect(() => {
    (async () => {
      if (!id) return;
      try {
        const [biz, mine] = await Promise.all([
          fetchBusiness(id),
          profile ? fetchMyClaim(profile.id, id) : Promise.resolve(null),
        ]);
        setBusiness(biz);
        setExisting(mine);
      } finally {
        setLoading(false);
      }
    })();
  }, [id, profile?.id]);

  const submit = async () => {
    if (!profile || !business) return;
    if (!contactName.trim() || !contactEmail.trim()) {
      alert({ title: 'Missing details', message: 'Please give your name and a contact email so we can verify you.' });
      return;
    }
    setSaving(true);
    try {
      await submitBusinessClaim(profile.id, business.id, {
        contact_name:  contactName.trim(),
        contact_email: contactEmail.trim(),
        contact_phone: contactPhone.trim() || null,
        role:          role.trim() || null,
        evidence:      evidence.trim() || null,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      alert({
        title: 'Claim submitted',
        message: `Thanks! We'll verify your connection to ${business.name} and get back to you. Once approved you can edit your listing and unlock Pro features.`,
        actions: [{ label: 'Done', style: 'primary', onPress: () => router.back() }],
      });
    } catch (e: any) {
      alert({ title: 'Could not submit', message: e?.message ?? 'Please try again.' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}><ActivityIndicator color={S.color} /></View>
      </SafeAreaView>
    );
  }

  if (!business) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}><Text style={styles.muted}>Business not found.</Text></View>
      </SafeAreaView>
    );
  }

  const Header = (
    <ScreenHeader title="Claim this business" onClose={() => router.back()} accent={S.color} />
  );

  // Already claimed by someone, or a pending/approved claim exists.
  if (business.is_claimed) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        {Header}
        <View style={styles.center}>
          <FontAwesome5 name="check-circle" size={36} color={S.color} solid />
          <Text style={styles.stateTitle}>Already claimed</Text>
          <Text style={styles.muted}>{business.name} has already been claimed.</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (existing && existing.status === 'pending') {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        {Header}
        <View style={styles.center}>
          <FontAwesome5 name="hourglass-half" size={32} color={S.color} solid />
          <Text style={styles.stateTitle}>Claim under review</Text>
          <Text style={styles.muted}>
            Your claim for {business.name} is being verified. We'll be in touch soon.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {Header}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, contentContainer(screenWidth)]} keyboardShouldPersistTaps="handled">

          <View style={[styles.bizCard, { borderColor: S.color }]}>
            <FontAwesome5 name="store" size={16} color={S.color} solid />
            <Text style={styles.bizName}>{business.name}</Text>
          </View>

          <Text style={styles.intro}>
            Tell us a little about your connection to this business. We verify each claim
            by hand to keep the directory trustworthy — once approved, the listing is
            yours to manage and you can upgrade to Pro or Premium.
          </Text>

          <Field label="Your name *">
            <TextInput style={styles.input} value={contactName} onChangeText={setContactName}
              placeholder="Full name" placeholderTextColor={colors.textLight} />
          </Field>

          <Field label="Contact email *">
            <TextInput style={styles.input} value={contactEmail} onChangeText={setContactEmail}
              placeholder="you@business.com" placeholderTextColor={colors.textLight}
              keyboardType="email-address" autoCapitalize="none" />
          </Field>

          <Field label="Contact phone">
            <TextInput style={styles.input} value={contactPhone} onChangeText={setContactPhone}
              placeholder="Optional" placeholderTextColor={colors.textLight} keyboardType="phone-pad" />
          </Field>

          <Field label="Your role">
            <TextInput style={styles.input} value={role} onChangeText={setRole}
              placeholder="e.g. Owner, Manager" placeholderTextColor={colors.textLight} />
          </Field>

          <Field label="How can we verify you?">
            <TextInput style={[styles.input, styles.textarea]} value={evidence} onChangeText={setEvidence}
              placeholder="e.g. a business email address, your website, or how you're connected"
              placeholderTextColor={colors.textLight} multiline />
          </Field>

          <Button
            label="Submit claim" icon="check" color={S.color} fullWidth
            loading={saving} disabled={saving} onPress={submit} style={styles.submitBtn}
          />

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.screenBackground },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: 12 },
  muted:  { color: colors.textMuted, fontSize: fontSize.sm, textAlign: 'center', lineHeight: 21 },
  stateTitle: { fontSize: fontSize.lg, fontWeight: '800', color: colors.textPrimary, marginTop: 4 },

  scroll:  { flex: 1 },
  content: { padding: spacing.md },

  bizCard: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderWidth: 1.5, borderRadius: radius.lg, padding: spacing.md, backgroundColor: '#fff',
  },
  bizName: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, flex: 1 },

  intro: {
    fontSize: fontSize.sm, color: colors.textMuted, lineHeight: 21,
    marginTop: spacing.md, marginBottom: spacing.sm,
  },

  field:      { marginTop: spacing.md },
  fieldLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary, marginBottom: 6 },
  input: {
    backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: fontSize.md, color: colors.textPrimary,
  },
  textarea: { minHeight: 90, textAlignVertical: 'top' },

  submitBtn: {
    marginTop: spacing.lg,
  },
});
