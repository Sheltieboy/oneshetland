/**
 * shifts.tsx  — OneShetland Shifts hub
 *
 * The tab entry point. Shows a landing page explaining what Shifts is,
 * quick-action tiles, how it works, the boost promo, a shift preview,
 * and the user's own activity links.
 *
 * Tapping "Post a shift" switches to the inline PostShiftForm.
 * Tapping "Browse Shifts" navigates to /shifts-browse.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, Pressable, Animated, ActivityIndicator,
  KeyboardAvoidingView, Platform, Alert, Modal, Switch,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { GooglePlacesAutocomplete } from 'react-native-google-places-autocomplete';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useStripe } from '@stripe/stripe-react-native';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { SECTIONS } from '@/constants/sections';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import {
  fetchOpenShifts, fetchMyApplications, fetchEmployerShifts,
  formatPay, formatDuration, formatShiftDate,
  URGENCY_CONFIG, CATEGORY_LABELS, type Shift,
} from '@/lib/shifts-api';
import { TabScreenHeader } from '@/components/TabScreenHeader';

const S = SECTIONS.shifts;

// ── Constants (shared with form) ──────────────────────────────────────────────

const CATEGORIES = [
  { id: 'hospitality',   label: 'Hospitality & Catering',    icon: 'utensils' },
  { id: 'maritime',      label: 'Maritime & Fishing',        icon: 'ship' },
  { id: 'oil_gas',       label: 'Oil & Gas / Energy',        icon: 'hard-hat' },
  { id: 'aquaculture',   label: 'Aquaculture',               icon: 'fish' },
  { id: 'crofting',      label: 'Crofting & Agriculture',    icon: 'tractor' },
  { id: 'care',          label: 'Care & Support',            icon: 'hand-holding-heart' },
  { id: 'events',        label: 'Events & Festivals',        icon: 'star' },
  { id: 'retail',        label: 'Retail & Admin',            icon: 'store' },
  { id: 'driving',       label: 'Driving & Logistics',       icon: 'truck' },
  { id: 'trades',        label: 'Construction & Trades',     icon: 'tools' },
  { id: 'education',     label: 'Education & Childcare',     icon: 'graduation-cap' },
  { id: 'tourism',       label: 'Tourism & Visitor',         icon: 'map-marker-alt' },
];

const REQUIREMENTS = [
  'Driving licence', 'Food hygiene cert', 'STCW', 'PVG / Disclosure',
  'First aid', 'Over 18', 'Own transport', 'Manual handling',
];

const URGENCY_OPTIONS = [
  { id: 'asap',      label: 'ASAP',      icon: 'bolt' },
  { id: 'today',     label: 'Today',     icon: 'sun' },
  { id: 'this_week', label: 'This week', icon: 'calendar-week' },
  { id: 'planned',   label: 'Planned',   icon: 'calendar-alt' },
];

const PAY_TYPES = [
  { id: 'hourly',     label: 'Hourly rate' },
  { id: 'fixed',      label: 'Fixed amount' },
  { id: 'negotiable', label: 'Negotiable' },
  { id: 'discuss',    label: 'To discuss' },
  { id: 'volunteer',  label: 'Voluntary / unpaid' },
];

const GOOGLE_KEY    = process.env.EXPO_PUBLIC_GOOGLE_PLACES_KEY ?? '';
const HOUR_ITEM_H   = 52;
const MINUTE_OPTIONS = [0, 15, 30, 45];

// ── Form helpers ──────────────────────────────────────────────────────────────

function FieldLabel({ label, required }: { label: string; required?: boolean }) {
  return (
    <Text style={styles.fieldLabel}>
      {label}{required ? <Text style={{ color: S.color }}> *</Text> : null}
    </Text>
  );
}

function StyledInput({ value, onChangeText, placeholder, multiline, keyboardType, prefix }: {
  value: string; onChangeText: (v: string) => void; placeholder: string;
  multiline?: boolean; keyboardType?: any; prefix?: string;
}) {
  return (
    <View style={[styles.inputWrap, multiline && { height: 90, alignItems: 'flex-start' }]}>
      {prefix ? <Text style={styles.inputPrefix}>{prefix}</Text> : null}
      <TextInput
        style={[styles.input, multiline && { height: 80, textAlignVertical: 'top', paddingTop: 4 }]}
        value={value} onChangeText={onChangeText} placeholder={placeholder}
        placeholderTextColor={colors.textLight} multiline={multiline}
        keyboardType={keyboardType} autoCorrect={false}
      />
    </View>
  );
}

function ChipRow({ options, selected, onToggle, color }: {
  options: string[]; selected: string[]; onToggle: (v: string) => void; color: string;
}) {
  return (
    <View style={styles.chipRow}>
      {options.map(opt => {
        const active = selected.includes(opt);
        return (
          <TouchableOpacity
            key={opt}
            style={[styles.chip, active && { backgroundColor: color, borderColor: color }]}
            onPress={() => { Haptics.selectionAsync(); onToggle(opt); }}
            activeOpacity={0.75}
          >
            {active && <FontAwesome5 name="check" size={9} color="#fff" style={{ marginRight: 4 }} />}
            <Text style={[styles.chipText, active && { color: '#fff' }]}>{opt}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

type PickerTarget = 'startDate' | 'startTime' | 'endDate' | 'endTime' | null;

function PickerField({ icon, label, value, mode, onPress }: {
  icon: string; label: string; value: Date; mode: 'date' | 'time'; onPress: () => void;
}) {
  const formatted = mode === 'date'
    ? value.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    : value.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  return (
    <TouchableOpacity style={styles.pickerField} onPress={onPress} activeOpacity={0.75}>
      <FontAwesome5 name={icon as any} size={13} color={S.color} />
      <View style={{ flex: 1 }}>
        <Text style={styles.pickerFieldLabel}>{label}</Text>
        <Text style={styles.pickerFieldValue}>{formatted}</Text>
      </View>
      <FontAwesome5 name="chevron-down" size={11} color={colors.textLight} />
    </TouchableOpacity>
  );
}

function CustomTimePicker({ value, onChange, color }: {
  value: Date; onChange: (d: Date) => void; color: string;
}) {
  const hourScrollRef  = useRef<ScrollView>(null);
  const currentHour    = value.getHours();
  const currentMinute  = MINUTE_OPTIONS.includes(value.getMinutes()) ? value.getMinutes() : 0;

  useEffect(() => {
    const t = setTimeout(() => {
      hourScrollRef.current?.scrollTo({ y: currentHour * HOUR_ITEM_H, animated: false });
    }, 80);
    return () => clearTimeout(t);
  }, []);

  const pickHour = (h: number) => {
    Haptics.selectionAsync();
    const d = new Date(value); d.setHours(h); d.setMinutes(currentMinute); onChange(d);
  };
  const pickMinute = (m: number) => {
    Haptics.selectionAsync();
    const d = new Date(value); d.setMinutes(m); onChange(d);
  };

  return (
    <View style={styles.timePicker}>
      <View style={styles.timePickerSide}>
        <Text style={styles.timePickerColLabel}>Hour</Text>
        <ScrollView
          ref={hourScrollRef} style={styles.timePickerScroll}
          snapToInterval={HOUR_ITEM_H} decelerationRate="fast" showsVerticalScrollIndicator={false}
          onMomentumScrollEnd={e => {
            const h = Math.round(e.nativeEvent.contentOffset.y / HOUR_ITEM_H);
            pickHour(Math.max(0, Math.min(23, h)));
          }}
        >
          {Array.from({ length: 24 }, (_, i) => (
            <TouchableOpacity
              key={i}
              style={[styles.timePickerItem, currentHour === i && { backgroundColor: color + '18' }]}
              onPress={() => pickHour(i)} activeOpacity={0.7}
            >
              <Text style={[styles.timePickerItemText, currentHour === i && { color, fontWeight: '800' }]}>
                {i.toString().padStart(2, '0')}
              </Text>
            </TouchableOpacity>
          ))}
          <View style={{ height: HOUR_ITEM_H * 3 }} />
        </ScrollView>
      </View>
      <Text style={styles.timePickerColon}>:</Text>
      <View style={styles.timePickerSide}>
        <Text style={styles.timePickerColLabel}>Minute</Text>
        <View style={styles.timePickerMinutes}>
          {MINUTE_OPTIONS.map(m => (
            <TouchableOpacity
              key={m}
              style={[styles.timePickerMinuteBtn, currentMinute === m && { backgroundColor: color, borderColor: color }]}
              onPress={() => pickMinute(m)} activeOpacity={0.75}
            >
              <Text style={[styles.timePickerMinuteBtnText, currentMinute === m && { color: '#fff', fontWeight: '800' }]}>
                {m.toString().padStart(2, '0')}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    </View>
  );
}

// ── Post-shift boost sheet ────────────────────────────────────────────────────

function BoostSheet({
  shiftId,
  onDismiss,
  onBoosted,
}: {
  shiftId: string;
  onDismiss: () => void;
  onBoosted: (boostedUntil: string) => void;
}) {
  const { initPaymentSheet, presentPaymentSheet } = useStripe();
  const { profile } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const hasSavedCard = !!profile?.has_payment_method;

  const handleBoost = async () => {
    // Pre-flight: redirect to card setup if no card on file
    if (!hasSavedCard) {
      Alert.alert(
        'Payment card needed',
        'Add a payment card in your account before boosting a shift.',
        [
          { text: 'Not now', style: 'cancel', onPress: onDismiss },
          { text: 'Add card', onPress: () => { onDismiss(); router.push('/payment-setup'); } },
        ],
      );
      return;
    }

    setLoading(true);
    try {
      // Charge the saved card off-session — no PaymentSheet needed
      const { data, error: fnErr } = await supabase.functions.invoke('create-boost-intent', {
        body: { shift_id: shiftId, use_saved_card: true },
      });
      if (fnErr) throw new Error(fnErr.message ?? 'Boost payment failed.');
      if (!data?.charged) throw new Error(data?.error ?? 'Payment did not complete.');

      const { data: confirmData, error: confirmErr } = await supabase.functions.invoke('confirm-boost', {
        body: { shift_id: shiftId },
      });
      if (confirmErr) throw confirmErr;

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onBoosted(confirmData?.boosted_until ?? new Date(Date.now() + 86_400_000).toISOString());
    } catch (e: any) {
      Alert.alert('Boost failed', e?.message ?? 'Try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onDismiss}>
      <View style={styles.boostOverlay}>
        <View style={styles.boostSheet}>
          <View style={styles.boostSheetHandle} />

          <View style={[styles.boostSheetIcon, { backgroundColor: colors.jobsLight }]}>
            <FontAwesome5 name="check-circle" size={28} color={colors.jobs} solid />
          </View>
          <Text style={styles.boostSheetTitle}>Shift posted!</Text>
          <Text style={styles.boostSheetBody}>
            Your shift is live. Want matching workers alerted right now?
          </Text>

          <View style={styles.boostPromoRow}>
            <View style={[styles.boostPromoIcon, { backgroundColor: '#FEF3C7' }]}>
              <FontAwesome5 name="bolt" size={14} color={colors.shifts} solid />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.boostPromoTitle}>Boost for £2.99</Text>
              <Text style={styles.boostPromoSub}>
                Pinned to the top + instant alert to every matching worker for 24 hours
              </Text>
            </View>
          </View>

          {/* Show which card will be charged */}
          {hasSavedCard && (
            <View style={styles.savedCardNote}>
              <FontAwesome5 name="credit-card" size={11} color={colors.jobs} solid />
              <Text style={styles.savedCardNoteText}>Charged to your saved card</Text>
            </View>
          )}

          <TouchableOpacity
            style={[styles.boostBtn, loading && { opacity: 0.7 }]}
            onPress={handleBoost}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading
              ? <ActivityIndicator color="#fff" size="small" />
              : <>
                  <FontAwesome5 name="bolt" size={13} color="#fff" solid />
                  <Text style={styles.boostBtnText}>
                    {hasSavedCard ? 'Confirm boost — £2.99' : 'Boost for £2.99'}
                  </Text>
                </>
            }
          </TouchableOpacity>

          <TouchableOpacity onPress={onDismiss} style={styles.boostSkipBtn} activeOpacity={0.7}>
            <Text style={styles.boostSkipText}>Not now — I'll boost later</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ── Post shift form ────────────────────────────────────────────────────────────

