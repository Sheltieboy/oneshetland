/**
 * app/games/map-it.tsx
 *
 * Map It — daily Shetland place-pinning game.
 *
 * Premium feel comes from:
 *   - Custom-styled SVG map (no third-party map tiles to clash with the brand)
 *   - Animated pin drop + line draw + score count-up on each reveal
 *   - Star ratings, confetti for perfect rounds, streak fireworks at the end
 *   - Tactile haptics on every interaction
 *   - Sharable result grid in the OneShetland voice
 */

import React, {
  useCallback, useEffect, useMemo, useReducer, useRef, useState,
} from 'react';
import {
  View, Text, StyleSheet, Pressable, TouchableOpacity,
  ActivityIndicator, Animated as RNAnimated, Easing, Share, Dimensions,
  ScrollView, PanResponder,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Svg, { Line as SvgLine } from 'react-native-svg';
// gesture-handler root view is still wired in _layout.tsx
import ShetlandMap from '../../assets/Shetland_UK_blank_map.svg';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import { submitScore } from '@/lib/games-api';
import { GameArt, GAME_COLORS, GAME_LIGHTS } from '@/components/GameArt';
// shetland-geometry kept available for distance maths inside lib/map-it.ts
import {
  loadPlacePool, pickDailyPlaces, resolveRound, scoreForDistance,
  starsForDistance, totalScore, todayKey, formatDateLabel,
  loadSession, saveSession, clearSession, buildShareText,
  pickPracticeRounds, getLevelInfo, addCumulativePts,
  ROUNDS_PER_DAY, PRACTICE_ROUNDS, MAX_POINTS_PER_ROUND,
  type Place, type RoundResult, type SessionState,
} from '@/lib/map-it';

const S = { ...SECTIONS.games, color: GAME_COLORS.map_it, light: GAME_LIGHTS.map_it };

// ── Visual constants ─────────────────────────────────────────────────────────

const MAP_BACKDROP = '#b2daf7';  // matches the SVG's sea fill
const ACCENT       = '#12B3D6';   // OneShetland teal (anchored / pin colour)
const ACCENT_2     = '#10B981';   // emerald — used for high-score states
const PERFECT      = '#F59E0B';   // amber for perfect / 3-star feedback

// ── SVG geometry + projection (calibrated 2026-06-06 from 5 control points) ─
//
// The Wikipedia "Shetland UK blank map" is 832×1582 SVG units. Latitude maps
// linearly to Y, longitude linearly to X (equirectangular). The Islands group
// inside the SVG has a 2× vertical stretch to compensate for the cosine-of-
// latitude squash at 60°N — that's baked into the file and we treat the
// canvas as a whole.
const SVG_NATURAL_W = 832;
const SVG_NATURAL_H = 1582;

// Projection coefficients (least-squares fit from 5 control points: Clickimin
// Broch, Sumburgh Head, Muckle Flugga, Out Skerries, Scalloway — all within
// ~4 SVG units of their actual positions, < 0.5% of canvas).
const Y_SLOPE     = -1163.68;
const Y_INTERCEPT =  70825.82;
const X_SLOPE     =    564.85;
const X_INTERCEPT =   1219.31;

function latToSvgY(lat: number): number { return Y_SLOPE * lat + Y_INTERCEPT; }
function lngToSvgX(lng: number): number { return X_SLOPE * lng + X_INTERCEPT; }
function svgYToLat(y:  number): number { return (Y_INTERCEPT - y) / -Y_SLOPE; }
function svgXToLng(x:  number): number { return (x - X_INTERCEPT) / X_SLOPE; }

// ── State machine ───────────────────────────────────────────────────────────

type Phase = 'loading' | 'intro' | 'playing' | 'revealing' | 'done' | 'already_played';

interface State {
  phase:       Phase;
  gameMode:    'daily' | 'practice';
  places:      Place[];
  results:     RoundResult[];
  roundIndex:  number;
  guess:       { lat: number; lng: number } | null;
  error:       string | null;
  // daily places IDs kept so practice can exclude them
  dailyIds:    string[];
}

type Action =
  | { type: 'BOOTED'; places: Place[]; results: RoundResult[]; phase: Phase }
  | { type: 'START' }
  | { type: 'GUESS'; lat: number; lng: number }
  | { type: 'CLEAR_GUESS' }
  | { type: 'SUBMIT_GUESS'; result: RoundResult }
  | { type: 'NEXT' }
  | { type: 'FINISH' }
  | { type: 'START_PRACTICE'; places: Place[] }
  | { type: 'ERROR'; msg: string };

function roundsForMode(mode: 'daily' | 'practice') {
  return mode === 'practice' ? PRACTICE_ROUNDS : ROUNDS_PER_DAY;
}

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'BOOTED':
      return {
        ...s, places: a.places, results: a.results,
        phase: a.phase, roundIndex: a.results.length,
        gameMode: 'daily', dailyIds: a.places.map(p => p.id),
      };
    case 'START':
      return { ...s, phase: 'playing', roundIndex: s.results.length, guess: null };
    case 'GUESS':
      return { ...s, guess: { lat: a.lat, lng: a.lng } };
    case 'CLEAR_GUESS':
      return { ...s, guess: null };
    case 'SUBMIT_GUESS':
      return { ...s, results: [...s.results, a.result], phase: 'revealing' };
    case 'NEXT': {
      const nextIdx = s.roundIndex + 1;
      if (nextIdx >= roundsForMode(s.gameMode)) return { ...s, phase: 'done' };
      return { ...s, phase: 'playing', roundIndex: nextIdx, guess: null };
    }
    case 'FINISH':
      return { ...s, phase: 'done' };
    case 'START_PRACTICE':
      return {
        ...s, phase: 'playing', gameMode: 'practice',
        places: a.places, results: [], roundIndex: 0, guess: null,
      };
    case 'ERROR':
      return { ...s, error: a.msg };
    default:
      return s;
  }
}

const INIT: State = {
  phase: 'loading', gameMode: 'daily',
  places: [], results: [], roundIndex: 0,
  guess: null, error: null, dailyIds: [],
};

// ── Main screen ──────────────────────────────────────────────────────────────

