/**
 * TravelPlanner (app) — pick your exact home stop; see how to get TO the event
 * (arriving before it starts) and BACK home (last feasible connection). Runs the
 * transit engine on-device. Parity with the web TravelPlanner.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, TextInput, FlatList } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { STOP_OPTIONS, DEFAULT_STOP, defaultStopForArea, planThere, planHomeTo, type TravelResult } from '@/lib/transit-data';
import { FERRY_MORE_INFO } from '@/lib/ferry-timetable';
import type { TransitArea } from '@/lib/transit';

const STORAGE_KEY = 'os_home_stop';

export function TravelPlanner({
  eventArea,
  eventStop,
  startsAt,
  endsAt,
  accent,
  defaultArea,
}: {
  eventArea: TransitArea;
  eventStop: string | null;
  startsAt: string | null;
  endsAt?: string | null;
  accent: string;
  defaultArea?: TransitArea | null;
}) {
  const [home, setHome] = useState<string>(() => defaultStopForArea(defaultArea) || DEFAULT_STOP);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((saved) => {
      if (saved && STOP_OPTIONS.some((s) => s.id === saved)) setHome(saved);
    }).catch(() => {});
  }, []);
  const choose = (id: string) => {
    setHome(id); setOpen(false); setQuery('');
    AsyncStorage.setItem(STORAGE_KEY, id).catch(() => {});
  };

  const there = useMemo(() => planThere(home, eventArea, eventStop, startsAt), [home, eventArea, eventStop, startsAt]);
  const back = useMemo(() => planHomeTo(eventArea, eventStop, home, startsAt, endsAt), [home, eventArea, eventStop, startsAt, endsAt]);
  const homeName = STOP_OPTIONS.find((s) => s.id === home)?.name ?? 'your stop';

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? STOP_OPTIONS.filter((s) => s.name.toLowerCase().includes(q) || s.areaLabel.toLowerCase().includes(q)) : STOP_OPTIONS;
  }, [query]);

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Plan your journey</Text>
      <TouchableOpacity style={styles.stopBtn} onPress={() => setOpen(true)} activeOpacity={0.8}>
        <FontAwesome5 name="map-marker-alt" size={12} color={accent} solid />
        <Text style={styles.stopBtnText} numberOfLines={1}>My stop: {homeName}</Text>
        <FontAwesome5 name="chevron-down" size={11} color={colors.textMuted} />
      </TouchableOpacity>

      <TripCard title="Getting there" result={there} homeLabel={homeName} dir="there" />
      <TripCard title="Getting home" result={back} homeLabel={homeName} dir="home" />

      <Text style={styles.caveat}>Timetabled connections — no live feed yet. Times can change; check before you travel. {FERRY_MORE_INFO}</Text>

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={styles.modal} edges={['top', 'bottom']}>
          <View style={styles.modalHead}>
            <TextInput
              style={styles.search}
              placeholder="Search your stop…"
              placeholderTextColor={colors.textMuted}
              value={query}
              onChangeText={setQuery}
              autoFocus
              autoCorrect={false}
            />
            <TouchableOpacity onPress={() => setOpen(false)} hitSlop={12}><Text style={[styles.close, { color: accent }]}>Done</Text></TouchableOpacity>
          </View>
          <FlatList
            data={filtered}
            keyExtractor={(s) => s.id}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.stopRow} onPress={() => choose(item.id)} activeOpacity={0.7}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.stopName}>{item.name}</Text>
                  <Text style={styles.stopArea}>{item.areaLabel}</Text>
                </View>
                {item.id === home && <FontAwesome5 name="check" size={13} color={accent} />}
              </TouchableOpacity>
            )}
            ListEmptyComponent={<Text style={styles.empty}>No stops match “{query}”.</Text>}
          />
        </SafeAreaView>
      </Modal>
    </View>
  );
}

function TripCard({ title, result, homeLabel, dir }: { title: string; result: TravelResult; homeLabel: string; dir: 'there' | 'home' }) {
  const journey = result.journey;
  const leaveBy = journey ? journey.legs[0].depart : null;
  const badge = result.departsBeforeStart ? `Leave by ${leaveBy}` : result.leavesBeforeEnd ? 'Before event ends' : null;
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardTitle}>{title}</Text>
        {badge && <View style={styles.warnPill}><Text style={styles.warnPillText}>{badge}</Text></View>}
      </View>
      {result.local ? (
        <Text style={styles.msg}>You&apos;re at the event — no ferry or bus needed.</Text>
      ) : !journey ? (
        <Text style={styles.msg}>
          {dir === 'there'
            ? `No bus or ferry from ${homeLabel} arrives before the start — you'll need to drive or arrange a lift.`
            : `No bus or ferry back to ${homeLabel} at all that day — plan a lift or an overnight stay.`}
        </Text>
      ) : (
        <>
          <View style={styles.legList}>
            {journey.legs.map((leg, i) => (
              <View key={i} style={styles.legRow}>
                <FontAwesome5 name={leg.mode === 'ferry' ? 'ship' : 'bus'} size={11} color={colors.textSecondary} solid style={{ marginTop: 2 }} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.legLine}>
                    <Text style={styles.legTime}>{leg.depart}</Text> <Text style={styles.legStop}>{leg.fromName}</Text>
                    <Text style={styles.legArrow}>  →  </Text>
                    <Text style={styles.legTime}>{leg.arrive}</Text> <Text style={styles.legStop}>{leg.toName}</Text>
                  </Text>
                  <Text style={styles.legSub}>
                    {leg.mode === 'ferry' ? leg.service : `Service ${leg.service}`}{leg.bookable ? ' · booking needed' : ''}
                  </Text>
                </View>
              </View>
            ))}
          </View>
          {result.departsBeforeStart && (
            <Text style={styles.warnNote}>
              This is the last connection home — it leaves before the event, so you&apos;d need to head off early, get a lift, or stay over.
            </Text>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: spacing.lg, paddingHorizontal: spacing.md },
  sectionTitle: { fontSize: fontSize.lg, fontWeight: '800', color: colors.textPrimary },
  stopBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8,
    backgroundColor: colors.cardBackground, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 10,
  },
  stopBtnText: { flex: 1, fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  card: {
    marginTop: 10, backgroundColor: colors.cardBackground, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, padding: spacing.md,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  warnPill: { backgroundColor: '#FAEEDA', borderRadius: radius.full, paddingHorizontal: 8, paddingVertical: 3 },
  warnPillText: { fontSize: fontSize.xs, fontWeight: '700', color: '#854F0B' },
  msg: { marginTop: 6, fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 19 },
  warnNote: { marginTop: 8, fontSize: fontSize.xs, fontWeight: '600', color: '#854F0B', lineHeight: 16 },
  legList: { marginTop: 8, gap: 10 },
  legRow: { flexDirection: 'row', gap: 8 },
  legLine: { fontSize: fontSize.sm, color: colors.textPrimary, lineHeight: 20 },
  legTime: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textSecondary, fontVariant: ['tabular-nums'] },
  legStop: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  legArrow: { color: colors.textMuted },
  legSub: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 1 },
  caveat: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 10, lineHeight: 16 },

  modal: { flex: 1, backgroundColor: colors.screenBackground },
  modalHead: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: spacing.md, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  search: {
    flex: 1, height: 40, borderRadius: radius.md, backgroundColor: colors.cardBackground,
    borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, fontSize: fontSize.md, color: colors.textPrimary,
  },
  close: { fontSize: fontSize.md, fontWeight: '800' },
  stopRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  stopName: { fontSize: fontSize.md, fontWeight: '600', color: colors.textPrimary },
  stopArea: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 1 },
  empty: { padding: spacing.lg, textAlign: 'center', color: colors.textSecondary },
});
