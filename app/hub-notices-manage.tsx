/**
 * hub-notices-manage.tsx
 * Admin view of a Hub's notices — post new ones and delete old ones.
 * Pass ?id=<hubId>.
 */

import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  ActivityIndicator, Alert, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { fetchHubNotices, deleteNotice, type HubNotice } from '@/lib/hubs-api';

const S = SECTIONS.community;

export default function HubNoticesManageScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [notices, setNotices] = useState<HubNotice[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try { setNotices(await fetchHubNotices(id)); }
    finally { setLoading(false); }
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  const remove = (n: HubNotice) => {
    Alert.alert('Delete notice?', `"${n.title}" will be removed.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try { await deleteNotice(n.id); load(); }
          catch (e: any) { Alert.alert('Could not delete', e?.message ?? ''); }
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Notices</Text>
        <TouchableOpacity onPress={() => id && router.push(`/hub-notice-compose?hub=${id}`)} hitSlop={12} style={{ width: 70, alignItems: 'flex-end' }}>
          <FontAwesome5 name="plus" size={16} color={S.color} solid />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={S.color} />}>

        <TouchableOpacity style={[styles.postBtn, { backgroundColor: S.color }]}
          onPress={() => id && router.push(`/hub-notice-compose?hub=${id}`)} activeOpacity={0.85}>
          <FontAwesome5 name="plus" size={13} color="#fff" solid />
          <Text style={styles.postBtnText}>Post a notice</Text>
        </TouchableOpacity>

        {loading ? (
          <View style={styles.center}><ActivityIndicator color={S.color} /></View>
        ) : notices.length === 0 ? (
          <View style={styles.empty}>
            <FontAwesome5 name="bullhorn" size={26} color={colors.textLight} />
            <Text style={styles.emptyBody}>No notices yet. Post your first update.</Text>
          </View>
        ) : notices.map(n => (
          <View key={n.id} style={styles.notice}>
            {n.image_url ? <Image source={{ uri: n.image_url }} style={styles.noticeImg} /> : null}
            <View style={{ flex: 1 }}>
              <View style={styles.noticeTop}>
                <Text style={styles.noticeTitle} numberOfLines={2}>{n.title}</Text>
                <View style={[styles.visTag, n.visibility !== 'public' ? styles.visMembers : styles.visPublic]}>
                  <FontAwesome5 name={n.visibility === 'public' ? 'globe' : 'lock'} size={8} color={n.visibility === 'public' ? '#2A8B5C' : '#6B47BF'} solid />
                  <Text style={[styles.visText, { color: n.visibility === 'public' ? '#2A8B5C' : '#6B47BF' }]}>
                    {n.visibility === 'public' ? 'Public' : 'Members'}
                  </Text>
                </View>
              </View>
              {n.body ? <Text style={styles.noticeBody} numberOfLines={2}>{n.body}</Text> : null}
              <Text style={styles.noticeDate}>
                {new Date(n.published_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                {n.expires_at ? `  ·  until ${new Date(n.expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}
              </Text>
            </View>
            <TouchableOpacity onPress={() => remove(n)} hitSlop={8} style={styles.delBtn}>
              <FontAwesome5 name="trash-alt" size={14} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
        ))}
        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  center: { paddingVertical: spacing.xl, alignItems: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingBottom: spacing.sm, borderBottomWidth: 2, backgroundColor: '#fff',
  },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, width: 70 },
  backText: { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },

  content: { padding: spacing.md },
  postBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: radius.lg, paddingVertical: 14, marginBottom: spacing.md },
  postBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },

  empty: { alignItems: 'center', paddingVertical: spacing.xxl, gap: 10 },
  emptyBody: { fontSize: fontSize.sm, color: colors.textMuted },

  notice: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 12, marginBottom: 10 },
  noticeImg: { width: 52, height: 52, borderRadius: 10 },
  noticeTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  noticeTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary, flexShrink: 1 },
  noticeBody: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 3, lineHeight: 18 },
  noticeDate: { fontSize: 11, color: colors.textLight, marginTop: 5 },
  visTag: { flexDirection: 'row', alignItems: 'center', gap: 3, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 },
  visPublic: { backgroundColor: '#DCFCE7' },
  visMembers: { backgroundColor: '#EDE9FE' },
  visText: { fontSize: 9, fontWeight: '800' },
  delBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F3F4F6' },
});
