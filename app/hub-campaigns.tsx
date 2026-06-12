/**
 * hub-campaigns.tsx
 * Hub admin: create/manage fundraising campaigns + export Gift Aid declarations.
 * Pass ?id=<hubId>.
 */

import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, RefreshControl, Modal, KeyboardAvoidingView, Platform, Share, Switch,
} from 'react-native';
import { Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { FundraisingProgress } from '@/components/FundraisingProgress';
import { uploadHubImage, type PickedFile } from '@/lib/image-upload';
import { formatPence } from '@/lib/local-api';
import {
  fetchHub, fetchHubCampaigns, createCampaign, updateCampaign, fetchHubDonations, createHubNotice,
  type Hub, type HubCampaign,
} from '@/lib/hubs-api';

const S = SECTIONS.community;
const DURATIONS = [
  { label: 'No end date', days: null as number | null },
  { label: '30 days', days: 30 },
  { label: '60 days', days: 60 },
  { label: '90 days', days: 90 },
];

function tint(hex?: string | null): string {
  if (!hex || !/^#?[0-9a-fA-F]{6}/.test(hex)) return S.color;
  return hex.startsWith('#') ? hex : `#${hex}`;
}
const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export default function HubCampaignsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [hub, setHub] = useState<Hub | null>(null);
  const [campaigns, setCampaigns] = useState<HubCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [story, setStory] = useState('');
  const [goalText, setGoalText] = useState('');
  const [durationIdx, setDurationIdx] = useState(0);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [coverFile, setCoverFile] = useState<PickedFile | null>(null);
  const [postNotice, setPostNotice] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [h, c] = await Promise.all([fetchHub(id), fetchHubCampaigns(id)]);
      setHub(h); setCampaigns(c);
    } finally { setLoading(false); }
  }, [id]);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  const accent = tint(hub?.brand_color);

  const openNew = () => { setEditId(null); setTitle(''); setStory(''); setGoalText(''); setDurationIdx(0); setCoverUrl(null); setCoverFile(null); setPostNotice(true); setEditorOpen(true); };
  const openEdit = (c: HubCampaign) => {
    setEditId(c.id); setTitle(c.title); setStory(c.story ?? ''); setGoalText((c.goal_pence / 100).toString());
    setDurationIdx(0); setCoverUrl(c.cover_url ?? null); setCoverFile(null); setEditorOpen(true);
  };

  const pickCover = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return Alert.alert('Permission needed', 'Allow photo access to add a cover.');
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [16, 9], quality: 0.85 });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    Haptics.selectionAsync();
    setCoverFile({ uri: a.uri, mimeType: a.mimeType, ext: a.fileName?.split('.').pop() });
    setCoverUrl(a.uri);
  };

  const save = async () => {
    if (!id) return;
    if (!title.trim()) { Alert.alert('Title needed', 'Give your fundraiser a title.'); return; }
    const goalPence = Math.round((parseFloat(goalText) || 0) * 100);
    if (goalPence < 100) { Alert.alert('Goal needed', 'Set a goal of at least £1.'); return; }
    setSaving(true);
    const days = DURATIONS[durationIdx].days;
    const ends_at = days ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
    try {
      // Upload a freshly-picked cover first (hub-scoped storage path).
      let cover = coverUrl;
      if (coverFile) { const up = await uploadHubImage(id, 'cover', coverFile); cover = up.publicUrl; }
      if (editId) {
        await updateCampaign(editId, { title: title.trim(), story: story.trim() || null, goal_pence: goalPence, cover_url: cover });
      } else {
        const created = await createCampaign(id, { title: title.trim(), story: story.trim() || null, goal_pence: goalPence, ends_at, cover_url: cover });
        if (postNotice) {
          await createHubNotice(id, {
            title: `Fundraiser: ${title.trim()}`,
            body: `We've launched a fundraiser — help us reach our ${formatPence(goalPence)} goal. Tap to donate.`,
            visibility: 'public',
            campaign_id: created.id,
          }).catch(() => { /* don't fail the campaign if the notice hiccups */ });
        }
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setEditorOpen(false); load();
    } catch (e: any) { Alert.alert('Could not save', e?.message ?? ''); }
    finally { setSaving(false); }
  };

  const toggleStatus = (c: HubCampaign) => {
    const next = c.status === 'active' ? 'closed' : 'active';
    updateCampaign(c.id, { status: next }).then(load).catch(e => Alert.alert('Could not update', e?.message ?? ''));
  };

  const exportGiftAid = async () => {
    if (!id || !hub) return;
    try {
      const donations = await fetchHubDonations(id, true);
      if (donations.length === 0) { Alert.alert('No Gift Aid donations', 'There are no Gift Aid declarations to export yet.'); return; }
      const header = ['Title', 'First name', 'Last name', 'House no. / address', 'Postcode', 'Donation date', 'Amount (£)'];
      const rows = donations.map(d => [
        d.ga_title ?? '', d.ga_first_name ?? '', d.ga_last_name ?? '', d.ga_address ?? '', d.ga_postcode ?? '',
        new Date(d.created_at).toLocaleDateString('en-GB'), (d.amount_pence / 100).toFixed(2),
      ].map(csvCell).join(','));
      const csv = [header.map(csvCell).join(','), ...rows].join('\n');
      await Share.share({
        title: `Gift Aid claim — ${hub.name}`,
        message: `Gift Aid declarations for ${hub.name}${hub.charity_number ? ` (${hub.charity_number})` : ''}\n\n${csv}`,
      });
    } catch (e: any) { Alert.alert('Could not export', e?.message ?? ''); }
  };

  if (loading) {
    return <SafeAreaView style={styles.safe} edges={['top']}><View style={styles.center}><ActivityIndicator color={S.color} /></View></SafeAreaView>;
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: accent }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={accent} />
          <Text style={[styles.backText, { color: accent }]}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Fundraising</Text>
        <TouchableOpacity onPress={openNew} hitSlop={12} style={{ width: 70, alignItems: 'flex-end' }}>
          <FontAwesome5 name="plus" size={16} color={accent} solid />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={accent} />}>

        {hub?.is_charity && hub?.charity_number ? (
          <TouchableOpacity style={[styles.giftAidBtn, { borderColor: accent }]} onPress={exportGiftAid} activeOpacity={0.85}>
            <FontAwesome5 name="file-export" size={13} color={accent} solid />
            <Text style={[styles.giftAidText, { color: accent }]}>Export Gift Aid claim</Text>
          </TouchableOpacity>
        ) : null}

        {campaigns.length === 0 ? (
          <View style={styles.empty}>
            <FontAwesome5 name="bullseye" size={26} color={colors.textLight} />
            <Text style={styles.emptyBody}>No fundraisers yet. Start one to raise money for your hub.</Text>
          </View>
        ) : campaigns.map(c => (
          <View key={c.id} style={[styles.card, c.status === 'closed' && { opacity: 0.7 }]}>
            <TouchableOpacity onPress={() => router.push(`/hub-campaign?id=${c.id}`)} activeOpacity={0.8}>
              <View style={styles.cardTop}>
                <Text style={styles.cardTitle} numberOfLines={1}>{c.title}</Text>
                {c.status === 'closed' ? <View style={styles.closedTag}><Text style={styles.closedTagText}>Closed</Text></View> : null}
              </View>
              <View style={{ marginTop: spacing.sm }}>
                <FundraisingProgress raisedPence={c.raised_pence} goalPence={c.goal_pence} donorCount={c.donor_count} endsAt={c.ends_at} accent={accent} compact />
              </View>
            </TouchableOpacity>
            <View style={styles.cardActions}>
              <TouchableOpacity onPress={() => openEdit(c)} hitSlop={8}><Text style={[styles.actionText, { color: accent }]}>Edit</Text></TouchableOpacity>
              <TouchableOpacity onPress={() => toggleStatus(c)} hitSlop={8}><Text style={styles.actionMuted}>{c.status === 'active' ? 'Close' : 'Reopen'}</Text></TouchableOpacity>
            </View>
          </View>
        ))}
        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Editor */}
      <Modal visible={editorOpen} transparent animationType="slide" onRequestClose={() => setEditorOpen(false)}>
        <KeyboardAvoidingView style={styles.modalWrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => !saving && setEditorOpen(false)} />
          <View style={styles.modalSheet}>
            <View style={styles.grabber} />
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.modalTitle}>{editId ? 'Edit fundraiser' : 'New fundraiser'}</Text>

              <Text style={styles.label}>Cover photo</Text>
              <TouchableOpacity style={[styles.coverPick, { borderColor: accent }]} onPress={pickCover} activeOpacity={0.85}>
                {coverUrl ? (
                  <Image source={{ uri: coverUrl }} style={styles.coverImg} />
                ) : (
                  <View style={styles.coverPlaceholder}>
                    <FontAwesome5 name="camera" size={20} color={accent} solid />
                    <Text style={[styles.coverHint, { color: accent }]}>Add a cover photo</Text>
                  </View>
                )}
              </TouchableOpacity>

              <Text style={styles.label}>Title</Text>
              <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholder="e.g. New minibus appeal" placeholderTextColor={colors.textLight} />

              <Text style={styles.label}>Goal (£)</Text>
              <TextInput style={styles.input} value={goalText} onChangeText={v => setGoalText(v.replace(/[^0-9.]/g, ''))} placeholder="e.g. 5000" placeholderTextColor={colors.textLight} keyboardType="decimal-pad" />

              {!editId ? (
                <>
                  <Text style={styles.label}>Runs for</Text>
                  <View style={styles.durRow}>
                    {DURATIONS.map((d, i) => (
                      <TouchableOpacity key={d.label} style={[styles.durBtn, durationIdx === i && { backgroundColor: accent, borderColor: accent }]}
                        onPress={() => setDurationIdx(i)} activeOpacity={0.85}>
                        <Text style={[styles.durText, durationIdx === i && { color: '#fff' }]}>{d.label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </>
              ) : null}

              <Text style={styles.label}>Story</Text>
              <TextInput style={[styles.input, styles.textarea]} value={story} onChangeText={setStory} placeholder="What are you raising money for?" placeholderTextColor={colors.textLight} multiline />

              {!editId ? (
                <View style={styles.noticeToggle}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.noticeToggleTitle}>Announce with a notice</Text>
                    <Text style={styles.noticeToggleSub}>Post a notice with a donate link + progress bar so members see it.</Text>
                  </View>
                  <Switch value={postNotice} onValueChange={setPostNotice} trackColor={{ true: accent }} />
                </View>
              ) : null}

              <TouchableOpacity style={[styles.saveBtn, { backgroundColor: accent }, saving && { opacity: 0.6 }]} onPress={save} disabled={saving} activeOpacity={0.85}>
                {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>{editId ? 'Save' : 'Start fundraiser'}</Text>}
              </TouchableOpacity>
              <View style={{ height: 20 }} />
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md, paddingBottom: spacing.sm, borderBottomWidth: 2, backgroundColor: '#fff' },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, width: 70 },
  backText: { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },

  content: { padding: spacing.md },
  giftAidBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1.5, borderRadius: radius.lg, paddingVertical: 12, marginBottom: spacing.md },
  giftAidText: { fontSize: fontSize.sm, fontWeight: '800' },

  empty: { alignItems: 'center', paddingVertical: spacing.xxl, gap: 10 },
  emptyBody: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },

  card: { backgroundColor: '#fff', borderRadius: radius.xl, borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: spacing.md },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary, flex: 1 },
  closedTag: { backgroundColor: '#F3F4F6', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  closedTagText: { fontSize: 11, fontWeight: '800', color: colors.textMuted },
  cardActions: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.md, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  actionText: { fontSize: fontSize.sm, fontWeight: '800' },
  actionMuted: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textMuted },

  modalWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: '#fff', borderTopLeftRadius: radius.xxl, borderTopRightRadius: radius.xxl, paddingHorizontal: spacing.lg, paddingTop: 10, paddingBottom: spacing.lg, maxHeight: '90%' },
  grabber: { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: spacing.md },
  modalTitle: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary, marginBottom: spacing.sm },
  label: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary, marginBottom: 6, marginTop: spacing.md },
  coverPick: { height: 150, borderRadius: radius.lg, borderWidth: 1.5, borderStyle: 'dashed', overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  coverImg: { width: '100%', height: '100%' },
  coverPlaceholder: { alignItems: 'center', gap: 8 },
  coverHint: { fontSize: fontSize.sm, fontWeight: '700' },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, fontSize: fontSize.md, color: colors.textPrimary },
  textarea: { minHeight: 90, textAlignVertical: 'top' },
  noticeToggle: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#F8F9FB', borderRadius: radius.lg, padding: spacing.md, marginTop: spacing.md },
  noticeToggleTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  noticeToggleSub: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2, lineHeight: 16 },
  durRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  durBtn: { paddingHorizontal: 12, paddingVertical: 9, borderRadius: 999, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border },
  durText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textSecondary },
  saveBtn: { marginTop: spacing.lg, borderRadius: radius.lg, paddingVertical: 15, alignItems: 'center' },
  saveText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
});
