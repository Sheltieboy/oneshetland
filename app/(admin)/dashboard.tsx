import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { colors, fontSize, spacing, radius } from '@/constants/theme';

interface Stats {
  openRuns: number | null;
  pendingRequests: number | null;
  pendingDrivers: number | null;
}

const ADMIN_SECTIONS = [
  {
    key: 'driver-approvals',
    icon: '👤',
    title: 'Driver approvals',
    description: 'Review pending driver applications',
    badge: null as string | null,
  },
  {
    key: 'active-runs',
    icon: '🚗',
    title: 'Active runs',
    description: 'Monitor runs currently in progress',
    badge: null,
  },
  {
    key: 'delivery-requests',
    icon: '📦',
    title: 'Delivery requests',
    description: 'All customer delivery requests',
    badge: null,
  },
  {
    key: 'payments',
    icon: '💳',
    title: 'Payments',
    description: 'Transactions and payouts — Stripe coming soon',
    badge: 'Coming soon',
  },
  {
    key: 'disputes',
    icon: '⚠️',
    title: 'Disputes',
    description: 'Customer and driver issue reports',
    badge: null,
  },
  {
    key: 'regions',
    icon: '🗺️',
    title: 'Regions',
    description: 'Manage Shetland delivery regions',
    badge: null,
  },
];