export default function MapItScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const userId = profile?.id ?? 'anon';

  const [state, dispatch] = useReducer(reducer, INIT);
  const submittedRef = useRef(false);
  const poolRef      = useRef<Place[]>([]);

  // Boot — load pool, pick daily places, resume session if any.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pool = await loadPlacePool();
        poolRef.current = pool;
        if (pool.length < ROUNDS_PER_DAY) {
          dispatch({ type: 'ERROR', msg: 'Not enough places in the dataset yet.' });
          return;
        }
        const dateKey = todayKey();
        const places  = pickDailyPlaces(dateKey, pool);
        const saved   = await loadSession(userId, dateKey);
        if (cancelled) return;

        if (saved && saved.results.length >= ROUNDS_PER_DAY) {
          dispatch({ type: 'BOOTED', places: saved.places, results: saved.results, phase: 'already_played' });
        } else if (saved && saved.results.length > 0) {
          dispatch({ type: 'BOOTED', places: saved.places, results: saved.results, phase: 'playing' });
        } else {
          dispatch({ type: 'BOOTED', places, results: [], phase: 'intro' });
        }
      } catch (e: any) {
        dispatch({ type: 'ERROR', msg: e?.message ?? 'Could not start the game.' });
      }
    })();
    return () => { cancelled = true; };
  }, [userId]);

  // Persist session for daily mode only.
  useEffect(() => {
    if (state.gameMode !== 'daily') return;
    if (state.phase === 'loading' || state.phase === 'intro') return;
    saveSession(userId, {
      dateKey: todayKey(),
      places: state.places,
      results: state.results,
      submitted: submittedRef.current,
    });
  }, [state.phase, state.results, state.places, state.gameMode, userId]);

  // On daily done: submit score + update cumulative level pts.
  useEffect(() => {
    if (state.phase !== 'done' || state.gameMode !== 'daily' || submittedRef.current) return;
    const total = totalScore(state.results);
    // Add to lifetime pts (used for level calculation)
    addCumulativePts(total).catch(() => {});
    if (profile?.id) {
      submitScore(profile.id, 'map_it', total, {
        metadata: {
          date: todayKey(),
          rounds: state.results.map(r => ({
            place_id: r.place.id, place: r.place.name,
            distance: Math.round(r.distanceKm * 100) / 100, points: r.points,
          })),
        },
      }).catch(() => {});
      submittedRef.current = true;
    }
  }, [state.phase, state.gameMode, state.results, profile?.id]);

  // Practice done: still add cumulative pts (unlocks levels) but no leaderboard.
  useEffect(() => {
    if (state.phase !== 'done' || state.gameMode !== 'practice') return;
    addCumulativePts(totalScore(state.results)).catch(() => {});
  }, [state.phase, state.gameMode, state.results]);

  const startPractice = useCallback(() => {
    const pool = poolRef.current;
    if (!pool.length) return;
    const places = pickPracticeRounds(pool, state.dailyIds);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    dispatch({ type: 'START_PRACTICE', places });
  }, [state.dailyIds]);

  const onSubmitGuess = useCallback(() => {
    if (!state.guess) return;
    const round = resolveRound(state.places[state.roundIndex], state.guess);
    Haptics.notificationAsync(
      round.points >= 800 ? Haptics.NotificationFeedbackType.Success
      : round.points >= 400 ? Haptics.NotificationFeedbackType.Warning
      : Haptics.NotificationFeedbackType.Error
    );
    dispatch({ type: 'SUBMIT_GUESS', result: round });
  }, [state.guess, state.places, state.roundIndex]);

  if (state.phase === 'loading') {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <Header onBack={() => router.back()} />
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      </SafeAreaView>
    );
  }

  if (state.error) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <Header onBack={() => router.back()} />
        <View style={styles.center}>
          <FontAwesome5 name="map-pin" size={28} color="rgba(255,255,255,0.4)" solid />
          <Text style={styles.errorMsg}>{state.error}</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (state.phase === 'intro') {
    return (
      <IntroScreen
        onPlay={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); dispatch({ type: 'START' }); }}
        onBack={() => router.back()}
      />
    );
  }

  if (state.phase === 'already_played') {
    return (
      <DoneScreen
        results={state.results}
        gameMode="daily"
        onShare={() => shareResults(state.places, state.results)}
        onClose={() => router.back()}
        onPlayMore={startPractice}
        alreadyPlayed
      />
    );
  }

  if (state.phase === 'done') {
    return (
      <DoneScreen
        results={state.results}
        gameMode={state.gameMode}
        onShare={state.gameMode === 'daily' ? () => shareResults(state.places, state.results) : undefined}
        onClose={() => router.back()}
        onPlayMore={startPractice}
      />
    );
  }

  // Playing or revealing
  const round = state.places[state.roundIndex];
  const result = state.phase === 'revealing' ? state.results[state.results.length - 1] : null;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <PlayHeader
        roundIndex={state.roundIndex}
        total={roundsForMode(state.gameMode)}
        cumulative={totalScore(state.results)}
        isPractice={state.gameMode === 'practice'}
        onClose={() => router.back()}
      />

      <PlaceCard place={round} revealing={state.phase === 'revealing'} />

      <View style={styles.mapWrap}>
        <MapCanvas
          onTap={(lat, lng) => {
            if (state.phase !== 'playing') return;
            Haptics.selectionAsync();
            dispatch({ type: 'GUESS', lat, lng });
          }}
          guess={state.guess}
          answer={state.phase === 'revealing' ? round : null}
          phase={state.phase}
        />
      </View>

      {state.phase === 'playing' && (
        <BottomBar
          guess={state.guess}
          onClear={() => dispatch({ type: 'CLEAR_GUESS' })}
          onSubmit={onSubmitGuess}
        />
      )}
      {state.phase === 'revealing' && result && (
        <RevealBar
          result={result}
          isLast={state.results.length >= ROUNDS_PER_DAY}
          onNext={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            dispatch({ type: 'NEXT' });
          }}
        />
      )}
    </SafeAreaView>
  );
}

// ── Intro screen ─────────────────────────────────────────────────────────────

