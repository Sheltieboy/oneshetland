/**
 * event-manage.tsx — Business event management screen
 * Shows stats, event updates, quick actions, status control.
 * Params: id (event ID)
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius, shadow } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAlert } from '@/components/BrandedAlert';
import { useAuth } from '@/context/AuthContext';
import {
  fetchEvent, updateEvent, postEventUpdate, fetchScannerStats,
  formatEventDate, UPDATE_KIND_LABELS,
  type OsEvent, type EventStatus, type UpdateKind, type ScannerStats,
} from '@/lib/events-api';

const S  = SECTIONS.events;
const SE = SECTIONS.local;

const UPDATE_KINDS: UpdateKind[] = ['info', 'urgent', 'venue_change', 'time_change', 'weather', 'entry_info'];

export default function EventManageScreen() {
  const { id }   = useLocalSearchParams<{ id: string }>();
  const router   = useRouter();
  const { profile } = useAuth();
  const { alert } = useAlert();

  const [event,     setEvent]     = useState<OsEvent | null>(null);
  const [stats,     setStats]     = useState<ScannerStats | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [refreshing,setRefreshing]= useState(false);

  // Post update form
  const [showUpdateForm, setShowUpdateForm] = useState(false);
  const [updateTitle,    setUpdateTitle]    = useState('');
  const [updateBody,     setUpdateBody]     = useState('');
  const [updateKind,     setUpdateKind]     = useState<UpdateKind>('info');
  const [updateUrgent,   setUpdateUrgent]   = useState(false);
  const [postingUpdate,  setPostingUpdate]  = useState(false);

  const [statusBusy, setStatusBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const [ev, st] = await Promise.all([
      fetchEvent(id).catch(() => null),
      fetchScannerStats(id).catch(() => null),
    ]);
    setEvent(ev);
    setStats(st);
    setLoading(false);
    setRefreshing(false);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const handleStatusChange = async (newStatus: EventStatus) => {
    if (!event) return;
    const labels: Record<EventStatus, string> = {
      draft:     'Save as draft',
      published: 'Publish event',
      cancelled: 'Cancel event',
      postponed: 'Mark as postponed',
      archived:  'Archive event',
    };
    alert({
      title: labels[newStatus],
      message: `Change event status to "${newStatus}"?`,
      actions: [
        { label: 'Cancel', style: 'cancel' },
        { label: 'Confirm', style: newStatus === 'cancelled' ? 'destructive' : 'primary',
          onPress: async () => {
            setStatusBusy(true);
            await updateEvent(event.id, { status: newStatus }).catch(e => alert({ title: 'Error', message: e.message }));
            await load();
            setStatusBusy(false);
          },
        },
      ],
    });
  };

  const handlePostUpdate = async () => {
    if (!updateTitle.trim() || !profile || !event) return;
    setPostingUpdate(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await postEventUpdate({
        event_id:  event.id,
        author_id: profile.id,
        title:     updateTitle.trim(),
        body:      updateBody.trim(),
        kind:      updateKind,
        is_urgent: updateUrgent,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setShowUpdateForm(false);
      setUpdateTitle('');
      setUpdateBody('');
      setUpdateKind('info');
      setUpdateUrgent(false);
      await load();
    } catch (e: any) {
      alert({ title: 'Error', message: e.message });
    } finally {
      setPostingUpdate(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      </SafeAreaView>
    );
  }

  if (!event) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}><Text style={styles.errorText}>Event not found.</Text></View>
      </SafeAreaView>
    );
  }

  const status      = event.status;
  const isPublished = status === 'published';
  const isCancelled = status === 'cancelled';
  const updates     = event.updates ?? [];

  const editParams = event.organiser_hub_id
    ? { hubId: event.organiser_hub_id, eventId: event.id }
    : { businessId: event.organiser_business_id ?? '', eventId: event.id };

  const hubReach = event.organiser_hub_id ? (
    event.hub_visibility === 'members' ? { label: 'Members only', icon: 'user-friends', color: '#6D28D9', bg: '#F3E8FF' }
    : event.hub_visibility === 'hub'   ? { label: 'On the hub page only', icon: 'store', color: S.color, bg: S.light }
    : event.calendar_approved          ? { label: 'On the main calendar', icon: 'globe-europe', color: '#15803D', bg: '#DCFCE7' }
    :                                    { label: 'Awaiting approval for the main calendar', icon: 'clock', color: '#92400E', bg: '#FEF3C7' }
  ) : null;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{event.title}</Text>
        <TouchableOpacity
          hitSlop={12}
          onPress={() => router.push({ pathname: '/event-create', params: editParams })}
        >
          <FontAwesome5 name="edit" size={15} color={S.color} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={S.color} />}
      >
        {/* Status strip */}
        <StatusStrip status={status} isBusy={statusBusy} onChangeStatus={handleStatusChange} />

        {/* Hub event reach */}
        {hubReach ? (
          <View style={[styles.reachBanner, { backgroundColor: hubReach.bg }]}>
            <FontAwesome5 name={hubReach.icon as any} size={12} color={hubReach.color} solid />
            <Text style={[styles.reachBannerText, { color: hubReach.color }]}>{hubReach.label}</Text>
          </View>
        ) : null}

        {/* Date summary */}
        <View style={styles.dateSummary}>
          <FontAwesome5 name="calendar-alt" size={12} color={S.color} />
          <Text style={styles.dateSummaryText}>{formatEventDate(event.starts_at, event.ends_at)}</Text>
        </View>

        {/* Stats */}
        {isPublished && stats && (
          <View style={styles.statsCard}>
            <StatBox label="Sold"       value={stats.tickets_sold}  color={S.color} />
            <View style={styles.statsDivider} />
            <StatBox label="Checked in" value={stats.checked_in}   color={colors.success} />
            <View style={styles.statsDivider} />
            <StatBox label="Capacity"   value={event.capacity ?? '∞'} color={colors.textMuted} />
          </View>
        )}

        {/* Quick actions */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Actions</Text>
          <View style={styles.actionsGrid}>
            <ActionBtn
              icon="qrcode" label="Scan tickets"
              color={SE.color}
              onPress={() => router.push({ pathname: '/event-scanner', params: { id: event.id } })}
              disabled={!isPublished}
            />
            <ActionBtn
              icon="eye" label="View public page"
              color={S.color}
              onPress={() => router.push({ pathname: '/events/[id]', params: { id: event.id } })}
            />
            <ActionBtn
              icon="edit" label="Edit event"
              color={SE.color}
              onPress={() => router.push({ pathname: '/event-create', params: editParams })}
            />
            <ActionBtn
              icon="bullhorn" label="Post update"
              color={S.color}
              onPress={() => setShowUpdateForm(v => !v)}
            />
          </View>
        </View>

        {/* Post update form */}
        {showUpdateForm && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Post an update</Text>
            <View style={styles.updateForm}>
              {/* Kind picker */}
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingBottom: 8 }}>
                {UPDATE_KINDS.map(k => (
                  <TouchableOpacity
                    key={k}
                    style={[styles.kindChip, updateKind === k && { backgroundColor: S.color, borderColor: S.color }]}
                    onPress={() => {
                      setUpdateKind(k);
                      setUpdateUrgent(k === 'urgent' || k === 'cancellation');
                    }}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.kindChipText, updateKind === k && { color: '#fff' }]}>
                      {UPDATE_KIND_LABELS[k]}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <TextInput
                style={styles.updateInput}
                value={updateTitle}
                onChangeText={setUpdateTitle}
                placeholder="Update headline"
                placeholderTextColor={colors.textLight}
              />
              <TextInput
                style={[styles.updateInput, styles.updateInputMulti]}
                value={updateBody}
                onChangeText={setUpdateBody}
                placeholder="Details (optional)"
                placeholderTextColor={colors.textLight}
                multiline
                numberOfLines={3}
              />
              <TouchableOpacity
                style={[styles.postBtn, { backgroundColor: updateTitle.trim() ? S.color : colors.border }, postingUpdate && { opacity: 0.7 }]}
                onPress={handlePostUpdate}
                disabled={!updateTitle.trim() || postingUpdate}
                activeOpacity={0.85}
              >
                {postingUpdate
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={styles.postBtnText}>Post update</Text>
                }
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Updates history */}
        {updates.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Updates sent</Text>
            <View style={{ gap: 8 }}>
              {updates.map(u => (
                <View key={u.id} style={styles.updateHistoryRow}>
                  <View style={[styles.updateDot, { backgroundColor: u.is_urgent ? colors.error : S.color }]} />
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                      <Text style={styles.updateHistoryKind}>{UPDATE_KIND_LABELS[u.kind]}</Text>
                      <Text style={styles.updateHistoryDate}>
                        {new Date(u.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                      </Text>
                    </View>
                    <Text style={styles.updateHistoryTitle}>{u.title}</Text>
                  </View>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Danger zone */}
        {!isCancelled && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.error }]}>Danger zone</Text>
            <TouchableOpacity
              style={styles.cancelEventBtn}
              onPress={() => handleStatusChange('cancelled')}
              activeOpacity={0.8}
            >
              <FontAwesome5 name="times-circle" size={13} color={colors.error} />
              <Text style={styles.cancelEventBtnText}>Cancel this event</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function StatusStrip({ status, isBusy, onChangeStatus }: {
  status: EventStatus; isBusy: boolean;
  onChangeStatus: (s: EventStatus) => void;
}) {
  const config: Record<EventStatus, { label: string; color: string }> = {
    draft:     { label: 'Draft',     color: colors.textMuted  },
    published: { label: 'Published', color: colors.success    },
    cancelled: { label: 'Cancelled', color: colors.error      },
    postponed: { label: 'Postponed', color: colors.warning     },
    archived:  { label: 'Archived',  color: colors.textMuted  },
  };
  const cfg = config[status] ?? config.draft;
  return (
    <View style={styles.statusStrip}>
      <View style={[styles.statusDot, { backgroundColor: cfg.color }]} />
      <Text style={[styles.statusLabel, { color: cfg.color }]}>{cfg.label}</Text>
      {status === 'draft' && !isBusy && (
        <TouchableOpacity style={styles.publishNowBtn} onPress={() => onChangeStatus('published')} activeOpacity={0.85}>
          <Text style={styles.publishNowText}>Publish now</Text>
        </TouchableOpacity>
      )}
      {status === 'published' && !isBusy && (
        <TouchableOpacity style={styles.unpublishBtn} onPress={() => onChangeStatus('draft')} activeOpacity={0.85}>
          <Text style={styles.unpublishText}>Unpublish</Text>
        </TouchableOpacity>
      )}
      {isBusy && <ActivityIndicator size="small" color={S.color} />}
    </View>
  );
}

function StatBox({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <View style={styles.statBox}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function ActionBtn({ icon, label, color, onPress, disabled }: {
  icon: string; label: string; color: string; onPress: () => void; disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[styles.actionBtn, disabled && { opacity: 0.4 }]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.8}
    >
      <View style={[styles.actionBtnIcon, { backgroundColor: color + '18' }]}>
        <FontAwesome5 name={icon as any} size={16} color={color} />
      </View>
      <Text style={styles.actionBtnLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.navy },
  scroll: { flex: 1, backgroundColor: colors.screenBackground },
  content:{ paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.screenBackground },
  errorText: { fontSize: fontSize.md, color: colors.textMuted },

  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
  },
  backBtn:     { flexDirection: 'row', alignItems: 'center', gap: 8, width: 60 },
  backText:    { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { flex: 1, color: '#fff', fontSize: fontSize.md, fontWeight: '800', textAlign: 'center', marginHorizontal: 8 },

  statusStrip: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#fff', paddingHorizontal: spacing.md, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  statusDot:   { width: 8, height: 8, borderRadius: 4 },
  statusLabel: { fontSize: fontSize.sm, fontWeight: '800', flex: 1 },
  reachBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: spacing.md, paddingVertical: 10, borderRadius: radius.md, marginTop: spacing.sm },
  reachBannerText: { fontSize: fontSize.sm, fontWeight: '800' },
  publishNowBtn: { backgroundColor: colors.success, paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.full },
  publishNowText:{ color: '#fff', fontSize: fontSize.xs, fontWeight: '800' },
  unpublishBtn:  { borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.full },
  unpublishText: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '700' },

  dateSummary: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: spacing.md, paddingVertical: 10,
    backgroundColor: S.light,
  },
  dateSummaryText: { fontSize: fontSize.xs, color: S.color, fontWeight: '700' },

  statsCard: {
    flexDirection: 'row', backgroundColor: '#fff',
    marginHorizontal: spacing.md, marginTop: spacing.md,
    borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    ...shadow.card,
  },
  statBox:   { flex: 1, alignItems: 'center', paddingVertical: 16 },
  statValue: { fontSize: fontSize.xxl, fontWeight: '900' },
  statLabel: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '700', marginTop: 2 },
  statsDivider: { width: 1, backgroundColor: colors.border },

  section:      { padding: spacing.md },
  sectionTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary, marginBottom: 10 },

  actionsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  actionBtn: {
    width: '47%', backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: 14, alignItems: 'center', gap: 8,
    ...shadow.card,
  },
  actionBtnIcon:  { width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  actionBtnLabel: { fontSize: fontSize.xs, fontWeight: '800', color: colors.textPrimary, textAlign: 'center' },

  updateForm: { gap: 8 },
  kindChip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.full,
    borderWidth: 1.5, borderColor: colors.border, backgroundColor: '#fff',
  },
  kindChipText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textMuted },
  updateInput: {
    backgroundColor: '#fff', borderRadius: radius.md,
    borderWidth: 1.5, borderColor: colors.border,
    paddingHorizontal: 12, paddingVertical: 10,
    fontSize: fontSize.sm, color: colors.textPrimary,
  },
  updateInputMulti: { minHeight: 70, textAlignVertical: 'top' },
  postBtn: { paddingVertical: 13, borderRadius: radius.md, alignItems: 'center' },
  postBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '900' },

  updateHistoryRow: {
    flexDirection: 'row', gap: 10, alignItems: 'flex-start',
    backgroundColor: '#fff', borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, padding: 12,
  },
  updateDot:         { width: 8, height: 8, borderRadius: 4, marginTop: 4, flexShrink: 0 },
  updateHistoryKind: { fontSize: fontSize.xs, fontWeight: '800', color: S.color, textTransform: 'uppercase' },
  updateHistoryDate: { fontSize: fontSize.xs, color: colors.textMuted },
  updateHistoryTitle:{ fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },

  cancelEventBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: 12, borderRadius: radius.md,
    borderWidth: 1.5, borderColor: colors.error + '60', backgroundColor: colors.errorLight,
  },
  cancelEventBtnText: { fontSize: fontSize.sm, fontWeight: '800', color: colors.error },
});
