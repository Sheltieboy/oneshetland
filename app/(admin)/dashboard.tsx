import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Image,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { fetchPendingAlertRequests } from '@/lib/alerts-api';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { colors, fontSize, spacing, radius, SIDEBAR_WIDTH } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { NavRail } from '@/components/NavRail';

// ─── Platform module definitions ──────────────────────────────────────────────

interface PlatformModule {
  key: string;
  icon: string;
  name: string;
  tagline: string;
  status: 'active' | 'coming';
  accentColor: string;
}

const PLATFORM_MODULES: PlatformModule[] = [
  {
    key: 'fetch',
    icon: '🚚',
    name: 'Fetch',
    tagline: 'Community delivery',
    status: 'active',
    accentColor: colors.accent,
  },
  {
    key: 'events',
    icon: '🗓️',
    name: 'Events',
    tagline: 'Community calendar',
    status: 'coming',
    accentColor: '#8B5CF6',
  },
  {
    key: 'noticeboard',
    icon: '📋',
    name: 'Notice Board',
    tagline: 'Local announcements',
    status: 'coming',
    accentColor: '#F59E0B',
  },
  {
    key: 'directory',
    icon: '🏢',
    name: 'Directory',
    tagline: 'Businesses & services',
    status: 'coming',
    accentColor: '#10B981',
  },
  {
    key: 'transport',
    icon: '🚌',
    name: 'Transport',
    tagline: 'Routes & timetables',
    status: 'coming',
    accentColor: '#EF4444',
  },
  {
    key: 'news',
    icon: '📰',
    name: 'News',
    tagline: 'Local news & updates',
    status: 'coming',
    accentColor: '#3B82F6',
  },
];

// ─── Platform-level sections ───────────────────────────────────────────────────

const PLATFORM_SECTIONS = [
  {
    key: 'config',
    icon: '⚙️',
    title: 'Config',
    description: 'Stripe price IDs, fees, feature flags — tweak without a redeploy',
  },
  {
    key: 'payments',
    icon: '💳',
    title: 'Payments',
    description: 'All transactions and payouts across the platform',
  },
  {
    key: 'disputes',
    icon: '⚠️',
    title: 'Disputes',
    description: 'Issue reports from any module',
  },
  {
    key: 'regions',
    icon: '🗺️',
    title: 'Regions',
    description: 'Geographic areas used across all modules',
  },
];

const PLATFORM_SECTION_ROUTES: Record<string, string> = {
  'config':    '/(admin)/config',
  'payments':  '/(admin)/payments',
  'disputes':  '/(admin)/disputes',
  'regions':   '/(admin)/regions',
};

// ─── Fetch-specific management sections ────────────────────────────────────────

const FETCH_SECTIONS = [
  {
    key: 'driver-approvals',
    icon: '👤',
    title: 'Driver approvals',
    description: 'Review pending driver applications',
  },
  {
    key: 'active-runs',
    icon: '🚗',
    title: 'Active runs',
    description: 'Monitor runs currently in progress',
  },
  {
    key: 'delivery-requests',
    icon: '📦',
    title: 'Delivery requests',
    description: 'All customer delivery requests',
  },
];

const FETCH_ROUTES: Record<string, string> = {
  'driver-approvals':  '/(admin)/driver-approvals',
  'active-runs':       '/(admin)/runs',
  'delivery-requests': '/(admin)/delivery-requests',
};

// ─── Platform stats ────────────────────────────────────────────────────────────

