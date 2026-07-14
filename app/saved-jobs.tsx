/**
 * app/saved-jobs.tsx — the worker's bookmarked jobs.
 * Jobs saved via the bookmark toggle on the Work hub / job detail, gathered in
 * one place. Tapping the bookmark here un-saves and drops the card on refocus.
 */

import React, { useCallback, useState } from 'react';
import { View, StyleSheet, ScrollView, RefreshControl } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { spacing, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { LoadingState } from '@/components/ui/LoadingState';
import { EmptyState } from '@/components/ui/EmptyState';
import { JobCard } from '@/components/JobCard';
import { useAuth } from '@/context/AuthContext';
import { fetchSavedJobs, toggleSavedJob, type Job } from '@/lib/jobs-api';
import { track } from '@/lib/analytics';

const S = SECTIONS.jobs;

export default function SavedJobsScreen() {
  const router = useRouter();
  const { screenWidth } = useAppLayout();
  const { profile } = useAuth();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!profile) { setJobs([]); setLoading(false); return; }
    try { setJobs(await fetchSavedJobs(profile.id)); }
    catch { setJobs([]); }
    finally { setLoading(false); setRefreshing(false); }
  }, [profile?.id]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const onToggleSave = async (jobId: string) => {
    if (!profile) return;
    try {
      const saved = await toggleSavedJob(profile.id, jobId);
      if (!saved) {
        setJobs(prev => prev.filter(j => j.id !== jobId));
        track('item_unsaved', { objectType: 'job', objectId: jobId });
      }
    } catch { /* leave the list as-is on failure */ }
  };

  return (
    <ScreenScaffold header={<ScreenHeader title="Saved jobs" accent={S.color} onBack={() => router.back()} />}>
      {loading ? (
        <LoadingState accent={S.color} />
      ) : (
        <ScrollView
          contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={S.color} />}
        >
          {jobs.length === 0 ? (
            <EmptyState
              icon="bookmark"
              title="No saved jobs yet"
              body="Tap the bookmark on any job to save it here for later."
              accent={S.color}
              variant="card"
              actionLabel="Browse jobs"
              onAction={() => router.replace('/(tabs)/jobs')}
            />
          ) : (
            <View style={{ gap: spacing.sm }}>
              {jobs.map(j => (
                <JobCard
                  key={j.id}
                  job={j}
                  saved
                  onToggleSave={() => onToggleSave(j.id)}
                  onPress={() => router.push(`/job/${j.id}`)}
                />
              ))}
            </View>
          )}
          <View style={{ height: 40 }} />
        </ScrollView>
      )}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md },
});
