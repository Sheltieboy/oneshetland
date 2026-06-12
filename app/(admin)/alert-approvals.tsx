/**
 * (admin)/alert-approvals.tsx
 *
 * Review businesses requesting urgent alert access.
 * Access is gated by the (admin) layout — role = 'admin' only.
 */

import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert, TextInput, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius, shadow } from '@/constants/theme';
import {
  fetchAllAlertAccess, reviewAlertRequest,
  type AlertAccessWithBusiness, type AlertAccessStatus,
} from '@/lib/alerts-api';

const STATUS_META: Record<AlertAccessStatus, { label: string; color: string; bg: string }> = {
  requested:  { label: 'Pending',   color: '#FF9500', bg: '#FFF8EC' },
  approved:   { label: 'Approved',  color: '#34C759', bg: '#F0FBF3' },
  active:     { label: 'Active',    color: '#0A84FF', bg: '#EEF5FF' },
  rejected:   { label: 'Rejected',  color: '#FF3B30', bg: '#FFF2F1' },
  suspended:  { label: 'Suspended', color: '#8E8E93', bg: '#F2F2F7' },
};

export default function AdminAlertApprovalsScreen() {
  const router = useRouter();

  const [requests, setRequests]   = useState<AlertAccessWithBusiness[]>([]);
  const [loading,  setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [noteText,    setNoteText]    = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const data = await fetchAllAlertAccess().catch(() => []);
    setRequests(data);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const decide = async (accessId: string, decision: 'approved' | 'rejected') => {
    setBusy(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await reviewAlertRequest(accessId, decision, noteText.trim() || undefined);
      setNoteText('');
      setReviewingId(null);
      await load();
    } catch (e: any) {
      Alert.alert('Error', e.message ?? 'Could not save decision');
    } finally {
      setBusy(false);
    }
  };

  const pending  = requests.filter(r => r.status === 'requested');
  const rest     = requests.filter(r => r.status !== 'requested');

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <FontAwesome5 name="chevron-left" size={14} color="#fff" />
        </TouchableOpacity>
        <View>
          <Text style={styles.headerTitle}>Alert Requests</Text>
          {pending.length > 0 && (
            <Text style={styles.headerSub}>{pending.length} awaiting review</Text>
          )}
        </View>
        <View style={{ width: 36 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={colors.accent} /></View>
      ) : (
        <ScrollView
          style={{ flex: 1, backgroundColor: colors.screenBackground }}
          contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
        >
          {/* Pending section */}
          {pending.length > 0 && (
            <View>
              <Text style={styles.sectionLabel}>NEEDS REVIEW</Text>
              <View style={{ gap: 10 }}>
                {pending.map(r => (
                  <RequestCard
                    key={r.id}
                    request={r}
                    isReviewing={reviewingId === r.id}
                    noteText={noteText}
                    onNoteChange={setNoteText}
                    onExpandReview={() => setReviewingId(r.id)}
                    onApprove={() => decide(r.id, 'approved')}
                    onReject={() => decide(r.id, 'rejected')}
                    busy={busy}
                  />
                ))}
              </View>
            </View>
          )}

          {/* History */}
          {rest.length > 0 && (
            <View>
              <Text style={styles.sectionLabel}>HISTORY</Text>
              <View style={{ gap: 8 }}>
                {rest.map(r => (
                  <RequestCard key={r.id} request={r} isReviewing={false} noteText="" onNoteChange={() => {}} onExpandReview={() => {}} onApprove={() => {}} onReject={() => {}} busy={false} />
                ))}
              </View>
            </View>
          )}

          {requests.length === 0 && (
            <View style={styles.empty}>
              <FontAwesome5 name="bell-slash" size={32} color={colors.textMuted} />
              <Text style={styles.emptyText}>No requests yet</Text>
            </View>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function RequestCard({
  request, isReviewing, noteText, onNoteChange,
  onExpandReview, onApprove, onReject, busy,
}: {
  request:        AlertAccessWithBusiness;
  isReviewing:    boolean;
  noteText:       string;
  onNoteChange:   (v: string) => void;
  onExpandReview: () => void;
  onApprove:      () => void;
  onReject:       () => void;
  busy:           boolean;
}) {
  const meta   = STATUS_META[request.status];
  const biz    = request.local_businesses;
  const reqDate = new Date(request.requested_at).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });

  return (
    <View style={styles.card}>
      {/* Business info */}
      <View style={styles.cardTop}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.bizName}>{biz?.name ?? 'Unknown business'}</Text>
          {biz?.category && <Text style={styles.bizCat}>{biz.category}</Text>}
          <Text style={styles.reqDate}>Requested {reqDate}</Text>
        </View>
        <View style={[styles.statusBadge, { backgroundColor: meta.bg, borderColor: meta.color + '40' }]}>
          <Text style={[styles.statusText, { color: meta.color }]}>{meta.label}</Text>
        </View>
      </View>

      {request.reviewer_notes ? (
        <View style={styles.noteView}>
          <Text style={styles.noteLabel}>Note</Text>
          <Text style={styles.noteText}>{request.reviewer_notes}</Text>
        </View>
      ) : null}

      {/* Review actions — only for pending */}
      {request.status === 'requested' && (
        isReviewing ? (
          <View style={styles.reviewPanel}>
            <TextInput
              style={styles.noteInput}
              placeholder="Optional note to log (internal only)…"
              placeholderTextColor={colors.textLight}
              value={noteText}
              onChangeText={onNoteChange}
              multiline
            />
            <View style={styles.reviewBtns}>
              <TouchableOpacity
                style={[styles.rejectBtn, busy && { opacity: 0.5 }]}
                onPress={onReject}
                disabled={busy}
              >
                {busy ? <ActivityIndicator size="small" color={colors.error} /> : (
                  <>
                    <FontAwesome5 name="times" size={11} color={colors.error} />
                    <Text style={[styles.reviewBtnText, { color: colors.error }]}>Reject</Text>
                  </>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.approveBtn, busy && { opacity: 0.5 }]}
                onPress={onApprove}
                disabled={busy}
              >
                {busy ? <ActivityIndicator size="small" color="#fff" /> : (
                  <>
                    <FontAwesome5 name="check" size={11} color="#fff" />
                    <Text style={[styles.reviewBtnText, { color: '#fff' }]}>Approve</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <TouchableOpacity style={styles.reviewTrigger} onPress={onExpandReview}>
            <Text style={styles.reviewTriggerText}>Review request →</Text>
          </TouchableOpacity>
        )
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.navy },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12, backgroundColor: colors.screenBackground },
  gateText: { fontSize: fontSize.md, color: colors.textMuted, fontWeight: '700' },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 14,
    backgroundColor: colors.navy,
  },
  backBtn:     { width: 36, alignItems: 'flex-start' },
  headerTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '900', textAlign: 'center' },
  headerSub:   { color: 'rgba(255,255,255,0.6)', fontSize: fontSize.xs, textAlign: 'center', marginTop: 1 },

  sectionLabel: {
    fontSize: 10, fontWeight: '900', letterSpacing: 1.2,
    color: colors.textMuted, marginBottom: 8, marginLeft: 2,
  },

  card: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing.md, gap: 10,
    ...shadow.card,
  },
  cardTop:    { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  bizName:    { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  bizCat:     { fontSize: fontSize.xs, color: colors.textMuted },
  reqDate:    { fontSize: fontSize.xs, color: colors.textLight, marginTop: 2 },
  statusBadge:{
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: radius.full, borderWidth: 1,
    alignSelf: 'flex-start',
  },
  statusText: { fontSize: fontSize.xs, fontWeight: '800' },

  noteView:  { backgroundColor: colors.screenBackground, borderRadius: radius.md, padding: 10, gap: 2 },
  noteLabel: { fontSize: 9, fontWeight: '900', letterSpacing: 1, color: colors.textMuted },
  noteText:  { fontSize: fontSize.sm, color: colors.textPrimary },

  reviewPanel: { gap: 10 },
  noteInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: 10, fontSize: fontSize.sm, color: colors.textPrimary,
    minHeight: 60, textAlignVertical: 'top',
  },
  reviewBtns: { flexDirection: 'row', gap: 10 },
  rejectBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 11, borderRadius: radius.md,
    borderWidth: 1.5, borderColor: colors.error + '50',
    backgroundColor: '#FFF2F1',
  },
  approveBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 11, borderRadius: radius.md,
    backgroundColor: colors.success,
  },
  reviewBtnText: { fontSize: fontSize.sm, fontWeight: '800' },

  reviewTrigger: { alignItems: 'flex-end' },
  reviewTriggerText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.accent },

  empty:      { alignItems: 'center', gap: 12, paddingTop: 60 },
  emptyText:  { fontSize: fontSize.md, color: colors.textMuted, fontWeight: '700' },
});
