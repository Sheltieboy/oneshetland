/**
 * hub-directory.tsx
 * Member directory — names, role and tier only (no contact details). Visible to
 * active members when the hub has the directory switched on. Pass ?id=<hubId>.
 */

import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { fetchHub, fetchHubDirectory, type Hub, type HubDirectoryEntry } from '@/lib/hubs-api';

const S = SECTIONS.community;

export default function HubDirectoryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [hub, setHub] = useState<Hub | null>(null);
  const [rows, setRows] = useState<HubDirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      const [h, d] = await Promise.all([fetchHub(id), fetchHubDirectory(id)]);
      setHub(h); setRows(d);
    } catch (e: any) {
      setError(e?.message ?? 'Could not load the directory.');
      setRows([]);
    } finally { setLoading(false); }
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  const initial = (n: string) => (n.trim()[0] ?? '?').toUpperCase();

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{hub?.name ?? 'Members'}</Text>
        <View style={{ width: 70 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={S.color} />}>
        {loading ? (
          <View style={styles.center}><ActivityIndicator color={S.color} /></View>
        ) : error ? (
          <View style={styles.empty}><FontAwesome5 name="lock" size={24} color={colors.textLight} /><Text style={styles.emptyBody}>{error}</Text></View>
        ) : (
          <>
            <Text style={styles.count}>{rows.length} member{rows.length === 1 ? '' : 's'}</Text>
            {rows.map(r => (
              <View key={r.user_id} style={styles.row}>
                <View style={[styles.avatar, { backgroundColor: S.color }]}><Text style={styles.avatarText}>{initial(r.name)}</Text></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{r.name}</Text>
                  {r.tier ? <Text style={styles.sub}>{r.tier}</Text> : null}
                </View>
                {r.role !== 'member' ? (
                  <View style={[styles.roleTag, { backgroundColor: S.color + '22' }]}>
                    <Text style={[styles.roleText, { color: S.color }]}>{r.role}</Text>
                  </View>
                ) : null}
              </View>
            ))}
          </>
        )}
        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingBottom: spacing.sm, borderBottomWidth: 2, backgroundColor: '#fff',
  },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, width: 70 },
  backText: { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, flex: 1, textAlign: 'center' },

  content: { padding: spacing.md },
  center: { paddingVertical: spacing.xl, alignItems: 'center' },
  empty: { alignItems: 'center', paddingVertical: spacing.xxl, gap: 10 },
  emptyBody: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },
  count: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: spacing.sm },

  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 12, marginBottom: 8 },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '800', fontSize: fontSize.md },
  name: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  sub: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  roleTag: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999 },
  roleText: { fontSize: 11, fontWeight: '800', textTransform: 'capitalize' },
});
