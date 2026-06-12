/**
 * app/games/guess-da-wird.tsx
 *
 * Guess Da Wird — daily Shetland dialect word game.
 *
 * Letter states (original, not Wordle-derived):
 *   Anchored  ⚓  #12B3D6 sea-blue  — right letter, right place
 *   Drifting  〰  #F59E0B amber      — right letter, wrong place
 *   Away      ·   #64748B slate     — not in the wird
 */

import React, {
  useCallback, useEffect, useMemo, useReducer, useRef, useState,
} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Share, Animated, Platform,
  Modal, TextInput, FlatList,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import { useAlert } from '@/components/BrandedAlert';
import { submitScore } from '@/lib/games-api';
import { GameArt, GAME_COLORS, GAME_LIGHTS } from '@/components/GameArt';
import {
  getDailyWird, checkGuess, buildKeyMap, buildClues, buildShareText,
  loadDailyState, saveDailyState, recordResult, loadStats, calcScore,
  isValidGuess, todayKey, maxTries, BASE_TRIES,
  loadWirdPool, MIN_LEN, MAX_LEN,
  type DailyWird, type GuessRow, type LetterState, type ClueLevel,
  type DailyStats, type GdwClue, type WirdCandidate,
} from '@/lib/guess-da-wird';

const S = { ...SECTIONS.games, color: GAME_COLORS.guess_da_wird, light: GAME_LIGHTS.guess_da_wird };

// ── Colour constants ──────────────────────────────────────────────────────────
const ANCHORED   = '#12B3D6';   // OneShetland sea blue
const DRIFTING   = '#D97706';   // amber — distinct from Wordle yellow
const AWAY_BG    = '#475569';   // slate for tiles
const AWAY_LIGHT = '#F1F5F9';   // slate-50 for bars

// ── State machine ─────────────────────────────────────────────────────────────
type Phase = 'loading' | 'playing' | 'won' | 'lost' | 'error';

interface GdwState {
  phase:      Phase;
  wird:       DailyWird | null;
  guesses:    GuessRow[];
  current:    string;
  cluesShown: ClueLevel;
  stats:      DailyStats | null;
  errorMsg:   string | null;
  validating: boolean;
}

type GdwAction =
  | { type: 'LOADED'; wird: DailyWird; guesses: GuessRow[]; won: boolean; lost: boolean; cluesShown: ClueLevel; stats: DailyStats | null }
  | { type: 'TYPE'; letter: string }
  | { type: 'DELETE' }
  | { type: 'VALIDATING'; on: boolean }
  | { type: 'SUBMIT'; row: GuessRow; won: boolean; lost: boolean }
  | { type: 'SHOW_CLUE'; level: ClueLevel }
  | { type: 'ERROR'; msg: string }
  | { type: 'STATS'; stats: DailyStats };

function reducer(s: GdwState, a: GdwAction): GdwState {
  switch (a.type) {
    case 'LOADED':
      return { ...s, phase: a.won ? 'won' : a.lost ? 'lost' : 'playing', wird: a.wird, guesses: a.guesses, cluesShown: a.cluesShown, stats: a.stats };
    case 'TYPE':
      if (s.phase !== 'playing' || !s.wird || s.current.length >= s.wird.word.length) return s;
      return { ...s, current: s.current + a.letter };
    case 'DELETE':
      return { ...s, current: s.current.slice(0, -1) };
    case 'VALIDATING':
      return { ...s, validating: a.on };
    case 'SUBMIT':
      return { ...s, guesses: [...s.guesses, a.row], current: '', phase: a.won ? 'won' : a.lost ? 'lost' : 'playing', validating: false };
    case 'SHOW_CLUE':
      return { ...s, cluesShown: a.level };
    case 'ERROR':
      return { ...s, phase: 'error', errorMsg: a.msg };
    case 'STATS':
      return { ...s, stats: a.stats };
    default:
      return s;
  }
}

const INIT: GdwState = { phase: 'loading', wird: null, guesses: [], current: '', cluesShown: 0, stats: null, errorMsg: null, validating: false };

