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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ViewStyle, Platform, Image,
  TextInput, TouchableOpacity, Keyboard,
} from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { SECTIONS } from '@/constants/sections';
import { colors } from '@/constants/theme';
import { MemoryPin } from '@/lib/memories-api';
import { MEMORY_CATEGORY_BY_SLUG } from '@/constants/memory-categories';
import { searchPlaces, ShetlandPlace, PLACE_CATEGORY_LABEL } from '@/lib/places-api';

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

  // When zoomed close enough, hover-style pills below each pin show the era
  // / category so the map reads as a heritage atlas. We watch the
  // latitudeDelta from onRegionChangeComplete — under ~0.3° (~33 km
  // north-south) is roughly "looking at one parish".
  const [showLabels, setShowLabels] = useState(false);
  const handleRegionChangeComplete = (region: any) => {
    if (!region) return;
    setShowLabels(region.latitudeDelta < 0.3);
  };

  // ── Place search ─────────────────────────────────────────────────────────
  // Search the seed shetland-places dataset; tap a result and we animate
  // the map to that location. mapRef.current.animateToRegion is the
  // smooth-pan call. Closed dropdown when the query is empty or a result
  // is picked.
  const mapRef = useRef<any>(null);
  const [placeQuery, setPlaceQuery]     = useState('');
  const [placeResults, setPlaceResults] = useState<ShetlandPlace[]>([]);
  const [searchOpen, setSearchOpen]     = useState(false);

  useEffect(() => {
    const q = placeQuery.trim();
    if (q.length < 2) { setPlaceResults([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await searchPlaces(q);
      if (!cancelled) setPlaceResults(r);
    }, 220);
    return () => { cancelled = true; clearTimeout(t); };
  }, [placeQuery]);

  const flyToPlace = (place: ShetlandPlace) => {
    setPlaceQuery(place.name);
    setPlaceResults([]);
    setSearchOpen(false);
    Keyboard.dismiss();
    mapRef.current?.animateToRegion?.({
      latitude:       Number(place.lat),
      longitude:      Number(place.lng),
      // Roughly 6 km on a side — close enough to see streets / hamlets,
      // wide enough to see neighbouring places.
      latitudeDelta:  0.06,
      longitudeDelta: 0.06,
    }, 600);
  };

  return (
    <View style={[{ height, borderRadius: 12, overflow: 'hidden' }, style]}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        // Android uses Google Maps; iOS keeps Apple Maps.
        provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined}
        initialRegion={initialRegion}
        showsUserLocation
        showsMyLocationButton
        showsCompass
        onRegionChangeComplete={handleRegionChangeComplete}
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
        {pins.map(pin => (
          <MemoryMarker
            key={pin.id}
            pin={pin}
            selected={pin.id === selectedId}
            showLabel={showLabels}
            onOpen={() => onOpenPin?.(pin)}
          />
        ))}
      </MapView>

      {/* ── Place search overlay ──────────────────────────────────────── */}
      <View style={styles.searchOverlay} pointerEvents="box-none">
        <View style={styles.searchBar}>
          <FontAwesome5 name="search" size={13} color={colors.textMuted} />
          <TextInput
            value={placeQuery}
            onChangeText={(t) => { setPlaceQuery(t); setSearchOpen(true); }}
            onFocus={() => setSearchOpen(true)}
            placeholder="Search the map — Lerwick, Brae, Sumburgh…"
            placeholderTextColor={colors.textLight}
            style={styles.searchInput}
            autoCorrect={false}
            autoCapitalize="words"
            returnKeyType="search"
            onSubmitEditing={() => {
              if (placeResults[0]) flyToPlace(placeResults[0]);
            }}
          />
          {placeQuery ? (
            <TouchableOpacity
              onPress={() => { setPlaceQuery(''); setPlaceResults([]); setSearchOpen(false); Keyboard.dismiss(); }}
              hitSlop={8}
            >
              <FontAwesome5 name="times-circle" size={14} color={colors.textMuted} solid />
            </TouchableOpacity>
          ) : null}
        </View>

        {searchOpen && placeResults.length > 0 ? (
          <View style={styles.searchResults}>
            {placeResults.map((p, i) => (
              <TouchableOpacity
                key={p.id}
                onPress={() => flyToPlace(p)}
                style={[
                  styles.searchResultRow,
                  i < placeResults.length - 1 && styles.searchResultDivider,
                ]}
              >
                <View style={styles.searchResultIcon}>
                  <FontAwesome5 name={iconForPlaceCategory(p.category)} size={11} color={SECTION.color} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.searchResultName} numberOfLines={1}>{p.name}</Text>
                  <Text style={styles.searchResultMeta} numberOfLines={1}>
                    {PLACE_CATEGORY_LABEL[p.category] ?? p.category}
                    {p.region ? ` · ${p.region.replace(/\b\w/g, c => c.toUpperCase())}` : ''}
                  </Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}
      </View>

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

function iconForPlaceCategory(cat: string): string {
  switch (cat) {
    case 'settlement': return 'home';
    case 'island':     return 'mountain';
    case 'voe':        return 'water';
    case 'loch':       return 'tint';
    case 'beach':      return 'umbrella-beach';
    case 'headland':   return 'flag';
    case 'hill':       return 'mountain';
    case 'lighthouse': return 'lightbulb';
    case 'broch':      return 'archway';
    case 'sound':      return 'water';
    case 'geo':        return 'water';
    case 'landmark':   return 'map-marker-alt';
    default:           return 'map-marker-alt';
  }
}

// ── One memory marker ───────────────────────────────────────────────────────
//
// Each marker manages its own tracksViewChanges flag because:
//   1. The hero image inside the pin needs the marker to re-render once
//      after it loads, otherwise iOS bakes the empty pin into a static
//      bitmap and the photo never appears.
//   2. When the zoom level crosses the showLabels threshold, the marker's
//      view shape changes — same problem, fix the same way.
//
// We start with tracksViewChanges=true, flip it to false once the visual
// is settled, and re-arm it whenever the image loads or the label
// toggles. That keeps frame-rate sensible (otherwise every pan re-bitmaps
// every marker) while still ensuring the image and label actually paint.

function MemoryMarker({
  pin, selected, showLabel, onOpen,
}: {
  pin:       MemoryPin;
  selected:  boolean;
  showLabel: boolean;
  onOpen:    () => void;
}) {
  const [tracks, setTracks]         = useState(true);
  const [imageReady, setImageReady] = useState(false);

  // When the label-visibility flips, give the marker a couple of frames to
  // re-paint, then freeze again.
  useEffect(() => {
    setTracks(true);
    const t = setTimeout(() => setTracks(false), 600);
    return () => clearTimeout(t);
  }, [showLabel]);

  // Same for image-ready transitions.
  useEffect(() => {
    if (imageReady) {
      const t = setTimeout(() => setTracks(false), 300);
      return () => clearTimeout(t);
    }
  }, [imageReady]);

  // Build the visible label text. Prefer the era; otherwise fall back to
  // the label of the first category tag.
  const labelText = useMemo(() => {
    if (pin.era) return pin.era;
    const firstSlug = pin.tags?.[0];
    return firstSlug ? MEMORY_CATEGORY_BY_SLUG[firstSlug]?.label ?? null : null;
  }, [pin.era, pin.tags]);

  // Border / accent: era-pin uses memories rose; otherwise use the first
  // category colour. Subtle, but it makes the map read as a heat map.
  const accent = (() => {
    const firstSlug = pin.tags?.[0];
    return firstSlug
      ? MEMORY_CATEGORY_BY_SLUG[firstSlug]?.color ?? SECTION.color
      : SECTION.color;
  })();

  const showPhoto = pin.hero_url && pin.hero_kind === 'photo';
  const headSize  = selected ? styles.pinHeadSelected : styles.pinHead;

  return (
    <Marker
      coordinate={{ latitude: pin.lat, longitude: pin.lng }}
      anchor={{ x: 0.5, y: 1 }}
      tracksViewChanges={tracks}
      onPress={onOpen}
      title={pin.title ?? 'Memory'}
      description={pin.place_name ?? undefined}
    >
      <View style={styles.pinWrap}>
        <View style={[headSize, { backgroundColor: accent, overflow: 'hidden' }]}>
          {showPhoto ? (
            <Image
              source={{ uri: pin.hero_url! }}
              style={StyleSheet.absoluteFill}
              resizeMode="cover"
              onLoadEnd={() => setImageReady(true)}
            />
          ) : pin.media_count > 0 ? (
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
          ) : (
            <FontAwesome5
              name="book-open"
              size={selected ? 11 : 9}
              color="#fff"
              solid
            />
          )}

          {/* Tiny media-kind badge in the corner if hero is photo but there
              are also videos / audios — tells the viewer there's more
              than the thumbnail suggests. */}
          {showPhoto && (pin.hero_kind !== 'photo' || pin.media_count > 1) ? (
            <View style={styles.kindBadge}>
              <FontAwesome5
                name={pin.hero_kind === 'audio' ? 'microphone' : pin.hero_kind === 'video' ? 'video' : 'plus'}
                size={6}
                color="#fff"
                solid
              />
            </View>
          ) : null}
        </View>
        <View style={[styles.pinTail, { borderTopColor: accent }]} />

        {/* Zoom-aware label */}
        {showLabel && labelText ? (
          <View style={styles.pinLabel}>
            <Text numberOfLines={1} style={styles.pinLabelText}>{labelText}</Text>
          </View>
        ) : null}
      </View>
    </Marker>
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
  kindBadge: {
    position: 'absolute',
    bottom: 1,
    right: 1,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: 'rgba(15, 28, 38, 0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#fff',
  },
  pinLabel: {
    marginTop: 4,
    backgroundColor: 'rgba(15, 28, 38, 0.85)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    maxWidth: 120,
  },
  pinLabelText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  emptyHint: {
    position: 'absolute',
    left: 0,
    right: 0,
    // Sits BELOW the search bar overlay when the map is empty.
    top: 70,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(15, 28, 38, 0.82)',
    paddingVertical: 14,
    paddingHorizontal: 20,
    gap: 10,
  },

  searchOverlay: {
    position: 'absolute',
    left: 10,
    right: 10,
    top: 10,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#fff',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: colors.textPrimary,
    paddingVertical: 0,
  },
  searchResults: {
    marginTop: 6,
    backgroundColor: '#fff',
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5,
  },
  searchResultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  searchResultDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  searchResultIcon: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: SECTION.light,
    alignItems: 'center', justifyContent: 'center',
  },
  searchResultName: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  searchResultMeta: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 1,
  },
  emptyHintText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.2,
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
