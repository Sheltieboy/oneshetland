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
import {
  searchPlaces, ShetlandPlace, PLACE_CATEGORY_LABEL,
  loadRecentPlaces, pushRecentPlace,
} from '@/lib/places-api';

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

// ── Grid clustering ──────────────────────────────────────────────────────────
//
// react-native-maps has no built-in clustering, and we deliberately don't add
// a new dependency. Instead we do lightweight grid clustering: divide the
// visible world into a grid whose cell size scales with the current zoom
// (latitudeDelta), then collapse every pin that lands in the same cell into a
// single count bubble. Zoom in → cells shrink → clusters break apart until
// you're looking at individual pins. Below the parish threshold we stop
// clustering entirely so close-up browsing always shows real pins.
//
// Keeping ~14 cells across the viewport gives a readable Lerwick (hundreds of
// pins collapse to a handful of bubbles) without over-merging.
const CLUSTER_CELLS = 14;
// Once the view is tighter than this (≈ one parish) we show every pin.
const CLUSTER_DISABLE_DELTA = 0.08;

interface Cluster {
  /** Stable key for React. */
  key:    string;
  lat:    number;
  lng:    number;
  /** The pins gathered into this cell. */
  pins:   MemoryPin[];
}

function buildClusters(pins: MemoryPin[], latDelta: number): Cluster[] {
  const cell = Math.max(latDelta / CLUSTER_CELLS, 1e-4);
  const buckets = new Map<string, MemoryPin[]>();
  for (const p of pins) {
    if (typeof p.lat !== 'number' || typeof p.lng !== 'number') continue;
    const gx = Math.floor(p.lng / cell);
    const gy = Math.floor(p.lat / cell);
    const k = `${gx}:${gy}`;
    const arr = buckets.get(k);
    if (arr) arr.push(p);
    else buckets.set(k, [p]);
  }
  const out: Cluster[] = [];
  for (const [k, group] of buckets) {
    // Cluster centre = mean of its members (looks tidier than the cell centre).
    let sumLat = 0, sumLng = 0;
    for (const p of group) { sumLat += p.lat; sumLng += p.lng; }
    out.push({
      key:  k,
      lat:  sumLat / group.length,
      lng:  sumLng / group.length,
      pins: group,
    });
  }
  return out;
}

interface MemoryMapNativeProps {
  pins:           MemoryPin[];
  onOpenPin?:     (pin: MemoryPin) => void;
  onDropPin?:     (point: { lat: number; lng: number }) => void;
  selectedId?:    string | null;
  pendingPoint?:  { lat: number; lng: number } | null;
  /**
   * Fired when the user picks a place from the search dropdown — the map
   * has already animated to it by the time this fires. Memories tab uses
   * it to surface a "Memories near {name}" feed under the map.
   */
  onPlacePicked?: (place: ShetlandPlace) => void;
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
  onPlacePicked,
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
  // Current view zoom (in latitudeDelta degrees). Used both to decide when
  // labels appear and to scale pins up when the user has zoomed in close.
  const [latDelta, setLatDelta]   = useState(1.6);
  const handleRegionChangeComplete = (region: any) => {
    if (!region) return;
    setShowLabels(region.latitudeDelta < 0.3);
    setLatDelta(region.latitudeDelta);
  };

  // ── Map taps → onDropPin only ────────────────────────────────────────────
  //
  // iOS bubbles marker taps up to the MapView too — so even when
  // Marker.onPress fires correctly, the map's onPress runs immediately
  // after with the same coordinate. Without a guard that fires onDropPin
  // and pushes the new-memory screen *in addition* to the detail screen
  // the marker already opened.
  //
  // Fix: a ref records the timestamp of the last marker tap. handleMapPress
  // short-circuits if it's within 450 ms — that's long enough to catch
  // the residual map event but short enough that a genuine second tap is
  // still respected as a "drop here" gesture.
  const markerTouchedAt = useRef(0);

