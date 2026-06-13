/**
 * app/business-jobs.tsx — a business's posted jobs: create + manage. Pass ?businessId=.
 */

import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { fetchBusinessJobs, formatJobPay, CONTRACT_LABELS, type Job, type JobStatus } from '@/lib/jobs-api';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingState } from '@/components/ui/LoadingState';
import { useAppLayout } from '@/hooks/useAppLayout';

const S = SECTIONS.jobs;

function statusTone(s: JobStatus, hidden: boolean): { label: string; color: string; bg: string } {
  if (hidden)           return { label: 'Hidden',  color: '#475569', bg: '#E2E8F0' };
  if (s === 'filled')   return { label: 'Filled',  color: '#15803D', bg: '#DCFCE7' };
  if (s === 'closed')   return { label: 'Closed',  color: '#991B1B', bg: '#FEE2E2' };
  return { label: 'Open', color: '#15803D', bg: '#DCFCE7' };
}

export default function BusinessJobsScreen() {
  const { businessId } = useLocalSearchParams<{ businessId: string }>();
  const router = useRouter();
  const { screenWidth } = useAppLayout();

  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!businessId) return;
    try { setJobs(await fetchBusinessJobs(businessId)); }
    catch { setJobs([]); }
    finally { setLoading(false); setRefreshing(false); }
  }, [businessId]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  return (
    <ScreenScaffold
      header={<ScreenHeader title="Jobs" accent={S.color} onBack={() => router.back()} />}
    >
      {loading ? (
        <LoadingState accent={S.color} />
      ) : (
        <ScrollView contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={S.color} />}>

          <TouchableOpacity style={[styles.createCard, { backgroundColor: S.color }]} onPress={() => router.push(`/job-post?businessId=${businessId}`)} activeOpacity={0.9}>
            <View style={styles.createIcon}><FontAwesome5 name="plus" size={16} color={S.color} solid /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.createTitle}>Post a job</Text>
              <Text style={styles.createSub}>Free · takes a couple of minutes</Text>
            </View>
            <FontAwesome5 name="chevron-right" size={14} color="rgba(255,255,255,0.85)" />
          </TouchableOpacity>

          {jobs.length === 0 ? (
            <EmptyState
              icon="briefcase"
              title="No jobs yet"
              body="Post your first role to start taking applications."
              accent={S.color}
              variant="card"
            />
          ) : jobs.map(j => {
            const tone = statusTone(j.status, j.is_hidden);
            return (
              <TouchableOpacity key={j.id} style={styles.row} onPress={() => router.push(`/job-applicants?jobId=${j.id}`)} activeOpacity={0.85}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle} numberOfLines={1}>{j.title}</Text>
                  <Text style={styles.rowMeta} numberOfLines={1}>{CONTRACT_LABELS[j.contract_type]}  ·  {formatJobPay(j)}</Text>
                  <View style={styles.rowFoot}>
                    <View style={[styles.statusPill, { backgroundColor: tone.bg }]}><Text style={[styles.statusPillText, { color: tone.color }]}>{tone.label}</Text></View>
                    <Text style={styles.appCount}>
                      <FontAwesome5 name="user" size={10} color={colors.textMuted} solid />{'  '}
                      {j.application_count} applicant{j.application_count === 1 ? '' : 's'}
                    </Text>
                  </View>
                </View>
                <View style={styles.rowActions}>
                  <TouchableOpacity onPress={() => router.push(`/job-post?businessId=${businessId}&jobId=${j.id}`)} hitSlop={10} style={styles.editBtn}>
                    <FontAwesome5 name="edit" size={14} color={S.color} />
                  </TouchableOpacity>
                  <FontAwesome5 name="chevron-right" size={13} color={colors.textLight} />
                </View>
              </TouchableOpacity>
            );
          })}
          <View style={{ height: 40 }} />
        </ScrollView>
      )}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md, gap: spacing.sm },
  createCard: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.xs },
  createIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  createTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
  createSub: { color: 'rgba(255,255,255,0.85)', fontSize: fontSize.xs, marginTop: 1 },

  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  rowTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  rowMeta: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
  rowFoot: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 },
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  statusPillText: { fontSize: 10, fontWeight: '800' },
  appCount: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600' },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  editBtn: { padding: 2 },
});