function IntroScreen({ onPlay, onBack }: { onPlay: () => void; onBack: () => void }) {
  const dateLabel = formatDateLabel(todayKey());

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Header onBack={onBack} />

      {/* ScrollView so the "Start" button is always reachable, even on the
          tighter vertical viewport you get when running this as an iPhone
          app on an iPad, or on smaller-screen iPhones. */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={introStyles.body}
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        <View style={introStyles.hero}>
          <GameArt id="map_it" size={108} radius={28} />
          <View style={{ height: 16 }} />
          <Text style={introStyles.title}>Map It</Text>
          <Text style={introStyles.sub}>
            Pin {ROUNDS_PER_DAY} Shetland places on the map.{'\n'}
            The closer your pin, the more points.
          </Text>
        </View>

        <View style={introStyles.dateChip}>
          <FontAwesome5 name="calendar-day" size={11} color={ACCENT} />
          <Text style={introStyles.dateText}>Today · {dateLabel}</Text>
        </View>

        <View style={introStyles.rules}>
          <RuleRow icon="ruler-horizontal" text="Distance scored on a curve — within 1 km is gold." />
          <RuleRow icon="hand-rock" text="No time limit. Pinch + drag to inspect the coast before pinning." />
          <RuleRow icon="trophy" text="Daily streak adds up. Same 10 places for everyone." />
        </View>

        <Pressable
          style={({ pressed }) => [introStyles.playBtn, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }]}
          onPress={onPlay}
        >
          <Text style={introStyles.playBtnText}>Start today's round</Text>
          <FontAwesome5 name="arrow-right" size={13} color="#fff" />
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function RuleRow({ icon, text }: { icon: string; text: string }) {
  return (
    <View style={introStyles.ruleRow}>
      <View style={introStyles.ruleIcon}>
        <FontAwesome5 name={icon as any} size={12} color={ACCENT} solid />
      </View>
      <Text style={introStyles.ruleText}>{text}</Text>
    </View>
  );
}

// ── Header during play ─────────────────────────────────────────────────────

function PlayHeader({
  roundIndex, total, cumulative, isPractice, onClose,
}: { roundIndex: number; total: number; cumulative: number; isPractice: boolean; onClose: () => void }) {
  return (
    <View style={playStyles.header}>
      <TouchableOpacity onPress={onClose} hitSlop={12} style={playStyles.closeBtn}>
        <FontAwesome5 name="times" size={16} color="rgba(255,255,255,0.7)" />
      </TouchableOpacity>
      <View style={playStyles.headerCentre}>
        {isPractice && (
          <View style={playStyles.practiceBadge}>
            <Text style={playStyles.practiceBadgeText}>PRACTICE</Text>
          </View>
        )}
        <View style={playStyles.dotsRow}>
          {Array.from({ length: total }).map((_, i) => (
            <View
              key={i}
              style={[
                playStyles.dot,
                i < roundIndex && { backgroundColor: ACCENT },
                i === roundIndex && playStyles.dotActive,
              ]}
            />
          ))}
        </View>
        <Text style={playStyles.headerLabel}>
          Round {roundIndex + 1} of {total}
        </Text>
      </View>
      <View style={playStyles.scoreBadge}>
        <Text style={playStyles.scoreBadgeNum}>{cumulative.toLocaleString()}</Text>
        <Text style={playStyles.scoreBadgeLabel}>pts</Text>
      </View>
    </View>
  );
}

// ── Place card (above map) ──────────────────────────────────────────────────

function PlaceCard({ place, revealing }: { place: Place; revealing: boolean }) {
  return (
    <View style={[placeCardStyles.card, revealing && placeCardStyles.cardRevealing]}>
      <View style={placeCardStyles.iconWrap}>
        <FontAwesome5 name={categoryIcon(place.category) as any} size={14} color={ACCENT} solid />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={placeCardStyles.label}>{place.category.toUpperCase()}{place.region ? ` · ${place.region}` : ''}</Text>
        <Text style={placeCardStyles.name} numberOfLines={2}>{place.name}</Text>
      </View>
    </View>
  );
}

function categoryIcon(category: string): string {
  return {
    settlement: 'home',
    island:     'water',
    voe:        'wind',
    loch:       'tint',
    beach:      'umbrella-beach',
    headland:   'mountain',
    hill:       'mountain',
    lighthouse: 'lightbulb',
    broch:      'monument',
    sound:      'water',
    geo:        'mountain',
    landmark:   'flag',
  }[category] ?? 'map-pin';
}

// ── Map canvas (SVG with custom projection + pinch/pan) ─────────────────────

// ViewBox zoom limits (viewBox width drives zoom: smaller = more zoomed in)
const MIN_VB_W = SVG_NATURAL_W / 8;   // 8× max zoom
const MAX_VB_W = SVG_NATURAL_W;       // 1× (full map)

type VB = { x: number; y: number; w: number; h: number };
const FULL_VB: VB = { x: 0, y: 0, w: SVG_NATURAL_W, h: SVG_NATURAL_H };

function clampVB(vb: VB): VB {
  const w = Math.max(MIN_VB_W, Math.min(MAX_VB_W, vb.w));
  const h = w * (SVG_NATURAL_H / SVG_NATURAL_W);
  const x = Math.max(0, Math.min(SVG_NATURAL_W - w, vb.x));
  const y = Math.max(0, Math.min(SVG_NATURAL_H - h, vb.y));
  return { x, y, w, h };
}

function pinchDist(t: { pageX: number; pageY: number }[]): number {
  const dx = t[0].pageX - t[1].pageX;
  const dy = t[0].pageY - t[1].pageY;
  return Math.sqrt(dx * dx + dy * dy);
}

function MapCanvas({
  onTap, guess, answer, phase,
}: {
  onTap:   (lat: number, lng: number) => void;
  guess:   { lat: number; lng: number } | null;
  answer:  Place | null;
  phase:   Phase;
}) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [vb,   setVb]   = useState<VB>(FULL_VB);

  // Sync refs — readable inside PanResponder callbacks without stale closures
  const vbRef    = useRef<VB>(FULL_VB);
  const savedVb  = useRef<VB>(FULL_VB);
  const phaseRef = useRef(phase);
  const onTapRef = useRef(onTap);
  const rectRef  = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  // Canvas page-origin (top-left in screen coordinates) — populated after layout
  const canvasRef    = useRef<View>(null);
  const originRef    = useRef({ x: 0, y: 0 });

  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { onTapRef.current = onTap;  }, [onTap]);

  // Fit SVG's 832×1582 aspect into the canvas, letterboxed
  const rect = useMemo(() => {
    if (!size.w || !size.h) return null;
    const svgAR    = SVG_NATURAL_W / SVG_NATURAL_H;
    const canvasAR = size.w / size.h;
    let rw: number, rh: number;
    if (canvasAR > svgAR) { rh = size.h; rw = rh * svgAR; }
    else                  { rw = size.w; rh = rw / svgAR; }
    return { x: (size.w - rw) / 2, y: (size.h - rh) / 2, w: rw, h: rh };
  }, [size.w, size.h]);

  useEffect(() => { rectRef.current = rect; }, [rect]);

  // Reset on each new round
  useEffect(() => {
    vbRef.current = FULL_VB; savedVb.current = FULL_VB;
    setVb(FULL_VB);
  }, [answer?.id]);

  // Measure the canvas's top-left position in screen space.
  // PanResponder gives pageX/pageY (absolute), so we subtract the canvas
  // origin to get coordinates relative to the canvas.
  const measureOrigin = useCallback(() => {
    canvasRef.current?.measure((_fx, _fy, _w, _h, pageX, pageY) => {
      originRef.current = { x: pageX, y: pageY };
    });
  }, []);

  // Convert absolute screen coords → canvas-relative coords
  const toCanvas = (pageX: number, pageY: number) => ({
    cx: pageX - originRef.current.x,
    cy: pageY - originRef.current.y,
  });

  // Convert canvas pixel → SVG unit using a given viewBox
  const canvasToSvg = (cx: number, cy: number, v: VB) => {
    const r = rectRef.current;
    if (!r) return null;
    return {
      x: v.x + ((cx - r.x) / r.w) * v.w,
      y: v.y + ((cy - r.y) / r.h) * v.h,
    };
  };

  // ── PanResponder — handles tap, single-finger pan, two-finger pinch ──────
  // Using PanResponder avoids all gesture-handler architecture dependencies
  // and gives reliable multi-touch events on every RN version.
  const gst = useRef({
    isPinch:           false,
    isTap:             false,
    tapCanvasX:        0,
    tapCanvasY:        0,
    tapStartTime:      0,
    pinchStartDist:    0,
    pinchStartVb:      FULL_VB as VB,
    pinchFocalCanvasX: 0,
    pinchFocalCanvasY: 0,
    pinchFocalSvgX:    SVG_NATURAL_W / 2,
    pinchFocalSvgY:    SVG_NATURAL_H / 2,
  }).current;

  const panResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder:  () => true,

    onPanResponderGrant: (evt) => {
      const touches = Array.from(evt.nativeEvent.touches) as any[];
      if (touches.length >= 2) {
        // ── Pinch start ───────────────────────────────────────────────────
        gst.isPinch = true; gst.isTap = false;
        gst.pinchStartDist = pinchDist(touches);
        gst.pinchStartVb   = { ...vbRef.current };
        savedVb.current    = { ...vbRef.current };
        const fPageX = (touches[0].pageX + touches[1].pageX) / 2;
        const fPageY = (touches[0].pageY + touches[1].pageY) / 2;
        const { cx, cy } = toCanvas(fPageX, fPageY);
        gst.pinchFocalCanvasX = cx; gst.pinchFocalCanvasY = cy;
        const s = canvasToSvg(cx, cy, gst.pinchStartVb);
        gst.pinchFocalSvgX = s?.x ?? SVG_NATURAL_W / 2;
        gst.pinchFocalSvgY = s?.y ?? SVG_NATURAL_H / 2;
      } else {
        // ── Potential tap or pan ──────────────────────────────────────────
        gst.isPinch = false; gst.isTap = true;
        const { cx, cy } = toCanvas(evt.nativeEvent.pageX, evt.nativeEvent.pageY);
        gst.tapCanvasX   = cx; gst.tapCanvasY = cy;
        gst.tapStartTime = Date.now();
        savedVb.current  = { ...vbRef.current };
      }
    },

    onPanResponderMove: (evt, gs) => {
      const touches = Array.from(evt.nativeEvent.touches) as any[];
      const r = rectRef.current;
      if (!r) return;

      if (touches.length >= 2) {
        // ── Pinch ─────────────────────────────────────────────────────────
        if (!gst.isPinch) {
          // Second finger added mid-gesture — init pinch now
          gst.isPinch = true; gst.isTap = false;
          gst.pinchStartDist = pinchDist(touches);
          gst.pinchStartVb   = { ...vbRef.current };
          savedVb.current    = { ...vbRef.current };
          const fPageX = (touches[0].pageX + touches[1].pageX) / 2;
          const fPageY = (touches[0].pageY + touches[1].pageY) / 2;
          const { cx, cy } = toCanvas(fPageX, fPageY);
          gst.pinchFocalCanvasX = cx; gst.pinchFocalCanvasY = cy;
          const s = canvasToSvg(cx, cy, gst.pinchStartVb);
          gst.pinchFocalSvgX = s?.x ?? SVG_NATURAL_W / 2;
          gst.pinchFocalSvgY = s?.y ?? SVG_NATURAL_H / 2;
        }
        gst.isTap = false;
        const dist  = pinchDist(touches);
        const scale = dist / gst.pinchStartDist;
        const rawW  = gst.pinchStartVb.w / scale;
        const w     = Math.max(MIN_VB_W, Math.min(MAX_VB_W, rawW));
        const h     = w * SVG_NATURAL_H / SVG_NATURAL_W;
        const fracX = (gst.pinchFocalCanvasX - r.x) / r.w;
        const fracY = (gst.pinchFocalCanvasY - r.y) / r.h;
        const next  = clampVB({
          x: gst.pinchFocalSvgX - fracX * w,
          y: gst.pinchFocalSvgY - fracY * h,
          w, h,
        });
        vbRef.current = next; setVb(next);

      } else if (!gst.isPinch) {
        // ── Pan ───────────────────────────────────────────────────────────
        const totalDist = Math.sqrt(gs.dx * gs.dx + gs.dy * gs.dy);
        if (totalDist > 8) gst.isTap = false;
        const sv = savedVb.current;
        const next = clampVB({
          ...sv,
          x: sv.x - (gs.dx / r.w) * sv.w,
          y: sv.y - (gs.dy / r.h) * sv.h,
        });
        vbRef.current = next; setVb(next);
      }
    },

    onPanResponderRelease: (_evt, gs) => {
      if (gst.isTap) {
        const dist     = Math.sqrt(gs.dx * gs.dx + gs.dy * gs.dy);
        const duration = Date.now() - gst.tapStartTime;
        if (dist < 12 && duration < 500 && phaseRef.current === 'playing') {
          const svgCoord = canvasToSvg(gst.tapCanvasX, gst.tapCanvasY, vbRef.current);
          if (svgCoord &&
              svgCoord.x >= 0 && svgCoord.x <= SVG_NATURAL_W &&
              svgCoord.y >= 0 && svgCoord.y <= SVG_NATURAL_H) {
            onTapRef.current(svgYToLat(svgCoord.y), svgXToLng(svgCoord.x));
          }
        }
      }
      savedVb.current = { ...vbRef.current };
      gst.isTap = false; gst.isPinch = false;
    },

    onPanResponderTerminate: () => {
      savedVb.current = { ...vbRef.current };
      gst.isTap = false; gst.isPinch = false;
    },
  })).current;

  // ── Project lat/lng → canvas pixel using current rendered viewBox ─────────
  const project = (lat: number, lng: number) => {
    if (!rect) return null;
    const fracX = (lngToSvgX(lng) - vb.x) / vb.w;
    const fracY = (latToSvgY(lat) - vb.y) / vb.h;
    return { left: rect.x + fracX * rect.w, top: rect.y + fracY * rect.h };
  };

  const guessPos  = guess  ? project(guess.lat,  guess.lng)  : null;
  const answerPos = answer ? project(answer.lat, answer.lng) : null;
  const viewBoxStr = `${vb.x} ${vb.y} ${vb.w} ${vb.h}`;

  return (
    <View
      ref={canvasRef}
      style={mapStyles.canvas}
      onLayout={(e) => {
        setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });
        // Defer measure so the native layout is committed before we read pageX/Y
        setTimeout(measureOrigin, 80);
      }}
      {...panResponder.panHandlers}
    >
      <View style={[StyleSheet.absoluteFill, { backgroundColor: MAP_BACKDROP }]} />

      {/* SVG re-renders as crisp vector at every zoom level (viewBox drives zoom,
          not a transform, so there is no GPU rasterisation / blur). */}
      {rect && (
        <ShetlandMap
          style={{ position: 'absolute', left: rect.x, top: rect.y }}
          width={rect.w}
          height={rect.h}
          viewBox={viewBoxStr}
          preserveAspectRatio="none"
        />
      )}

      {/* Dashed line guess → answer */}
      {phase === 'revealing' && guessPos && answerPos && (
        <Svg width={size.w} height={size.h} style={StyleSheet.absoluteFill} pointerEvents="none">
          <SvgLine
            x1={guessPos.left}  y1={guessPos.top}
            x2={answerPos.left} y2={answerPos.top}
            stroke={PERFECT} strokeWidth={3}
            strokeDasharray="8,6" strokeLinecap="round"
          />
        </Svg>
      )}

      {guessPos && (
        <View style={[pinStyles.pinAbs, { left: guessPos.left, top: guessPos.top }]} pointerEvents="none">
          <View style={pinStyles.guessOuter}><View style={pinStyles.guessMiddle}><View style={pinStyles.guessInner} /></View></View>
        </View>
      )}

      {phase === 'revealing' && answerPos && (
        <View style={[pinStyles.pinAbs, { left: answerPos.left, top: answerPos.top }]} pointerEvents="none">
          <View style={pinStyles.answerOuter}><View style={pinStyles.answerMiddle}><View style={pinStyles.answerInner} /></View></View>
        </View>
      )}

      {phase === 'playing' && !guess && (
        <View style={mapStyles.hintOverlay} pointerEvents="none">
          <View style={mapStyles.hintPill}>
            <FontAwesome5 name="hand-pointer" size={11} color="#fff" solid />
            <Text style={mapStyles.hintText}>Tap to pin · pinch to zoom · drag to pan</Text>
          </View>
        </View>
      )}
    </View>
  );
}

