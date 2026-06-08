/**
 * components/MemoryMapNative.tsx
 *
 * The real map view for the Memories section — backed by react-native-maps
 * so islanders get actual place names ("Hillswick", "Da Lodberries"), zoom
 * and pan, satellite toggle, the lot. Replaces the SVG silhouette map
 * (which lives on for Map It game purposes in components/MemoryMap.tsx).
 *
 * Tile provider:
 *   iOS     — Apple Maps (no API key)
 *   Android — Google Maps (PROVIDER_GOOGLE). Needs a Maps SDK API key in
 *             app.json → expo.android.config.googleMaps.apiKey. Without
 *             one, the map renders blank tiles on Android — the soft
 *             import below catches a missing package but NOT a missing
 *             key; see commit notes if you ship Android.
 *
 * Tap-to-drop:
 *   onDropPin fires on any tap that's NOT on a marker. react-native-maps
 *   debounces this for us, so we don't need our own iOS double-fire guard.
 *
 * Markers:
 *   We render a custom rose-pink head with a tail and (when there's
 *   media) a small kind icon inside. Apple Maps' default red pin would
 *   visually clash with the Memories rose, so we override with a custom
 *   <Marker> child view.
 */

import React, { useMemo, useRef } from 'react';
import {
  View, Text, StyleSheet, ViewStyle, Platform, TouchableOpacity,
} from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { SECTIONS } from '@/constants/sections';
import { colors } from '@/constants/theme';
import { MemoryPin } from '@/lib/memories-api';

const SECTION = SECTIONS.memories;

// ── Soft-load react-native-maps so a missing dep alerts instead of crashing.

let MapView: any = null;
let Marker:  any = null;
let PROVIDER_GOOGLE: any = undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Maps = require('react-native-maps');
  MapView         = Maps.default ?? Maps;
  Marker          = Maps.Marker;
  PROVIDER_GOOGLE = Maps.PROVIDER_GOOGLE;
} catch {
  MapView = null;
}

// Shetland-centred default region. Wide enough to show Fair Isle south to
// Unst north on first paint, then the user zooms in.
const SHETLAND_REGION = {
  latitude:       60.30,
  longitude:     -1.25,
  latitudeDelta:  1.6,
  longitudeDelta: 1.6,
};

interface MemoryMapNativeProps {
  pins:           MemoryPin[];
  onOpenPin?:     (pin: MemoryPin) => void;
  onDropPin?:     (point: { lat: number; lng: number }) => void;
  selectedId?:    string | null;
  pendingPoint?:  { lat: number; lng: number } | null;
  /** Fixed height for the map. Default 420. */
  height?:        number;
  style?:         ViewStyle;
}

export function MemoryMapNative({
  pins,
  onOpenPin,
  onDropPin,
  selectedId = null,
  pendingPoint = null,
  height = 420,
  style,
}: MemoryMapNativeProps) {

  // If react-native-maps isn't installed, render a friendly placeholder
  // rather than crashing the screen.
  if (!MapView) {
    return (
      <View style={[styles.fallback, { height }, style]}>
        <FontAwesome5 name="map" size={32} color={SECTION.color} />
        <Text style={styles.fallbackTitle}>Map module not installed</Text>
        <Text style={styles.fallbackBody}>
          Run:  npx expo install react-native-maps
        </Text>
      </View>
    );
  }

  const initialRegion = useMemo(() => {
    // If there's a pending pin (the user has chosen a location while
    // creating a memory), centre on it. Otherwise centre on Shetland.
    if (pendingPoint) {
      return {
        latitude:       pendingPoint.lat,
        longitude:      pendingPoint.lng,
        latitudeDelta:  0.6,
        longitudeDelta: 0.6,
      };
    }
    return SHETLAND_REGION;
  }, [pendingPoint]);

  return (
    <View style={[{ height, borderRadius: 12, overflow: 'hidden' }, style]}>
      <MapView
        style={StyleSheet.absoluteFill}
        // Android uses Google Maps; iOS keeps Apple Maps.
        provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined}
        initialRegion={initialRegion}
        showsUserLocation
        showsMyLocationButton
        showsCompass
        // Tap on map (not on a marker) → drop a new pin there.
        onPress={(e: any) => {
          if (!onDropPin) return;
          const { latitude, longitude } = e.nativeEvent.coordinate ?? {};
          if (typeof latitude !== 'number' || typeof longitude !== 'number') return;
          onDropPin({ lat: latitude, lng: longitude });
        }}
      >
        {/* Pending (draft) marker */}
        {pendingPoint ? (
          <Marker
            coordinate={{ latitude: pendingPoint.lat, longitude: pendingPoint.lng }}
            anchor={{ x: 0.5, y: 1 }}
            tracksViewChanges={false}
          >
            <View style={styles.pinWrap}>
              <View style={[styles.pinDraftHead, { backgroundColor: colors.accent }]}>
                <FontAwesome5 name="plus" size={11} color="#fff" solid />
              </View>
              <View style={[styles.pinTail, { borderTopColor: colors.accent }]} />
            </View>
          </Marker>
        ) : null}

        {/* Memory pins */}
        {pins.map(pin => {
          const selected = pin.id === selectedId;
          return (
            <Marker
              key={pin.id}
              coordinate={{ latitude: pin.lat, longitude: pin.lng }}
              anchor={{ x: 0.5, y: 1 }}
              tracksViewChanges={false}
              onPress={() => onOpenPin?.(pin)}
              title={pin.title ?? 'Memory'}
              description={pin.place_name ?? undefined}
            >
              <View style={styles.pinWrap}>
                <View
                  style={[
                    selected ? styles.pinHeadSelected : styles.pinHead,
                    { backgroundColor: SECTION.color },
                  ]}
                >
                  {pin.media_count > 0 ? (
                    <FontAwesome5
                      name={
                        pin.hero_kind === 'audio' ? 'microphone' :
                        pin.hero_kind === 'video' ? 'video'      :
                        'image'
                      }
                      size={selected ? 11 : 9}
                      color="#fff"
                      solid
                    />
                  ) : null}
                </View>
                <View style={[styles.pinTail, { borderTopColor: SECTION.color }]} />
              </View>
            </Marker>
          );
        })}
      </MapView>

      {/* Helper hint when the map is empty AND we're in drop mode */}
      {pins.length === 0 && onDropPin ? (
        <View pointerEvents="none" style={styles.emptyHint}>
          <FontAwesome5 name="hand-pointer" size={12} color="#fff" solid />
          <Text style={styles.emptyHintText}>Tap a place to drop the first memory</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pinWrap: {
    alignItems: 'center',
  },
  pinHead: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2.5,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinHeadSelected: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 3,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinDraftHead: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2.5,
    borderColor: '#fff',
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinTail: {
    width: 0,
    height: 0,
    marginTop: -2,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderTopWidth: 7,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  emptyHint: {
    position: 'absolute',
    alignSelf: 'center',
    top: '45%',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 28, 38, 0.78)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    gap: 8,
  },
  emptyHintText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  fallback: {
    width: '100%',
    backgroundColor: SECTION.light,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 16,
  },
  fallbackTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  fallbackBody: {
    fontSize: 12,
    color: colors.textMuted,
    textAlign: 'center',
  },
});

export default MemoryMapNative;
