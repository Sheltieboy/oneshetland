/**
 * components/ShetlandSign.tsx
 *
 * Procedurally renders a Shetland-style road sign for ANY place name.
 *
 * Visual references the traditional UK rural finger-post style used across
 * Shetland's road network: white background, double black border (thick
 * outer + thin inner with a small gap), bold sans-serif uppercase place
 * name, optional distance, optional arrow, optional dialect subtitle.
 *
 * Why procedural rather than uploaded images?
 *   - Works for every place on Shetland — Lerwick, Brae, Hillswick, Cullivoe,
 *     Hamnavoe, Sandwick, anything new the user types — without an asset
 *     library.
 *   - Stays sharp at any size (no PNG aliasing).
 *   - Reskinnable from one place if the visual language ever changes.
 *
 * Usage:
 *   <ShetlandSign name="Lerwick" />
 *   <ShetlandSign name="Brae" distance="12" unit="miles" arrow="right" />
 *   <ShetlandSign name="Lerwick" subtitle="Hjaltland" size="lg" />
 */

import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ViewStyle } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';

export type ShetlandSignSize = 'sm' | 'md' | 'lg';
export type SignArrow = 'left' | 'right' | 'up' | 'none';

interface ShetlandSignProps {
  /** Place name. Rendered uppercase. Required. */
  name:       string;
  /** Optional distance number (rendered as a small numeral next to the name). */
  distance?:  string | number | null;
  /** Optional unit label for distance. Defaults to "miles" when distance is set. */
  unit?:      string;
  /** Optional dialect / second-language line under the main name. */
  subtitle?:  string | null;
  /** Optional finger-post arrow direction. */
  arrow?:     SignArrow;
  /** Size preset. */
  size?:      ShetlandSignSize;
  /** Style override applied to the outer container. */
  style?:     ViewStyle;
  /** Render a tiny wooden-look "post" stub underneath for decorative cards. */
  withPost?:  boolean;
  /** Slight rotation to make the sign feel less digital (degrees). */
  tilt?:      number;
}

const SIZE_MAP = {
  sm: {
    paddingV: 6,
    paddingH: 12,
    nameSize: 14,
    subSize: 10,
    distSize: 12,
    arrowSize: 14,
    borderOuter: 2,
    borderInner: 1,
    gap: 3,
    radius: 4,
    postH: 14,
    postW: 6,
  },
  md: {
    paddingV: 10,
    paddingH: 18,
    nameSize: 20,
    subSize: 12,
    distSize: 16,
    arrowSize: 18,
    borderOuter: 3,
    borderInner: 1,
    gap: 4,
    radius: 6,
    postH: 22,
    postW: 8,
  },
  lg: {
    paddingV: 14,
    paddingH: 24,
    nameSize: 28,
    subSize: 14,
    distSize: 22,
    arrowSize: 24,
    borderOuter: 4,
    borderInner: 1,
    gap: 5,
    radius: 8,
    postH: 32,
    postW: 10,
  },
} as const;

const SIGN_BLACK = '#0A0A0A';
const SIGN_WHITE = '#FAFAF7'; // very slight cream — looks like enamel rather than UI white
const POST_COLOUR = '#3F2A18';

function arrowIcon(arrow: SignArrow): string | null {
  switch (arrow) {
    case 'left':  return 'arrow-left';
    case 'right': return 'arrow-right';
    case 'up':    return 'arrow-up';
    default:      return null;
  }
}

export function ShetlandSign({
  name,
  distance,
  unit = 'miles',
  subtitle,
  arrow = 'none',
  size = 'md',
  style,
  withPost = false,
  tilt = 0,
}: ShetlandSignProps) {
  const s = SIZE_MAP[size];
  const icon = arrowIcon(arrow);

  // UK road signs use mixed-case sentence-style. Shetland local fingers tend
  // to use ALL CAPS for the main name — that's what we mirror here.
  const displayName = useMemo(() => name.trim().toUpperCase(), [name]);

  const containerTransform = tilt !== 0 ? [{ rotate: `${tilt}deg` }] : undefined;

  return (
    <View style={[styles.wrap, { transform: containerTransform }, style]}>
      {/* Outer border (thick) */}
      <View
        style={[
          styles.outer,
          {
            backgroundColor: SIGN_BLACK,
            padding: s.gap,
            borderRadius: s.radius + s.gap,
          },
        ]}
      >
        {/* White plate */}
        <View
          style={[
            styles.plate,
            {
              backgroundColor: SIGN_WHITE,
              paddingVertical: s.paddingV,
              paddingHorizontal: s.paddingH,
              borderRadius: s.radius,
              borderWidth: s.borderInner,
              borderColor: SIGN_BLACK,
            },
          ]}
        >
          <View style={styles.row}>
            {icon && arrow === 'left' ? (
              <FontAwesome5
                name={icon}
                size={s.arrowSize}
                color={SIGN_BLACK}
                style={{ marginRight: s.paddingH / 2 }}
              />
            ) : null}

            <View style={{ alignItems: 'center' }}>
              <Text
                allowFontScaling={false}
                numberOfLines={1}
                style={{
                  fontSize: s.nameSize,
                  color: SIGN_BLACK,
                  fontWeight: '900',
                  letterSpacing: 0.5,
                  // System sans-serif. Bold weight + tracking gets close to
                  // the UK Transport font look without bundling a typeface.
                }}
              >
                {displayName}
              </Text>
              {subtitle ? (
                <Text
                  allowFontScaling={false}
                  numberOfLines={1}
                  style={{
                    fontSize: s.subSize,
                    color: SIGN_BLACK,
                    fontStyle: 'italic',
                    opacity: 0.75,
                    marginTop: 2,
                  }}
                >
                  {subtitle}
                </Text>
              ) : null}
            </View>

            {distance != null && distance !== '' ? (
              <View
                style={{
                  marginLeft: s.paddingH / 1.5,
                  alignItems: 'center',
                }}
              >
                <Text
                  allowFontScaling={false}
                  style={{
                    fontSize: s.distSize,
                    color: SIGN_BLACK,
                    fontWeight: '900',
                  }}
                >
                  {distance}
                </Text>
                <Text
                  allowFontScaling={false}
                  style={{
                    fontSize: s.subSize,
                    color: SIGN_BLACK,
                    opacity: 0.7,
                    marginTop: -2,
                  }}
                >
                  {unit}
                </Text>
              </View>
            ) : null}

            {icon && arrow === 'right' ? (
              <FontAwesome5
                name={icon}
                size={s.arrowSize}
                color={SIGN_BLACK}
                style={{ marginLeft: s.paddingH / 2 }}
              />
            ) : null}

            {icon && arrow === 'up' ? (
              <FontAwesome5
                name={icon}
                size={s.arrowSize}
                color={SIGN_BLACK}
                style={{ marginLeft: s.paddingH / 2 }}
              />
            ) : null}
          </View>
        </View>
      </View>

      {withPost ? (
        <View
          style={{
            width: s.postW,
            height: s.postH,
            backgroundColor: POST_COLOUR,
            alignSelf: 'center',
            borderBottomLeftRadius: 2,
            borderBottomRightRadius: 2,
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
  outer: {
    // padding is set per-size to create the gap between outer thick and inner thin border
  },
  plate: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});

export default ShetlandSign;
