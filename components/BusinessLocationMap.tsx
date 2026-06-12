/**
 * BusinessLocationMap
 *
 * Compact, non-interactive map showing a business pin, with a tap target that
 * opens the device maps app for directions. Uses react-native-maps (Google on
 * Android, Apple Maps on iOS unless a Google iOS SDK key is configured).
 * Soft-loads the maps module so a missing dep degrades to an "Open in Maps"
 * button rather than crashing.
 */

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform, Linking } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius } from '@/constants/theme';

let MapView: any = null;
let Marker:  any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Maps = require('react-native-maps');
  MapView = Maps.default ?? Maps;
  Marker  = Maps.Marker;
} catch {
  MapView = null;
}

interface Props {
  lat:     number | null;
  lng:     number | null;
  name:    string;
  address?: string | null;
  color?:  string;
  height?: number;
}

export function BusinessLocationMap({ lat, lng, name, address, color = '#7C3AED', height = 160 }: Props) {
  if (lat == null || lng == null) return null;

  const openDirections = () => {
    const label = encodeURIComponent(name);
    const url = Platform.select({
      ios:     `http://maps.apple.com/?daddr=${lat},${lng}&q=${label}`,
      android: `geo:${lat},${lng}?q=${lat},${lng}(${label})`,
      default: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
    })!;
    Linking.openURL(url).catch(() => {});
  };

  const region = { latitude: lat, longitude: lng, latitudeDelta: 0.012, longitudeDelta: 0.012 };

  return (
    <TouchableOpacity activeOpacity={0.9} onPress={openDirections} style={[styles.wrap, { height }]}>
      {MapView ? (
        <MapView
          style={StyleSheet.absoluteFill}
          region={region}
          pointerEvents="none"
          scrollEnabled={false}
          zoomEnabled={false}
          rotateEnabled={false}
          pitchEnabled={false}
          toolbarEnabled={false}
        >
          <Marker coordinate={{ latitude: lat, longitude: lng }} pinColor={color} />
        </MapView>
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.fallback]}>
          <FontAwesome5 name="map-marked-alt" size={26} color={color} />
        </View>
      )}

      {/* Directions pill */}
      <View style={styles.pill}>
        <FontAwesome5 name="directions" size={11} color={color} solid />
        <Text style={[styles.pillText, { color }]}>Directions</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderRadius: radius.lg, overflow: 'hidden',
    borderWidth: 1, borderColor: colors.border, backgroundColor: '#eef0f2',
    marginBottom: 12,
  },
  fallback: { alignItems: 'center', justifyContent: 'center' },
  pill: {
    position: 'absolute', right: 10, bottom: 10,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#fff', borderRadius: radius.full,
    paddingHorizontal: 12, paddingVertical: 7,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 6, elevation: 3,
  },
  pillText: { fontSize: fontSize.xs, fontWeight: '800' },
});
