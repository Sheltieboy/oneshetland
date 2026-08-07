/**
 * notices.tsx
 * The full Local Notices feed — community notices from across Shetland's hubs
 * and businesses, with fundraiser progress inline. Reached from the home
 * "Local Notices · See all" link.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { LoadingState } from '@/components/ui/LoadingState';
import { EmptyState } from '@/components/ui/EmptyState';
import { fetchHomeNotices, type HomeNotice } from '@/lib/concierge-api';
import { formatPence } from '@/lib/local-api';
import { broadcastNotice, fetchNoticeBroadcastState } from '@/lib/notices-broadcast';
import { useAuth } from '@/context/AuthContext';
import { useAlert } from '@/components/BrandedAlert';

const S = SECTIONS.notices;

function tint(hex?: string | null): string {
  if (!hex || !/^#?[0-9a-fA-F]{6}/.test(hex)) return SECTIONS.community.color;
  return hex.startsWith('#') ? hex : `#${hex}`;
}

export default function NoticesScreen() {
  const router = useRouter();
  const { screenWidth } = useAppLayout();
  const { profile } = useAuth();
  const { alert } = useAlert();
  const [notices, setNotices] = useState<HomeNotice[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [sentMap, setSentMap] = useState<Record<string, string | null>>({});

  const isAdmin = profile?.role === 'admin';

  // Push an urgent notice to every device on the islands. Confirmed first,
  // because it bypasses quiet hours and cannot be recalled.
  const broadcast = (n: HomeNotice) => {
    alert({
      title: 'Send to everyone?',
      message:
        `"${n.title}" will be pushed to every OneShetland user who hasn't turned notices off — ` +
        'including through quiet hours. It can only be sent once and cannot be recalled.',
      icon: 'exclamation-triangle',
      accent: colors.error,
      actions: [
        { label: 'Cancel', style: 'cancel' },
        {
          label: 'Send island-wide',
          style: 'destructive',
          onPress: async () => {
            setSending(n.id);
            try {
              const res = await broadcastNotice(n.id);
              setSentMap(prev => ({ ...prev, [n.id]: new Date().toISOString() }));
              alert({ title: 'Sent', message: `Delivered to ${res.sent} of ${res.recipients} devices.` });
            } catch (e) {
              alert({ title: 'Not sent', message: e instanceof Error ? e.message : 'Something went wrong.' });
            } finally {
              setSending(null);
            }
          },
        },
      ],
    });
  };

  const load = useCallback(async () => {
    try {
      const rows = await fetchHomeNotices({ limit: 50 });
      setNotices(rows);
      if (isAdmin) {
        const urgent = rows.filter(n => n.severity === 'urgent').map(n => n.id);
        setSentMap(await fetchNoticeBroadcastState(urgent));
      }
    }
    catch { setNotices([]); }
    finally { setLoading(false); }
  }, [isAdmin]);
  useEffect(() => { load(); }, [load]);
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  return (
    <ScreenScaffold
      header={
        <ScreenHeader
          title="Local Notices"
          accent={S.color}
          onBack={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))}
        />
      }
    >
      <ScrollView
        contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={S.color} />}>

        {loading ? (
          <LoadingState accent={S.color} />
        ) : notices.length === 0 ? (
          <EmptyState icon="bullhorn" title="No notices right now." accent={S.color} variant="card" />
        ) : notices.map(n => {
          const accent = tint(n.brand_color);
          const c = n.campaign && n.campaign.status === 'active' ? n.campaign : null;
          const pct = c && c.goal_pence > 0 ? Math.min(1, c.raised_pence / c.goal_pence) : 0;
          const isUrgent = n.severity === 'urgent';
          const open = () => {
            if (n.campaign_id) router.push(`/hub-campaign?id=${n.campaign_id}` as any);
            else if (n.hub_id) router.push(`/hubs/${n.hub_id}` as any);
            else router.push('/(tabs)/whats-on');
          };
          return (
            <TouchableOpacity key={n.id} style={styles.card} onPress={open} activeOpacity={0.85}>
              <View style={styles.cardTop}>
                <View style={[styles.logo, { backgroundColor: accent }]}>
                  {n.logo_url ? <Image source={{ uri: n.logo_url }} style={styles.logoImg} />
                    : <FontAwesome5 name={c ? 'hand-holding-heart' : 'bullhorn'} size={14} color="#fff" solid />}
                </View>
                <View style={{ flex: 1 }}>
                  {isUrgent ? <Text style={styles.urgent}>URGENT</Text> : null}
                  <Text style={styles.title} numberOfLines={2}>{n.title}</Text>
                  <Text style={styles.meta} numberOfLines={1}>{n.publisher}{n.locality ? `  ·  ${n.locality}` : ''}</Text>
                </View>
              </View>
              {n.body ? <Text style={styles.body} numberOfLines={3}>{n.body}</Text> : null}

              {/* Admin only: push an urgent notice to every device. */}
              {isAdmin && isUrgent ? (
                sentMap[n.id] ? (
                  <View style={styles.sentRow}>
                    <FontAwesome5 name="check-circle" size={11} color={colors.success} solid />
                    <Text style={styles.sentText}>Sent island-wide</Text>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={styles.broadcastBtn}
                    disabled={sending === n.id}
                    onPress={() => broadcast(n)}
                    activeOpacity={0.85}
                  >
                    <FontAwesome5 name="broadcast-tower" size={12} color="#fff" solid />
                    <Text style={styles.broadcastText}>
                      {sending === n.id ? 'Sending…' : 'Send to everyone'}
                    </Text>
                  </TouchableOpacity>
                )
              ) : null}
              {c ? (
                <View style={styles.barWrap}>
                  <View style={styles.barTrack}><View style={[styles.barFill, { width: `${Math.round(pct * 100)}%`, backgroundColor: accent }]} /></View>
                  <View style={styles.barMeta}>
                    <Text style={styles.barText}>{formatPence(c.raised_pence)} of {formatPence(c.goal_pence)}</Text>
                    <Text style={[styles.donate, { color: accent }]} onPress={() => router.push(`/hub-donate?campaign=${c.id}` as any)}>Donate ›</Text>
                  </View>
                </View>
              ) : null}
            </TouchableOpacity>
          );
        })}
        <View style={{ height: 40 }} />
      </ScrollView>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md, gap: spacing.sm },

  card: { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  cardTop: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  logo: { width: 42, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  logoImg: { width: 42, height: 42 },
  urgent: { fontSize: 10, fontWeight: '900', color: colors.error, letterSpacing: 0.5 },
  title: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  meta: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  body: { fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 20, marginTop: spacing.sm },

  broadcastBtn:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: spacing.sm, backgroundColor: colors.error, borderRadius: radius.md, paddingVertical: 11 },
  broadcastText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
  sentRow:       { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing.sm },
  sentText:      { fontSize: fontSize.xs, fontWeight: '700', color: colors.success },

  barWrap: { marginTop: spacing.sm, gap: 4 },
  barTrack: { height: 8, borderRadius: 999, backgroundColor: '#E9ECF2', overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 999 },
  barMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  barText: { fontSize: 12, color: colors.textMuted, fontWeight: '700' },
  donate: { fontSize: fontSize.sm, fontWeight: '800' },
});
