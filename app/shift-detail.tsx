import React, { useEffect, useState, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, ActivityIndicator, Alert, Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import {
  fetchShift, fetchMyApplication, submitInterest, withdrawApplication,
  formatPay, formatDuration, formatShiftDate, URGENCY_CONFIG, CATEGORY_LABELS,
  shiftDisplayBusiness,
  type Shift, type ShiftApplication, type CheckInStatus,
} from '@/lib/shifts-api';

const S = SECTIONS.shifts;

export default function ShiftDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router  = useRouter();
  const { profile } = useAuth();

  const [shift, setShift]             = useState<Shift | null>(null);
  const [application, setApplication] = useState<ShiftApplication | null>(null);
  const [loading, setLoading]         = useState(true);
  const [submitting, setSubmitting]   = useState(false);
  const [showMessage, setShowMessage] = useState(false);
  const [message, setMessage]         = useState('');

  const successAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!id) return;
    Promise.all([
      fetchShift(id),
      profile ? fetchMyApplication(id, profile.id) : Promise.resolve(null),
    ]).then(([s, app]) => {
      setShift(s);
      setApplication(app);
    }).catch(() => Alert.alert('Error', 'Could not load shift.'))
      .finally(() => setLoading(false));
  }, [id, profile]);

  const handleSubmitInterest = async () => {
    if (!profile || !shift) return;
    setSubmitting(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await submitInterest(shift.id, profile.id, message || undefined);
      const app = await fetchMyApplication(shift.id, profile.id);
      setApplication(app);
      setShowMessage(false);
      Animated.spring(successAnim, { toValue: 1, friction: 5, useNativeDriver: true }).start();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleWithdraw = () => {
    Alert.alert('Withdraw interest?', 'You can re-apply at any time.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Withdraw', style: 'destructive', onPress: async () => {
        if (!application) return;
        await withdrawApplication(application.id, shift?.id, application.status === 'accepted');
        setApplication(null);
        successAnim.setValue(0);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }},
    ]);
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

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >

        {/* ── Hero (back button + title live together in one block) ── */}
        <View style={[styles.hero, { borderBottomColor: S.color }]}>

          {/* Back */}
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
            <FontAwesome5 name="chevron-left" size={13} color={S.color} />
            <Text style={[styles.backText, { color: S.color }]}>Back</Text>
          </TouchableOpacity>

          {/* Badges row */}
          <View style={styles.heroBadges}>
            {isBoosted && (
              <View style={styles.featuredBadge}>
                <FontAwesome5 name="bolt" size={9} color={colors.shifts} solid />
                <Text style={styles.featuredText}>Featured</Text>
              </View>
            )}
            <View style={[styles.urgencyBadge, { backgroundColor: urgency.bg }]}>
              <Text style={[styles.urgencyText, { color: urgency.color }]}>{urgency.label}</Text>
            </View>
            <Text style={styles.categoryText}>
              {CATEGORY_LABELS[shift.category] ?? shift.category}
            </Text>
          </View>

          {/* Title */}
          <Text style={styles.heroTitle}>{shift.title}</Text>

          {/* Pay + spots — hero highlight strip */}
          <View style={styles.heroStats}>
            <View style={styles.heroStat}>
              <Text style={[styles.heroStatValue, { color: S.color }]}>
                {formatPay(shift.pay_type, shift.pay_amount)}
              </Text>
              <Text style={styles.heroStatLabel}>pay</Text>
            </View>
            <View style={styles.heroStatDivider} />
            <View style={styles.heroStat}>
              <Text style={[styles.heroStatValue, { color: '#fff' }]}>
                {formatDuration(shift.start_at, shift.end_at)}
              </Text>
              <Text style={styles.heroStatLabel}>duration</Text>
            </View>
            <View style={styles.heroStatDivider} />
            <View style={styles.heroStat}>
              <Text style={[styles.heroStatValue, { color: spotsLeft > 0 ? '#fff' : colors.error }]}>
                {spotsLeft}/{shift.positions_total}
              </Text>
              <Text style={styles.heroStatLabel}>spots left</Text>
            </View>
          </View>

          {/* Employer / linked Local business */}
          {(() => {
            const biz = shiftDisplayBusiness(shift);
            return (
              <View style={styles.employerRow}>
                <View style={[styles.employerAvatar, { backgroundColor: S.color + '22' }]}>
                  <FontAwesome5 name="building" size={11} color={S.color} />
                </View>
                <Text style={styles.employerName}>{biz.name}</Text>
                {biz.is_verified && (
                  <View style={styles.verifiedBadge}>
                    <FontAwesome5 name="check-circle" size={11} color={S.color} solid />
                    <Text style={[styles.verifiedText, { color: S.color }]}>Verified</Text>
                  </View>
                )}
              </View>
            );
          })()}
        </View>

        {/* ── When & where card ── */}
        <View style={styles.card}>
          <View style={styles.cardRow}>
            <View style={[styles.cardIcon, { backgroundColor: S.color + '18' }]}>
              <FontAwesome5 name="calendar-alt" size={13} color={S.color} solid />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardRowLabel}>Date & time</Text>
              <Text style={styles.cardRowValue}>{formatShiftDate(shift.start_at)}</Text>
            </View>
          </View>
          <View style={styles.cardDivider} />
          <View style={styles.cardRow}>
            <View style={[styles.cardIcon, { backgroundColor: S.color + '18' }]}>
              <FontAwesome5 name="map-marker-alt" size={13} color={S.color} solid />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardRowLabel}>Location</Text>
              <Text style={styles.cardRowValue}>{shift.location_text}</Text>
            </View>
          </View>
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
            <View style={styles.ownShiftCard}>
              <View style={[styles.ownShiftIconWrap, { backgroundColor: S.color + '18' }]}>
                <FontAwesome5 name="briefcase" size={16} color={S.color} solid />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[styles.ownShiftTitle, { color: S.color }]}>You posted this shift</Text>
                <Text style={styles.ownShiftSub}>View and manage applications below</Text>
              </View>
              <TouchableOpacity
                style={[styles.ownShiftBtn, { backgroundColor: S.color }]}
                onPress={() => router.push('/my-posted-shifts')}
                activeOpacity={0.85}
              >
                <Text style={styles.ownShiftBtnText}>Manage →</Text>
              </TouchableOpacity>
            </View>
          ) : spotsLeft === 0 && !hasApplied ? (
            <View style={styles.fullCard}>
              <FontAwesome5 name="user-slash" size={18} color={colors.textMuted} />
              <View style={{ flex: 1 }}>
                <Text style={styles.fullTitle}>This shift is now full</Text>
                <Text style={styles.fullSub}>All positions have been filled.</Text>
              </View>
            </View>
          ) : isAccepted ? (
            <AcceptedBlock cis={application?.check_in_status ?? null} />
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
                  <Text style={[styles.appliedTitle, { color: S.color }]}>Interest submitted</Text>
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
                      : <Text style={styles.applyBtnText}>Submit interest</Text>
                    }
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <TouchableOpacity
                style={styles.applyBtn}
                onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); setShowMessage(true); }}
                activeOpacity={0.85}
              >
                <FontAwesome5 name="paper-plane" size={14} color="#fff" solid />
                <Text style={styles.applyBtnText}>Submit interest</Text>
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

