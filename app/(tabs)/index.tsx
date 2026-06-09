/**
 * app/(tabs)/index.tsx
 *
 * Home — the concierge.
 *
 * Vertical scroll, top to bottom:
 *   1. Sticky top banner (urgent | personal | Spik daily)
 *   2. Time-aware greeting + status line
 *   3. What's coming up this week (contextual carousel)
 *   4. Work in Shetland (Jobs + Shifts in one card)
 *   5. Notices (3 most relevant)
 *   6. Today's game prompt
 *   7. For-you row (engagement-driven tiles)
 *
 * Boats deliberately not surfaced here — Boats is for the men who go
 * seeking it. The For-you row will pick it up automatically once a user
 * has saved or commented on a boat.
 *
 * Data sources, current state:
 *   - Events / Notices / Jobs / Shifts pull from lib/seed-content.ts
 *     (placeholder). Real schemas land in chunk B; this file's row
 *     components stay the same, only the fetchers change.
 *   - Boats prefs (saved + recent) feed the For-you row from
 *     lib/boats-prefs.ts.
 *   - Engagement signals come from lib/engagement.ts.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect, Stack } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { SECTIONS, SectionKey } from '@/constants/sections';
import { colors, spacing, radius } from '@/constants/theme';
import { useAuth } from '@/context/AuthContext';

import DisplayText from '@/components/DisplayText';

import {
  SAMPLE_EVENTS, SAMPLE_NOTICES, SAMPLE_JOBS, SAMPLE_SHIFTS,
  SAMPLE_URGENT_NOTICE, SampleEvent, SampleNotice, todaysSpik,
} from '@/lib/seed-content';
import { loadSavedBoats, loadRecentBoats, VesselStub } from '@/lib/boats-prefs';
import {
  bumpSectionEngagement, getRecentEngagement, EngagementKey, EngagementEntry,
} from '@/lib/engagement';

// ──────────────────────────────────────────────────────────────────────────
// Top banner
// ──────────────────────────────────────────────────────────────────────────

function TopBanner({
  urgent, personalNote,
}: {
  urgent:       SampleNotice | null;
  personalNote: string | null;
}) {
  const router = useRouter();
  const spik = todaysSpik();

  return (
    <View style={styles.bannerWrap}>
      {/* Urgent zone — only rendered when there's an active alert */}
      {urgent ? (
        <TouchableOpacity
          onPress={() => router.push('/(tabs)/whats-on')}
          style={styles.bannerUrgent}
          activeOpacity={0.85}
        >
          <FontAwesome5 name="exclamation-triangle" size={11} color="#fff" solid />
          <Text style={styles.bannerUrgentText} numberOfLines={1}>
            {urgent.title}
          </Text>
        </TouchableOpacity>
      ) : null}

      {/* Personal + Spik strip */}
      <View style={styles.bannerStrip}>
        {personalNote ? (
          <View style={styles.bannerPersonal}>
            <View style={styles.bannerPersonalDot} />
            <Text style={styles.bannerPersonalText} numberOfLines={1}>{personalNote}</Text>
          </View>
        ) : (
          <View style={{ flex: 1 }} />
        )}

        <TouchableOpacity
          onPress={() => router.push('/(tabs)/spik')}
          style={styles.bannerSpik}
          activeOpacity={0.85}
        >
          <Text style={styles.bannerSpikLabel}>SPIK</Text>
          <Text style={styles.bannerSpikWord} numberOfLines={1}>
            {spik.word}
          </Text>
          <Text style={styles.bannerSpikMeaning} numberOfLines={1}>
            · {spik.meaning}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Greeting
// ──────────────────────────────────────────────────────────────────────────

function timeGreeting(): string {
  const h = new Date().getHours();
  if (h < 5)  return 'Up late';
  if (h < 12) return "Mornin'";
  if (h < 18) return 'Aftirneen';
  return "Evenin'";
}

