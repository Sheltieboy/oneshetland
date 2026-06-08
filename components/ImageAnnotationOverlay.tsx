/**
 * components/ImageAnnotationOverlay.tsx
 *
 * Displays an image with optional "image pins" overlaid on it. Image pins
 * are stored in unit coordinates (0..1) so they survive resizing — see
 * memory_image_pins in migration 038.
 *
 * Two modes:
 *
 *   mode="view"   — read-only. Tap a pin to read its prompt + answer.
 *                   Used when browsing other people's memories.
 *
 *   mode="annotate" — author mode. Tap an empty spot to add a new pin
 *                     (a sheet/modal opens asking for the prompt), or tap
 *                     an existing pin to manage it. Used by the author
 *                     while creating / editing their memory.
 *
 * The parent owns the pin data and the prompt sheet — this component just
 * reports taps via callbacks. That keeps state mostly in the screen and
 * makes the overlay reusable in any context.
 */

import React, { useRef, useState } from 'react';
import {
  View, Image, StyleSheet, Pressable, Text,
  GestureResponderEvent, ViewStyle,
} from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { SECTIONS } from '@/constants/sections';
import { colors } from '@/constants/theme';
import { MemoryImagePin } from '@/lib/memories-api';

interface ImageAnnotationOverlayProps {
  uri:           string;
  pins:          MemoryImagePin[];
  mode:          'view' | 'annotate';
  /** Image natural aspect ratio (width / height) if known. Defaults to 4:3. */
  aspectRatio?:  number;
  onTapPin?:     (pin: MemoryImagePin) => void;
  /** Annotate mode only — fires when the user taps empty space to drop a new pin. */
  onTapEmpty?:   (point: { x: number; y: number }) => void;
  style?:        ViewStyle;
}

const SECTION = SECTIONS.memories;

export function ImageAnnotationOverlay({
  uri,
  pins,
  mode,
  aspectRatio = 4 / 3,
  onTapPin,
  onTapEmpty,
  style,
}: ImageAnnotationOverlayProps) {
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const lastTap = useRef(0);

  const handleTap = (e: GestureResponderEvent) => {
    if (mode !== 'annotate' || !onTapEmpty || !size.w || !size.h) return;
    const now = Date.now();
    if (now - lastTap.current < 200) return;
    lastTap.current = now;
    const x = e.nativeEvent.locationX / size.w;
    const y = e.nativeEvent.locationY / size.h;
    onTapEmpty({ x, y });
  };

  return (
    <View
      style={[styles.frame, { aspectRatio }, style]}
      onLayout={e => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
    >
      <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />

      {/* Tap-to-annotate target — sits behind the pins so pin taps win. */}
      {mode === 'annotate' ? (
        <Pressable style={StyleSheet.absoluteFill} onPress={handleTap} />
      ) : null}

      {/* Existing pins */}
      {size.w > 0 && pins.map(pin => {
        const cx = pin.x * size.w;
        const cy = pin.y * size.h;

        // Flip the label to the left when the pin is on the right half of
        // the image so it doesn't clip off the edge.
        const labelOnRight = pin.x < 0.65;

        return (
          <Pressable
            key={pin.id}
            onPress={() => onTapPin?.(pin)}
            hitSlop={8}
            style={[
              styles.pinAbs,
              { left: cx - 14, top: cy - 14 },
            ]}
          >
            <View style={styles.pinAndLabel}>
              <View
                style={[
                  styles.pinHead,
                  {
                    backgroundColor: pin.resolved ? colors.success : SECTION.color,
                  },
                ]}
              >
                <FontAwesome5
                  name={pin.resolved ? 'check' : 'question'}
                  size={12}
                  color="#fff"
                  solid
                />
              </View>
              {pin.resolved ? null : (
                <View style={styles.pulseRing} />
              )}

              {/* Visible tag label when resolved */}
              {pin.resolved && pin.resolved_answer ? (
                <View
                  style={[
                    styles.tagLabel,
                    labelOnRight
                      ? { left: 32 }
                      : { right: 32 },
                  ]}
                  pointerEvents="none"
                >
                  <Text
                    numberOfLines={1}
                    style={styles.tagLabelText}
                  >
                    {pin.resolved_answer}
                  </Text>
                </View>
              ) : null}

              {/* "N suggestions" badge for unresolved pins */}
              {!pin.resolved && pin.suggestions && pin.suggestions.length > 0 ? (
                <View
                  style={[
                    styles.suggestBadge,
                    labelOnRight
                      ? { left: 32 }
                      : { right: 32 },
                  ]}
                  pointerEvents="none"
                >
                  <FontAwesome5 name="lightbulb" size={9} color="#fff" solid />
                  <Text style={styles.suggestBadgeText}>
                    {pin.suggestions.length}
                  </Text>
                </View>
              ) : null}
            </View>
          </Pressable>
        );
      })}

      {/* Helper for annotate-mode when there are no pins yet */}
      {mode === 'annotate' && pins.length === 0 ? (
        <View pointerEvents="none" style={styles.hint}>
          <FontAwesome5 name="hand-pointer" size={12} color="#fff" solid />
          <Text style={styles.hintText}>Tap on the photo to mark "who is this?"</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    backgroundColor: '#000',
    borderRadius: 8,
    overflow: 'hidden',
    position: 'relative',
  },
  pinAbs: {
    position: 'absolute',
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinAndLabel: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  tagLabel: {
    position: 'absolute',
    top: 2,
    maxWidth: 160,
    backgroundColor: 'rgba(15, 28, 38, 0.85)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  tagLabelText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  suggestBadge: {
    position: 'absolute',
    top: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: SECTION.color,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
  },
  suggestBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '800',
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
    shadowOpacity: 0.4,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  pulseRing: {
    position: 'absolute',
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.65)',
  },
  hint: {
    position: 'absolute',
    bottom: 10,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 28, 38, 0.78)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    gap: 8,
  },
  hintText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
});

export default ImageAnnotationOverlay;
