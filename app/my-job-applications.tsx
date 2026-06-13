/**
 * app/my-job-applications.tsx — the candidate's application tracker.
 * Each application shows a visible pipeline so people are never left guessing.
 */

import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  ActivityIndicator, RefreshControl, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import {
  fetchMyApplications, withdrawApplication,
  PIPELINE_STAGES, APPLICATION_STATUS_LABELS,
  type JobApplication, type ApplicationStatus,
} from '@/lib/jobs-api';

const S = SECTIONS.jobs;

function statusTone(s: ApplicationStatus): { color: string; bg: string } {
  switch (s) {
    case 'hired':    return { color: '#15803D', bg: '#DCFCE7' };
    case 'offer':    return { color: '#15803D', bg: '#DCFCE7' };
    case 'interview':
    case 'shortlisted': return { color: '#92400E', bg: '#FEF3C7' };
    case 'declined': return { color: '#991B1B', bg: '#FEE2E2' };
    case 'withdrawn':return { color: '#475569', bg: '#E2E8F0' };
    default:         return { color: '#1E3A8A', bg: '#DBEAFE' };
  }
}

export default function MyJobApplicationsScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const [apps, setApps] = useState<JobApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!profile) { setLoading(false); return; }
    try { setApps(await fetchMyApplications(profile.id)); }
    catch { setApps([]); }
    finally { setLoading(false); setRefreshing(false); }
  }, [profile?.id]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const withdraw = (a: JobApplication) => {
    Alert.alert('Withdraw application?', 'The employer will see this as withdrawn.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Withdraw', style: 'destructive', onPress: async () => { try { await withdrawApplication(a.id); await load(); } catch (e: any) { Alert.alert('Failed', e?.message ?? ''); } } },
    ]);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My applications</Text>
        <View style={{ width: 70 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={S.color} /></View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={S.color} />}>
          {apps.length === 0 ? (
            <View style={styles.empty}>
              <FontAwesome5 name="clipboard-list" size={28} color={S.color} />
              <Text style={styles.emptyTitle}>No applications yet</Text>
              <Text style={styles.emptyBody}>Find a role in Jobs and apply — they'll show here with live status.</Text>
              <TouchableOpacity style={[styles.browseBtn, { backgroundColor: S.color }]} onPress={() => router.replace('/(tabs)/jobs')}>
                <Text style={styles.browseBtnText}>Browse jobs</Text>
              </TouchableOpacity>
            </View>
          ) : apps.map(a => {
            const tone = statusTone(a.status);
            const reached = PIPELINE_STAGES.indexOf(a.status);
            const closed = a.status === 'declined' || a.status === 'withdrawn';
            return (
              <View key={a.id} style={styles.card}>
                <TouchableOpacity style={styles.cardTop} onPress={() => router.push(`/job/${a.job_id}`)} activeOpacity={0.8}>
                  <View style={[styles.logo, { backgroundColor: S.light }]}>
                    {a.job?.business?.logo_url
                      ? <Image source={{ uri: a.job.business.logo_url }} style={styles.logoImg} />
                      : <FontAwesome5 name="briefcase" size={15} color={S.color} solid />}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.jobTitle} numberOfLines={1}>{a.job?.title ?? 'Role'}</Text>
                    <Text style={styles.jobOrg} numberOfLines={1}>{a.job?.business?.name ?? 'Employer'}</Text>
                  </View>
                  <View style={[styles.statusPill, { backgroundColor: tone.bg }]}>
                    <Text style={[styles.statusPillText, { color: tone.color }]}>{APPLICATION_STATUS_LABELS[a.status]}</Text>
                  </View>
                </TouchableOpacity>

                {!closed ? (
                  <View style={styles.pipeline}>
                    {PIPELINE_STAGES.slice(0, 5).map((st, i) => {
                      const done = i <= reached;
                      return (
                        <React.Fragment key={st}>
                          {i > 0 ? <View style={[styles.pipeLine, done && { backgroundColor: S.color }]} /> : null}
                          <View style={[styles.pipeDot, done && { backgroundColor: S.color, borderColor: S.color }]} />
                        </React.Fragment>
                      );
                    })}
                  </View>
                ) : null}

                <View style={styles.cardFoot}>
                  <Text style={styles.foot}>
                    {closed ? 'Updated' : 'Applied'} {new Date(closed ? a.status_changed_at : a.applied_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                  </Text>
                  {!closed && a.status !== 'hired' ? (
                    <TouchableOpacity onPress={() => withdraw(a)} hitSlop={6}><Text style={styles.withdraw}>Withdraw</Text></TouchableOpacity>
                  ) : null}
                </View>
              </View>
            );
          })}
          <View style={{ height: 40 }} />
        </ScrollView>
      )}
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

  content: { padding: spacing.md, gap: spacing.sm },
  card: { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  logo: { width: 42, height: 42, borderRadius: 11, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  logoImg: { width: 42, height: 42 },
  jobTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  jobOrg: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  statusPill: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999 },
  statusPillText: { fontSize: 11, fontWeight: '800' },

  pipeline: { flexDirection: 'row', alignItems: 'center', marginTop: 14, paddingHorizontal: 4 },
  pipeDot: { width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: colors.border, backgroundColor: '#fff' },
  pipeLine: { flex: 1, height: 2, backgroundColor: colors.border },

  cardFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  foot: { fontSize: fontSize.xs, color: colors.textMuted },
  withdraw: { fontSize: fontSize.xs, fontWeight: '800', color: colors.error },

  empty: { alignItems: 'center', gap: 10, padding: spacing.xl, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border },
  emptyTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  emptyBody: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', lineHeight: 19 },
  browseBtn: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: 999, marginTop: 4 },
  browseBtnText: { color: '#fff', fontWeight: '800' },
});
