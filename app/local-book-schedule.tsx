/**
 * app/local-book-schedule.tsx
 *
 * Business-side: weekly recurring availability + one-off overrides (one-day
 * closures, holiday opens, and last-min slots that get pushed to the feed).
 *
 * Phase 1 of OneShetland Book.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, Modal, Platform, KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import DateTimePicker from '@react-native-community/datetimepicker';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import {
  fetchAvailabilityRules, createAvailabilityRule, deleteAvailabilityRule,
  fetchUpcomingOverrides, createOverride, deleteOverride,
  DAYS_OF_WEEK, formatTime,
  type BookAvailabilityRule, type BookSlotOverride, type BookOverrideType,
} from '@/lib/book-api';
import { useAlert } from '@/components/BrandedAlert';

const S = SECTIONS.local;

export default function BookScheduleScreen() {
  const router = useRouter();
  const { alert } = useAlert();
  const { businessId } = useLocalSearchParams<{ businessId: string }>();

  const [rules, setRules]         = useState<BookAvailabilityRule[]>([]);
  const [overrides, setOverrides] = useState<BookSlotOverride[]>([]);
  const [loading, setLoading]     = useState(true);

  const [showRuleModal, setShowRuleModal]         = useState(false);
  const [showOverrideModal, setShowOverrideModal] = useState(false);
  const [overrideMode, setOverrideMode] = useState<BookOverrideType>('open');

  const load = useCallback(async () => {
    if (!businessId) return;
    try {
      const [r, o] = await Promise.all([
        fetchAvailabilityRules(businessId),
        fetchUpcomingOverrides(businessId),
      ]);
      setRules(r);
      setOverrides(o);
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => { load(); }, [load]);

  const handleDeleteRule = (rule: BookAvailabilityRule) => {
    const day = DAYS_OF_WEEK[rule.day_of_week].long;
    alert({
      title:   `Remove ${day} ${formatTime(rule.start_time)}–${formatTime(rule.end_time)}?`,
      message: 'Existing bookings on this slot stay confirmed.',
      icon:    'trash',
      accent:  colors.error,
      actions: [
        { label: 'Cancel', style: 'cancel' },
        { label: 'Remove', style: 'destructive', onPress: async () => {
          await deleteAvailabilityRule(rule.id);
          Haptics.selectionAsync();
          load();
        }},
      ],
    });
  };

  const handleDeleteOverride = (ov: BookSlotOverride) => {
    alert({
      title:   'Remove this override?',
      message: 'This single one-off entry will be deleted.',
      icon:    'trash',
      accent:  colors.error,
      actions: [
        { label: 'Cancel', style: 'cancel' },
        { label: 'Remove', style: 'destructive', onPress: async () => {
          await deleteOverride(ov.id);
          Haptics.selectionAsync();
          load();
        }},
      ],
    });
  };

  const startOverride = (type: BookOverrideType) => {
    setOverrideMode(type);
    setShowOverrideModal(true);
  };

  if (!businessId) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}><Text style={styles.dim}>Missing business ID.</Text></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Schedule</Text>
        <View style={{ width: 70 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>

          {/* ── Weekly recurring schedule ── */}
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.sectionTitle}>Weekly hours</Text>
                <Text style={styles.sectionSub}>The blocks of time that repeat every week.</Text>
              </View>
              <TouchableOpacity
                style={[styles.sectionAddBtn, { backgroundColor: S.color }]}
                onPress={() => setShowRuleModal(true)}
                hitSlop={6}
              >
                <FontAwesome5 name="plus" size={11} color="#fff" />
              </TouchableOpacity>
            </View>

            {rules.length === 0 ? (
              <View style={styles.empty}>
                <Text style={styles.emptyText}>
                  No weekly hours set yet. Add a block — e.g. <Text style={{ fontWeight: '800' }}>Tuesday 09:00–17:30</Text>.
                </Text>
              </View>
            ) : (
              <View style={styles.ruleList}>
                {DAYS_OF_WEEK.map(d => {
                  const dayRules = rules.filter(r => r.day_of_week === d.idx);
                  if (dayRules.length === 0) return null;
                  return (
                    <View key={d.idx} style={styles.dayRow}>
                      <Text style={styles.dayLabel}>{d.short}</Text>
                      <View style={styles.dayBlocks}>
                        {dayRules.map(r => (
                          <TouchableOpacity
                            key={r.id}
                            style={[styles.dayBlock, { borderColor: S.color }]}
                            onLongPress={() => handleDeleteRule(r)}
                            delayLongPress={300}
                          >
                            <Text style={[styles.dayBlockTime, { color: S.color }]}>
                              {formatTime(r.start_time)}–{formatTime(r.end_time)}
                            </Text>
                            <Text style={styles.dayBlockInterval}>every {r.slot_interval_minutes}m</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </View>
                  );
                })}
                <Text style={styles.helperText}>Long-press a block to remove it.</Text>
              </View>
            )}
          </View>

          {/* ── One-off overrides ── */}
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.sectionTitle}>One-off changes</Text>
                <Text style={styles.sectionSub}>Holidays, sick days, or last-min slot drops.</Text>
              </View>
            </View>

            {/* Quick-add buttons */}
            <View style={styles.quickAddRow}>
              <TouchableOpacity
                style={[styles.quickAddBtn, { borderColor: '#10B981' }]}
                onPress={() => startOverride('last_min')}
                activeOpacity={0.85}
              >
                <FontAwesome5 name="bolt" size={11} color="#10B981" solid />
                <Text style={[styles.quickAddText, { color: '#10B981' }]}>Last-min slot</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.quickAddBtn, { borderColor: colors.textMuted }]}
                onPress={() => startOverride('open')}
                activeOpacity={0.85}
              >
                <FontAwesome5 name="plus-circle" size={11} color={colors.textMuted} />
                <Text style={[styles.quickAddText, { color: colors.textPrimary }]}>Add open hours</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.quickAddBtn, { borderColor: colors.error }]}
                onPress={() => startOverride('closed')}
                activeOpacity={0.85}
              >
                <FontAwesome5 name="ban" size={11} color={colors.error} />
                <Text style={[styles.quickAddText, { color: colors.error }]}>Closure</Text>
              </TouchableOpacity>
            </View>

            {overrides.length === 0 ? (
              <View style={styles.empty}>
                <Text style={styles.emptyText}>No upcoming one-offs.</Text>
              </View>
            ) : (
              <View style={{ gap: 8, marginTop: 4 }}>
                {overrides.map(ov => (
                  <View key={ov.id} style={styles.overrideCard}>
                    <View style={[styles.overrideIcon, { backgroundColor: overrideBg(ov.type) }]}>
                      <FontAwesome5
                        name={ov.type === 'closed' ? 'ban' : ov.type === 'last_min' ? 'bolt' : 'plus-circle'}
                        size={11} color={overrideColor(ov.type)}
                        solid={ov.type === 'last_min'}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.overrideTitle}>
                        {overrideLabel(ov.type)}
                      </Text>
                      <Text style={styles.overrideSub}>{formatRange(ov.starts_at, ov.ends_at)}</Text>
                      {ov.notes ? <Text style={styles.overrideNotes} numberOfLines={2}>{ov.notes}</Text> : null}
                    </View>
                    <TouchableOpacity onPress={() => handleDeleteOverride(ov)} hitSlop={10}>
                      <FontAwesome5 name="times" size={12} color={colors.textMuted} />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}
          </View>

          <View style={{ height: 40 }} />
        </ScrollView>
      )}

      <WeeklyRuleEditor
        visible={showRuleModal}
        businessId={businessId}
        onClose={() => setShowRuleModal(false)}
        onSaved={() => { setShowRuleModal(false); load(); }}
      />

      <OverrideEditor
        visible={showOverrideModal}
        businessId={businessId}
        type={overrideMode}
        onClose={() => setShowOverrideModal(false)}
        onSaved={() => { setShowOverrideModal(false); load(); }}
      />
    </SafeAreaView>
  );
}

