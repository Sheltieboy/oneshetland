/**
 * GameArt
 *
 * Flat vector "cover art" for each game, drawn with react-native-svg so it's
 * crisp at any size and matches the app palette. Used on the Games hub tiles,
 * the home "Today's game" card, and anywhere a game needs a face.
 *
 *   <GameArt id="spik_sprint" size={64} />
 */

import React from 'react';
import Svg, {
  Defs, LinearGradient, Stop, Rect, Path, G, Circle, Text as SvgText,
} from 'react-native-svg';
import type { GameId } from '@/lib/games-api';

const PALETTE: Record<GameId, { a: string; b: string }> = {
  spik_sprint:   { a: '#12C98B', b: '#059669' }, // emerald
  spik_snap:     { a: '#F6A723', b: '#E0820F' }, // amber
  guess_da_wird: { a: '#3B82F6', b: '#1D4ED8' }, // blue
  map_it:        { a: '#19BBDD', b: '#0E8FAC' }, // teal
};

const W = 'rgba(255,255,255,0.96)';
const WSOFT = 'rgba(255,255,255,0.55)';

/** Per-game accent colour (good contrast with white text) for theming screens. */
export const GAME_COLORS: Record<GameId, string> = {
  spik_sprint:   '#10B981',
  spik_snap:     '#E0820F',
  guess_da_wird: '#2563EB',
  map_it:        '#0E8FAC',
};

/** Soft tint per game — for light backgrounds / pills. */
export const GAME_LIGHTS: Record<GameId, string> = {
  spik_sprint:   '#D1FAE5',
  spik_snap:     '#FDE8C7',
  guess_da_wird: '#DBEAFE',
  map_it:        '#D0F0F7',
};

interface Props {
  id:      GameId;
  size?:   number;
  radius?: number;
}

export function GameArt({ id, size = 64, radius = 18 }: Props) {
  const p = PALETTE[id] ?? PALETTE.spik_sprint;
  const gid = `ga-${id}`;
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={gid} x1="0" y1="0" x2="0.4" y2="1">
          <Stop offset="0" stopColor={p.a} />
          <Stop offset="1" stopColor={p.b} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100" height="100" rx={radius} fill={`url(#${gid})`} />
      {id === 'spik_sprint'   && <SprintMotif />}
      {id === 'spik_snap'     && <SnapMotif />}
      {id === 'guess_da_wird' && <WirdMotif a={p.a} />}
      {id === 'map_it'        && <MapMotif a={p.b} />}
    </Svg>
  );
}

// Speedy lightning bolt + motion lines
function SprintMotif() {
  return (
    <G>
      <Rect x="12" y="38" width="22" height="5" rx="2.5" fill={WSOFT} />
      <Rect x="10" y="50" width="28" height="5" rx="2.5" fill={WSOFT} />
      <Rect x="14" y="62" width="18" height="5" rx="2.5" fill={WSOFT} />
      <Path d="M62 20 L40 56 L54 56 L48 82 L74 44 L60 44 L66 20 Z" fill={W} />
    </G>
  );
}

// Two flashcards snapping together with a spark
function SnapMotif() {
  return (
    <G>
      <G transform="rotate(-10 50 54)">
        <Rect x="28" y="30" width="38" height="48" rx="7" fill={WSOFT} />
      </G>
      <G transform="rotate(9 50 52)">
        <Rect x="32" y="28" width="38" height="48" rx="7" fill={W} />
        <Rect x="39" y="38" width="24" height="5" rx="2.5" fill="rgba(0,0,0,0.12)" />
        <Rect x="39" y="48" width="16" height="5" rx="2.5" fill="rgba(0,0,0,0.10)" />
      </G>
      <Path d="M76 26 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3 Z" fill={W} />
    </G>
  );
}

// Grid of letter tiles with one question-mark tile
function WirdMotif({ a }: { a: string }) {
  const T = (x: number, y: number, q?: boolean) => (
    <G>
      <Rect x={x} y={y} width="26" height="26" rx="6" fill={q ? W : WSOFT} />
      {q && <SvgText x={x + 13} y={y + 19} fontSize="18" fontWeight="900" fill={a} textAnchor="middle">?</SvgText>}
    </G>
  );
  return (
    <G>
      {T(24, 24)}
      {T(54, 24)}
      {T(24, 54)}
      {T(54, 54, true)}
    </G>
  );
}

// Shetland-ish islands with a location pin
function MapMotif({ a }: { a: string }) {
  return (
    <G>
      {/* island blobs */}
      <Path d="M20 60 q6 -14 18 -10 q10 -10 20 0 q14 -4 18 10 q-8 12 -22 9 q-12 7 -22 -2 q-10 -1 -12 -7 Z" fill={WSOFT} />
      {/* pin */}
      <Path d="M58 24 c-9 0 -16 7 -16 16 c0 12 16 28 16 28 c0 0 16 -16 16 -28 c0 -9 -7 -16 -16 -16 Z" fill={W} />
      <Circle cx="58" cy="40" r="6" fill={a} />
    </G>
  );
}
