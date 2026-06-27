/**
 * ShetlandTodayCard
 *
 * A premium "today at a glance" card for the home feed: a weather-aware Shetland
 * photo behind current weather, sunrise/sunset/daylight, and a tide timeline.
 * Defaults to Lerwick, with a "Near me" toggle that uses the device location so
 * folk across the isles aren't stuck with a Lerwick-only forecast. Tides come
 * from the Admiralty UK Tidal API (nearest station to the active coordinates);
 * the tide strip hides entirely if no key is configured — we never invent tides.
 *
 *   <ShetlandTodayCard style={{ marginHorizontal: 16 }} />
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ImageBackground, ActivityIndicator,
  TouchableOpacity, StyleProp, ViewStyle, Linking,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { FontAwesome5 } from '@expo/vector-icons';
import { fontSize, spacing, radius } from '@/constants/theme';
import { useAlert } from '@/components/BrandedAlert';
import {
  fetchTodaySnapshot, describeWeather, LERWICK_COORDS, type TodaySnapshot,
} from '@/lib/shetland-today';
import { fetchTides, type TideResult } from '@/lib/tides';

// Soft-load expo-location so a missing dep just disables the "Near me" toggle.
let Location: any = null;
try { Location = require('expo-location'); } catch { Location = null; }

// Weather-aware Shetland photos (reused from the hero set) for the premium look.
const IMG = {
  daySunny:   require('@/assets/context-background-images/60-hero-day-sunny.webp'),
  dayCalm:    require('@/assets/context-background-images/60-hero-day-calm.webp'),
  dayRainy:   require('@/assets/context-background-images/60-hero-day-rainy.webp'),
  nightClear: require('@/assets/context-background-images/60-hero-night-clear.webp'),
  nightRain:  require('@/assets/context-background-images/60-hero-night-rain.webp'),
};

function pickImage(code: number | null): any {
  const h = new Date().getHours();
  const isDay = h >= 5 && h < 22;
  const wet = code != null && ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95);
  if (!isDay) return wet ? IMG.nightRain : IMG.nightClear;
  if (wet) return IMG.dayRainy;
  if (code === 0 || (code != null && code <= 2)) return IMG.daySunny;
  return IMG.dayCalm;
}

const clampPct = (f: number) => Math.min(95, Math.max(5, f * 100));

type Mode = 'lerwick' | 'mine';
const PREF_KEY = 'shetland_today_loc';

export function ShetlandTodayCard({ style }: { style?: StyleProp<ViewStyle> }) {
  const [mode, setMode]   = useState<Mode>('lerwick');
  const [place, setPlace] = useState('Lerwick');
  const [snap, setSnap]   = useState<TodaySnapshot | null>(null);
  const [tide, setTide]   = useState<TideResult | null>(null);
  const [loading, setLoading] = useState(true);
  const hasLocation = !!(Location?.requestForegroundPermissionsAsync);

  // Weather + tides for a location, fetched together.
  const { alert } = useAlert();

  const loadFor = useCallback(async (coords: { lat: number; lng: number }, label: string) => {
    setLoading(true);
    setPlace(label);
    const [s, t] = await Promise.all([fetchTodaySnapshot(coords), fetchTides(coords)]);
    setSnap(s);
    setTide(t);
    setLoading(false);
  }, []);

  const loadLerwick = useCallback(() => loadFor(LERWICK_COORDS, 'Lerwick'), [loadFor]);

  // `interactive` = the user tapped "Near me" → we may show prompts. On the
  // silent mount path we never nag; we just fall back to Lerwick.
  const loadMine = useCallback(async (interactive: boolean): Promise<boolean> => {
    if (!hasLocation) return false;
    setLoading(true);
    try {
      // Don't re-prompt if we already have permission; only ask when undetermined.
      let perm = await Location.getForegroundPermissionsAsync?.();
      if (!perm || perm.status === 'undetermined') {
        perm = await Location.requestForegroundPermissionsAsync();
      }
      if (perm?.status !== 'granted') {
        setLoading(false);
        if (interactive) {
          alert({
            title: 'Turn on location',
            message: 'To show the weather and tides for where you are, allow OneShetland to use your location in Settings.',
            actions: [
              { label: 'Not now', style: 'cancel' },
              { label: 'Open settings', style: 'primary', onPress: () => { Linking.openSettings().catch(() => {}); } },
            ],
          });
        }
        return false;
      }

      // Fast + reliable: race a fresh fix against a timeout, then fall back to
      // the last known position so it never hangs (mirrors a website's snappy feel).
      const current = await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy?.Low ?? 3 }),
        new Promise<null>(res => setTimeout(() => res(null), 6000)),
      ]).catch(() => null);
      let coords = (current as { coords?: { latitude: number; longitude: number } } | null)?.coords;
      if (!coords) {
        const last = await Location.getLastKnownPositionAsync?.().catch(() => null);
        coords = last?.coords;
      }
      if (!coords || typeof coords.latitude !== 'number' || typeof coords.longitude !== 'number') {
        setLoading(false);
        if (interactive) {
          alert({
            title: "Couldn't get your location",
            message: 'We couldn\'t pin down where you are just now — showing Lerwick. Try again in a moment.',
            actions: [{ label: 'OK', style: 'primary' }],
          });
        }
        return false;
      }

      const lat = coords.latitude, lng = coords.longitude;
      let label = 'Near you';
      try {
        const geo = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lng });
        const g = geo?.[0];
        label = g?.city || g?.subregion || g?.district || g?.name || 'Near you';
      } catch { /* keep fallback */ }
      await loadFor({ lat, lng }, label);
      return true;
    } catch {
      setLoading(false);
      return false;
    }
  }, [hasLocation, loadFor, alert]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const saved = (await AsyncStorage.getItem(PREF_KEY)) as Mode | null;
      if (!alive) return;
      if (saved === 'mine') {
        setMode('mine');
        const ok = await loadMine(false);
        if (!ok && alive) { setMode('lerwick'); void loadLerwick(); }
      } else {
        void loadLerwick();
      }
    })();
    return () => { alive = false; };
  }, [loadMine, loadLerwick]);

  const choose = async (next: Mode) => {
    if (next === mode && snap) return;
    if (next === 'mine') {
      const ok = await loadMine(true);
      if (ok) { setMode('mine'); void AsyncStorage.setItem(PREF_KEY, 'mine'); }
      else    { setMode('lerwick'); void loadLerwick(); void AsyncStorage.setItem(PREF_KEY, 'lerwick'); }
    } else {
      setMode('lerwick');
      void loadLerwick();
      void AsyncStorage.setItem(PREF_KEY, 'lerwick');
    }
  };

  const w = describeWeather(snap?.weatherCode ?? null);
  const now = new Date();
  const nowFraction = (now.getHours() * 60 + now.getMinutes()) / 1440;
  const tideEvents = tide?.events ?? [];

  return (
    <ImageBackground
      source={pickImage(snap?.weatherCode ?? null)}
      style={[styles.card, style]}
      imageStyle={styles.image}
    >
      <View style={styles.scrim} />

      <View style={styles.topRow}>
        <Text style={styles.kicker}>SHETLAND TODAY</Text>
        {hasLocation ? (
          <View style={styles.toggle}>
            <Pill label="Lerwick" active={mode === 'lerwick'} onPress={() => choose('lerwick')} />
            <Pill label="Near me" active={mode === 'mine'} onPress={() => choose('mine')} />
          </View>
        ) : null}
      </View>

      {loading && !snap ? (
        <View style={styles.loadingBox}><ActivityIndicator color="#fff" /></View>
      ) : (
        <>
          <View style={styles.weatherRow}>
            <FontAwesome5 name={w.icon as any} size={30} color="#fff" solid />
            <Text style={styles.temp}>{snap?.tempC != null ? `${snap.tempC}°` : '—'}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.place} numberOfLines={1}>{place}</Text>
              <Text style={styles.cond} numberOfLines={1}>{w.label}</Text>
            </View>
            {loading ? <ActivityIndicator color="rgba(255,255,255,0.8)" /> : null}
          </View>

          <View style={styles.divider} />

          <View style={styles.sunRow}>
            <Sun icon="sun"   label="Sunrise"  value={snap?.sunrise ?? '—'} />
            <Sun icon="moon"  label="Sunset"   value={snap?.sunset ?? '—'} />
            <Sun icon="clock" label="Daylight" value={snap?.daylight ?? '—'} />
          </View>

          {tideEvents.length > 0 ? (
            <>
              <View style={styles.tideHeaderRow}>
                <FontAwesome5 name="water" size={10} color="rgba(255,255,255,0.7)" solid />
                <Text style={styles.tideKicker}>
                  TIDES{tide?.stationName ? ` · ${tide.stationName}` : ''}
                </Text>
              </View>
              <View style={styles.tideTrack}>
                <View style={[styles.nowDot, { left: `${clampPct(nowFraction)}%` }]} />
                {tideEvents.map((e, i) => (
                  <View key={i} style={[styles.tideTick, { left: `${clampPct(e.fraction)}%` }]}>
                    <View style={styles.tickLine} />
                    <Text style={[styles.tickLabel, e.type === 'flow' ? styles.flow : styles.ebb]}>
                      {e.type === 'flow' ? 'Flow' : 'Ebb'}
                    </Text>
                    <Text style={styles.tickTime}>{e.time}</Text>
                  </View>
                ))}
              </View>
              {/* Required ADMIRALTY attribution (UK Tidal API terms, clause 2). */}
              <Text style={styles.tideAttribution}>
                Contains ADMIRALTY® tidal data: © Crown copyright and database right
              </Text>
            </>
          ) : null}
        </>
      )}
    </ImageBackground>
  );
}

