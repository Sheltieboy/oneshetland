/**
 * app/job-applicants.tsx — employer pipeline for one job. Pass ?jobId=.
 * Lightweight ATS: filter by stage, read the candidate's CV snapshot + cover
 * note, and move them through the pipeline. (Free — no add-on required.)
 */

import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  RefreshControl,
} from 'react-native';
import { useLocalSearchParams, useFocusEffect, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingState } from '@/components/ui/LoadingState';
import { useAlert } from '@/components/BrandedAlert';
import {
  fetchJob, fetchJobApplications, updateApplicationStatus,
  PIPELINE_STAGES, APPLICATION_STATUS_LABELS,
  type Job, type JobApplication, type ApplicationStatus,
} from '@/lib/jobs-api';

const S = SECTIONS.jobs;
const FILTERS: (ApplicationStatus | 'all')[] = ['all', 'applied', 'shortlisted', 'interview', 'offer', 'hired', 'declined'];

const NEXT_ACTIONS: { status: ApplicationStatus; label: string; color: string }[] = [
  { status: 'shortlisted', label: 'Shortlist', color: '#92400E' },
  { status: 'interview',   label: 'Interview', color: '#1E3A8A' },
  { status: 'offer',       label: 'Offer',     color: '#15803D' },
  { status: 'hired',       label: 'Hire',      color: '#15803D' },
];

