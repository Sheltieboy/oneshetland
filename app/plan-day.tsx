/**
 * plan-day.tsx — "Plan a day out", the app twin of the website's
 * /visiting/plan.
 *
 * Tell it when you're free and what you fancy, and Peerie Bot lays out a day:
 * what's actually on, somewhere to eat, things worth seeing, with travel times
 * between each stop and a map of the route.
 *
 * The scheduling is NOT done here — it's the web's /api/ai/plan-day, the same
 * endpoint the website's own page calls (see lib/planner-api.ts for why). This
 * screen is the form and the itinerary; the times come from one place for both
 * platforms.
 *
 * Peerie Bot's part is choosing and ordering the stops, so it carries the full
 * signature while it works: the name, the AI tag, the ✨, and the ring-colour
 * glow round the working area. When the model can't be reached the server
 * hands back the plain planner's day instead of an error, and the byline says
 * so rather than passing code's work off as the assistant's.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator, Image, Linking, Platform, ScrollView, StyleSheet,
  Text, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import DateTimePicker from '@react-native-community/datetimepicker';
import MapView, { Marker, Polyline, PROVIDER_DEFAULT } from 'react-native-maps';
import { colors, fontSize, radius, shadow, spacing } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { SECTION_HEROES } from '@/constants/section-heroes';
import { TabScreenHeader } from '@/components/TabScreenHeader';
import { HeroBackPill } from '@/components/ui/HeroBackPill';
import { AiGlow } from '@/components/ai/AiGlow';
import { PEERIE } from '@/constants/peerie';
import {
  fetchDayPlan, hhmm, INTERESTS, isoDate, longDate,
  type DayPlan, type Interest, type Transport,
} from '@/lib/planner-api';

const S = SECTIONS.local;

/** A sensible default day: today, 10:00 to 17:00. */
function defaultTimes() {
  const d = new Date();
  const from = new Date(d); from.setHours(10, 0, 0, 0);
  const to = new Date(d); to.setHours(17, 0, 0, 0);
  return { date: d, from, to };
}

type PickerTarget = 'date' | 'from' | 'to';

