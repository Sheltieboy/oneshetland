import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '@/context/AuthContext';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { Input, KeyboardDoneBar } from '@/components/ui/Input';
import { FormScrollView } from '@/components/ui/FormScrollView';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { colors, fontSize, spacing, radius } from '@/constants/theme';

export default function AccountScreen() {
  const router = useRouter();
  const { profile, signOut, refreshProfile } = useAuth();

  const [fullName, setFullName] = useState(profile?.full_name ?? '');
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSave() {
    if (!isSupabaseConfigured || !profile?.id) return;

    setSaving(true);
    const { error } = await supabase
      .from('profiles')
      .update({ full_name: fullName.trim(), phone: phone.trim() || null })
      .eq('id', profile.id);
    setSaving(false);

    if (error) {
      Alert.alert('Could not save changes', error.message);
    } else {
      await refreshProfile();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }

  async function handleSignOut() {
    Alert.alert('Sign out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: signOut,
      },
    ]);
  }

  const roleLabel: Record<string, string> = {
    customer: 'Customer',
    driver: 'Driver',
    admin: 'Admin',
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardDoneBar />
      <FormScrollView contentContainerStyle={styles.content}>
          {/* Header */}
          <View style={styles.header}>
            <TouchableOpacity onPress={() => router.back()} style={styles.backLink}>
              <Text style={styles.backLinkText}>← Back</Text>
            </TouchableOpacity>
            <Text style={styles.title}>My account</Text>

            {/* Avatar */}
            <View style={styles.avatarSection}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>
                  {(profile?.full_name ?? 'U')[0].toUpperCase()}
                </Text>
              </View>
              <View>
                <Text style={styles.avatarName}>{profile?.full_name ?? '—'}</Text>
                <View style={styles.roleBadge}>
                  <Text style={styles.roleBadgeText}>
                    {roleLabel[profile?.role ?? 'customer']}
                  </Text>
                </View>
              </View>
            </View>
          </View>

          <View style={styles.body}>
            {/* Profile edit */}
            <Card style={styles.section}>
              <Text style={styles.sectionTitle}>Personal details</Text>

              <Input
                label="Full name"
                value={fullName}
                onChangeText={setFullName}
                placeholder="Your full name"
                autoCapitalize="words"
              />

              <Input
                label="Phone number (optional)"
                value={phone}
                onChangeText={setPhone}
                placeholder="+44 7700 000000"
                keyboardType="phone-pad"
                containerStyle={{ marginBottom: 0 }}
              />

              <Button
                label={saved ? '✓ Saved' : 'Save changes'}
                onPress={handleSave}
                loading={saving}
                variant={saved ? 'outline' : 'primary'}
                size="md"
                style={styles.saveButton}
              />
            </Card>

            {/* Account info */}
            <Card style={styles.section}>
              <Text style={styles.sectionTitle}>Account info</Text>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Email</Text>
                <Text style={styles.infoValue} numberOfLines={1}>
                  {/* Email comes from auth.users, not profiles — fetch via session */}
                  {profile ? '(see your sign-in email)' : '—'}
                </Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Account type</Text>
                <Text style={styles.infoValue}>
                  {roleLabel[profile?.role ?? 'customer']}
                </Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Member since</Text>
                <Text style={styles.infoValue}>
                  {profile?.created_at
                    ? new Date(profile.created_at).toLocaleDateString('en-GB', {
                        day: 'numeric',
                        month: 'long',
                        year: 'numeric',
                      })
                    : '—'}
                </Text>
              </View>
            </Card>

            {/* Danger zone */}
            <Card style={styles.section}>
              <Text style={styles.sectionTitle}>Session</Text>
              <Button
                label="Sign out"
                onPress={handleSignOut}
                variant="outline"
                size="md"
                fullWidth
              />
            </Card>

            {/* Quick links */}
            <Card style={styles.section}>
              <Text style={styles.sectionTitle}>More</Text>
              <TouchableOpacity
                style={styles.accountLink}
                onPress={() => router.push('/(customer)/saved-addresses')}
              >
                <Text style={styles.accountLinkIcon}>📍</Text>
                <Text style={styles.accountLinkLabel}>Saved addresses</Text>
                <Text style={styles.accountLinkArrow}>›</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.accountLink, styles.accountLinkLast]}
                onPress={() => router.push('/(customer)/previous-requests')}
              >
                <Text style={styles.accountLinkIcon}>📋</Text>
                <Text style={styles.accountLinkLabel}>Previous requests</Text>
                <Text style={styles.accountLinkArrow}>›</Text>
              </TouchableOpacity>
            </Card>
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
    marginBottom: spacing.lg,
  },
  avatarSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: colors.white,
    fontWeight: '800',
    fontSize: fontSize.xl,
  },
  avatarName: {
    color: colors.white,
    fontSize: fontSize.lg,
    fontWeight: '700',
    marginBottom: 4,
  },
  roleBadge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  roleBadgeText: {
    color: colors.white,
    fontSize: fontSize.xs,
    fontWeight: '700',
  },

  body: { padding: spacing.lg, gap: spacing.md },
  section: {},
  sectionTitle: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.navy,
    marginBottom: spacing.md,
  },
  saveButton: { marginTop: spacing.md },

  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  infoLabel: { fontSize: fontSize.sm, color: colors.textMuted },
  infoValue: {
    fontSize: fontSize.sm,
    color: colors.textPrimary,
    fontWeight: '500',
    flex: 1,
    textAlign: 'right',
  },

  accountLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  accountLinkLast: { borderBottomWidth: 0 },
  accountLinkIcon: { fontSize: 18, width: 26 },
  accountLinkLabel: {
    flex: 1,
    fontSize: fontSize.md,
    color: colors.textPrimary,
    fontWeight: '500',
  },
  accountLinkArrow: { fontSize: fontSize.xl, color: colors.textLight },
});
