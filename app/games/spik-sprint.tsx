/**
 * app/games/spik-sprint.tsx — Style A: Tap-to-pick speed round.
 *
 * - 60-second timer
 * - English meaning at the top
 * - 4 Shetland words below in a 2x2 grid
 * - Tap correct → +1 point, next question, build a streak
 * - Tap wrong  → -2 seconds, brief shake
 * - End screen: score, XP, leaderboard placement, play again
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import { loadSpikGameWords, makeSprintQuestion, type SpikGameWord } from '@/lib/spik-games-data';
import { submitScore, fetchTopScores, type LeaderboardRow } from '@/lib/games-api';

const S = SECTIONS.games;
const ROUND_SECONDS = 60;
const WRONG_PENALTY_SEC = 2;

// 4 punchy saturated tile colours — gameshow energy
const TILE_COLORS = [
  { bg: '#E11D48', letterBg: '#fff', letterText: '#E11D48' }, // rose-600
  { bg: '#0284C7', letterBg: '#fff', letterText: '#0284C7' }, // sky-600
  { bg: '#EA580C', letterBg: '#fff', letterText: '#EA580C' }, // orange-600
  { bg: '#7C3AED', letterBg: '#fff', letterText: '#7C3AED' }, // violet-600
];

// Confetti particle colours
const CONFETTI_COLORS = ['#FBBF24', '#10B981', '#3B82F6', '#EC4899', '#F97316', '#A855F7', '#fff'];
const PARTICLE_COUNT = 28;

type Phase = 'loading' | 'ready' | 'playing' | 'done';

interface Question {
  meaning: string;
  options: SpikGameWord[];
  correctIndex: number;
}

export default function SpikSprintScreen() {
  const router = useRouter();
  const { profile } = useAuth();

  const [phase, setPhase]       = useState<Phase>('loading');
  const [pool, setPool]         = useState<SpikGameWord[]>([]);
  const [question, setQuestion] = useState<Question | null>(null);
  const [score, setScore]       = useState(0);
  const [streak, setStreak]     = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(ROUND_SECONDS);
  const [feedback, setFeedback] = useState<'right' | 'wrong' | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // endRoundRef always points to the latest endRound so the stale-closure
  // in setInterval sees the current score/bestStreak values.
  const endRoundRef = useRef<() => Promise<void>>(async () => {});
  const shakeAnim = useRef(new Animated.Value(0)).current;

  // Reward / feedback animations
  const redFlash    = useRef(new Animated.Value(0)).current;
  const scorePop    = useRef(new Animated.Value(1)).current;
  const plusOne     = useRef(new Animated.Value(0)).current;
  const [showConfetti, setShowConfetti] = useState(0); // increments to retrigger
  const [countdownNum, setCountdownNum]         = useState<number | null>(null);
  const countdownScale   = useRef(new Animated.Value(1)).current;
  const countdownOpacity = useRef(new Animated.Value(0)).current;
  const lastCountdownSec = useRef<number | null>(null);

  // Load word pool once
  useEffect(() => {
    loadSpikGameWords()
      .then(words => { setPool(words); setPhase('ready'); })
      .catch(err => { console.error(err); setPhase('ready'); });
  }, []);

  // Tick — calls endRound via ref so the interval always sees the latest score
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

  const startRound = () => {
    setScore(0);
    setStreak(0);
    setBestStreak(0);
    setSecondsLeft(ROUND_SECONDS);
    setFeedback(null);
    setQuestion(makeSprintQuestion(pool));
    setPhase('playing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  // Keep the ref pointing at the latest version of endRound on every render
  // so the timer interval above always calls with fresh score/bestStreak state.
  const endRound = async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setPhase('done');
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    if (profile && score > 0) {
      try {
        await submitScore(profile.id, 'spik_sprint', score, {
          durationMs: ROUND_SECONDS * 1000,
          metadata: { best_streak: bestStreak },
          xpEarned: score,    // 1 XP per correct
        });
      } catch (e) { console.error('Score submit failed', e); }
    }

    try {
      const lb = await fetchTopScores('spik_sprint', 'all', 5);
      setLeaderboard(lb);
    } catch {}
  };
  endRoundRef.current = endRound;

  const handleAnswer = (idx: number) => {
    if (!question || phase !== 'playing') return;
    const correct = idx === question.correctIndex;
    if (correct) {
      setScore(s => s + 1);
      setStreak(s => {
        const next = s + 1;
        setBestStreak(b => Math.max(b, next));
        return next;
      });
      setFeedback('right');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      // Confetti retrigger
      setShowConfetti(c => c + 1);

      // Score number pulses
      Animated.sequence([
        Animated.timing(scorePop, { toValue: 1.4, duration: 120, useNativeDriver: true }),
        Animated.spring(scorePop, { toValue: 1,   friction: 4,  useNativeDriver: true }),
      ]).start();

      // "+1" floats up and fades
      plusOne.setValue(0);
      Animated.timing(plusOne, { toValue: 1, duration: 700, useNativeDriver: true }).start();

      setTimeout(() => {
        setFeedback(null);
        setQuestion(makeSprintQuestion(pool));
      }, 350);
    } else {
      setStreak(0);
      setSecondsLeft(s => Math.max(0, s - WRONG_PENALTY_SEC));
      setFeedback('wrong');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);

      // Red flash overlay
      Animated.sequence([
        Animated.timing(redFlash, { toValue: 0.35, duration: 60,  useNativeDriver: true }),
        Animated.timing(redFlash, { toValue: 0,    duration: 280, useNativeDriver: true }),
      ]).start();

      // Shake
      Animated.sequence([
        Animated.timing(shakeAnim, { toValue: 12,  duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: -12, duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 6,   duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 0,   duration: 50, useNativeDriver: true }),
      ]).start();
      setTimeout(() => {
        setFeedback(null);
        setQuestion(makeSprintQuestion(pool));
      }, 650);
    }
  };

  const exit = () => router.back();

  // ── Render ──

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
          {phase === 'playing' ? (
            <View style={styles.headerPlayRow}>
              <View style={styles.headerScoreBlock}>
                <Text style={styles.headerScoreLabel}>SCORE</Text>
                <Animated.Text style={[styles.headerScore, { color: S.color, transform: [{ scale: scorePop }] }]}>
                  {score}
                </Animated.Text>
              </View>
              <View style={styles.headerTimeBlock}>
                <Text style={styles.headerScoreLabel}>TIME</Text>
                <Text style={[styles.headerTime, secondsLeft <= 10 && { color: colors.error }]}>
                  0:{String(secondsLeft).padStart(2, '0')}
                </Text>
              </View>
            </View>
          ) : (
            <Text style={styles.headerTitle}>Spik Sprint</Text>
          )}
        </View>
        <View style={{ width: 32 }} />
      </View>

      {/* Timer bar */}
      {phase === 'playing' && (
        <View style={styles.timerBar}>
          <View style={[styles.timerFill, {
            width: `${(secondsLeft / ROUND_SECONDS) * 100}%`,
            backgroundColor: secondsLeft <= 10 ? colors.error : S.color,
          }]} />
        </View>
      )}

      {/* Body */}
      <View style={styles.body}>

        {phase === 'ready' && (
          <View style={styles.intro}>
            <View style={[styles.introIcon, { backgroundColor: S.light }]}>
              <FontAwesome5 name="bolt" size={36} color={S.color} solid />
            </View>
            <Text style={styles.introTitle}>Spik Sprint</Text>
            <Text style={styles.introSub}>
              How many can you get in {ROUND_SECONDS} seconds?{'\n'}
              Tap the right Shetland word.{'\n'}
              Wrong answer = −{WRONG_PENALTY_SEC}s.
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

        {phase === 'playing' && question && (
          <Animated.View style={[styles.playArea, { transform: [{ translateX: shakeAnim }] }]}>

            {/* Streak banner — appears once you're on a roll */}
            {streak >= 3 && (
              <View style={styles.streakBanner}>
                <FontAwesome5 name="fire" size={16} color="#fff" solid />
                <Text style={styles.streakBannerText}>{streak}× COMBO</Text>
                <FontAwesome5 name="fire" size={16} color="#fff" solid />
              </View>
            )}

            {/* Question card */}
            <View style={styles.questionCard}>
              <Text style={styles.questionLabel}>What's the Shetland word for</Text>
              <Text style={styles.questionMeaning}>{question.meaning}</Text>
            </View>

            {/* Coloured option tiles */}
            <View style={styles.optionsGrid}>
              {question.options.map((opt, i) => {
                const tile = TILE_COLORS[i];
                const isCorrectFeedback = feedback && i === question.correctIndex;
                const isRevealedWrong = feedback === 'wrong' && i !== question.correctIndex;
                return (
                  <TouchableOpacity
                    key={opt.id}
                    style={[
                      styles.optionBtn,
                      { backgroundColor: tile.bg },
                      isCorrectFeedback && styles.optionCorrect,
                      isRevealedWrong && styles.optionDimmed,
                    ]}
                    onPress={() => handleAnswer(i)}
                    disabled={!!feedback}
                    activeOpacity={0.8}
                  >
                    <View style={[styles.optionLetter, { backgroundColor: tile.letterBg }]}>
                      <Text style={[styles.optionLetterText, { color: tile.letterText }]}>
                        {String.fromCharCode(65 + i)}
                      </Text>
                    </View>
                    <Text style={styles.optionText} numberOfLines={2}>{opt.word}</Text>
                    {opt.pronunciation ? (
                      <Text style={styles.optionPron}>/{opt.pronunciation}/</Text>
                    ) : null}
                    {isCorrectFeedback && (
                      <View style={styles.optionCheck}>
                        <FontAwesome5 name="check" size={14} color="#fff" solid />
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={styles.helperText}>
              Tap the right word · +1 for correct · −{WRONG_PENALTY_SEC}s for wrong
            </Text>
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
              {score === 0 ? 'No correct answers — try again!' :
               score < 5  ? 'A good start. Keep playing!' :
               score < 10 ? 'Nice work!' :
               score < 15 ? 'Great speed!' :
               score < 20 ? 'You\'re on fire!' :
                            'Spik master!'}
            </Text>

            {bestStreak >= 3 && (
              <View style={styles.bestStreakRow}>
                <FontAwesome5 name="fire" size={12} color={colors.shifts} solid />
                <Text style={styles.bestStreakText}>Best streak: {bestStreak}</Text>
              </View>
            )}

            {profile && (
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
  safe:   { flex: 1, backgroundColor: S.light },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 10,
    borderBottomWidth: 3,
  },
  headerBtn:    { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  headerCenter: { flex: 1, alignItems: 'center' },
  headerTitle:  { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },

  headerPlayRow:    { flexDirection: 'row', alignItems: 'center', gap: 32 },
  headerScoreBlock: { alignItems: 'center', minWidth: 60 },
  headerScoreLabel: { color: 'rgba(255,255,255,0.55)', fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },
  headerScore:      { fontSize: 26, fontWeight: '900', letterSpacing: -0.5, marginTop: -2 },
  headerTimeBlock:  { alignItems: 'center', minWidth: 60 },
  headerTime:       { color: '#fff', fontSize: 26, fontWeight: '900', letterSpacing: -0.5, marginTop: -2 },

  timerBar:  { height: 6, backgroundColor: 'rgba(255,255,255,0.15)' },
  timerFill: { height: 6 },

  body: { flex: 1, padding: spacing.lg, justifyContent: 'space-between' },

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

  // Play — overall layout
  playArea: { flex: 1, justifyContent: 'space-between', gap: 14, paddingVertical: 4 },

  // Streak banner — pops in when you're on a roll
  streakBanner: {
    flexDirection: 'row', alignSelf: 'center', alignItems: 'center', gap: 8,
    backgroundColor: colors.shifts,
    paddingHorizontal: 16, paddingVertical: 8,
    borderRadius: radius.full,
    shadowColor: colors.shifts, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 8, elevation: 4,
  },
  streakBannerText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '900', letterSpacing: 0.8 },

  // Question card — elevated white card on the green tinted background
  questionCard: {
    backgroundColor: '#fff',
    borderRadius: 24,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
    alignItems: 'center', gap: 10,
    shadowColor: '#0F1C26', shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08, shadowRadius: 16, elevation: 4,
  },
  questionLabel: {
    fontSize: 11, color: colors.textMuted, fontWeight: '900',
    textTransform: 'uppercase', letterSpacing: 1.5, textAlign: 'center',
  },
  questionMeaning: {
    fontSize: 30, fontWeight: '900', color: colors.textPrimary,
    textAlign: 'center', letterSpacing: -0.5, lineHeight: 36,
  },

  // Options grid — coloured tiles with letter chips
  optionsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, width: '100%' },
  optionBtn: {
    width: '48%', minHeight: 96,
    borderRadius: 18,
    paddingHorizontal: 14, paddingVertical: 14,
    alignItems: 'flex-start', justifyContent: 'space-between',
    gap: 8,
    shadowColor: '#0F1C26', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 8, elevation: 4,
  },
  optionLetter: {
    width: 28, height: 28, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  optionLetterText: { fontSize: 13, fontWeight: '900' },
  optionText:    { fontSize: 20, fontWeight: '900', color: '#fff', letterSpacing: -0.3 },
  optionCorrect: {
    backgroundColor: '#16A34A', borderColor: '#16A34A',
    shadowColor: '#16A34A', shadowOpacity: 0.4, shadowRadius: 12,
  },
  optionDimmed:  { opacity: 0.4 },
  optionPron:    { fontSize: 11, color: 'rgba(255,255,255,0.65)', fontWeight: '600', fontStyle: 'italic' },
  optionCheck: {
    position: 'absolute', top: 10, right: 10,
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center', justifyContent: 'center',
  },

  helperText: {
    fontSize: 11, color: colors.textMuted, fontWeight: '600',
    textAlign: 'center', letterSpacing: 0.3,
  },

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

  bestStreakRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4 },
  bestStreakText: { fontSize: fontSize.sm, color: colors.textSecondary, fontWeight: '700' },

  xpEarned: { paddingHorizontal: 14, paddingVertical: 6, backgroundColor: '#D1FAE5', borderRadius: radius.full, marginTop: 8 },
  xpText:   { fontSize: fontSize.sm, fontWeight: '900' },

  miniLb: { width: '100%', backgroundColor: '#fff', borderRadius: radius.lg, padding: 12, marginTop: 16, borderWidth: 1, borderColor: colors.border },
  miniLbTitle: { fontSize: 11, color: colors.textMuted, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 },
  miniLbRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 5 },
  miniLbRank: { width: 18, fontSize: 11, fontWeight: '900', color: colors.textMuted },
  miniLbName: { flex: 1, fontSize: fontSize.xs, color: colors.textPrimary, fontWeight: '600' },
  miniLbScore: { fontSize: fontSize.sm, fontWeight: '900', color: colors.textPrimary },

  doneActions: { width: '100%', marginTop: 16, alignItems: 'center', gap: 4 },
  doneSecondary: { paddingVertical: 12 },
  doneSecondaryText: { fontSize: fontSize.sm, color: colors.textMuted, fontWeight: '700' },

  doneSignInHint: { fontSize: fontSize.xs, color: colors.textMuted, textAlign: 'center', marginTop: 8 },
});