// ── Bottom bar (playing) ────────────────────────────────────────────────────

function BottomBar({
  guess, onClear, onSubmit,
}: {
  guess:    { lat: number; lng: number } | null;
  onClear:  () => void;
  onSubmit: () => void;
}) {
  return (
    <View style={bottomStyles.bar}>
      {guess ? (
        <>
          <TouchableOpacity onPress={onClear} style={bottomStyles.secondary}>
            <FontAwesome5 name="undo" size={11} color="rgba(255,255,255,0.7)" />
            <Text style={bottomStyles.secondaryText}>Retry</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onSubmit} style={bottomStyles.primary}>
            <Text style={bottomStyles.primaryText}>Place pin</Text>
            <FontAwesome5 name="check" size={13} color="#fff" />
          </TouchableOpacity>
        </>
      ) : (
        <Text style={bottomStyles.hint}>Tap somewhere on the map…</Text>
      )}
    </View>
  );
}

// ── Reveal bar ──────────────────────────────────────────────────────────────

const RESULT_LABELS: Record<number, { label: string; color: string }> = {
  3: { label: "Bull's-eye! 🎯", color: '#FFD700' },
  2: { label: 'Nicely done! 👏', color: PERFECT },
  1: { label: 'On the map! 📍', color: '#FF9800' },
  0: { label: 'Keep trying 🗺', color: 'rgba(255,255,255,0.6)' },
};

