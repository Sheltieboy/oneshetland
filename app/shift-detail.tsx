import React, { useEffect, useState, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, ActivityIndicator, Animated, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import { useGoToSignIn } from '@/hooks/useGoToSignIn';
import { useAlert } from '@/components/BrandedAlert';
import { ContentActions } from '@/components/ContentActions';
import { ShiftOwnerHub } from '@/components/ShiftOwnerHub';
import {
  fetchShift, fetchMyApplication, submitInterest, withdrawApplication,
  checkIn, checkOut,
  formatPay, formatDuration, formatShiftDate, URGENCY_CONFIG, CATEGORY_LABELS,
  shiftDisplayBusiness, hoursWorked,
  type Shift, type ShiftApplication, type CheckInStatus,
} from '@/lib/shifts-api';
import { track } from '@/lib/analytics';

const S = SECTIONS.shifts;

export default function ShiftDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router  = useRouter();
  const goToSignIn = useGoToSignIn();
  const { profile } = useAuth();
  const { alert } = useAlert();

  const [shift, setShift]             = useState<Shift | null>(null);
  const [application, setApplication] = useState<ShiftApplication | null>(null);
  const [loading, setLoading]         = useState(true);
  const [submitting, setSubmitting]   = useState(false);
  const [showMessage, setShowMessage] = useState(false);
  const [message, setMessage]         = useState('');
  const [checkingInOut, setCheckingInOut] = useState(false);

  const successAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!id) return;
    Promise.all([
      fetchShift(id),
      profile ? fetchMyApplication(id, profile.id) : Promise.resolve(null),
    ]).then(([s, app]) => {
      setShift(s);
      setApplication(app);
    }).catch(() => alert({ title: 'Error', message: 'Could not load shift.' }))
      .finally(() => setLoading(false));
  }, [id, profile]);

  useEffect(() => {
    if (shift?.id) track('content_viewed', { objectType: 'shift', objectId: shift.id });
  }, [shift?.id]);

  const handleSubmitInterest = async () => {
    if (!profile || !shift) return;
    setSubmitting(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await submitInterest(shift.id, profile.id, message || undefined);
      track('shift_applied', { objectType: 'shift', objectId: shift.id });
      const app = await fetchMyApplication(shift.id, profile.id);
      setApplication(app);
      setShowMessage(false);
      Animated.spring(successAnim, { toValue: 1, friction: 5, useNativeDriver: true }).start();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      alert({ title: 'Error', message: e.message });
    } finally {
      setSubmitting(false);
    }
  };

  const handleWithdraw = () => {
    alert({
      title: 'Withdraw application?',
      message: 'You can re-apply at any time.',
      actions: [
        { label: 'Cancel', style: 'cancel' },
        { label: 'Withdraw', style: 'destructive', onPress: async () => {
          if (!application) return;
          await withdrawApplication(application.id, shift?.id, application.status === 'accepted');
          setApplication(null);
          successAnim.setValue(0);
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }},
      ],
    });
  };

  // Refresh the worker's application from the server so the accepted card can
  // advance (null → checked_in → checked_out) after a check in/out.
  const refreshApplication = async () => {
    if (!shift || !profile) return;
    const app = await fetchMyApplication(shift.id, profile.id);
    setApplication(app);
  };

  // checkIn/checkOut already fire the notify-worker-checkin edge function; we
  // just persist + refresh here (no duplicate notification).
  const handleCheckIn = async () => {
    if (!application || checkingInOut) return;
    setCheckingInOut(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await checkIn(application.id);
      await refreshApplication();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      alert({ title: 'Error', message: e?.message ?? 'Could not check in.' });
    } finally {
      setCheckingInOut(false);
    }
  };

  const handleCheckOut = async () => {
    if (!application || checkingInOut) return;
    setCheckingInOut(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await checkOut(application.id);
      await refreshApplication();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      alert({ title: 'Error', message: e?.message ?? 'Could not check out.' });
    } finally {
      setCheckingInOut(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      </SafeAreaView>
    );
  }

  if (!shift) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}><Text style={styles.errorText}>Shift not found.</Text></View>
      </SafeAreaView>
    );
  }

  const urgency    = URGENCY_CONFIG[shift.urgency];
  const spotsLeft  = shift.positions_total - shift.positions_filled;
  const hasApplied = application && application.status !== 'withdrawn';
  const isAccepted = application?.status === 'accepted';
  const isOwnShift = profile?.id === shift.employer_id;
  const isBoosted  = !!(shift.boosted_until && shift.boosted_until > new Date().toISOString());

  const biz = shiftDisplayBusiness(shift);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Top bar */}
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/jobs?tab=shifts'))} style={styles.backPill} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={16} color={S.color} />
          <FontAwesome5 name={S.icon as any} size={12} color={S.color} solid />
          <Text style={styles.backPillText}>Shifts</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }} />
        {!isOwnShift ? (
          <ContentActions
            contentType="shift"
            contentId={shift.id}
            authorId={shift.employer_id}
            authorName={biz.name}
            icon="ellipsis-v"
            color={colors.textSecondary}
          />
        ) : null}
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* Head — logo + title + employer */}
        <View style={styles.head}>
          <View style={[styles.logo, { backgroundColor: S.light }]}>
            {biz.logo_url
              ? <Image source={{ uri: biz.logo_url }} style={styles.logoImg} />
              : <FontAwesome5 name="briefcase" size={22} color={S.color} solid />}
          </View>
          <View style={{ flex: 1 }}>
            <View style={styles.headBadges}>
              {isBoosted ? <View style={styles.featuredBadge}><FontAwesome5 name="bolt" size={9} color={S.color} solid /><Text style={styles.featuredText}>Boosted</Text></View> : null}
              <View style={[styles.urgencyBadge, { backgroundColor: urgency.bg }]}><Text style={[styles.urgencyText, { color: urgency.color }]}>{urgency.label}</Text></View>
            </View>
            <Text style={styles.title}>{shift.title}</Text>
            <Text style={styles.org}>{biz.name}{biz.is_verified ? '  ·  ✓ Verified' : ''}</Text>
          </View>
        </View>

        {/* Pay card */}
        <View style={[styles.payCard, { backgroundColor: S.light }]}>
          <FontAwesome5 name="coins" size={14} color={S.color} solid />
          <Text style={[styles.payText, { color: S.color }]}>{formatPay(shift.pay_type, shift.pay_amount)}</Text>
          <Text style={[styles.spots, spotsLeft === 0 && { color: colors.error }]}>
            {spotsLeft > 0 ? `${spotsLeft} of ${shift.positions_total} spot${shift.positions_total === 1 ? '' : 's'} left` : 'Full'}
          </Text>
        </View>

        {/* Fact grid */}
        <View style={styles.factGrid}>
          <Fact icon="calendar-day" label={formatShiftDate(shift.start_at)} />
          <Fact icon="hourglass-half" label={formatDuration(shift.start_at, shift.end_at)} />
          {shift.location_text ? <Fact icon="map-marker-alt" label={shift.location_text} /> : null}
          {CATEGORY_LABELS[shift.category] ? <Fact icon="tag" label={CATEGORY_LABELS[shift.category]} /> : null}
        </View>

        {/* ── Description ── */}
        {shift.description ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>About this shift</Text>
            <Text style={styles.descriptionText}>{shift.description}</Text>
          </View>
        ) : null}

        {/* ── Requirements ── */}
        {shift.requirements.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Requirements</Text>
            <Text style={styles.sectionHint}>You must meet these to apply</Text>
            <View style={styles.reqChips}>
              {shift.requirements.map(req => (
                <View key={req} style={styles.reqChip}>
                  <FontAwesome5 name="check" size={9} color={S.color} />
                  <Text style={styles.reqChipText}>{req}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* ── CTA ── */}
        <View style={styles.ctaSection}>
          {isOwnShift ? (
            <ShiftOwnerHub
              shift={shift}
              onShiftUpdate={(p) => setShift((prev) => (prev ? { ...prev, ...p } : prev))}
            />
          ) : spotsLeft === 0 && !hasApplied ? (
            <View style={styles.fullCard}>
              <FontAwesome5 name="user-slash" size={18} color={colors.textMuted} />
              <View style={{ flex: 1 }}>
                <Text style={styles.fullTitle}>This shift is now full</Text>
                <Text style={styles.fullSub}>All positions have been filled.</Text>
              </View>
            </View>
          ) : isAccepted && application ? (
            <AcceptedBlock
              cis={application.check_in_status ?? null}
              worked={hoursWorked(application, shift.start_at, shift.end_at)}
              startAt={shift.start_at}
              onCheckIn={handleCheckIn}
              onCheckOut={handleCheckOut}
              busy={checkingInOut}
            />
          ) : hasApplied ? (
            <View style={{ gap: 10 }}>
              <Animated.View style={[
                styles.appliedCard,
                { transform: [{ scale: successAnim.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) }] },
              ]}>
                <View style={[styles.appliedIconWrap, { backgroundColor: S.color + '18' }]}>
                  <FontAwesome5 name="paper-plane" size={16} color={S.color} solid />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.appliedTitle, { color: S.color }]}>Application sent</Text>
                  <Text style={styles.appliedSub}>The employer will be in touch if you're selected.</Text>
                </View>
              </Animated.View>
              <TouchableOpacity style={styles.withdrawBtn} onPress={handleWithdraw}>
                <Text style={styles.withdrawText}>Withdraw application</Text>
              </TouchableOpacity>
            </View>
          ) : (
            showMessage ? (
              <View style={styles.messageCard}>
                <Text style={styles.messageLabel}>Add a note (optional)</Text>
                <TextInput
                  style={styles.messageInput}
                  value={message}
                  onChangeText={setMessage}
                  placeholder="Introduce yourself or mention relevant experience…"
                  placeholderTextColor={colors.textLight}
                  multiline
                  autoFocus
                />
                <View style={styles.messageActions}>
                  <TouchableOpacity
                    style={styles.skipBtn}
                    onPress={() => { setShowMessage(false); handleSubmitInterest(); }}
                  >
                    <Text style={styles.skipText}>Skip & submit</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.applyBtn, submitting && { opacity: 0.7 }]}
                    onPress={handleSubmitInterest}
                    disabled={submitting}
                  >
                    {submitting
                      ? <ActivityIndicator color="#fff" size="small" />
                      : <Text style={styles.applyBtnText}>Submit application</Text>
                    }
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <TouchableOpacity
                style={styles.applyBtn}
                onPress={() => { if (!profile) { goToSignIn(`/shift-detail?id=${id}`); return; } Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); setShowMessage(true); }}
                activeOpacity={0.85}
              >
                <FontAwesome5 name="paper-plane" size={14} color="#fff" solid />
                <Text style={styles.applyBtnText}>Apply for this shift</Text>
              </TouchableOpacity>
            )
          )}
        </View>

        <View style={{ height: 60 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Accepted / check-in status block ─────────────────────────────────────────

// Check-in opens 2 hours before the shift start.
const CHECKIN_LEAD_MS = 2 * 60 * 60 * 1000;

function AcceptedBlock({ cis, worked, startAt, onCheckIn, onCheckOut, busy }: {
  cis: CheckInStatus;
  worked: { label: string; actual: boolean } | null;
  startAt: string;
  onCheckIn: () => void;
  onCheckOut: () => void;
  busy: boolean;
}) {
  const configs = {
    employer_confirmed: {
      icon: 'check-double', iconColor: colors.success, bg: colors.successLight,
      title: 'Shift complete ✓', sub: 'The employer has confirmed this shift as done.',
    },
    checked_out: {
      icon: 'hourglass-half', iconColor: colors.warning, bg: colors.warningLight,
      title: 'Awaiting confirmation', sub: "You've finished — the employer will confirm shortly.",
    },
    checked_in: {
      icon: 'map-marker-alt', iconColor: S.color, bg: S.light,
      title: "You're checked in", sub: "You're on the clock. Tap below when you've finished.",
    },
  };

  // Currently checked in → offer "I've finished this shift".
  if (cis === 'checked_in') {
    const cfg = configs.checked_in;
    return (
      <View style={{ gap: 10 }}>
        <View style={[styles.statusCard, { backgroundColor: cfg.bg }]}>
          <FontAwesome5 name={cfg.icon as any} size={20} color={cfg.iconColor} solid />
          <View style={{ flex: 1 }}>
            <Text style={[styles.statusTitle, { color: cfg.iconColor }]}>{cfg.title}</Text>
            <Text style={styles.statusSub}>{cfg.sub}</Text>
          </View>
        </View>
        <TouchableOpacity
          style={[styles.checkActionBtn, { backgroundColor: colors.warning }, busy && { opacity: 0.7 }]}
          onPress={onCheckOut}
          disabled={busy}
          activeOpacity={0.85}
        >
          <FontAwesome5 name="flag-checkered" size={14} color="#fff" solid />
          <Text style={styles.checkActionText}>I've finished this shift</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Checked out / employer confirmed → read-only status (+ worked hours).
  if (cis && cis in configs) {
    const cfg = configs[cis as keyof typeof configs];
    const showHours = worked && (cis === 'checked_out' || cis === 'employer_confirmed');
    return (
      <View style={[styles.statusCard, { backgroundColor: cfg.bg }]}>
        <FontAwesome5 name={cfg.icon as any} size={20} color={cfg.iconColor} solid />
        <View style={{ flex: 1 }}>
          <Text style={[styles.statusTitle, { color: cfg.iconColor }]}>{cfg.title}</Text>
          <Text style={styles.statusSub}>{cfg.sub}</Text>
          {showHours ? <Text style={styles.statusHours}>{worked!.label} worked{worked!.actual ? '' : ' (scheduled)'}</Text> : null}
        </View>
      </View>
    );
  }

  // null — confirmed but not yet checked in.
  const checkinOpen = Date.now() >= new Date(startAt).getTime() - CHECKIN_LEAD_MS;
  return (
    <View style={{ gap: 10 }}>
      <View style={[styles.statusCard, { backgroundColor: colors.jobsLight }]}>
        <FontAwesome5 name="check-circle" size={20} color={colors.jobs} solid />
        <View style={{ flex: 1 }}>
          <Text style={[styles.statusTitle, { color: colors.jobs }]}>You're confirmed!</Text>
          <Text style={styles.statusSub}>The employer accepted your application.</Text>
        </View>
      </View>
      {checkinOpen ? (
        <TouchableOpacity
          style={[styles.checkActionBtn, { backgroundColor: S.color }, busy && { opacity: 0.7 }]}
          onPress={onCheckIn}
          disabled={busy}
          activeOpacity={0.85}
        >
          <FontAwesome5 name="sign-in-alt" size={14} color="#fff" solid />
          <Text style={styles.checkActionText}>Check in to this shift</Text>
        </TouchableOpacity>
      ) : (
        <View style={styles.checkinPrompt}>
          <FontAwesome5 name="clock" size={12} color={colors.textMuted} />
          <Text style={[styles.checkinPromptText, { color: colors.textMuted }]}>Check-in opens 2 hours before the shift starts</Text>
        </View>
      )}
    </View>
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

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: colors.screenBackground },
  scroll:  { flex: 1, backgroundColor: colors.screenBackground },
  content: { paddingTop: spacing.sm, paddingBottom: 40 },
  center:  { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errorText: { color: colors.textMuted, fontSize: fontSize.md },

  // Header (matches job/[id])
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingTop: spacing.sm },
  backPill: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 999, backgroundColor: S.color + '14' },
  backPillText: { color: S.color, fontSize: fontSize.sm, fontWeight: '800' },
  head: { flexDirection: 'row', gap: 14, alignItems: 'flex-start', paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  logo: { width: 56, height: 56, borderRadius: 15, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  logoImg: { width: 56, height: 56 },
  headBadges: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  title: { fontSize: 24, fontWeight: '900', color: colors.textPrimary, letterSpacing: -0.4 },
  org: { fontSize: fontSize.sm, color: colors.textSecondary, fontWeight: '600', marginTop: 4 },
  payCard: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: spacing.lg, marginTop: spacing.md, padding: spacing.md, borderRadius: radius.md },
  payText: { fontSize: fontSize.lg, fontWeight: '900' },
  spots: { fontSize: fontSize.xs, color: colors.textMuted, marginLeft: 'auto', fontWeight: '700' },
  factGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginHorizontal: spacing.lg, marginTop: spacing.md },
  fact: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999 },
  factText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary },

  // Hero — single cohesive navy block
  hero: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
    gap: 12,
    borderBottomWidth: 3,
  },
  backBtn:  { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' },
  backText: { fontSize: fontSize.sm, fontWeight: '700' },

  heroBadges:  { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  featuredBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#FEF3C7', paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full },
  featuredText:  { fontSize: 10, fontWeight: '800', color: colors.shifts },
  urgencyBadge:  { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.full },
  urgencyText:   { fontSize: 11, fontWeight: '800' },
  categoryText:  { color: 'rgba(255,255,255,0.5)', fontSize: fontSize.xs, fontWeight: '600' },

  heroTitle: { color: '#fff', fontSize: 26, fontWeight: '900', lineHeight: 30 },

  heroStats: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: radius.lg, paddingVertical: 12, paddingHorizontal: spacing.md,
    gap: 0,
  },
  heroStat:        { flex: 1, alignItems: 'center', gap: 2 },
  heroStatValue:   { fontSize: fontSize.md, fontWeight: '900' },
  heroStatLabel:   { fontSize: 10, color: 'rgba(255,255,255,0.45)', fontWeight: '600' },
  heroStatDivider: { width: 1, height: 28, backgroundColor: 'rgba(255,255,255,0.12)' },

  employerRow:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  employerAvatar:{ width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  employerName:  { color: 'rgba(255,255,255,0.65)', fontSize: fontSize.sm, fontWeight: '600' },
  verifiedBadge: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  verifiedText:  { fontSize: 10, fontWeight: '700' },

  // When & where card
  card: {
    backgroundColor: '#fff',
    marginHorizontal: spacing.md, marginTop: spacing.md,
    borderRadius: radius.xl,
    borderWidth: 1, borderColor: colors.border,
    overflow: 'hidden',
  },
  cardRow:       { flexDirection: 'row', alignItems: 'center', gap: 12, padding: spacing.md },
  cardDivider:   { height: 1, backgroundColor: colors.border, marginHorizontal: spacing.md },
  cardIcon:      { width: 34, height: 34, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  cardRowLabel:  { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600', marginBottom: 2 },
  cardRowValue:  { fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: '700', lineHeight: 20 },

  // Sections
  section:      { marginHorizontal: spacing.md, marginTop: spacing.lg },
  sectionTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary, marginBottom: 4 },
  sectionHint:  { fontSize: fontSize.xs, color: colors.textMuted, marginBottom: 12 },
  descriptionText: { fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 22 },

  reqChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  reqChip:  { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: S.light, paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.full, borderWidth: 1, borderColor: S.color + '33' },
  reqChipText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textPrimary },

  // CTA area
  ctaSection: { marginHorizontal: spacing.md, marginTop: spacing.xl },

  applyBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 10, height: 54, borderRadius: radius.lg, backgroundColor: S.color,
  },
  applyBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },

  // Message
  messageCard: {
    backgroundColor: '#fff', borderRadius: radius.xl,
    borderWidth: 1, borderColor: colors.border, padding: spacing.md, gap: 12,
  },
  messageLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  messageInput: {
    height: 90, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, padding: 10,
    fontSize: fontSize.sm, color: colors.textPrimary, textAlignVertical: 'top',
  },
  messageActions: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  skipBtn:  { flex: 1, alignItems: 'center', paddingVertical: 10 },
  skipText: { fontSize: fontSize.sm, color: colors.textMuted, fontWeight: '600' },

  // Applied state
  appliedCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: S.light, borderRadius: radius.xl,
    borderWidth: 1.5, borderColor: S.color + '44', padding: spacing.md,
  },
  appliedIconWrap: { width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  appliedTitle: { fontSize: fontSize.sm, fontWeight: '800' },
  appliedSub:   { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2, lineHeight: 16 },
  withdrawBtn:  { alignItems: 'center', paddingVertical: 6 },
  withdrawText: { fontSize: fontSize.sm, color: colors.textMuted, fontWeight: '600', textDecorationLine: 'underline' },

  // Status (accepted / check-in states)
  statusCard: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    padding: spacing.md, borderRadius: radius.xl,
  },
  statusTitle: { fontSize: fontSize.sm, fontWeight: '800', marginBottom: 2 },
  statusSub:   { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 16 },
  statusHours: { fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: '800', marginTop: 4 },
  checkinPrompt: { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center', paddingVertical: 8 },
  checkinPromptText: { fontSize: fontSize.sm, fontWeight: '700' },
  checkActionBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 10, height: 54, borderRadius: radius.lg,
  },
  checkActionText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },

  // Full
  fullCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', borderRadius: radius.xl,
    borderWidth: 1, borderColor: colors.border, padding: spacing.md,
  },
  fullTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  fullSub:   { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
});
