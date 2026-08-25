/**
 * hub-my-memberships.tsx
 * The user's digital membership cards — one per hub they belong to. Each card
 * shows the hub branding, tier, member number, validity, and a QR code of the
 * member identity to show at the door.
 */

import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image, RefreshControl,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import QRCode from 'react-native-qrcode-svg';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingState } from '@/components/ui/LoadingState';
import { useAuth } from '@/context/AuthContext';
import {
  fetchMyHubMemberships, isMembershipActive, formatMembershipPrice,
  HUB_TYPE_ICONS,
  type HubMember,
} from '@/lib/hubs-api';

const S = SECTIONS.community;

function tint(hex?: string | null): string {
  if (!hex || !/^#?[0-9a-fA-F]{6}/.test(hex)) return S.color;
  return hex.startsWith('#') ? hex : `#${hex}`;
}
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export default function MyMembershipsScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const { screenWidth } = useAppLayout();
  const [memberships, setMemberships] = useState<HubMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!profile?.id) { setLoading(false); return; }
    try { setMemberships(await fetchMyHubMemberships(profile.id)); setLoadError(false); }
    catch { setMemberships([]); setLoadError(true); }
    finally { setLoading(false); }
  }, [profile?.id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  return (
    <ScreenScaffold header={<ScreenHeader title="My memberships" accent={S.color} />}>
      <ScrollView contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={S.color} />}>

        {loading ? (
          <LoadingState accent={S.color} />
        ) : loadError && memberships.length === 0 ? (
          <EmptyState
            icon="exclamation-circle"
            title="Couldn't load your memberships"
            body="Something went agley — pull doon to try again."
            accent={colors.error}
            variant="card"
            actionLabel="Try again"
            onAction={() => { setLoading(true); load(); }}
          />
        ) : memberships.length === 0 ? (
          <EmptyState
            icon="id-card"
            title="No memberships yet"
            body="Join a Hub to get your membership card here."
            accent={S.color}
            variant="card"
            actionLabel="Browse Hubs"
            onAction={() => router.push('/hubs')}
          />
        ) : memberships.map(m => {
          const accent = tint(m.hub?.brand_color);
          const valid = isMembershipActive(m);
          const qrPayload = `oneshetland-hub-member:${m.hub_id}:${m.member_no ?? m.id}`;
          return (
            <TouchableOpacity key={m.id} activeOpacity={0.9}
              onPress={() => m.hub_id && router.push(`/hubs/${m.hub_id}`)} style={styles.cardShadow}>
              <View style={[styles.card, { backgroundColor: accent }]}>
                <View style={styles.cardTop}>
                  <View style={styles.cardLogo}>
                    {m.hub?.logo_url
                      ? <Image source={{ uri: m.hub.logo_url }} style={styles.cardLogoImg} />
                      : <FontAwesome5 name={(HUB_TYPE_ICONS[m.hub?.type ?? 'community']) as any} size={18} color={accent} solid />}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cardHub} numberOfLines={1}>{m.hub?.name ?? 'Hub'}</Text>
                    <Text style={styles.cardTier}>
                      {m.membership_type?.name ?? 'Member'}
                      {m.role !== 'member' ? `  ·  ${m.role}` : ''}
                    </Text>
                  </View>
                  <View style={[styles.statusChip, { backgroundColor: valid ? 'rgba(255,255,255,0.22)' : '#B45309' }]}>
                    <Text style={styles.statusText}>{valid ? 'Active' : 'Expired'}</Text>
                  </View>
                </View>

                <View style={styles.qrWrap}>
                  <QRCode value={qrPayload} size={132} backgroundColor="#fff" color="#0F1C26" />
                </View>

                <View style={styles.cardFoot}>
                  <View>
                    <Text style={styles.footLabel}>Member</Text>
                    <Text style={styles.footValue}>{m.member_no ? `#${m.member_no}` : '—'}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    {/* Membership does not auto-renew, so it is not 'Renews'. */}
                    <Text style={styles.footLabel}>{m.paid_until ? (valid ? 'Valid until' : 'Expired') : 'Valid'}</Text>
                    <Text style={styles.footValue}>{m.paid_until ? fmtDate(m.paid_until) : 'No expiry'}</Text>
                  </View>
                </View>
              </View>
            </TouchableOpacity>
          );
        })}
        <View style={{ height: 40 }} />
      </ScrollView>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md, gap: spacing.md },

  cardShadow: { borderRadius: radius.xl, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 4 },
  card: { borderRadius: radius.xl, padding: spacing.lg, gap: spacing.md },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cardLogo: { width: 44, height: 44, borderRadius: 13, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  cardLogoImg: { width: 44, height: 44 },
  cardHub: { color: '#fff', fontSize: fontSize.md, fontWeight: '900' },
  cardTier: { color: 'rgba(255,255,255,0.85)', fontSize: fontSize.xs, marginTop: 1, textTransform: 'capitalize' },
  statusChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  statusText: { color: '#fff', fontSize: 11, fontWeight: '800' },

  qrWrap: { alignSelf: 'center', backgroundColor: '#fff', borderRadius: radius.lg, padding: 14 },

  cardFoot: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  footLabel: { color: 'rgba(255,255,255,0.7)', fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  footValue: { color: '#fff', fontSize: fontSize.md, fontWeight: '800', marginTop: 2 },
});
