/**
 * app/job/[id].tsx — full job listing + in-app apply.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image, Linking,
  ActivityIndicator, TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius, SIDEBAR_WIDTH } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { useAuth } from '@/context/AuthContext';
import { useGoToSignIn } from '@/hooks/useGoToSignIn';
import { NavRail } from '@/components/NavRail';
import { Sheet } from '@/components/ui/Sheet';
import { useAlert } from '@/components/BrandedAlert';
import { ContentActions } from '@/components/ContentActions';
import {
  fetchJob, hasApplied, applyToJob, ensureWorkerProfile, generateCoverLetter,
  fetchSavedJobIds, toggleSavedJob,
  formatJobPay, payIsShown, CONTRACT_LABELS, REMOTE_LABELS,
  jobDisplayBusiness, isExternalJob,
  type Job, type WorkerProfile,
} from '@/lib/jobs-api';
import { track } from '@/lib/analytics';

const S = SECTIONS.jobs;

export default function JobDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { profile } = useAuth();
  const { isTablet } = useAppLayout();
  const goToSignIn = useGoToSignIn();

  const [job, setJob]         = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [applied, setApplied] = useState(false);
  const [saved, setSaved]     = useState(false);
  const [showApply, setShowApply] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const j = await fetchJob(id);
      setJob(j);
      if (profile) {
        const [ap, savedIds] = await Promise.all([hasApplied(id, profile.id), fetchSavedJobIds(profile.id)]);
        setApplied(ap);
        setSaved(savedIds.has(id));
      }
    } finally { setLoading(false); }
  }, [id, profile?.id]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (job?.id) track('content_viewed', { objectType: 'job', objectId: job.id, businessId: job.posted_as_business_id ?? undefined });
  }, [job?.id]);

  const onSave = async () => {
    if (!profile) { goToSignIn(); return; }
    setSaved(await toggleSavedJob(profile.id, id));
  };

  if (loading) {
    return <SafeAreaView style={[styles.safe, styles.center]}><Stack.Screen options={{ headerShown: false }} /><ActivityIndicator color={S.color} size="large" /></SafeAreaView>;
  }
  if (!job) {
    return (
      <SafeAreaView style={[styles.safe, styles.center]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Text style={styles.muted}>This job is no longer available.</Text>
        <TouchableOpacity onPress={() => router.replace('/(tabs)/jobs')} style={styles.backPill}><Text style={styles.backPillText}>Back to Jobs</Text></TouchableOpacity>
      </SafeAreaView>
    );
  }

  const external  = isExternalJob(job);
  const disp      = jobDisplayBusiness(job);
  const isOwnPost = !external && profile?.id === job.employer_id;
  const isClosed  = job.status === 'closed' || job.status === 'filled';
  const featured = job.is_featured || (job.boosted_until != null && new Date(job.boosted_until) > new Date());

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <NavRail />
      <View style={{ flex: 1, paddingLeft: isTablet ? SIDEBAR_WIDTH : 0 }}>
        <View style={styles.topBar}>
          <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/jobs'))} style={styles.backBtn} hitSlop={12}>
            <FontAwesome5 name="chevron-left" size={16} color={S.color} />
            <FontAwesome5 name="briefcase" size={12} color={S.color} solid />
            <Text style={styles.backText}>Jobs</Text>
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          <TouchableOpacity onPress={onSave} style={styles.iconBtn} hitSlop={12}>
            <FontAwesome5 name="bookmark" size={20} color={saved ? S.color : colors.textSecondary} solid={saved} />
          </TouchableOpacity>
          {!isOwnPost ? (
            <ContentActions
              contentType="job"
              contentId={job.id}
              authorId={job.employer_id}
              icon="ellipsis-v"
            />
          ) : null}
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.head}>
            <View style={[styles.logo, { backgroundColor: S.light }]}>
              {disp.logo_url
                ? <Image source={{ uri: disp.logo_url }} style={styles.logoImg} resizeMode="contain" />
                : <FontAwesome5 name="briefcase" size={22} color={S.color} solid />}
            </View>
            <View style={{ flex: 1 }}>
              {featured ? <Text style={styles.featured}>★ Featured</Text> : null}
              <Text style={styles.title}>{job.title}</Text>
              <TouchableOpacity disabled={!job.business?.slug} onPress={() => job.business?.slug && router.push(`/b/${job.business.slug}`)}>
                <Text style={styles.org}>
                  {disp.name}{disp.is_verified ? '  ·  ✓ Verified' : ''}
                </Text>
              </TouchableOpacity>
              {job.source_label ? <Text style={styles.sourceLabel}>Listed {job.source_label}</Text> : null}
            </View>
          </View>

          <View style={[styles.payCard, { backgroundColor: S.light }]}>
            <FontAwesome5 name="coins" size={14} color={S.color} solid />
            <Text style={[styles.payText, { color: S.color }]}>{formatJobPay(job)}</Text>
            {!payIsShown(job) ? <Text style={styles.payHint}>Salary on application</Text> : null}
          </View>

          <View style={styles.factGrid}>
            <Fact icon="file-signature" label={CONTRACT_LABELS[job.contract_type]} />
            <Fact icon="laptop-house" label={REMOTE_LABELS[job.remote_mode]} />
            {job.locality || job.location ? <Fact icon="map-marker-alt" label={(job.locality ?? job.location)!} /> : null}
            {job.is_seasonal ? <Fact icon="sun" label={job.season_label || 'Seasonal'} /> : null}
            {job.relocation_support ? <Fact icon="suitcase-rolling" label="Relocation support" /> : null}
            {job.housing_available ? <Fact icon="home" label="Housing available" /> : null}
          </View>

          {job.description ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>About the role</Text>
              <Text style={styles.body}>{job.description}</Text>
            </View>
          ) : null}

          {!external && (job.apply_url || job.apply_email) ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Other ways to apply</Text>
              {job.apply_url ? <TouchableOpacity onPress={() => Linking.openURL(job.apply_url!)}><Text style={styles.link}>{job.apply_url}</Text></TouchableOpacity> : null}
              {job.apply_email ? <TouchableOpacity onPress={() => Linking.openURL(`mailto:${job.apply_email}`)}><Text style={styles.link}>{job.apply_email}</Text></TouchableOpacity> : null}
            </View>
          ) : null}

          <View style={{ height: 100 }} />
        </ScrollView>

        {/* Sticky apply bar */}
        {external ? (
          <View style={styles.applyBar}>
            <TouchableOpacity
              style={[styles.applyBtn, { backgroundColor: S.color }]}
              onPress={() => job.apply_url && Linking.openURL(job.apply_url)}
              activeOpacity={0.9}
              disabled={!job.apply_url}
            >
              <FontAwesome5 name="external-link-alt" size={14} color="#fff" solid />
              <Text style={styles.applyBtnText}>Apply on official site</Text>
            </TouchableOpacity>
          </View>
        ) : !isOwnPost ? (
          <View style={styles.applyBar}>
            {applied ? (
              <View style={[styles.appliedPill]}>
                <FontAwesome5 name="check-circle" size={15} color="#15803D" solid />
                <Text style={styles.appliedText}>Applied — track it in My applications</Text>
              </View>
            ) : isClosed ? (
              <View style={[styles.appliedPill]}>
                <FontAwesome5 name="lock" size={14} color={colors.textMuted} solid />
                <Text style={styles.appliedText}>
                  {job.status === 'filled' ? 'This role has been filled' : 'This role is no longer accepting applications'}
                </Text>
              </View>
            ) : (
              <TouchableOpacity
                style={[styles.applyBtn, { backgroundColor: S.color }]}
                onPress={() => { if (!profile) { goToSignIn(); return; } setShowApply(true); }}
                activeOpacity={0.9}
              >
                <FontAwesome5 name="paper-plane" size={15} color="#fff" solid />
                <Text style={styles.applyBtnText}>Apply now</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          <View style={styles.applyBar}>
            <TouchableOpacity
              style={[styles.applyBtn, { backgroundColor: S.color }]}
              onPress={() => router.push(`/job-applicants?jobId=${job.id}` as any)}
              activeOpacity={0.9}
            >
              <FontAwesome5 name="users" size={15} color="#fff" solid />
              <Text style={styles.applyBtnText}>Manage this job</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {showApply && job ? (
        <ApplySheet
          job={job}
          userId={profile!.id}
          onClose={() => setShowApply(false)}
          onApplied={() => { setShowApply(false); setApplied(true); }}
        />
      ) : null}
    </SafeAreaView>
  );
}

function ApplySheet({ job, userId, onClose, onApplied }: { job: Job; userId: string; onClose: () => void; onApplied: () => void }) {
  const { alert } = useAlert();
  const [profile, setProfile] = useState<WorkerProfile | null>(null);
  const [cover, setCover]     = useState('');
  const [aiBusy, setAiBusy]   = useState(false);
  const [busy, setBusy]       = useState(false);

  useEffect(() => { void ensureWorkerProfile(userId).then(setProfile).catch(() => {}); }, [userId]);

  const draftAi = async () => {
    setAiBusy(true);
    try { setCover(await generateCoverLetter(job.id)); }
    catch (e: any) { alert({ title: 'Could not draft', message: e?.message ?? 'Try again, or write your own.' }); }
    finally { setAiBusy(false); }
  };

  const submit = async () => {
    setBusy(true);
    try {
      const snapshot = profile ? {
        headline: profile.headline, summary: profile.summary, skills: profile.skills,
        qualifications: profile.qualifications, experience: profile.experience,
        willing_to_relocate: profile.willing_to_relocate,
      } : {};
      await applyToJob({ jobId: job.id, userId, coverLetter: cover.trim() || null, snapshot });
      track('job_applied', { objectType: 'job', objectId: job.id, businessId: job.posted_as_business_id ?? undefined });
      onApplied();
    } catch (e: any) {
      alert({ title: 'Could not apply', message: e?.message ?? '' });
    } finally { setBusy(false); }
  };

  const thin = !profile || (!profile.summary && (profile.skills?.length ?? 0) === 0);

  return (
    <Sheet visible onClose={onClose} title={`Apply — ${job.title}`} scroll>
      <Text style={styles.sheetSub}>Your work profile is sent with this application.</Text>

      {thin ? (
        <View style={styles.warn}>
          <FontAwesome5 name="info-circle" size={12} color="#92400E" solid />
          <Text style={styles.warnText}>Your profile is light. A fuller profile/CV gets more replies — add skills & experience first.</Text>
        </View>
      ) : null}

      <View style={styles.coverHead}>
        <Text style={styles.coverLabel}>Cover note (optional)</Text>
        <TouchableOpacity onPress={draftAi} disabled={aiBusy} style={styles.aiBtn} hitSlop={8}>
          {aiBusy ? <ActivityIndicator size="small" color={S.color} /> : <><FontAwesome5 name="magic" size={11} color={S.color} solid /><Text style={styles.aiBtnText}>Draft with Peerie Bot</Text></>}
        </TouchableOpacity>
      </View>
      <TextInput
        value={cover}
        onChangeText={setCover}
        placeholder="A few lines on why you're a good fit…"
        placeholderTextColor={colors.textMuted}
        style={styles.coverInput}
        multiline
      />

      <TouchableOpacity style={[styles.submit, { backgroundColor: S.color, opacity: busy ? 0.5 : 1 }]} onPress={submit} disabled={busy} activeOpacity={0.9}>
        {busy ? <ActivityIndicator color="#fff" /> : <><FontAwesome5 name="paper-plane" size={14} color="#fff" solid /><Text style={styles.submitText}>Send application</Text></>}
      </TouchableOpacity>
    </Sheet>
  );
}

function Fact({ icon, label }: { icon: string; label: string }) {
  return (
    <View style={styles.fact}>
      <FontAwesome5 name={icon as any} size={12} color={S.color} solid />
      <Text style={styles.factText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  center: { alignItems: 'center', justifyContent: 'center', gap: 12 },
  muted: { color: colors.textMuted, fontSize: fontSize.md },
  backPill: { backgroundColor: S.color, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: 999 },
  backPillText: { color: '#fff', fontWeight: '800' },

  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingTop: spacing.sm },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 999, backgroundColor: S.color + '14' },
  backText: { color: S.color, fontSize: fontSize.sm, fontWeight: '800' },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },

  content: { padding: spacing.lg, gap: spacing.md },
  head: { flexDirection: 'row', gap: 14, alignItems: 'flex-start' },
  logo: { width: 56, height: 56, borderRadius: 15, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  logoImg: { width: 56, height: 56 },
  featured: { fontSize: 11, fontWeight: '800', color: S.color, marginBottom: 2 },
  title: { fontSize: 24, fontWeight: '900', color: colors.textPrimary, letterSpacing: -0.4 },
  org: { fontSize: fontSize.sm, color: colors.textSecondary, fontWeight: '600', marginTop: 4 },
  sourceLabel: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 3 },

  payCard: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: spacing.md, borderRadius: radius.md },
  payText: { fontSize: fontSize.lg, fontWeight: '900' },
  payHint: { fontSize: fontSize.xs, color: colors.textMuted, marginLeft: 'auto' },

  factGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  fact: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999 },
  factText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary },

  section: { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.md, gap: 8 },
  sectionTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary },
  body: { fontSize: fontSize.md, color: colors.textPrimary, lineHeight: 23 },
  link: { fontSize: fontSize.sm, color: S.color, fontWeight: '700', textDecorationLine: 'underline' },

  applyBar: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: spacing.md, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: colors.border },
  applyBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: spacing.md, borderRadius: 999 },
  applyBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
  appliedPill: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: spacing.md, borderRadius: 999, backgroundColor: '#DCFCE7' },
  appliedText: { color: '#15803D', fontSize: fontSize.sm, fontWeight: '800' },

  sheetSub: { fontSize: fontSize.sm, color: colors.textMuted },
  warn: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', backgroundColor: '#FEF3C7', borderRadius: radius.md, padding: spacing.sm },
  warnText: { flex: 1, fontSize: 12, color: '#92400E', lineHeight: 17 },
  coverHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm },
  coverLabel: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  aiBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: S.light },
  aiBtnText: { fontSize: 12, fontWeight: '800', color: S.color },
  coverInput: { minHeight: 110, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, fontSize: fontSize.md, color: colors.textPrimary, backgroundColor: '#fff', textAlignVertical: 'top' },
  submit: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: spacing.md, borderRadius: 999, marginTop: spacing.sm },
  submitText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
});
