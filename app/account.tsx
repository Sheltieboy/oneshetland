import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Image,
  Linking,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/context/AuthContext';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { deleteAccount } from '@/lib/moderation';
import { clearPushToken } from '@/lib/notifications';
import { Input, KeyboardDoneBar } from '@/components/ui/Input';
import { FormScrollView } from '@/components/ui/FormScrollView';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { haptic } from '@/lib/haptics';
import { useAlert } from '@/components/BrandedAlert';

interface DriverProfile {
  driver_status: 'pending' | 'approved' | 'rejected';
  vehicle_type: string | null;
  vehicle_reg: string | null;
  notes: string | null;
  stripe_account_id: string | null;
  stripe_onboarding_complete: boolean;
  stripe_payouts_enabled: boolean;
}

// ─── small reusable row ────────────────────────────────────────────────────
function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

function LinkRow({
  icon,
  label,
  onPress,
  last = false,
}: {
  icon: string;
  label: string;
  onPress: () => void;
  last?: boolean;
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.accountLink,
        last && styles.accountLinkLast,
        pressed && { opacity: 0.7 },
      ]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={styles.accountLinkIcon} accessibilityElementsHidden importantForAccessibility="no">{icon}</Text>
      <Text style={styles.accountLinkLabel}>{label}</Text>
      <Text style={styles.accountLinkArrow}>›</Text>
    </Pressable>
  );
}