export default function AdminDashboard() {
  const router = useRouter();
  const { profile, signOut } = useAuth();
  const [stats, setStats] = useState<Stats>({
    openRuns: null,
    pendingRequests: null,
    pendingDrivers: null,
  });

  const firstName = profile?.full_name?.split(' ')[0] ?? 'Admin';

  useEffect(() => {
    async function fetchStats() {
      const [runsRes, requestsRes, driversRes] = await Promise.all([
        supabase
          .from('runs')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'open'),
        supabase
          .from('delivery_requests')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'pending'),
        supabase
          .from('driver_profiles')
          .select('*', { count: 'exact', head: true })
          .eq('driver_status', 'pending'),
      ]);

      setStats({
        openRuns: runsRes.count ?? 0,
        pendingRequests: requestsRes.count ?? 0,
        pendingDrivers: driversRes.count ?? 0,
      });
    }

    fetchStats();
  }, []);

  function handleSectionPress(key: string) {
    if (key === 'driver-approvals') {
      router.push('/(admin)/driver-approvals');
    } else if (key === 'delivery-requests') {
      router.push('/(admin)/delivery-requests');
    } else if (key === 'active-runs') {
      router.push('/(admin)/runs');
    }
    // Payments, disputes, regions: add navigation as those screens are built
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <View style={styles.brandRow}>
              <View style={styles.logoCircle}>
                <Image
                  source={require('../../assets/icon.png')}
                  style={styles.logoImage}
                  resizeMode="contain"
                />
              </View>
              <Text style={styles.brandName}>OneShetland Fetch</Text>
            </View>
            <Text style={styles.greeting}>Admin dashboard</Text>
            <Text style={styles.headerSub}>Signed in as {firstName}</Text>
          </View>
          <View style={styles.adminBadge}>
            <Text style={styles.adminBadgeText}>Admin</Text>
          </View>
        </View>

        {/* Live stats */}
        <View style={styles.statsRow}>
          {[
            { label: 'Open runs', value: stats.openRuns },
            { label: 'Pending requests', value: stats.pendingRequests },
            { label: 'Pending drivers', value: stats.pendingDrivers },
          ].map((stat, i) => (
            <View
              key={stat.label}
              style={[styles.statCard, i === 2 && styles.statCardLast]}
            >
              <Text style={[
                styles.statValue,
                stat.value !== null && stat.value > 0 && styles.statValueAlert,
              ]}>
                {stat.value === null ? '—' : stat.value}
              </Text>
              <Text style={styles.statLabel}>{stat.label}</Text>
            </View>
          ))}
        </View>

        {/* Admin sections */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Management</Text>
          <View style={styles.grid}>
            {ADMIN_SECTIONS.map((section) => (
              <Card
                key={section.key}
                style={styles.sectionCard}
                onPress={() => handleSectionPress(section.key)}
              >
                <View style={styles.sectionCardRow}>
                  <Text style={styles.sectionIcon}>{section.icon}</Text>
                  <View style={styles.sectionBody}>
                    <View style={styles.sectionTitleRow}>
                      <Text style={styles.sectionCardTitle}>{section.title}</Text>
                      {section.badge && (
                        <View style={styles.comingSoon}>
                          <Text style={styles.comingSoonText}>{section.badge}</Text>
                        </View>
                      )}
                      {/* Live count badges */}
                      {section.key === 'driver-approvals' && stats.pendingDrivers !== null && stats.pendingDrivers > 0 && (
                        <View style={styles.alertBadge}>
                          <Text style={styles.alertBadgeText}>{stats.pendingDrivers}</Text>
                        </View>
                      )}
                      {section.key === 'delivery-requests' && stats.pendingRequests !== null && stats.pendingRequests > 0 && (
                        <View style={styles.alertBadge}>
                          <Text style={styles.alertBadgeText}>{stats.pendingRequests}</Text>
                        </View>
                      )}
                    </View>
                    <Text style={styles.sectionDesc}>{section.description}</Text>
                  </View>
                  <Text style={styles.arrow}>›</Text>
                </View>
              </Card>
            ))}
          </View>
        </View>

        <View style={styles.signOutRow}>
          <Button label="Sign out" onPress={signOut} variant="ghost" size="sm" />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  scroll: { flex: 1, backgroundColor: colors.screenBackground },
  content: { paddingBottom: spacing.xxl },

  header: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  headerLeft: { flex: 1 },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  logoCircle: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoImage: { width: 36, height: 36, borderRadius: 9 },
  brandName: {
    color: colors.white,
    fontSize: fontSize.sm,
    fontWeight: '700',
    opacity: 0.9,
  },
  greeting: {
    color: colors.white,
    fontSize: fontSize.xl,
    fontWeight: '700',
    marginBottom: 4,
  },
  headerSub: { color: 'rgba(255,255,255,0.6)', fontSize: fontSize.sm },
  adminBadge: {
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    marginTop: spacing.md + 4,
  },
  adminBadgeText: {
    color: colors.white,
    fontSize: fontSize.xs,
    fontWeight: '700',
  },

  statsRow: {
    flexDirection: 'row',
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  statCard: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.lg,
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  statCardLast: { borderRightWidth: 0 },
  statValue: {
    fontSize: fontSize.xxl,
    fontWeight: '800',
    color: colors.navy,
    marginBottom: 4,
  },
  statValueAlert: {
    color: colors.accent,
  },
  statLabel: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    textAlign: 'center',
  },

  section: { padding: spacing.lg },
  sectionTitle: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.navy,
    marginBottom: spacing.sm,
  },

  grid: { gap: spacing.sm },
  sectionCard: {},
  sectionCardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  sectionIcon: { fontSize: 24, width: 32 },
  sectionBody: { flex: 1 },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: 4,
  },
  sectionCardTitle: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.navy,
  },
  sectionDesc: { fontSize: fontSize.sm, color: colors.textMuted },
  arrow: { fontSize: fontSize.xl, color: colors.textLight },
  comingSoon: {
    backgroundColor: colors.offWhite,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  comingSoonText: {
    fontSize: 10,
    color: colors.textMuted,
    fontWeight: '600',
  },
  alertBadge: {
    backgroundColor: colors.accent,
    minWidth: 20,
    height: 20,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  alertBadgeText: {
    color: colors.white,
    fontSize: 11,
    fontWeight: '700',
  },

  signOutRow: { alignItems: 'center', paddingBottom: spacing.lg },
});