function RevealBar({
  result, isLast, onNext,
}: { result: RoundResult; isLast: boolean; onNext: () => void }) {
  const stars  = starsForDistance(result.distanceKm);
  const points = result.points;
  const { label, color: labelColor } = RESULT_LABELS[stars];

  // Slide up from below
  const slideAnim = useRef(new RNAnimated.Value(120)).current;

  // Star scale animations — one per star, bounce in with stagger
  const starAnims = useRef([
    new RNAnimated.Value(0),
    new RNAnimated.Value(0),
    new RNAnimated.Value(0),
  ]).current;

  // Score count-up
  const countAnim = useRef(new RNAnimated.Value(0)).current;
  const [displayed, setDisplayed] = useState(0);

  // Score "pop" at count-up end
  const scoreScale = useRef(new RNAnimated.Value(1)).current;

  useEffect(() => {
    // 1. Slide the bar up
    RNAnimated.spring(slideAnim, {
      toValue: 0, useNativeDriver: true, tension: 120, friction: 9,
    }).start();

    // 2. Stars bounce in one-by-one (only earned stars get the pop)
    starAnims.forEach((anim, i) => {
      if (i < stars) {
        RNAnimated.sequence([
          RNAnimated.delay(180 + i * 160),
          RNAnimated.spring(anim, {
            toValue: 1, useNativeDriver: true, tension: 260, friction: 7,
          }),
        ]).start(() => {
          // Haptic tick for each earned star
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        });
      } else {
        anim.setValue(0.4); // dim unfilled stars immediately
      }
    });

    // 3. Score count-up (delayed slightly so slide finishes first)
    countAnim.setValue(0);
    const listener = countAnim.addListener(({ value }) =>
      setDisplayed(Math.round(value * points)));
    RNAnimated.sequence([
      RNAnimated.delay(280),
      RNAnimated.timing(countAnim, {
        toValue: 1, duration: 950, easing: Easing.out(Easing.cubic), useNativeDriver: false,
      }),
    ]).start(() => {
      // Pop the score when count-up lands
      RNAnimated.sequence([
        RNAnimated.timing(scoreScale, { toValue: 1.25, duration: 120, useNativeDriver: true }),
        RNAnimated.spring(scoreScale, { toValue: 1, useNativeDriver: true, tension: 300, friction: 8 }),
      ]).start();
    });

    return () => countAnim.removeListener(listener);
  }, []);

  const distText = result.distanceKm < 1
    ? `${Math.round(result.distanceKm * 1000)} m away`
    : `${result.distanceKm.toFixed(1)} km away`;

  return (
    <RNAnimated.View style={[revealStyles.bar, { transform: [{ translateY: slideAnim }] }]}>
      {/* Result headline */}
      <Text style={[revealStyles.resultLabel, { color: labelColor }]}>{label}</Text>

      <View style={revealStyles.revealRow}>
        {/* Distance + stars */}
        <View style={revealStyles.left}>
          <Text style={revealStyles.distLabel}>{distText}</Text>
          <View style={revealStyles.starsRow}>
            {[0, 1, 2].map(i => (
              <RNAnimated.View key={i} style={{ transform: [{ scale: starAnims[i] }] }}>
                <FontAwesome5
                  name="star" size={20}
                  color={i < stars ? '#FFD700' : 'rgba(255,255,255,0.18)'}
                  solid
                />
              </RNAnimated.View>
            ))}
          </View>
        </View>

        {/* Score */}
        <View style={revealStyles.scoreCol}>
          <RNAnimated.Text style={[revealStyles.scoreNum, { transform: [{ scale: scoreScale }] }]}>
            +{displayed.toLocaleString()}
          </RNAnimated.Text>
          <Text style={revealStyles.scoreLabel}>points</Text>
        </View>

        {/* Next button */}
        <TouchableOpacity onPress={onNext} style={revealStyles.nextBtn}>
          <Text style={revealStyles.nextText}>{isLast ? 'Finish' : 'Next'}</Text>
          <FontAwesome5 name="arrow-right" size={12} color="#fff" />
        </TouchableOpacity>
      </View>
    </RNAnimated.View>
  );
}

