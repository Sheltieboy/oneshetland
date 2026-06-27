/**
 * business-alerts.tsx
 *
 * Full alerts history for a business owner — live, scheduled, and ended.
 * Reached from the Urgent Alerts card in the business dashboard.
 */

import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius, shadow } from '@/constants/theme';
import { useAlert } from '@/components/BrandedAlert';
import { fetchAllBusinessAlerts, cancelAlert, forceExpireAlert, type PartnerAlert } from '@/lib/alerts-api';

const TYPE_META = {
  emergency:  { label: 'Emergency',  color: '#FF3B30', bg: '#FFF2F1', icon: 'exclamation-triangle' },
  disruption: { label: 'Disruption', color: '#FF9500', bg: '#FFF8EC', icon: 'exclamation-circle'  },
  info:       { label: 'Info',       color: '#0A84FF', bg: '#EEF5FF', icon: 'info-circle'          },
} as const;

function alertStatus(a: PartnerAlert): 'live' | 'scheduled' | 'ended' {
  const now = Date.now();
  if (!a.is_active) {
    const startsAt = a.starts_at ? new Date(a.starts_at).getTime() : 0;
    if (startsAt > now) return 'scheduled';
    return 'ended';
  }
  if (a.expires_at && new Date(a.expires_at).getTime() <= now) return 'ended';
  return 'live';
}

