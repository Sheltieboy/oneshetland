import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Switch,
  Platform,
} from 'react-native';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '@/context/AuthContext';
import { Input, KeyboardDoneBar } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { FormScrollView } from '@/components/ui/FormScrollView';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { useAlert } from '@/components/BrandedAlert';
import { REGIONS } from '@/constants/regions';
import { DELIVERY_CATEGORIES } from '@/constants/categories';
import { colors, fontSize, spacing, radius } from '@/constants/theme';

// ─── helpers ────────────────────────────────────────────────────────────────

function roundUpToNextHour(d: Date): Date {
  const r = new Date(d);
  r.setMinutes(0, 0, 0);
  r.setHours(r.getHours() + 1);
  return r;
}

function addHours(d: Date, h: number): Date {
  return new Date(d.getTime() + h * 60 * 60 * 1000);
}

function formatDateTime(d: Date): string {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  let dayStr: string;
  if (d.toDateString() === today.toDateString()) {
    dayStr = 'Today';
  } else if (d.toDateString() === tomorrow.toDateString()) {
    dayStr = 'Tomorrow';
  } else {
    dayStr = d.toLocaleDateString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
  }

  const timeStr = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${dayStr}, ${timeStr}`;
}

// ─── types ───────────────────────────────────────────────────────────────────

interface RunForm {
  originRegionSlug: string;
  destinationRegionSlug: string;
  destinationArea: string;
  departureStart: Date;
  departureEnd: Date;
  categoriesAccepted: string[];
  ferryCrossing: boolean;
  notes: string;
}

function makeInitialForm(): RunForm {
  const start = roundUpToNextHour(new Date());
  return {
    originRegionSlug: 'lerwick',
    destinationRegionSlug: '',
    destinationArea: '',
    departureStart: start,
    departureEnd: addHours(start, 2),
    categoriesAccepted: [],
    ferryCrossing: false,
    notes: '',
  };
}

// ─── component ───────────────────────────────────────────────────────────────

export default function CreateRunScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const { alert } = useAlert();

  const [form, setForm]           = useState<RunForm>(makeInitialForm);
  const [errors, setErrors]       = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [bankConnected, setBankConnected] = useState<boolean | null>(null);

  // Check bank connection on mount
  useEffect(() => {
    if (!profile?.id) return;
    supabase
      .from('driver_profiles')
      .select('stripe_onboarding_complete, stripe_payouts_enabled')
      .eq('id', profile.id)
      .single()
      .then(({ data }) => {
        setBankConnected(
          !!(data?.stripe_onboarding_complete && data?.stripe_payouts_enabled)
        );
      });
  }, [profile?.id]);
  const [originPickerOpen, setOriginPickerOpen] = useState(false);
  const [destPickerOpen, setDestPickerOpen] = useState(false);

  // Which date/time picker is visible: null | 'start' | 'end'
  const [activePicker, setActivePicker] = useState<null | 'start' | 'end'>(null);

  function update(patch: Partial<RunForm>) {
    setForm((prev) => ({ ...prev, ...patch }));
  }

  function toggleCategory(slug: string) {
    setForm((prev) => ({
      ...prev,
      categoriesAccepted: prev.categoriesAccepted.includes(slug)
        ? prev.categoriesAccepted.filter((s) => s !== slug)
        : [...prev.categoriesAccepted, slug],
    }));
  }

  function handleDateChange(event: DateTimePickerEvent, date?: Date) {
    if (Platform.OS === 'android') {
      // Android dismisses automatically on selection or cancel
      if (event.type === 'set' && date) {
        if (activePicker === 'start') {
          const newStart = date;
          update({
            departureStart: newStart,
            // Push end forward if it's now before start
            departureEnd: form.departureEnd <= newStart
              ? addHours(newStart, 2)
              : form.departureEnd,
          });
        } else if (activePicker === 'end') {
          update({ departureEnd: date });
        }
      }
      setActivePicker(null);
    } else {
      // iOS — picker stays open, update live
      if (date) {
        if (activePicker === 'start') {
          update({
            departureStart: date,
            departureEnd: form.departureEnd <= date
              ? addHours(date, 2)
              : form.departureEnd,
          });
        } else if (activePicker === 'end') {
          update({ departureEnd: date });
        }
      }
    }
  }

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!form.destinationRegionSlug) e.destination = 'Please select a destination region.';
    if (form.departureEnd <= form.departureStart)
      e.departureEnd = 'Latest time must be after earliest time.';
    if (form.categoriesAccepted.length === 0)
      e.categories = 'Please select at least one category you can carry.';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSubmit() {
    if (!validate()) return;

    if (!isSupabaseConfigured) {
      alert({ title: 'Supabase not configured', message: 'Add your keys to .env.' });
      return;
    }

    if (!profile?.id) {
      alert({ title: 'Error', message: 'You must be signed in to create a run.' });
      return;
    }

    setSubmitting(true);

    const { error } = await supabase.from('runs').insert({
      driver_id: profile.id,
      origin_region_id: null,       // TODO: resolve slug → UUID
      destination_region_id: null,  // TODO: resolve slug → UUID
      destination_area: form.destinationArea || null,
      departure_start: form.departureStart.toISOString(),
      departure_end: form.departureEnd.toISOString(),
      categories_accepted: form.categoriesAccepted,
      ferry_crossing: form.ferryCrossing,
      notes: [
        `Origin: ${form.originRegionSlug}`,
        `Destination: ${form.destinationRegionSlug}`,
        form.notes,
      ]
        .filter(Boolean)
        .join('\n') || null,
      status: 'open',
    });

    setSubmitting(false);

    if (error) {
      alert({ title: 'Could not create run', message: error.message });
      return;
    }

    alert({
      title: 'Run created! 🚗',
      message: 'Your run is now visible to customers. Matched requests will appear on your dashboard.',
      actions: [
        { label: 'Back to dashboard', style: 'primary', onPress: () => router.replace('/(driver)/dashboard') },
      ],
    });
  }

  const originRegion = REGIONS.find((r) => r.slug === form.originRegionSlug);
  const destRegion = REGIONS.find((r) => r.slug === form.destinationRegionSlug);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardDoneBar />
      <FormScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Header */}
          <View style={styles.header}>
            <TouchableOpacity onPress={() => router.back()} style={styles.backLink}>
              <Text style={styles.backLinkText}>‹ Back</Text>
            </TouchableOpacity>
            <Text style={styles.title}>Create a run</Text>
            <Text style={styles.subtitle}>
              Tell customers where you're heading and when.
            </Text>
          </View>

          <View style={styles.form}>

            {/* Origin */}
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Origin (start point)</Text>
              <TouchableOpacity
                style={styles.regionSelector}
                onPress={() => {
                  setOriginPickerOpen((o) => !o);
                  setDestPickerOpen(false);
                  setActivePicker(null);
                }}
                activeOpacity={0.8}
              >
                <Text style={styles.regionSelectorText}>
                  {originRegion?.name ?? 'Select region…'}
                </Text>
                <Text style={styles.chevron}>{originPickerOpen ? '▲' : '▼'}</Text>
              </TouchableOpacity>
              {originPickerOpen && (
                <View style={styles.regionDropdown}>
                  <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled>
                    {REGIONS.map((r) => (
                      <TouchableOpacity
                        key={r.slug}
                        style={[
                          styles.regionOption,
                          form.originRegionSlug === r.slug && styles.regionOptionSelected,
                        ]}
                        onPress={() => {
                          update({ originRegionSlug: r.slug });
                          setOriginPickerOpen(false);
                        }}
                      >
                        <Text
                          style={[
                            styles.regionOptionText,
                            form.originRegionSlug === r.slug && styles.regionOptionTextSelected,
                          ]}
                        >
                          {r.name}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>
              )}
            </View>

            {/* Destination */}
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Destination region</Text>
              <TouchableOpacity
                style={[
                  styles.regionSelector,
                  errors.destination && styles.regionSelectorError,
                ]}
                onPress={() => {
                  setDestPickerOpen((o) => !o);
                  setOriginPickerOpen(false);
                  setActivePicker(null);
                }}
                activeOpacity={0.8}
              >
                <Text
                  style={[
                    styles.regionSelectorText,
                    !destRegion && styles.regionSelectorPlaceholder,
                  ]}
                >
                  {destRegion?.name ?? 'Select region…'}
                </Text>
                <Text style={styles.chevron}>{destPickerOpen ? '▲' : '▼'}</Text>
              </TouchableOpacity>
              {errors.destination && (
                <Text style={styles.fieldError}>{errors.destination}</Text>
              )}
              {destPickerOpen && (
                <View style={styles.regionDropdown}>
                  <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled>
                    {REGIONS.map((r) => (
                      <TouchableOpacity
                        key={r.slug}
                        style={[
                          styles.regionOption,
                          form.destinationRegionSlug === r.slug && styles.regionOptionSelected,
                        ]}
                        onPress={() => {
                          update({ destinationRegionSlug: r.slug });
                          setDestPickerOpen(false);
                          if (errors.destination) setErrors((e) => ({ ...e, destination: '' }));
                        }}
                      >
                        <Text
                          style={[
                            styles.regionOptionText,
                            form.destinationRegionSlug === r.slug && styles.regionOptionTextSelected,
                          ]}
                        >
                          {r.name}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>
              )}
            </View>

            <Input
              label="Destination area / village (optional)"
              value={form.destinationArea}
              onChangeText={(v) => update({ destinationArea: v })}
              placeholder="e.g. Mid Yell, Uyeasound"
            />

            {/* Departure — earliest */}
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Departure — earliest time</Text>
              <TouchableOpacity
                style={styles.dateButton}
                onPress={() => {
                  setActivePicker(activePicker === 'start' ? null : 'start');
                  setOriginPickerOpen(false);
                  setDestPickerOpen(false);
                }}
                activeOpacity={0.8}
              >
                <Text style={styles.dateButtonText}>
                  🕐  {formatDateTime(form.departureStart)}
                </Text>
                <Text style={styles.chevron}>{activePicker === 'start' ? '▲' : '▼'}</Text>
              </TouchableOpacity>
              {activePicker === 'start' && (
                <DateTimePicker
                  value={form.departureStart}
                  mode="datetime"
                  display={Platform.OS === 'ios' ? 'inline' : 'default'}
                  minimumDate={new Date()}
                  onChange={handleDateChange}
                  style={styles.inlinePicker}
                />
              )}
            </View>

            {/* Departure — latest */}
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Departure — latest time</Text>
              <TouchableOpacity
                style={[styles.dateButton, errors.departureEnd && styles.dateButtonError]}
                onPress={() => {
                  setActivePicker(activePicker === 'end' ? null : 'end');
                  setOriginPickerOpen(false);
                  setDestPickerOpen(false);
                }}
                activeOpacity={0.8}
              >
                <Text style={styles.dateButtonText}>
                  🕓  {formatDateTime(form.departureEnd)}
                </Text>
                <Text style={styles.chevron}>{activePicker === 'end' ? '▲' : '▼'}</Text>
              </TouchableOpacity>
              {errors.departureEnd && (
                <Text style={styles.fieldError}>{errors.departureEnd}</Text>
              )}
              {activePicker === 'end' && (
                <DateTimePicker
                  value={form.departureEnd}
                  mode="datetime"
                  display={Platform.OS === 'ios' ? 'inline' : 'default'}
                  minimumDate={form.departureStart}
                  onChange={handleDateChange}
                  style={styles.inlinePicker}
                />
              )}
            </View>

            {/* Categories */}
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Categories I can carry</Text>
              <Text style={styles.fieldHint}>Select all that apply.</Text>
              {errors.categories && (
                <Text style={styles.fieldError}>{errors.categories}</Text>
              )}
              <View style={styles.checkGrid}>
                {DELIVERY_CATEGORIES.map((cat) => {
                  const selected = form.categoriesAccepted.includes(cat.slug);
                  return (
                    <TouchableOpacity
                      key={cat.slug}
                      style={[styles.checkChip, selected && styles.checkChipSelected]}
                      onPress={() => {
                        toggleCategory(cat.slug);
                        if (errors.categories) setErrors((e) => ({ ...e, categories: '' }));
                      }}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.checkIcon}>{cat.icon}</Text>
                      <Text
                        style={[styles.checkLabel, selected && styles.checkLabelSelected]}
                        numberOfLines={2}
                      >
                        {cat.name}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {/* Ferry crossing toggle */}
            <View style={styles.toggleRow}>
              <View style={styles.toggleLabel}>
                <Text style={styles.toggleTitle}>Ferry crossing involved</Text>
                <Text style={styles.toggleSub}>
                  Tick if your route involves a Shetland ferry crossing.
                </Text>
              </View>
              <Switch
                value={form.ferryCrossing}
                onValueChange={(v) => update({ ferryCrossing: v })}
                trackColor={{ false: colors.border, true: colors.accent }}
                thumbColor={colors.white}
              />
            </View>

            <Input
              label="Additional notes (optional)"
              value={form.notes}
              onChangeText={(v) => update({ notes: v })}
              placeholder="e.g. car boot space only, fragile items OK, timing flexibility"
              multiline
              numberOfLines={3}
              style={{ height: 80, textAlignVertical: 'top' }}
            />

            {bankConnected === false && (
              <TouchableOpacity
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onPress={() => router.push('/(driver)/connect-bank' as any)}
                style={styles.bankWarning}
              >
                <Text style={styles.bankWarningText}>
                  🏦 You need to connect your bank account before creating a run
                </Text>
                <Text style={styles.bankWarningLink}>Set up now →</Text>
              </TouchableOpacity>
            )}

            <Button
              label="Create run"
              onPress={handleSubmit}
              loading={submitting}
              disabled={bankConnected === false}
              variant="secondary"
              size="lg"
              fullWidth
              style={styles.submitButton}
            />

            <Text style={styles.disclaimer}>
              Only approved drivers may create runs. By submitting you confirm you hold a valid
              UK driving licence and appropriate vehicle insurance.
            </Text>
          </View>
      </FormScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  content: {
    backgroundColor: colors.screenBackground,
    paddingBottom: spacing.xxl,
    flexGrow: 1,
  },
  header: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
  },
  backLink: { marginBottom: spacing.md },
  backLinkText: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.sm, fontWeight: '500' },
  title: {
    color: colors.white,
    fontSize: fontSize.xxl,
    fontWeight: '800',
    marginBottom: spacing.sm,
  },
  subtitle: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: fontSize.sm,
    lineHeight: 20,
  },

  form: { padding: spacing.lg },

  fieldGroup: { marginBottom: spacing.md },
  fieldLabel: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.navy,
    marginBottom: 6,
  },
  fieldHint: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  fieldError: { fontSize: fontSize.xs, color: colors.error, marginTop: 4 },

  regionSelector: {
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: colors.white,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  regionSelectorError: { borderColor: colors.error },
  regionSelectorText: { fontSize: fontSize.md, color: colors.textPrimary },
  regionSelectorPlaceholder: { color: colors.textLight },
  chevron: { color: colors.textMuted, fontSize: 12 },
  regionDropdown: {
    marginTop: 4,
    borderWidth: 1.5,
    borderColor: colors.borderFocus,
    borderRadius: radius.md,
    backgroundColor: colors.white,
    overflow: 'hidden',
  },
  regionOption: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  regionOptionSelected: { backgroundColor: '#F0FBFF' },
  regionOptionText: { fontSize: fontSize.md, color: colors.textPrimary },
  regionOptionTextSelected: { color: colors.accent, fontWeight: '600' },

  dateButton: {
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: colors.white,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dateButtonError: { borderColor: colors.error },
  dateButtonText: {
    fontSize: fontSize.md,
    color: colors.textPrimary,
  },
  inlinePicker: {
    marginTop: 4,
    backgroundColor: colors.white,
    borderRadius: radius.md,
  },

  checkGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  checkChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.white,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.full,
    borderWidth: 1.5,
    borderColor: colors.border,
    maxWidth: '48%',
  },
  checkChipSelected: {
    borderColor: colors.accent,
    backgroundColor: '#F0FBFF',
  },
  checkIcon: { fontSize: 16 },
  checkLabel: {
    fontSize: fontSize.sm,
    color: colors.textPrimary,
    fontWeight: '500',
    flexShrink: 1,
  },
  checkLabelSelected: { color: colors.accent },

  toggleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  toggleLabel: { flex: 1 },
  toggleTitle: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.navy,
    marginBottom: 4,
  },
  toggleSub: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    lineHeight: 18,
  },

  bankWarning: {
    backgroundColor: '#FFF7ED',
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: '#FED7AA',
    alignItems: 'center',
    gap: 4,
  },
  bankWarningText: {
    fontSize: fontSize.sm,
    color: '#92400E',
    fontWeight: '600',
    textAlign: 'center',
  },
  bankWarningLink: {
    fontSize: fontSize.sm,
    color: '#B45309',
    fontWeight: '700',
  },
  submitButton: { marginBottom: spacing.sm },
  disclaimer: {
    fontSize: fontSize.xs,
    color: colors.textLight,
    textAlign: 'center',
    lineHeight: 18,
  },
});
