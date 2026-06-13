/**
 * hub-members.tsx
 * Hub committee/owner admin: approve pending requests, view members, and
 * promote members to committee. Pass ?id=<hubId>.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Alert, RefreshControl,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { IconButton } from '@/components/ui/IconButton';
import { LoadingState } from '@/components/ui/LoadingState';
import { EmptyState } from '@/components/ui/EmptyState';
import { useAuth } from '@/context/AuthContext';
import {
  fetchHub, fetchHubMembers, approveMember, rejectMember, setMemberRole, notifyHub,
  HUB_TYPE_LABELS,
  type Hub, type HubMember, type HubRole,
} from '@/lib/hubs-api';

const S = SECTIONS.community;

export default function HubMembersScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { screenWidth } = useAppLayout();
  const { profile } = useAuth();
  const [hub, setHub] = useState<Hub | null>(null);
  const [members, setMembers] = useState<HubMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [h, m] = await Promise.all([fetchHub(id), fetchHubMembers(id)]);
      setHub(h); setMembers(m);
    } finally { setLoading(false); }
  }, [id]);

  useEffect(() => { load(); }, [load]);
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  const pending = members.filter(m => m.status === 'pending');
  const active  = members.filter(m => m.status === 'active');
  const isOwner = !!hub && profile?.id === hub.owner_id;

  const act = async (fn: () => Promise<void>) => {
    try { await fn(); await load(); }
    catch (e: any) { Alert.alert('Could not update', e?.message ?? ''); }
  };

  const approve = (m: HubMember) => act(async () => {
    await approveMember(m.id);
    notifyHub('approved', m.hub_id, m.user_id);  // tell the member they're in
  });

  const promote = (m: HubMember) => {
    const next: HubRole = m.role === 'committee' ? 'member' : 'committee';
    Alert.alert(
      next === 'committee' ? 'Make committee?' : 'Remove from committee?',
      `${m.profile?.full_name ?? 'This member'} will ${next === 'committee' ? 'be able to help run the hub' : 'become a normal member'}.`,
      [{ text: 'Cancel', style: 'cancel' }, { text: 'Confirm', onPress: () => act(() => setMemberRole(m.id, next)) }],
    );
  };

  if (loading) {
    return (
      <ScreenScaffold header={<ScreenHeader title="Members" accent={S.color} onBack={() => router.back()} />}>
        <LoadingState accent={S.color} />
      </ScreenScaffold>
    );
  }

  return (
    <ScreenScaffold
      header={
        <ScreenHeader
          title={hub?.name ?? 'Members'}
          accent={S.color}
          onBack={() => router.back()}
          rightElement={
            id ? <IconButton icon="cog" color={S.color} onPress={() => router.push(`/hub-register?id=${id}`)} /> : undefined
          }
        />
      }
    >
      <ScrollView contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={S.color} />}>

        {pending.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>Requests to join ({pending.length})</Text>
            {pending.map(m => (
              <View key={m.id} style={styles.row}>
                <Avatar name={m.profile?.full_name} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{m.profile?.full_name ?? 'New member'}</Text>
                  <Text style={styles.sub}>Requested {new Date(m.joined_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</Text>
                </View>
                <TouchableOpacity style={styles.rejectBtn} onPress={() => act(() => rejectMember(m.id))} hitSlop={6}>
                  <FontAwesome5 name="times" size={13} color={colors.textMuted} />
                </TouchableOpacity>
                <TouchableOpacity style={[styles.approveBtn, { backgroundColor: S.color }]} onPress={() => approve(m)} activeOpacity={0.85}>
                  <Text style={styles.approveText}>Approve</Text>
                </TouchableOpacity>
              </View>
            ))}
          </>
        )}

        <Text style={styles.sectionLabel}>Members ({active.length})</Text>
        {active.length === 0 ? (
          <EmptyState icon="users" title="No members yet" body="When people join this hub they'll appear here." accent={S.color} variant="card" />
        ) : active.map(m => (
          <View key={m.id} style={styles.row}>
            <Avatar name={m.profile?.full_name} />
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{m.profile?.full_name ?? 'Member'}</Text>
              <Text style={styles.sub}>
                {m.role === 'owner' ? 'Owner' : m.role === 'committee' ? 'Committee' : 'Member'}
                {`  ·  joined ${new Date(m.joined_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`}
              </Text>
            </View>
            {m.role === 'owner' ? (
              <View style={[styles.roleTag, { backgroundColor: S.color }]}>
                <Text style={[styles.roleTagText, { color: '#fff' }]}>Owner</Text>
              </View>
            ) : isOwner ? (
              <TouchableOpacity
                style={[styles.roleBtn, m.role === 'committee' ? styles.roleBtnGhost : { backgroundColor: S.color }]}
                onPress={() => promote(m)} activeOpacity={0.85}
              >
                <FontAwesome5 name={m.role === 'committee' ? 'user-minus' : 'user-shield'} size={11}
                  color={m.role === 'committee' ? colors.textMuted : '#fff'} solid />
                <Text style={[styles.roleBtnText, m.role === 'committee' ? { color: colors.textMuted } : { color: '#fff' }]}>
                  {m.role === 'committee' ? 'Remove' : 'Make committee'}
                </Text>
              </TouchableOpacity>
            ) : m.role === 'committee' ? (
              <View style={[styles.roleTag, { backgroundColor: S.color + '22' }]}>
                <Text style={[styles.roleTagText, { color: S.color }]}>Committee</Text>
              </View>
            ) : null}
          </View>
        ))}

        <Text style={styles.hint}>
          {isOwner
            ? 'Committee members can post notices, manage members and run the hub. Only you (the owner) can add or remove them.'
            : 'Committee members help run the hub. Only the owner can change committee roles.'}
        </Text>
        <View style={{ height: 40 }} />
      </ScrollView>
    </ScreenScaffold>
  );
}

function Avatar({ name }: { name?: string | null }) {
  const initial = (name ?? '?').trim()[0]?.toUpperCase() ?? '?';
  return <View style={styles.avatar}><Text style={styles.avatarText}>{initial}</Text></View>;
}

const styles = StyleSheet.create({
  content: { padding: spacing.md },
  sectionLabel: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: spacing.md, marginBottom: spacing.sm },

  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 12, marginBottom: 8 },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: S.color, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '800', fontSize: fontSize.md },
  name: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  sub: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },

  rejectBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F3F4F6' },
  approveBtn: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: radius.md },
  approveText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },

  roleTag: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, backgroundColor: '#F3F4F6' },
  roleTagText: { fontSize: 11, fontWeight: '800', color: colors.textMuted, textTransform: 'capitalize' },
  roleBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.md },
  roleBtnGhost: { backgroundColor: '#F3F4F6' },
  roleBtnText: { fontSize: 12, fontWeight: '800' },

  hint: { fontSize: fontSize.xs, color: colors.textLight, marginTop: spacing.md, fontStyle: 'italic', textAlign: 'center' },
});