  const handleMarkerOpen = (pin: MemoryPin) => {
    markerTouchedAt.current = Date.now();
    onOpenPin?.(pin);
  };

  // ── Clustering ─────────────────────────────────────────────────────────────
  // Collapse nearby pins into count bubbles while zoomed out; show real pins
  // once we're in close. Recomputed only when the pin set or zoom changes.
  const clusterers = latDelta > CLUSTER_DISABLE_DELTA;
  const clusters = useMemo(
    () => (clusterers ? buildClusters(pins, latDelta) : []),
    [pins, latDelta, clusterers],
  );

  // Tapping a cluster zooms the map in on its members' bounds so the cluster
  // breaks apart — the standard "expand on tap" gesture, no extra dependency.
  const handleClusterPress = (cluster: Cluster) => {
    markerTouchedAt.current = Date.now();
    const lats = cluster.pins.map(p => p.lat);
    const lngs = cluster.pins.map(p => p.lng);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    // Pad the bounds a touch, and floor the span so a tight cluster still
    // zooms in meaningfully rather than barely nudging.
    const latSpan = Math.max((maxLat - minLat) * 1.6, 0.02);
    const lngSpan = Math.max((maxLng - minLng) * 1.6, 0.02);
    mapRef.current?.animateToRegion?.({
      latitude:       (minLat + maxLat) / 2,
      longitude:      (minLng + maxLng) / 2,
      latitudeDelta:  latSpan,
      longitudeDelta: lngSpan,
    }, 450);
  };