export default function PlanDayScreen() {
  const router = useRouter();
  const initial = useMemo(defaultTimes, []);

  const [date, setDate] = useState(initial.date);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [transport, setTransport] = useState<Transport>('driving');
  const [picked, setPicked] = useState<Interest[]>([]);

  const [picker, setPicker] = useState<PickerTarget | null>(null);
  const [draft, setDraft] = useState<Date>(initial.date);

  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<DayPlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  const windowValid = to.getTime() > from.getTime();

  const openPicker = useCallback((target: PickerTarget) => {
    Haptics.selectionAsync();
    setDraft(target === 'date' ? date : target === 'from' ? from : to);
    setPicker(target);
  }, [date, from, to]);

  const commitPicker = useCallback(() => {
    if (picker === 'date') setDate(draft);
    else if (picker === 'from') setFrom(draft);
    else if (picker === 'to') setTo(draft);
    setPicker(null);
  }, [picker, draft]);

  const toggleInterest = useCallback((key: Interest) => {
    Haptics.selectionAsync();
    setPicked(p => (p.includes(key) ? p.filter(k => k !== key) : [...p, key]));
  }, []);

  const run = useCallback(async () => {
    if (busy || !windowValid) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setBusy(true); setError(null);
    try {
      const result = await fetchDayPlan({
        date: isoDate(date),
        from: hhmm(from),
        to: hhmm(to),
        transport,
        interests: picked,
      });
      setPlan(result);
    } catch (e) {
      setPlan(null);
      setError(e instanceof Error ? e.message : 'Something went wrong building your day.');
    } finally {
      setBusy(false);
    }
  }, [busy, windowValid, date, from, to, transport, picked]);

  /* The web builds hrefs for a website (/directory/x, /whats-on/y). In the app
     those are native routes, so a stop opens in the app rather than a browser. */
  const openStop = useCallback((href: string) => {
    Haptics.selectionAsync();
    const dir = href.match(/^\/directory\/(.+)$/);
    if (dir) { router.push(`/b/${dir[1]}`); return; }
    const ev = href.match(/^\/whats-on\/(.+)$/);
    if (ev) { router.push(`/events/${ev[1]}`); return; }
    Linking.openURL(`https://oneshetland.com${href}`);
  }, [router]);

  const mapped = plan?.stops.filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng)) ?? [];
  const region = useMemo(() => {
    if (mapped.length === 0) return null;
    const lats = mapped.map(s => s.lat), lngs = mapped.map(s => s.lng);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    return {
      latitude: (minLat + maxLat) / 2,
      longitude: (minLng + maxLng) / 2,
      // A floor keeps a tight cluster of Lerwick stops from zooming to street level.
      latitudeDelta: Math.max((maxLat - minLat) * 1.5, 0.05),
      longitudeDelta: Math.max((maxLng - minLng) * 1.5, 0.05),
    };
  }, [mapped]);

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View>
        <TabScreenHeader
          section={S}
          photo={SECTION_HEROES.local}
          title="Plan a day out"
          eyebrow="Something to do"
        />
        {router.canGoBack() ? (
          <View style={{ position: 'absolute', top: 12, left: spacing.md }}>
            <HeroBackPill variant="overlay" label="Back" onPress={() => router.back()} />
          </View>
        ) : null}
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">

        {/* ── The ask ──────────────────────────────────────────────────── */}
        <AiGlow active={busy} style={styles.formCard} borderRadius={radius.lg}>
          <View style={styles.peerieRow}>
            <View style={[styles.avatar, { backgroundColor: S.color }]}>
              <Text style={styles.spark}>{PEERIE.spark}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.peerieName}>{PEERIE.name}</Text>
              <Text style={styles.peerieRole}>{PEERIE.role}</Text>
            </View>
            <View style={styles.tag}><Text style={styles.tagText}>{PEERIE.tag}</Text></View>
          </View>

          <Text style={styles.intro}>
            Tell me when you&apos;re free and what you fancy, and I&apos;ll lay out a day —
            with travel times and a map.
          </Text>

          <Text style={styles.label}>Which day</Text>
          <TouchableOpacity style={styles.field} onPress={() => openPicker('date')} activeOpacity={0.8}>
            <FontAwesome5 name="calendar-day" size={13} color={S.color} solid />
            <Text style={styles.fieldText}>{longDate(isoDate(date))}</Text>
          </TouchableOpacity>

          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>From</Text>
              <TouchableOpacity style={styles.field} onPress={() => openPicker('from')} activeOpacity={0.8}>
                <FontAwesome5 name="clock" size={13} color={S.color} solid />
                <Text style={styles.fieldText}>{hhmm(from)}</Text>
              </TouchableOpacity>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Until</Text>
              <TouchableOpacity style={styles.field} onPress={() => openPicker('to')} activeOpacity={0.8}>
                <FontAwesome5 name="clock" size={13} color={S.color} solid />
                <Text style={styles.fieldText}>{hhmm(to)}</Text>
              </TouchableOpacity>
            </View>
          </View>
          {!windowValid && (
            <Text style={styles.warn}>The finish time needs to be after the start time.</Text>
          )}

          <Text style={styles.label}>Getting about</Text>
          <View style={styles.segment}>
            {(['driving', 'walking'] as Transport[]).map(t => {
              const on = transport === t;
              return (
                <TouchableOpacity
                  key={t}
                  style={[styles.segmentItem, on && { backgroundColor: S.color }]}
                  onPress={() => { Haptics.selectionAsync(); setTransport(t); }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  activeOpacity={0.85}
                >
                  <FontAwesome5
                    name={t === 'driving' ? 'car' : 'walking'}
                    size={12}
                    color={on ? '#fff' : colors.textMuted}
                    solid
                  />
                  <Text style={[styles.segmentText, on && styles.segmentTextOn]}>
                    {t === 'driving' ? 'By car' : 'On foot'}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={styles.label}>What are you after?</Text>
          <View style={styles.chips}>
            {INTERESTS.map(i => {
              const on = picked.includes(i.key);
              return (
                <TouchableOpacity
                  key={i.key}
                  style={[styles.chip, on && { backgroundColor: S.color, borderColor: S.color }]}
                  onPress={() => toggleInterest(i.key)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  activeOpacity={0.85}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>
                    {i.emoji} {i.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={styles.hint}>Pick none and we&apos;ll give you a bit of everything.</Text>

          <TouchableOpacity
            style={[styles.cta, { backgroundColor: S.color }, (busy || !windowValid) && styles.ctaOff]}
            onPress={run}
            disabled={busy || !windowValid}
            activeOpacity={0.9}
          >
            {busy && <ActivityIndicator size="small" color="#fff" />}
            <Text style={styles.ctaText}>
              {busy ? `${PEERIE.name} is putting your day together…` : plan ? 'Plan it again' : 'Plan my day'}
            </Text>
          </TouchableOpacity>
        </AiGlow>

        {error && (
          <View style={styles.errorCard}>
            <FontAwesome5 name="exclamation-circle" size={14} color={colors.warningDark} solid />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* ── The day ──────────────────────────────────────────────────── */}
        {plan && (
          <View style={styles.planWrap}>
            <Text style={styles.planTitle}>{plan.title}</Text>
            <Text style={styles.planDate}>{longDate(isoDate(date))} · {hhmm(from)}–{hhmm(to)}</Text>
            {plan.intro ? <Text style={styles.planIntro}>{plan.intro}</Text> : null}
            <Text style={styles.byline}>
              {plan.by === 'peerie'
                ? `Put together by ${PEERIE.name} ${PEERIE.spark} · ${PEERIE.tag}`
                : 'Put together from opening times and travel distances.'}
            </Text>

            {region && (
              <View style={styles.mapCard}>
                <MapView
                  provider={PROVIDER_DEFAULT}
                  style={styles.map}
                  initialRegion={region}
                  pointerEvents="none"
                >
                  <Polyline
                    coordinates={mapped.map(s => ({ latitude: s.lat, longitude: s.lng }))}
                    strokeColor={S.color}
                    strokeWidth={3}
                  />
                  {mapped.map((s, i) => (
                    <Marker
                      key={s.id}
                      coordinate={{ latitude: s.lat, longitude: s.lng }}
                      title={`${i + 1}. ${s.name}`}
                      description={`${s.arrive}–${s.depart}`}
                      pinColor={S.color}
                    />
                  ))}
                </MapView>
              </View>
            )}

            {plan.stops.map((stop, i) => (
              <View key={stop.id}>
                <View style={styles.leg}>
                  <FontAwesome5
                    name={stop.travelMode === 'walking' ? 'walking' : 'car'}
                    size={11}
                    color={colors.textMuted}
                    solid
                  />
                  <Text style={styles.legText}>{stop.travel}</Text>
                </View>

                <TouchableOpacity
                  style={styles.stop}
                  onPress={() => openStop(stop.href)}
                  activeOpacity={0.85}
                >
                  <View style={[styles.stopNum, { backgroundColor: S.color }]}>
                    <Text style={styles.stopNumText}>{i + 1}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.stopTime}>{stop.arrive} – {stop.depart}</Text>
                    <Text style={styles.stopName}>{stop.name}</Text>
                    {stop.why ? <Text style={styles.stopWhy}>{stop.why}</Text> : null}
                    {!stop.openKnown && (
                      <Text style={styles.stopWarn}>Check opening times before you go.</Text>
                    )}
                  </View>
                  {stop.image ? (
                    <Image source={{ uri: stop.image }} style={styles.stopImage} />
                  ) : null}
                </TouchableOpacity>
              </View>
            ))}

            {plan.skipped.length > 0 && (
              <View style={styles.skipped}>
                <Text style={styles.skippedTitle}>Left out</Text>
                {plan.skipped.slice(0, 6).map((s, i) => (
                  <Text key={`${s.name}-${i}`} style={styles.skippedRow}>· {s.name} — {s.reason}</Text>
                ))}
              </View>
            )}

            <View style={styles.footnote}>
              <Text style={styles.footnoteText}>
                <Text style={{ fontWeight: '800' }}>Worth knowing. </Text>
                Travel times are estimated from distance and typical Shetland road speeds, not
                live traffic, and they lean a little slow. Ferry islands — Yell, Unst, Whalsay,
                Fetlar and the rest — aren&apos;t planned for, because we don&apos;t hold the
                ferry timetables and would rather leave them out than strand you.
              </Text>
            </View>
          </View>
        )}
      </ScrollView>

      {/* ── Date / time picker sheet ─────────────────────────────────── */}
      {picker && (
        <View style={styles.pickerSheet}>
          <DateTimePicker
            value={draft}
            mode={picker === 'date' ? 'date' : 'time'}
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            themeVariant="light"
            textColor={colors.textPrimary}
            minuteInterval={15}
            onChange={(_, d) => {
              if (Platform.OS === 'android') {
                // Android's dialog IS the confirmation — there's no sheet to
                // confirm from, so a dismissal must not silently commit.
                if (d) {
                  if (picker === 'date') setDate(d);
                  else if (picker === 'from') setFrom(d);
                  else setTo(d);
                }
                setPicker(null);
                return;
              }
              if (d) setDraft(d);
            }}
            style={{ width: '100%' }}
          />
          {Platform.OS === 'ios' && (
            <View style={styles.pickerActions}>
              <TouchableOpacity style={styles.pickerCancel} onPress={() => setPicker(null)}>
                <Text style={styles.pickerCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.pickerDone, { backgroundColor: S.color }]}
                onPress={commitPicker}
              >
                <Text style={styles.pickerDoneText}>Done</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  body: { paddingBottom: spacing.xxl },

  formCard: {
    margin: spacing.md, padding: spacing.md,
    backgroundColor: colors.cardBackground, borderRadius: radius.lg, ...shadow.card,
  },

  peerieRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  avatar: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  spark: { fontSize: 15 },
  peerieName: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  peerieRole: { fontSize: fontSize.xs, color: colors.textMuted },
  tag: {
    paddingHorizontal: 7, paddingVertical: 2,
    borderRadius: radius.full, backgroundColor: colors.accentLight,
  },
  tagText: { fontSize: 10, fontWeight: '900', color: colors.accentDark, letterSpacing: 0.5 },

  intro: { marginTop: spacing.sm, fontSize: fontSize.sm, lineHeight: 19, color: colors.textSecondary },

  label: {
    marginTop: spacing.md, marginBottom: 6,
    fontSize: fontSize.xs, fontWeight: '800', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.6,
  },
  row: { flexDirection: 'row', gap: spacing.sm },
  field: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: 12, paddingVertical: 11,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.screenBackground,
  },
  fieldText: { fontSize: fontSize.md, fontWeight: '600', color: colors.textPrimary },
  warn: { marginTop: 6, fontSize: fontSize.xs, fontWeight: '700', color: colors.warningDark },

  segment: {
    flexDirection: 'row', gap: 4, padding: 4,
    borderRadius: radius.full, backgroundColor: colors.screenBackground,
    borderWidth: 1, borderColor: colors.border, alignSelf: 'flex-start',
  },
  segmentItem: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 7, borderRadius: radius.full,
  },
  segmentText: { fontSize: fontSize.xs, fontWeight: '800', color: colors.textMuted },
  segmentTextOn: { color: '#fff' },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  chip: {
    paddingHorizontal: 11, paddingVertical: 7,
    borderRadius: radius.full, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.screenBackground,
  },
  chipText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textSecondary },
  chipTextOn: { color: '#fff' },
  hint: { marginTop: 7, fontSize: fontSize.xs, color: colors.textMuted },

  cta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
    marginTop: spacing.md, paddingVertical: 14, borderRadius: radius.full,
  },
  ctaOff: { opacity: 0.6 },
  ctaText: { fontSize: fontSize.md, fontWeight: '800', color: '#fff' },

  errorCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm,
    marginHorizontal: spacing.md, padding: spacing.md,
    borderRadius: radius.md, backgroundColor: colors.warningLight,
  },
  errorText: { flex: 1, fontSize: fontSize.sm, lineHeight: 19, color: colors.warningDark },

  planWrap: { paddingHorizontal: spacing.md, paddingTop: spacing.lg },
  planTitle: { fontSize: fontSize.xxl, fontWeight: '900', color: colors.textPrimary },
  planDate: { marginTop: 2, fontSize: fontSize.sm, fontWeight: '700', color: colors.textMuted },
  planIntro: { marginTop: spacing.sm, fontSize: fontSize.md, lineHeight: 22, color: colors.textSecondary },
  byline: { marginTop: 6, fontSize: fontSize.xs, fontWeight: '700', color: colors.textMuted },

  mapCard: {
    marginTop: spacing.md, height: 220,
    borderRadius: radius.lg, overflow: 'hidden',
    borderWidth: 1, borderColor: colors.border,
  },
  map: { flex: 1 },

  leg: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    paddingVertical: 10, paddingLeft: 6,
  },
  legText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textMuted },

  stop: {
    flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm,
    padding: spacing.md, borderRadius: radius.lg,
    backgroundColor: colors.cardBackground, ...shadow.card,
  },
  stopNum: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  stopNumText: { fontSize: fontSize.xs, fontWeight: '900', color: '#fff' },
  stopTime: { fontSize: fontSize.xs, fontWeight: '800', color: colors.textMuted },
  stopName: { marginTop: 2, fontSize: fontSize.lg, fontWeight: '800', color: colors.textPrimary },
  stopWhy: { marginTop: 4, fontSize: fontSize.sm, lineHeight: 19, color: colors.textSecondary },
  stopWarn: { marginTop: 5, fontSize: fontSize.xs, fontWeight: '700', color: colors.warningDark },
  stopImage: { width: 56, height: 56, borderRadius: radius.md, backgroundColor: colors.screenBackground },

  skipped: {
    marginTop: spacing.lg, padding: spacing.md,
    borderRadius: radius.md, backgroundColor: colors.cardBackground,
    borderWidth: 1, borderColor: colors.border,
  },
  skippedTitle: { fontSize: fontSize.xs, fontWeight: '900', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.6 },
  skippedRow: { marginTop: 5, fontSize: fontSize.xs, color: colors.textMuted },

  footnote: { marginTop: spacing.lg, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.cardBackground },
  footnoteText: { fontSize: fontSize.xs, lineHeight: 18, color: colors.textMuted },

  pickerSheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: colors.cardBackground,
    borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    padding: spacing.md, ...shadow.card,
  },
  pickerActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  pickerCancel: {
    flex: 1, paddingVertical: 13, alignItems: 'center',
    borderRadius: radius.full, borderWidth: 1, borderColor: colors.border,
  },
  pickerCancelText: { fontSize: fontSize.md, fontWeight: '700', color: colors.textSecondary },
  pickerDone: { flex: 1, paddingVertical: 13, alignItems: 'center', borderRadius: radius.full },
  pickerDoneText: { fontSize: fontSize.md, fontWeight: '800', color: '#fff' },
});
