import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAlert } from '@/components/BrandedAlert';
import {
  fetchShiftManageApplications, updateApplicationStatus,
  confirmShiftComplete, cancelShift, hoursWorked,
  type Shift, type CheckInStatus,
} from '@/lib/shifts-api';

const S = SECTIONS.shifts;

type HubApp = {
  id: string; worker_id: string; shift_id: string; status: string; message: string | null;
  check_in_status: CheckInStatus; checked_in_at: string | null;
  checked_out_at: string | null; employer_confirmed_at: string | null; created_at: string;
  worker: { display_name: string | null; full_name: string | null; location_area: string | null; created_at: string } | null;
  workerProfile: { bio: string | null; experience_summary: string | null; skills: string[] | null; hourly_rate_min: number | null; hourly_rate_max: number | null; qualifications: string[] | null } | null;
};

const time = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';

/** Worker check-in state phrased for the employer. */
function checkInState(a: HubApp): { text: string; bg: string; color: string } {
  if (a.check_in_status === 'employer_confirmed') return { text: 'Hours confirmed', bg: colors.successLight, color: colors.success };
  if (a.check_in_status === 'checked_out')        return { text: `Finished ${time(a.checked_out_at)}`, bg: colors.warningLight, color: colors.warning };
  if (a.check_in_status === 'checked_in')         return { text: `Clocked in ${time(a.checked_in_at)}`, bg: S.light, color: S.color };
  return { text: 'Not yet clocked in', bg: colors.screenBackground, color: colors.textMuted };
}

