/**
 * hub-notices-manage.tsx
 * Admin view of a Hub's notices — post new ones and delete old ones.
 * Pass ?id=<hubId>.
 */

import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  Alert, RefreshControl,
} from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { fetchHubNotices, deleteNotice, type HubNotice } from '@/lib/hubs-api';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingState } from '@/components/ui/LoadingState';

const S = SECTIONS.community;

export default function HubNoticesManageScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { screenWidth } = useAppLayout();
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
    <ScreenScaffold
      header={
        <ScreenHeader
          title="Notices"
          accent={S.color}
          rightElement={
            <IconButton icon="plus" color={S.color} onPress={() => id && router.push(`/hub-notice-compose?hub=${id}`)} />
          }
        />
      }
    >
      <ScrollView contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={S.color} />}>

        <Button
          label="Post a notice"
          icon="plus"
          color={S.color}
          fullWidth
          onPress={() => id && router.push(`/hub-notice-compose?hub=${id}`)}
          style={styles.postBtnSpacing}
        />

        {loading ? (
          <LoadingState accent={S.color} />
        ) : notices.length === 0 ? (
          <EmptyState
            icon="bullhorn"
            title="No notices yet"
            body="Post your first update."
            accent={S.color}
            variant="card"
          />
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
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md },
  postBtnSpacing: { marginBottom: spacing.md },

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
