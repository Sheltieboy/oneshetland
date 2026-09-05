/**
 * hub-admin.tsx
 * Hub admin home (committee / owner). Branches into the parts of running a
 * Hub: Members, Notices, Settings, and a peek at the public page.
 * Pass ?id=<hubId>.
 */

import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  RefreshControl,
} from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { LoadingState } from '@/components/ui/LoadingState';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  fetchHub, fetchHubMembers, fetchHubNotices,
  HUB_TYPE_LABELS, HUB_TYPE_ICONS,
  type Hub,
} from '@/lib/hubs-api';

const S = SECTIONS.community;

function tint(hex?: string | null): string {
  if (!hex || !/^#?[0-9a-fA-F]{6}/.test(hex)) return S.color;
  return hex.startsWith('#') ? hex : `#${hex}`;
}

export default function HubAdminScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { screenWidth } = useAppLayout();

  const [hub, setHub] = useState<Hub | null>(null);
  const [pending, setPending] = useState(0);
  const [activeCount, setActiveCount] = useState(0);
  const [noticeCount, setNoticeCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [h, members, notices] = await Promise.all([
        fetchHub(id), fetchHubMembers(id), fetchHubNotices(id),
      ]);
      setHub(h);
      setPending(members.filter(m => m.status === 'pending').length);
      setActiveCount(members.filter(m => m.status === 'active').length);
      setNoticeCount(notices.length);
    } finally { setLoading(false); }
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  if (loading) {
    return (
      <ScreenScaffold header={<ScreenHeader title="Manage" accent={S.color} onBack={() => router.back()} />}>
        <LoadingState accent={S.color} />
      </ScreenScaffold>
    );
  }
  if (!hub) {
    return (
      <ScreenScaffold header={<ScreenHeader title="Manage" accent={S.color} onBack={() => router.back()} />}>
        <EmptyState icon="store-slash" title="Hub not found" body="This Hub may have been removed or the link is out of date." accent={S.color} variant="card" />
      </ScreenScaffold>
    );
  }

  const accent = tint(hub.brand_color);

  return (
    <ScreenScaffold header={<ScreenHeader title="Manage" accent={accent} onBack={() => router.back()} />}>
      <ScrollView contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={accent} />}>

        {/* Identity */}
        <View style={styles.identity}>
          <View style={[styles.logo, { backgroundColor: accent }]}>
            {hub.logo_url
              ? <Image source={{ uri: hub.logo_url }} style={styles.logoImg} />
              : <FontAwesome5 name={(HUB_TYPE_ICONS[hub.type]) as any} size={20} color="#fff" solid />}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.name} numberOfLines={1}>{hub.name}</Text>
            <Text style={styles.sub}>{HUB_TYPE_LABELS[hub.type]}{hub.is_verified ? '  ·  Verified' : ''}</Text>
          </View>
        </View>

        {/* Quick stats */}
        <View style={styles.statsRow}>
          <Stat label="Members" value={activeCount} accent={accent} />
          <Stat label="Notices" value={noticeCount} accent={accent} />
          <Stat label="Pending" value={pending} accent={pending > 0 ? '#D97706' : accent} />
        </View>

        {/* ── Membership ── */}
        <Text style={styles.groupLabel}>Membership</Text>
        <Tile icon="users" title="Members" sub={pending > 0 ? `${pending} request${pending === 1 ? '' : 's'} to review` : `${activeCount} member${activeCount === 1 ? '' : 's'}`}
          badge={pending > 0 ? pending : undefined} accent={accent}
          onPress={() => router.push(`/hub-members?id=${hub.id}`)} />
        <Tile icon="id-card" title="Membership tiers" sub="Free or paid ways to join"
          accent={accent} onPress={() => router.push(`/hub-membership-types?id=${hub.id}`)} />
        <Tile icon="address-book" title="Member directory" sub="Who's in the hub"
          accent={accent} onPress={() => router.push(`/hub-directory?id=${hub.id}`)} />
        <Tile icon="university" title="Payouts" sub="Connect or manage where Hub payments are paid"
          accent={accent} onPress={() => router.push(`/hub-payouts?id=${hub.id}`)} />

        {/* ── Content & comms ── */}
        <Text style={styles.groupLabel}>Content & comms</Text>
        <Tile icon="bullhorn" title="Notices" sub="Post and manage updates"
          accent={accent} onPress={() => router.push(`/hub-notices-manage?id=${hub.id}`)} />
        <Tile icon="folder-open" title="Documents" sub="Policies, minutes, forms"
          accent={accent} onPress={() => router.push(`/hub-documents?id=${hub.id}`)} />
        <Tile icon="calendar-alt" title="Events" sub="Create events & sell tickets"
          accent={accent} onPress={() => router.push(`/hub-events?id=${hub.id}`)} />
        <Tile icon="hand-holding-heart" title="Fundraising" sub="Campaigns, donations & Gift Aid"
          accent={accent} onPress={() => router.push(`/hub-campaigns?id=${hub.id}`)} />

        <Tile icon="paper-plane" title="Message members" sub="Push or email the whole membership"
          accent={accent} onPress={() => router.push(`/hub-broadcast?id=${hub.id}`)} />

        {/* ── Hub ── */}
        <Text style={styles.groupLabel}>Hub</Text>
        <Tile icon="cog" title="Hub settings" sub="Name, branding, contact, join mode"
          accent={accent} onPress={() => router.push(`/hub-register?id=${hub.id}`)} />
        <Tile icon="eye" title="View public page" sub="See your Hub as visitors do"
          accent={accent} onPress={() => router.push(`/hubs/${hub.id}`)} />

        <View style={{ height: 40 }} />
      </ScrollView>
    </ScreenScaffold>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color: accent }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function Tile({ icon, title, sub, badge, accent, onPress }: {
  icon: string; title: string; sub: string; badge?: number; accent: string; onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.tile} onPress={onPress} activeOpacity={0.8}>
      <View style={[styles.tileIcon, { backgroundColor: accent + '18' }]}>
        <FontAwesome5 name={icon as any} size={16} color={accent} solid />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.tileTitle}>{title}</Text>
        <Text style={styles.tileSub}>{sub}</Text>
      </View>
      {badge != null && <View style={styles.badge}><Text style={styles.badgeText}>{badge}</Text></View>}
      <FontAwesome5 name="chevron-right" size={13} color={colors.textLight} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md, gap: spacing.sm },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: spacing.xs },
  logo: { width: 52, height: 52, borderRadius: 15, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  logoImg: { width: 52, height: 52 },
  name: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary },
  sub: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },

  statsRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.xs },
  stat: { flex: 1, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, paddingVertical: 14, alignItems: 'center' },
  statValue: { fontSize: 22, fontWeight: '900' },
  statLabel: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },

  groupLabel: { fontSize: 11, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: spacing.md, marginBottom: 2 },

  tile: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  tileIcon: { width: 42, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  tileTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  tileSub: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  badge: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, backgroundColor: '#D97706', alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#fff', fontSize: 12, fontWeight: '800' },

  soonCard: { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginTop: spacing.xs },
  soonTitle: { fontSize: 11, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  soonBody: { fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 4, lineHeight: 19 },
});