export default function JobApplicantsScreen() {
  const { jobId } = useLocalSearchParams<{ jobId: string }>();
  const { screenWidth } = useAppLayout();
  const { alert } = useAlert();
  const router = useRouter();

  const [job, setJob]   = useState<Job | null>(null);
  const [apps, setApps] = useState<JobApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<ApplicationStatus | 'all'>('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!jobId) return;
    try {
      const [j, list] = await Promise.all([fetchJob(jobId), fetchJobApplications(jobId)]);
      setJob(j); setApps(list);
    } catch { setApps([]); }
    finally { setLoading(false); setRefreshing(false); }
  }, [jobId]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const move = async (a: JobApplication, status: ApplicationStatus) => {
    try {
      await updateApplicationStatus(a.id, status);
      setApps(prev => prev.map(x => x.id === a.id ? { ...x, status } : x));
    } catch (e: any) { alert({ title: 'Could not update', message: e?.message ?? '' }); }
  };

  const decline = (a: JobApplication) => {
    alert({
      title: 'Not selected?',
      message: 'Mark this applicant as not selected? They\'ll see the update.',
      actions: [
        { label: 'Cancel', style: 'cancel' },
        { label: 'Confirm', style: 'destructive', onPress: () => move(a, 'declined') },
      ],
    });
  };

  const visible = filter === 'all' ? apps : apps.filter(a => a.status === filter);
  const counts = (s: ApplicationStatus | 'all') => s === 'all' ? apps.length : apps.filter(a => a.status === s).length;

  return (
    <ScreenScaffold
      header={
        <ScreenHeader
          title={job?.title ?? 'Applicants'}
          accent={S.color}
          rightElement={job ? (
            <TouchableOpacity
              onPress={() => router.push(`/job-post?jobId=${job.id}${job.posted_as_business_id ? `&businessId=${job.posted_as_business_id}` : ''}` as any)}
              hitSlop={10}
              style={styles.editBtn}
              activeOpacity={0.8}
            >
              <FontAwesome5 name="pen" size={13} color={S.color} solid />
              <Text style={styles.editBtnText}>Edit</Text>
            </TouchableOpacity>
          ) : undefined}
        />
      }
    >
      {loading ? (
        <LoadingState accent={S.color} />
      ) : (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterBar} contentContainerStyle={{ gap: 8, paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}>
            {FILTERS.map(f => {
              const on = filter === f;
              return (
                <TouchableOpacity key={f} style={[styles.filterChip, on && { backgroundColor: S.color, borderColor: S.color }]} onPress={() => setFilter(f)} activeOpacity={0.8}>
                  <Text style={[styles.filterText, on && { color: '#fff' }]}>
                    {f === 'all' ? 'All' : APPLICATION_STATUS_LABELS[f]} {counts(f)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <ScrollView contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={S.color} />}>
            {visible.length === 0 ? (
              <EmptyState
                icon="users"
                title={apps.length === 0 ? 'No applicants yet' : 'None in this stage'}
                body={apps.length === 0 ? 'Share the role — applications appear here instantly.' : undefined}
                accent={S.color}
                variant="card"
              />
            ) : visible.map(a => {
              const snap = a.profile_snapshot ?? {};
              const skills: string[] = Array.isArray(snap.skills) ? snap.skills : [];
              const isOpen = expanded === a.id;
              const closed = a.status === 'declined' || a.status === 'withdrawn';
              return (
                <View key={a.id} style={styles.card}>
                  <TouchableOpacity style={styles.cardTop} onPress={() => setExpanded(isOpen ? null : a.id)} activeOpacity={0.8}>
                    <View style={styles.avatar}>
                      {a.applicant?.avatar_url
                        ? <Image source={{ uri: a.applicant.avatar_url }} style={styles.avatarImg} />
                        : <FontAwesome5 name="user" size={15} color={S.color} solid />}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.name}>{a.applicant?.full_name ?? 'Applicant'}</Text>
                      {snap.headline ? <Text style={styles.headline} numberOfLines={1}>{snap.headline}</Text> : null}
                      <Text style={styles.applied}>Applied {new Date(a.applied_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</Text>
                    </View>
                    <View style={styles.statusPill}><Text style={styles.statusPillText}>{APPLICATION_STATUS_LABELS[a.status]}</Text></View>
                  </TouchableOpacity>

                  {skills.length > 0 ? (
                    <View style={styles.skills}>{skills.slice(0, 6).map((s, i) => <View key={i} style={styles.skillChip}><Text style={styles.skillText}>{s}</Text></View>)}</View>
                  ) : null}

                  {isOpen ? (
                    <View style={styles.detail}>
                      {snap.summary ? <Text style={styles.summary}>{snap.summary}</Text> : null}
                      {a.cover_letter ? (
                        <View style={styles.coverBox}><Text style={styles.coverLabel}>Cover note</Text><Text style={styles.coverText}>{a.cover_letter}</Text></View>
                      ) : null}
                      {snap.willing_to_relocate ? <Text style={styles.reloc}>📦 Willing to relocate</Text> : null}
                    </View>
                  ) : null}

                  {!closed ? (
                    <View style={styles.actions}>
                      {NEXT_ACTIONS.filter(n => n.status !== a.status).map(n => (
                        <TouchableOpacity key={n.status} style={[styles.actionBtn, { borderColor: n.color }]} onPress={() => move(a, n.status)} activeOpacity={0.85}>
                          <Text style={[styles.actionText, { color: n.color }]}>{n.label}</Text>
                        </TouchableOpacity>
                      ))}
                      <TouchableOpacity style={[styles.actionBtn, { borderColor: colors.error }]} onPress={() => decline(a)} activeOpacity={0.85}>
                        <Text style={[styles.actionText, { color: colors.error }]}>Decline</Text>
                      </TouchableOpacity>
                    </View>
                  ) : null}
                </View>
              );
            })}
            <View style={{ height: 40 }} />
          </ScrollView>
        </>
      )}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  editBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4, paddingVertical: 4 },
  editBtnText: { fontSize: fontSize.sm, fontWeight: '800', color: SECTIONS.jobs.color },
  filterBar: { backgroundColor: '#fff', maxHeight: 52, borderBottomWidth: 1, borderBottomColor: colors.border },
  filterChip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border, height: 34 },
  filterText: { fontSize: fontSize.xs, fontWeight: '800', color: colors.textSecondary },

  content: { padding: spacing.md, gap: spacing.sm },
  card: { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: S.light, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarImg: { width: 42, height: 42 },
  name: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  headline: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 1 },
  applied: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  statusPill: { backgroundColor: S.light, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999 },
  statusPillText: { fontSize: 11, fontWeight: '800', color: S.color },

  skills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  skillChip: { backgroundColor: colors.offWhite, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999 },
  skillText: { fontSize: 11, fontWeight: '700', color: colors.textSecondary },

  detail: { marginTop: 12, gap: 8 },
  summary: { fontSize: fontSize.sm, color: colors.textPrimary, lineHeight: 20 },
  coverBox: { backgroundColor: colors.offWhite, borderRadius: radius.md, padding: spacing.sm },
  coverLabel: { fontSize: 11, fontWeight: '800', color: colors.textMuted, marginBottom: 3 },
  coverText: { fontSize: fontSize.sm, color: colors.textPrimary, lineHeight: 20 },
  reloc: { fontSize: fontSize.xs, fontWeight: '700', color: S.color },

  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  actionBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1.5 },
  actionText: { fontSize: fontSize.xs, fontWeight: '800' },
});
