/**
 * (admin)/alerts.tsx
 *
 * Platform-wide alerts overview — all live, scheduled and recent alerts
 * across every business. Admin can force-expire any alert.
 */

import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius, shadow } from '@/constants/theme';
import { fetchAllAlertsAdmin, forceExpireAlert, type PartnerAlert } from '@/lib/alerts-api';

const TYPE_META = {
  emergency:  { label: 'Emergency',  color: '#FF3B30', bg: '#FFF2F1', icon: 'exclamation-triangle' },
  disruption: { label: 'Disruption', color: '#FF9500', bg: '#FFF8EC', icon: 'exclamation-circle'  },
  info:       { label: 'Info',       color: '#0A84FF', bg: '#EEF5FF', icon: 'info-circle'          },
} as const;

function alertStatus(a: PartnerAlert): 'live' | 'scheduled' | 'ended' {
  const now = Date.now();
  if (!a.is_active) {
    if (a.starts_at && new Date(a.starts_at).getTime() > now) return 'scheduled';
    return 'ended';
  }
  if (a.expires_at && new Date(a.expires_at).getTime() <= now) return 'ended';
  return 'live';
}

function timeRemaining(expiresAt: string | null): string {
  if (!expiresAt) return 'No expiry set';
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'Expired';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m remaining` : `${m}m remaining`;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
}

export default function AdminAlertsScreen() {
  const router = useRouter();
  const [alerts,     setAlerts]     = useState<PartnerAlert[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const data = await fetchAllAlertsAdmin().catch(() => []);
    setAlerts(data);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const live      = alerts.filter(a => alertStatus(a) === 'live');
  const scheduled = alerts.filter(a => alertStatus(a) === 'scheduled');
  const ended     = alerts.filter(a => alertStatus(a) === 'ended');

  const handleForceExpire = (a: PartnerAlert) => {
    Alert.alert(
      'Force end this alert?',
      `"${a.business_name}" — ${a.message.slice(0, 60)}${a.message.length > 60 ? '…' : ''}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'End alert',
          style: 'destructive',
          onPress: async () => {
            try { await forceExpireAlert(a.id); await load(); } catch {}
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <FontAwesome5 name="chevron-left" size={14} color="#fff" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Platform Alerts</Text>
          {live.length > 0
            ? <Text style={styles.headerSub}>{live.length} live right now</Text>
            : <Text style={styles.headerSub}>No alerts live</Text>
          }
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
          {live.length > 0 && (
            <View style={styles.section}>
              <SectionHeader label="LIVE NOW" color="#FF3B30" count={live.length} />
              {live.map(a => (
                <AdminAlertCard key={a.id} alert={a} status="live" onForceExpire={() => handleForceExpire(a)} />
              ))}
            </View>
          )}

          {scheduled.length > 0 && (
            <View style={styles.section}>
              <SectionHeader label="SCHEDULED" color="#FF9500" count={scheduled.length} />
              {scheduled.map(a => (
                <AdminAlertCard key={a.id} alert={a} status="scheduled" />
              ))}
            </View>
          )}

          {ended.length > 0 && (
            <View style={styles.section}>
              <SectionHeader label="ENDED THIS WEEK" color={colors.textMuted} count={ended.length} />
              {ended.map(a => (
                <AdminAlertCard key={a.id} alert={a} status="ended" />
              ))}
            </View>
          )}

          {alerts.length === 0 && (
            <View style={styles.empty}>
              <FontAwesome5 name="broadcast-tower" size={32} color={colors.textMuted} />
              <Text style={styles.emptyText}>No alerts this week</Text>
            </View>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function SectionHeader({ label, color, count }: { label: string; color: string; count: number }) {
  return (
    <View style={styles.sectionHeader}>
      <View style={[styles.sectionBar, { backgroundColor: color }]} />
      <Text style={styles.sectionLabel}>{label}</Text>
      <View style={[styles.countBadge, { backgroundColor: color + '20' }]}>
        <Text style={[styles.countText, { color }]}>{count}</Text>
      </View>
    </View>
  );
}

function AdminAlertCard({ alert: a, status, onForceExpire }: {
  alert: PartnerAlert;
  status: 'live' | 'scheduled' | 'ended';
  onForceExpire?: () => void;
}) {
  const meta = TYPE_META[a.type];

  return (
    <View style={[styles.card, status === 'ended' && styles.cardEnded]}>
      <View style={[styles.colorBar, { backgroundColor: status === 'ended' ? colors.border : meta.color }]} />
      <View style={{ flex: 1, padding: spacing.sm, gap: 5 }}>
        {/* Business + type row */}
        <View style={styles.cardTopRow}>
          <Text style={styles.bizName}>{a.business_name}</Text>
          <View style={[styles.typePill, { backgroundColor: status === 'ended' ? '#F2F2F7' : meta.bg }]}>
            <Text style={[styles.typePillText, { color: status === 'ended' ? colors.textMuted : meta.color }]}>
              {meta.label}
            </Text>
          </View>
        </View>

        <Text style={[styles.message, status === 'ended' && { color: colors.textMuted }]} numberOfLines={3}>
          {a.message}
        </Text>

        {/* Status line */}
        {status === 'live' && (
          <Text style={[styles.statusLine, { color: '#FF3B30' }]}>
            🔴 Live · {timeRemaining(a.expires_at)}
          </Text>
        )}
        {status === 'scheduled' && (
          <Text style={[styles.statusLine, { color: '#FF9500' }]}>
            🕐 Scheduled for {fmtDate(a.starts_at)}
          </Text>
        )}
        {status === 'ended' && (
          <Text style={styles.statusLine}>
            Ended · sent {fmtDate(a.created_at)}
          </Text>
        )}
      </View>

      {status === 'live' && onForceExpire && (
        <TouchableOpacity onPress={onForceExpire} style={styles.forceBtn} hitSlop={8}>
          <FontAwesome5 name="stop-circle" size={16} color="#FF3B30" />
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.navy },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  header: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: spacing.md, paddingVertical: 14,
    backgroundColor: colors.navy,
  },
  backBtn:     { width: 36 },
  headerTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '900' },
  headerSub:   { color: 'rgba(255,255,255,0.55)', fontSize: fontSize.xs, marginTop: 1 },

  section:       { gap: 8 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  sectionBar:    { width: 4, height: 16, borderRadius: 2 },
  sectionLabel:  { fontSize: 11, fontWeight: '900', letterSpacing: 1, color: colors.textMuted, flex: 1 },
  countBadge:    { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.full },
  countText:     { fontSize: 11, fontWeight: '900' },

  card: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    flexDirection: 'row', overflow: 'hidden', ...shadow.card,
  },
  cardEnded: { backgroundColor: colors.offWhite },
  colorBar:  { width: 4, alignSelf: 'stretch' },

  cardTopRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bizName:    { flex: 1, fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  typePill:   { paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.full },
  typePillText: { fontSize: 9, fontWeight: '900', letterSpacing: 0.8 },

  message:    { fontSize: fontSize.sm, color: colors.textPrimary, lineHeight: 18 },
  statusLine: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600' },

  forceBtn: { padding: spacing.sm, alignSelf: 'center', marginRight: 4 },

  empty:     { alignItems: 'center', gap: 12, paddingTop: 60 },
  emptyText: { fontSize: fontSize.md, color: colors.textMuted, fontWeight: '700' },
});