// ── Weekly rule editor ───────────────────────────────────────────────────────

function WeeklyRuleEditor({
  visible, businessId, onClose, onSaved,
}: {
  visible: boolean;
  businessId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [days, setDays]         = useState<number[]>([1, 2, 3, 4, 5]); // Mon–Fri default
  const [startHM, setStartHM]   = useState({ h: 9,  m: 0 });
  const [endHM, setEndHM]       = useState({ h: 17, m: 0 });
  const [interval, setInterval] = useState('30');
  const [saving, setSaving]     = useState(false);

  useEffect(() => {
    if (visible) {
      setDays([1, 2, 3, 4, 5]);
      setStartHM({ h: 9,  m: 0 });
      setEndHM  ({ h: 17, m: 0 });
      setInterval('30');
    }
  }, [visible]);

  const toggleDay = (idx: number) => {
    Haptics.selectionAsync();
    setDays(d => d.includes(idx) ? d.filter(x => x !== idx) : [...d, idx].sort());
  };

  const save = async () => {
    if (days.length === 0) return Alert.alert('Pick at least one day');
    const startMins = startHM.h * 60 + startHM.m;
    const endMins   = endHM.h   * 60 + endHM.m;
    if (endMins <= startMins) return Alert.alert('End must be after start');
    const ivl = parseInt(interval);
    if (!ivl || ivl < 5 || ivl > 240) return Alert.alert('Slot interval must be 5–240 minutes');

    setSaving(true);
    try {
      const startStr = `${String(startHM.h).padStart(2, '0')}:${String(startHM.m).padStart(2, '0')}`;
      const endStr   = `${String(endHM.h).padStart(2, '0')}:${String(endHM.m).padStart(2, '0')}`;
      await Promise.all(days.map(d =>
        createAvailabilityRule(businessId, {
          day_of_week:           d,
          start_time:            startStr,
          end_time:              endStr,
          slot_interval_minutes: ivl,
        }),
      ));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onSaved();
    } catch (e: any) {
      Alert.alert('Save failed', e?.message ?? 'Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={modalStyles.overlay}>
          <View style={modalStyles.sheet}>
            <View style={modalStyles.handle} />
            <Text style={modalStyles.title}>Weekly hours block</Text>

            <Text style={modalStyles.label}>Days</Text>
            <View style={modalStyles.dayPickerRow}>
              {DAYS_OF_WEEK.map(d => (
                <TouchableOpacity
                  key={d.idx}
                  style={[modalStyles.dayChip, days.includes(d.idx) && { backgroundColor: S.color, borderColor: S.color }]}
                  onPress={() => toggleDay(d.idx)}
                >
                  <Text style={[modalStyles.dayChipText, days.includes(d.idx) && { color: '#fff' }]}>
                    {d.short}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={modalStyles.row2}>
              <View style={{ flex: 1 }}>
                <Text style={modalStyles.label}>Start</Text>
                <TimePickerInline value={startHM} onChange={setStartHM} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={modalStyles.label}>End</Text>
                <TimePickerInline value={endHM} onChange={setEndHM} />
              </View>
            </View>

            <Text style={modalStyles.label}>Slot interval (mins)</Text>
            <View style={modalStyles.intervalRow}>
              {[15, 30, 45, 60].map(n => (
                <TouchableOpacity
                  key={n}
                  style={[modalStyles.intervalChip, interval === String(n) && { backgroundColor: S.color, borderColor: S.color }]}
                  onPress={() => setInterval(String(n))}
                >
                  <Text style={[modalStyles.intervalChipText, interval === String(n) && { color: '#fff' }]}>
                    {n}m
                  </Text>
                </TouchableOpacity>
              ))}
              <TextInput
                style={[modalStyles.intervalCustom, ![15, 30, 45, 60].includes(parseInt(interval)) && { borderColor: S.color }]}
                value={interval}
                onChangeText={setInterval}
                keyboardType="number-pad"
                placeholder="custom"
                placeholderTextColor={colors.textLight}
                maxLength={3}
              />
            </View>

            <View style={modalStyles.actions}>
              <TouchableOpacity onPress={onClose} style={modalStyles.cancelBtn}>
                <Text style={modalStyles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[modalStyles.saveBtn, { backgroundColor: S.color }, saving && { opacity: 0.7 }]}
                onPress={save}
                disabled={saving}
                activeOpacity={0.85}
              >
                {saving
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={modalStyles.saveText}>Add to schedule</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Override editor (one-off open / closed / last-min) ───────────────────────

function OverrideEditor({
  visible, businessId, type, onClose, onSaved,
}: {
  visible: boolean;
  businessId: string;
  type: BookOverrideType;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [startsAt, setStartsAt] = useState<Date>(() => roundToNextHalf(new Date(Date.now() + 60 * 60_000)));
  const [endsAt, setEndsAt]     = useState<Date>(() => roundToNextHalf(new Date(Date.now() + 2 * 60 * 60_000)));
  const [notes, setNotes]       = useState('');
  const [saving, setSaving]     = useState(false);
  const [showStart, setShowStart] = useState(false);
  const [showEnd, setShowEnd]     = useState(false);

  useEffect(() => {
    if (visible) {
      const base = type === 'last_min' ? 30 : 60;
      setStartsAt(roundToNextHalf(new Date(Date.now() + base * 60_000)));
      setEndsAt  (roundToNextHalf(new Date(Date.now() + (base + 60) * 60_000)));
      setNotes('');
    }
  }, [visible, type]);

  const save = async () => {
    if (endsAt <= startsAt) return Alert.alert('End must be after start');
    setSaving(true);
    try {
      await createOverride(businessId, {
        starts_at: startsAt.toISOString(),
        ends_at:   endsAt.toISOString(),
        type,
        notes:     notes.trim() || null,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onSaved();
    } catch (e: any) {
      Alert.alert('Save failed', e?.message ?? 'Try again.');
    } finally {
      setSaving(false);
    }
  };

  const titleMap: Record<BookOverrideType, string> = {
    open:     'Add open hours',
    closed:   'Mark a closure',
    last_min: 'Last-min slot',
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={modalStyles.overlay}>
          <View style={modalStyles.sheet}>
            <View style={modalStyles.handle} />
            <Text style={modalStyles.title}>{titleMap[type]}</Text>
            <Text style={modalStyles.subtitle}>
              {type === 'last_min'
                ? 'Push a fresh opening to customers right now. Great for filling a no-show.'
                : type === 'closed'
                ? 'Block out a date range — bank holiday, sick day, family event.'
                : 'Open extra hours outside your normal weekly schedule.'}
            </Text>

            <Text style={modalStyles.label}>From</Text>
            <TouchableOpacity style={modalStyles.dateBtn} onPress={() => setShowStart(true)}>
              <FontAwesome5 name="calendar-alt" size={12} color={colors.textMuted} />
              <Text style={modalStyles.dateBtnText}>{formatDateTime(startsAt)}</Text>
            </TouchableOpacity>
            {showStart && (
              <DateTimePicker
                value={startsAt}
                mode="datetime"
                display={Platform.OS === 'ios' ? 'inline' : 'default'}
                onChange={(_, d) => { setShowStart(Platform.OS === 'ios'); if (d) setStartsAt(d); }}
                minimumDate={new Date()}
              />
            )}

            <Text style={modalStyles.label}>To</Text>
            <TouchableOpacity style={modalStyles.dateBtn} onPress={() => setShowEnd(true)}>
              <FontAwesome5 name="calendar-alt" size={12} color={colors.textMuted} />
              <Text style={modalStyles.dateBtnText}>{formatDateTime(endsAt)}</Text>
            </TouchableOpacity>
            {showEnd && (
              <DateTimePicker
                value={endsAt}
                mode="datetime"
                display={Platform.OS === 'ios' ? 'inline' : 'default'}
                onChange={(_, d) => { setShowEnd(Platform.OS === 'ios'); if (d) setEndsAt(d); }}
                minimumDate={startsAt}
              />
            )}

            <Text style={modalStyles.label}>Notes (optional)</Text>
            <TextInput
              style={[modalStyles.input, { height: 60, textAlignVertical: 'top' }]}
              value={notes} onChangeText={setNotes}
              placeholder={type === 'last_min'
                ? 'e.g. cancellation just freed up'
                : type === 'closed'
                ? 'e.g. Up Helly Aa'
                : 'e.g. extra Sunday hours'}
              placeholderTextColor={colors.textLight}
              multiline
              maxLength={140}
            />

            <View style={modalStyles.actions}>
              <TouchableOpacity onPress={onClose} style={modalStyles.cancelBtn}>
                <Text style={modalStyles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[modalStyles.saveBtn, { backgroundColor: S.color }, saving && { opacity: 0.7 }]}
                onPress={save}
                disabled={saving}
                activeOpacity={0.85}
              >
                {saving
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={modalStyles.saveText}>Save</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Inline time picker (hour + minute steppers) ──────────────────────────────

function TimePickerInline({
  value, onChange,
}: {
  value: { h: number; m: number };
  onChange: (v: { h: number; m: number }) => void;
}) {
  const bump = (field: 'h' | 'm', delta: number) => {
    Haptics.selectionAsync();
    if (field === 'h') onChange({ ...value, h: (value.h + delta + 24) % 24 });
    else                onChange({ ...value, m: (value.m + delta + 60) % 60 });
  };

  return (
    <View style={timeStyles.row}>
      <View style={timeStyles.col}>
        <TouchableOpacity onPress={() => bump('h', 1)} hitSlop={8}>
          <FontAwesome5 name="chevron-up" size={11} color={colors.textMuted} />
        </TouchableOpacity>
        <Text style={timeStyles.num}>{String(value.h).padStart(2, '0')}</Text>
        <TouchableOpacity onPress={() => bump('h', -1)} hitSlop={8}>
          <FontAwesome5 name="chevron-down" size={11} color={colors.textMuted} />
        </TouchableOpacity>
      </View>
      <Text style={timeStyles.sep}>:</Text>
      <View style={timeStyles.col}>
        <TouchableOpacity onPress={() => bump('m', 15)} hitSlop={8}>
          <FontAwesome5 name="chevron-up" size={11} color={colors.textMuted} />
        </TouchableOpacity>
        <Text style={timeStyles.num}>{String(value.m).padStart(2, '0')}</Text>
        <TouchableOpacity onPress={() => bump('m', -15)} hitSlop={8}>
          <FontAwesome5 name="chevron-down" size={11} color={colors.textMuted} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function overrideLabel(t: BookOverrideType): string {
  return t === 'last_min' ? 'Last-min slot' : t === 'closed' ? 'Closure' : 'Extra open hours';
}
function overrideColor(t: BookOverrideType): string {
  return t === 'last_min' ? '#10B981' : t === 'closed' ? colors.error : colors.textPrimary;
}
function overrideBg(t: BookOverrideType): string {
  return t === 'last_min' ? '#10B98120' : t === 'closed' ? colors.error + '20' : colors.border;
}

function formatDateTime(d: Date): string {
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
       + ' · ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function formatRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const sameDay = s.toDateString() === e.toDateString();
  if (sameDay) {
    return s.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
         + ' · ' + s.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
         + '–'   + e.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return formatDateTime(s) + '  →  ' + formatDateTime(e);
}
function roundToNextHalf(d: Date): Date {
  const out = new Date(d);
  out.setSeconds(0, 0);
  const m = out.getMinutes();
  out.setMinutes(m < 30 ? 30 : 0);
  if (m >= 30) out.setHours(out.getHours() + 1);
  return out;
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: colors.screenBackground },
  scroll:  { flex: 1 },
  content: { padding: spacing.md, gap: 16 },
  center:  { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  dim:     { color: colors.textMuted },

  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
    borderBottomWidth: 2,
  },
  backBtn:     { flexDirection: 'row', alignItems: 'center', gap: 8, width: 70 },
  backText:    { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '800', flex: 1, textAlign: 'center' },

  section:      { backgroundColor: '#fff', borderRadius: radius.lg, padding: spacing.md, borderWidth: 1, borderColor: colors.border, gap: 12 },
  sectionHeader:{ flexDirection: 'row', alignItems: 'center', gap: 12 },
  sectionTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  sectionSub:   { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  sectionAddBtn:{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },

  empty:        { paddingVertical: 16, alignItems: 'center' },
  emptyText:    { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },

  ruleList: { gap: 4 },
  dayRow:   { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border },
  dayLabel: { width: 36, fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary, paddingTop: 4 },
  dayBlocks:{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  dayBlock: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.md, borderWidth: 1.5, backgroundColor: '#fff' },
  dayBlockTime: { fontSize: fontSize.xs, fontWeight: '800' },
  dayBlockInterval: { fontSize: 10, color: colors.textMuted, fontWeight: '600', marginTop: 1 },
  helperText: { fontSize: 11, color: colors.textLight, fontWeight: '600', marginTop: 6, textAlign: 'center' },

  quickAddRow: { flexDirection: 'row', gap: 6, marginTop: 4 },
  quickAddBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 10, borderRadius: radius.md, borderWidth: 1.5, backgroundColor: '#fff',
  },
  quickAddText:{ fontSize: 11, fontWeight: '800' },

  overrideCard:  { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border },
  overrideIcon:  { width: 28, height: 28, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  overrideTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  overrideSub:   { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  overrideNotes: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 3, fontStyle: 'italic' },
});

const modalStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet:   { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: spacing.lg, paddingBottom: 40, gap: 8 },
  handle:  { width: 36, height: 4, backgroundColor: colors.border, borderRadius: 2, alignSelf: 'center', marginBottom: 8 },
  title:   { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary },
  subtitle:{ fontSize: fontSize.xs, color: colors.textMuted, marginBottom: 6, lineHeight: 17 },

  label:   { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary, marginTop: 8, marginBottom: 4 },
  input:   { backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 10, fontSize: fontSize.sm, color: colors.textPrimary },

  dayPickerRow: { flexDirection: 'row', gap: 5, justifyContent: 'space-between' },
  dayChip:      { flex: 1, paddingVertical: 8, alignItems: 'center', borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.md, backgroundColor: '#fff' },
  dayChipText:  { fontSize: 11, fontWeight: '800', color: colors.textMuted },

  row2:    { flexDirection: 'row', gap: 10 },

  intervalRow:  { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  intervalChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border, backgroundColor: '#fff' },
  intervalChipText: { fontSize: fontSize.xs, fontWeight: '800', color: colors.textMuted },
  intervalCustom: { width: 80, paddingHorizontal: 10, paddingVertical: 8, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border, fontSize: fontSize.xs, color: colors.textPrimary, textAlign: 'center', fontWeight: '700' },

  dateBtn:    { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: '#fff' },
  dateBtnText:{ fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: '700' },

  actions:    { flexDirection: 'row', gap: 10, marginTop: 16 },
  cancelBtn:  { flex: 1, alignItems: 'center', paddingVertical: 12 },
  cancelText: { fontSize: fontSize.sm, color: colors.textMuted, fontWeight: '700' },
  saveBtn:    { flex: 2, paddingVertical: 12, borderRadius: radius.md, alignItems: 'center' },
  saveText:   { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
});

const timeStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: '#fff', justifyContent: 'center' },
  col: { alignItems: 'center', gap: 4 },
  num: { fontSize: 22, fontWeight: '900', color: colors.textPrimary, letterSpacing: -0.5, fontVariant: ['tabular-nums'] },
  sep: { fontSize: 22, fontWeight: '900', color: colors.textMuted },
});
