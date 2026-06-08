/**
 * app/games/spik-snap.tsx — Style B: Tinder-style swipe.
 *
 * - 60-second timer
 * - A card shows a Shetland word + a meaning
 * - Swipe right if the meaning matches, left if not (or use buttons)
 * - 50/50 chance the meaning is wrong
 * - +1 for correct, -2 seconds for wrong
 * - Correct → confetti burst + +1 float; Wrong → red flash + shake
 * - Card flips to the next question on answer
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated, ActivityIndicator,
  PanResponder, Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import { loadSpikGameWords, makeSnapCard, type SpikGameWord } from '@/lib/spik-games-data';
import { submitScore, fetchTopScores, type LeaderboardRow } from '@/lib/games-api';

const S = SECTIONS.games;
const ROUND_SECONDS = 60;
const WRONG_PENALTY_SEC = 2;
const SWIPE_THRESHOLD = 100;
const { width: SCREEN_W } = Dimensions.get('window');

// Confetti particle colours
const CONFETTI_COLORS = ['#FBBF24', '#10B981', '#3B82F6', '#EC4899', '#F97316', '#A855F7', '#fff'];
const PARTICLE_COUNT = 28;

type Phase = 'loading' | 'ready' | 'playing' | 'done';

interface Card {
  word: SpikGameWord;
  shownMeaning: string;
  match: boolean;
}

export default function SpikSnapScreen() {
  const router = useRouter();
  const { profile } = useAuth();

  const [phase, setPhase]       = useState<Phase>('loading');
  const [pool, setPool]         = useState<SpikGameWord[]>([]);
  const [card, setCard]         = useState<Card | null>(null);
  const [score, setScore]       = useState(0);
  const [streak, setStreak]     = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(ROUND_SECONDS);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);

  const pan = useRef(new Animated.ValueXY()).current;
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const answeringRef = useRef(false); // guard against double-triggers during flip
  // endRoundRef always points to the latest endRound so the stale-closure
  // in setInterval sees the current score/bestStreak values.
  const endRoundRef = useRef<() => Promise<void>>(async () => {});

  // Flip animation — drives rotateY for the card-turn transition
  // useNativeDriver: false because it shares a transform array with pan (non-native)
  const flipAnim = useRef(new Animated.Value(0)).current;

  // Reward / feedback animations
  const shakeAnim    = useRef(new Animated.Value(0)).current;
  const redFlash     = useRef(new Animated.Value(0)).current;
  const scorePop     = useRef(new Animated.Value(1)).current;
  const plusOne      = useRef(new Animated.Value(0)).current;
  const [showConfetti, setShowConfetti] = useState(0);
  const [countdownNum, setCountdownNum] = useState<number | null>(null);
  const countdownScale   = useRef(new Animated.Value(1)).current;
  const countdownOpacity = useRef(new Animated.Value(0)).current;
  const lastCountdownSec = useRef<number | null>(null);

  // Card rotation/opacity from horizontal drag
  const rotate = pan.x.interpolate({
    inputRange:  [-SCREEN_W, 0, SCREEN_W],
    outputRange: ['-15deg', '0deg', '15deg'],
  });
  const yesOpacity = pan.x.interpolate({ inputRange: [0, SWIPE_THRESHOLD], outputRange: [0, 1], extrapolate: 'clamp' });
  const noOpacity  = pan.x.interpolate({ inputRange: [-SWIPE_THRESHOLD, 0], outputRange: [1, 0], extrapolate: 'clamp' });
  const cardRotateY = flipAnim.interpolate({ inputRange: [-90, 0, 90], outputRange: ['-90deg', '0deg', '90deg'] });

  // Load pool
  useEffect(() => {
    loadSpikGameWords()
      .then(words => { setPool(words); setPhase('ready'); })
      .catch(err => { console.error(err); setPhase('ready'); });
  }, []);

  // Timer — calls endRound via ref so the interval always sees the latest score
  useEffect(() => {
    if (phase !== 'playing') return;
    timerRef.current = setInterval(() => {
      setSecondsLeft(s => {
        if (s <= 1) { endRoundRef.current(); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [phase]);

  // Big-number countdown for the final 5 seconds
  useEffect(() => {
    if (phase !== 'playing') return;
    if (secondsLeft <= 5 && secondsLeft >= 1 && lastCountdownSec.current !== secondsLeft) {
      lastCountdownSec.current = secondsLeft;
      setCountdownNum(secondsLeft);
      countdownScale.setValue(2.5);
      countdownOpacity.setValue(0.85);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      Animated.parallel([
        Animated.timing(countdownScale,   { toValue: 1.0, duration: 800, useNativeDriver: true }),
        Animated.timing(countdownOpacity, { toValue: 0,   duration: 800, useNativeDriver: true }),
      ]).start(() => setCountdownNum(null));
    }
    if (secondsLeft > 5) lastCountdownSec.current = null;
  }, [secondsLeft, phase]);

  // Pan responder — swipe drag still works for feel; release past threshold triggers answer
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 5,
      onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false }),
      onPanResponderRelease: (_, g) => {
        if (g.dx > SWIPE_THRESHOLD) flyOut(true);
        else if (g.dx < -SWIPE_THRESHOLD) flyOut(false);
        else Animated.spring(pan, { toValue: { x: 0, y: 0 }, friction: 6, useNativeDriver: false }).start();
      },
    }),
  ).current;

  const startRound = () => {
    setScore(0);
    setStreak(0);
    setBestStreak(0);
    setSecondsLeft(ROUND_SECONDS);
    setCard(makeSnapCard(pool));
    pan.setValue({ x: 0, y: 0 });
    flipAnim.setValue(0);
    shakeAnim.setValue(0);
    redFlash.setValue(0);
    scorePop.setValue(1);
    plusOne.setValue(0);
    setCountdownNum(null);
    lastCountdownSec.current = null;
    answeringRef.current = false;
    setPhase('playing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  const flyOut = (userSwipedRight: boolean) => {
    if (!card || answeringRef.current) return;
    answeringRef.current = true;

    const correct = userSwipedRight === card.match;

    // Fire feedback immediately
    if (correct) {
      setScore(s => s + 1);
      setStreak(s => { const next = s + 1; setBestStreak(b => Math.max(b, next)); return next; });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setShowConfetti(c => c + 1);
      Animated.sequence([
        Animated.timing(scorePop, { toValue: 1.4, duration: 120, useNativeDriver: true }),
        Animated.spring(scorePop, { toValue: 1,   friction: 4,  useNativeDriver: true }),
      ]).start();
      plusOne.setValue(0);
      Animated.timing(plusOne, { toValue: 1, duration: 700, useNativeDriver: true }).start();
    } else {
      setStreak(0);
      setSecondsLeft(s => Math.max(0, s - WRONG_PENALTY_SEC));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Animated.sequence([
        Animated.timing(redFlash, { toValue: 0.35, duration: 60,  useNativeDriver: true }),
        Animated.timing(redFlash, { toValue: 0,    duration: 280, useNativeDriver: true }),
      ]).start();
      Animated.sequence([
        Animated.timing(shakeAnim, { toValue: 12,  duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: -12, duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 6,   duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 0,   duration: 50, useNativeDriver: true }),
      ]).start();
    }

    // Snap pan back instantly, then flip card out → swap → flip in
    pan.setValue({ x: 0, y: 0 });
    flipAnim.setValue(0);

    Animated.timing(flipAnim, { toValue: 90, duration: 150, useNativeDriver: false }).start(() => {
      setCard(makeSnapCard(pool));
      flipAnim.setValue(-90);
      Animated.timing(flipAnim, { toValue: 0, duration: 150, useNativeDriver: false }).start(() => {
        answeringRef.current = false;
      });
    });
  };

  // Keep the ref pointing at the latest version on every render
  const endRound = async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setPhase('done');
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    if (profile && score > 0) {
      try {
        await submitScore(profile.id, 'spik_snap', score, {
          durationMs: ROUND_SECONDS * 1000,
          metadata: { best_streak: bestStreak },
          xpEarned: score,
        });
      } catch (e) { console.error('Score submit failed', e); }
    }
    try {
      const lb = await fetchTopScores('spik_snap', 'all', 5);
      setLeaderboard(lb);
    } catch {}
  };
  endRoundRef.current = endRound;

  const exit = () => router.back();

  if (phase === 'loading') {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>

      {/* Header */}
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity style={styles.headerBtn} onPress={exit} hitSlop={12}>
          <FontAwesome5 name="times" size={16} color={S.color} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Spik Snap</Text>
          {phase === 'playing' && (
            <View style={styles.headerScoreRow}>
              <Animated.Text style={[styles.headerScore, { color: S.color, transform: [{ scale: scorePop }] }]}>
                {score}
              </Animated.Text>
              {streak >= 3 && (
                <View style={styles.streakPill}>
                  <FontAwesome5 name="fire" size={9} color="#fff" solid />
                  <Text style={styles.streakText}>{streak}</Text>
                </View>
              )}
            </View>
          )}
        </View>
        <View style={{ width: 32 }} />
      </View>

      {phase === 'playing' && (
        <View style={styles.timerBar}>
          <View style={[styles.timerFill, {
            width: `${(secondsLeft / ROUND_SECONDS) * 100}%`,
            backgroundColor: secondsLeft <= 10 ? colors.error : S.color,
          }]} />
        </View>
      )}

      <View style={styles.body}>

        {phase === 'ready' && (
          <View style={styles.intro}>
            <View style={[styles.introIcon, { backgroundColor: S.light }]}>
              <FontAwesome5 name="hand-paper" size={36} color={S.color} solid />
            </View>
            <Text style={styles.introTitle}>Spik Snap</Text>
            <Text style={styles.introSub}>
              Does the meaning match the word?{'\n'}
              Swipe <Text style={{ color: '#16A34A', fontWeight: '900' }}>right</Text> for yes,{' '}
              <Text style={{ color: colors.error, fontWeight: '900' }}>left</Text> for no.{'\n'}
              Or tap the buttons below.{'\n'}
              You have {ROUND_SECONDS} seconds. Wrong = −{WRONG_PENALTY_SEC}s.
            </Text>
            <TouchableOpacity
              style={[styles.startBtn, { backgroundColor: S.color }]}
              onPress={startRound}
              activeOpacity={0.85}
            >
              <FontAwesome5 name="play" size={13} color="#fff" solid />
              <Text style={styles.startBtnText}>Start</Text>
            </TouchableOpacity>
          </View>
        )}

        {phase === 'playing' && card && (
          <Animated.View style={[styles.playArea, { transform: [{ translateX: shakeAnim }] }]}>
            <Animated.View
              {...panResponder.panHandlers}
              style={[
                styles.card,
                {
                  transform: [
                    { perspective: 1000 },
                    { translateX: pan.x },
                    { translateY: pan.y },
                    { rotate },
                    { rotateY: cardRotateY },
                  ],
                },
              ]}
            >
              {/* MATCH/NOPE labels fade in as you drag */}
              <Animated.View style={[styles.cornerLabel, styles.cornerLeft, { opacity: yesOpacity }]}>
                <Text style={[styles.cornerText, { color: '#16A34A', borderColor: '#16A34A' }]}>MATCH</Text>
              </Animated.View>
              <Animated.View style={[styles.cornerLabel, styles.cornerRight, { opacity: noOpacity }]}>
                <Text style={[styles.cornerText, { color: colors.error, borderColor: colors.error }]}>NOPE</Text>
              </Animated.View>

              <Text style={styles.cardLabel}>Shetland word</Text>
              <Text style={styles.cardWord}>{card.word.word}</Text>
              {card.word.pronunciation ? (
                <Text style={styles.cardPron}>/{card.word.pronunciation}/</Text>
              ) : null}
              <View style={styles.cardDivider} />
              <Text style={styles.cardLabel}>Means</Text>
              <Text style={styles.cardMeaning}>{card.shownMeaning}</Text>
            </Animated.View>

            <View style={styles.actionRow}>
              <TouchableOpacity
                style={[styles.actionBtn, styles.actionNo]}
                onPress={() => flyOut(false)}
                activeOpacity={0.7}
              >
                <FontAwesome5 name="times" size={22} color={colors.error} />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionBtn, styles.actionYes]}
                onPress={() => flyOut(true)}
                activeOpacity={0.7}
              >
                <FontAwesome5 name="check" size={22} color="#16A34A" />
              </TouchableOpacity>
            </View>

            <Text style={styles.swipeHint}>← swipe left for "no"   ·   swipe right for "yes" →</Text>
          </Animated.View>
        )}

        {phase === 'done' && (
          <View style={styles.doneArea}>
            <View style={[styles.doneIcon, { backgroundColor: S.light }]}>
              <FontAwesome5 name="check" size={32} color={S.color} solid />
            </View>
            <Text style={styles.doneScoreLabel}>Time's up!</Text>
            <Text style={[styles.doneScore, { color: S.color }]}>{score}</Text>
            <Text style={styles.doneScoreSub}>
              {score < 5  ? 'A good start. Keep playing!' :
               score < 10 ? 'Nice work!' :
               score < 20 ? 'Great speed!' :
               score < 30 ? 'You\'re flying!' :
                            'Snap master!'}
            </Text>

            {bestStreak >= 3 && (
              <View style={styles.bestStreakRow}>
                <FontAwesome5 name="fire" size={12} color={colors.shifts} solid />
                <Text style={styles.bestStreakText}>Best streak: {bestStreak}</Text>
              </View>
            )}

            {profile && score > 0 && (
              <View style={styles.xpEarned}>
                <Text style={[styles.xpText, { color: S.color }]}>+{score} XP</Text>
              </View>
            )}

            {leaderboard.length > 0 && (
              <View style={styles.miniLb}>
                <Text style={styles.miniLbTitle}>All-time top</Text>
                {leaderboard.slice(0, 5).map((row, i) => (
                  <View key={row.user_id} style={styles.miniLbRow}>
                    <Text style={styles.miniLbRank}>{i + 1}</Text>
                    <Text style={styles.miniLbName} numberOfLines={1}>
                      {row.games_handle ?? 'Anon'}
                      {profile?.id === row.user_id && <Text style={{ color: S.color }}> · you</Text>}
                    </Text>
                    <Text style={styles.miniLbScore}>{row.best_score}</Text>
                  </View>
                ))}
              </View>
            )}

            <View style={styles.doneActions}>
              <TouchableOpacity
                style={[styles.startBtn, { backgroundColor: S.color }]}
                onPress={startRound}
                activeOpacity={0.85}
              >
                <FontAwesome5 name="redo" size={12} color="#fff" solid />
                <Text style={styles.startBtnText}>Play again</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.doneSecondary} onPress={exit}>
                <Text style={styles.doneSecondaryText}>Back to Games</Text>
              </TouchableOpacity>
            </View>

            {!profile && (
              <Text style={styles.doneSignInHint}>
                Sign in to save your score and climb the leaderboard.
              </Text>
            )}
          </View>
        )}

      </View>

      {/* ── Reward / feedback overlays — all pointerEvents="none" ── */}

      {/* Confetti burst on correct */}
      {phase === 'playing' && <ConfettiBurst trigger={showConfetti} />}

      {/* "+1" float */}
      {phase === 'playing' && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.plusOne,
            {
              opacity: plusOne.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 1, 0] }),
              transform: [{ translateY: plusOne.interpolate({ inputRange: [0, 1], outputRange: [0, -80] }) }],
            },
          ]}
        >
          <Text style={[styles.plusOneText, { color: S.color }]}>+1</Text>
        </Animated.View>
      )}

      {/* Red flash on wrong */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFillObject, { backgroundColor: '#DC2626', opacity: redFlash }]} />

      {/* Big countdown number in final 5 seconds */}
      {countdownNum !== null && (
        <View pointerEvents="none" style={styles.countdownOverlay}>
          <Animated.Text style={[styles.countdownNumber, { opacity: countdownOpacity, transform: [{ scale: countdownScale }] }]}>
            {countdownNum}
          </Animated.Text>
        </View>
      )}

    </SafeAreaView>
  );
}

