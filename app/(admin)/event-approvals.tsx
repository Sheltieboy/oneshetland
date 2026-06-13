/**
 * (admin)/event-approvals.tsx
 * Moderation queue: events from UNVERIFIED hubs that want to go islands-wide on
 * the main What's On calendar. Verified hubs skip this — they auto-publish.
 * One-tap Approve flips the event onto the calendar.
 */

import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, Alert, Image,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingState } from '@/components/ui/LoadingState';
import { useAuth } from '@/context/AuthContext';
import { fetchPendingHubEvents, approveHubEvent, type OsEvent } from '@/lib/events-api';

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    + '  ·  ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export default function EventApprovalsScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const { screenWidth } = useAppLayout();

  const [events, setEvents] = useState<OsEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setEvents(await fetchPendingHubEvents()); }
    catch { setEvents([]); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const approve = async (ev: OsEvent) => {
    if (!profile?.id) return;
    setBusyId(ev.id);
    try {
      await approveHubEvent(ev.id, profile.id);
      setEvents(prev => prev.filter(e => e.id !== ev.id));
    } catch (e: any) {
      Alert.alert('Could not approve', e?.message ?? '');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <ScreenScaffold
      header={<ScreenHeader title="Event approvals" accent={colors.accent} onBack={() => router.back()} />}
    >
      {loading ? (
        <LoadingState accent={colors.accent} />
      ) : (
        <ScrollView contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} />}>

          {events.length === 0 ? (
            <EmptyState
              icon="check-circle"
              title="All clear"
              body="No hub events waiting for the main calendar."
              accent="#15803D"
              variant="card"
            />
          ) : (
            events.map(ev => {
              const hub = (ev as any).hub as { name?: string; logo_url?: string | null } | null;
              return (
                <View key={ev.id} style={styles.card}>
                  <View style={styles.cardTop}>
                    <View style={styles.hubChip}>
                      {hub?.logo_url
                        ? <Image source={{ uri: hub.logo_url }} style={styles.hubLogo} />
                        : <FontAwesome5 name="users" size={11} color={colors.textMuted} solid />}
                      <Text style={styles.hubName} numberOfLines={1}>{hub?.name ?? 'A hub'}</Text>
                    </View>
                    <Text style={styles.unverified}>Unverified</Text>
                  </View>

                  <Text style={styles.title}>{ev.title}</Text>
                  <Text style={styles.when}>{fmtWhen(ev.starts_at)}</Text>
                  {ev.venue ? <Text style={styles.venue}>{ev.venue}</Text> : null}

                  <View style={styles.actions}>
                    <TouchableOpacity
                      style={styles.viewBtn}
                      onPress={() => router.push(`/events/${ev.id}`)}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.viewBtnText}>Preview</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.approveBtn, busyId === ev.id && { opacity: 0.5 }]}
                      onPress={() => approve(ev)}
                      disabled={busyId === ev.id}
                      activeOpacity={0.85}
                    >
                      {busyId === ev.id
                        ? <ActivityIndicator color="#fff" size="small" />
                        : (<><FontAwesome5 name="check" size={12} color="#fff" /><Text style={styles.approveBtnText}>Approve for calendar</Text></>)}
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })
          )}
          <View style={{ height: 40 }} />
        </ScrollView>
      )}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md, gap: spacing.sm },
  card: { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  hubChip: { flexDirection: 'row', alignItems: 'center', gap: 7, flex: 1 },
  hubLogo: { width: 20, height: 20, borderRadius: 6 },
  hubName: { fontSize: fontSize.xs, fontWeight: '800', color: colors.textSecondary, flexShrink: 1 },
  unverified: { fontSize: 10, fontWeight: '800', color: '#92400E', backgroundColor: '#FEF3C7', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  title: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary },
  when: { fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 3 },
  venue: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  actions: { flexDirection: 'row', gap: 8, marginTop: spacing.md },
  viewBtn: { paddingHorizontal: spacing.md, paddingVertical: 10, borderRadius: 999, borderWidth: 1.5, borderColor: colors.border },
  viewBtnText: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textSecondary },
  approveBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 11, borderRadius: 999, backgroundColor: '#15803D' },
  approveBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
});
