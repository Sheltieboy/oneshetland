/**
 * hub-campaign.tsx
 * Public campaign page: progress graphic, story, donor wall, Donate button.
 * Pass ?id=<campaignId>.
 */

import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl,
  Image, Modal, Share,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import QRCode from 'react-native-qrcode-svg';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { FundraisingProgress } from '@/components/FundraisingProgress';
import { ContentActions } from '@/components/ContentActions';
import { formatPence } from '@/lib/local-api';
import {
  fetchCampaign, fetchHub, fetchCampaignDonors,
  type HubCampaign, type Hub, type DonorWallEntry,
} from '@/lib/hubs-api';

const S = SECTIONS.community;
function tint(hex?: string | null): string {
  if (!hex || !/^#?[0-9a-fA-F]{6}/.test(hex)) return S.color;
  return hex.startsWith('#') ? hex : `#${hex}`;
}
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export default function HubCampaignScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [campaign, setCampaign] = useState<HubCampaign | null>(null);
  const [hub, setHub] = useState<Hub | null>(null);
  const [donors, setDonors] = useState<DonorWallEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);

  const shareUrl = id ? `https://oneshetland.com/give/${id}` : '';

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const c = await fetchCampaign(id);
      setCampaign(c);
      if (c) {
        const [h, d] = await Promise.all([fetchHub(c.hub_id), fetchCampaignDonors(c.id).catch(() => [])]);
        setHub(h); setDonors(d);
      }
    } finally { setLoading(false); }
  }, [id]);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  if (loading) {
    return <SafeAreaView style={styles.safe} edges={['top']}><View style={styles.center}><ActivityIndicator color={S.color} /></View></SafeAreaView>;
  }
  if (!campaign || !hub) {
    return <SafeAreaView style={styles.safe} edges={['top']}><View style={styles.center}><Text style={styles.muted}>Campaign not found.</Text></View></SafeAreaView>;
  }

  const accent = tint(hub.brand_color);
  const closed = campaign.status === 'closed';

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: accent }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={accent} />
          <Text style={[styles.backText, { color: accent }]}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Fundraiser</Text>
        <View style={{ width: 70, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: spacing.xs }}>
          <TouchableOpacity onPress={() => setQrOpen(true)} hitSlop={12}>
            <FontAwesome5 name="qrcode" size={18} color={accent} solid />
          </TouchableOpacity>
          <ContentActions
            contentType="hub_campaign"
            contentId={campaign.id}
            icon="ellipsis-v"
            color={accent}
          />
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={accent} />}>
        {campaign.cover_url ? <Image source={{ uri: campaign.cover_url }} style={styles.cover} /> : null}
        <Text style={styles.title}>{campaign.title}</Text>
        <Text style={styles.org}>{hub.name}</Text>

        <View style={styles.progressCard}>
          <FundraisingProgress
            raisedPence={campaign.raised_pence} goalPence={campaign.goal_pence}
            donorCount={campaign.donor_count} endsAt={campaign.ends_at} accent={accent}
          />
        </View>

        {campaign.story ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>About this fundraiser</Text>
            <Text style={styles.story}>{campaign.story}</Text>
          </View>
        ) : null}

        {donors.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Recent supporters</Text>
            {donors.map((d, i) => (
              <View key={i} style={styles.donorRow}>
                <View style={[styles.donorAvatar, { backgroundColor: accent + '22' }]}>
                  <FontAwesome5 name={d.is_anonymous ? 'user-secret' : 'heart'} size={11} color={accent} solid />
                </View>
                <View style={{ flex: 1 }}>
                  <View style={styles.donorNameRow}>
                    <Text style={[styles.donorName, d.is_anonymous && { color: colors.textMuted, fontStyle: 'italic' }]}>{d.name}</Text>
                    {d.gift_aid ? (
                      <View style={styles.gaTag}><Text style={styles.gaTagText}>+ Gift Aid</Text></View>
                    ) : null}
                  </View>
                  {d.message ? <Text style={styles.donorMsg} numberOfLines={2}>{d.message}</Text> : null}
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={[styles.donorAmount, { color: accent }]}>{formatPence(d.amount_pence)}</Text>
                  <Text style={styles.donorDate}>{fmtDate(d.created_at)}</Text>
                </View>
              </View>
            ))}
          </View>
        ) : null}

        <View style={{ height: 100 }} />
      </ScrollView>

      {!closed ? (
        <View style={styles.footer}>
          <TouchableOpacity style={[styles.donateBtn, { backgroundColor: accent }]} onPress={() => router.push(`/hub-donate?campaign=${campaign.id}`)} activeOpacity={0.85}>
            <FontAwesome5 name="heart" size={15} color="#fff" solid />
            <Text style={styles.donateText}>Donate</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.footer}><Text style={styles.closedText}>This fundraiser has closed. Thank you to everyone who gave.</Text></View>
      )}

      {/* Share / QR poster */}
      <Modal visible={qrOpen} transparent animationType="fade" onRequestClose={() => setQrOpen(false)}>
        <View style={styles.qrWrap}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setQrOpen(false)} />
          <View style={styles.qrCard}>
            <Text style={styles.qrTitle}>{campaign.title}</Text>
            <Text style={styles.qrSub}>Scan to donate</Text>
            <View style={styles.qrBox}>
              <QRCode value={shareUrl} size={200} backgroundColor="#fff" color="#0F1C26" />
            </View>
            <Text style={styles.qrUrl}>{shareUrl}</Text>
            <TouchableOpacity style={[styles.qrShareBtn, { backgroundColor: accent }]}
              onPress={() => Share.share({ title: campaign.title, message: `Support ${hub.name}: ${campaign.title}\n${shareUrl}` })}
              activeOpacity={0.85}>
              <FontAwesome5 name="share" size={13} color="#fff" solid />
              <Text style={styles.qrShareText}>Share link</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setQrOpen(false)} hitSlop={8} style={{ marginTop: 10 }}>
              <Text style={styles.qrClose}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  muted: { color: colors.textMuted, fontSize: fontSize.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md, paddingBottom: spacing.sm, borderBottomWidth: 2, backgroundColor: '#fff' },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, width: 70 },
  backText: { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },

  content: { padding: spacing.md },
  cover: { width: '100%', height: 180, borderRadius: radius.xl, marginBottom: spacing.md },
  title: { fontSize: 22, fontWeight: '900', color: colors.textPrimary, letterSpacing: -0.4 },

  qrWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  qrCard: { backgroundColor: '#fff', borderRadius: radius.xxl, padding: spacing.xl, alignItems: 'center', width: '100%', maxWidth: 340 },
  qrTitle: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary, textAlign: 'center' },
  qrSub: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 2, marginBottom: spacing.lg },
  qrBox: { padding: 16, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border },
  qrUrl: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: spacing.md, textAlign: 'center' },
  qrShareBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: radius.lg, paddingVertical: 14, paddingHorizontal: 28, marginTop: spacing.lg },
  qrShareText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
  qrClose: { color: colors.textMuted, fontSize: fontSize.sm, fontWeight: '700' },
  org: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 2 },

  progressCard: { backgroundColor: '#fff', borderRadius: radius.xl, borderWidth: 1, borderColor: colors.border, padding: spacing.lg, marginTop: spacing.lg },

  section: { marginTop: spacing.lg },
  sectionTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, marginBottom: 8 },
  story: { fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 22 },

  donorRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 12, marginBottom: 8 },
  donorAvatar: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  donorNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  donorName: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  gaTag: { backgroundColor: '#DCFCE7', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  gaTagText: { fontSize: 10, fontWeight: '800', color: '#15803D' },
  donorMsg: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  donorAmount: { fontSize: fontSize.sm, fontWeight: '800' },
  donorDate: { fontSize: 11, color: colors.textLight, marginTop: 1 },

  footer: { padding: spacing.md, paddingBottom: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: '#fff' },
  donateBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: radius.lg, paddingVertical: 16 },
  donateText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
  closedText: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },
});