interface PlatformStats {
  totalUsers: number | null;
  pendingDrivers: number | null;
  pendingRequests: number | null;
  openRuns: number | null;
  pendingSpikSuggestions: number | null;
  pendingAlertRequests: number | null;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export default function AdminDashboard() {
  const router = useRouter();
  const { profile, signOut } = useAuth();
  const { sidePadding, isTablet } = useAppLayout();
  const [stats, setStats] = useState<PlatformStats>({
    totalUsers: null,
    pendingDrivers: null,
    pendingRequests: null,
    openRuns: null,
    pendingSpikSuggestions: null,
    pendingAlertRequests: null,
  });

  const firstName = profile?.full_name?.split(' ')[0] || 'Admin';

  useEffect(() => {
    async function fetchStats() {
      const [usersRes, driversRes, requestsRes, runsRes, spikRes, alertReqs] = await Promise.all([
        supabase.from('profiles').select('*', { count: 'exact', head: true }),
        supabase.from('driver_profiles').select('*', { count: 'exact', head: true }).eq('driver_status', 'pending'),
        supabase.from('delivery_requests').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('runs').select('*', { count: 'exact', head: true }).eq('status', 'open'),
        supabase.from('spik_suggestions').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
        fetchPendingAlertRequests().catch(() => [] as any[]),
      ]);
      setStats({
        totalUsers: usersRes.count ?? 0,
        pendingDrivers: driversRes.count ?? 0,
        pendingRequests: requestsRes.count ?? 0,
        openRuns: runsRes.count ?? 0,
        pendingSpikSuggestions: spikRes.count ?? 0,
        pendingAlertRequests: (alertReqs as any[]).length,
      });
    }
    fetchStats();
  }, []);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <NavRail />
      <ScrollView
        style={[styles.scroll, { paddingLeft: isTablet ? SIDEBAR_WIDTH : 0 }]}
        contentContainerStyle={[styles.content, { paddingHorizontal: Math.max(spacing.lg, sidePadding) }]}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Header ── */}
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))}
            style={styles.backToApp}
            hitSlop={8}
          >
            <FontAwesome5 name="chevron-left" size={11} color="rgba(255,255,255,0.6)" />
            <Text style={styles.backToAppText}>Back to app</Text>
          </TouchableOpacity>

          <View style={styles.headerTop}>
            <View style={styles.brandRow}>
              <View style={styles.logoCircle}>
                <Image
                  source={require('../../assets/icon.png')}
                  style={styles.logoImage}
                  resizeMode="contain"
                />
              </View>
              <View>
                <Text style={styles.brandName}>OneShetland</Text>
                <Text style={styles.brandSub}>Platform Admin</Text>
              </View>
            </View>
            <View style={styles.adminBadge}>
              <Text style={styles.adminBadgeText}>Admin</Text>
            </View>
          </View>
          <Text style={styles.greeting}>Good to see you, {firstName}</Text>
        </View>

        {/* ── Platform stats strip ── */}
        <View style={styles.statsStrip}>
          <View style={[styles.statCell, styles.statCellBorder]}>
            <Text style={styles.statValue}>{stats.totalUsers ?? '—'}</Text>
            <Text style={styles.statLabel}>Platform users</Text>
          </View>
          <View style={[styles.statCell, styles.statCellBorder]}>
            <Text style={[styles.statValue, (stats.pendingDrivers ?? 0) > 0 && styles.statAlert]}>
              {stats.pendingDrivers ?? '—'}
            </Text>
            <Text style={styles.statLabel}>Pending drivers</Text>
          </View>
          <View style={[styles.statCell, styles.statCellBorder]}>
            <Text style={[styles.statValue, (stats.pendingRequests ?? 0) > 0 && styles.statAlert]}>
              {stats.pendingRequests ?? '—'}
            </Text>
            <Text style={styles.statLabel}>Open requests</Text>
          </View>
          <View style={styles.statCell}>
            <Text style={styles.statValue}>{stats.openRuns ?? '—'}</Text>
            <Text style={styles.statLabel}>Active runs</Text>
          </View>
        </View>

        {/* ── Platform modules ── */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Platform modules</Text>
            <Text style={styles.sectionMeta}>
              {PLATFORM_MODULES.filter((m) => m.status === 'active').length} active
              {' · '}
              {PLATFORM_MODULES.filter((m) => m.status === 'coming').length} coming soon
            </Text>
          </View>

          <View style={styles.moduleGrid}>
            {PLATFORM_MODULES.map((mod) => (
              <View
                key={mod.key}
                style={[
                  styles.moduleCard,
                  mod.status === 'coming' && styles.moduleCardDimmed,
                ]}
              >
                {/* Active indicator strip */}
                {mod.status === 'active' && (
                  <View style={[styles.moduleStrip, { backgroundColor: mod.accentColor }]} />
                )}

                <Text style={styles.moduleIcon}>{mod.icon}</Text>
                <Text style={[styles.moduleName, mod.status === 'coming' && styles.moduleNameDimmed]}>
                  {mod.name}
                </Text>
                <Text style={styles.moduleTagline}>{mod.tagline}</Text>

                <View style={[
                  styles.moduleStatusBadge,
                  mod.status === 'active'
                    ? { backgroundColor: colors.accentLight }
                    : { backgroundColor: colors.offWhite },
                ]}>
                  <Text style={[
                    styles.moduleStatusText,
                    mod.status === 'active'
                      ? { color: colors.accent }
                      : { color: colors.textLight },
                  ]}>
                    {mod.status === 'active' ? 'Live' : 'Soon'}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </View>

        {/* ── Platform management ── */}
        <View style={styles.section}>
          <View style={styles.fetchHeader}>
            <View style={[styles.fetchStrip, { backgroundColor: colors.navy }]} />
            <View style={styles.fetchHeaderText}>
              <Text style={styles.sectionTitle}>Platform</Text>
              <Text style={styles.sectionMeta}>Shared across all modules</Text>
            </View>
          </View>

          <View style={styles.managementList}>
            {PLATFORM_SECTIONS.map((section) => (
              <Card
                key={section.key}
                style={styles.managementCard}
                onPress={() => {
                  if (PLATFORM_SECTION_ROUTES[section.key]) {
                    router.push(PLATFORM_SECTION_ROUTES[section.key] as any);
                  }
                }}
              >
                <View style={styles.managementRow}>
                  <Text style={styles.managementIcon}>{section.icon}</Text>
                  <View style={styles.managementBody}>
                    <Text style={styles.managementTitle}>{section.title}</Text>
                    <Text style={styles.managementDesc}>{section.description}</Text>
                  </View>
                  <Text style={styles.arrow}>›</Text>
                </View>
              </Card>
            ))}
          </View>
        </View>

        {/* ── Fetch module management ── */}
        <View style={styles.section}>
          <View style={styles.fetchHeader}>
            <View style={[styles.fetchStrip, { backgroundColor: colors.accent }]} />
            <View style={styles.fetchHeaderText}>
              <Text style={styles.sectionTitle}>Fetch management</Text>
              <Text style={styles.sectionMeta}>Community delivery module</Text>
            </View>
          </View>

          <View style={styles.managementList}>
            {FETCH_SECTIONS.map((section) => (
              <Card
                key={section.key}
                style={styles.managementCard}
                onPress={() => {
                  if (FETCH_ROUTES[section.key]) {
                    router.push(FETCH_ROUTES[section.key] as any);
                  }
                }}
              >
                <View style={styles.managementRow}>
                  <Text style={styles.managementIcon}>{section.icon}</Text>
                  <View style={styles.managementBody}>
                    <View style={styles.managementTitleRow}>
                      <Text style={styles.managementTitle}>{section.title}</Text>
                      {section.key === 'driver-approvals' && (stats.pendingDrivers ?? 0) > 0 && (
                        <View style={styles.alertBadge}>
                          <Text style={styles.alertBadgeText}>{stats.pendingDrivers}</Text>
                        </View>
                      )}
                      {section.key === 'delivery-requests' && (stats.pendingRequests ?? 0) > 0 && (
                        <View style={styles.alertBadge}>
                          <Text style={styles.alertBadgeText}>{stats.pendingRequests}</Text>
                        </View>
                      )}
                    </View>
                    <Text style={styles.managementDesc}>{section.description}</Text>
                  </View>
                  <Text style={styles.arrow}>›</Text>
                </View>
              </Card>
            ))}
          </View>
        </View>

        {/* ── Urgent Alerts management ── */}
        <View style={styles.section}>
          <View style={styles.fetchHeader}>
            <View style={[styles.fetchStrip, { backgroundColor: '#FF3B30' }]} />
            <View style={styles.fetchHeaderText}>
              <Text style={styles.sectionTitle}>Urgent Alerts</Text>
              <Text style={styles.sectionMeta}>Partner broadcast access</Text>
            </View>
          </View>

          <View style={styles.managementList}>
            <Card
              style={styles.managementCard}
              onPress={() => router.push('/(admin)/alert-approvals' as any)}
            >
              <View style={styles.managementRow}>
                <Text style={styles.managementIcon}>📡</Text>
                <View style={styles.managementBody}>
                  <View style={styles.managementTitleRow}>
                    <Text style={styles.managementTitle}>Alert access requests</Text>
                    {(stats.pendingAlertRequests ?? 0) > 0 && (
                      <View style={styles.alertBadge}>
                        <Text style={styles.alertBadgeText}>{stats.pendingAlertRequests}</Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.managementDesc}>
                    Approve or reject businesses requesting the £10/month alert add-on
                  </Text>
                </View>
                <Text style={styles.arrow}>›</Text>
              </View>
            </Card>
            <Card
              style={styles.managementCard}
              onPress={() => router.push('/(admin)/alerts' as any)}
            >
              <View style={styles.managementRow}>
                <Text style={styles.managementIcon}>🔴</Text>
                <View style={styles.managementBody}>
                  <Text style={styles.managementTitle}>Live alerts overview</Text>
                  <Text style={styles.managementDesc}>
                    All active, scheduled and recent alerts across every business
                  </Text>
                </View>
                <Text style={styles.arrow}>›</Text>
              </View>
            </Card>
          </View>
        </View>

        {/* ── Spik management ── */}
        <View style={styles.section}>
          <View style={styles.fetchHeader}>
            <View style={[styles.fetchStrip, { backgroundColor: '#0891B2' }]} />
            <View style={styles.fetchHeaderText}>
              <Text style={styles.sectionTitle}>Spik management</Text>
              <Text style={styles.sectionMeta}>Shetland dialect dictionary</Text>
            </View>
          </View>

          <View style={styles.managementList}>
            <Card
              style={styles.managementCard}
              onPress={() => router.push('/(admin)/spik-suggestions' as any)}
            >
              <View style={styles.managementRow}>
                <Text style={styles.managementIcon}>📝</Text>
                <View style={styles.managementBody}>
                  <View style={styles.managementTitleRow}>
                    <Text style={styles.managementTitle}>Community suggestions</Text>
                    {(stats.pendingSpikSuggestions ?? 0) > 0 && (
                      <View style={styles.alertBadge}>
                        <Text style={styles.alertBadgeText}>{stats.pendingSpikSuggestions}</Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.managementDesc}>
                    Review, copy and paste improvements into WordPress
                  </Text>
                </View>
                <Text style={styles.arrow}>›</Text>
              </View>
            </Card>

            <Card
              style={styles.managementCard}
              onPress={() => router.push('/(admin)/email-centre' as any)}
            >
              <View style={styles.managementRow}>
                <Text style={styles.managementIcon}>✉️</Text>
                <View style={styles.managementBody}>
                  <Text style={styles.managementTitle}>Email Centre</Text>
                  <Text style={styles.managementDesc}>
                    Templates, footer, delivery log and sender settings — powered by Postmark
                  </Text>
                </View>
                <Text style={styles.arrow}>›</Text>
              </View>
            </Card>

            <Card
              style={styles.managementCard}
              onPress={() => router.push('/(admin)/compliance' as any)}
            >
              <View style={styles.managementRow}>
                <Text style={styles.managementIcon}>🔒</Text>
                <View style={styles.managementBody}>
                  <Text style={styles.managementTitle}>Compliance Log</Text>
                  <Text style={styles.managementDesc}>
                    Search any member's email to view all their verifications, agreements and consents
                  </Text>
                </View>
                <Text style={styles.arrow}>›</Text>
              </View>
            </Card>

            <Card
              style={styles.managementCard}
              onPress={() => router.push('/(admin)/business-claims' as any)}
            >
              <View style={styles.managementRow}>
                <Text style={styles.managementIcon}>🏪</Text>
                <View style={styles.managementBody}>
                  <Text style={styles.managementTitle}>Business claims</Text>
                  <Text style={styles.managementDesc}>
                    Verify directory claims, approve owners, and grant discounts
                  </Text>
                </View>
                <Text style={styles.arrow}>›</Text>
              </View>
            </Card>

            <Card
              style={styles.managementCard}
              onPress={() => router.push('/(admin)/event-approvals' as any)}
            >
              <View style={styles.managementRow}>
                <Text style={styles.managementIcon}>📅</Text>
                <View style={styles.managementBody}>
                  <Text style={styles.managementTitle}>Hub event approvals</Text>
                  <Text style={styles.managementDesc}>
                    Approve unverified hubs' events for the islands-wide calendar
                  </Text>
                </View>
                <Text style={styles.arrow}>›</Text>
              </View>
            </Card>
          </View>
        </View>

        <View style={styles.signOutRow}>
          <Button label="Sign out" onPress={signOut} variant="ghost" size="sm" />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  scroll: { flex: 1, backgroundColor: colors.screenBackground },
  content: { paddingBottom: spacing.xxl },

  backToApp: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingTop: spacing.xs, paddingBottom: spacing.xs,
    alignSelf: 'flex-start',
  },
  backToAppText: {
    color: 'rgba(255,255,255,0.6)', fontSize: fontSize.sm, fontWeight: '600',
  },

  // Header
  header: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
  },
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: spacing.lg,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  logoCircle: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  logoImage: { width: 40, height: 40, borderRadius: 10 },
  brandName: {
    color: colors.white,
    fontSize: fontSize.md,
    fontWeight: '800',
  },
  brandSub: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: fontSize.xs,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginTop: 1,
  },
  adminBadge: {
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
  },
  adminBadgeText: { color: colors.white, fontSize: fontSize.xs, fontWeight: '700' },
  greeting: {
    color: colors.white,
    fontSize: fontSize.xl,
    fontWeight: '700',
  },

  // Stats strip
  statsStrip: {
    flexDirection: 'row',
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  statCell: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  statCellBorder: {
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  statValue: {
    fontSize: fontSize.lg,
    fontWeight: '800',
    color: colors.navy,
    marginBottom: 2,
  },
  statAlert: { color: colors.accent },
  statLabel: {
    fontSize: 10,
    color: colors.textMuted,
    textAlign: 'center',
  },

  // Sections
  section: { padding: spacing.lg, paddingBottom: 0 },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: spacing.md,
  },
  sectionTitle: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.navy,
  },
  sectionMeta: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
  },

  // Module grid
  moduleGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  moduleCard: {
    width: '31%',
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    padding: spacing.sm + 2,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'flex-start',
    overflow: 'hidden',
  },
  moduleCardDimmed: {
    backgroundColor: colors.offWhite,
  },
  moduleStrip: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 3,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  moduleIcon: { fontSize: 22, marginBottom: spacing.xs, marginTop: spacing.xs },
  moduleName: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.navy,
    marginBottom: 2,
  },
  moduleNameDimmed: { color: colors.textMuted },
  moduleTagline: {
    fontSize: 10,
    color: colors.textLight,
    marginBottom: spacing.sm,
    lineHeight: 13,
  },
  moduleStatusBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  moduleStatusText: {
    fontSize: 10,
    fontWeight: '700',
  },

  // Fetch management
  fetchHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  fetchStrip: {
    width: 4,
    height: 36,
    borderRadius: radius.full,
  },
  fetchHeaderText: {},

  managementList: { gap: spacing.sm, paddingBottom: spacing.lg },
  managementCard: {},
  managementRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  managementIcon: { fontSize: 22, width: 30 },
  managementBody: { flex: 1 },
  managementTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: 3,
  },
  managementTitle: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.navy,
  },
  managementDesc: { fontSize: fontSize.sm, color: colors.textMuted },
  arrow: { fontSize: fontSize.xl, color: colors.textLight },

  alertBadge: {
    backgroundColor: colors.accent,
    minWidth: 20,
    height: 20,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  alertBadgeText: { color: colors.white, fontSize: 11, fontWeight: '700' },

  signOutRow: { alignItems: 'center', paddingTop: spacing.lg, paddingBottom: spacing.lg },
});