function Pill({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.8} style={[styles.pill, active && styles.pillActive]}>
      <Text style={[styles.pillText, active && styles.pillTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function Sun({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <View style={styles.sunCol}>
      <View style={styles.sunLabelRow}>
        <FontAwesome5 name={icon as any} size={10} color="rgba(255,255,255,0.75)" solid />
        <Text style={styles.sunLabel}>{label}</Text>
      </View>
      <Text style={styles.sunValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    overflow: 'hidden',
    padding: spacing.md,
    minHeight: 150,
    gap: spacing.md,
  },
  image: { borderRadius: radius.lg },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(8,20,32,0.46)' },

  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  kicker: { color: 'rgba(255,255,255,0.85)', fontSize: 11, fontWeight: '800', letterSpacing: 1.2 },

  toggle: { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.16)', borderRadius: radius.full, padding: 2 },
  pill: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: radius.full },
  pillActive: { backgroundColor: '#fff' },
  pillText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  pillTextActive: { color: '#08182a' },

  loadingBox: { paddingVertical: spacing.lg, alignItems: 'center' },

  weatherRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  temp: { color: '#fff', fontSize: 34, fontWeight: '800' },
  place: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
  cond: { color: 'rgba(255,255,255,0.75)', fontSize: fontSize.sm },

  divider: { height: 1, backgroundColor: 'rgba(255,255,255,0.18)' },

  sunRow: { flexDirection: 'row', justifyContent: 'space-between' },
  sunCol: { gap: 3 },
  sunLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  sunLabel: { color: 'rgba(255,255,255,0.75)', fontSize: 11, fontWeight: '600' },
  sunValue: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },

  // Tide timeline
  tideHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tideKicker: { color: 'rgba(255,255,255,0.7)', fontSize: 10, fontWeight: '700', letterSpacing: 0.8 },
  tideTrack: {
    position: 'relative',
    height: 46,
    marginTop: 6,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.22)',
  },
  nowDot: {
    position: 'absolute', top: -4, width: 8, height: 8, borderRadius: 4,
    backgroundColor: '#fff', marginLeft: -4,
  },
  tideTick: { position: 'absolute', top: 0, width: 40, marginLeft: -20, alignItems: 'center' },
  tickLine: { width: 1, height: 9, backgroundColor: 'rgba(255,255,255,0.5)' },
  tickLabel: { fontSize: 10, fontWeight: '700', marginTop: 3 },
  tickTime: { color: '#fff', fontSize: 11, marginTop: 1 },
  flow: { color: '#5dcaa5' },
  ebb: { color: '#85b7eb' },
  tideAttribution: { color: 'rgba(255,255,255,0.6)', fontSize: 10, lineHeight: 13, marginTop: 8 },
});
