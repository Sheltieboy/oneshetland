/**
 * The opening-hours editor (app). RN twin of the web component.
 *
 * Writes the canonical "HH:MM-HH:MM" (or "Closed") that the visitor planner
 * can reason about — free text like "when the boat's in" reads fine on a
 * listing but can't answer "open at 14:20 on a Tuesday", which is the whole
 * question a planner has to settle.
 *
 * Three states per day, deliberately: open with times, explicitly Closed, or
 * blank. Blank means "not told us" and is NOT the same as closed — a day left
 * blank must never turn folk away from a shop that's actually open.
 */

import React, { useState } from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, radius, spacing } from '@/constants/theme';
import {
  CLOSED, DAYS, formatDay, fromHM, parseRange, toHM,
  type DayKey, type OpeningHoursMap,
} from '@/lib/opening-hours';

type Editing = { day: DayKey; which: 'open' | 'close' } | null;

export function OpeningHoursEditor({
  value,
  onChange,
  accent,
}: {
  value: OpeningHoursMap;
  onChange: (next: OpeningHoursMap) => void;
  accent: string;
}) {
  const [editing, setEditing] = useState<Editing>(null);
  const [draft, setDraft] = useState<Date>(new Date());

  const partsFor = (day: DayKey) => {
    const raw = value[day];
    const range = parseRange(raw);
    if (!range) return { open: '09:00', close: '17:00' };
    const fmt = (m: number) => fromHM(Math.floor(m / 60) % 24, m % 60);
    return { open: fmt(range.open), close: fmt(range.close) };
  };

  const write = (day: DayKey, next: string | null) => {
    const out = { ...value };
    if (next === null) delete out[day]; else out[day] = next;
    onChange(out);
  };

  const openPicker = (day: DayKey, which: 'open' | 'close') => {
    const p = partsFor(day);
    const { h, m } = toHM(which === 'open' ? p.open : p.close);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    setDraft(d);
    setEditing({ day, which });
    Haptics.selectionAsync();
  };

  const confirmPicker = () => {
    if (!editing) return;
    const p = partsFor(editing.day);
    const picked = fromHM(draft.getHours(), draft.getMinutes());
    const open = editing.which === 'open' ? picked : p.open;
    const close = editing.which === 'close' ? picked : p.close;
    write(editing.day, `${open}-${close}`);
    setEditing(null);
  };

  const copyDown = (from: DayKey) => {
    const source = value[from];
    if (!source) return;
    Haptics.selectionAsync();
    const out = { ...value };
    let started = false;
    for (const d of DAYS) {
      if (d.key === from) { started = true; continue; }
      if (started) out[d.key] = source;
    }
    onChange(out);
  };

  return (
    <View style={styles.wrap}>
      {DAYS.map(d => {
        const raw = value[d.key];
        const isClosed = !!raw && raw.trim().toLowerCase() === CLOSED.toLowerCase();
        const range = parseRange(raw);
        const parts = partsFor(d.key);

        return (
          <View key={d.key} style={styles.row}>
            <Text style={styles.day}>{d.short}</Text>

            {!raw ? (
              <>
                <Text style={styles.unset}>Not set</Text>
                <TouchableOpacity style={styles.pill} onPress={() => write(d.key, '09:00-17:00')}>
                  <Text style={styles.pillText}>Set hours</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.pill} onPress={() => write(d.key, CLOSED)}>
                  <Text style={styles.pillText}>Closed</Text>
                </TouchableOpacity>
              </>
            ) : isClosed ? (
              <>
                <Text style={styles.closedText}>Closed</Text>
                <TouchableOpacity style={styles.pill} onPress={() => write(d.key, '09:00-17:00')}>
                  <Text style={styles.pillText}>Open</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => write(d.key, null)}>
                  <Text style={styles.clear}>Clear</Text>
                </TouchableOpacity>
              </>
            ) : range ? (
              <>
                <TouchableOpacity style={styles.time} onPress={() => openPicker(d.key, 'open')}>
                  <Text style={[styles.timeText, { color: accent }]}>{parts.open}</Text>
                </TouchableOpacity>
                <Text style={styles.to}>to</Text>
                <TouchableOpacity style={styles.time} onPress={() => openPicker(d.key, 'close')}>
                  <Text style={[styles.timeText, { color: accent }]}>{parts.close}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.pill} onPress={() => write(d.key, CLOSED)}>
                  <Text style={styles.pillText}>Closed</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => copyDown(d.key)}>
                  <Text style={[styles.clear, { color: accent }]}>Copy down</Text>
                </TouchableOpacity>
              </>
            ) : (
              // Legacy free text — shown as written, replaceable with real times.
              <>
                <Text style={styles.legacy} numberOfLines={1}>{formatDay(raw)}</Text>
                <TouchableOpacity style={styles.pill} onPress={() => write(d.key, '09:00-17:00')}>
                  <Text style={styles.pillText}>Use times</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        );
      })}

      <Text style={styles.footnote}>
        A day left as “Not set” just means you haven’t said — it won’t show as closed. Closing after midnight
        is fine: put the time as it reads on the door.
      </Text>

      <Modal visible={!!editing} transparent animationType="fade" onRequestClose={() => setEditing(null)}>
        <View style={styles.modalWrap}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              {editing ? `${DAYS.find(x => x.key === editing.day)?.label} — ${editing.which === 'open' ? 'opens' : 'closes'}` : ''}
            </Text>
            <DateTimePicker
              value={draft}
              mode="time"
              display="spinner"
              onChange={(_, date) => date && setDraft(date)}
            />
            <View style={styles.modalRow}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => setEditing(null)}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalOk, { backgroundColor: accent }]} onPress={confirmPicker}>
                <Text style={styles.modalOkText}>Done</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap',
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: 12, paddingVertical: 10, backgroundColor: '#fff',
  },
  day:        { width: 38, fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  unset:      { flex: 1, fontSize: fontSize.sm, color: colors.textLight },
  closedText: { flex: 1, fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary },
  legacy:     { flex: 1, fontSize: fontSize.xs, color: colors.textMuted },
  time:       { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 6 },
  timeText:   { fontSize: fontSize.sm, fontWeight: '800' },
  to:         { fontSize: fontSize.xs, color: colors.textMuted },
  pill:       { borderWidth: 1, borderColor: colors.border, borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 6 },
  pillText:   { fontSize: fontSize.xs, fontWeight: '700', color: colors.textSecondary },
  clear:      { fontSize: fontSize.xs, fontWeight: '700', color: colors.textLight, textDecorationLine: 'underline' },
  footnote:   { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 16, marginTop: 2 },

  modalWrap:  { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  modalCard:  { backgroundColor: '#fff', borderRadius: radius.lg, padding: spacing.lg, width: '100%', maxWidth: 360 },
  modalTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, textAlign: 'center' },
  modalRow:   { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  modalCancel:     { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: radius.full, borderWidth: 1, borderColor: colors.border },
  modalCancelText: { fontWeight: '800', color: colors.textPrimary, fontSize: fontSize.sm },
  modalOk:     { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: radius.full },
  modalOkText: { fontWeight: '800', color: '#fff', fontSize: fontSize.sm },
});
