import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { useAlert } from '@/components/BrandedAlert';

// ── Reusable components ───────────────────────────────────────────────────────

function SectionCard({ title, accentColor, children }: {
  title: string; accentColor: string; children: React.ReactNode;
}) {
  return (
    <View style={styles.card}>
      <View style={[styles.cardAccent, { backgroundColor: accentColor }]} />
      <View style={styles.cardInner}>
        <Text style={[styles.cardTitle, { color: accentColor }]}>{title}</Text>
        {children}
      </View>
    </View>
  );
}

function MenuRow({ icon, iconColor, label, sublabel, badge, badgeColor, onPress, last }: {
  icon: string; iconColor: string; label: string; sublabel?: string;
  badge?: string; badgeColor?: string; onPress: () => void; last?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[styles.menuRow, last && { borderBottomWidth: 0 }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={[styles.menuIconWrap, { backgroundColor: iconColor + '18' }]}>
        <FontAwesome5 name={icon as any} size={13} color={iconColor} solid />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.menuLabel}>{label}</Text>
        {sublabel ? <Text style={styles.menuSublabel} numberOfLines={1}>{sublabel}</Text> : null}
      </View>
      {badge ? (
        <View style={[styles.badge, { backgroundColor: badgeColor ?? colors.accent }]}>
          <Text style={styles.badgeText}>{badge}</Text>
        </View>
      ) : null}
      <FontAwesome5 name="chevron-right" size={10} color={colors.textLight} />
    </TouchableOpacity>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

type ShiftStats = {
  myApps:         { pending: number; accepted: number; total: number };
  postedShifts:   number;
  pendingIncoming: number;
};

export default function MeTab() {
  const router = useRouter();
  const { session, profile, signOut, refreshProfile } = useAuth();
  const { alert } = useAlert();

  const [refreshing, setRefreshing] = useState(false);
  const [stats, setStats] = useState<ShiftStats>({
    myApps:          { pending: 0, accepted: 0, total: 0 },
    postedShifts:    0,
    pendingIncoming: 0,
  });

  const initials = (profile?.full_name ?? 'U')
    .split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2);

  const loadStats = useCallback(async () => {
    if (!profile?.id) return;
    try {
      const [appsRes, shiftsRes] = await Promise.all([
        supabase.from('shift_applications').select('status').eq('worker_id', profile.id),
        supabase.from('shifts').select('id').eq('employer_id', profile.id).eq('status', 'open'),
      ]);

      const myApps   = appsRes.data   ?? [];
      const myShifts = shiftsRes.data ?? [];

      let pendingIncoming = 0;
      if (myShifts.length > 0) {
        const { count } = await supabase
          .from('shift_applications')
          .select('id', { count: 'exact', head: true })
          .in('shift_id', myShifts.map(s => s.id))
          .eq('status', 'pending');
        pendingIncoming = count ?? 0;
      }

      setStats({
        myApps: {
          pending:  myApps.filter(a => a.status === 'pending').length,
          accepted: myApps.filter(a => a.status === 'accepted').length,
          total:    myApps.length,
        },
        postedShifts:    myShifts.length,
        pendingIncoming,
      });
    } catch { /* silent */ }
  }, [profile?.id]);

  useEffect(() => { loadStats(); }, [loadStats]);

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([refreshProfile(), loadStats()]);
    setRefreshing(false);
  };

  const handleSignOut = () => {
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
  };

  // ── Signed-out state ────────────────────────────────────────────────────
  // No session / no profile → show a clean sign-in prompt instead of the
  // personal cards (Shifts, Payments, Fetch, Account). Those sections are
  // meaningless without an account and were confusingly visible before.
  if (!session || !profile) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.signedOutHeader}>
          <View style={styles.avatarMuted}>
            <FontAwesome5 name="user" size={26} color="rgba(255,255,255,0.5)" solid />
          </View>
          <Text style={styles.signedOutTitle}>Welcome to OneShetland</Text>
          <Text style={styles.signedOutSub}>
            Sign in to access your shifts, bookings, deliveries, loyalty cards and payments.
          </Text>
        </View>

        <View style={styles.signedOutBody}>
          <TouchableOpacity
            style={styles.signInPrimaryBtn}
            onPress={() => { Haptics.selectionAsync(); router.push('/(auth)/sign-in'); }}
            activeOpacity={0.85}
          >
            <FontAwesome5 name="sign-in-alt" size={13} color="#fff" />
            <Text style={styles.signInPrimaryBtnText}>Sign in</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.signUpSecondaryBtn}
            onPress={() => { Haptics.selectionAsync(); router.push('/(auth)/sign-up'); }}
            activeOpacity={0.85}
          >
            <Text style={styles.signUpSecondaryBtnText}>Create an account</Text>
          </TouchableOpacity>

          <Text style={styles.signedOutFootnote}>
            You can still browse Local businesses, Spik, Events and Fetch without an account.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
        }
      >
        {/* ── Profile header ─────────────────────────────────────────────── */}
        <View style={styles.header}>
          <View style={styles.headerRow}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{initials}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.headerName}>{profile?.full_name ?? 'My Profile'}</Text>
              {profile?.bio ? (
                <Text style={styles.headerBio} numberOfLines={2}>{profile.bio}</Text>
              ) : (
                <Text style={styles.headerBioEmpty}>Add a bio in Edit profile</Text>
              )}
            </View>
          </View>

          <View style={styles.headerMeta}>
            {profile?.location_area ? (
              <View style={styles.headerMetaItem}>
                <FontAwesome5 name="map-marker-alt" size={10} color="rgba(255,255,255,0.5)" />
                <Text style={styles.headerMetaText}>{profile.location_area}</Text>
              </View>
            ) : null}
            {profile?.created_at ? (
              <View style={styles.headerMetaItem}>
                <FontAwesome5 name="calendar-alt" size={10} color="rgba(255,255,255,0.5)" />
                <Text style={styles.headerMetaText}>
                  Member since {new Date(profile.created_at).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}
                </Text>
              </View>
            ) : null}
          </View>

          <TouchableOpacity
            style={styles.editBtn}
            onPress={() => { Haptics.selectionAsync(); router.push('/edit-profile'); }}
            activeOpacity={0.85}
          >
            <FontAwesome5 name="pen" size={11} color={colors.navy} />
            <Text style={styles.editBtnText}>Edit profile</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.body}>

          {/* ── Shifts ─────────────────────────────────────────────────────── */}
          <SectionCard title="Shifts" accentColor={SECTIONS.shifts.color}>
            <MenuRow
              icon="paper-plane"
              iconColor={SECTIONS.shifts.color}
              label="My applications"
              sublabel={
                stats.myApps.total === 0
                  ? 'No applications yet'
                  : `${stats.myApps.pending} pending · ${stats.myApps.accepted} confirmed`
              }
              badge={stats.myApps.accepted > 0 ? `${stats.myApps.accepted} ✓` : undefined}
              badgeColor={colors.jobs}
              onPress={() => { Haptics.selectionAsync(); router.push('/my-shift-applications'); }}
            />
            <MenuRow
              icon="id-badge"
              iconColor={SECTIONS.shifts.color}
              label="My shift profile"
              sublabel="Bio, skills & qualifications employers see"
              onPress={() => { Haptics.selectionAsync(); router.push('/shift-worker-profile'); }}
              last={stats.postedShifts === 0}
            />
            {stats.postedShifts > 0 && (
              <>
                <MenuRow
                  icon="briefcase"
                  iconColor={SECTIONS.shifts.color}
                  label="My posted shifts"
                  sublabel={`${stats.postedShifts} live · ${stats.pendingIncoming} to review`}
                  badge={stats.pendingIncoming > 0 ? stats.pendingIncoming.toString() : undefined}
                  badgeColor={SECTIONS.shifts.color}
                  onPress={() => { Haptics.selectionAsync(); router.push('/my-posted-shifts'); }}
                />
                <MenuRow
                  icon="building"
                  iconColor={SECTIONS.shifts.color}
                  label="Business profile"
                  sublabel="Name and description shown on your shift listings"
                  onPress={() => { Haptics.selectionAsync(); router.push('/employer-profile'); }}
                  last
                />
              </>
            )}
          </SectionCard>

          {/* ── Payments & Banking ──────────────────────────────────────────── */}
          <SectionCard title="Payments & Banking" accentColor={colors.jobs}>
            <View style={[styles.statusBanner, {
              backgroundColor: profile?.has_payment_method ? colors.jobsLight : '#FEF3C7',
            }]}>
              <FontAwesome5
                name={profile?.has_payment_method ? 'check-circle' : 'exclamation-circle'}
                size={13}
                color={profile?.has_payment_method ? colors.jobs : '#D97706'}
                solid
              />
              <Text style={[styles.statusText, {
                color: profile?.has_payment_method ? colors.jobs : '#92400E',
              }]}>
                {profile?.has_payment_method ? 'Payment card added' : 'No payment card yet'}
              </Text>
              {!profile?.has_payment_method && (
                <TouchableOpacity
                  style={[styles.statusBtn, { backgroundColor: '#D97706' }]}
                  onPress={() => { Haptics.selectionAsync(); router.push('/(customer)/payment-setup'); }}
                >
                  <Text style={styles.statusBtnText}>Add card</Text>
                </TouchableOpacity>
              )}
            </View>

            <MenuRow
              icon="credit-card"
              iconColor={colors.jobs}
              label={profile?.has_payment_method ? 'Update payment card' : 'Add a payment card'}
              sublabel="Used for Fetch deliveries, events and services"
              onPress={() => { Haptics.selectionAsync(); router.push('/(customer)/payment-setup'); }}
            />
            <MenuRow
              icon="university"
              iconColor={colors.jobs}
              label="Bank account & payouts"
              sublabel="Receive payment for shifts and deliveries"
              onPress={() => { Haptics.selectionAsync(); router.push('/(driver)/connect-bank'); }}
              last
            />
          </SectionCard>

          {/* ── Fetch Delivers ──────────────────────────────────────────────── */}
          <SectionCard title="Fetch Delivers" accentColor={SECTIONS.fetch.color}>
            <MenuRow
              icon="map-marker-alt"
              iconColor={SECTIONS.fetch.color}
              label="Saved addresses"
              onPress={() => { Haptics.selectionAsync(); router.push('/(customer)/saved-addresses'); }}
            />
            <MenuRow
              icon="history"
              iconColor={SECTIONS.fetch.color}
              label="Previous requests"
              onPress={() => { Haptics.selectionAsync(); router.push('/(customer)/previous-requests'); }}
              last
            />
          </SectionCard>

          {/* ── Preferences ─────────────────────────────────────────────────── */}
          <SectionCard title="Preferences" accentColor={colors.navy}>
            <MenuRow
              icon="bell"
              iconColor={colors.navy}
              label="Notifications"
              sublabel="Pushes, quiet hours, per-feature toggles"
              onPress={() => { Haptics.selectionAsync(); router.push('/notification-preferences'); }}
              last
            />
          </SectionCard>

          {/* ── Admin (only when role = 'admin') ────────────────────────────── */}
          {profile?.role === 'admin' && (
            <SectionCard title="Admin" accentColor="#DC2626">
              <MenuRow
                icon="shield-alt"
                iconColor="#DC2626"
                label="Admin dashboard"
                sublabel="Platform, Fetch, Shifts, Local management"
                onPress={() => { Haptics.selectionAsync(); router.push('/(admin)/dashboard'); }}
                last
              />
            </SectionCard>
          )}

          {/* ── Account ─────────────────────────────────────────────────────── */}
          <SectionCard title="Account" accentColor={colors.textMuted}>
            <MenuRow
              icon="user-edit"
              iconColor={colors.textMuted}
              label="Edit profile"
              sublabel="Name, bio, location, phone"
              onPress={() => { Haptics.selectionAsync(); router.push('/edit-profile'); }}
            />

            <View style={styles.infoBlock}>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Email</Text>
                <Text style={styles.infoValue} numberOfLines={1}>{session?.user.email ?? '—'}</Text>
              </View>
              <View style={[styles.infoRow, { borderBottomWidth: 0 }]}>
                <Text style={styles.infoLabel}>Role</Text>
                <Text style={styles.infoValue}>{profile?.role ?? '—'}</Text>
              </View>
            </View>

            <TouchableOpacity style={styles.signOutBtn} onPress={handleSignOut} activeOpacity={0.8}>
              <FontAwesome5 name="sign-out-alt" size={13} color="#DC2626" />
              <Text style={styles.signOutText}>Sign out</Text>
            </TouchableOpacity>
          </SectionCard>

          <View style={{ height: 40 }} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },

  // ── Signed-out state ──
  signedOutHeader: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xl,
    alignItems: 'center',
    gap: 14,
  },
  avatarMuted: {
    width: 76, height: 76, borderRadius: 38,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  signedOutTitle: {
    fontSize: fontSize.xl, fontWeight: '900', color: '#fff',
    textAlign: 'center', letterSpacing: -0.4, marginTop: 4,
  },
  signedOutSub: {
    fontSize: fontSize.sm, color: 'rgba(255,255,255,0.6)',
    textAlign: 'center', lineHeight: 21, paddingHorizontal: spacing.md,
  },
  signedOutBody: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    gap: 12,
  },
  signInPrimaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: colors.accent,
    paddingVertical: 14, borderRadius: radius.full,
  },
  signInPrimaryBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
  signUpSecondaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 12, borderRadius: radius.full,
    borderWidth: 1.5, borderColor: colors.border, backgroundColor: '#fff',
  },
  signUpSecondaryBtnText: { color: colors.textPrimary, fontSize: fontSize.sm, fontWeight: '700' },
  signedOutFootnote: {
    fontSize: fontSize.xs, color: colors.textMuted,
    textAlign: 'center', marginTop: spacing.md, paddingHorizontal: spacing.lg, lineHeight: 18,
  },

  // Header
  header: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
    gap: 14,
  },
  headerRow:      { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  avatar: {
    width: 60, height: 60, borderRadius: 30,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText:     { fontSize: 22, fontWeight: '900', color: '#fff' },
  headerName:     { fontSize: fontSize.xl, fontWeight: '900', color: '#fff', marginBottom: 4 },
  headerBio:      { fontSize: fontSize.sm, color: 'rgba(255,255,255,0.6)', lineHeight: 18 },
  headerBioEmpty: { fontSize: fontSize.xs, color: 'rgba(255,255,255,0.3)', fontStyle: 'italic' },
  headerMeta:     { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  headerMetaItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  headerMetaText: { fontSize: fontSize.xs, color: 'rgba(255,255,255,0.5)' },
  editBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    alignSelf: 'flex-start',
    backgroundColor: '#fff', borderRadius: radius.full,
    paddingHorizontal: 14, paddingVertical: 7,
  },
  editBtnText: { fontSize: fontSize.xs, fontWeight: '800', color: colors.navy },

  // Body
  body: { padding: spacing.md, gap: 12 },

  // Section card
  card: {
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    flexDirection: 'row',
    overflow: 'hidden',
    shadowColor: '#0F1C26',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  cardAccent: { width: 4 },
  cardInner:  { flex: 1, padding: spacing.md },
  cardTitle: {
    fontSize: fontSize.xs, fontWeight: '800',
    textTransform: 'uppercase', letterSpacing: 0.6,
    marginBottom: 10,
  },

  // Menu rows
  menuRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 11,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  menuIconWrap: {
    width: 32, height: 32, borderRadius: radius.sm,
    alignItems: 'center', justifyContent: 'center',
  },
  menuLabel:    { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  menuSublabel: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  badge: {
    paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: radius.full,
  },
  badgeText: { fontSize: 10, fontWeight: '800', color: '#fff' },

  // Status banner
  statusBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: radius.md, padding: 10, marginBottom: 8,
  },
  statusText:    { flex: 1, fontSize: fontSize.xs, fontWeight: '600' },
  statusBtn:     { paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.full },
  statusBtnText: { fontSize: fontSize.xs, fontWeight: '700', color: '#fff' },

  // Info block
  infoBlock: { marginTop: 8 },
  infoRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  infoLabel: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600' },
  infoValue: { fontSize: fontSize.xs, color: colors.textPrimary, fontWeight: '600', maxWidth: '60%', textAlign: 'right' },

  // Sign out
  signOutBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginTop: 10, paddingVertical: 4,
  },
  signOutText: { fontSize: fontSize.sm, fontWeight: '700', color: '#DC2626' },
});