function timeRemaining(expiresAt: string | null): string {
  if (!expiresAt) return 'No expiry';
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'Expired';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `Ends in ${h}h ${m}m`;
  return `Ends in ${m}m`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function BusinessAlertsScreen() {
  const router    = useRouter();
  const { alert } = useAlert();
  const { businessId, businessName } = useLocalSearchParams<{ businessId: string; businessName: string }>();

  const [alerts,     setAlerts]     = useState<PartnerAlert[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!businessId) return;
    const data = await fetchAllBusinessAlerts(businessId).catch(() => []);
    setAlerts(data);
    setLoading(false);
    setRefreshing(false);
  }, [businessId]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const live      = alerts.filter(a => alertStatus(a) === 'live');
  const scheduled = alerts.filter(a => alertStatus(a) === 'scheduled');
  const ended     = alerts.filter(a => alertStatus(a) === 'ended');

  const handleCancel = (a: PartnerAlert) => {
    const isLive = alertStatus(a) === 'live';
    alert({
      title: isLive ? 'End alert now?' : 'Delete scheduled alert?',
      message: isLive
        ? 'It will be removed from the app immediately.'
        : 'It will be deleted and never sent.',
      actions: [
        { label: 'Keep', style: 'cancel' },
        {
          label: isLive ? 'End alert' : 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              if (isLive) await forceExpireAlert(a.id);
              else await cancelAlert(a.id);
              await load();
            } catch (e: any) {
              alert({
                title: isLive ? 'Could not end alert' : 'Could not delete alert',
                message: e?.message ?? 'Please try again.',
              });
            }
          },
        },
      ],
    });
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <FontAwesome5 name="chevron-left" size={14} color="#fff" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Alerts</Text>
          <Text style={styles.headerSub}>{businessName}</Text>
        </View>
        <View style={{ width: 36 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={colors.accent} /></View>
      ) : (
        <ScrollView
          style={{ flex: 1, backgroundColor: colors.screenBackground }}
          contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
        >
          {/* Live */}
          {live.length > 0 && (
            <Section label="LIVE NOW" accent="#FF3B30">
              {live.map(a => <AlertRow key={a.id} alert={a} status="live" onCancel={() => handleCancel(a)} />)}
            </Section>
          )}

          {/* Scheduled */}
          {scheduled.length > 0 && (
            <Section label="SCHEDULED" accent="#FF9500">
              {scheduled.map(a => <AlertRow key={a.id} alert={a} status="scheduled" onCancel={() => handleCancel(a)} />)}
            </Section>
          )}

          {/* Ended */}
          {ended.length > 0 && (
            <Section label="ENDED / CANCELLED" accent={colors.textMuted}>
              {ended.map(a => <AlertRow key={a.id} alert={a} status="ended" />)}
            </Section>
          )}

          {alerts.length === 0 && (
            <View style={styles.empty}>
              <FontAwesome5 name="bell-slash" size={32} color={colors.textMuted} />
              <Text style={styles.emptyText}>No alerts yet</Text>
              <Text style={styles.emptySub}>Alerts you send will appear here</Text>
            </View>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function Section({ label, accent, children }: { label: string; accent: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <View style={[styles.sectionAccent, { backgroundColor: accent }]} />
        <Text style={styles.sectionLabel}>{label}</Text>
      </View>
      <View style={{ gap: 8 }}>{children}</View>
    </View>
  );
}

function AlertRow({ alert: a, status, onCancel }: {
  alert: PartnerAlert;
  status: 'live' | 'scheduled' | 'ended';
  onCancel?: () => void;
}) {
  const meta = TYPE_META[a.type];

  return (
    <View style={[styles.card, status === 'ended' && styles.cardEnded]}>
      <View style={[styles.colorBar, { backgroundColor: status === 'ended' ? colors.border : meta.color }]} />
      <View style={{ flex: 1, gap: 4 }}>
        {/* Type + status badge row */}
        <View style={styles.badgeRow}>
          <View style={[styles.typeBadge, { backgroundColor: status === 'ended' ? '#F2F2F7' : meta.bg }]}>
            <FontAwesome5 name={meta.icon as any} size={9} color={status === 'ended' ? colors.textMuted : meta.color} />
            <Text style={[styles.typeBadgeText, { color: status === 'ended' ? colors.textMuted : meta.color }]}>
              {meta.label.toUpperCase()}
            </Text>
          </View>

          {status === 'live' && (
            <View style={styles.liveBadge}>
              <View style={styles.liveDot} />
              <Text style={styles.liveText}>LIVE · {timeRemaining(a.expires_at)}</Text>
            </View>
          )}
          {status === 'scheduled' && (
            <View style={styles.scheduledBadge}>
              <FontAwesome5 name="clock" size={9} color="#FF9500" />
              <Text style={styles.scheduledText}>{fmtDate(a.starts_at)}</Text>
            </View>
          )}
          {status === 'ended' && (
            <Text style={styles.endedText}>
              {a.expires_at ? `Ended ${fmtDate(a.expires_at)}` : `Sent ${fmtDate(a.created_at)}`}
            </Text>
          )}
        </View>

        <Text style={[styles.message, status === 'ended' && { color: colors.textMuted }]}>
          {a.message}
        </Text>

        <Text style={styles.meta}>Sent {fmtDate(a.created_at)}{a.expires_at && status !== 'ended' ? ` · Expires ${fmtDate(a.expires_at)}` : ''}</Text>
      </View>

      {onCancel && (
        <TouchableOpacity onPress={onCancel} hitSlop={12} style={styles.cancelBtn}>
          <FontAwesome5 name={status === 'live' ? 'stop-circle' : 'times'} size={14} color={colors.textMuted} />
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: '#1a1f36' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  header: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: spacing.md, paddingVertical: 14,
    backgroundColor: '#1a1f36',
  },
  backBtn:     { width: 36 },
  headerTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '900' },
  headerSub:   { color: 'rgba(255,255,255,0.55)', fontSize: fontSize.xs, marginTop: 1 },

  section:       { gap: 10 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionAccent: { width: 4, height: 16, borderRadius: 2 },
  sectionLabel:  { fontSize: 11, fontWeight: '900', letterSpacing: 1, color: colors.textMuted },

  card: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    flexDirection: 'row', alignItems: 'flex-start',
    overflow: 'hidden', ...shadow.card,
  },
  cardEnded: { backgroundColor: colors.offWhite },
  colorBar:  { width: 4, alignSelf: 'stretch', minHeight: 56 },

  badgeRow:      { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: spacing.sm, flexWrap: 'wrap' },
  typeBadge:     { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 3, borderRadius: radius.full },
  typeBadgeText: { fontSize: 9, fontWeight: '900', letterSpacing: 0.8 },

  liveBadge:     { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#FF3B3012', paddingHorizontal: 7, paddingVertical: 3, borderRadius: radius.full },
  liveDot:       { width: 6, height: 6, borderRadius: 3, backgroundColor: '#FF3B30' },
  liveText:      { fontSize: 9, fontWeight: '900', letterSpacing: 0.8, color: '#FF3B30' },

  scheduledBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#FFF8EC', paddingHorizontal: 7, paddingVertical: 3, borderRadius: radius.full },
  scheduledText:  { fontSize: 9, fontWeight: '800', color: '#FF9500' },

  endedText: { fontSize: 10, color: colors.textMuted },

  message: { fontSize: fontSize.sm, fontWeight: '600', color: colors.textPrimary, paddingRight: spacing.sm, lineHeight: 19 },
  meta:     { fontSize: 10, color: colors.textLight, paddingBottom: spacing.sm },

  cancelBtn: { padding: spacing.sm, alignSelf: 'flex-start', marginTop: 4 },

  empty:     { alignItems: 'center', gap: 10, paddingTop: 60 },
  emptyText: { fontSize: fontSize.md, fontWeight: '800', color: colors.textMuted },
  emptySub:  { fontSize: fontSize.sm, color: colors.textLight },
});
