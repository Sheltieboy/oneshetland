import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, Alert, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import {
  fetchEmployerApplications, updateApplicationStatus, formatShiftDate,
} from '@/lib/shifts-api';

const S = SECTIONS.shifts;

type WorkerProfile = {
  bio:                string | null;
  experience_summary: string | null;
  skills:             string[] | null;
  hourly_rate_min:    number | null;
  hourly_rate_max:    number | null;
  qualifications:     string[] | null;
} | null;

type Application = {
  id:            string;
  shift_id:      string;
  status:        string;
  message:       string | null;
  created_at:    string;
  shift:         { title: string; start_at: string } | null;
  worker:        { full_name: string; avatar_url: string | null; location_area: string | null; created_at: string } | null;
  workerProfile: WorkerProfile;
};

export default function EmployerApplicationsScreen() {
  const router = useRouter();
  const { profile } = useAuth();

  const [applications, setApplications] = useState<Application[]>([]);
  const [loading, setLoading]           = useState(true);
  const [refreshing, setRefreshing]     = useState(false);
  const [actioning, setActioning]       = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile) return;
    try {
      const data = await fetchEmployerApplications(profile.id);
      setApplications((data ?? []) as Application[]);
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Could not load applications.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [profile]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = () => { setRefreshing(true); load(); };

  const handleAction = (appId: string, status: 'accepted' | 'rejected', workerName: string) => {
    const label = status === 'accepted' ? 'Accept' : 'Decline';
    const msg   = status === 'accepted'
      ? `Accept ${workerName} for this shift? They'll be notified.`
      : `Decline ${workerName}'s application?`;

    Alert.alert(label, msg, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: label,
        style: status === 'rejected' ? 'destructive' : 'default',
        onPress: async () => {
          setActioning(appId);
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          try {
            const app = applications.find(a => a.id === appId);
            await updateApplicationStatus(appId, status, app?.shift_id);
            setApplications(prev => prev.filter(a => a.id !== appId));
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          } catch (e: any) {
            Alert.alert('Error', e?.message);
          } finally {
            setActioning(null);
          }
        },
      },
    ]);
  };

  const renderItem = ({ item }: { item: Application }) => {
    const workerName   = item.worker?.full_name ?? 'Unknown';
    const initials     = workerName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    const isActioning  = actioning === item.id;
    const wp           = item.workerProfile;
    const memberSince  = item.worker?.created_at
      ? new Date(item.worker.created_at).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
      : null;

    return (
      <View style={styles.card}>

        {/* Which shift */}
        {item.shift && (
          <View style={styles.shiftBanner}>
            <FontAwesome5 name="briefcase" size={10} color={S.color} />
            <Text style={styles.shiftBannerTitle} numberOfLines={1}>{item.shift.title}</Text>
            <Text style={styles.shiftBannerDate}>{formatShiftDate(item.shift.start_at)}</Text>
          </View>
        )}

        {/* Worker header */}
        <View style={styles.workerHeader}>
          <View style={[styles.avatar, { backgroundColor: S.color + '22' }]}>
            <Text style={[styles.avatarText, { color: S.color }]}>{initials}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.workerName}>{workerName}</Text>
            <View style={styles.workerMeta}>
              {item.worker?.location_area ? (
                <View style={styles.metaItem}>
                  <FontAwesome5 name="map-marker-alt" size={10} color={colors.textMuted} />
                  <Text style={styles.metaText}>{item.worker.location_area}</Text>
                </View>
              ) : null}
              {memberSince ? (
                <View style={styles.metaItem}>
                  <FontAwesome5 name="calendar-alt" size={10} color={colors.textMuted} />
                  <Text style={styles.metaText}>Member since {memberSince}</Text>
                </View>
              ) : null}
            </View>
          </View>
          <View style={styles.appliedPill}>
            <Text style={styles.appliedPillText}>
              {new Date(item.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
            </Text>
          </View>
        </View>

        {/* Bio */}
        {wp?.bio ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>About</Text>
            <Text style={styles.bioText}>{wp.bio}</Text>
          </View>
        ) : null}

        {/* Experience */}
        {wp?.experience_summary ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Experience</Text>
            <Text style={styles.bioText}>{wp.experience_summary}</Text>
          </View>
        ) : null}

        {/* Rate expectation */}
        {(wp?.hourly_rate_min || wp?.hourly_rate_max) ? (
          <View style={styles.rateRow}>
            <FontAwesome5 name="pound-sign" size={11} color={S.color} />
            <Text style={styles.rateText}>
              {wp?.hourly_rate_min && wp?.hourly_rate_max
                ? `£${wp.hourly_rate_min}–£${wp.hourly_rate_max}/hr expected`
                : wp?.hourly_rate_min
                  ? `From £${wp.hourly_rate_min}/hr`
                  : `Up to £${wp?.hourly_rate_max}/hr`}
            </Text>
          </View>
        ) : null}

        {/* Skills */}
        {wp?.skills && wp.skills.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Skills</Text>
            <View style={styles.tagRow}>
              {wp.skills.map(skill => (
                <View key={skill} style={styles.tag}>
                  <Text style={styles.tagText}>{skill}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {/* Qualifications */}
        {wp?.qualifications && wp.qualifications.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Qualifications</Text>
            <View style={styles.tagRow}>
              {wp.qualifications.map(q => (
                <View key={q} style={[styles.tag, { backgroundColor: colors.jobs + '18', borderColor: colors.jobs + '44' }]}>
                  <FontAwesome5 name="check" size={8} color={colors.jobs} style={{ marginRight: 3 }} />
                  <Text style={[styles.tagText, { color: colors.jobs }]}>{q}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {/* Message from applicant */}
        {item.message ? (
          <View style={styles.messageBox}>
            <FontAwesome5 name="comment-alt" size={11} color={S.color} style={{ marginTop: 1 }} />
            <View style={{ flex: 1 }}>
              <Text style={styles.messageLabel}>Their message</Text>
              <Text style={styles.messageText}>"{item.message}"</Text>
            </View>
          </View>
        ) : null}

        {/* No profile info notice */}
        {!wp && !item.message ? (
          <View style={styles.noProfileNote}>
            <FontAwesome5 name="user-circle" size={12} color={colors.textMuted} />
            <Text style={styles.noProfileText}>This worker hasn't completed their shift profile yet.</Text>
          </View>
        ) : null}

        {/* Actions */}
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.actionBtn, styles.declineBtn]}
            onPress={() => handleAction(item.id, 'rejected', workerName)}
            disabled={isActioning}
            activeOpacity={0.8}
          >
            {isActioning
              ? <ActivityIndicator size="small" color={colors.textMuted} />
              : <Text style={styles.declineBtnText}>Decline</Text>
            }
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: S.color }]}
            onPress={() => handleAction(item.id, 'accepted', workerName)}
            disabled={isActioning}
            activeOpacity={0.8}
          >
            {isActioning
              ? <ActivityIndicator size="small" color="#fff" />
              : <>
                  <FontAwesome5 name="check" size={12} color="#fff" />
                  <Text style={styles.acceptBtnText}>Accept</Text>
                </>
            }
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>

      <View style={[styles.backBar, { borderBottomColor: S.color }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Shifts</Text>
        </TouchableOpacity>
        <Text style={styles.screenTitle}>Applications</Text>
        <View style={{ width: 60 }} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={S.color} />
        </View>
      ) : (
        <FlatList
          data={applications}
          keyExtractor={item => item.id}
          renderItem={renderItem}
          contentContainerStyle={[styles.list, applications.length === 0 && { flex: 1 }]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={S.color} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <View style={[styles.emptyIcon, { backgroundColor: S.light }]}>
                <FontAwesome5 name="inbox" size={28} color={S.color} />
              </View>
              <Text style={styles.emptyTitle}>No pending applications</Text>
              <Text style={styles.emptyText}>
                When workers submit interest in your shifts, they'll appear here.
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.screenBackground },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  backBar: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
    borderBottomWidth: 2,
  },
  backBtn:     { flexDirection: 'row', alignItems: 'center', gap: 8, width: 60 },
  backText:    { fontSize: fontSize.sm, fontWeight: '700' },
  screenTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },

  list: { padding: spacing.md, gap: 14, paddingBottom: 60 },

  card: {
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: 14,
    shadowColor: '#0F1C26',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 10,
    elevation: 2,
  },

  // Shift banner
  shiftBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: S.light,
    borderRadius: radius.md,
    paddingHorizontal: 10, paddingVertical: 8,
  },
  shiftBannerTitle: { flex: 1, fontSize: fontSize.xs, fontWeight: '700', color: S.color },
  shiftBannerDate:  { fontSize: fontSize.xs, color: S.color, opacity: 0.7 },

  // Worker header
  workerHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  avatar: {
    width: 48, height: 48, borderRadius: 24,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText:  { fontSize: fontSize.md, fontWeight: '900' },
  workerName:  { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, marginBottom: 4 },
  workerMeta:  { gap: 3 },
  metaItem:    { flexDirection: 'row', alignItems: 'center', gap: 5 },
  metaText:    { fontSize: fontSize.xs, color: colors.textMuted },
  appliedPill: {
    backgroundColor: colors.screenBackground,
    borderRadius: radius.full,
    paddingHorizontal: 8, paddingVertical: 4,
  },
  appliedPillText: { fontSize: 10, color: colors.textMuted, fontWeight: '600' },

  // Sections
  section:      { gap: 6 },
  sectionLabel: { fontSize: fontSize.xs, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  bioText:      { fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 20 },

  // Rate
  rateRow:  { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rateText: { fontSize: fontSize.sm, fontWeight: '700', color: S.color },

  // Tags
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 10, paddingVertical: 4,
    backgroundColor: colors.screenBackground,
    borderRadius: radius.full,
    borderWidth: 1, borderColor: colors.border,
  },
  tagText: { fontSize: 11, fontWeight: '600', color: colors.textSecondary },

  // Message
  messageBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    backgroundColor: S.light,
    borderRadius: radius.md,
    padding: 12,
    borderLeftWidth: 3, borderLeftColor: S.color,
  },
  messageLabel: { fontSize: 10, fontWeight: '800', color: S.color, marginBottom: 3, textTransform: 'uppercase' },
  messageText:  { fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 20, fontStyle: 'italic' },

  // No profile
  noProfileNote: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.screenBackground, borderRadius: radius.md,
    padding: 10,
  },
  noProfileText: { fontSize: fontSize.xs, color: colors.textMuted, flex: 1, lineHeight: 16 },

  // Actions
  actions: { flexDirection: 'row', gap: 10, paddingTop: 4, borderTopWidth: 1, borderTopColor: colors.border },
  actionBtn: {
    flex: 1, height: 46, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
    flexDirection: 'row', gap: 6,
  },
  declineBtn:     { borderWidth: 1.5, borderColor: colors.border, backgroundColor: '#fff' },
  declineBtnText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textMuted },
  acceptBtnText:  { fontSize: fontSize.sm, fontWeight: '800', color: '#fff' },

  // Empty
  empty:      { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: 12 },
  emptyIcon:  { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  emptyTitle: { fontSize: fontSize.lg, fontWeight: '800', color: colors.textPrimary },
  emptyText:  { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
});