// ── Level progress widget ────────────────────────────────────────────────────

function LevelBadge({ pts }: { pts: number }) {
  const { current, next, progress } = getLevelInfo(pts);
  const barWidth = useRef(new RNAnimated.Value(0)).current;

  useEffect(() => {
    RNAnimated.timing(barWidth, {
      toValue: progress, duration: 900, easing: Easing.out(Easing.quad), useNativeDriver: false,
    }).start();
  }, [progress]);

  return (
    <View style={doneStyles.levelCard}>
      <View style={doneStyles.levelTop}>
        <View style={[doneStyles.levelIconWrap, { backgroundColor: current.color + '22' }]}>
          <FontAwesome5 name={current.icon as any} size={14} color={current.color} solid />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={doneStyles.levelLabel}>LEVEL {current.level}</Text>
          <Text style={[doneStyles.levelName, { color: current.color }]}>{current.name}</Text>
        </View>
        <Text style={doneStyles.levelPts}>{pts.toLocaleString()} pts</Text>
      </View>
      {next && (
        <>
          <View style={doneStyles.levelBarBg}>
            <RNAnimated.View
              style={[
                doneStyles.levelBarFill,
                { backgroundColor: current.color, width: barWidth.interpolate({ inputRange: [0,1], outputRange: ['0%','100%'] }) },
              ]}
            />
          </View>
          <Text style={doneStyles.levelNextLabel}>
            {(next.minPts - pts).toLocaleString()} pts to Level {next.level} · {next.name}
          </Text>
        </>
      )}
      {!next && (
        <Text style={[doneStyles.levelNextLabel, { color: current.color }]}>
          Maximum rank achieved 🏆
        </Text>
      )}
    </View>
  );
}

// ── Done screen ─────────────────────────────────────────────────────────────

