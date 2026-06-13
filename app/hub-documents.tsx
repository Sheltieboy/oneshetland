/**
 * hub-documents.tsx
 * Hub documents (policies, minutes, forms…). Link-based: a title + a URL the hub
 * hosts. RLS returns only the documents the viewer may see; admins can add and
 * remove. Pass ?id=<hubId>.
 */

import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  Alert, RefreshControl, Linking,
} from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { IconButton } from '@/components/ui/IconButton';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingState } from '@/components/ui/LoadingState';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { useAuth } from '@/context/AuthContext';
import {
  fetchHub, fetchMyMembership, fetchHubDocuments, createHubDocument, deleteHubDocument,
  type Hub, type HubMember, type HubDocument, type NoticeVisibility,
} from '@/lib/hubs-api';

const S = SECTIONS.community;

const VIS: { key: NoticeVisibility; label: string; icon: string }[] = [
  { key: 'public',    label: 'Everyone',  icon: 'globe' },
  { key: 'members',   label: 'Members',   icon: 'lock' },
  { key: 'committee', label: 'Committee', icon: 'user-shield' },
];

export default function HubDocumentsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { profile } = useAuth();
  const { screenWidth } = useAppLayout();

  const [hub, setHub] = useState<Hub | null>(null);
  const [docs, setDocs] = useState<HubDocument[]>([]);
  const [membership, setMembership] = useState<HubMember | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [editorOpen, setEditorOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [vis, setVis] = useState<NoticeVisibility>('members');
  const [saving, setSaving] = useState(false);

  const isAdmin = membership?.status === 'active' && (membership.role === 'owner' || membership.role === 'committee');

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [h, d, mem] = await Promise.all([
        fetchHub(id), fetchHubDocuments(id),
        profile ? fetchMyMembership(id, profile.id) : Promise.resolve(null),
      ]);
      setHub(h); setDocs(d); setMembership(mem);
    } finally { setLoading(false); }
  }, [id, profile?.id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  const save = async () => {
    if (!id) return;
    if (!title.trim() || !url.trim()) { Alert.alert('Title and link needed', 'Add a title and a link.'); return; }
    const link = /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
    setSaving(true);
    try {
      await createHubDocument(id, { title: title.trim(), url: link, visibility: vis });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setEditorOpen(false); setTitle(''); setUrl(''); setVis('members');
      load();
    } catch (e: any) { Alert.alert('Could not add', e?.message ?? ''); }
    finally { setSaving(false); }
  };

  const remove = (d: HubDocument) => {
    Alert.alert('Remove document?', `"${d.title}" will be removed.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => { try { await deleteHubDocument(d.id); load(); } catch (e: any) { Alert.alert('Could not remove', e?.message ?? ''); } } },
    ]);
  };

  return (
    <ScreenScaffold
      header={
        <ScreenHeader
          title="Documents"
          accent={S.color}
          onBack={() => router.back()}
          rightElement={isAdmin ? (
            <IconButton icon="plus" color={S.color} onPress={() => setEditorOpen(true)} />
          ) : undefined}
        />
      }
    >
      <ScrollView contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={S.color} />}>
        {loading ? (
          <LoadingState accent={S.color} />
        ) : docs.length === 0 ? (
          <EmptyState icon="folder-open" title="No documents yet." accent={S.color} variant="card" />
        ) : docs.map(d => (
          <View key={d.id} style={styles.docRow}>
            <TouchableOpacity style={styles.docMain} onPress={() => Linking.openURL(d.url)} activeOpacity={0.7}>
              <View style={[styles.docIcon, { backgroundColor: S.color + '18' }]}>
                <FontAwesome5 name="file-alt" size={15} color={S.color} solid />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.docTitle} numberOfLines={2}>{d.title}</Text>
                <Text style={styles.docVis}>{d.visibility === 'public' ? 'Everyone' : d.visibility === 'committee' ? 'Committee only' : 'Members only'}</Text>
              </View>
              <FontAwesome5 name="external-link-alt" size={12} color={colors.textLight} />
            </TouchableOpacity>
            {isAdmin ? (
              <TouchableOpacity onPress={() => remove(d)} hitSlop={8} style={styles.docDel}>
                <FontAwesome5 name="trash-alt" size={13} color={colors.textMuted} />
              </TouchableOpacity>
            ) : null}
          </View>
        ))}
        <View style={{ height: 40 }} />
      </ScrollView>

      <Sheet visible={editorOpen} onClose={() => !saving && setEditorOpen(false)} title="Add document">
        <Text style={styles.label}>Title</Text>
        <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholder="e.g. Club constitution" placeholderTextColor={colors.textLight} />

        <Text style={styles.label}>Link (URL)</Text>
        <TextInput style={styles.input} value={url} onChangeText={setUrl} placeholder="https://…  (Drive, Dropbox, a PDF link)" placeholderTextColor={colors.textLight} autoCapitalize="none" keyboardType="url" />
        <Text style={styles.hint}>Paste a link to a file you host (Google Drive, Dropbox, your website).</Text>

        <Text style={styles.label}>Who can see it</Text>
        <View style={styles.visRow}>
          {VIS.map(v => (
            <TouchableOpacity key={v.key} style={[styles.visBtn, vis === v.key && { backgroundColor: S.color, borderColor: S.color }]}
              onPress={() => setVis(v.key)} activeOpacity={0.85}>
              <FontAwesome5 name={v.icon as any} size={11} color={vis === v.key ? '#fff' : colors.textMuted} solid />
              <Text style={[styles.visText, vis === v.key && { color: '#fff' }]}>{v.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Button label="Add document" onPress={save} color={S.color} loading={saving} disabled={saving} fullWidth style={styles.saveBtn} />
      </Sheet>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md },

  docRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, marginBottom: 10 },
  docMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  docIcon: { width: 40, height: 40, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  docTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  docVis: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
  docDel: { padding: 14 },

  label: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary, marginBottom: 6, marginTop: spacing.md },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, fontSize: fontSize.md, color: colors.textPrimary },
  hint: { fontSize: fontSize.xs, color: colors.textLight, marginTop: 4 },
  visRow: { flexDirection: 'row', gap: 8 },
  visBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: radius.md, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border },
  visText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textSecondary },
  saveBtn: { marginTop: spacing.lg },
});