// ── Main screen ───────────────────────────────────────────────────────────────
export default function GuessDaWird() {
  const router     = useRouter();
  const { profile }  = useAuth();
  const { alert }    = useAlert();
  const userId       = profile?.id ?? 'anon';

  const [state, dispatch] = useReducer(reducer, INIT);
  const [stuckOpen, setStuckOpen] = useState(false);
  const shakeAnim         = useRef(new Animated.Value(0)).current;
  const startTime         = useRef<number | null>(null);

  // ── Boot ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const dateKey = todayKey();
        const [wird, savedState, stats] = await Promise.all([
          getDailyWird(dateKey),
          loadDailyState(userId),
          loadStats(userId),
        ]);
        if (cancelled) return;

        if (savedState) {
          const guesses: GuessRow[] = savedState.guesses.map(g => ({
            word: g, letters: checkGuess(g, wird.word),
          }));
          dispatch({ type: 'LOADED', wird, guesses, won: savedState.won, lost: savedState.lost, cluesShown: savedState.cluesShown, stats });
        } else {
          startTime.current = Date.now();
          dispatch({ type: 'LOADED', wird, guesses: [], won: false, lost: false, cluesShown: 0, stats });
        }
      } catch (e: any) {
        if (!cancelled) dispatch({ type: 'ERROR', msg: e?.message ?? 'Could not load today\'s wird.' });
      }
    })();
    return () => { cancelled = true; };
  }, [userId]);

  // ── Shake animation ───────────────────────────────────────────────────────
  const triggerShake = useCallback((msg?: string) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 7,  duration: 55, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -7, duration: 55, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 5,  duration: 55, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -5, duration: 55, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0,  duration: 55, useNativeDriver: true }),
    ]).start();
    if (msg) {
      alert({ title: msg, message: '', icon: 'exclamation-circle', accent: DRIFTING, actions: [{ label: 'OK', style: 'primary' }] });
    }
  }, [shakeAnim, alert]);

  // ── Keyboard handlers ─────────────────────────────────────────────────────
  const pressLetter = useCallback((letter: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    dispatch({ type: 'TYPE', letter });
  }, []);

  const pressDelete = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    dispatch({ type: 'DELETE' });
  }, []);

  const pressEnter = useCallback(async () => {
    const { wird, guesses, current, phase, cluesShown, validating } = state;
    if (!wird || phase !== 'playing' || validating) return;

    const maxT = maxTries(wird.word);

    if (current.length < wird.word.length) {
      triggerShake();
      return;
    }

    // Validate against Shetland word pool
    dispatch({ type: 'VALIDATING', on: true });
    const valid = await isValidGuess(current, wird.word.length);
    if (!valid) {
      triggerShake('That\'s not in da wird list yet.\nTry another wird.');
      dispatch({ type: 'VALIDATING', on: false });
      return;
    }

    const letters  = checkGuess(current, wird.word);
    const won      = letters.every(l => l.state === 'anchored');
    const newCount = guesses.length + 1;
    const lost     = !won && newCount >= maxT;
    const row: GuessRow = { word: current, letters };

    dispatch({ type: 'SUBMIT', row, won, lost });
    Haptics.notificationAsync(won
      ? Haptics.NotificationFeedbackType.Success
      : Haptics.NotificationFeedbackType.Warning
    );

    // Persist state
    const allGuesses = [...guesses.map(g => g.word), current];
    const dateKey = todayKey();
    await saveDailyState(userId, { dateKey, guesses: allGuesses, won, lost, cluesShown });

    if (won || lost) {
      const solveSeconds = startTime.current
        ? Math.round((Date.now() - startTime.current) / 1000)
        : undefined;
      const updated = await recordResult(userId, dateKey, newCount, won, cluesShown, solveSeconds);
      dispatch({ type: 'STATS', stats: updated });

      if (profile) {
        const score = calcScore(newCount, maxT, cluesShown, won, wird.difficulty);
        submitScore(profile.id, 'guess_da_wird', score, {
          metadata: { date: dateKey, tries: newCount, won, cluesUsed: cluesShown, difficulty: wird.difficulty },
          xpEarned: score,
        }).catch(() => {});
      }
    }
  }, [state, userId, profile, triggerShake]);

  const showNextClue = useCallback(() => {
    const next = Math.min((state.cluesShown + 1), 5) as ClueLevel;
    dispatch({ type: 'SHOW_CLUE', level: next });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    if (state.wird) {
      saveDailyState(userId, {
        dateKey:    todayKey(),
        guesses:    state.guesses.map(g => g.word),
        won:        state.phase === 'won',
        lost:       state.phase === 'lost',
        cluesShown: next,
      });
    }
  }, [state, userId]);

  const handleShare = useCallback(async () => {
    const { wird, guesses, phase, cluesShown, stats } = state;
    if (!wird || !stats) return;
    const text = buildShareText(todayKey(), guesses, phase === 'won', cluesShown, stats);
    await Share.share({ message: text });
  }, [state]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const keyMap   = useMemo(() => buildKeyMap(state.guesses),               [state.guesses]);
  const clues    = useMemo(() => state.wird ? buildClues(state.wird) : [], [state.wird]);
  const maxT     = state.wird ? maxTries(state.wird.word) : BASE_TRIES;
  const wordLen  = state.wird?.word.length ?? 5;
  const gameOver = state.phase === 'won' || state.phase === 'lost';

  // ── Loading / error ───────────────────────────────────────────────────────
  if (state.phase === 'loading') {
    return (
      <SafeAreaView style={styles.outer} edges={['top']}>
        <Header onBack={() => router.back()} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={ANCHORED} />
          <Text style={styles.loadingText}>Fetching today's wird…</Text>
        </View>
      </SafeAreaView>
    );
  }
  if (state.phase === 'error') {
    return (
      <SafeAreaView style={styles.outer} edges={['top']}>
        <Header onBack={() => router.back()} />
        <View style={styles.center}>
          <View style={[styles.iconCircle, { backgroundColor: '#FEE2E2' }]}>
            <FontAwesome5 name="exclamation-circle" size={28} color={colors.error} />
          </View>
          <Text style={styles.errorTitle}>We couldna reach the game</Text>
          <Text style={styles.errorSub}>{state.errorMsg}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const { wird, guesses, current, phase, cluesShown, stats } = state;

  return (
    // Outer View fills the whole screen — no SafeAreaView flex complications
    <View style={styles.outer}>

      {/* Top safe area + header */}
      <SafeAreaView edges={['top']} style={{ backgroundColor: colors.navy }}>
        <Header onBack={() => router.back()} />
      </SafeAreaView>

      {/* Scrollable game content */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {stats && <StatsRibbon stats={stats} maxT={maxT} />}

        {guesses.length === 0 && !gameOver && (
          <View style={styles.intro}>
            <GameArt id="guess_da_wird" size={96} radius={24} />
            <View style={{ height: 14 }} />
            <Text style={styles.introTitle}>Guess da Wird</Text>
            <Text style={styles.introSub}>Can you work oot today's Shetland wird?</Text>
            <View style={styles.introPills}>
              <View style={styles.introPill}>
                <FontAwesome5 name="font" size={9} color={ANCHORED} />
                <Text style={styles.introPillText}>{wordLen} letters</Text>
              </View>
              <View style={styles.introPill}>
                <FontAwesome5 name="redo" size={9} color={ANCHORED} />
                <Text style={styles.introPillText}>{maxT} tries</Text>
              </View>
              {wird?.difficulty === 3 && (
                <View style={[styles.introPill, { backgroundColor: DRIFTING + '20', borderColor: DRIFTING + '40' }]}>
                  <FontAwesome5 name="fire" size={9} color={DRIFTING} />
                  <Text style={[styles.introPillText, { color: DRIFTING }]}>Tricky one today</Text>
                </View>
              )}
            </View>
          </View>
        )}

        <Animated.View style={[styles.board, { transform: [{ translateX: shakeAnim }] }]}>
          {guesses.map((row, ri) => <GuessRowView key={ri} row={row} />)}
          {!gameOver && <ActiveRow current={current} wordLen={wordLen} validating={state.validating} />}
          {!gameOver && Array.from({ length: Math.max(0, maxT - guesses.length - 1) }).map((_, i) => (
            <EmptyRow key={i} wordLen={wordLen} />
          ))}
        </Animated.View>

        {gameOver && wird && (
          <ResultBanner
            wird={wird}
            won={phase === 'won'}
            guesses={guesses}
            cluesShown={cluesShown}
            stats={stats}
            onShare={handleShare}
            onSpik={() => router.push({ pathname: '/spik-detail', params: { id: String(wird.id) } })}
          />
        )}

        {!gameOver && (
          <CluePanel
            clues={clues}
            shownLevel={cluesShown}
            onShowNext={showNextClue}
            triesLeft={maxT - guesses.length}
          />
        )}
      </ScrollView>

      {/* Stuck? — opens a browser of valid-length Spik words for discovery. */}
      {!gameOver && (
        <View style={styles.stuckRow}>
          <TouchableOpacity
            style={styles.stuckBtn}
            onPress={() => { Haptics.selectionAsync(); setStuckOpen(true); }}
            activeOpacity={0.7}
            accessibilityLabel="Browse Spik words for help"
          >
            <FontAwesome5 name="book-open" size={10} color={ANCHORED} />
            <Text style={styles.stuckBtnText}>Stuck?</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Keyboard sits here — a plain sibling of ScrollView, never inside flex competition */}
      {!gameOver && (
        <KeyboardView
          keyMap={keyMap}
          onLetter={pressLetter}
          onDelete={pressDelete}
          onEnter={pressEnter}
          wordLen={wordLen}
          currentLen={current.length}
          disabled={state.validating}
        />
      )}

      {/* Bottom safe area fills under the keyboard on iPhone */}
      <SafeAreaView edges={['bottom']} style={{ backgroundColor: '#F8FAFC' }} />

      <StuckBrowser
        visible={stuckOpen}
        defaultLen={wordLen}
        onClose={() => setStuckOpen(false)}
      />

    </View>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Header({ onBack }: { onBack: () => void }) {
  return (
    <View style={styles.header}>
      <TouchableOpacity style={styles.backBtn} onPress={onBack} hitSlop={12}>
        <FontAwesome5 name="chevron-left" size={14} color={S.color} />
        <Text style={[styles.backText, { color: S.color }]}>Back</Text>
      </TouchableOpacity>
      <Text style={styles.headerTitle}>Guess Da Wird</Text>
      <View style={{ width: 70 }} />
    </View>
  );
}

function GuessRowView({ row }: { row: GuessRow }) {
  return (
    <View style={styles.row}>
      {row.letters.map((l, i) => (
        <LetterTile key={i} letter={l.letter.toUpperCase()} state={l.state} />
      ))}
    </View>
  );
}

function ActiveRow({ current, wordLen, validating }: { current: string; wordLen: number; validating: boolean }) {
  return (
    <View style={styles.row}>
      {Array.from({ length: wordLen }).map((_, i) => (
        <LetterTile
          key={i}
          letter={(current[i] ?? '').toUpperCase()}
          state="empty"
          active={!!current[i]}
          pulse={validating && !!current[i]}
        />
      ))}
    </View>
  );
}

function EmptyRow({ wordLen }: { wordLen: number }) {
  return (
    <View style={styles.row}>
      {Array.from({ length: wordLen }).map((_, i) => (
        <LetterTile key={i} letter="" state="empty" />
      ))}
    </View>
  );
}

function LetterTile({ letter, state, active, pulse }: {
  letter: string; state: LetterState; active?: boolean; pulse?: boolean;
}) {
  const bg =
    state === 'anchored' ? ANCHORED :
    state === 'drifting' ? DRIFTING :
    state === 'away'     ? AWAY_BG  : '#fff';
  const fg =
    state === 'empty' ? colors.textPrimary : '#fff';
  const borderColor =
    state !== 'empty'  ? 'transparent' :
    active             ? colors.navy    : colors.border;

  return (
    <View style={[
      styles.tile,
      { backgroundColor: bg, borderColor },
      pulse && { opacity: 0.6 },
    ]}>
      <Text style={[styles.tileLetter, { color: fg }]}>{letter}</Text>
    </View>
  );
}

function KeyboardView({ keyMap, onLetter, onDelete, onEnter, wordLen, currentLen, disabled }: {
  keyMap: Record<string, LetterState>;
  onLetter:    (l: string) => void;
  onDelete:    () => void;
  onEnter:     () => void;
  wordLen:     number;
  currentLen:  number;
  disabled: boolean;
}) {
  const ROWS = [
    ['Q','W','E','R','T','Y','U','I','O','P'],
    ['A','S','D','F','G','H','J','K','L'],
    ['ENTER','Z','X','C','V','B','N','M','⌫'],
  ];

  return (
    <View style={styles.keyboard}>
      {ROWS.map((row, ri) => (
        <View key={ri} style={styles.keyRow}>
          {row.map(key => {
            const isAction = key === 'ENTER' || key === '⌫';
            const lc = key.toLowerCase();
            const ks = keyMap[lc];
            const bg =
              ks === 'anchored' ? ANCHORED :
              ks === 'drifting' ? DRIFTING :
              ks === 'away'     ? AWAY_BG  : '#E2E8F0';
            const fg = ks ? '#fff' : colors.textPrimary;
            const enterDisabled = key === 'ENTER' && (currentLen < wordLen || disabled);

            return (
              <TouchableOpacity
                key={key}
                style={[
                  styles.key,
                  isAction && styles.keyAction,
                  !isAction && { backgroundColor: bg },
                  isAction && { backgroundColor: key === 'ENTER' ? colors.navy : '#94A3B8' },
                  (enterDisabled || (disabled && !isAction)) && { opacity: 0.45 },
                ]}
                onPress={() => {
                  if (key === 'ENTER')  onEnter();
                  else if (key === '⌫') onDelete();
                  else                   onLetter(lc);
                }}
                disabled={enterDisabled}
                activeOpacity={0.7}
                accessibilityLabel={key === '⌫' ? 'Delete' : key === 'ENTER' ? 'Submit guess' : key}
              >
                <Text style={[
                  styles.keyLabel,
                  !isAction && { color: fg },
                  isAction && { color: '#fff', fontSize: 10, fontWeight: '900' },
                ]}>
                  {key}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function CluePanel({ clues, shownLevel, onShowNext, triesLeft }: {
  clues:       GdwClue[];
  shownLevel:  ClueLevel;
  onShowNext:  () => void;
  triesLeft:   number;
}) {
  const revealed = clues.filter(c => c.level <= shownLevel);
  const next     = clues.find(c => c.level === (shownLevel + 1) as ClueLevel);

  return (
    <View style={styles.cluePanel}>
      <View style={styles.cluePanelHeader}>
        <FontAwesome5 name="binoculars" size={12} color={DRIFTING} />
        <Text style={styles.cluePanelTitle}>Clues</Text>
        {shownLevel > 0 && (
          <View style={styles.clueCountPill}>
            <Text style={styles.clueCountText}>{shownLevel} used</Text>
          </View>
        )}
      </View>

      {revealed.map(c => (
        <View key={c.level} style={styles.clueItem}>
          <View style={styles.clueItemHeader}>
            <FontAwesome5 name={c.icon as any} size={9} color={DRIFTING} />
            <Text style={styles.clueNum}>Clue {c.level}</Text>
          </View>
          <Text style={styles.clueContent}>{c.content}</Text>
        </View>
      ))}

      {next && shownLevel < 5 && (
        <TouchableOpacity style={styles.clueBtn} onPress={onShowNext} activeOpacity={0.85}>
          <FontAwesome5 name={next.icon as any} size={11} color={DRIFTING} />
          <Text style={[styles.clueBtnText, { color: DRIFTING }]}>
            {shownLevel === 0 ? 'Need a peerie clue?' : next.label}
          </Text>
        </TouchableOpacity>
      )}

      {triesLeft <= 2 && shownLevel < 5 && next && (
        <Text style={styles.stuckHint}>Running low on tries — clues dinna count against you.</Text>
      )}
    </View>
  );
}

function ResultBanner({ wird, won, guesses, cluesShown, stats, onShare, onSpik }: {
  wird:       DailyWird;
  won:        boolean;
  guesses:    GuessRow[];
  cluesShown: ClueLevel;
  stats:      DailyStats | null;
  onShare:    () => void;
  onSpik:     () => void;
}) {
  const headline = won
    ? (guesses.length === 1 ? 'Unbelievable! First try!'
      : guesses.length <= 2 ? 'Brilliant — you got it!'
      : guesses.length <= 4 ? 'You got it!'
      : 'Weel done — you got it!')
    : 'Kept its secret the day.';
  const sub = won
    ? `"${wird.word}" found in ${guesses.length} tr${guesses.length === 1 ? 'y' : 'ies'}.`
    : `Today's wird was "${wird.word}".`;

  return (
    <View style={styles.resultCard}>
      <Text style={[styles.resultHeadline, { color: won ? ANCHORED : colors.textPrimary }]}>
        {headline}
      </Text>
      <Text style={styles.resultSub}>{sub}</Text>

      {won && stats && stats.currentStreak > 1 && (
        <View style={styles.streakRow}>
          <FontAwesome5 name="fire" size={12} color={DRIFTING} solid />
          <Text style={[styles.streakText, { color: DRIFTING }]}>
            {stats.currentStreak} day streak!
          </Text>
        </View>
      )}

      <View style={styles.resultDivider} />

      <Text style={styles.resultMeaningLabel}>Meaning</Text>
      <Text style={styles.resultMeaning}>{wird.meaning}</Text>
      {wird.full_meaning && wird.full_meaning !== wird.meaning && (
        <Text style={styles.resultFullMeaning}>{wird.full_meaning}</Text>
      )}
      <View style={styles.resultMetaRow}>
        {wird.part_of_speech && (
          <View style={[styles.metaPill, { backgroundColor: ANCHORED + '20' }]}>
            <Text style={[styles.metaPillText, { color: ANCHORED }]}>{wird.part_of_speech}</Text>
          </View>
        )}
        {wird.category && (
          <View style={[styles.metaPill, { backgroundColor: colors.border }]}>
            <Text style={styles.metaPillText}>{wird.category}</Text>
          </View>
        )}
        {wird.usage_level && (
          <View style={[styles.metaPill, { backgroundColor: colors.border }]}>
            <Text style={styles.metaPillText}>{wird.usage_level}</Text>
          </View>
        )}
      </View>
      {wird.example_sentence && (
        <Text style={styles.resultExample}>"{wird.example_sentence}"</Text>
      )}
      {wird.pronunciation && (
        <View style={styles.pronRow}>
          <FontAwesome5 name="volume-up" size={10} color={colors.textMuted} />
          <Text style={styles.pronText}>{wird.pronunciation}</Text>
        </View>
      )}

      <View style={styles.resultActions}>
        <TouchableOpacity style={[styles.resultBtn, { backgroundColor: ANCHORED }]} onPress={onShare} activeOpacity={0.85}>
          <FontAwesome5 name="share-alt" size={12} color="#fff" />
          <Text style={styles.resultBtnText}>Share</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.resultBtn, { backgroundColor: colors.navy }]} onPress={onSpik} activeOpacity={0.85}>
          <FontAwesome5 name="book-open" size={12} color="#fff" />
          <Text style={styles.resultBtnText}>See in Spik</Text>
        </TouchableOpacity>
      </View>

      {!won && (
        <Text style={styles.encouragement}>
          No luck the day — but you've learned a new Shetland wird. Come back the morn!
        </Text>
      )}
    </View>
  );
}

function StatsRibbon({ stats, maxT }: { stats: DailyStats; maxT: number }) {
  const [expanded, setExpanded] = useState(false);
  const winRate = stats.played > 0 ? Math.round((stats.won / stats.played) * 100) : 0;
  const avgTries = stats.played > 0
    ? (stats.distribution.reduce((sum, c, i) => sum + c * (i + 1), 0) / Math.max(1, stats.won)).toFixed(1)
    : '—';

  return (
    <TouchableOpacity
      style={styles.statsRibbon}
      onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setExpanded(e => !e); }}
      activeOpacity={0.9}
      accessibilityLabel={expanded ? 'Collapse stats' : 'Expand stats'}
    >
      <View style={styles.statsRow}>
        <StatCell label="Played"  value={String(stats.played)} />
        <StatCell label="Streak"  value={String(stats.currentStreak)} />
        <StatCell label="Best"    value={String(stats.bestStreak)} />
        <StatCell label="Win %"   value={`${winRate}%`} />
        <StatCell label="Avg tries" value={String(avgTries)} />
        <FontAwesome5
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={10} color={colors.textMuted}
          style={{ marginLeft: 4 }}
        />
      </View>

      {expanded && (
        <View style={styles.statsExpanded}>
          <View style={styles.statsExpandedRow}>
            <StatCell label="Won"        value={String(stats.won)} />
            <StatCell label="Clues used" value={String(stats.cluesUsed)} />
            {stats.fastestSolve !== null && (
              <StatCell label="Fastest" value={`${stats.fastestSolve}s`} />
            )}
          </View>

          <Text style={styles.distLabel}>Tries distribution</Text>
          {stats.distribution.slice(0, maxT).map((count, i) => {
            const pct = stats.won > 0 ? count / stats.won : 0;
            return (
              <View key={i} style={styles.distRow}>
                <Text style={styles.distNum}>{i + 1}</Text>
                <View style={styles.distBarWrap}>
                  <View style={[styles.distBar, { flex: Math.max(0.04, pct), backgroundColor: ANCHORED }]} />
                  <View style={{ flex: Math.max(0, 1 - pct) }} />
                </View>
                <Text style={styles.distCount}>{count}</Text>
              </View>
            );
          })}

          {stats.played === 0 && (
            <Text style={styles.statsEmpty}>Play today's wird to start your stats.</Text>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statCell}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// ── Stuck? browser ────────────────────────────────────────────────────────────
//
// Bottom-sheet modal that lets a stuck player browse valid-length Spik words.
// Source: loadWirdPool() — the curated set that already has meanings attached,
// so cards can show "word · pos · short meaning" without extra fetches.
// Deliberate UX choice: tapping a card does NOT autofill. Reading + typing
// keeps the spelling-recall part of the game intact and aids learning.

function StuckBrowser({
  visible, defaultLen, onClose,
}: {
  visible:    boolean;
  defaultLen: number;
  onClose:    () => void;
}) {
  const [allWords, setAllWords] = useState<WirdCandidate[] | null>(null);
  const [search,   setSearch]   = useState('');
  const [lenFilter, setLenFilter] = useState<number>(defaultLen);

  // Load the curated pool once on first open. Reset filter to today's wordLen
  // every time the sheet opens (so reopening clears any earlier length tweak).
  useEffect(() => {
    if (!visible) return;
    setLenFilter(defaultLen);
    setSearch('');
    if (allWords) return;
    let cancelled = false;
    loadWirdPool()
      .then(p => { if (!cancelled) setAllWords(p); })
      .catch(() => { if (!cancelled) setAllWords([]); });
    return () => { cancelled = true; };
  }, [visible, defaultLen]);

  const filtered = useMemo(() => {
    if (!allWords) return [];
    const s = search.trim().toLowerCase();
    return allWords
      .filter(w => w.word.length === lenFilter)
      .filter(w => !s || w.word.startsWith(s))
      .sort((a, b) => a.word.localeCompare(b.word));
  }, [allWords, search, lenFilter]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={browserStyles.overlay}>
        <View style={browserStyles.sheet}>
          <View style={browserStyles.handle} />

          <View style={browserStyles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={browserStyles.title}>Stuck?</Text>
              <Text style={browserStyles.subtitle}>Browse Shetland words to spark an idea — you still need to type your guess.</Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={16} accessibilityLabel="Close">
              <FontAwesome5 name="times" size={16} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <TextInput
            style={browserStyles.search}
            value={search}
            onChangeText={setSearch}
            placeholder={`Search ${lenFilter}-letter words…`}
            placeholderTextColor={colors.textLight}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <View style={browserStyles.chipsRow}>
            <Text style={browserStyles.chipsLabel}>Length</Text>
            {Array.from({ length: MAX_LEN - MIN_LEN + 1 }, (_, i) => MIN_LEN + i).map(n => {
              const selected = n === lenFilter;
              const isToday  = n === defaultLen;
              return (
                <TouchableOpacity
                  key={n}
                  style={[browserStyles.chip, selected && browserStyles.chipSelected]}
                  onPress={() => { Haptics.selectionAsync(); setLenFilter(n); }}
                  activeOpacity={0.7}
                >
                  <Text style={[browserStyles.chipText, selected && browserStyles.chipTextSelected]}>
                    {n}{isToday ? '★' : ''}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {allWords === null ? (
            <View style={browserStyles.loading}>
              <ActivityIndicator color={ANCHORED} />
            </View>
          ) : filtered.length === 0 ? (
            <View style={browserStyles.empty}>
              <Text style={browserStyles.emptyText}>
                {search ? 'No matches.' : 'No words at this length.'}
              </Text>
            </View>
          ) : (
            <FlatList
              data={filtered}
              keyExtractor={w => String(w.id)}
              showsVerticalScrollIndicator
              initialNumToRender={20}
              windowSize={9}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => <BrowserCard w={item} />}
              ItemSeparatorComponent={() => <View style={browserStyles.cardSep} />}
              contentContainerStyle={{ paddingBottom: 24 }}
            />
          )}

          <Text style={browserStyles.count}>
            {allWords === null ? '…' : `${filtered.length} word${filtered.length === 1 ? '' : 's'}`}
          </Text>
        </View>
      </View>
    </Modal>
  );
}

function BrowserCard({ w }: { w: WirdCandidate }) {
  const meaning = w.short_meaning ?? w.spik_meaning;
  return (
    <View style={browserStyles.card}>
      <Text style={browserStyles.cardWord}>{w.word}</Text>
      {(w.part_of_speech || meaning) && (
        <Text style={browserStyles.cardMeaning} numberOfLines={2}>
          {w.part_of_speech ? <Text style={browserStyles.cardPos}>{w.part_of_speech} · </Text> : null}
          {meaning ?? '—'}
        </Text>
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const TILE_SIZE = 46;

const styles = StyleSheet.create({
  // Outer fills the screen; SafeAreaView is only used for top/bottom insets
  outer:  { flex: 1, backgroundColor: colors.screenBackground },
  scroll:  { flex: 1, backgroundColor: colors.screenBackground },
  content:{ paddingHorizontal: spacing.md, paddingBottom: 12, gap: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, padding: spacing.xl },

  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
    borderBottomWidth: 2, borderBottomColor: S.color,
  },
  backBtn:     { flexDirection: 'row', alignItems: 'center', gap: 8, width: 70 },
  backText:    { fontSize: fontSize.sm, fontWeight: '700', color: '#fff' },
  headerTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '900', flex: 1, textAlign: 'center' },

  iconCircle: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  loadingText:{ color: colors.textMuted, fontSize: fontSize.sm, marginTop: 8 },
  errorTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary, textAlign: 'center' },
  errorSub:   { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },

  // Intro
  intro:          { alignItems: 'center', gap: 6, paddingTop: 6 },
  introTitle:     { fontSize: 22, fontWeight: '900', color: colors.textPrimary },
  introSub:       { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },
  introPills:     { flexDirection: 'row', gap: 8, marginTop: 4 },
  introPill:      { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.full, backgroundColor: ANCHORED + '15', borderWidth: 1, borderColor: ANCHORED + '30' },
  introPillText:  { fontSize: 11, fontWeight: '800', color: ANCHORED },

  // Board
  board: { alignItems: 'center', gap: 6, marginVertical: 4 },
  row:   { flexDirection: 'row', gap: 5 },
  tile:  { width: TILE_SIZE, height: TILE_SIZE, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
  tileLetter: { fontSize: 21, fontWeight: '900', letterSpacing: -0.5 },

  keyboard: {
    backgroundColor: '#DDE4EC',
    paddingHorizontal: 4,
    paddingTop: 8,
    paddingBottom: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  keyRow: { flexDirection: 'row', justifyContent: 'center', gap: 4, marginBottom: 6 },
  key:       { height: 46, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', flex: 1, maxWidth: 36 },
  keyAction: { flex: 1.6, maxWidth: 58 },
  keyLabel:  { fontSize: 14, fontWeight: '800' },

  // Clue panel
  cluePanel:       { backgroundColor: '#fff', borderRadius: radius.lg, padding: spacing.md, borderWidth: 1, borderColor: colors.border, gap: 10 },
  cluePanelHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cluePanelTitle:  { fontSize: fontSize.sm, fontWeight: '900', color: colors.textPrimary, flex: 1 },
  clueCountPill:   { backgroundColor: DRIFTING + '20', paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full },
  clueCountText:   { fontSize: 10, fontWeight: '800', color: DRIFTING },
  clueItem:        { gap: 5, paddingLeft: 10, borderLeftWidth: 3, borderLeftColor: DRIFTING },
  clueItemHeader:  { flexDirection: 'row', alignItems: 'center', gap: 6 },
  clueNum:         { fontSize: 10, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.8 },
  clueContent:     { fontSize: fontSize.sm, color: colors.textPrimary, lineHeight: 20 },
  clueBtn:         { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 10, borderRadius: radius.md, backgroundColor: DRIFTING + '12', borderWidth: 1, borderColor: DRIFTING + '35' },
  clueBtnText:     { fontSize: fontSize.sm, fontWeight: '800' },
  stuckHint:       { fontSize: 11, color: colors.textMuted, textAlign: 'center', fontStyle: 'italic' },

  // Result card
  resultCard:         { backgroundColor: '#fff', borderRadius: radius.xl, padding: spacing.lg, borderWidth: 1, borderColor: colors.border, gap: 8 },
  resultHeadline:     { fontSize: 20, fontWeight: '900' },
  resultSub:          { fontSize: fontSize.sm, color: colors.textMuted, fontWeight: '600' },
  streakRow:          { flexDirection: 'row', alignItems: 'center', gap: 6 },
  streakText:         { fontSize: fontSize.sm, fontWeight: '800' },
  resultDivider:      { height: 1, backgroundColor: colors.border, marginVertical: 4 },
  resultMeaningLabel: { fontSize: 10, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 },
  resultMeaning:      { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, lineHeight: 22 },
  resultFullMeaning:  { fontSize: fontSize.sm, color: colors.textMuted, lineHeight: 20, marginTop: 2 },
  resultMetaRow:      { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  metaPill:           { paddingHorizontal: 9, paddingVertical: 4, borderRadius: radius.full },
  metaPillText:       { fontSize: 11, fontWeight: '700', color: colors.textMuted },
  resultExample:      { fontSize: fontSize.sm, color: colors.textPrimary, fontStyle: 'italic', lineHeight: 20, marginTop: 4 },
  pronRow:            { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  pronText:           { fontSize: 12, color: colors.textMuted, fontStyle: 'italic' },
  resultActions:      { flexDirection: 'row', gap: 10, marginTop: 8 },
  resultBtn:          { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, borderRadius: radius.md },
  resultBtnText:      { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
  encouragement:      { fontSize: fontSize.xs, color: colors.textMuted, textAlign: 'center', lineHeight: 18, fontStyle: 'italic', marginTop: 4 },

  // Stats ribbon
  statsRibbon:     { backgroundColor: '#fff', borderRadius: radius.lg, padding: spacing.sm, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.border, marginTop: 8 },
  statsRow:        { flexDirection: 'row', alignItems: 'center', gap: 2 },
  statsExpanded:   { marginTop: 12, gap: 10 },
  statsExpandedRow:{ flexDirection: 'row', gap: 4 },
  statCell:        { flex: 1, alignItems: 'center', gap: 2 },
  statValue:       { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary },
  statLabel:       { fontSize: 9, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.4, textAlign: 'center' },
  statsEmpty:      { fontSize: fontSize.xs, color: colors.textMuted, textAlign: 'center', fontStyle: 'italic' },

  distLabel:   { fontSize: 11, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  distRow:     { flexDirection: 'row', alignItems: 'center', gap: 8 },
  distNum:     { width: 14, fontSize: 11, fontWeight: '800', color: colors.textMuted, textAlign: 'right' },
  distBarWrap: { flex: 1, flexDirection: 'row', height: 18, borderRadius: 4, overflow: 'hidden', backgroundColor: AWAY_LIGHT },
  distBar:     { borderRadius: 4, height: 18 },
  distCount:   { width: 20, fontSize: 11, fontWeight: '800', color: colors.textPrimary, textAlign: 'right' },

  // Stuck? button — sits between board and keyboard
  stuckRow: {
    flexDirection: 'row', justifyContent: 'center',
    paddingHorizontal: spacing.md, paddingVertical: 6,
    backgroundColor: '#F8FAFC',
  },
  stuckBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: radius.full,
    borderWidth: 1, borderColor: ANCHORED + '40',
    backgroundColor: ANCHORED + '10',
  },
  stuckBtnText: { color: ANCHORED, fontSize: 12, fontWeight: '800', letterSpacing: 0.3 },
});

// ── Stuck? browser styles ─────────────────────────────────────────────────────

const browserStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet:   {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: spacing.lg, paddingBottom: 40,
    maxHeight: '85%',
    gap: 12,
  },
  handle:  { width: 36, height: 4, backgroundColor: colors.border, borderRadius: 2, alignSelf: 'center', marginBottom: 4 },

  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  title:     { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary },
  subtitle:  { fontSize: 12, color: colors.textMuted, lineHeight: 17, marginTop: 2 },

  search: {
    backgroundColor: '#F8FAFC',
    borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, paddingVertical: 10,
    fontSize: fontSize.sm, color: colors.textPrimary,
  },

  chipsRow:    { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  chipsLabel:  { fontSize: 11, color: colors.textMuted, fontWeight: '700', marginRight: 4, letterSpacing: 0.5 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: radius.full,
    borderWidth: 1.5, borderColor: colors.border, backgroundColor: '#fff',
  },
  chipSelected: { backgroundColor: ANCHORED, borderColor: ANCHORED },
  chipText:     { fontSize: 12, fontWeight: '800', color: colors.textPrimary },
  chipTextSelected: { color: '#fff' },

  loading: { paddingVertical: 40, alignItems: 'center' },
  empty:   { paddingVertical: 40, alignItems: 'center' },
  emptyText: { color: colors.textMuted, fontSize: fontSize.sm },

  card:        { paddingVertical: 10, paddingHorizontal: 4 },
  cardWord:    { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary, letterSpacing: 0.5 },
  cardPos:     { fontSize: 11, color: colors.textMuted, fontWeight: '700', textTransform: 'lowercase' },
  cardMeaning: { fontSize: 12, color: colors.textPrimary, lineHeight: 17, marginTop: 2 },
  cardSep:     { height: 1, backgroundColor: colors.border },

  count:    { fontSize: 11, color: colors.textLight, textAlign: 'center', marginTop: 4 },
});