  const handleMapPress = (e: any) => {
    if (Date.now() - markerTouchedAt.current < 450) return;
    if (!onDropPin) return;
    const { latitude, longitude } = e?.nativeEvent?.coordinate ?? {};
    if (typeof latitude !== 'number' || typeof longitude !== 'number') return;
    onDropPin({ lat: latitude, lng: longitude });
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
  const [recentPlaces, setRecentPlaces] = useState<ShetlandPlace[]>([]);

  // Load recent picks on mount so the empty search box already has chips.
  useEffect(() => {
    void loadRecentPlaces().then(setRecentPlaces);
  }, []);

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
    // Persist for the recents chip row, then bubble up so the screen can
    // show "Memories near {name}" cards beside the map.
    void pushRecentPlace(place).then(setRecentPlaces);
    onPlacePicked?.(place);
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
        // Forgiving handler: tap on a pin (or near one) opens the pin;
        // tap elsewhere falls through to onDropPin if provided.
        onPress={handleMapPress}
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

        {/* Memory pins — clustered into count bubbles while zoomed out, then
            broken out into individual markers once we're in close. A single
            pin in a cell renders as the real marker even while clustering is
            on, so lone stories never hide behind a "1" bubble. */}
        {clusterers
          ? clusters.map(c =>
              c.pins.length === 1 ? (
                <MemoryMarker
                  key={c.pins[0].id}
                  pin={c.pins[0]}
                  selected={c.pins[0].id === selectedId}
                  showLabel={showLabels}
                  zoomedIn={latDelta < 0.3}
                  onOpen={() => handleMarkerOpen(c.pins[0])}
                />
              ) : (
                <ClusterMarker
                  key={c.key}
                  cluster={c}
                  onPress={() => handleClusterPress(c)}
                />
              ),
            )
          : pins.map(pin => (
              <MemoryMarker
                key={pin.id}
                pin={pin}
                selected={pin.id === selectedId}
                showLabel={showLabels}
                zoomedIn={latDelta < 0.3}
                onOpen={() => handleMarkerOpen(pin)}
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

        {/* Recents row — shown when the box is focused but empty. */}
        {searchOpen && placeQuery.trim().length < 2 && recentPlaces.length > 0 ? (
          <View style={styles.recentsWrap}>
            <Text style={styles.recentsLabel}>Recent</Text>
            <View style={styles.recentsRow}>
              {recentPlaces.map(p => (
                <TouchableOpacity
                  key={p.id}
                  onPress={() => flyToPlace(p)}
                  style={styles.recentChip}
                >
                  <FontAwesome5
                    name={iconForPlaceCategory(p.category)}
                    size={10}
                    color={SECTION.color}
                  />
                  <Text style={styles.recentChipText} numberOfLines={1}>{p.name}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ) : null}

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
          <Text style={styles.emptyHintText}>Tap a place to drop the first story</Text>
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

// ── Cluster bubble ───────────────────────────────────────────────────────────
//
// A count bubble standing in for several pins gathered into one grid cell.
// Sized up a little for bigger counts so a busy Lerwick reads at a glance.
// Tapping zooms in on the cluster's bounds (handled by the parent).

function ClusterMarker({
  cluster, onPress,
}: {
  cluster: Cluster;
  onPress: () => void;
}) {
  const n = cluster.pins.length;
  const big = n >= 25;
  const size = big ? 48 : n >= 10 ? 42 : 36;

  return (
    <Marker
      coordinate={{ latitude: cluster.lat, longitude: cluster.lng }}
      anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={false}
      onPress={onPress}
      accessibilityLabel={`${n} stories here — tap to zoom in`}
    >
      <View style={styles.pinWrap}>
        <View
          style={[
            styles.clusterBubble,
            { width: size, height: size, borderRadius: size / 2, backgroundColor: SECTION.color },
          ]}
        >
          <Text style={styles.clusterCount}>{n > 99 ? '99+' : n}</Text>
        </View>
      </View>
    </Marker>
  );
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
  pin, selected, showLabel, zoomedIn, onOpen,
}: {
  pin:       MemoryPin;
  selected:  boolean;
  showLabel: boolean;
  zoomedIn:  boolean;
  onOpen:    () => void;
}) {
  const [tracks, setTracks]         = useState(true);
  const [imageReady, setImageReady] = useState(false);

  // When the label-visibility OR zoomed-in state flips, give the marker a
  // couple of frames to re-paint at the new size, then freeze again.
  useEffect(() => {
    setTracks(true);
    const t = setTimeout(() => setTracks(false), 600);
    return () => clearTimeout(t);
  }, [showLabel, zoomedIn]);

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
  // Pin grows when the user has zoomed in past the parish threshold —
  // visual confirmation that taps are now on bigger targets.
  const headSize  = selected
    ? styles.pinHeadSelected
    : zoomedIn ? styles.pinHeadZoomed : styles.pinHead;

  return (
    <Marker
      coordinate={{ latitude: pin.lat, longitude: pin.lng }}
      // Anchor slightly higher than the geometric bottom because the
      // larger touch halo below extends past the visible pin tail.
      anchor={{ x: 0.5, y: 0.86 }}
      tracksViewChanges={tracks}
      onPress={onOpen}
      title={pin.title ?? 'Memory'}
      description={pin.place_name ?? undefined}
      accessibilityLabel={
        `Story: ${pin.title ?? 'Untitled'}` +
        (pin.place_name ? `, ${pin.place_name}` : '') +
        (pin.era ? `, ${pin.era}` : '')
      }
    >
      {/* Transparent halo expands the touchable area to ~52 px without
          changing the visible pin size. iOS hit-tests the entire view
          tree, so taps in this padding open the memory just like taps on
          the head. */}
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
    // Wider than the visible pin so iOS's marker hit-test catches taps
    // around the edge of the pin head, not just dead-centre on it.
    width: 56,
    alignItems: 'center',
    paddingVertical: 6,
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
  pinHeadZoomed: {
    // Mid-size used when the user has zoomed in close. Visual confirmation
    // that pins are now bigger targets — no hover needed.
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 2.5,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinHeadSelected: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 3,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  clusterBubble: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: '#fff',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  clusterCount: {
    color: '#fff',
    fontWeight: '900',
    fontSize: 14,
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
  recentsWrap: {
    marginTop: 6,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 10,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5,
  },
  recentsLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 6,
  },
  recentsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  recentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: SECTION.light,
    maxWidth: 180,
  },
  recentChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textPrimary,
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
