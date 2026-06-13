/**
 * (tabs)/jobs.tsx — the "Work" hub.
 *
 * One home for finding work: a Jobs / Shifts switch at the top that swaps the
 * content IN PLACE (no navigation), so both tiers share the exact same chrome,
 * search, filters and card styling. Jobs = traditional roles; Shifts = casual
 * same-day work.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius, SIDEBAR_WIDTH } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { useAuth } from '@/context/AuthContext';
import { NavRail } from '@/components/NavRail';
import { JobCard } from '@/components/JobCard';
import { ShiftCard } from '@/components/ShiftCard';
import {
  fetchJobs, fetchSavedJobIds, toggleSavedJob,
  JOB_CATEGORIES, type Job,
} from '@/lib/jobs-api';
import { fetchOpenShifts, CATEGORY_LABELS, type Shift } from '@/lib/shifts-api';

type Tier = 'jobs' | 'shifts';
const JOBS = SECTIONS.jobs;
const SHIFTS = SECTIONS.shifts;

const SHIFT_CATS = Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label }));
const JOB_CATS   = JOB_CATEGORIES.map(c => ({ value: c, label: c }));

export default function WorkHubScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const { isTablet, screenWidth } = useAppLayout();
  const { tab: tabParam } = useLocalSearchParams<{ tab?: string }>();

  const [tier, setTier]     = useState<Tier>(tabParam === 'shifts' ? 'shifts' : 'jobs');
  const [jobs, setJobs]     = useState<Job[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [saved, setSaved]   = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery]   = useState('');
  const [category, setCategory] = useState<string | null>(null);

  // React to nav (e.g. the "Shifts" item) targeting this hub with ?tab=shifts.
  useEffect(() => { if (tabParam === 'shifts' || tabParam === 'jobs') setTier(tabParam); }, [tabParam]);

  const accent = tier === 'jobs' ? JOBS.color : SHIFTS.color;

  const load = useCallback(async () => {
    try {
      if (tier === 'jobs') {
        const [list, savedIds] = await Promise.all([
          fetchJobs({ category: category ?? undefined, keyword: query.trim() || undefined, limit: 60 }),
          profile ? fetchSavedJobIds(profile.id) : Promise.resolve(new Set<string>()),
        ]);
        setJobs(list); setSaved(savedIds);
      } else {
        setShifts(await fetchOpenShifts(category ?? undefined));
      }
    } catch { if (tier === 'jobs') setJobs([]); else setShifts([]); }
    finally { setLoading(false); setRefreshing(false); }
  }, [tier, category, query, profile?.id]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));
  useEffect(() => {
    const h = setTimeout(() => { void load(); }, 280);
    return () => clearTimeout(h);
  }, [query, category, tier]);

  const switchTier = (t: Tier) => {
    if (t === tier) return;
    setTier(t); setCategory(null); setQuery(''); setLoading(true);
  };

  const onToggleSave = async (jobId: string) => {
    if (!profile) { router.push('/(auth)/sign-in'); return; }
    const next = new Set(saved);
    if (await toggleSavedJob(profile.id, jobId)) next.add(jobId); else next.delete(jobId);
    setSaved(next);
  };

  const cats = tier === 'jobs' ? JOB_CATS : SHIFT_CATS;
  const q = query.trim().toLowerCase();
  const visibleShifts = q
    ? shifts.filter(s => `${s.title} ${s.category} ${s.location_text}`.toLowerCase().includes(q))
    : shifts;

  const maxW = isTablet ? Math.min(880, screenWidth - spacing.lg * 2) : undefined;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <NavRail />
      <View style={{ flex: 1, paddingLeft: isTablet ? SIDEBAR_WIDTH : 0 }}>
        {/* Work switch */}
        <View style={styles.header}>
          <View style={styles.switchRow}>
            <Pill icon="briefcase" label="Jobs"   active={tier === 'jobs'}   color={JOBS.color}   onPress={() => switchTier('jobs')} />
            <Pill icon={SHIFTS.icon} label="Shifts" active={tier === 'shifts'} color={SHIFTS.color} onPress={() => switchTier('shifts')} />
          </View>
        </View>

        <ScrollView
          contentContainerStyle={[styles.content, maxW ? { width: maxW, alignSelf: 'center' } : null]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={accent} />}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.lede}>
            {tier === 'jobs'
              ? 'Find permanent, part-time and seasonal work across Shetland.'
              : 'Pick up casual, same-day and short-notice shifts across Shetland.'}
          </Text>

          {/* Quick links */}
          <View style={styles.quickRow}>
            <QuickLink color={accent} icon="user-tie" label="My profile / CV" onPress={() => router.push(profile ? '/work-profile' : '/(auth)/sign-in')} />
            {tier === 'jobs' ? (
              <QuickLink color={accent} icon="clipboard-list" label="My applications" onPress={() => router.push(profile ? '/my-job-applications' : '/(auth)/sign-in')} />
            ) : (
              <QuickLink color={accent} icon="clipboard-list" label="My shifts" onPress={() => router.push(profile ? '/my-shift-applications' : '/(auth)/sign-in')} />
            )}
          </View>

          {/* Search */}
          <View style={styles.searchBar}>
            <FontAwesome5 name="search" size={14} color={colors.textMuted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={tier === 'jobs' ? 'Search jobs — title, employer, keyword…' : 'Search shifts — title, place…'}
              placeholderTextColor={colors.textLight}
              style={styles.searchInput}
              autoCorrect={false}
              returnKeyType="search"
            />
            {query ? <TouchableOpacity onPress={() => setQuery('')} hitSlop={8}><FontAwesome5 name="times-circle" size={14} color={colors.textMuted} solid /></TouchableOpacity> : null}
          </View>

          {/* Category filter */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.catRow} contentContainerStyle={{ gap: 8, paddingVertical: 2 }}>
            <Cat label="All" active={category === null} accent={accent} onPress={() => setCategory(null)} />
            {cats.map(c => <Cat key={c.value} label={c.label} active={category === c.value} accent={accent} onPress={() => setCategory(c.value)} />)}
          </ScrollView>

          {loading ? (
            <View style={styles.center}><ActivityIndicator color={accent} /></View>
          ) : tier === 'jobs' ? (
            jobs.length === 0 ? (
              <Empty icon="briefcase" color={accent} title="No jobs match" body="Try clearing filters, or check back soon — new roles are posted regularly." />
            ) : (
              <View style={{ gap: spacing.sm }}>
                {jobs.map(j => (
                  <JobCard key={j.id} job={j} saved={saved.has(j.id)} onToggleSave={() => onToggleSave(j.id)} onPress={() => router.push(`/job/${j.id}`)} />
                ))}
              </View>
            )
          ) : (
            visibleShifts.length === 0 ? (
              <Empty icon={SHIFTS.icon} color={accent} title="No shifts right now" body="Nothing matches just now — pull to refresh, or check back soon." />
            ) : (
              <View style={{ gap: spacing.sm }}>
                {visibleShifts.map(s => (
                  <ShiftCard key={s.id} shift={s} onPress={() => router.push({ pathname: '/shift-detail', params: { id: s.id } })} />
                ))}
              </View>
            )
          )}

          {/* Employer CTA */}
          <TouchableOpacity
            style={[styles.hireCta, { borderColor: accent + '40', backgroundColor: accent + '14' }]}
            onPress={() => router.push(tier === 'jobs' ? '/local-business-dashboard' : '/shift-post')}
            activeOpacity={0.85}
          >
            <FontAwesome5 name={tier === 'jobs' ? 'store' : 'plus-circle'} size={14} color={accent} solid />
            <Text style={[styles.hireCtaText, { color: accent }]}>
              {tier === 'jobs' ? 'Hiring? Post a job from your business' : 'Need cover? Post a shift'}
            </Text>
            <FontAwesome5 name="chevron-right" size={12} color={accent} />
          </TouchableOpacity>

          <View style={{ height: 40 }} />
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

function Pill({ icon, label, active, color, onPress }: { icon: string; label: string; active: boolean; color: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.switchPill, active && { backgroundColor: color }]} onPress={onPress} activeOpacity={0.85}>
      <FontAwesome5 name={icon as any} size={12} color={active ? '#fff' : colors.textSecondary} solid />
      <Text style={[styles.switchText, { color: active ? '#fff' : colors.textSecondary }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function QuickLink({ icon, label, color, onPress }: { icon: string; label: string; color: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.quickLink} onPress={onPress} activeOpacity={0.85}>
      <View style={[styles.quickIcon, { backgroundColor: color + '1A' }]}><FontAwesome5 name={icon as any} size={14} color={color} solid /></View>
      <Text style={styles.quickLinkText}>{label}</Text>
    </TouchableOpacity>
  );
}

function Cat({ label, active, accent, onPress }: { label: string; active: boolean; accent: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.cat, active && { backgroundColor: accent, borderColor: accent }]} onPress={onPress} activeOpacity={0.8}>
      <Text style={[styles.catText, active && { color: '#fff' }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function Empty({ icon, color, title, body }: { icon: string; color: string; title: string; body: string }) {
  return (
    <View style={styles.empty}>
      <FontAwesome5 name={icon as any} size={28} color={color} solid />
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  header: { paddingHorizontal: spacing.md, paddingBottom: spacing.sm, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: colors.border },
  switchRow: { flexDirection: 'row', gap: 8, backgroundColor: colors.offWhite, borderRadius: 999, padding: 4, alignSelf: 'center' },
  switchPill: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 18, paddingVertical: 8, borderRadius: 999 },
  switchText: { fontSize: fontSize.sm, fontWeight: '800' },

  content: { padding: spacing.md },
  lede: { fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 20, marginBottom: spacing.md },

  quickRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  quickLink: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  quickIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  quickLinkText: { flex: 1, fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },

  searchBar: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  searchInput: { flex: 1, fontSize: fontSize.sm, color: colors.textPrimary, paddingVertical: 0 },
  catRow: { marginTop: spacing.sm, marginBottom: spacing.md },
  cat: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border },
  catText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary },

  center: { paddingVertical: spacing.xl, alignItems: 'center' },
  empty: { alignItems: 'center', gap: 8, padding: spacing.xl, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border },
  emptyTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  emptyBody: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', lineHeight: 19 },

  hireCta: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: spacing.lg, padding: spacing.md, borderRadius: radius.lg, borderWidth: 1.5 },
  hireCtaText: { flex: 1, fontSize: fontSize.sm, fontWeight: '800' },
});