// ─── main screen ──────────────────────────────────────────────────────────
export default function AccountScreen() {
  const router = useRouter();
  const { session, profile, signOut, refreshProfile, hasAppliedToDrive } = useAuth();
  const { alert } = useAlert();
  const { screenWidth } = useAppLayout();

  const [fullName, setFullName] = useState(profile?.full_name ?? '');
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [driverProfile, setDriverProfile] = useState<DriverProfile | null>(null);
  const [driverNotes, setDriverNotes] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [notesSaved, setNotesSaved] = useState(false);
  const [vehicleType, setVehicleType] = useState('');
  const [vehicleReg, setVehicleReg] = useState('');
  const [savingVehicle, setSavingVehicle] = useState(false);
  const [vehicleSaved, setVehicleSaved] = useState(false);
  const [removingCard, setRemovingCard] = useState(false);

  // Sync form fields when profile first loads
  useEffect(() => {
    setFullName(profile?.full_name ?? '');
    setPhone(profile?.phone ?? '');
  }, [profile?.id]);

  // Fetch driver_profiles row when the user has a driver capability (applied).
  // Driver-ness is driver_profiles.driver_status, not profiles.role.
  const fetchDriverProfile = useCallback(async () => {
    if (!hasAppliedToDrive || !profile?.id) return;
    const { data } = await supabase
      .from('driver_profiles')
      .select('driver_status, vehicle_type, vehicle_reg, notes, stripe_account_id, stripe_onboarding_complete, stripe_payouts_enabled')
      .eq('id', profile.id)
      .single();
    if (data) {
      setDriverProfile(data as DriverProfile);
      setDriverNotes(data.notes ?? '');
      setVehicleType(data.vehicle_type ?? '');
      setVehicleReg(data.vehicle_reg ?? '');
    }
  }, [profile?.id, hasAppliedToDrive]);

  const VEHICLE_TYPES = ['Car', 'Estate car', 'SUV / 4x4', 'Van', 'Pickup truck', 'Minibus'];

  const isVehicleDirty =
    vehicleType !== (driverProfile?.vehicle_type ?? '') ||
    vehicleReg.trim() !== (driverProfile?.vehicle_reg ?? '').trim();

  async function handleSaveVehicle() {
    if (!profile?.id || !vehicleType || !vehicleReg.trim()) {
      alert({ title: 'Missing details', message: 'Please select a vehicle type and enter your registration.' });
      return;
    }
    setSavingVehicle(true);
    const { error } = await supabase
      .from('driver_profiles')
      .update({ vehicle_type: vehicleType, vehicle_reg: vehicleReg.trim().toUpperCase() })
      .eq('id', profile.id);
    setSavingVehicle(false);
    if (error) {
      alert({ title: 'Could not save', message: error.message });
    } else {
      setDriverProfile((prev) =>
        prev ? { ...prev, vehicle_type: vehicleType, vehicle_reg: vehicleReg.trim().toUpperCase() } : prev,
      );
      setVehicleReg((v) => v.trim().toUpperCase());
      setVehicleSaved(true);
      setTimeout(() => setVehicleSaved(false), 2000);
    }
  }

  async function handleSaveNotes() {
    if (!profile?.id) return;
    setSavingNotes(true);
    const { error } = await supabase
      .from('driver_profiles')
      .update({ notes: driverNotes.trim() || null })
      .eq('id', profile.id);
    setSavingNotes(false);
    if (error) {
      alert({ title: 'Could not save', message: error.message });
    } else {
      setDriverProfile((prev) => prev ? { ...prev, notes: driverNotes.trim() || null } : prev);
      setNotesSaved(true);
      setTimeout(() => setNotesSaved(false), 2000);
    }
  }

  useEffect(() => {
    fetchDriverProfile();
  }, [fetchDriverProfile]);

  const isDirty =
    fullName.trim() !== (profile?.full_name ?? '').trim() ||
    (phone.trim() || null) !== (profile?.phone ?? null);

  async function handleSave() {
    if (!isSupabaseConfigured || !profile?.id) return;
    setSaving(true);
    const { error } = await supabase
      .from('profiles')
      .update({ full_name: fullName.trim(), phone: phone.trim() || null })
      .eq('id', profile.id);
    setSaving(false);
    if (error) {
      alert({ title: 'Could not save changes', message: error.message });
    } else {
      await refreshProfile();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }

  async function handleSignOut() {
    alert({
      title:   'Sign out?',
      message: 'You\'ll need to sign back in to access your account.',
      icon:    'sign-out-alt',
      accent:  '#DC2626',
      actions: [
        { label: 'Cancel',   style: 'cancel' },
        { label: 'Sign out', style: 'destructive', onPress: signOut },
      ],
    });
  }

  // Account deletion (Apple 5.1.1(v) / Google Play). Two-step, deliberate
  // confirmation: first a "what happens" warning, then a final "permanently
  // delete?" gate before we actually call the edge function.
  async function performDelete() {
    const currentUserId = session?.user.id;
    setDeleting(true);
    try {
      await deleteAccount();
      // Mirror the sign-out cleanup: clear this device's push token (best-effort,
      // the server session is already dead), then clear the local session.
      if (currentUserId) {
        try { await clearPushToken(currentUserId); } catch { /* non-fatal */ }
      }
      await supabase.auth.signOut();
      // Route back to the auth screen. The auth state change will also redirect,
      // but replace explicitly so there's no flash of a logged-in screen.
      router.replace('/(auth)/sign-in');
    } catch (err: any) {
      setDeleting(false);
      alert({
        title: 'Could not delete account',
        message: err?.message
          ? `${err.message}\n\nPlease try again, or contact support if this keeps happening.`
          : 'Something went wrong. Please try again, or contact support if this keeps happening.',
        icon: 'exclamation-triangle',
        accent: colors.error,
      });
    }
  }

  function confirmDeleteFinal() {
    alert({
      title: 'Permanently delete?',
      message: 'This cannot be undone. Tap "Delete forever" to remove your account now.',
      icon: 'trash-alt',
      accent: colors.error,
      actions: [
        { label: 'Cancel', style: 'cancel' },
        { label: 'Delete forever', style: 'destructive', onPress: performDelete },
      ],
    });
  }

  function handleDeleteAccount() {
    alert({
      title: 'Delete account?',
      message:
        'This is permanent. Your profile, posts and comments are removed; you\'ll be signed out and can\'t sign back in. ' +
        'Records required for orders and payments are kept in anonymised form.',
      icon: 'user-slash',
      accent: colors.error,
      actions: [
        { label: 'Cancel', style: 'cancel' },
        { label: 'Continue', style: 'destructive', onPress: confirmDeleteFinal },
      ],
    });
  }

  // Removing a card must go through the service-role `remove-card` edge function:
  // it detaches the card in Stripe AND re-syncs profiles.has_payment_method (a
  // locked column the client can't write — the lock trigger would revert it).
  function handleRemoveCard() {
    alert({
      title: 'Remove payment method?',
      message: 'Your saved card will be removed from your account. You can add one again any time.',
      icon: 'credit-card',
      accent: colors.error,
      actions: [
        { label: 'Keep card', style: 'cancel' },
        {
          label: 'Remove card',
          style: 'destructive',
          onPress: async () => {
            setRemovingCard(true);
            try {
              const { data, error } = await supabase.functions.invoke('remove-card', { body: {} });
              if (error || (data as { error?: string } | null)?.error) {
                throw new Error((data as { error?: string } | null)?.error ?? error?.message ?? 'Could not remove the card.');
              }
              await refreshProfile();
              haptic.success();
            } catch (e) {
              haptic.error();
              alert({
                title: "Couldn't remove card",
                message: e instanceof Error ? e.message : 'Please try again.',
                actions: [{ label: 'OK', style: 'cancel' }],
              });
            } finally {
              setRemovingCard(false);
            }
          },
        },
      ],
    });
  }

  const roleLabel: Record<string, string> = {
    customer: 'Customer',
    driver: 'Driver',
    admin: 'Admin',
  };

  // Driver is a capability (driver_profiles.driver_status), not a role. Show the
  // driver card / "go to driver dashboard" to anyone who has applied; show
  // "apply to become a driver" to everyone else (non-admins).
  const isDriver = hasAppliedToDrive;
  const isCustomer = !hasAppliedToDrive && profile?.role !== 'admin';

  // Driver status helpers
  const driverStatusConfig = {
    pending:  { label: 'Pending approval', bg: '#FFF7ED', text: '#B45309', dot: '#F59E0B' },
    approved: { label: 'Approved',         bg: '#F0FDF4', text: '#166534', dot: '#22C55E' },
    rejected: { label: 'Application rejected', bg: '#FFF1F2', text: '#9F1239', dot: '#F43F5E' },
  };

  return (
    <ScreenScaffold>
      <KeyboardDoneBar />
      <FormScrollView contentContainerStyle={[styles.content, contentContainer(screenWidth)]}>

        {/* ── Header ───────────────────────────────────────────────────── */}
        <View style={styles.header}>
          <View style={styles.headerTop}>
            <Pressable
              onPress={() => { haptic.light(); router.back(); }}
              hitSlop={12}
              style={styles.backBtn}
            >
              <Text style={styles.backText}>‹ Back</Text>
            </Pressable>
          </View>
          <View style={styles.headerInner}>
            <View>
              <Text style={styles.title}>{profile?.full_name ?? 'My account'}</Text>
              <View style={styles.roleBadge}>
                <Text style={styles.roleBadgeText}>
                  {roleLabel[profile?.role ?? 'customer']}
                </Text>
              </View>
            </View>
            <View style={styles.avatarStack}>
              <View style={styles.iconCircle}>
                <Image
                  source={require('../assets/icon.png')}
                  style={styles.iconImage}
                  resizeMode="contain"
                />
              </View>
              <View style={styles.initialBadge}>
                <Text style={styles.initialText}>
                  {(profile?.full_name ?? 'U')[0].toUpperCase()}
                </Text>
              </View>
            </View>
          </View>
        </View>

        <View style={styles.body}>

          {/* ── Personal details ──────────────────────────────────────── */}
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
              disabled={!isDirty}
              variant={saved ? 'outline' : 'primary'}
              size="md"
              style={styles.saveButton}
            />
          </Card>

          {/* ── Customer card ─────────────────────────────────────────── */}
          <Card style={styles.section}>
            <Text style={styles.sectionTitle}>Customer account</Text>

            {/* Payment method status */}
            <View style={[
              styles.statusBanner,
              profile?.has_payment_method ? styles.statusBannerGreen : styles.statusBannerAmber,
            ]}>
              <Text style={styles.statusBannerIcon}>
                {profile?.has_payment_method ? '✓' : '!'}
              </Text>
              <View style={{ flex: 1 }}>
                <Text style={[
                  styles.statusBannerTitle,
                  { color: profile?.has_payment_method ? '#166534' : '#92400E' },
                ]}>
                  {profile?.has_payment_method ? 'Payment method set up' : 'No payment method'}
                </Text>
                <Text style={[
                  styles.statusBannerBody,
                  { color: profile?.has_payment_method ? '#4ADE80' : '#B45309' },
                ]}>
                  {profile?.has_payment_method
                    ? 'You can request deliveries'
                    : 'Required before you can request a delivery'}
                </Text>
              </View>
              {!profile?.has_payment_method && (
                <Pressable
                  style={styles.statusBannerAction}
                  onPress={() => { haptic.light(); router.push('/payment-setup'); }}
                >
                  <Text style={styles.statusBannerActionText}>Set up</Text>
                </Pressable>
              )}
            </View>

            <View style={styles.linkGroup}>
              <LinkRow
                icon="💳"
                label={profile?.has_payment_method ? 'Update payment method' : 'Set up payment method'}
                onPress={() => { haptic.light(); router.push('/payment-setup'); }}
              />
              {profile?.has_payment_method && (
                <LinkRow
                  icon="🗑️"
                  label={removingCard ? 'Removing…' : 'Remove payment method'}
                  onPress={() => { if (!removingCard) { haptic.light(); handleRemoveCard(); } }}
                />
              )}
              <LinkRow
                icon="📍"
                label="Saved addresses"
                onPress={() => { haptic.light(); router.push('/(customer)/saved-addresses'); }}
              />
              <LinkRow
                icon="📋"
                label="Previous requests"
                onPress={() => { haptic.light(); router.push('/(customer)/previous-requests'); }}
              />
              {isCustomer && (
                <LinkRow
                  icon="🚗"
                  label="Apply to become a driver"
                  onPress={() => { haptic.light(); router.push('/(customer)/apply-driver'); }}
                  last
                />
              )}
              {isDriver && (
                <LinkRow
                  icon="🚗"
                  label="Go to driver dashboard"
                  onPress={() => { haptic.light(); router.replace({ pathname: '/(tabs)/fetch', params: { view: 'driver' } } as any); }}
                  last
                />
              )}
            </View>
          </Card>

          {/* ── Driver card (drivers only) ─────────────────────────────── */}
          {isDriver && (
            <Card style={styles.section}>
              <Text style={styles.sectionTitle}>Driver account</Text>

              {/* Approval status */}
              {driverProfile && (() => {
                const cfg = driverStatusConfig[driverProfile.driver_status] ?? driverStatusConfig.pending;
                return (
                  <View style={[styles.statusBanner, { backgroundColor: cfg.bg }]}>
                    <View style={[styles.statusDot, { backgroundColor: cfg.dot }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.statusBannerTitle, { color: cfg.text }]}>
                        {cfg.label}
                      </Text>
                      {driverProfile.driver_status === 'pending' && (
                        <Text style={[styles.statusBannerBody, { color: cfg.text, opacity: 0.75 }]}>
                          We'll notify you once reviewed — usually 1–2 working days
                        </Text>
                      )}
                    </View>
                  </View>
                );
              })()}

              {/* Vehicle */}
              <Text style={styles.subSectionTitle}>Vehicle</Text>
              <View style={styles.vehicleGrid}>
                {VEHICLE_TYPES.map((type) => (
                  <Pressable
                    key={type}
                    style={[styles.vehicleChip, vehicleType === type && styles.vehicleChipSelected]}
                    onPress={() => { haptic.light(); setVehicleType(type); }}
                  >
                    <Text style={[styles.vehicleChipText, vehicleType === type && styles.vehicleChipTextSelected]}>
                      {type}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Input
                label="Registration"
                value={vehicleReg}
                onChangeText={(v) => setVehicleReg(v.toUpperCase())}
                placeholder="e.g. SY24 ABC"
                autoCapitalize="characters"
                hint="Used to verify your vehicle insurance. Not shown publicly."
              />
              <Button
                label={vehicleSaved ? '✓ Saved' : 'Save vehicle'}
                onPress={handleSaveVehicle}
                loading={savingVehicle}
                disabled={!isVehicleDirty}
                variant={vehicleSaved ? 'outline' : 'secondary'}
                size="md"
                fullWidth
                style={{ marginBottom: spacing.md }}
              />

              {/* Typical routes */}
              <View style={styles.divider} />
              <Text style={styles.subSectionTitle}>Your typical routes</Text>
              <Input
                value={driverNotes}
                onChangeText={setDriverNotes}
                placeholder="Where do you regularly travel to and from? E.g. Lerwick to Scalloway most days, or regular trips north."
                multiline
                numberOfLines={4}
                style={{ height: 100, textAlignVertical: 'top' }}
                hint="Helps match you with requests along your route. Seen only by the OneShetland team."
              />
              <Button
                label={notesSaved ? '✓ Saved' : 'Save routes'}
                onPress={handleSaveNotes}
                loading={savingNotes}
                disabled={driverNotes.trim() === (driverProfile?.notes ?? '').trim()}
                variant={notesSaved ? 'outline' : 'secondary'}
                size="md"
                fullWidth
                style={{ marginBottom: spacing.md }}
              />

              {/* Bank / payouts */}
              <View style={styles.divider} />
              <Text style={styles.subSectionTitle}>Bank account &amp; payouts</Text>

              {driverProfile?.stripe_payouts_enabled ? (
                <View style={[styles.statusBanner, styles.statusBannerGreen]}>
                  <Text style={styles.statusBannerIcon}>✓</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.statusBannerTitle, { color: '#166534' }]}>
                      Payouts enabled
                    </Text>
                    <Text style={[styles.statusBannerBody, { color: '#166534', opacity: 0.75 }]}>
                      Payments land within 2 working days of each delivery
                    </Text>
                  </View>
                </View>
              ) : driverProfile?.stripe_account_id ? (
                // Has started onboarding but not yet confirmed
                <View>
                  <View style={[styles.statusBanner, styles.statusBannerAmber]}>
                    <Text style={styles.statusBannerIcon}>⏳</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.statusBannerTitle, { color: '#92400E' }]}>
                        Verification in progress
                      </Text>
                      <Text style={[styles.statusBannerBody, { color: '#B45309' }]}>
                        Stripe is reviewing your details
                      </Text>
                    </View>
                  </View>
                  <Button
                    label="Re-open Stripe setup"
                    onPress={() => { haptic.light(); router.push('/(driver)/connect-bank'); }}
                    variant="outline"
                    size="md"
                    fullWidth
                    style={{ marginTop: spacing.sm }}
                  />
                </View>
              ) : (
                <View>
                  <Text style={styles.bankPrompt}>
                    Connect your bank account so you get paid when you complete a delivery.
                  </Text>
                  <Button
                    label="Connect bank account"
                    onPress={() => { haptic.light(); router.push('/(driver)/connect-bank'); }}
                    variant="secondary"
                    size="md"
                    fullWidth
                    style={{ marginTop: spacing.sm }}
                  />
                </View>
              )}
            </Card>
          )}

          {/* ── Preferences ─────────────────────────────────────────────── */}
          <Card style={styles.section}>
            <Text style={styles.sectionTitle}>Preferences</Text>
            <View style={styles.linkGroup}>
              <LinkRow
                icon="🔔"
                label="Notifications"
                onPress={() => { haptic.light(); router.push('/notification-preferences'); }}
              />
              <LinkRow
                icon="🚫"
                label="Blocked users"
                onPress={() => { haptic.light(); router.push('/blocked-users'); }}
                last
              />
            </View>
          </Card>

          {/* ── Account info ──────────────────────────────────────────── */}
          <Card style={styles.section}>
            <Text style={styles.sectionTitle}>Account info</Text>
            <InfoRow label="Email" value={session?.user.email ?? '—'} />
            <InfoRow label="Account type" value={roleLabel[profile?.role ?? 'customer']} />
            <InfoRow
              label="Member since"
              value={
                profile?.created_at
                  ? new Date(profile.created_at).toLocaleDateString('en-GB', {
                      day: 'numeric', month: 'long', year: 'numeric',
                    })
                  : '—'
              }
            />
          </Card>

          {/* ── Legal ─────────────────────────────────────────────────── */}
          <Card style={styles.section}>
            <Text style={styles.sectionTitle}>Legal</Text>
            <View style={styles.linkGroup}>
              <LinkRow
                icon="🔒"
                label="Privacy Policy"
                onPress={() => { haptic.light(); Linking.openURL('https://oneshetland.com/privacy'); }}
              />
              <LinkRow
                icon="📄"
                label="Terms of Service"
                onPress={() => { haptic.light(); Linking.openURL('https://oneshetland.com/terms'); }}
                last
              />
            </View>
          </Card>

          {/* ── Session ───────────────────────────────────────────────── */}
          <Card style={styles.section}>
            <Text style={styles.sectionTitle}>Session</Text>
            <Button
              label="Sign out"
              onPress={handleSignOut}
              variant="outline"
              size="md"
              fullWidth
            />

            {/* Danger zone — permanent account deletion */}
            <View style={styles.dangerDivider} />
            <Pressable
              style={({ pressed }) => [styles.dangerRow, pressed && { opacity: 0.7 }]}
              onPress={() => { haptic.light(); handleDeleteAccount(); }}
              disabled={deleting}
              accessibilityRole="button"
              accessibilityLabel="Delete account"
            >
              <Text style={styles.dangerIcon} accessibilityElementsHidden importantForAccessibility="no">🗑️</Text>
              <Text style={styles.dangerLabel}>
                {deleting ? 'Deleting account…' : 'Delete account'}
              </Text>
              {!deleting && <Text style={styles.dangerArrow}>›</Text>}
            </Pressable>
            <Text style={styles.dangerHint}>
              Permanently removes your account and personal data. This can't be undone.
            </Text>
          </Card>

        </View>
      </FormScrollView>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content: {
    backgroundColor: colors.screenBackground,
    paddingBottom: spacing.xxl,
    flexGrow: 1,
  },

  // Header
  header: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  headerTop: { marginBottom: spacing.sm },
  backBtn: {},
  backText: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.sm, fontWeight: '500' },
  headerInner: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: { color: colors.white, fontSize: fontSize.lg, fontWeight: '700' },
  roleBadge: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(18,179,214,0.25)',
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
    marginTop: 4,
  },
  roleBadgeText: {
    color: colors.accent,
    fontSize: fontSize.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  avatarStack: { width: 44, height: 44 },
  iconCircle: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 3,
  },
  iconImage: { width: 36, height: 36, borderRadius: 9 },
  initialBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 20,
    height: 20,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.navy,
  },
  initialText: { color: colors.white, fontWeight: '800', fontSize: 9 },

  // Body
  body: { padding: spacing.lg, gap: spacing.md },
  section: {},
  sectionTitle: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.navy,
    marginBottom: spacing.md,
  },
  subSectionTitle: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.navy,
    marginBottom: spacing.sm,
  },
  saveButton: { marginTop: spacing.md },

  // Status banners
  statusBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  statusBannerGreen: { backgroundColor: '#F0FDF4' },
  statusBannerAmber: { backgroundColor: '#FFFBEB' },
  statusBannerIcon: { fontSize: 16, lineHeight: 20 },
  statusDot: { width: 10, height: 10, borderRadius: 5, marginTop: 4, flexShrink: 0 },
  statusBannerTitle: { fontSize: fontSize.sm, fontWeight: '700', marginBottom: 2 },
  statusBannerBody: { fontSize: fontSize.xs, lineHeight: 16 },
  statusBannerAction: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.md,
    alignSelf: 'center',
  },
  statusBannerActionText: { color: colors.white, fontSize: fontSize.xs, fontWeight: '700' },

  // Link rows
  linkGroup: { marginTop: spacing.xs },
  accountLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  accountLinkLast: {},
  accountLinkIcon: { fontSize: 18, width: 26 },
  accountLinkLabel: {
    flex: 1,
    fontSize: fontSize.md,
    color: colors.textPrimary,
    fontWeight: '500',
  },
  accountLinkArrow: { fontSize: fontSize.xl, color: colors.textLight },

  // Info rows
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

  // Danger zone (account deletion)
  dangerDivider: { height: 1, backgroundColor: colors.border, marginTop: spacing.md, marginBottom: spacing.xs },
  dangerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  dangerIcon: { fontSize: 18, width: 26 },
  dangerLabel: {
    flex: 1,
    fontSize: fontSize.md,
    color: colors.error,
    fontWeight: '700',
  },
  dangerArrow: { fontSize: fontSize.xl, color: colors.error },
  dangerHint: {
    fontSize: fontSize.xs,
    color: colors.textLight,
    lineHeight: 16,
    marginTop: 2,
  },

  // Driver card specifics
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.md },
  bankPrompt: { fontSize: fontSize.sm, color: colors.textMuted, lineHeight: 20 },

  // Vehicle chip picker
  vehicleGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  vehicleChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.white,
  },
  vehicleChipSelected: { borderColor: colors.accent, backgroundColor: '#F0FBFF' },
  vehicleChipText: { fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: '500' },
  vehicleChipTextSelected: { color: colors.accent, fontWeight: '700' },
});
