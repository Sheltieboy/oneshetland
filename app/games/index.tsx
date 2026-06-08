/**
 * app/games.tsx — OneShetland Games Centre
 *
 * Hub for all dialect games. Shows user stats, available games, leaderboards.
 * Open to non-signed-in users (they can browse + see leaderboards, but need
 * to sign in to play and have scores saved).
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useFocusEffect } from 'expo-router';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import {
  GAMES, fetchUserStats, fetchTopScores, fetchMyBestScore,
  levelTitle, xpForLevel,
  type GameId, type UserGameStats, type LeaderboardRow,
} from '@/lib/games-api';

const S = SECTIONS.games;

export default function GamesCentre() {
  const router = useRouter();
  const { profile } = useAuth();

  const [stats, setStats]         = useState<UserGameStats | null>(null);
  const [bestSprint, setBestSprint] = useState<number>(0);
  const [bestSnap,   setBestSnap]   = useState<number>(0);
  const [bestWird,   setBestWird]   = useState<number>(0);
  const [bestMapIt,  setBestMapIt]  = useState<number>(0);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);
  const [leaderboardGame, setLeaderboardGame] = useState<GameId>('spik_sprint');
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, sprint, snap, wird, mapit, lb] = await Promise.all([
        profile ? fetchUserStats(profile.id).catch(() => null)                    : Promise.resolve(null),
        profile ? fetchMyBestScore(profile.id, 'spik_sprint').catch(() => 0)     : Promise.resolve(0),
        profile ? fetchMyBestScore(profile.id, 'spik_snap').catch(() => 0)       : Promise.resolve(0),
        profile ? fetchMyBestScore(profile.id, 'guess_da_wird').catch(() => 0)   : Promise.resolve(0),
        profile ? fetchMyBestScore(profile.id, 'map_it').catch(() => 0)          : Promise.resolve(0),
        fetchTopScores(leaderboardGame, 'all', 10).catch(() => []),
      ]);
      setStats(s);
      setBestSprint(sprint);
      setBestSnap(snap);
      setBestWird(wird);
      setBestMapIt(mapit);
      setLeaderboard(lb);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [profile?.id, leaderboardGame]);

  // Initial load + reload when leaderboard tab changes
  useEffect(() => { load(); }, [load]);

  // Re-fetch stats every time the screen comes back into focus
  // (e.g. after finishing a game and navigating back here)
  useFocusEffect(
    useCallback(() => { load(); }, [load])
  );

  const level = stats?.level ?? 1;
  const xp    = stats?.total_xp ?? 0;
  const xpToNext = xpForLevel(level + 1);
  const xpInLevel = xp - xpForLevel(level);
  const xpNeeded  = xpToNext - xpForLevel(level);
  const progress  = Math.max(0, Math.min(1, xpInLevel / xpNeeded));

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>

      {/* Header */}
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => { Haptics.selectionAsync(); router.back(); }}
          hitSlop={12}
        >
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Back</Text>
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <View style={[styles.headerIconPill, { backgroundColor: S.color + '28' }]}>
            <FontAwesome5 name={S.icon as any} size={13} color={S.color} solid />
          </View>
          <Text style={styles.headerTitle}>Games</Text>
        </View>
        <View style={{ width: 70 }} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={S.color} />}
      >

        {/* ── Stats card ── */}
        {profile ? (
          <TouchableOpacity
            style={[styles.statsCard, { backgroundColor: S.color }]}
            onPress={() => { Haptics.selectionAsync(); router.push('/games/stats'); }}
            activeOpacity={0.9}
          >
            <View style={styles.statsDrillHint}>
              <Text style={styles.statsDrillHintText}>Tap for breakdown</Text>
              <FontAwesome5 name="chevron-right" size={10} color="rgba(255,255,255,0.85)" />
            </View>
            <View style={styles.statsTop}>
              <View>
                <Text style={styles.statsLevel}>LEVEL {level}</Text>
                <Text style={styles.statsTitle}>{levelTitle(level)}</Text>
              </View>
              <View style={styles.statsStreak}>
                <FontAwesome5 name="fire" size={14} color="#fff" solid />
                <Text style={styles.statsStreakNum}>{stats?.current_streak_days ?? 0}</Text>
                <Text style={styles.statsStreakLabel}>day{(stats?.current_streak_days ?? 0) !== 1 ? 's' : ''}</Text>
              </View>
            </View>

            <View style={styles.xpRow}>
              <Text style={styles.xpText}>{xpInLevel} / {xpNeeded} XP</Text>
              <View style={styles.xpTrack}>
                <View style={[styles.xpFill, { width: `${progress * 100}%` }]} />
              </View>
            </View>

            <View style={styles.statsBottom}>
              <View style={styles.statsBottomItem}>
                <Text style={styles.statsBottomNum}>{stats?.games_played ?? 0}</Text>
                <Text style={styles.statsBottomLabel}>games</Text>
              </View>
              <View style={styles.statsBottomDivider} />
              <View style={styles.statsBottomItem}>
                <Text style={styles.statsBottomNum}>{stats?.longest_streak_days ?? 0}</Text>
                <Text style={styles.statsBottomLabel}>best streak</Text>
              </View>
              <View style={styles.statsBottomDivider} />
              <View style={styles.statsBottomItem}>
                <Text style={styles.statsBottomNum}>{xp}</Text>
                <Text style={styles.statsBottomLabel}>total XP</Text>
              </View>
            </View>
          </TouchableOpacity>
        ) : (
          <View style={styles.signInCard}>
            <View style={[styles.signInIcon, { backgroundColor: S.light }]}>
              <FontAwesome5 name="trophy" size={20} color={S.color} solid />
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={styles.signInTitle}>Sign in to track your scores</Text>
              <Text style={styles.signInSub}>Build streaks, earn XP, climb the leaderboards.</Text>
            </View>
            <TouchableOpacity
              style={[styles.signInBtn, { backgroundColor: S.color }]}
              onPress={() => router.push('/(auth)/sign-in')}
            >
              <Text style={styles.signInBtnText}>Sign in</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Available games ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Pick a game</Text>
          <View style={{ gap: 10 }}>
            <GameRow
              game={GAMES.spik_sprint}
              best={bestSprint}
              accent="#10B981"
              onPress={() => {
                Haptics.selectionAsync();
                router.push('/games/spik-sprint');
              }}
            />
            <GameRow
              game={GAMES.spik_snap}
              best={bestSnap}
              accent="#F59E0B"
              onPress={() => {
                Haptics.selectionAsync();
                router.push('/games/spik-snap');
              }}
            />
            <GameRow
              game={GAMES.guess_da_wird}
              best={bestWird}
              accent="#0EA5E9"
              onPress={() => {
                Haptics.selectionAsync();
                router.push('/games/guess-da-wird');
              }}
            />
            <GameRow
              game={GAMES.map_it}
              best={bestMapIt}
              accent="#12B3D6"
              onPress={() => {
                Haptics.selectionAsync();
                router.push('/games/map-it' as any);
              }}
            />
          </View>
        </View>

        {/* ── Leaderboard ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Leaderboard</Text>

          {/* Game switcher */}
          <View style={styles.lbSwitch}>
            {(['spik_sprint', 'spik_snap', 'guess_da_wird', 'map_it'] as const).map(gid => {
              const active = leaderboardGame === gid;
              return (
                <TouchableOpacity
                  key={gid}
                  style={[styles.lbSwitchBtn, active && { backgroundColor: S.color, borderColor: S.color }]}
                  onPress={() => { Haptics.selectionAsync(); setLeaderboardGame(gid); }}
                >
                  <Text style={[styles.lbSwitchBtnText, active && { color: '#fff' }]}>
                    {GAMES[gid].label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {loading ? (
            <ActivityIndicator color={S.color} style={{ marginTop: 16 }} />
          ) : leaderboard.length === 0 ? (
            <View style={styles.lbEmpty}>
              <Text style={styles.lbEmptyText}>No scores yet — be the first!</Text>
            </View>
          ) : (
            <View style={styles.lbList}>
              {leaderboard.map((row, i) => (
                <View key={row.user_id} style={[styles.lbRow, i === 0 && styles.lbRowFirst]}>
                  <View style={[styles.lbRank, i === 0 && { backgroundColor: '#FBBF24' }]}>
                    <Text style={[styles.lbRankText, i === 0 && { color: '#fff' }]}>{i + 1}</Text>
                  </View>
                  <Text style={styles.lbName} numberOfLines={1}>
                    {row.games_handle ?? 'Anon'}
                    {profile?.id === row.user_id && (
                      <Text style={[styles.lbYou, { color: S.color }]}> · you</Text>
                    )}
                  </Text>
                  <Text style={styles.lbScore}>{row.best_score}</Text>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* ── Coming soon ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Coming soon</Text>
          <View style={styles.comingGrid}>
            {[
              { icon: 'users',        label: 'Family Mode',   sub: 'Asymmetric difficulty' },
              { icon: 'map-marked-alt', label: 'Wird Hunt',   sub: 'Geolocation game' },
              { icon: 'school',       label: 'Class Mode',    sub: 'For Shetland schools' },
              { icon: 'sword',        label: 'Spik Duel',     sub: 'Real-time 1v1' },
              { icon: 'volume-up',    label: 'Hear-da-Wird',  sub: 'Audio pronunciation' },
              { icon: 'trophy',       label: 'Tournaments',   sub: 'Weekly prizes' },
            ].map(item => (
              <View key={item.label} style={styles.comingCard}>
                <View style={[styles.comingIcon, { backgroundColor: S.light }]}>
                  <FontAwesome5 name={item.icon as any} size={13} color={S.color} solid />
                </View>
                <Text style={styles.comingLabel}>{item.label}</Text>
                <Text style={styles.comingSub}>{item.sub}</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Game row ──────────────────────────────────────────────────────────────────

function GameRow({
  game, best, accent, onPress,
}: {
  game: typeof GAMES[GameId];
  best: number | null;
  accent: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.gameRow, !game.live && { opacity: 0.7 }]}
      onPress={onPress}
      activeOpacity={0.85}
      disabled={!game.live}
    >
      <View style={[styles.gameIcon, { backgroundColor: accent + '20' }]}>
        <FontAwesome5 name={game.icon as any} size={18} color={accent} solid />
      </View>
      <View style={{ flex: 1 }}>
        <View style={styles.gameTitleRow}>
          <Text style={styles.gameLabel}>{game.label}</Text>
          {!game.live && (
            <View style={styles.soonPill}>
              <Text style={styles.soonPillText}>Coming soon</Text>
            </View>
          )}
        </View>
        <Text style={styles.gameDesc} numberOfLines={2}>{game.description}</Text>
        {game.live && best !== null && best > 0 && (
          <Text style={[styles.gameBest, { color: accent }]}>Personal best: {best}</Text>
        )}
      </View>
      <FontAwesome5 name="chevron-right" size={12} color={colors.textLight} />
    </TouchableOpacity>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: colors.navy },
  scroll:  { flex: 1, backgroundColor: colors.screenBackground },
  content: { paddingBottom: 40 },

  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
    borderBottomWidth: 2,
  },
  backBtn:        { flexDirection: 'row', alignItems: 'center', gap: 8, width: 70 },
  backText:       { fontSize: fontSize.sm, fontWeight: '700' },
  headerCenter:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerIconPill: { width: 28, height: 28, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  headerTitle:    { color: '#fff', fontSize: fontSize.md, fontWeight: '900' },

  // Stats card (signed-in)
  statsCard: {
    marginHorizontal: spacing.md, marginTop: spacing.md,
    padding: spacing.lg, borderRadius: radius.xl, gap: 14,
    shadowColor: '#10B981', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 12, elevation: 4,
  },
  statsTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statsLevel: { color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: '900', letterSpacing: 1.5 },
  statsTitle: { color: '#fff', fontSize: 22, fontWeight: '900', letterSpacing: -0.4, marginTop: 2 },
  statsStreak: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(255,255,255,0.18)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.full },
  statsStreakNum:   { color: '#fff', fontSize: fontSize.md, fontWeight: '900' },
  statsStreakLabel: { color: 'rgba(255,255,255,0.75)', fontSize: fontSize.xs, fontWeight: '700' },

  xpRow:   { gap: 6 },
  xpText:  { color: '#fff', fontSize: 11, fontWeight: '700' },
  xpTrack: { height: 6, backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 3, overflow: 'hidden' },
  xpFill:  { height: 6, backgroundColor: '#fff', borderRadius: 3 },

  statsBottom: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: radius.md, padding: 10 },
  statsBottomItem:    { flex: 1, alignItems: 'center', gap: 2 },
  statsBottomNum:     { color: '#fff', fontSize: fontSize.lg, fontWeight: '900' },
  statsBottomLabel:   { color: 'rgba(255,255,255,0.65)', fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  statsBottomDivider: { width: 1, height: 24, backgroundColor: 'rgba(255,255,255,0.2)' },

  statsDrillHint:     {
    position: 'absolute', top: 10, right: 12,
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(255,255,255,0.18)',
    paddingHorizontal: 9, paddingVertical: 4,
    borderRadius: radius.full,
  },
  statsDrillHintText: { color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 0.3 },

  // Sign-in card (signed-out)
  signInCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    marginHorizontal: spacing.md, marginTop: spacing.md,
    backgroundColor: '#fff', borderRadius: radius.xl, padding: spacing.md,
    borderWidth: 1, borderColor: colors.border,
  },
  signInIcon: { width: 44, height: 44, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' },
  signInTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  signInSub:   { fontSize: fontSize.xs, color: colors.textMuted },
  signInBtn:   { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.full },
  signInBtnText: { color: '#fff', fontSize: fontSize.xs, fontWeight: '800' },

  // Section
  section:      { paddingHorizontal: spacing.md, marginTop: spacing.lg },
  sectionTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary, marginBottom: 12 },

  // Game row
  gameRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: 14, borderWidth: 1, borderColor: colors.border,
  },
  gameIcon:     { width: 48, height: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  gameTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  gameLabel:    { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  gameDesc:     { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 17, marginTop: 2 },
  gameBest:     { fontSize: fontSize.xs, fontWeight: '800', marginTop: 4 },
  soonPill:     { backgroundColor: colors.border + '99', paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.full },
  soonPillText: { fontSize: 9, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },

  // Leaderboard
  lbSwitch:     { flexDirection: 'row', gap: 6, marginBottom: 12 },
  lbSwitchBtn:  { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#fff', borderRadius: radius.full, borderWidth: 1.5, borderColor: colors.border },
  lbSwitchBtnText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textMuted },

  lbList:    { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  lbRow:     { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border },
  lbRowFirst:{ borderTopWidth: 0 },
  lbRank:    { width: 26, height: 26, borderRadius: 13, backgroundColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  lbRankText:{ fontSize: 11, fontWeight: '900', color: colors.textMuted },
  lbName:    { flex: 1, fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: '600' },
  lbYou:     { fontWeight: '800' },
  lbScore:   { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary },
  lbEmpty:   { padding: spacing.lg, alignItems: 'center', backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border },
  lbEmptyText:{ fontSize: fontSize.sm, color: colors.textMuted },

  // Coming soon grid
  comingGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  comingCard: {
    width: '48%', backgroundColor: '#fff', borderRadius: radius.lg,
    padding: 12, gap: 4, borderWidth: 1, borderColor: colors.border,
  },
  comingIcon: { width: 30, height: 30, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  comingLabel:{ fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  comingSub:  { fontSize: fontSize.xs, color: colors.textMuted },
});