// ── Confetti burst ────────────────────────────────────────────────────────────

function ConfettiBurst({ trigger }: { trigger: number }) {
  const particles = useRef(
    Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
      key: i,
      x: new Animated.Value(0),
      y: new Animated.Value(0),
      rot: new Animated.Value(0),
      opacity: new Animated.Value(0),
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    })),
  ).current;

  useEffect(() => {
    if (trigger === 0) return;
    particles.forEach((p, i) => {
      const angle  = (Math.PI * 2 * i) / PARTICLE_COUNT + (Math.random() - 0.5) * 0.4;
      const dist   = 100 + Math.random() * 90;
      const targetX = Math.cos(angle) * dist;
      const targetY = Math.sin(angle) * dist - 40;
      const fall   = targetY + 200 + Math.random() * 80;
      p.x.setValue(0); p.y.setValue(0); p.rot.setValue(0); p.opacity.setValue(1);
      Animated.parallel([
        Animated.timing(p.x,       { toValue: targetX, duration: 700, useNativeDriver: true }),
        Animated.sequence([
          Animated.timing(p.y,     { toValue: targetY, duration: 320, useNativeDriver: true }),
          Animated.timing(p.y,     { toValue: fall,    duration: 580, useNativeDriver: true }),
        ]),
        Animated.timing(p.rot,     { toValue: (Math.random() - 0.5) * 4, duration: 900, useNativeDriver: true }),
        Animated.sequence([
          Animated.delay(400),
          Animated.timing(p.opacity, { toValue: 0, duration: 500, useNativeDriver: true }),
        ]),
      ]).start();
    });
  }, [trigger]);

  return (
    <View pointerEvents="none" style={styles.confettiHost}>
      {particles.map(p => (
        <Animated.View
          key={p.key}
          style={{
            position: 'absolute',
            width: 9, height: 14, marginLeft: -4.5, marginTop: -7,
            backgroundColor: p.color, borderRadius: 2,
            opacity: p.opacity,
            transform: [
              { translateX: p.x },
              { translateY: p.y },
              { rotate: p.rot.interpolate({ inputRange: [-2, 2], outputRange: ['-720deg', '720deg'] }) },
            ],
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.navy },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
    borderBottomWidth: 2,
  },
  headerBtn:      { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  headerCenter:   { alignItems: 'center', gap: 4 },
  headerTitle:    { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
  headerScoreRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headerScore:    { fontSize: 20, fontWeight: '900' },
  streakPill:     { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: colors.shifts, paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.full },
  streakText:     { color: '#fff', fontSize: 10, fontWeight: '900' },

  timerBar:  { height: 4, backgroundColor: colors.border },
  timerFill: { height: 4 },

  body: { flex: 1, padding: spacing.lg },

  // Intro
  intro:      { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, padding: spacing.lg },
  introIcon:  { width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center' },
  introTitle: { fontSize: 32, fontWeight: '900', color: colors.textPrimary, letterSpacing: -0.6 },
  introSub:   { fontSize: fontSize.md, color: colors.textMuted, textAlign: 'center', lineHeight: 22 },

  startBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 10, paddingHorizontal: 24, paddingVertical: 14, borderRadius: radius.full,
    marginTop: 12,
  },
  startBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },

  // Play
  playArea: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 20 },
  card: {
    width: '100%', minHeight: 320,
    backgroundColor: '#fff', borderRadius: 24, padding: 28,
    borderWidth: 1, borderColor: colors.border,
    shadowColor: '#0F1C26', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.12, shadowRadius: 16, elevation: 8,
    justifyContent: 'center', alignItems: 'flex-start', gap: 6,
    backfaceVisibility: 'hidden',
  },
  cardLabel:   { fontSize: 11, color: colors.textMuted, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1.5 },
  cardWord:    { fontSize: 44, fontWeight: '900', color: colors.textPrimary, letterSpacing: -1.2, marginBottom: 4 },
  cardPron:    { fontSize: 14, color: colors.textMuted, fontStyle: 'italic', fontWeight: '500', marginTop: -2 },
  cardDivider: { width: '100%', height: 1, backgroundColor: colors.border, marginVertical: 12 },
  cardMeaning: { fontSize: 24, fontWeight: '700', color: colors.textPrimary, lineHeight: 30 },

  cornerLabel: {
    position: 'absolute', top: 20,
    paddingHorizontal: 12, paddingVertical: 6,
    transform: [{ rotate: '0deg' }],
  },
  cornerLeft:  { right: 20, transform: [{ rotate: '12deg' }] },
  cornerRight: { left: 20,  transform: [{ rotate: '-12deg' }] },
  cornerText:  { fontSize: 22, fontWeight: '900', letterSpacing: 2, borderWidth: 4, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 },

  actionRow: { flexDirection: 'row', gap: 60 },
  actionBtn: { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff', borderWidth: 2 },
  actionNo:  { borderColor: colors.error },
  actionYes: { borderColor: '#16A34A' },

  swipeHint: { fontSize: 11, color: colors.textLight, fontWeight: '600' },

  // Reward overlays
  plusOne: {
    position: 'absolute',
    top: '38%', alignSelf: 'center',
    left: 0, right: 0, alignItems: 'center',
  },
  plusOneText: {
    fontSize: 56, fontWeight: '900', letterSpacing: -1.5,
    textShadowColor: 'rgba(0,0,0,0.18)', textShadowRadius: 4, textShadowOffset: { width: 0, height: 2 },
  },
  confettiHost: {
    position: 'absolute', left: '50%', top: '45%',
    width: 0, height: 0,
  },
  countdownOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center',
  },
  countdownNumber: {
    fontSize: 240, fontWeight: '900', color: '#DC2626',
    letterSpacing: -8,
    textShadowColor: 'rgba(255,255,255,0.6)', textShadowRadius: 10, textShadowOffset: { width: 0, height: 0 },
  },

  // Done
  doneArea: { flex: 1, alignItems: 'center', justifyContent: 'flex-start', paddingTop: spacing.lg, gap: 10 },
  doneIcon: { width: 80, height: 80, borderRadius: 40, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  doneScoreLabel: { fontSize: fontSize.sm, color: colors.textMuted, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  doneScore: { fontSize: 72, fontWeight: '900', letterSpacing: -2 },
  doneScoreSub: { fontSize: fontSize.md, color: colors.textPrimary, fontWeight: '700', textAlign: 'center' },

  bestStreakRow:  { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4 },
  bestStreakText: { fontSize: fontSize.sm, color: colors.textSecondary, fontWeight: '700' },

  xpEarned: { paddingHorizontal: 14, paddingVertical: 6, backgroundColor: '#D1FAE5', borderRadius: radius.full, marginTop: 8 },
  xpText:   { fontSize: fontSize.sm, fontWeight: '900' },

  miniLb: { width: '100%', backgroundColor: '#fff', borderRadius: radius.lg, padding: 12, marginTop: 16, borderWidth: 1, borderColor: colors.border },
  miniLbTitle: { fontSize: 11, color: colors.textMuted, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 },
  miniLbRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 5 },
  miniLbRank: { width: 18, fontSize: 11, fontWeight: '900', color: colors.textMuted },
  miniLbName: { flex: 1, fontSize: fontSize.xs, color: colors.textPrimary, fontWeight: '600' },
  miniLbScore: { fontSize: fontSize.sm, fontWeight: '900', color: colors.textPrimary },

  doneActions:       { width: '100%', marginTop: 16, alignItems: 'center', gap: 4 },
  doneSecondary:     { paddingVertical: 12 },
  doneSecondaryText: { fontSize: fontSize.sm, color: colors.textMuted, fontWeight: '700' },

  doneSignInHint: { fontSize: fontSize.xs, color: colors.textMuted, textAlign: 'center', marginTop: 8 },
});