export function ShiftOwnerHub({ shift, onShiftUpdate }: { shift: Shift; onShiftUpdate: (p: Partial<Shift>) => void }) {
  const { alert } = useAlert();
  const [apps, setApps]       = useState<HubApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy]       = useState<string | null>(null);
  const [filled, setFilled]   = useState(shift.positions_filled);
  const [status, setStatus]   = useState(shift.status);

  const load = useCallback(async () => {
    try {
      const data = await fetchShiftManageApplications(shift.id);
      setApps((data ?? []) as HubApp[]);
    } catch {
      /* leave list as-is; a transient read error shouldn't blank the hub */
    } finally {
      setLoading(false);
    }
  }, [shift.id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const pending   = apps.filter(a => a.status === 'pending');
  const crew      = apps.filter(a => a.status === 'accepted');
  const spotsLeft = Math.max(0, shift.positions_total - filled);
  const active    = status === 'open' || status === 'filled';
  const canComplete = active && (crew.some(a => a.check_in_status === 'checked_out') || new Date(shift.start_at).getTime() < Date.now());

  const decide = (app: HubApp, decision: 'accepted' | 'rejected') => {
    const name = app.worker?.display_name || app.worker?.full_name || 'this applicant';
    alert({
      title: decision === 'accepted' ? 'Accept' : 'Decline',
      message: decision === 'accepted'
        ? `Accept ${name} for "${shift.title}"? They'll be notified.`
        : `Decline ${name}'s application?`,
      actions: [
        { label: 'Cancel', style: 'cancel' },
        {
          label: decision === 'accepted' ? 'Accept' : 'Decline',
          style: decision === 'rejected' ? 'destructive' : 'primary',
          onPress: async () => {
            setBusy(app.id);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            try {
              await updateApplicationStatus(app.id, decision, app.shift_id);
              if (decision === 'accepted') {
                const newFilled = filled + 1;
                const nowFull   = newFilled >= shift.positions_total;
                setFilled(newFilled);
                if (nowFull) setStatus('filled');
                onShiftUpdate({ positions_filled: newFilled, ...(nowFull ? { status: 'filled' } : {}) });
              }
              await load();
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            } catch (e: any) {
              alert({ title: 'Error', message: e?.message });
            } finally {
              setBusy(null);
            }
          },
        },
      ],
    });
  };

  const complete = () => {
    alert({
      title: 'Mark shift complete?',
      message: 'Your crew will be confirmed as done and notified.',
      actions: [
        { label: 'Not yet', style: 'cancel' },
        {
          label: 'Confirm complete',
          style: 'primary',
          onPress: async () => {
            setBusy('complete');
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            try {
              await confirmShiftComplete(shift.id);
              setStatus('completed');
              onShiftUpdate({ status: 'completed' });
              await load();
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            } catch (e: any) {
              alert({ title: 'Error', message: e?.message });
            } finally {
              setBusy(null);
            }
          },
        },
      ],
    });
  };

  const doCancel = () => {
    alert({
      title: 'Cancel this shift?',
      message: 'Anyone still in play will be told it’s off. No new applications can come in.',
      actions: [
        { label: 'Keep it open', style: 'cancel' },
        {
          label: 'Yes, cancel it',
          style: 'destructive',
          onPress: async () => {
            setBusy('cancel');
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            try {
              await cancelShift(shift.id);
              setStatus('cancelled');
              onShiftUpdate({ status: 'cancelled' });
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            } catch (e: any) {
              alert({ title: 'Error', message: e?.message });
            } finally {
              setBusy(null);
            }
          },
        },
      ],
    });
  };

  const STATUS_BADGE: Record<string, { label: string; color: string; bg: string }> = {
    open:      { label: 'Open',      color: S.color,          bg: S.light },
    filled:    { label: 'Filled',    color: colors.jobs,      bg: colors.jobsLight },
    cancelled: { label: 'Cancelled', color: colors.textMuted, bg: colors.screenBackground },
    completed: { label: 'Completed', color: '#2563EB',        bg: '#EFF6FF' },
  };
  const badge = STATUS_BADGE[status] ?? STATUS_BADGE.open;

  return (
    <View style={{ gap: spacing.md }}>
      {/* Status strip */}
      <View style={styles.strip}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={[styles.stripTitle, { color: S.color }]}>You posted this shift</Text>
          <View style={[styles.badge, { backgroundColor: badge.bg }]}><Text style={[styles.badgeText, { color: badge.color }]}>{badge.label}</Text></View>
        </View>
        <Text style={styles.stripMeta}>
          {filled}/{shift.positions_total} filled{spotsLeft > 0 ? ` · ${spotsLeft} spot${spotsLeft === 1 ? '' : 's'} left` : ''}
          {pending.length > 0 ? ` · ${pending.length} to review` : ''}
        </Text>
        {active && (
          <View style={styles.stripActions}>
            {canComplete && (
              <TouchableOpacity style={[styles.actBtn, { backgroundColor: colors.success }]} onPress={complete} disabled={!!busy}>
                <Text style={styles.actBtnText}>Mark complete</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={[styles.actBtn, styles.actBtnGhost]} onPress={doCancel} disabled={!!busy}>
              <Text style={[styles.actBtnText, { color: colors.error }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {loading ? (
        <ActivityIndicator color={S.color} style={{ marginVertical: spacing.md }} />
      ) : (
        <>
          {/* Applicants to review */}
          <View>
            <Text style={styles.groupTitle}>Applicants to review{pending.length ? ` (${pending.length})` : ''}</Text>
            {pending.length === 0 ? (
              <Text style={styles.emptyText}>No applications waiting.</Text>
            ) : (
              <View style={{ gap: 10, marginTop: 8 }}>
                {pending.map(a => {
                  const name = a.worker?.display_name || a.worker?.full_name || 'Applicant';
                  const wp = a.workerProfile;
                  const memberSince = a.worker?.created_at ? new Date(a.worker.created_at).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) : null;
                  return (
                    <View key={a.id} style={styles.card}>
                      <Text style={styles.name}>{name}{a.worker?.location_area ? <Text style={styles.nameSub}>{`  ·  ${a.worker.location_area}`}</Text> : null}</Text>
                      {memberSince ? <Text style={styles.faint}>On OneShetland since {memberSince}</Text> : null}
                      {wp?.bio ? <Text style={styles.body}><Text style={styles.bodyLabel}>About: </Text>{wp.bio}</Text> : null}
                      {wp?.experience_summary ? <Text style={styles.body}><Text style={styles.bodyLabel}>Experience: </Text>{wp.experience_summary}</Text> : null}
                      {(wp?.hourly_rate_min != null || wp?.hourly_rate_max != null) ? (
                        <Text style={styles.body}><Text style={styles.bodyLabel}>Rate: </Text>
                          {wp?.hourly_rate_min != null && wp?.hourly_rate_max != null ? `£${wp.hourly_rate_min}–£${wp.hourly_rate_max}/hr` : `£${wp?.hourly_rate_min ?? wp?.hourly_rate_max}/hr`}</Text>
                      ) : null}
                      {wp?.skills && wp.skills.length > 0 ? (
                        <View style={styles.chips}>{wp.skills.map(sk => <View key={sk} style={styles.chip}><Text style={styles.chipText}>{sk}</Text></View>)}</View>
                      ) : null}
                      {wp?.qualifications && wp.qualifications.length > 0 ? (
                        <Text style={styles.faint}><Text style={{ fontWeight: '700' }}>Qualifications: </Text>{wp.qualifications.join(', ')}</Text>
                      ) : null}
                      {a.message ? <View style={styles.note}><Text style={styles.body}><Text style={styles.bodyLabel}>Their note: </Text>{a.message}</Text></View> : null}
                      <View style={styles.cardActions}>
                        <TouchableOpacity style={[styles.decideBtn, { backgroundColor: S.color }, (busy === a.id || spotsLeft === 0) && { opacity: 0.4 }]} onPress={() => decide(a, 'accepted')} disabled={busy === a.id || spotsLeft === 0}>
                          <Text style={styles.decideBtnText}>Accept</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={[styles.decideBtnGhost, busy === a.id && { opacity: 0.4 }]} onPress={() => decide(a, 'rejected')} disabled={busy === a.id}>
                          <Text style={[styles.decideBtnText, { color: colors.error }]}>Decline</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </View>

          {/* Crew + live check-in */}
          {crew.length > 0 && (
            <View>
              <Text style={styles.groupTitle}>Your crew ({crew.length})</Text>
              <View style={{ gap: 8, marginTop: 8 }}>
                {crew.map(a => {
                  const name = a.worker?.display_name || a.worker?.full_name || 'Worker';
                  const ci = checkInState(a);
                  const worked = (a.check_in_status === 'checked_out' || a.check_in_status === 'employer_confirmed')
                    ? hoursWorked(a, shift.start_at, shift.end_at) : null;
                  return (
                    <View key={a.id} style={styles.crewRow}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.crewName} numberOfLines={1}>{name}</Text>
                        {worked ? <Text style={styles.crewHours}>{worked.label} worked{worked.actual ? '' : ' (scheduled)'}</Text> : null}
                      </View>
                      <View style={[styles.badge, { backgroundColor: ci.bg }]}><Text style={[styles.badgeText, { color: ci.color }]}>{ci.text}</Text></View>
                    </View>
                  );
                })}
              </View>
              {canComplete && crew.some(a => a.check_in_status !== 'employer_confirmed') && (
                <TouchableOpacity style={[styles.completeWide, { backgroundColor: colors.success }]} onPress={complete} disabled={!!busy}>
                  <Text style={styles.actBtnText}>Confirm hours & complete shift</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { backgroundColor: '#fff', borderRadius: radius.xl, borderWidth: 1.5, borderColor: S.color + '33', padding: spacing.md, gap: 8 },
  stripTitle: { fontSize: fontSize.sm, fontWeight: '800' },
  stripMeta: { fontSize: fontSize.xs, color: colors.textSecondary, fontWeight: '600' },
  stripActions: { flexDirection: 'row', gap: 8, marginTop: 2 },
  actBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.full },
  actBtnGhost: { borderWidth: 1, borderColor: colors.border, backgroundColor: '#fff' },
  actBtnText: { color: '#fff', fontSize: fontSize.xs, fontWeight: '800' },
  completeWide: { marginTop: 10, height: 46, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' },

  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.full },
  badgeText: { fontSize: 11, fontWeight: '800' },

  groupTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary },
  emptyText: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 6 },

  card: { backgroundColor: '#fff', borderRadius: radius.xl, borderWidth: 1, borderColor: colors.border, padding: spacing.md, gap: 5 },
  name: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  nameSub: { fontSize: fontSize.sm, fontWeight: '500', color: colors.textMuted },
  faint: { fontSize: fontSize.xs, color: colors.textMuted },
  body: { fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 20 },
  bodyLabel: { fontWeight: '700', color: colors.textPrimary },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 },
  chip: { backgroundColor: colors.screenBackground, paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.full },
  chipText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textSecondary },
  note: { backgroundColor: colors.screenBackground, borderRadius: radius.md, padding: 10, marginTop: 2 },
  cardActions: { flexDirection: 'row', gap: 10, marginTop: 8 },
  decideBtn: { flex: 1, height: 42, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' },
  decideBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
  decideBtnGhost: { flex: 1, height: 42, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },

  crewRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 10 },
  crewName: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  crewHours: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
});
