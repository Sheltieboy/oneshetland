/**
 * EventsCalendar
 *
 * A month grid for the What's On tab. Days with events show a coloured dot and
 * a small count; today is ringed; the selected day is filled. Month nav arrows
 * page through. Purely presentational — the parent supplies events bucketed by
 * day-key and handles selection.
 */

import React, { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius } from '@/constants/theme';

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

/** Local YYYY-M-D key (month/day un-padded — matches dayKey()). */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

interface Props {
  monthDate:   Date;                       // any date within the displayed month
  counts:      Record<string, number>;     // dayKey → event count
  selectedKey: string | null;
  onSelectDay: (key: string, date: Date) => void;
  onChangeMonth: (delta: number) => void;
  color:       string;
}

export function EventsCalendar({ monthDate, counts, selectedKey, onSelectDay, onChangeMonth, color }: Props) {
  const todayKey = dayKey(new Date());
  const year  = monthDate.getFullYear();
  const month = monthDate.getMonth();

  const cells = useMemo(() => {
    const first = new Date(year, month, 1);
    // JS getDay(): 0=Sun … 6=Sat. We want Monday-start, so shift.
    const lead = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const out: (Date | null)[] = [];
    for (let i = 0; i < lead; i++) out.push(null);
    for (let d = 1; d <= daysInMonth; d++) out.push(new Date(year, month, d));
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [year, month]);

  return (
    <View style={styles.wrap}>
      {/* Month header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => onChangeMonth(-1)} hitSlop={12} style={styles.navBtn}>
          <FontAwesome5 name="chevron-left" size={15} color={color} />
        </TouchableOpacity>
        <Text style={styles.monthTitle}>{MONTHS[month]} {year}</Text>
        <TouchableOpacity onPress={() => onChangeMonth(1)} hitSlop={12} style={styles.navBtn}>
          <FontAwesome5 name="chevron-right" size={15} color={color} />
        </TouchableOpacity>
      </View>

      {/* Weekday row */}
      <View style={styles.weekRow}>
        {WEEKDAYS.map(w => <Text key={w} style={styles.weekday}>{w}</Text>)}
      </View>

      {/* Day grid */}
      <View style={styles.grid}>
        {cells.map((date, i) => {
          if (!date) return <View key={`b${i}`} style={styles.cell} />;
          const key = dayKey(date);
          const count = counts[key] ?? 0;
          const isToday = key === todayKey;
          const isSelected = key === selectedKey;
          return (
            <TouchableOpacity
              key={key}
              style={styles.cell}
              activeOpacity={count ? 0.7 : 1}
              onPress={() => onSelectDay(key, date)}
            >
              <View style={[
                styles.dayInner,
                isToday && { borderColor: color, borderWidth: 1.5 },
                isSelected && { backgroundColor: color },
              ]}>
                <Text style={[
                  styles.dayNum,
                  isSelected && { color: '#fff' },
                  !count && !isSelected && { color: colors.textLight },
                ]}>{date.getDate()}</Text>
                {count > 0 && (
                  <View style={[styles.dot, { backgroundColor: isSelected ? '#fff' : color }]}>
                    <Text style={[styles.dotText, { color: isSelected ? color : '#fff' }]}>{count}</Text>
                  </View>
                )}
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing.md, margin: spacing.md,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
  navBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  monthTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary },

  weekRow: { flexDirection: 'row', marginBottom: 4 },
  weekday: { flex: 1, textAlign: 'center', fontSize: 10, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase' },

  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: `${100 / 7}%`, aspectRatio: 1, alignItems: 'center', justifyContent: 'center', padding: 2 },
  dayInner: {
    width: '92%', height: '92%', borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center', gap: 2,
  },
  dayNum: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  dot: { minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  dotText: { fontSize: 9, fontWeight: '900' },
});
