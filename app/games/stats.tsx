/**
 * games/stats.tsx
 *
 * Drill-in from the green stats card on the Games Centre.
 * Shows the user's full per-game breakdown + recent play history.
 */

import React, { useEffect, useState, useCallback } from 'react';
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
  GAMES, fetchUserStats, fetchGameBreakdown, fetchMyRecentScores,
  levelTitle, xpForLevel,
  type UserGameStats, type GameBreakdownEntry, type GameScore,
} from '@/lib/games-api';

const S = SECTIONS.games;

const ACCENTS: Record<string, string> = {
  spik_sprint:   '#10B981',
  spik_snap:     '#F59E0B',
  guess_da_wird: '#0EA5E9',
};

export default function GameStatsScreen() {
  const router = useRouter();
  const { profile } = useAuth();

  const [stats,     setStats]     = useState<UserGameStats | null>(null);
  const [breakdown, setBreakdown] = useState<GameBreakdownEntry[]>([]);
  const [recent,    setRecent]    = useState<GameScore[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!profile?.id) { setLoading(false); return; }
    try {
      const [s, b, r] = await Promise.all([
        fetchUserStats(profile.id).catch(() => null),
        fetchGameBreakdown(profile.id).catch(() => []),
        fetchMyRecentScores(profile.id, 15).catch(() => []),
      ]);
      setStats(s);
      setBreakdown(b);
      setRecent(r);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [profile?.id]);

  useEffect(() => { load(); }, [load]);

  const level = stats?.level ?? 1;
  const xp    = stats?.total_xp ?? 0;
  const xpToNext   = xpForLevel(level + 1);
  const xpInLevel  = xp - xpForLevel(level);
  const xpNeeded   = xpToNext - xpForLevel(level);
  const progress   = Math.max(0, Math.min(1, xpInLevel / xpNeeded));

  const breakdownByGame = (id: string) => breakdown.find(b => b.game_id === id);

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
          <Text style={[styles.backText, { color: S.color }]}>Games</Text>
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <View style={[styles.headerIconPill, { backgroundColor: S.color + '28' }]}>
            <FontAwesome5 name="chart-line" size={13} color={S.color} solid />
          </View>
          <Text style={styles.headerTitle}>My stats</Text>
        </View>
        <View style={{ width: 80 }} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); load(); }}
            tintColor={S.color}
          />
        }
      >
        {!profile ? (
          <View style={styles.signedOut}>
            <Text style={styles.signedOutText}>Sign in to see your stats.</Text>
            <TouchableOpacity
              style={[styles.signInBtn, { backgroundColor: S.color }]}
              onPress={() => router.push('/(auth)/sign-in')}
            >
              <Text style={styles.signInBtnText}>Sign in</Text>
            </TouchableOpacity>
          </View>
        ) : loading ? (
          <View style={{ paddingTop: 80, alignItems: 'center' }}>
            <ActivityIndicator color={S.color} />
          </View>
        ) : (
          <>
            {/* ── Compact summary strip ──
                Deliberately small + white-on-light so it doesn't echo the big
                green card on the parent /games screen — otherwise the drill-in
                feels like the same page hasn't moved. */}
            <View style={styles.summaryStrip}>
              <View style={styles.summaryLevel}>
                <View style={[styles.summaryLevelBadge, { backgroundColor: S.color }]}>
                  <Text style={styles.summaryLevelBadgeText}>L{level}</Text>
                </View>
                <View>
                  <Text style={styles.summaryLevelTitle}>{levelTitle(level)}</Text>
                  <Text style={styles.summaryLevelXp}>{xp.toLocaleString()} XP total</Text>
                </View>
              </View>
              <View style={[styles.summaryStreak, { backgroundColor: S.light }]}>
                <FontAwesome5 name="fire" size={11} color={S.color} solid />
                <Text style={[styles.summaryStreakNum, { color: S.color }]}>
                  {stats?.current_streak_days ?? 0}
                </Text>
              </View>
            </View>

            <View style={styles.xpBarWrap}>
              <View style={styles.xpBarTrack}>
                <View style={[styles.xpBarFill, { width: `${progress * 100}%`, backgroundColor: S.color }]} />
              </View>
              <Text style={styles.xpBarText}>
                {xpInLevel} / {xpNeeded} XP to L{level + 1}
              </Text>
            </View>

            {/* ── Per-game breakdown ── */}
            <Text style={styles.sectionTitle}>By game</Text>
            <View style={{ gap: 10 }}>
              {(Object.values(GAMES)).map(game => {
                const b      = breakdownByGame(game.id);
                const accent = ACCENTS[game.id] ?? S.color;
                return (
                  <View
                    key={game.id}
                    style={[styles.gameCard, !game.live && { opacity: 0.7 }]}
                  >
                    <View style={[styles.gameIconWrap, { backgroundColor: accent + '20' }]}>
                      <FontAwesome5 name={game.icon as any} size={18} color={accent} solid />
                    </View>
                    <View style={{ flex: 1 }}>
                      <View style={styles.gameTopRow}>
                        <Text style={styles.gameName}>{game.label}</Text>
                        {!game.live && (
                          <View style={styles.soonPill}><Text style={styles.soonPillText}>Coming soon</Text></View>
                        )}
                      </View>
                      {b ? (
                        <View style={styles.gameStatsRow}>
                          <Stat label="Best"    value={b.best_score}    accent={accent} />
                          <Stat label="Played"  value={b.games_played}  />
                          <Stat label="Average" value={b.average_score} />
                        </View>
                      ) : (
                        <Text style={styles.gameEmpty}>
                          {game.live ? "Not played yet — tap a game on the Games tab to start." : "Returning soon."}
                        </Text>
                      )}
                      {b?.last_played && (
                        <Text style={styles.gameLast}>
                          Last played {formatRelative(b.last_played)}
                        </Text>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>

            {/* ── Recent activity ── */}
            <Text style={styles.sectionTitle}>Recent activity</Text>
            {recent.length === 0 ? (
              <View style={styles.empty}>
                <FontAwesome5 name="history" size={20} color={colors.textLight} />
                <Text style={styles.emptyText}>No games played yet.</Text>
              </View>
            ) : (
              <View style={styles.recentList}>
                {recent.map((r, i) => {
                  const game   = (Object.values(GAMES)).find(g => g.id === r.game_id);
                  const accent = ACCENTS[r.game_id] ?? S.color;
                  return (
                    <View key={r.id} style={[styles.recentRow, i < recent.length - 1 && styles.recentRowBorder]}>
                      <View style={[styles.recentIcon, { backgroundColor: accent + '20' }]}>
                        <FontAwesome5 name={(game?.icon ?? 'gamepad') as any} size={11} color={accent} solid />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.recentName}>{game?.label ?? r.game_id}</Text>
                        <Text style={styles.recentTime}>{formatRelative(r.played_at)}</Text>
                      </View>
                      <Text style={[styles.recentScore, { color: accent }]}>{r.score}</Text>
                    </View>
                  );
                })}
              </View>
            )}

            <View style={{ height: 40 }} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1)    return 'just now';
  if (mins < 60)   return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs  < 24)   return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7)    return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <View style={styles.statBlock}>
      <Text style={[styles.statValue, accent && { color: accent }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: colors.screenBackground },
  scroll:  { flex: 1 },
  content: { padding: spacing.md, paddingBottom: 40 },

  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
    borderBottomWidth: 2,
  },
  backBtn:        { flexDirection: 'row', alignItems: 'center', gap: 8, width: 80 },
  backText:       { fontSize: fontSize.sm, fontWeight: '700' },
  headerCenter:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerIconPill: { width: 28, height: 28, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  headerTitle:    { color: '#fff', fontSize: fontSize.md, fontWeight: '900' },

  // Compact summary strip
  summaryStrip: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#fff', borderRadius: radius.lg,
    paddingHorizontal: 14, paddingVertical: 12,
    borderWidth: 1, borderColor: colors.border,
  },
  summaryLevel:           { flexDirection: 'row', alignItems: 'center', gap: 10 },
  summaryLevelBadge:      { paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.sm },
  summaryLevelBadgeText:  { color: '#fff', fontSize: fontSize.sm, fontWeight: '900' },
  summaryLevelTitle:      { color: colors.textPrimary, fontSize: fontSize.sm, fontWeight: '800' },
  summaryLevelXp:         { color: colors.textMuted, fontSize: fontSize.xs, marginTop: 1 },
  summaryStreak:          { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.full },
  summaryStreakNum:       { fontSize: fontSize.sm, fontWeight: '900' },

  xpBarWrap:    { marginTop: 10, gap: 6 },
  xpBarTrack:   { height: 5, backgroundColor: colors.border, borderRadius: 3, overflow: 'hidden' },
  xpBarFill:    { height: 5, borderRadius: 3 },
  xpBarText:    { color: colors.textMuted, fontSize: 10, fontWeight: '700', textAlign: 'right' },

  sectionTitle:  { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary, marginTop: spacing.lg, marginBottom: spacing.sm },

  // Game card
  gameCard:    {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: 14, borderWidth: 1, borderColor: colors.border,
  },
  gameIconWrap:{ width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  gameTopRow:  { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  gameName:    { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  soonPill:    { backgroundColor: colors.border + '99', paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.full },
  soonPillText:{ fontSize: 9, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  gameStatsRow:{ flexDirection: 'row', gap: spacing.md, marginTop: 2 },
  statBlock:   { gap: 1 },
  statValue:   { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary },
  statLabel:   { fontSize: 10, color: colors.textMuted, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  gameEmpty:   { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 17 },
  gameLast:    { fontSize: fontSize.xs, color: colors.textLight, marginTop: 6 },

  // Recent
  recentList:     { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  recentRow:      { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
  recentRowBorder:{ borderBottomWidth: 1, borderBottomColor: colors.border },
  recentIcon:     { width: 28, height: 28, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  recentName:     { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  recentTime:     { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  recentScore:    { fontSize: fontSize.md, fontWeight: '900' },

  empty:     { alignItems: 'center', padding: spacing.lg, gap: 8, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border },
  emptyText: { fontSize: fontSize.sm, color: colors.textMuted },

  signedOut:     { alignItems: 'center', padding: spacing.xl, gap: 16, marginTop: spacing.lg },
  signedOutText: { fontSize: fontSize.md, color: colors.textPrimary, fontWeight: '700' },
  signInBtn:     { paddingHorizontal: 22, paddingVertical: 10, borderRadius: radius.full },
  signInBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
});
