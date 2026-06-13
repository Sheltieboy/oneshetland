/**
 * hub-directory.tsx
 * Member directory — names, role and tier only (no contact details). Visible to
 * active members when the hub has the directory switched on. Pass ?id=<hubId>.
 */

import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, RefreshControl,
} from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { LoadingState } from '@/components/ui/LoadingState';
import { EmptyState } from '@/components/ui/EmptyState';
import { fetchHub, fetchHubDirectory, type Hub, type HubDirectoryEntry } from '@/lib/hubs-api';

const S = SECTIONS.community;

export default function HubDirectoryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { screenWidth } = useAppLayout();
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
    <ScreenScaffold
      header={<ScreenHeader title={hub?.name ?? 'Members'} accent={S.color} onBack={() => router.back()} />}
    >
      <ScrollView contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={S.color} />}>
        {loading ? (
          <LoadingState accent={S.color} />
        ) : error ? (
          <EmptyState icon="lock" title="Directory unavailable" body={error} accent={S.color} variant="card" />
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
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md },
  count: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: spacing.sm },

  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 12, marginBottom: 8 },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '800', fontSize: fontSize.md },
  name: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  sub: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  roleTag: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999 },
  roleText: { fontSize: 11, fontWeight: '800', textTransform: 'capitalize' },
});
