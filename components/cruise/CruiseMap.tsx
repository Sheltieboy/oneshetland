/**
 * Static plotted map for cruise routes + "where ships sail from".
 * Soft-loads react-native-maps (Apple Maps on iOS, Google on Android) the same
 * way MemoryMapNative does, with a graceful fallback if the module is missing.
 */
import React, { useRef } from 'react';
import { View, Text, StyleSheet, Platform, ViewStyle } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, radius, fontSize } from '@/constants/theme';

const ACCENT = '#0E6E8C';

let MapView: any = null;
let Marker: any = null;
let Polyline: any = null;
let PROVIDER_GOOGLE: any = undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Maps = require('react-native-maps');
  MapView = Maps.default ?? Maps;
  Marker = Maps.Marker;
  Polyline = Maps.Polyline;
  PROVIDER_GOOGLE = Maps.PROVIDER_GOOGLE;
} catch {
  MapView = null;
}

export type MapMarker = { lat: number; lng: number; label?: string; hub?: boolean; size?: number };
export type MapLine = [[number, number], [number, number]];

interface Props {
  markers: MapMarker[];
  lines?: MapLine[];
  height?: number;
  style?: ViewStyle;
}

export function CruiseMap({ markers, lines = [], height = 240, style }: Props) {
  const ref = useRef<any>(null);
  if (markers.length === 0) return null;

  if (!MapView) {
    return (
      <View style={[st.fallback, { height }, style]}>
        <FontAwesome5 name="map" size={28} color={ACCENT} />
        <Text style={st.fallbackText}>Map unavailable</Text>
      </View>
    );
  }

  const lats = markers.map((m) => m.lat);
  const lngs = markers.map((m) => m.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const region = {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max(0.5, (maxLat - minLat) * 1.5),
    longitudeDelta: Math.max(0.5, (maxLng - minLng) * 1.5),
  };
  const coords = markers.map((m) => ({ latitude: m.lat, longitude: m.lng }));

  return (
    <View style={[st.wrap, { height }, style]}>
      <MapView
        ref={ref}
        style={StyleSheet.absoluteFill}
        provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined}
        initialRegion={region}
        scrollEnabled={false}
        zoomEnabled={false}
        rotateEnabled={false}
        pitchEnabled={false}
        toolbarEnabled={false}
        onMapReady={() => {
          try {
            ref.current?.fitToCoordinates(coords, {
              edgePadding: { top: 40, right: 40, bottom: 40, left: 40 },
              animated: false,
            });
          } catch {}
        }}
      >
        {lines.map((ln, i) => (
          <Polyline
            key={`l${i}`}
            coordinates={ln.map(([la, lo]) => ({ latitude: la, longitude: lo }))}
            strokeColor={`${ACCENT}99`}
            strokeWidth={1.5}
            geodesic
          />
        ))}
        {markers.map((m, i) => {
          const s = m.size ?? (m.hub ? 16 : 11);
          return (
            <Marker key={`m${i}`} coordinate={{ latitude: m.lat, longitude: m.lng }} title={m.label} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
              <View style={[st.dot, { width: s, height: s, borderRadius: s / 2, backgroundColor: m.hub ? ACCENT : '#5b6b75' }]} />
            </Marker>
          );
        })}
      </MapView>
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { borderRadius: radius.lg, overflow: 'hidden', borderWidth: 1, borderColor: colors.border, backgroundColor: '#dde6ea' },
  dot: { borderWidth: 2, borderColor: '#fff' },
  fallback: { borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: '#eef1f3', alignItems: 'center', justifyContent: 'center', gap: 8 },
  fallbackText: { fontSize: fontSize.sm, color: colors.textMuted, fontWeight: '600' },
});
