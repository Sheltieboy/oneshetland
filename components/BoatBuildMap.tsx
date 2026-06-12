/**
 * BoatBuildMap
 *
 * Plots where the Shetland fleet was built — one marker per boat-building town,
 * sized by how many boats came from there. Tapping a marker filters the fleet
 * list to that yard's town. Soft-loads react-native-maps so a missing dep
 * degrades gracefully.
 */

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import type { BuildPlaceCount } from '@/lib/boats-stats';

const SECTION = SECTIONS.daBoats;

let MapView: any = null;
let Marker:  any = null;
let Callout:  any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Maps = require('react-native-maps');
  MapView = Maps.default ?? Maps;
  Marker  = Maps.Marker;
  Callout = Maps.Callout;
} catch {
  MapView = null;
}

// Centred over the North Sea so NE Scotland, Shetland and the Nordic yards are
// all roughly in frame; outliers (Istanbul, Iceland) are a pan away.
const REGION = {
  latitude:        58.4,
  longitude:      -0.5,
  latitudeDelta:   8.5,
  longitudeDelta: 12.0,
};

interface Props {
  places:        BuildPlaceCount[];
  height?:       number;
  onSelectPlace?: (place: BuildPlaceCount) => void;
}

export function BoatBuildMap({ places, height = 300, onSelectPlace }: Props) {
  const maxCount = places.reduce((m, p) => Math.max(m, p.count), 1);

  if (!MapView) {
    return (
      <View style={[styles.fallback, { height }]}>
        <FontAwesome5 name="map-marked-alt" size={26} color={SECTION.color} />
        <Text style={styles.fallbackText}>Map unavailable</Text>
      </View>
    );
  }

  return (
    <View style={[styles.wrap, { height }]}>
      <MapView style={StyleSheet.absoluteFill} initialRegion={REGION}>
        {places.map(p => {
          const size = 22 + Math.round((p.count / maxCount) * 26);
          return (
            <Marker
              key={p.key}
              coordinate={{ latitude: p.lat, longitude: p.lng }}
              onPress={() => onSelectPlace?.(p)}
              anchor={{ x: 0.5, y: 0.5 }}
            >
              <View style={[styles.bubble, { width: size, height: size, borderRadius: size / 2 }]}>
                <Text style={styles.bubbleCount}>{p.count}</Text>
              </View>
              {Callout ? (
                <Callout tooltip onPress={() => onSelectPlace?.(p)}>
                  <View style={styles.callout}>
                    <Text style={styles.calloutTitle}>{p.label}</Text>
                    <Text style={styles.calloutSub}>{p.count} boat{p.count === 1 ? '' : 's'} built here</Text>
                  </View>
                </Callout>
              ) : null}
            </Marker>
          );
        })}
      </MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderRadius: radius.lg, overflow: 'hidden',
    borderWidth: 1, borderColor: colors.border, backgroundColor: '#cfe0ee',
  },
  bubble: {
    backgroundColor: SECTION.color,
    borderWidth: 2, borderColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.3, shadowRadius: 3, elevation: 3,
  },
  bubbleCount: { color: '#fff', fontSize: 11, fontWeight: '900' },
  callout: {
    backgroundColor: '#fff', borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 8,
    minWidth: 120, borderWidth: 1, borderColor: colors.border,
  },
  calloutTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  calloutSub:   { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  fallback: {
    borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    backgroundColor: '#eef2f6', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  fallbackText: { fontSize: fontSize.sm, color: colors.textMuted, fontWeight: '600' },
});