function DoneScreen({
  results, gameMode, onShare, onClose, onPlayMore, alreadyPlayed,
}: {
  results:        RoundResult[];
  gameMode:       'daily' | 'practice';
  onShare?:       () => void;
  onClose:        () => void;
  onPlayMore?:    () => void;
  alreadyPlayed?: boolean;
}) {
  const total  = totalScore(results);
  const rounds = gameMode === 'practice' ? PRACTICE_ROUNDS : ROUNDS_PER_DAY;
  const max    = rounds * MAX_POINTS_PER_ROUND;
  const pct    = Math.round((total / max) * 100);

  const [cumulativePts, setCumulativePts] = useState(0);

  // Animated total count-up
  const animVal = useRef(new RNAnimated.Value(0)).current;
  const [displayed, setDisplayed] = useState(0);

  useEffect(() => {
    // Load lifetime pts for the level widget
    import('@/lib/map-it').then(m => m.loadCumulativePts()).then(setCumulativePts).catch(() => {});

    const listener = animVal.addListener(({ value }) => {
      setDisplayed(Math.round(value * total));
    });
    RNAnimated.timing(animVal, {
      toValue: 1, duration: 1600, easing: Easing.out(Easing.cubic), useNativeDriver: false,
    }).start(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
    return () => animVal.removeListener(listener);
  }, [total, animVal]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Header onBack={onClose} />

      <ScrollView style={{ flex: 1 }} contentContainerStyle={doneStyles.body} showsVerticalScrollIndicator={false}>
        {/* Score headline */}
        <View style={doneStyles.headline}>
          {gameMode === 'practice' && (
            <View style={[doneStyles.alreadyChip, { backgroundColor: ACCENT + '22', borderColor: ACCENT + '40' }]}>
              <FontAwesome5 name="dumbbell" size={10} color={ACCENT} />
              <Text style={[doneStyles.alreadyText, { color: ACCENT }]}>Practice round</Text>
            </View>
          )}
          <Text style={doneStyles.headlineLabel}>
            {gameMode === 'practice' ? 'PRACTICE SCORE' : 'FINAL SCORE'}
          </Text>
          <Text style={doneStyles.total}>{displayed.toLocaleString()}</Text>
          <Text style={doneStyles.subTotal}>of {max.toLocaleString()} · {pct}%</Text>
          {alreadyPlayed && (
            <View style={doneStyles.alreadyChip}>
              <FontAwesome5 name="check-circle" size={11} color={ACCENT_2} solid />
              <Text style={doneStyles.alreadyText}>You've already played today — come back tomorrow!</Text>
            </View>
          )}
        </View>

        {/* Level progress */}
        {cumulativePts > 0 && <LevelBadge pts={cumulativePts} />}

        {/* Round-by-round breakdown */}
        <View style={doneStyles.roundsList}>
          {results.map((r, i) => {
            const stars = starsForDistance(r.distanceKm);
            return (
              <View key={i} style={doneStyles.roundRow}>
                <Text style={doneStyles.roundNum}>{i + 1}</Text>
                <Text style={doneStyles.roundName} numberOfLines={1}>{r.place.name}</Text>
                <View style={doneStyles.roundStars}>
                  {[0,1,2].map(s => (
                    <FontAwesome5
                      key={s} name="star" size={9}
                      color={s < stars ? '#FFD700' : 'rgba(255,255,255,0.18)'} solid
                    />
                  ))}
                </View>
                <Text style={doneStyles.roundDist}>
                  {r.distanceKm < 1
                    ? `${Math.round(r.distanceKm * 1000)} m`
                    : `${r.distanceKm.toFixed(1)} km`}
                </Text>
                <Text style={doneStyles.roundPts}>+{r.points}</Text>
              </View>
            );
          })}
        </View>

        {/* Actions */}
        <View style={doneStyles.actions}>
          {onPlayMore && (
            <TouchableOpacity onPress={onPlayMore} style={doneStyles.playMoreBtn}>
              <FontAwesome5 name="play-circle" size={13} color="#fff" solid />
              <Text style={doneStyles.playMoreText}>Play more rounds</Text>
            </TouchableOpacity>
          )}
          <View style={doneStyles.actionsRow}>
            {onShare && (
              <TouchableOpacity onPress={onShare} style={doneStyles.shareBtn}>
                <FontAwesome5 name="share-alt" size={13} color="#fff" />
                <Text style={doneStyles.shareText}>Share</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={onClose} style={doneStyles.doneBtn}>
              <Text style={doneStyles.doneText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

async function shareResults(places: Place[], results: RoundResult[]) {
  const total = totalScore(results);
  const text  = buildShareText(
    { dateKey: todayKey(), places, results, submitted: true },
    total,
  );
  try {
    Haptics.selectionAsync();
    await Share.share({ message: text });
  } catch { /* user cancelled */ }
}

// ── Shared header ───────────────────────────────────────────────────────────

function Header({ onBack }: { onBack: () => void }) {
  return (
    <View style={styles.header}>
      <TouchableOpacity onPress={onBack} hitSlop={12} style={styles.backBtn}>
        <FontAwesome5 name="chevron-left" size={14} color={S.color} />
        <Text style={[styles.backText, { color: S.color }]}>Back</Text>
      </TouchableOpacity>
      <Text style={styles.headerTitle}>Map It</Text>
      <View style={{ width: 70 }} />
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.navy },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
    backgroundColor: colors.navy,
    borderBottomWidth: 2, borderBottomColor: S.color,
  },
  backBtn:     { flexDirection: 'row', alignItems: 'center', gap: 8, width: 70 },
  backText:    { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '900', flex: 1, textAlign: 'center', letterSpacing: 0.4 },

  errorMsg: { color: 'rgba(255,255,255,0.8)', fontSize: fontSize.sm, textAlign: 'center', paddingHorizontal: spacing.xl },

  mapWrap: { flex: 1, backgroundColor: MAP_BACKDROP },
});

const introStyles = StyleSheet.create({
  // flexGrow:1 lets the contentContainerStyle fill the ScrollView when the
  // content is shorter than the screen (so the Start button hugs the bottom
  // via marginTop:'auto') but still allows scrolling if content is taller.
  body:   { flexGrow: 1, padding: spacing.lg, gap: 18 },
  hero:   { alignItems: 'center', gap: 14, paddingTop: 16, paddingBottom: 8 },
  heroIconWrap: {
    width: 90, height: 90, borderRadius: 45,
    backgroundColor: ACCENT + '18',
    borderWidth: 2, borderColor: ACCENT + '40',
    alignItems: 'center', justifyContent: 'center',
  },
  title:  { color: '#fff', fontSize: 30, fontWeight: '900', letterSpacing: 0.4 },
  sub:    { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.md, lineHeight: 24, textAlign: 'center' },

  dateChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    alignSelf: 'center',
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: radius.full,
    backgroundColor: ACCENT + '14',
    borderWidth: 1, borderColor: ACCENT + '30',
  },
  dateText: { color: ACCENT, fontSize: fontSize.xs, fontWeight: '800', letterSpacing: 0.3 },

  rules: { gap: 12, marginTop: 12 },
  ruleRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  ruleIcon: {
    width: 28, height: 28, borderRadius: 8,
    backgroundColor: ACCENT + '14',
    alignItems: 'center', justifyContent: 'center',
    marginTop: 1,
  },
  ruleText: { flex: 1, color: 'rgba(255,255,255,0.85)', fontSize: fontSize.sm, lineHeight: 20 },

  playBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    marginTop: 'auto',
    backgroundColor: ACCENT,
    height: 56,
    borderRadius: radius.lg,
    shadowColor: ACCENT, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.4, shadowRadius: 12,
  },
  playBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '900', letterSpacing: 0.4 },
});

const playStyles = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: spacing.md, paddingVertical: 10,
    backgroundColor: colors.navy,
    borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  closeBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerCentre: { flex: 1, alignItems: 'center', gap: 4 },
  practiceBadge: {
    paddingHorizontal: 8, paddingVertical: 2,
    borderRadius: radius.full,
    backgroundColor: ACCENT_2 + '22',
    borderWidth: 1, borderColor: ACCENT_2 + '40',
  },
  practiceBadgeText: { color: ACCENT_2, fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  dotsRow: { flexDirection: 'row', gap: 4 },
  dot: {
    width: 6, height: 6, borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  dotActive: { backgroundColor: '#fff', width: 16 },
  headerLabel: { color: 'rgba(255,255,255,0.6)', fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },

  scoreBadge: {
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: radius.full,
    backgroundColor: ACCENT + '20',
    borderWidth: 1, borderColor: ACCENT + '40',
    alignItems: 'center',
    minWidth: 70,
  },
  scoreBadgeNum:   { color: '#fff', fontSize: fontSize.sm, fontWeight: '900' },
  scoreBadgeLabel: { color: ACCENT, fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
});

const placeCardStyles = StyleSheet.create({
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    marginHorizontal: spacing.md, marginTop: 12, marginBottom: 8,
    padding: spacing.md,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: radius.lg,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
  cardRevealing: {
    backgroundColor: ACCENT_2 + '14',
    borderColor: ACCENT_2 + '40',
  },
  iconWrap: {
    width: 40, height: 40, borderRadius: radius.md,
    backgroundColor: ACCENT + '20',
    alignItems: 'center', justifyContent: 'center',
  },
  label: { color: 'rgba(255,255,255,0.5)', fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },
  name:  { color: '#fff', fontSize: fontSize.lg, fontWeight: '900', marginTop: 2 },
});

const mapStyles = StyleSheet.create({
  canvas: { flex: 1, overflow: 'hidden' },
  hintOverlay: {
    position: 'absolute', left: 0, right: 0, top: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingVertical: 14, paddingHorizontal: 20,
    gap: 10,
  },
  // Kept for legacy callers; folded into hintOverlay above.
  hintPill: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
  },
  hintText: { color: '#fff', fontSize: 14, fontWeight: '700', letterSpacing: 0.2 },
});

// Pins are nested concentric views, absolutely positioned over the SVG and
// translated so their centre aligns with the projected (left, top).
const pinStyles = StyleSheet.create({
  // Centre the pin on its (left, top) anchor
  pinAbs: {
    position: 'absolute',
    transform: [{ translateX: -16 }, { translateY: -16 }],
  },
  guessOuter: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: ACCENT + '26',
    alignItems: 'center', justifyContent: 'center',
  },
  guessMiddle: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: ACCENT + '44',
    alignItems: 'center', justifyContent: 'center',
  },
  guessInner: {
    width: 12, height: 12, borderRadius: 6,
    backgroundColor: ACCENT,
    borderWidth: 2.5, borderColor: '#fff',
  },
  answerOuter: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: ACCENT_2 + '22',
    alignItems: 'center', justifyContent: 'center',
    // Visual nudge so the 40-px ring centres on the same point as the 32-px
    // guess pin (which uses translate -16/-16).  We add an extra -4 each
    // axis so the 40-px ring is offset by -20/-20 net.
    transform: [{ translateX: -4 }, { translateY: -4 }],
  },
  answerMiddle: {
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: ACCENT_2 + '4D',
    alignItems: 'center', justifyContent: 'center',
  },
  answerInner: {
    width: 14, height: 14, borderRadius: 7,
    backgroundColor: ACCENT_2,
    borderWidth: 3, borderColor: '#fff',
  },
});