function Greeting({ name, status }: { name: string | null; status: string | null }) {
  return (
    <View style={styles.greetingWrap}>
      <DisplayText weight="black" style={styles.greetingTitle}>
        {`${timeGreeting()}${name ? `, ${name.split(' ')[0]}` : ''}`}
      </DisplayText>
      {status ? <Text style={styles.greetingStatus}>{status}</Text> : null}
    </View>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Section row chrome
// ──────────────────────────────────────────────────────────────────────────

function SectionRow({
  title, action, children,
}: {
  title:   string;
  action?: { label: string; onPress: () => void };
  children: React.ReactNode;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <Text style={styles.rowTitle}>{title}</Text>
        {action ? (
          <TouchableOpacity onPress={action.onPress} hitSlop={8}>
            <Text style={styles.rowAction}>{action.label}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {children}
    </View>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// What's coming up this week
// ──────────────────────────────────────────────────────────────────────────

function fmtEventDay(iso: string): { day: string; time: string } {
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);

  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();

  let day = '';
  if (sameDay(d, today))         day = 'Today';
  else if (sameDay(d, tomorrow)) day = 'Tomorrow';
  else day = d.toLocaleDateString(undefined, { weekday: 'short' });

  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return { day, time };
}

function ComingUpRow() {
  const router = useRouter();
  const upcoming = useMemo(() => {
    const week = Date.now() + 7 * 86_400_000;
    return SAMPLE_EVENTS
      .filter(e => new Date(e.starts_at).getTime() < week)
      .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
  }, []);

  if (upcoming.length === 0) return null;

  const busy = upcoming.length >= 4;

  return (
    <SectionRow
      title="Coming up this week"
      action={{ label: 'See all', onPress: () => router.push('/(tabs)/whats-on') }}
    >
      {busy ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: spacing.sm, paddingHorizontal: spacing.lg }}
        >
          {upcoming.slice(0, 5).map(e => (
            <EventCardCompact key={e.id} event={e} onPress={() => router.push('/(tabs)/whats-on')} />
          ))}
        </ScrollView>
      ) : (
        <View style={{ paddingHorizontal: spacing.lg, gap: spacing.sm }}>
          {upcoming.slice(0, 2).map(e => (
            <EventCardFull key={e.id} event={e} onPress={() => router.push('/(tabs)/whats-on')} />
          ))}
        </View>
      )}
    </SectionRow>
  );
}

function EventCardCompact({ event, onPress }: { event: SampleEvent; onPress: () => void }) {
  const { day, time } = fmtEventDay(event.starts_at);
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={styles.eventCardCompact}>
      <View style={styles.eventDayChip}>
        <Text style={styles.eventDayChipText}>{day.toUpperCase()}</Text>
      </View>
      <Text style={styles.eventCardTitle} numberOfLines={2}>{event.title}</Text>
      <Text style={styles.eventCardMeta} numberOfLines={1}>{time}  ·  {event.venue}</Text>
    </TouchableOpacity>
  );
}

function EventCardFull({ event, onPress }: { event: SampleEvent; onPress: () => void }) {
  const { day, time } = fmtEventDay(event.starts_at);
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={styles.eventCardFull}>
      <View style={[styles.eventDayChip, { alignSelf: 'flex-start' }]}>
        <Text style={styles.eventDayChipText}>{day.toUpperCase()}  ·  {time}</Text>
      </View>
      <Text style={[styles.eventCardTitle, { fontSize: 18 }]} numberOfLines={2}>{event.title}</Text>
      <Text style={styles.eventCardMeta}>{event.venue}  ·  {event.category}</Text>
    </TouchableOpacity>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Work in Shetland
// ──────────────────────────────────────────────────────────────────────────

function WorkRow() {
  const router = useRouter();
  return (
    <SectionRow
      title="Work in Shetland"
      action={{ label: 'See all', onPress: () => router.push('/(tabs)/shifts') }}
    >
      <View style={[styles.workCard, { backgroundColor: SECTIONS.shifts.light }]}>
        <View style={styles.workColumns}>
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={styles.workColLabel}>JOBS</Text>
            {SAMPLE_JOBS.map(j => (
              <View key={j.id} style={styles.workItem}>
                <Text style={styles.workItemTitle} numberOfLines={1}>{j.title}</Text>
                <Text style={styles.workItemMeta}  numberOfLines={1}>{j.employer}  ·  {j.pay}</Text>
              </View>
            ))}
          </View>
          <View style={styles.workDivider} />
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={styles.workColLabel}>SHIFTS</Text>
            {SAMPLE_SHIFTS.map(s => (
              <View key={s.id} style={styles.workItem}>
                <Text style={styles.workItemTitle} numberOfLines={1}>{s.title}</Text>
                <Text style={styles.workItemMeta}  numberOfLines={1}>{s.when}  ·  {s.pay}</Text>
              </View>
            ))}
          </View>
        </View>
      </View>
    </SectionRow>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Notices
// ──────────────────────────────────────────────────────────────────────────

function NoticesRow() {
  const router = useRouter();
  const list = SAMPLE_NOTICES.slice(0, 3);

  return (
    <SectionRow
      title="Notices"
      action={{ label: 'See all', onPress: () => router.push('/(tabs)/whats-on') }}
    >
      <View style={{ paddingHorizontal: spacing.lg, gap: spacing.xs }}>
        {list.map(n => (
          <TouchableOpacity
            key={n.id}
            onPress={() => router.push('/(tabs)/whats-on')}
            activeOpacity={0.85}
            style={styles.noticeRow}
          >
            <View style={[
              styles.noticeDot,
              { backgroundColor: n.severity === 'urgent' ? colors.error : SECTIONS.notices.color },
            ]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.noticeTitle} numberOfLines={1}>{n.title}</Text>
              <Text style={styles.noticeMeta} numberOfLines={1}>
                {n.publisher}{n.locality ? `  ·  ${n.locality}` : ''}
              </Text>
            </View>
            <FontAwesome5 name="chevron-right" size={11} color={colors.textLight} />
          </TouchableOpacity>
        ))}
      </View>
    </SectionRow>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Games daily prompt
// ──────────────────────────────────────────────────────────────────────────

function GamesRow() {
  const router = useRouter();
  const idx = new Date().getDate() % 4;
  const cfg = [
    { key: 'spik-sprint',   title: 'Spik Sprint',   sub: '60 seconds. How many do you ken?', path: '/games' as const },
    { key: 'guess-da-wird', title: 'Guess Da Wird', sub: "Today's Shetlandic word.",          path: '/games/guess-da-wird' as const },
    { key: 'map-it',        title: 'Map It',        sub: "Drop a pin near today's place.",    path: '/games/map-it' as const },
    { key: 'spik-snap',     title: 'Spik Snap',     sub: 'Match the word to its meaning.',    path: '/games' as const },
  ][idx];

  return (
    <SectionRow
      title="Today's game"
      action={{ label: 'All games', onPress: () => router.push('/games') }}
    >
      <View style={{ paddingHorizontal: spacing.lg }}>
        <TouchableOpacity
          onPress={() => router.push(cfg.path)}
          activeOpacity={0.9}
          style={[styles.gameCard, { backgroundColor: SECTIONS.games.color }]}
        >
          <View style={{ flex: 1 }}>
            <Text style={styles.gameTitle}>{cfg.title}</Text>
            <Text style={styles.gameSub}>{cfg.sub}</Text>
          </View>
          <View style={styles.gamePlay}>
            <FontAwesome5 name="play" size={18} color={SECTIONS.games.color} solid />
          </View>
        </TouchableOpacity>
      </View>
    </SectionRow>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// For-you row
// ──────────────────────────────────────────────────────────────────────────

interface ForYouTile {
  key:      EngagementKey;
  label:    string;
  subtitle: string;
  iconKey:  SectionKey;
  onPress:  () => void;
}

function ForYouRow({ tiles }: { tiles: ForYouTile[] }) {
  if (tiles.length === 0) return null;
  return (
    <SectionRow title="For you">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: spacing.sm, paddingHorizontal: spacing.lg }}
      >
        {tiles.map(t => {
          const meta = SECTIONS[t.iconKey];
          return (
            <TouchableOpacity
              key={t.key}
              onPress={t.onPress}
              activeOpacity={0.85}
              style={styles.foryouTile}
            >
              <View style={[styles.foryouIcon, { backgroundColor: meta.light }]}>
                <FontAwesome5 name={meta.icon} size={20} color={meta.color} solid />
              </View>
              <Text style={styles.foryouLabel} numberOfLines={1}>{meta.label}</Text>
              <Text style={styles.foryouSub}   numberOfLines={2}>{t.subtitle}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </SectionRow>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Screen
// ──────────────────────────────────────────────────────────────────────────

const ENGAGEMENT_TO_SECTION: Record<EngagementKey, SectionKey> = {
  memories: 'memories',
  daBoats:  'daBoats',
  spik:     'spik',
  fetch:    'fetch',
  local:    'local',
  shifts:   'shifts',
  games:    'games',
  events:   'events',
  notices:  'notices',
  jobs:     'jobs',
};

const ENGAGEMENT_TO_PATH: Record<EngagementKey, string> = {
  memories: '/(tabs)/memories',
  daBoats:  '/(tabs)/da-boats',
  spik:     '/(tabs)/spik',
  fetch:    '/(tabs)/fetch',
  local:    '/(tabs)/local',
  shifts:   '/(tabs)/shifts',
  games:    '/games',
  events:   '/(tabs)/whats-on',
  notices:  '/(tabs)/whats-on',
  jobs:     '/(tabs)/shifts',
};

export default function HomeScreen() {
  const router = useRouter();
  const { profile } = useAuth();

  const [refreshing, setRefreshing]     = useState(false);
  const [savedBoats, setSavedBoats]     = useState<VesselStub[]>([]);
  const [recentBoats, setRecentBoats]   = useState<VesselStub[]>([]);
  const [engagement, setEngagement]     = useState<Array<{ key: EngagementKey; entry: EngagementEntry }>>([]);

  const loadPrefs = useCallback(async () => {
    const [s, r, e] = await Promise.all([
      loadSavedBoats(),
      loadRecentBoats(),
      getRecentEngagement(),
    ]);
    setSavedBoats(s);
    setRecentBoats(r);
    setEngagement(e);
    setRefreshing(false);
  }, []);

  useFocusEffect(useCallback(() => { void loadPrefs(); }, [loadPrefs]));

  // ── Build For-you tiles ────────────────────────────────────────────────
  const tiles = useMemo<ForYouTile[]>(() => {
    const out: ForYouTile[] = [];

    if (savedBoats.length > 0 || recentBoats.length > 0) {
      const count = savedBoats.length;
      out.push({
        key: 'daBoats',
        iconKey: 'daBoats',
        label: 'Da Boats',
        subtitle: count > 0
          ? `${count} boat${count === 1 ? '' : 's'} saved`
          : 'You looked at boats recently',
        onPress: () => router.push('/(tabs)/da-boats'),
      });
    }

    for (const { key, entry } of engagement) {
      if (key === 'daBoats') continue;
      if (out.some(t => t.key === key)) continue;

      const iconKey = ENGAGEMENT_TO_SECTION[key];
      const meta    = SECTIONS[iconKey];
      out.push({
        key, iconKey,
        label: meta.label,
        subtitle: entry?.lastNote ?? 'Pick up where you left off',
        onPress: () => router.push(ENGAGEMENT_TO_PATH[key] as any),
      });
    }

    return out.slice(0, 5);
  }, [savedBoats, recentBoats, engagement, router]);

  // ── Personal note in the banner ────────────────────────────────────────
  const personalNote = useMemo(() => {
    if (savedBoats.length === 0) return null;
    return `${savedBoats.length} boat${savedBoats.length === 1 ? '' : 's'} saved`;
  }, [savedBoats]);

  // ── Status under the greeting ──────────────────────────────────────────
  const status = useMemo(() => {
    const bits: string[] = [];
    if (savedBoats.length)  bits.push(`${savedBoats.length} saved boat${savedBoats.length === 1 ? '' : 's'}`);
    if (recentBoats.length) bits.push(`${recentBoats.length} recently seen`);
    return bits.length ? bits.join('  ·  ') : null;
  }, [savedBoats, recentBoats]);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Sticky banner */}
      <TopBanner urgent={SAMPLE_URGENT_NOTICE} personalNote={personalNote} />

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); void loadPrefs(); }}
            tintColor={colors.accent}
          />
        }
      >
        <Greeting name={profile?.full_name ?? null} status={status} />
        <ComingUpRow />
        <WorkRow />
        <NoticesRow />
        <GamesRow />
        <ForYouRow tiles={tiles} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Styles
// ──────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.screenBackground },
  scroll:    { paddingBottom: spacing.xxl, gap: spacing.lg, paddingTop: spacing.md },

  // Banner
  bannerWrap: {
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  bannerUrgent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.error,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
  },
  bannerUrgentText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '800',
    flex: 1,
  },
  bannerStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    gap: 12,
    minHeight: 38,
  },
  bannerPersonal: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  bannerPersonalDot: {
    width: 7, height: 7, borderRadius: 4,
    backgroundColor: colors.accent,
  },
  bannerPersonalText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  bannerSpik: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: SECTIONS.spik.light,
  },
  bannerSpikLabel: {
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1.5,
    color: SECTIONS.spik.color,
  },
  bannerSpikWord: {
    fontSize: 13,
    fontWeight: '900',
    color: SECTIONS.spik.color,
    fontStyle: 'italic',
  },
  bannerSpikMeaning: {
    fontSize: 11,
    color: colors.textMuted,
    maxWidth: 140,
  },

  // Greeting
  greetingWrap: { paddingHorizontal: spacing.lg },
  greetingTitle: {
    fontSize: 30,
    color: colors.textPrimary,
    letterSpacing: -0.5,
  },
  greetingStatus: {
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: 2,
  },

  // Row chrome
  row: { gap: spacing.sm },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
  },
  rowTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: colors.textPrimary,
    letterSpacing: -0.2,
  },
  rowAction: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.accent,
  },

  // Event cards
  eventCardCompact: {
    width: 200,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 6,
  },
  eventCardFull: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 8,
  },
  eventDayChip: {
    backgroundColor: SECTIONS.events.light,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    alignSelf: 'flex-start',
  },
  eventDayChipText: {
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.6,
    color: SECTIONS.events.color,
  },
  eventCardTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  eventCardMeta: {
    fontSize: 12,
    color: colors.textMuted,
  },

  // Work card
  workCard: {
    marginHorizontal: spacing.lg,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  workColumns: { flexDirection: 'row', gap: spacing.sm },
  workDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(0,0,0,0.15)',
  },
  workColLabel: {
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1,
    color: SECTIONS.shifts.color,
    marginBottom: 2,
  },
  workItem: { gap: 1 },
  workItemTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  workItemMeta: {
    fontSize: 12,
    color: colors.textSecondary,
  },

  // Notices
  noticeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  noticeDot: {
    width: 10, height: 10, borderRadius: 5,
  },
  noticeTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  noticeMeta: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 1,
  },

  // Games
  gameCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  gameTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: '#fff',
    letterSpacing: -0.3,
  },
  gameSub: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.9)',
    marginTop: 2,
    fontWeight: '500',
  },
  gamePlay: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
  },

  // For you
  foryouTile: {
    width: 140,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 6,
  },
  foryouIcon: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  foryouLabel: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  foryouSub: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 16,
  },
});
