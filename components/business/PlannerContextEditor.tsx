/**
 * PlannerContextEditor — "Appearing in visitors' plans", app side.
 *
 * The RN twin of the web component. The context the day planner needs and
 * cannot infer: how long people stay, indoors or out, what it's good for,
 * whether to book, and one plain line about what a visitor actually does here.
 *
 * Structured first, one short line of prose second, and that ordering is the
 * whole design. Asked for a paragraph, every business writes an advert, and an
 * advert is precisely what a planner can't reason over. Chips and a number can
 * be reasoned over; "a warm welcome awaits" cannot.
 *
 * The visitor-ready switch is three-state on purpose. Not-said is not the same
 * as no: an owner who never opens this form keeps appearing exactly as today,
 * and only an explicit no takes them out.
 */

import React from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, radius, spacing } from '@/constants/theme';
import {
  BOOKINGS, DWELL_CHOICES, GOOD_FOR, NOTE_MAX, SETTINGS,
  type PlannerContext,
} from '@/constants/planner-context';

export function PlannerContextEditor({
  value,
  onChange,
  accent,
}: {
  value: PlannerContext;
  onChange: (next: PlannerContext) => void;
  accent: string;
}) {
  const set = <K extends keyof PlannerContext>(k: K, v: PlannerContext[K]) => {
    Haptics.selectionAsync();
    onChange({ ...value, [k]: v });
  };

  const ready = value.planner_visitor_ready;
  const chips = value.planner_good_for ?? [];
  const noteLeft = NOTE_MAX - (value.planner_note?.length ?? 0);

  const Pill = ({ on, label, onPress }: { on: boolean; label: string; onPress: () => void }) => (
    <TouchableOpacity
      style={[styles.pill, on && { backgroundColor: accent, borderColor: accent }]}
      onPress={onPress}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
    >
      <Text style={[styles.pillText, on && styles.pillTextOn]}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Appearing in visitors&apos; plans</Text>
      <Text style={styles.blurb}>
        OneShetland builds visitors a day out — what to see, where to eat, in an order that
        works. This is what it needs to know about you. It takes a minute and it&apos;s the
        difference between being suggested and being skipped.
      </Text>

      {/* Three states, and the middle one is the default for a reason. */}
      <Text style={styles.label}>Should we send visitors your way?</Text>
      <View style={styles.pills}>
        <Pill on={ready === true}  label="Yes, we're worth a visit"     onPress={() => set('planner_visitor_ready', true)} />
        <Pill on={ready === false} label="No — we're not that sort of place" onPress={() => set('planner_visitor_ready', false)} />
        <Pill on={ready == null}   label="Not said"                     onPress={() => set('planner_visitor_ready', null)} />
      </View>
      <Text style={styles.hint}>
        Say no if you&apos;re a trade counter, an office or anywhere a visitor turning up would be
        a nuisance. You&apos;ll still appear in the Directory either way.
      </Text>

      {ready !== false && (
        <>
          <Text style={styles.label}>How long do folk usually spend?</Text>
          <View style={styles.pills}>
            <Pill on={value.planner_dwell_minutes == null} label="Not said" onPress={() => set('planner_dwell_minutes', null)} />
            {DWELL_CHOICES.map(d => (
              <Pill
                key={d.minutes}
                on={value.planner_dwell_minutes === d.minutes}
                label={d.label}
                onPress={() => set('planner_dwell_minutes', d.minutes)}
              />
            ))}
          </View>
          <Text style={styles.hint}>
            This sets the times either side of you in someone&apos;s day, so a rough answer is
            worth far more than none.
          </Text>

          <Text style={styles.label}>Indoors or out?</Text>
          <View style={styles.pills}>
            {SETTINGS.map(s => (
              <Pill
                key={s.key}
                on={value.planner_setting === s.key}
                label={s.label}
                onPress={() => set('planner_setting', s.key)}
              />
            ))}
          </View>
          <Text style={styles.hint}>Lets us put you forward when the weather turns.</Text>

          <Text style={styles.label}>Good for…</Text>
          <View style={styles.pills}>
            {GOOD_FOR.map(g => {
              const on = chips.includes(g.key);
              return (
                <Pill
                  key={g.key}
                  on={on}
                  label={g.label}
                  onPress={() =>
                    set('planner_good_for', on ? chips.filter(c => c !== g.key) : [...chips, g.key])
                  }
                />
              );
            })}
          </View>

          <Text style={styles.label}>Do folk need to book?</Text>
          <View style={styles.pills}>
            {BOOKINGS.map(b => (
              <Pill
                key={b.key}
                on={value.planner_booking === b.key}
                label={b.label}
                onPress={() => set('planner_booking', b.key)}
              />
            ))}
          </View>

          <Text style={styles.label}>One line: what does a visitor actually do here?</Text>
          <TextInput
            style={styles.note}
            value={value.planner_note ?? ''}
            maxLength={NOTE_MAX}
            multiline
            placeholder="e.g. Hand-knitted Fair Isle you can watch being made, and a peerie café at the back."
            placeholderTextColor={colors.textMuted}
            onChangeText={t => onChange({ ...value, planner_note: t || null })}
          />
          <View style={styles.noteFoot}>
            <Text style={[styles.hint, { flex: 1 }]}>
              Not an advert — this is read by the planner, and it works far better on plain facts
              than on adjectives.
            </Text>
            <Text style={[styles.count, noteLeft < 20 && styles.countLow]}>{noteLeft}</Text>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.md, borderRadius: radius.lg,
    backgroundColor: colors.screenBackground,
    borderWidth: 1, borderColor: colors.border,
  },
  title: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary },
  blurb: { marginTop: 4, fontSize: fontSize.sm, lineHeight: 19, color: colors.textSecondary },

  label: {
    marginTop: spacing.md, marginBottom: 7,
    fontSize: fontSize.sm, fontWeight: '800', color: colors.textSecondary,
  },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  pill: {
    paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: radius.full, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.cardBackground,
  },
  pillText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textSecondary },
  pillTextOn: { color: '#fff' },

  hint: { marginTop: 6, fontSize: fontSize.xs, lineHeight: 16, color: colors.textMuted },

  note: {
    minHeight: 64, padding: 12, textAlignVertical: 'top',
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.cardBackground,
    fontSize: fontSize.sm, color: colors.textPrimary,
  },
  noteFoot: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  count: { marginTop: 6, fontSize: fontSize.xs, color: colors.textMuted },
  countLow: { fontWeight: '800', color: colors.warningDark },
});
