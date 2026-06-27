/**
 * app/notifications.tsx
 *
 * In-app notification inbox — the history of everything the app has notified
 * you about (from notification_log). Tapping an item marks it read and opens
 * the relevant screen. So a missed push is never lost.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { useAuth } from '@/context/AuthContext';
import { notificationRoute } from '@/lib/notifications';
import { NOTIFICATION_MODULES } from '@/lib/notification-prefs';
import {
  fetchInbox, markNotificationsRead, type InboxNotification,
} from '@/lib/notifications-inbox';

// category like 'fetch.delivered' → the owning module's icon + colour.
function moduleVisual(category: string): { icon: string; color: string } {
  const moduleKey = category.split('.')[0];
  const m = NOTIFICATION_MODULES.find(x => x.module === moduleKey);
  return { icon: m?.icon ?? 'bell', color: m?.color ?? colors.navy };
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export default function NotificationsInboxScreen() {
  const router = useRouter();
  const { profile } = useAuth();

  const [items, setItems]       = useState<InboxNotification[]>([]);
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefresh] = useState(false);

  const load = useCallback(async () => {
    if (!profile) { setLoading(false); return; }
    try {
      setItems(await fetchInbox());
    } catch (e) {
      console.warn('[inbox] load failed', e);
    } finally {
      setLoading(false);
      setRefresh(false);
    }
  }, [profile?.id]);

  useEffect(() => { load(); }, [load]);

  const onTap = async (item: InboxNotification) => {
    // Optimistically mark read.
    if (!item.read_at) {
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, read_at: new Date().toISOString() } : i));
      markNotificationsRead([item.id]).catch(() => {});
    }
    const route = notificationRoute(item.data);
    if (route) { try { router.push(route as never); } catch { /* ignore */ } }
  };

  const markAll = async () => {
    setItems(prev => prev.map(i => ({ ...i, read_at: i.read_at ?? new Date().toISOString() })));
    try { await markNotificationsRead(); } catch { load(); }
  };

  const hasUnread = items.some(i => !i.read_at);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color="#fff" />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Notifications</Text>
        <TouchableOpacity onPress={markAll} disabled={!hasUnread} hitSlop={8} style={{ width: 70, alignItems: 'flex-end' }}>
          <Text style={[styles.markAll, !hasUnread && styles.markAllOff]}>Mark all</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" /></View>
      ) : !profile ? (
        <View style={styles.center}><Text style={styles.dim}>Sign in to see your notifications.</Text></View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={i => i.id}
          contentContainerStyle={items.length === 0 ? styles.emptyWrap : styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefresh(true); load(); }} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <FontAwesome5 name="bell-slash" size={28} color={colors.textLight} />
              <Text style={styles.emptyTitle}>Nothing yet</Text>
              <Text style={styles.dim}>Your notifications will appear here.</Text>
            </View>
          }
          renderItem={({ item }) => {
            const v = moduleVisual(item.category);
            const unread = !item.read_at;
            return (
              <TouchableOpacity
                style={[styles.row, unread && styles.rowUnread]}
                onPress={() => onTap(item)}
                activeOpacity={0.7}
              >
                <View style={[styles.iconWrap, { backgroundColor: v.color + '20' }]}>
                  <FontAwesome5 name={v.icon as any} size={14} color={v.color} solid />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle} numberOfLines={1}>{item.title}</Text>
                  <Text style={styles.rowBody} numberOfLines={2}>{item.body}</Text>
                  <Text style={styles.rowTime}>{relativeTime(item.created_at)}</Text>
                </View>
                {unread && <View style={styles.unreadDot} />}
              </TouchableOpacity>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.navy },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, gap: 8 },
  dim:    { color: colors.textMuted, textAlign: 'center' },

  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
  },
  backBtn:     { flexDirection: 'row', alignItems: 'center', gap: 8, width: 70 },
  backText:    { color: '#fff', fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '800', flex: 1, textAlign: 'center' },
  markAll:     { color: '#fff', fontSize: fontSize.sm, fontWeight: '700' },
  markAllOff:  { opacity: 0.4 },

  listContent: { backgroundColor: colors.screenBackground, paddingVertical: spacing.xs },
  emptyWrap:   { flexGrow: 1, backgroundColor: colors.screenBackground },
  emptyTitle:  { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, marginTop: 4 },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', paddingHorizontal: spacing.md, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  rowUnread:  { backgroundColor: '#F4F9FC' },
  iconWrap:   { width: 38, height: 38, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  rowTitle:   { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  rowBody:    { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2, lineHeight: 17 },
  rowTime:    { fontSize: 11, color: colors.textLight, marginTop: 4 },
  unreadDot:  { width: 9, height: 9, borderRadius: 5, backgroundColor: '#12B3D6' },
});
