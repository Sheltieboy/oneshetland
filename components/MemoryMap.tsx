/**
 * components/MemoryMap.tsx
 *
 * The hero canvas for the Memories section: the Shetland archipelago with
 * one bloom of rose-pink for every memory pin in view. Tap a pin to open
 * it; tap empty water/land to drop a new pin at that lat/lng.
 *
 * Uses the same Shetland_UK_blank_map.svg the Map It game uses, so memory
 * pins land in the exact same visual coordinate space as the game map.
 *
 * v1 ships a single fixed viewport showing the whole archipelago. Pan/
 * zoom is a follow-up — Map It already has a great implementation we can
 * lift when we're ready.
 *
 * Props:
 *   pins         all pins to render
 *   onOpenPin    fired with the pin when one is tapped
 *   onDropPin    fired with lat/lng when an empty spot is tapped
 *   selectedId   highlights a pin (pulses bigger). Used after returning
 *                from the detail screen so the user can see what they
 *                just opened.
 *   pendingPoint a "draft" pin shown in a different colour while the user
 *                is in the middle of creating a memory at this location.
 */

import React, { useMemo, useRef, useState } from 'react';
import {
  View, StyleSheet, TouchableWithoutFeedback,
  Pressable, Text, GestureResponderEvent, ViewStyle,
} from 'react-native';
import ShetlandMap from '../assets/Shetland_UK_blank_map.svg';
import { latLngToXY, xyToLatLng } from '@/lib/shetland-geometry';
import { SECTIONS } from '@/constants/sections';
import { colors } from '@/constants/theme';
import { MemoryPin } from '@/lib/memories-api';
import { FontAwesome5 } from '@expo/vector-icons';

interface MemoryMapProps {
  pins:           MemoryPin[];
  onOpenPin?:     (pin: MemoryPin) => void;
  onDropPin?:     (point: { lat: number; lng: number }) => void;
  selectedId?:    string | null;
  pendingPoint?:  { lat: number; lng: number } | null;
  /** Optional aspect ratio override (defaults to roughly Shetland's). */
  aspectRatio?:   number;
  style?:         ViewStyle;
}

const SECTION = SECTIONS.memories;

// Shetland is taller than it is wide. SVG viewBox is roughly 1:1.5 → match.
const DEFAULT_AR = 0.66;

export function MemoryMap({
  pins,
  onOpenPin,
  onDropPin,
  selectedId = null,
  pendingPoint = null,
  aspectRatio = DEFAULT_AR,
  style,
}: MemoryMapProps) {
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const lastTap = useRef(0);

  // Project lat/lng → screen for every pin once per render.
  const projected = useMemo(() => {
    if (!size.w || !size.h) return [];
    return pins.map(p => ({
      pin: p,
      xy:  latLngToXY(p.lat, p.lng, size.w, size.h),
    }));
  }, [pins, size.w, size.h]);

  const pendingXY = useMemo(() => {
    if (!pendingPoint || !size.w || !size.h) return null;
    return latLngToXY(pendingPoint.lat, pendingPoint.lng, size.w, size.h);
  }, [pendingPoint, size.w, size.h]);

  // Tap the empty canvas → drop pin at that lat/lng.
  // Tap on a child pin is intercepted by the pin's own Pressable so this
  // only fires for genuine "background" taps.
  const handleCanvasTap = (e: GestureResponderEvent) => {
    if (!onDropPin || !size.w || !size.h) return;
    // Debounce double-fire on iOS.
    const now = Date.now();
    if (now - lastTap.current < 250) return;
    lastTap.current = now;

    const { locationX, locationY } = e.nativeEvent;
    const point = xyToLatLng(locationX, locationY, size.w, size.h);
    onDropPin(point);
  };

  return (
    <View
      style={[styles.canvas, { aspectRatio }, style]}
      onLayout={e => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
    >
      {/* Sea background */}
      <View style={styles.sea} />

      {/* Shetland silhouette — re-renders as crisp vector at any size. */}
      {size.w > 0 && (
        <ShetlandMap
          width={size.w}
          height={size.h}
          style={StyleSheet.absoluteFill}
          preserveAspectRatio="none"
        />
      )}

      {/* Tap-to-drop target. Sits BEHIND the pins so child pins win the tap. */}
      <TouchableWithoutFeedback onPress={handleCanvasTap}>
        <View style={StyleSheet.absoluteFill} />
      </TouchableWithoutFeedback>

      {/* Pending (draft) pin */}
      {pendingXY ? (
        <View
          pointerEvents="none"
          style={[styles.pinWrap, { left: pendingXY.x - 14, top: pendingXY.y - 28 }]}
        >
          <View style={[styles.pinDraftHead, { backgroundColor: colors.accent }]} />
          <View style={[styles.pinTail, { borderTopColor: colors.accent }]} />
        </View>
      ) : null}

      {/* Memory pins */}
      {projected.map(({ pin, xy }) => {
        const selected = pin.id === selectedId;
        return (
          <Pressable
            key={pin.id}
            onPress={() => onOpenPin?.(pin)}
            hitSlop={6}
            style={[
              styles.pinWrap,
              {
                left: xy.x - (selected ? 18 : 14),
                top:  xy.y - (selected ? 36 : 28),
              },
            ]}
          >
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
          </Pressable>
        );
      })}

      {/* Subtle helper hint when the map is empty. */}
      {pins.length === 0 && onDropPin ? (
        <View pointerEvents="none" style={styles.emptyHint}>
          <FontAwesome5 name="hand-pointer" size={12} color="#fff" solid />
          <Text style={styles.emptyHintText}>Tap anywhere to drop the first memory</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: {
    width: '100%',
    backgroundColor: '#DCEEFF',  // sea
    borderRadius: 12,
    overflow: 'hidden',
    position: 'relative',
  },
  sea: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#DCEEFF',
  },
  pinWrap: {
    position: 'absolute',
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
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  pinHeadSelected: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 3,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
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
});

export default MemoryMap;
