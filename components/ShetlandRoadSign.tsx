/**
 * ShetlandRoadSign
 *
 * A mocked-up UK primary-route road sign reading "Shetland" — a green panel with
 * a white border + route arrow on posts, against a Shetland-ish sky. Rendered as
 * the Fetch tab's header banner (passed to TabScreenHeader's `banner` slot) in
 * place of a photo. Pure SVG so it stays crisp at any size.
 */

import React from 'react';
import Svg, { Defs, LinearGradient, Stop, Rect, Path, Text as SvgText } from 'react-native-svg';

export function ShetlandRoadSign() {
  return (
    <Svg width="100%" height="100%" viewBox="0 0 680 200" preserveAspectRatio="xMidYMid slice">
      <Defs>
        <LinearGradient id="sign-sky" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#9db4c2" />
          <Stop offset="1" stopColor="#c9d6dc" />
        </LinearGradient>
      </Defs>

      {/* Sky + heather hills */}
      <Rect x="0" y="0" width="680" height="200" fill="url(#sign-sky)" />
      <Path d="M0 150 Q 170 120 340 142 T 680 138 L680 200 L0 200 Z" fill="#5c6a4c" />
      <Path d="M0 168 Q 200 150 400 166 T 680 160 L680 200 L0 200 Z" fill="#46523a" />

      {/* Posts */}
      <Rect x="333" y="120" width="9" height="60" fill="#8b9197" />
      <Rect x="441" y="120" width="9" height="60" fill="#8b9197" />

      {/* Sign panel */}
      <Rect x="250" y="40" width="300" height="86" rx="10" fill="#006b3c" stroke="#ffffff" strokeWidth="4" />
      {/* Route arrow */}
      <Path d="M289 83 L309 70 L309 78 L325 78 L325 88 L309 88 L309 96 Z" fill="#ffffff" />
      <SvgText x="415" y="95" textAnchor="middle" fill="#ffffff" fontSize="40" fontWeight="700">Shetland</SvgText>
    </Svg>
  );
}