const bottomStyles = StyleSheet.create({
  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: spacing.md, paddingVertical: 12,
    paddingBottom: 20,
    backgroundColor: colors.navy,
    borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)',
  },
  hint:     { flex: 1, color: 'rgba(255,255,255,0.5)', fontSize: fontSize.sm, fontWeight: '700', textAlign: 'center' },
  secondary:{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 10, borderRadius: radius.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' },
  secondaryText: { color: 'rgba(255,255,255,0.85)', fontSize: fontSize.xs, fontWeight: '800' },
  primary:  { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 46, borderRadius: radius.md, backgroundColor: ACCENT },
  primaryText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '900', letterSpacing: 0.4 },
});

const revealStyles = StyleSheet.create({
  bar: {
    paddingHorizontal: spacing.md, paddingTop: 14, paddingBottom: 22,
    backgroundColor: colors.navy,
    borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.1)',
    gap: 10,
  },
  resultLabel: {
    fontSize: 17, fontWeight: '900', letterSpacing: 0.2, textAlign: 'center',
  },
  revealRow: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
  },
  left: { gap: 6 },
  distLabel: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.xs, fontWeight: '700' },
  starsRow: { flexDirection: 'row', gap: 6 },
  scoreCol: { flex: 1, alignItems: 'center' },
  scoreNum: { color: '#fff', fontSize: 28, fontWeight: '900', letterSpacing: 0.3 },
  scoreLabel: { color: 'rgba(255,255,255,0.4)', fontSize: 9, fontWeight: '800', letterSpacing: 0.8 },
  nextBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 16, paddingVertical: 12,
    borderRadius: radius.md, backgroundColor: ACCENT,
  },
  nextText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '900', letterSpacing: 0.4 },
});

const doneStyles = StyleSheet.create({
  body: { flex: 1, padding: spacing.md, gap: 18 },
  headline: { alignItems: 'center', gap: 6, paddingTop: 16 },
  headlineLabel: { color: 'rgba(255,255,255,0.4)', fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  total: { color: '#fff', fontSize: 56, fontWeight: '900', letterSpacing: 0.4 },
  subTotal: { color: 'rgba(255,255,255,0.5)', fontSize: fontSize.sm, fontWeight: '700' },
  alreadyChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8,
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: radius.full, backgroundColor: ACCENT_2 + '14', borderWidth: 1, borderColor: ACCENT_2 + '30',
  },
  alreadyText: { color: ACCENT_2, fontSize: 11, fontWeight: '800' },

  roundsList: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: radius.lg,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
    paddingVertical: 6,
  },
  roundRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 12, paddingVertical: 8,
  },
  roundNum: { color: 'rgba(255,255,255,0.4)', fontSize: 11, fontWeight: '900', width: 16, textAlign: 'right' },
  roundName: { flex: 1, color: '#fff', fontSize: fontSize.sm, fontWeight: '700' },
  roundStars: { flexDirection: 'row', gap: 2 },
  roundDist: { color: 'rgba(255,255,255,0.5)', fontSize: 11, fontWeight: '700', width: 50, textAlign: 'right' },
  roundPts:  { color: ACCENT, fontSize: 11, fontWeight: '900', width: 50, textAlign: 'right' },

  actions: { gap: 10, marginTop: 4, paddingBottom: 8 },
  actionsRow: { flexDirection: 'row', gap: 10 },
  playMoreBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    height: 52, borderRadius: radius.md, backgroundColor: ACCENT,
  },
  playMoreText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '900', letterSpacing: 0.4 },
  shareBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    height: 46, borderRadius: radius.md,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
  },
  shareText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
  doneBtn: {
    flex: 1, paddingHorizontal: 24, height: 46, alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
  },
  doneText: { color: 'rgba(255,255,255,0.85)', fontSize: fontSize.sm, fontWeight: '800' },

  // Level card
  levelCard: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: radius.lg, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
    padding: 14, gap: 10,
  },
  levelTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  levelIconWrap: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  levelLabel: { color: 'rgba(255,255,255,0.4)', fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },
  levelName:  { fontSize: 15, fontWeight: '900', letterSpacing: 0.2 },
  levelPts:   { color: 'rgba(255,255,255,0.5)', fontSize: 11, fontWeight: '700' },
  levelBarBg: {
    height: 6, borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.1)',
    overflow: 'hidden',
  },
  levelBarFill: { height: '100%', borderRadius: 3 },
  levelNextLabel: {
    color: 'rgba(255,255,255,0.45)', fontSize: 11, fontWeight: '700', textAlign: 'center',
  },
});