function AcceptedBlock({ cis }: { cis: CheckInStatus }) {
  const router = useRouter();

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
      title: "You're checked in", sub: 'Manage your shift from My Applications.',
    },
  };

  if (cis && cis in configs) {
    const cfg = configs[cis as keyof typeof configs];
    return (
      <View style={[styles.statusCard, { backgroundColor: cfg.bg }]}>
        <FontAwesome5 name={cfg.icon as any} size={20} color={cfg.iconColor} solid />
        <View style={{ flex: 1 }}>
          <Text style={[styles.statusTitle, { color: cfg.iconColor }]}>{cfg.title}</Text>
          <Text style={styles.statusSub}>{cfg.sub}</Text>
        </View>
      </View>
    );
  }

  // null — confirmed but not yet checked in
  return (
    <View style={{ gap: 10 }}>
      <View style={[styles.statusCard, { backgroundColor: colors.jobsLight }]}>
        <FontAwesome5 name="check-circle" size={20} color={colors.jobs} solid />
        <View style={{ flex: 1 }}>
          <Text style={[styles.statusTitle, { color: colors.jobs }]}>You're confirmed!</Text>
          <Text style={styles.statusSub}>The employer accepted your application.</Text>
        </View>
      </View>
      <TouchableOpacity
        style={styles.checkinPrompt}
        onPress={() => router.push('/my-shift-applications')}
        activeOpacity={0.8}
      >
        <FontAwesome5 name="sign-in-alt" size={12} color={S.color} />
        <Text style={[styles.checkinPromptText, { color: S.color }]}>Check in when your shift starts →</Text>
      </TouchableOpacity>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: colors.navy },
  scroll:  { flex: 1, backgroundColor: colors.screenBackground },
  content: { paddingBottom: 40 },
  center:  { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errorText: { color: colors.textMuted, fontSize: fontSize.md },

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
  checkinPrompt: { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center', paddingVertical: 8 },
  checkinPromptText: { fontSize: fontSize.sm, fontWeight: '700' },

  // Own shift
  ownShiftCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', borderRadius: radius.xl,
    borderWidth: 1.5, borderColor: S.color + '33', padding: spacing.md,
  },
  ownShiftIconWrap: { width: 44, height: 44, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' },
  ownShiftTitle:    { fontSize: fontSize.sm, fontWeight: '800' },
  ownShiftSub:      { fontSize: fontSize.xs, color: colors.textMuted },
  ownShiftBtn:      { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.full },
  ownShiftBtnText:  { color: '#fff', fontSize: fontSize.xs, fontWeight: '800' },

  // Full
  fullCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', borderRadius: radius.xl,
    borderWidth: 1, borderColor: colors.border, padding: spacing.md,
  },
  fullTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  fullSub:   { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
});
