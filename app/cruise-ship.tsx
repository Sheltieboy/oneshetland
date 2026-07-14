/**
 * app/cruise-ship.tsx — a single ship visit.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Image, StyleSheet, ActivityIndicator, Linking } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, spacing, radius, fontSize } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import DisplayText from '@/components/DisplayText';
import { getCruiseVisit, getShipOtherCalls, routePoints, baro, fmtTime, fmtDateShort, fmtDateLong, hoursAshore, ashorePlan, trackUrl, type CruiseVisit, type CruiseDay, type OtherCall } from '@/lib/cruise-api';
import { CruiseMap, type MapMarker, type MapLine } from '@/components/cruise/CruiseMap';

const ACCENT = '#0E6E8C';
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default function CruiseShipScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { sidePadding } = useAppLayout();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [visit, setVisit] = useState<CruiseVisit | null>(null);
  const [day, setDay] = useState<CruiseDay | null>(null);
  const [otherCalls, setOtherCalls] = useState<OtherCall[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    getCruiseVisit(id).then(({ visit, day }) => {
      setVisit(visit); setDay(day); setLoading(false);
      if (visit?.ship_id) getShipOtherCalls(visit.ship_id, visit.id).then(setOtherCalls).catch(() => {});
    }).catch(() => setLoading(false));
  }, [id]);

  if (loading) {
    return <SafeAreaView style={styles.safe}><Stack.Screen options={{ headerShown: false }} /><ActivityIndicator color={ACCENT} style={{ marginTop: 60 }} /></SafeAreaView>;
  }
  if (!visit) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}><Stack.Screen options={{ headerShown: false }} />
        <View style={{ padding: spacing.xl }}><Text style={{ color: colors.textSecondary }}>This cruise visit could not be found.</Text></View>
      </SafeAreaView>
    );
  }

  const name = visit.ship?.name ?? visit.ship_name_cache ?? 'Cruise ship';
  const b = baro(day?.barometer);
  const hrs = hoursAshore(visit);
  const inPort = visit.status === 'in_port';
  const facts = [
    visit.ship?.vessel_type ? cap(visit.ship.vessel_type) : null,
    visit.ship?.length_label,
    visit.est_pax ? `~${visit.est_pax.toLocaleString()} passengers` : visit.est_pax_label,
    visit.berth || visit.berth_area_group,
  ].filter(Boolean).join('  ·  ');

  const route = routePoints(visit.from_location, visit.to_location);
  const routeMarkers: MapMarker[] = route.map((p) => ({ lat: p.lat, lng: p.lng, label: p.name, hub: p.kind === 'lerwick' }));
  const routeLines: MapLine[] = route.slice(1).map((p, i) => [[route[i].lat, route[i].lng], [p.lat, p.lng]] as MapLine);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.topBar, { paddingTop: insets.top ? 4 : 10 }]}>
        <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace('/cruise'))} hitSlop={12} style={styles.back}>
          <FontAwesome5 name="chevron-left" size={16} color={ACCENT} />
        </TouchableOpacity>
        <Text style={styles.topBarTitle} numberOfLines={1}>{visit.visit_date ? fmtDateLong(visit.visit_date) : 'Cruise visit'}</Text>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: sidePadding + spacing.lg, paddingBottom: spacing.xxl }}>
        {/* Photo */}
        <View style={styles.photoWrap}>
          {visit.ship?.image_url ? (
            <Image source={{ uri: visit.ship.image_url }} style={styles.photo} resizeMode="cover" />
          ) : (
            <View style={[styles.photo, styles.photoPlaceholder]}><FontAwesome5 name="ship" size={40} color={colors.textLight} /></View>
          )}
          <View style={[styles.statusPill, { backgroundColor: inPort ? 'rgba(26,161,136,0.95)' : 'rgba(3,47,76,0.85)' }]}>
            <Text style={styles.statusPillText}>{inPort ? 'Alongside now' : cap(visit.status)}</Text>
          </View>
        </View>

        <DisplayText weight="black" style={styles.h1}>{name}</DisplayText>
        {!!facts && <Text style={styles.facts}>{facts}</Text>}

        {/* arr/dep + barometer */}
        <View style={styles.infoCard}>
          <Row label="Arrives" value={`${fmtTime(visit.arrival_at)}${visit.from_location ? `  ·  from ${visit.from_location}` : ''}`} />
          <Row label="Departs" value={`${fmtTime(visit.departure_at)}${visit.to_location ? `  ·  to ${visit.to_location}` : ''}`} />
          {hrs ? <Row label="Ashore" value={`~${hrs} hours`} /> : null}
        </View>

        {day ? (
          <View style={[styles.baroChip, { borderLeftColor: b.color }]}>
            <View style={[styles.dot, { backgroundColor: b.color }]} />
            <Text style={styles.baroChipText}>{b.label} in town
              <Text style={styles.baroChipSub}>  ·  {day.ships_count} {day.ships_count === 1 ? 'ship' : 'ships'}{day.total_est_pax ? ` · ~${day.total_est_pax.toLocaleString()} ashore` : ''}</Text>
            </Text>
          </View>
        ) : null}

        {/* Voyage */}
        {route.length > 1 && (
          <View style={{ marginTop: 12 }}>
            <Text style={styles.blockTitle}>Voyage</Text>
            <Text style={styles.blockSub}>
              {visit.from_location ? `From ${visit.from_location}` : 'Arriving'} → Lerwick{visit.to_location ? ` → ${visit.to_location}` : ''}
            </Text>
            <CruiseMap markers={routeMarkers} lines={routeLines} height={220} />
          </View>
        )}

        {/* Your day ashore */}
        <View style={styles.ashore}>
          <Text style={styles.ashoreTitle}>Your day ashore</Text>
          <Text style={styles.ashoreBody}>{ashorePlan(hrs)}</Text>
          <Text style={styles.ashoreNote}>Toilets, Wi‑Fi, ATMs and taxis are all in the town centre, a short walk from the berth.{hrs ? '  Aim to be back on board about 30 minutes before departure.' : ''}</Text>
        </View>

        {/* Other calls this season */}
        {otherCalls.length > 0 && (
          <View style={{ marginTop: 12 }}>
            <Text style={styles.blockTitle}>{name} also calls</Text>
            <View style={styles.callsWrap}>
              {otherCalls.map((c) => (
                <TouchableOpacity key={c.id} style={styles.callChip} activeOpacity={0.85} onPress={() => router.push({ pathname: '/cruise-ship', params: { id: c.id } })}>
                  <Text style={styles.callChipDate}>{c.visit_date ? fmtDateShort(c.visit_date) : ''}</Text>
                  {c.est_pax ? <Text style={styles.callChipPax}>~{c.est_pax.toLocaleString()} pax</Text> : null}
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {/* Actions */}
        <View style={styles.actions}>
          <TouchableOpacity style={[styles.btn, { backgroundColor: ACCENT }]} onPress={() => Linking.openURL(trackUrl(visit.ship))} activeOpacity={0.85}>
            <FontAwesome5 name="satellite-dish" size={13} color="#fff" solid />
            <Text style={styles.btnText}>Track live</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={() => router.push('/(tabs)/local')} activeOpacity={0.85}>
            <Text style={[styles.btnText, { color: colors.textPrimary }]}>What&apos;s open today</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={() => router.push('/(tabs)/whats-on')} activeOpacity={0.85}>
            <Text style={[styles.btnText, { color: colors.textPrimary }]}>Tours &amp; tickets</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  topBar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: spacing.lg, paddingBottom: 8 },
  back: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  topBarTitle: { color: ACCENT, fontWeight: '700', fontSize: fontSize.sm, flex: 1 },

  photoWrap: { borderRadius: radius.lg, overflow: 'hidden', backgroundColor: colors.screenBackground, aspectRatio: 16 / 9, marginTop: 4 },
  photo: { width: '100%', height: '100%' },
  photoPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  statusPill: { position: 'absolute', top: 10, right: 10, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 5 },
  statusPillText: { color: '#fff', fontSize: 11, fontWeight: '700' },

  h1: { fontSize: 28, color: colors.textPrimary, letterSpacing: -0.5, marginTop: spacing.md },
  facts: { fontSize: 13, color: colors.textMuted, marginTop: 2 },

  infoCard: { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 14, marginTop: spacing.md },
  row: { flexDirection: 'row', gap: 12, paddingVertical: 4 },
  rowLabel: { width: 64, color: colors.textLight, fontSize: 13 },
  rowValue: { flex: 1, color: colors.textPrimary, fontSize: 13 },

  baroChip: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, borderLeftWidth: 5, padding: 12, marginTop: 10 },
  dot: { width: 11, height: 11, borderRadius: 6 },
  baroChipText: { flex: 1, fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  baroChipSub: { fontWeight: '400', color: colors.textMuted, fontSize: 12 },

  blockTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary, marginBottom: 4 },
  blockSub: { fontSize: 13, color: colors.textMuted, marginBottom: 10 },
  callsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  callChip: { backgroundColor: '#fff', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 8 },
  callChipDate: { fontSize: 13, fontWeight: '800', color: colors.textPrimary },
  callChipPax: { fontSize: 11, color: colors.textMuted, marginTop: 1 },

  ashore: { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 14, marginTop: 12 },
  ashoreTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary, marginBottom: 4 },
  ashoreBody: { fontSize: 13, color: colors.textSecondary, lineHeight: 20 },
  ashoreNote: { fontSize: 12, color: colors.textMuted, marginTop: 8, lineHeight: 17 },

  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 },
  btn: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: radius.md, paddingHorizontal: 16, paddingVertical: 11 },
  btnGhost: { backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border },
  btnText: { color: '#fff', fontWeight: '700', fontSize: fontSize.sm },
});