function PostShiftForm({ onSuccess }: { onSuccess: (shiftId: string) => void }) {
  const { profile } = useAuth();
  const [submitting, setSubmitting] = useState(false);

  // Post-as picker: load any Local businesses this user owns so they can
  // post a shift on behalf of one with a single tap (no re-entering name/address).
  const [myBusinesses, setMyBusinesses] = useState<Array<{
    id: string; name: string; logo_url: string | null; address: string;
  }>>([]);
  const [selectedBusinessId, setSelectedBusinessId] = useState<string | null>(null);
  const [businessesLoaded, setBusinessesLoaded] = useState(false);

  // Inline-create state — used when the user has no Local businesses yet.
  // On submit, we'll create a real local_businesses row first, then link
  // the shift to it (so the new business is usable everywhere else too).
  const [inlineBusinessName, setInlineBusinessName] = useState('');
  const [inlineBusinessCategory, setInlineBusinessCategory] = useState<'food_drink' | 'retail' | 'services' | 'tourism' | 'accommodation' | 'other' | null>(null);

  useEffect(() => {
    if (!profile?.id) return;
    supabase
      .from('local_businesses')
      .select('id, name, logo_url, address')
      .eq('owner_id', profile.id)
      .eq('is_active', true)
      .order('name', { ascending: true })
      .then(({ data }) => {
        if (data) setMyBusinesses(data as any[]);
        setBusinessesLoaded(true);
      });
  }, [profile?.id]);

  // Sensible default category based on the shift's category, when we
  // need to inline-create a Local business.
  useEffect(() => {
    if (inlineBusinessCategory) return;
    if (!category) return;
    const map: Record<string, typeof inlineBusinessCategory> = {
      hospitality: 'food_drink',
      retail:      'retail',
      tourism:     'tourism',
    };
    setInlineBusinessCategory(map[category] ?? 'services');
  }, [category, inlineBusinessCategory]);

  const [title, setTitle]               = useState('');
  const [category, setCategory]         = useState('');
  const [description, setDescription]   = useState('');
  const [location, setLocation]         = useState('');
  const [payType, setPayType]           = useState('hourly');
  const [payAmount, setPayAmount]       = useState('');
  const [positions, setPositions]       = useState('1');
  const [requirements, setRequirements] = useState<string[]>([]);
  const [urgency, setUrgency]           = useState('planned');

  const now = new Date();
  const [startDate, setStartDate] = useState<Date>(now);
  const [startTime, setStartTime] = useState<Date>(now);
  const [endDate, setEndDate]     = useState<Date>(now);
  const [endTime, setEndTime]     = useState<Date>(now);
  const [isMultiDay, setIsMultiDay] = useState(false);

  const [activePicker, setActivePicker] = useState<PickerTarget>(null);
  const [tempDate, setTempDate]         = useState<Date>(now);

  const openPicker = (target: PickerTarget) => {
    const current =
      target === 'startDate' ? startDate :
      target === 'startTime' ? startTime :
      target === 'endDate'   ? endDate   : endTime;
    setTempDate(current);
    setActivePicker(target);
    Haptics.selectionAsync();
  };

  const confirmPicker = () => {
    if (activePicker === 'startDate') setStartDate(tempDate);
    if (activePicker === 'startTime') setStartTime(tempDate);
    if (activePicker === 'endDate')   setEndDate(tempDate);
    if (activePicker === 'endTime')   setEndTime(tempDate);
    setActivePicker(null);
  };

  const pickerMode = activePicker === 'startTime' || activePicker === 'endTime' ? 'time' : 'date';

  const toggleRequirement = useCallback((req: string) => {
    setRequirements(prev => prev.includes(req) ? prev.filter(r => r !== req) : [...prev, req]);
  }, []);

  const reset = () => {
    setTitle(''); setCategory(''); setDescription(''); setLocation('');
    setPayType('hourly'); setPayAmount(''); setPositions('1');
    setRequirements([]); setUrgency('planned'); setIsMultiDay(false);
    setStartDate(new Date()); setStartTime(new Date());
    setEndDate(new Date()); setEndTime(new Date());
    setSelectedBusinessId(null);
  };

  const handleSubmit = async () => {
    if (!title.trim())    return Alert.alert('Missing info', 'Please add a shift title.');
    if (!category)        return Alert.alert('Missing info', 'Please select a category.');
    if (!location.trim()) return Alert.alert('Missing info', 'Please add a location.');

    const start_at = new Date(
      startDate.getFullYear(), startDate.getMonth(), startDate.getDate(),
      startTime.getHours(), startTime.getMinutes()
    ).toISOString();

    const endD = isMultiDay ? endDate : startDate;
    const end_at = new Date(
      endD.getFullYear(), endD.getMonth(), endD.getDate(),
      endTime.getHours(), endTime.getMinutes()
    ).toISOString();

    if (new Date(end_at) <= new Date(start_at)) {
      return Alert.alert('Invalid times', 'End time must be after start time.');
    }

    // If the user has no Local business yet, require a business name + category
    // and create one inline. The new business is usable elsewhere in the app
    // straight away (Local directory, loyalty, bookings if they upgrade, etc).
    let businessIdForShift: string | null = selectedBusinessId;
    const needsInlineCreate = myBusinesses.length === 0 && !businessIdForShift;
    if (needsInlineCreate) {
      if (!inlineBusinessName.trim()) {
        return Alert.alert('Business name required', 'What name should workers see on this shift?');
      }
      if (!inlineBusinessCategory) {
        return Alert.alert('Category required', 'Pick a category for your business.');
      }
    }

    setSubmitting(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Inline-create the Local business if needed (BEFORE the shift insert
    // so we have its id to link).
    if (needsInlineCreate) {
      const { data: created, error: bizErr } = await supabase
        .from('local_businesses')
        .insert({
          owner_id:    profile!.id,
          name:        inlineBusinessName.trim(),
          category:    inlineBusinessCategory,
          address:     location.trim(),
          email:       profile?.email ?? null,
          is_active:   true,
        })
        .select('id, name, address')
        .single();
      if (bizErr || !created) {
        setSubmitting(false);
        return Alert.alert('Could not create business', bizErr?.message ?? 'Try again.');
      }
      businessIdForShift = created.id;
      // Refresh local cache so the new business shows in the picker next time
      setMyBusinesses(prev => [...prev, { id: created.id, name: created.name, logo_url: null, address: created.address }]);
      setSelectedBusinessId(created.id);
    }

    await supabase.from('shift_employer_profiles').upsert({
      id:            profile!.id,
      business_name: profile!.full_name ?? 'Unknown',
      is_verified:   false,
      logo_url:      null,
    }, { onConflict: 'id', ignoreDuplicates: true });

    const { data: newShift, error } = await supabase.from('shifts').insert({
      employer_id:           profile!.id,
      posted_as_business_id: businessIdForShift,    // null → falls back to employer profile
      title:                 title.trim(),
      category,
      description:           description.trim() || null,
      location_text:         location.trim(),
      start_at,
      end_at,
      pay_type:              payType,
      pay_amount:            payAmount ? parseFloat(payAmount) : null,
      positions_total:       parseInt(positions) || 1,
      requirements,
      urgency,
      status:                'open',
    }).select('id').single();

    setSubmitting(false);

    if (error) {
      Alert.alert('Error', error.message);
    } else {
      // NOTE: notify-matching-workers is NOT fired here — it only fires on boost.
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      reset();
      onSuccess(newShift!.id);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        style={[styles.formScroll, { flex: 1 }]}
        contentContainerStyle={styles.formContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Inline business creation — shown when user has no Local business yet ── */}
        {businessesLoaded && myBusinesses.length === 0 && (
          <View style={styles.fieldGroup}>
            <FieldLabel label="Your business" required />
            <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 8, lineHeight: 16 }}>
              We'll create a business profile from this so it's usable across the app (Local directory, loyalty, bookings…). You can flesh it out later.
            </Text>
            <StyledInput
              value={inlineBusinessName}
              onChangeText={setInlineBusinessName}
              placeholder="e.g. The Hood Wink"
            />
            <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: colors.textPrimary, marginTop: 12, marginBottom: 6 }}>
              Category
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
              {([
                { id: 'food_drink',    label: 'Food & Drink' },
                { id: 'retail',        label: 'Retail' },
                { id: 'services',      label: 'Services' },
                { id: 'tourism',       label: 'Tourism' },
                { id: 'accommodation', label: 'Stay' },
                { id: 'other',         label: 'Other' },
              ] as const).map(c => {
                const active = inlineBusinessCategory === c.id;
                return (
                  <TouchableOpacity
                    key={c.id}
                    style={{
                      paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999,
                      borderWidth: 1.5, borderColor: active ? S.color : colors.border,
                      backgroundColor: active ? S.light : '#fff',
                    }}
                    onPress={() => { Haptics.selectionAsync(); setInlineBusinessCategory(c.id as any); }}
                    activeOpacity={0.85}
                  >
                    <Text style={{ fontSize: fontSize.xs, fontWeight: '800', color: active ? S.color : colors.textPrimary }}>
                      {c.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        )}

        {/* ── Post as ── (only shown if user has Local businesses) ── */}
        {myBusinesses.length > 0 && (() => {
          /**
           * Switching "Post as":
           *  - If the location was auto-filled from the previously-selected
           *    business, replace it with the new business's address (or
           *    clear it for 'Use employer profile').
           *  - If the location is empty, fill from the new business.
           *  - If the user has typed manually, leave it alone.
           */
          const handleSwitch = (nextId: string | null) => {
            Haptics.selectionAsync();
            const prev = selectedBusinessId ? myBusinesses.find(b => b.id === selectedBusinessId) : null;
            const next = nextId ? myBusinesses.find(b => b.id === nextId) : null;
            const locTrim = location.trim();
            const wasAutoFilled = !!prev?.address && locTrim === prev.address.trim();
            setSelectedBusinessId(nextId);
            if (wasAutoFilled || !locTrim) {
              setLocation(next?.address ?? '');
            }
          };

          return (
            <View style={styles.fieldGroup}>
              <FieldLabel label="Post as" />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                {myBusinesses.map(b => {
                  const active = selectedBusinessId === b.id;
                  return (
                    <TouchableOpacity
                      key={b.id}
                      style={{
                        flexDirection: 'row', alignItems: 'center', gap: 8,
                        paddingHorizontal: 12, paddingVertical: 9, borderRadius: 999,
                        borderWidth: 1.5, borderColor: active ? S.color : colors.border,
                        backgroundColor: active ? S.light : '#fff',
                      }}
                      onPress={() => handleSwitch(b.id)}
                      activeOpacity={0.85}
                    >
                      <FontAwesome5 name="store" size={11} color={active ? S.color : colors.textMuted} solid />
                      <Text style={{ fontSize: fontSize.xs, fontWeight: '800', color: active ? S.color : colors.textPrimary }} numberOfLines={1}>
                        {b.name}
                      </Text>
                      {active && <FontAwesome5 name="check" size={9} color={S.color} solid />}
                    </TouchableOpacity>
                  );
                })}
                {(() => {
                  const active = selectedBusinessId === null;
                  return (
                    <TouchableOpacity
                      style={{
                        flexDirection: 'row', alignItems: 'center', gap: 8,
                        paddingHorizontal: 12, paddingVertical: 9, borderRadius: 999,
                        borderWidth: 1.5, borderColor: active ? S.color : colors.border,
                        backgroundColor: active ? S.light : '#fff',
                      }}
                      onPress={() => handleSwitch(null)}
                      activeOpacity={0.85}
                    >
                      <FontAwesome5 name="user" size={11} color={active ? S.color : colors.textMuted} solid />
                      <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: active ? S.color : colors.textPrimary }}>
                        Use employer profile
                      </Text>
                      {active && <FontAwesome5 name="check" size={9} color={S.color} solid />}
                    </TouchableOpacity>
                  );
                })()}
              </ScrollView>
              <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 6 }}>
                {selectedBusinessId
                  ? 'Workers see this business\'s name and logo on the listing.'
                  : 'Workers see your employer-profile business name on the listing.'}
              </Text>
            </View>
          );
        })()}

        <View style={styles.fieldGroup}>
          <FieldLabel label="Shift title" required />
          <StyledInput value={title} onChangeText={setTitle} placeholder="e.g. Kitchen assistant for lunch service" />
        </View>

        <View style={styles.fieldGroup}>
          <FieldLabel label="Category" required />
          <View style={styles.categoryGrid}>
            {CATEGORIES.map(cat => {
              const active = category === cat.id;
              return (
                <TouchableOpacity
                  key={cat.id}
                  style={[styles.categoryCard, active && { borderColor: S.color, backgroundColor: S.light }]}
                  onPress={() => { Haptics.selectionAsync(); setCategory(cat.id); }}
                  activeOpacity={0.75}
                >
                  <FontAwesome5 name={cat.icon as any} size={14} color={active ? S.color : colors.textMuted} solid />
                  <Text style={[styles.categoryLabel, active && { color: S.color, fontWeight: '700' }]} numberOfLines={2}>
                    {cat.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={styles.fieldGroup}>
          <FieldLabel label="Location" required />
          {location ? (
            <View style={styles.locationSelected}>
              <FontAwesome5 name="map-marker-alt" size={13} color={S.color} />
              <Text style={styles.locationSelectedText} numberOfLines={2}>{location}</Text>
              <TouchableOpacity onPress={() => setLocation('')} hitSlop={12} style={styles.locationClear}>
                <FontAwesome5 name="times-circle" size={16} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          ) : (
            <GooglePlacesAutocomplete
              placeholder="Search for a place or postcode…"
              onPress={(data) => setLocation(data.description)}
              query={{ key: GOOGLE_KEY, language: 'en', components: 'country:gb' }}
              fetchDetails={false}
              textInputProps={{ placeholderTextColor: colors.textLight }}
              styles={{
                container:          { flex: 0 },
                textInputContainer: { backgroundColor: 'transparent', padding: 0, margin: 0 },
                textInput: {
                  backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border,
                  borderRadius: radius.md, height: 46, paddingHorizontal: 12,
                  fontSize: fontSize.sm, color: colors.textPrimary, marginBottom: 0,
                },
                listView: {
                  backgroundColor: '#fff', borderRadius: radius.md, marginTop: 4,
                  borderWidth: 1, borderColor: colors.border, overflow: 'hidden',
                },
                row:              { paddingVertical: 12, paddingHorizontal: 14 },
                separator:        { height: 1, backgroundColor: colors.border },
                description:      { fontSize: fontSize.sm, color: colors.textPrimary },
                poweredContainer: { display: 'none' },
              }}
              enablePoweredByContainer={false}
              minLength={2}
              keyboardShouldPersistTaps="handled"
            />
          )}
        </View>

        <View style={styles.fieldGroup}>
          <FieldLabel label="Date & times" required />
          <View style={styles.datePickerGrid}>
            <PickerField icon="calendar"  label="Start date" value={startDate} mode="date" onPress={() => openPicker('startDate')} />
            <PickerField icon="clock"     label="Start time" value={startTime} mode="time" onPress={() => openPicker('startTime')} />
          </View>
          <View style={styles.multiDayRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.multiDayLabel}>Multi-day shift</Text>
              <Text style={styles.multiDayHint}>e.g. a week on a fishing boat</Text>
            </View>
            <Switch
              value={isMultiDay}
              onValueChange={v => { Haptics.selectionAsync(); setIsMultiDay(v); }}
              trackColor={{ false: colors.border, true: S.color }}
              thumbColor="#fff"
            />
          </View>
          <View style={styles.datePickerGrid}>
            {isMultiDay && (
              <PickerField icon="calendar-check" label="End date" value={endDate} mode="date" onPress={() => openPicker('endDate')} />
            )}
            <PickerField icon="clock" label="End time" value={endTime} mode="time" onPress={() => openPicker('endTime')} />
          </View>
        </View>

        <View style={styles.fieldGroup}>
          <FieldLabel label="How urgent is this?" />
          <View style={styles.urgencyRow}>
            {URGENCY_OPTIONS.map(opt => {
              const active = urgency === opt.id;
              return (
                <TouchableOpacity
                  key={opt.id}
                  style={[styles.urgencyBtn, active && { backgroundColor: S.color, borderColor: S.color }]}
                  onPress={() => { Haptics.selectionAsync(); setUrgency(opt.id); }}
                  activeOpacity={0.75}
                >
                  <FontAwesome5 name={opt.icon as any} size={11} color={active ? '#fff' : colors.textMuted} solid />
                  <Text style={[styles.urgencyText, active && { color: '#fff' }]}>{opt.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={styles.fieldGroup}>
          <FieldLabel label="Pay / compensation" />
          <View style={styles.payTypeRow}>
            {PAY_TYPES.map(pt => {
              const active = payType === pt.id;
              return (
                <TouchableOpacity
                  key={pt.id}
                  style={[styles.payTypeBtn, active && { backgroundColor: S.color, borderColor: S.color }]}
                  onPress={() => { Haptics.selectionAsync(); setPayType(pt.id); }}
                  activeOpacity={0.75}
                >
                  <Text style={[styles.payTypeText, active && { color: '#fff' }]}>{pt.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {(payType === 'hourly' || payType === 'fixed') && (
            <StyledInput
              value={payAmount} onChangeText={setPayAmount}
              placeholder={payType === 'hourly' ? '13.50' : '120.00'}
              keyboardType="decimal-pad" prefix="£"
            />
          )}
        </View>

        <View style={styles.fieldGroup}>
          <FieldLabel label="Number of positions" />
          <View style={styles.positionsRow}>
            {['1','2','3','4','5+'].map(p => {
              const active = positions === p;
              return (
                <TouchableOpacity
                  key={p}
                  style={[styles.posBtn, active && { backgroundColor: S.color, borderColor: S.color }]}
                  onPress={() => { Haptics.selectionAsync(); setPositions(p); }}
                  activeOpacity={0.75}
                >
                  <Text style={[styles.posBtnText, active && { color: '#fff' }]}>{p}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={styles.fieldGroup}>
          <FieldLabel label="Requirements" />
          <Text style={styles.fieldHint}>Select any that apply</Text>
          <ChipRow options={REQUIREMENTS} selected={requirements} onToggle={toggleRequirement} color={S.color} />
        </View>

        <View style={styles.fieldGroup}>
          <FieldLabel label="Additional details" />
          <StyledInput
            value={description} onChangeText={setDescription}
            placeholder="Anything else workers should know — uniform, parking, what to bring…"
            multiline
          />
        </View>

        <TouchableOpacity
          style={[styles.submitBtn, submitting && { opacity: 0.7 }]}
          onPress={handleSubmit} disabled={submitting} activeOpacity={0.85}
        >
          {submitting
            ? <ActivityIndicator color="#fff" />
            : <>
                <FontAwesome5 name="paper-plane" size={14} color="#fff" solid />
                <Text style={styles.submitText}>Post this shift</Text>
              </>
          }
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Date/time picker modal */}
      <Modal visible={activePicker !== null} transparent animationType="slide" onRequestClose={() => setActivePicker(null)}>
        <TouchableOpacity style={styles.pickerOverlay} activeOpacity={1} onPress={() => setActivePicker(null)} />
        <View style={styles.pickerSheet}>
          <View style={styles.pickerSheetHeader}>
            <TouchableOpacity onPress={() => setActivePicker(null)}>
              <Text style={styles.pickerCancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.pickerTitle}>
              {activePicker === 'startDate' ? 'Start date' :
               activePicker === 'startTime' ? 'Start time' :
               activePicker === 'endDate'   ? 'End date'   : 'End time'}
            </Text>
            <TouchableOpacity onPress={confirmPicker}>
              <Text style={[styles.pickerDone, { color: S.color }]}>Done</Text>
            </TouchableOpacity>
          </View>
          {pickerMode === 'date' ? (
            <DateTimePicker
              value={tempDate} mode="date" display="spinner"
              onChange={(_, date) => { if (date) setTempDate(date); }}
              minimumDate={new Date()} style={{ height: 220 }}
            />
          ) : (
            <CustomTimePicker value={tempDate} onChange={setTempDate} color={S.color} />
          )}
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

// ── Preview shift card (compact, for hub) ─────────────────────────────────────

function PreviewShiftCard({ shift }: { shift: Shift }) {
  const router  = useRouter();
  const urgency = URGENCY_CONFIG[shift.urgency];
  const isBoosted = !!(shift.boosted_until && shift.boosted_until > new Date().toISOString());

  return (
    <TouchableOpacity
      style={[styles.previewCard, { borderLeftColor: urgency.color }]}
      onPress={() => {
        Haptics.selectionAsync();
        router.push({ pathname: '/shift-detail', params: { id: shift.id } });
      }}
      activeOpacity={0.8}
    >
      <View style={styles.previewCardTop}>
        {isBoosted && (
          <View style={styles.featuredBadge}>
            <FontAwesome5 name="bolt" size={7} color={colors.shifts} solid />
            <Text style={styles.featuredText}>Featured</Text>
          </View>
        )}
        <View style={[styles.previewUrgency, { backgroundColor: urgency.bg }]}>
          <Text style={[styles.previewUrgencyText, { color: urgency.color }]}>{urgency.label}</Text>
        </View>
        <Text style={styles.previewCategory} numberOfLines={1}>
          {CATEGORY_LABELS[shift.category] ?? shift.category}
        </Text>
      </View>
      <Text style={styles.previewTitle} numberOfLines={1}>{shift.title}</Text>
      <View style={styles.previewMeta}>
        <Text style={styles.previewMetaText}>{formatShiftDate(shift.start_at)}</Text>
        <Text style={styles.previewMetaSep}>·</Text>
        <Text style={[styles.previewPay, { color: S.color }]}>
          {formatPay(shift.pay_type, shift.pay_amount)}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

// ── How it works static steps ─────────────────────────────────────────────────

const HOW_IT_WORKS = {
  workers: [
    { icon: 'search',         title: 'Browse open shifts',          body: 'Filter by category, urgency, and location to find work that fits your life.' },
    { icon: 'paper-plane',    title: 'Submit your interest',        body: 'Apply in seconds — add a note about your experience if you like.' },
    { icon: 'map-marker-alt', title: 'Show up and check in',        body: "If you're picked, you'll get a notification — just show up, check in, and get paid." },
  ],
  employers: [
    { icon: 'plus-circle',    title: 'Post a shift for free',       body: 'Takes under 2 minutes. Set the date, pay, and any requirements.' },
    { icon: 'users',          title: 'Review applicants',           body: 'See worker profiles and accept the best fit with one tap.' },
    { icon: 'bolt',           title: 'Boost to reach more workers', body: 'Pay £2.99 to pin your shift to the top and alert every matching worker instantly.' },
  ],
};

// ── Mini cards shown inside the hub tabs ──────────────────────────────────────

const APP_STATUS: Record<string, { label: string; color: string; bg: string }> = {
  pending:  { label: 'Pending',   color: '#D97706',        bg: '#FEF3C7' },
  accepted: { label: 'Confirmed', color: colors.jobs,      bg: colors.jobsLight },
  rejected: { label: 'Declined',  color: '#DC2626',        bg: '#FEE2E2' },
};

const SHIFT_STATUS: Record<string, { label: string; color: string; bg: string }> = {
  open:   { label: 'Open',   color: S.color,     bg: S.light },
  filled: { label: 'Filled', color: colors.jobs, bg: colors.jobsLight },
};

function MiniAppCard({ app }: { app: any }) {
  const router  = useRouter();
  const st      = APP_STATUS[app.status] ?? APP_STATUS.pending;
  const shift   = app.shift;

  return (
    <TouchableOpacity
      style={styles.miniCard}
      onPress={() => { Haptics.selectionAsync(); router.push({ pathname: '/shift-detail', params: { id: app.shift_id } }); }}
      activeOpacity={0.8}
    >
      <View style={styles.miniCardTop}>
        <View style={[styles.miniStatusBadge, { backgroundColor: st.bg }]}>
          <Text style={[styles.miniStatusText, { color: st.color }]}>{st.label}</Text>
        </View>
        {shift && (
          <Text style={styles.miniCardDate}>
            {new Date(shift.start_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
          </Text>
        )}
      </View>
      <Text style={styles.miniCardTitle} numberOfLines={1}>
        {shift?.title ?? 'Shift no longer available'}
      </Text>
      {shift && (
        <View style={styles.miniCardMeta}>
          <Text style={styles.miniCardMetaText}>{formatPay(shift.pay_type, shift.pay_amount)}</Text>
          <Text style={styles.miniCardMetaSep}>·</Text>
          <Text style={styles.miniCardMetaText} numberOfLines={1}>{shift.location_text}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

function MiniPostedShiftCard({ shift }: { shift: any }) {
  const router = useRouter();
  const st     = SHIFT_STATUS[shift.status] ?? SHIFT_STATUS.open;
  const isBoosted = !!(shift.boosted_until && shift.boosted_until > new Date().toISOString());

  return (
    <TouchableOpacity
      style={styles.miniCard}
      onPress={() => { Haptics.selectionAsync(); router.push('/my-posted-shifts'); }}
      activeOpacity={0.8}
    >
      <View style={styles.miniCardTop}>
        <View style={[styles.miniStatusBadge, { backgroundColor: st.bg }]}>
          <Text style={[styles.miniStatusText, { color: st.color }]}>{st.label}</Text>
        </View>
        {isBoosted && (
          <View style={[styles.miniStatusBadge, { backgroundColor: '#FEF3C7' }]}>
            <Text style={[styles.miniStatusText, { color: colors.shifts }]}>⚡ Boosted</Text>
          </View>
        )}
        {shift.pending_count > 0 && (
          <View style={[styles.miniStatusBadge, { backgroundColor: S.color }]}>
            <Text style={[styles.miniStatusText, { color: '#fff' }]}>{shift.pending_count} to review</Text>
          </View>
        )}
        <Text style={styles.miniCardDate}>
          {new Date(shift.start_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
        </Text>
      </View>
      <Text style={styles.miniCardTitle} numberOfLines={1}>{shift.title}</Text>
      <View style={styles.miniCardMeta}>
        <Text style={styles.miniCardMetaText}>{formatPay(shift.pay_type, shift.pay_amount)}</Text>
        <Text style={styles.miniCardMetaSep}>·</Text>
        <Text style={styles.miniCardMetaText}>{shift.total_apps} applicant{shift.total_apps !== 1 ? 's' : ''}</Text>
      </View>
    </TouchableOpacity>
  );
}

// ── Hub landing page ──────────────────────────────────────────────────────────

function HubScreen({ onPostShift }: { onPostShift: () => void }) {
  const router      = useRouter();
  const { profile } = useAuth();
  const { isTablet } = useAppLayout();

  const [previewShifts,      setPreviewShifts]      = useState<Shift[]>([]);
  const [shiftCount,         setShiftCount]          = useState<number | null>(null);
  const [loadingPreview,     setLoadingPreview]      = useState(true);
  const [myApplications,     setMyApplications]      = useState<any[]>([]);
  const [myPostedShifts,     setMyPostedShifts]      = useState<any[]>([]);
  const [hasEmployerProfile, setHasEmployerProfile]  = useState(false);
  const [loadingMyData,      setLoadingMyData]       = useState(true);
  const [howTab,             setHowTab]              = useState<'workers' | 'employers'>('workers');

  useEffect(() => {
    // Public: open shifts preview
    fetchOpenShifts()
      .then(data => { setShiftCount(data.length); setPreviewShifts(data.slice(0, 3)); })
      .catch(() => {})
      .finally(() => setLoadingPreview(false));

    // Personalised: employer profile check + user's own applications + posted shifts
    if (profile) {
      Promise.all([
        fetchMyApplications(profile.id).catch(() => []),
        fetchEmployerShifts(profile.id).catch(() => []),
        supabase.from('shift_employer_profiles').select('id').eq('id', profile.id).maybeSingle(),
      ]).then(([apps, shifts, { data: empProfile }]) => {
        const hasEmp = !!empProfile;
        const activeApps = (apps as any[])
          .filter(a => a.status !== 'withdrawn')
          .slice(0, 4);
        const activeShifts = (shifts as any[])
          .filter(s => s.status === 'open' || s.status === 'filled')
          .slice(0, 4);
        setMyApplications(activeApps);
        setMyPostedShifts(activeShifts);
        setHasEmployerProfile(hasEmp);
        // Auto-select employer tab if they're an employer with shifts but no applications
        if (hasEmp && activeShifts.length > 0 && activeApps.length === 0) setHowTab('employers');
      }).finally(() => setLoadingMyData(false));
    } else {
      setLoadingMyData(false);
    }
  }, [profile?.id]);

  const hasApps   = myApplications.length > 0;
  const hasShifts = myPostedShifts.length > 0;

  return (
    <ScrollView
      style={styles.hubScroll}
      contentContainerStyle={[styles.hubContent, isTablet && styles.hubContentTablet]}
      showsVerticalScrollIndicator={false}
    >
      {/* ── Hero card ── */}
      {/* Strong amber hero block, mirrors the Local Wallet card aesthetic.
          Big live count + two embedded actions (Browse / Post). */}
      <TouchableOpacity
        style={styles.heroCard}
        onPress={() => { Haptics.selectionAsync(); router.push('/shifts-browse'); }}
        activeOpacity={0.92}
      >
        <View style={styles.heroTop}>
          <View>
            <Text style={styles.heroLabel}>LIVE NOW</Text>
            <Text style={styles.heroCount}>
              {shiftCount === null ? '—' : shiftCount}
            </Text>
            <Text style={styles.heroSub}>
              {shiftCount === null
                ? 'Loading…'
                : shiftCount === 0
                  ? 'No open shifts today'
                  : `Open shift${shiftCount === 1 ? '' : 's'} across Shetland`}
            </Text>
          </View>
          <View style={styles.heroIconWrap}>
            <FontAwesome5 name="briefcase" size={22} color="#fff" solid />
          </View>
        </View>

        <View style={styles.heroActions}>
          <View style={styles.heroAction}>
            <FontAwesome5 name="search" size={12} color="#fff" />
            <Text style={styles.heroActionText}>Browse</Text>
          </View>
          <View style={styles.heroActionDivider} />
          <TouchableOpacity
            style={styles.heroAction}
            onPress={() => { Haptics.selectionAsync(); onPostShift(); }}
            activeOpacity={0.7}
          >
            <FontAwesome5 name="plus" size={12} color="#fff" />
            <Text style={styles.heroActionText}>Post a shift</Text>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>

      {/* ── Latest shifts preview (moved up — was previously bottom of page) ── */}
      {previewShifts.length > 0 && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Latest shifts</Text>
            {shiftCount !== null && shiftCount > 0 && (
              <TouchableOpacity onPress={() => router.push('/shifts-browse')} activeOpacity={0.75}>
                <Text style={[styles.sectionLink, { color: S.color }]}>View all {shiftCount} →</Text>
              </TouchableOpacity>
            )}
          </View>
          <View style={styles.previewList}>
            {previewShifts.map(s => <PreviewShiftCard key={s.id} shift={s} />)}
          </View>
        </View>
      )}

      {/* ── Contextual tabs ── */}
      <View style={styles.section}>

        {/* Toggle — only shown to users who have set up an employer profile */}
        {hasEmployerProfile && (
          <View style={styles.howToggle}>
            {(['workers', 'employers'] as const).map(tab => (
              <TouchableOpacity
                key={tab}
                style={[styles.howToggleBtn, howTab === tab && styles.howToggleBtnActive]}
                onPress={() => { Haptics.selectionAsync(); setHowTab(tab); }}
                activeOpacity={0.8}
              >
                <Text style={[styles.howToggleBtnText, howTab === tab && styles.howToggleBtnTextActive]}>
                  {tab === 'workers' ? 'For workers' : 'For employers'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Workers tab — always visible (or when worker tab is active) */}
        {(!hasEmployerProfile || howTab === 'workers') && (
          loadingMyData ? (
            <View style={styles.tabLoading}><ActivityIndicator color={S.color} size="small" /></View>
          ) : hasApps ? (
            <>
              <Text style={styles.tabSectionLabel}>Your applications</Text>
              <View style={styles.miniCardList}>
                {myApplications.map(app => <MiniAppCard key={app.id} app={app} />)}
              </View>
              <TouchableOpacity
                style={styles.tabViewAllBtn}
                onPress={() => { Haptics.selectionAsync(); router.push('/my-shift-applications'); }}
                activeOpacity={0.8}
              >
                <Text style={[styles.tabViewAllText, { color: S.color }]}>View all applications →</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <View style={styles.howSteps}>
                {HOW_IT_WORKS.workers.map((step, i) => (
                  <View key={i} style={styles.howStep}>
                    <View style={styles.howStepLeft}>
                      <View style={[styles.howStepIcon, { backgroundColor: S.light }]}>
                        <FontAwesome5 name={step.icon as any} size={13} color={S.color} solid />
                      </View>
                      {i < HOW_IT_WORKS.workers.length - 1 && <View style={styles.howStepLine} />}
                    </View>
                    <View style={styles.howStepBody}>
                      <Text style={styles.howStepTitle}>{step.title}</Text>
                      <Text style={styles.howStepText}>{step.body}</Text>
                    </View>
                  </View>
                ))}
              </View>
              <TouchableOpacity
                style={[styles.howActionBtn, { marginTop: 12 }]}
                onPress={() => { Haptics.selectionAsync(); router.push('/shifts-browse'); }}
                activeOpacity={0.8}
              >
                <FontAwesome5 name="search" size={12} color={S.color} />
                <Text style={[styles.howActionText, { color: S.color }]}>Browse open shifts</Text>
              </TouchableOpacity>
            </>
          )
        )}

        {/* Employers tab — only visible if the user has an employer profile */}
        {hasEmployerProfile && howTab === 'employers' && (
          loadingMyData ? (
            <View style={styles.tabLoading}><ActivityIndicator color={S.color} size="small" /></View>
          ) : hasShifts ? (
            <>
              <Text style={styles.tabSectionLabel}>Your posted shifts</Text>
              <View style={styles.miniCardList}>
                {myPostedShifts.map(shift => <MiniPostedShiftCard key={shift.id} shift={shift} />)}
              </View>
              <View style={styles.howActions}>
                <TouchableOpacity
                  style={styles.howActionBtn}
                  onPress={() => { Haptics.selectionAsync(); router.push('/my-posted-shifts'); }}
                  activeOpacity={0.8}
                >
                  <FontAwesome5 name="briefcase" size={12} color={S.color} />
                  <Text style={[styles.howActionText, { color: S.color }]}>All my shifts</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.howActionBtn}
                  onPress={() => { Haptics.selectionAsync(); router.push('/employer-applications'); }}
                  activeOpacity={0.8}
                >
                  <FontAwesome5 name="inbox" size={12} color={S.color} />
                  <Text style={[styles.howActionText, { color: S.color }]}>Applications inbox</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <>
              <View style={styles.howSteps}>
                {HOW_IT_WORKS.employers.map((step, i) => (
                  <View key={i} style={styles.howStep}>
                    <View style={styles.howStepLeft}>
                      <View style={[styles.howStepIcon, { backgroundColor: S.light }]}>
                        <FontAwesome5 name={step.icon as any} size={13} color={S.color} solid />
                      </View>
                      {i < HOW_IT_WORKS.employers.length - 1 && <View style={styles.howStepLine} />}
                    </View>
                    <View style={styles.howStepBody}>
                      <Text style={styles.howStepTitle}>{step.title}</Text>
                      <Text style={styles.howStepText}>{step.body}</Text>
                    </View>
                  </View>
                ))}
              </View>
              <TouchableOpacity
                style={[styles.howActionBtn, { marginTop: 12 }]}
                onPress={() => { Haptics.selectionAsync(); onPostShift(); }}
                activeOpacity={0.8}
              >
                <FontAwesome5 name="plus" size={12} color={S.color} />
                <Text style={[styles.howActionText, { color: S.color }]}>Post your first shift</Text>
              </TouchableOpacity>
            </>
          )
        )}

        {/* Employer upsell — shown to non-employers once their data has loaded */}
        {!loadingMyData && !hasEmployerProfile && (
          <TouchableOpacity
            style={styles.employerUpsell}
            onPress={() => { Haptics.selectionAsync(); router.push('/employer-profile'); }}
            activeOpacity={0.8}
          >
            <FontAwesome5 name="building" size={12} color={colors.textMuted} />
            <Text style={styles.employerUpsellText}>
              Hiring or organising in Shetland? Set up your employer profile →
            </Text>
          </TouchableOpacity>
        )}

      </View>

      {/* ── Boost promo ── */}
      <View style={styles.boostPromoCard}>
        <View style={styles.boostPromoCardTop}>
          <View style={styles.boostPromoCardIcon}>
            <FontAwesome5 name="bolt" size={16} color={colors.shifts} solid />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.boostPromoCardTitle}>Get seen by the right workers</Text>
            <Text style={styles.boostPromoCardSub}>
              Boost your shift for £2.99 — pinned to the top, every matching worker alerted instantly.
            </Text>
          </View>
        </View>
        <View style={styles.boostPromoCardBullets}>
          {[
            '⚡  Instantly alert matching workers',
            '📌  Pinned to the top of the list for 24 hrs',
            '📊  Workers set preferences — you reach the right people',
          ].map((b, i) => (
            <Text key={i} style={styles.boostPromoCardBullet}>{b}</Text>
          ))}
        </View>
        <TouchableOpacity
          style={styles.boostPromoCardBtn}
          onPress={() => { Haptics.selectionAsync(); onPostShift(); }}
          activeOpacity={0.85}
        >
          <FontAwesome5 name="plus" size={11} color={colors.shifts} />
          <Text style={styles.boostPromoCardBtnText}>Post a shift and boost it</Text>
        </TouchableOpacity>
      </View>

      {/* Empty state for Latest shifts — shown only when there's nothing to preview */}
      {!loadingPreview && previewShifts.length === 0 && (
        <View style={styles.section}>
          <View style={styles.previewEmpty}>
            <Text style={styles.previewEmptyText}>No shifts posted yet — be the first!</Text>
            <TouchableOpacity onPress={onPostShift} activeOpacity={0.8}>
              <Text style={[styles.sectionLink, { color: S.color }]}>Post a shift →</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

// ── Main tab screen ────────────────────────────────────────────────────────────

export default function ShiftsTab() {
  const [mode, setMode]               = useState<'hub' | 'post'>('hub');
  const [boostShiftId, setBoostShiftId] = useState<string | null>(null);
  const router = useRouter();

  const handlePostSuccess = (shiftId: string) => {
    setMode('hub');
    setBoostShiftId(shiftId);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>

      <TabScreenHeader
        section={S}
        right={
          mode === 'post' ? (
            <TouchableOpacity
              style={[styles.headerBadge, { backgroundColor: S.color + '22' }]}
              onPress={() => setMode('hub')}
              hitSlop={8}
            >
              <FontAwesome5 name="times" size={11} color={S.color} />
              <Text style={[styles.headerBadgeText, { color: S.color }]}>Cancel</Text>
            </TouchableOpacity>
          ) : (
            <View style={[styles.headerBadge, { backgroundColor: S.color + '22' }]}>
              <View style={[styles.headerBadgeDot, { backgroundColor: S.color }]} />
              <Text style={[styles.headerBadgeText, { color: S.color }]}>Live</Text>
            </View>
          )
        }
      >
        {mode === 'post' && (
          <Text style={styles.postFormSubtitle}>
            Free to post — boost for £2.99 to alert matching workers
          </Text>
        )}
      </TabScreenHeader>

      <View style={{ flex: 1 }}>
        {mode === 'hub'
          ? <HubScreen onPostShift={() => setMode('post')} />
          : <PostShiftForm onSuccess={handlePostSuccess} />
        }
      </View>

      {/* Boost sheet — shown after a successful post */}
      {boostShiftId && (
        <BoostSheet
          shiftId={boostShiftId}
          onDismiss={() => setBoostShiftId(null)}
          onBoosted={() => setBoostShiftId(null)}
        />
      )}

    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },

  headerBadgeRow:  { flexDirection: 'row', gap: 6 },
  headerBadge:     { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.full },
  headerBadgeText: { fontSize: 11, fontWeight: '700' },
  headerBadgeDot:  { width: 6, height: 6, borderRadius: 3 },
  postFormSubtitle: { color: 'rgba(255,255,255,0.5)', fontSize: fontSize.xs, marginTop: 2 },

  // ── Hub ────────────────────────────────────────────────────────────────────
  hubScroll:  { flex: 1, backgroundColor: colors.screenBackground },
  hubContent: { paddingBottom: 60 },
  hubContentTablet: { maxWidth: 760, alignSelf: 'center', width: '100%' },

  // Live strip
  liveStrip:     { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: spacing.md, paddingTop: 14, paddingBottom: 2 },
  liveStripDot:  { width: 7, height: 7, borderRadius: 3.5 },

  // ── Premium hero card ──
  heroCard: {
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
    backgroundColor: S.color,
    borderRadius: radius.xl,
    padding: spacing.md,
    gap: 14,
    shadowColor: S.color,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.28,
    shadowRadius: 14,
    elevation: 5,
  },
  heroTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  heroLabel: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1.5,
  },
  heroCount: {
    color: '#fff',
    fontSize: 52,
    fontWeight: '900',
    letterSpacing: -2,
    lineHeight: 56,
    marginTop: 2,
  },
  heroSub: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: fontSize.xs,
    fontWeight: '600',
    marginTop: 2,
  },
  heroIconWrap: {
    width: 56, height: 56, borderRadius: radius.lg,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
  },
  heroActions: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderRadius: radius.md,
    padding: 8,
  },
  heroAction: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingVertical: 4,
  },
  heroActionText: {
    color: '#fff',
    fontSize: fontSize.xs,
    fontWeight: '800',
  },
  heroActionDivider: {
    width: 1,
    height: 18,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  liveStripText: { fontSize: fontSize.xs, fontWeight: '700' },

  // Action tiles
  actionTiles: { flexDirection: 'row', gap: 12, paddingHorizontal: spacing.md, paddingVertical: spacing.md },
  actionTile: {
    flex: 1, borderRadius: radius.xl, padding: 16, gap: 6,
    shadowColor: '#0F1C26', shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.1, shadowRadius: 10, elevation: 3,
    minHeight: 140,
  },
  actionTilePrimary:  { backgroundColor: '#fff' },
  actionTileSecondary:{ backgroundColor: S.color },
  actionTileIcon:  { width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  actionTileTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary },
  actionTileSub:   { fontSize: fontSize.xs, color: colors.textMuted },

  // How it works
  section:       { paddingHorizontal: spacing.md, marginTop: spacing.lg },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  sectionTitle:  { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary, marginBottom: 12 },
  sectionLink:   { fontSize: fontSize.sm, fontWeight: '700' },

  howToggle: {
    flexDirection: 'row',
    backgroundColor: colors.border,
    borderRadius: radius.full, padding: 3, marginBottom: 16,
  },
  howToggleBtn: { flex: 1, paddingVertical: 7, borderRadius: radius.full, alignItems: 'center' },
  howToggleBtnActive: { backgroundColor: '#fff' },
  howToggleBtnText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textMuted },
  howToggleBtnTextActive: { color: colors.textPrimary },

  howSteps:    { gap: 0 },
  howStep:     { flexDirection: 'row', gap: 14 },
  howStepLeft: { alignItems: 'center', width: 34 },
  howStepIcon: { width: 34, height: 34, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  howStepLine: { flex: 1, width: 2, backgroundColor: colors.border, marginVertical: 4, marginTop: 6, marginBottom: 6 },
  howStepBody: { flex: 1, paddingBottom: 16 },
  howStepTitle:{ fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary, marginBottom: 2 },
  howStepText: { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 16 },

  howActions:    { flexDirection: 'row', gap: 8, marginTop: 12 },
  howActionBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 10, backgroundColor: S.light,
    borderRadius: radius.md, borderWidth: 1, borderColor: S.color + '44',
  },
  howActionText: { fontSize: fontSize.xs, fontWeight: '700' },

  // Boost promo card
  boostPromoCard: {
    marginHorizontal: spacing.md, marginTop: spacing.lg,
    backgroundColor: '#FFFBEB',
    borderRadius: radius.xl,
    borderWidth: 1.5, borderColor: '#FDE68A',
    padding: spacing.md, gap: 12,
  },
  boostPromoCardTop:    { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  boostPromoCardIcon:   { width: 40, height: 40, borderRadius: radius.md, backgroundColor: '#FEF3C7', alignItems: 'center', justifyContent: 'center' },
  boostPromoCardTitle:  { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary, marginBottom: 3 },
  boostPromoCardSub:    { fontSize: fontSize.xs, color: colors.textSecondary, lineHeight: 16 },
  boostPromoCardBullets:{ gap: 6 },
  boostPromoCardBullet: { fontSize: fontSize.xs, color: colors.textSecondary, lineHeight: 18 },
  boostPromoCardBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 10, borderRadius: radius.md,
    backgroundColor: '#FEF3C7', borderWidth: 1, borderColor: '#FDE68A',
  },
  boostPromoCardBtnText: { fontSize: fontSize.sm, fontWeight: '800', color: colors.shifts },

  // Preview cards
  previewList:      { gap: 10 },
  previewLoading:   { paddingVertical: 24, alignItems: 'center' },
  previewEmpty:     { paddingVertical: 20, alignItems: 'center', gap: 8 },
  previewEmptyText: { fontSize: fontSize.sm, color: colors.textMuted },
  previewCard: {
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    borderLeftWidth: 3,
    padding: 12, gap: 5,
    shadowColor: '#0F1C26',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05, shadowRadius: 4,
    elevation: 1,
  },
  previewCardTop:    { flexDirection: 'row', alignItems: 'center', gap: 6 },
  featuredBadge:     { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#FEF3C7', paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.full },
  featuredText:      { fontSize: 9, fontWeight: '800', color: colors.shifts },
  previewUrgency:    { paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.full },
  previewUrgencyText:{ fontSize: 9, fontWeight: '800' },
  previewCategory:   { fontSize: 10, color: colors.textMuted, fontWeight: '600', flex: 1 },
  previewTitle:      { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  previewMeta:       { flexDirection: 'row', alignItems: 'center', gap: 6 },
  previewMetaText:   { fontSize: fontSize.xs, color: colors.textMuted },
  previewMetaSep:    { color: colors.border, fontSize: fontSize.xs },
  previewPay:        { fontSize: fontSize.xs, fontWeight: '800' },

  // Contextual tab cards
  tabLoading:      { paddingVertical: 24, alignItems: 'center' },
  tabSectionLabel: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 },
  miniCardList:    { gap: 8 },
  miniCard: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: 12, gap: 4,
    borderWidth: 1, borderColor: colors.border,
  },
  miniCardTop:        { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2, flexWrap: 'wrap' },
  miniStatusBadge:    { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.full },
  miniStatusText:     { fontSize: 10, fontWeight: '800' },
  miniCardDate:       { fontSize: 10, color: colors.textMuted, fontWeight: '600', marginLeft: 'auto' as any },
  miniCardTitle:      { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  miniCardMeta:       { flexDirection: 'row', alignItems: 'center', gap: 5 },
  miniCardMetaText:   { fontSize: fontSize.xs, color: colors.textMuted },
  miniCardMetaSep:    { fontSize: fontSize.xs, color: colors.border },
  tabViewAllBtn:      { alignItems: 'center', paddingVertical: 10 },
  tabViewAllText:     { fontSize: fontSize.sm, fontWeight: '700' },
  employerUpsell:     { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16, paddingVertical: 10, paddingHorizontal: 12, backgroundColor: colors.border + '60', borderRadius: radius.md },
  employerUpsellText: { flex: 1, fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600', lineHeight: 16 },

  // My activity
  activityRow: { flexDirection: 'row', gap: 10 },
  activityBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    paddingVertical: 12, backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1.5, borderColor: colors.border,
  },
  activityBtnText: { fontSize: fontSize.sm, fontWeight: '700' },

  // ── Boost sheet ────────────────────────────────────────────────────────────
  boostOverlay:    { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  boostSheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: spacing.lg, paddingBottom: 40,
    alignItems: 'center', gap: 12,
  },
  boostSheetHandle: { width: 36, height: 4, backgroundColor: colors.border, borderRadius: 2, marginBottom: 4 },
  boostSheetIcon:   { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  boostSheetTitle:  { fontSize: fontSize.xl, fontWeight: '900', color: colors.textPrimary, textAlign: 'center' },
  boostSheetBody:   { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', lineHeight: 20, paddingHorizontal: 8 },
  boostPromoRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    width: '100%', backgroundColor: '#FFFBEB',
    borderRadius: radius.lg, padding: 14,
    borderWidth: 1, borderColor: '#FDE68A',
    marginTop: 4,
  },
  boostPromoIcon:    { width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  boostPromoTitle:   { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary, marginBottom: 2 },
  boostPromoSub:     { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 16 },
  boostBtn: {
    width: '100%', height: 52, borderRadius: radius.lg,
    backgroundColor: colors.shifts,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    marginTop: 4,
  },
  savedCardNote: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    backgroundColor: colors.jobsLight, borderRadius: radius.md,
    paddingHorizontal: 12, paddingVertical: 7, marginBottom: 4,
  },
  savedCardNoteText: { fontSize: fontSize.xs, color: colors.jobs, fontWeight: '700' },
  boostBtnText:  { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
  boostSkipBtn:  { paddingVertical: 6 },
  boostSkipText: { color: colors.textMuted, fontSize: fontSize.sm, fontWeight: '600' },

  // ── Post shift form ────────────────────────────────────────────────────────
  formScroll:  { flex: 1, backgroundColor: colors.screenBackground },
  formContent: { padding: spacing.md, paddingBottom: 120 },
  fieldGroup:  { marginBottom: spacing.lg },
  fieldLabel:  { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary, marginBottom: 8 },
  fieldHint:   { fontSize: fontSize.xs, color: colors.textMuted, marginBottom: 10, lineHeight: 16 },

  inputWrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#fff', borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, height: 46,
  },
  inputPrefix: { color: colors.textMuted, fontSize: fontSize.md, marginRight: 4, fontWeight: '600' },
  input:       { flex: 1, color: colors.textPrimary, fontSize: fontSize.sm },

  categoryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  categoryCard: {
    width: '30%', alignItems: 'center', justifyContent: 'center',
    gap: 6, padding: 10, backgroundColor: '#fff',
    borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border, minHeight: 68,
  },
  categoryLabel: { fontSize: 10, fontWeight: '600', color: colors.textMuted, textAlign: 'center', lineHeight: 13 },

  urgencyRow: { flexDirection: 'row', gap: 8 },
  urgencyBtn: {
    flex: 1, flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: 4, paddingVertical: 10, backgroundColor: '#fff',
    borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border,
  },
  urgencyText: { fontSize: 10, fontWeight: '600', color: colors.textMuted },

  payTypeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  payTypeBtn: { paddingHorizontal: 14, paddingVertical: 8, backgroundColor: '#fff', borderRadius: radius.full, borderWidth: 1.5, borderColor: colors.border },
  payTypeText:{ fontSize: fontSize.xs, fontWeight: '600', color: colors.textMuted },

  positionsRow: { flexDirection: 'row', gap: 8 },
  posBtn: { flex: 1, paddingVertical: 10, alignItems: 'center', backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border },
  posBtnText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textMuted },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 7,
    backgroundColor: '#fff', borderRadius: radius.full, borderWidth: 1.5, borderColor: colors.border,
  },
  chipText: { fontSize: fontSize.xs, fontWeight: '600', color: colors.textMuted },

  submitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: S.color, borderRadius: radius.lg, height: 52, marginTop: 8,
  },
  submitText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },

  pickerField: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, paddingVertical: 12,
  },
  pickerFieldLabel: { fontSize: 10, fontWeight: '600', color: colors.textMuted, marginBottom: 2 },
  pickerFieldValue: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  datePickerGrid:   { flexDirection: 'row', gap: 8, marginBottom: 8 },
  multiDayRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#fff', borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, paddingVertical: 10, marginBottom: 8, gap: 10,
  },
  multiDayLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  multiDayHint:  { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },

  locationSelected: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: S.light, borderRadius: radius.md,
    paddingHorizontal: 14, paddingVertical: 12,
    borderWidth: 1.5, borderColor: S.color + '55',
  },
  locationSelectedText: { flex: 1, fontSize: fontSize.sm, fontWeight: '600', color: colors.textPrimary, lineHeight: 18 },
  locationClear: { marginLeft: 'auto' as any },

  timePicker: {
    flexDirection: 'row', alignItems: 'flex-start',
    paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xl,
    gap: 16, height: 260,
  },
  timePickerSide:        { flex: 1, alignItems: 'center', gap: 6 },
  timePickerColLabel:    { fontSize: fontSize.xs, fontWeight: '700', color: colors.textMuted, marginBottom: 4 },
  timePickerScroll:      { width: '100%', height: 200 },
  timePickerItem:        { height: HOUR_ITEM_H, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  timePickerItemText:    { fontSize: 26, color: colors.textPrimary, fontWeight: '600' },
  timePickerColon:       { fontSize: 30, fontWeight: '800', color: colors.textPrimary, marginTop: 42 },
  timePickerMinutes:     { width: '100%', gap: 8 },
  timePickerMinuteBtn:   { height: 46, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border, backgroundColor: '#fff' },
  timePickerMinuteBtnText: { fontSize: 20, fontWeight: '600', color: colors.textMuted },

  pickerOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  pickerSheet:   { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 32 },
  pickerSheetHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  pickerCancel: { fontSize: fontSize.sm, color: colors.textMuted, fontWeight: '600' },
  pickerTitle:  { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  pickerDone:   { fontSize: fontSize.sm, fontWeight: '800' },
});
