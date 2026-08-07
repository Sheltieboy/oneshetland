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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, Image, ImageBackground, Platform, Animated,
} from 'react-native';

// OneShetland brand mark (transparent rings) used in the top app header.
const LOGO = require('@/assets/logo-mark-keyed.png');
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect, Stack } from 'expo-router';
import { FontAwesome5, Ionicons } from '@expo/vector-icons';
import { SECTIONS, SectionKey } from '@/constants/sections';
import { NAV, PROFILE, type NavDest } from '@/constants/nav-model';
import { colors, spacing, radius, fontSize } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { GameArt } from '@/components/GameArt';
import { Skeleton } from '@/components/ui/Skeleton';
import { FeaturedBusinessesBar } from '@/components/FeaturedBusinessesBar';
import { BrushAccent } from '@/components/Brush';
import { CruiseTodayCard } from '@/components/CruiseTodayCard';
import { getCruiseHomeCard, type CruiseHomeCard } from '@/lib/cruise-api';
import { TodayAtAGlance } from '@/components/TodayAtAGlance';
import { ShetlandTodayCard } from '@/components/ShetlandTodayCard';
import { NearbyDealsTicker } from '@/components/NearbyDealsTicker';
import { NotificationBell } from '@/components/NotificationBell';
import { useAuth } from '@/context/AuthContext';

import DisplayText from '@/components/DisplayText';
import AlertPill from '@/components/AlertPill';

import { fetchActiveAlerts, type PartnerAlert } from '@/lib/alerts-api';
import { supabase } from '@/lib/supabase';
import { fetchWalletBalance, formatPence, fetchFeaturedBusinesses, CATEGORY_ICONS, CATEGORY_LABELS, type LocalBusiness } from '@/lib/local-api';
import { SAMPLE_URGENT_NOTICE, SampleEvent } from '@/lib/seed-content';
import {
  fetchHomeEvents, fetchHomeNotices, fetchHomeJobs, fetchHomeShifts,
  fetchTodaysSpik, fetchNearbyOffers,
  HomeEvent, HomeNotice, HomeJob, HomeShift, NearbyOffer, SpikDaily,
} from '@/lib/concierge-api';
import { loadSavedBoats, loadRecentBoats, VesselStub } from '@/lib/boats-prefs';
import { fetchHomeData, type HomeData } from '@/lib/home-data';
import { fetchFreshProducts, type FreshProduct } from '@/lib/products-api';
import * as Haptics from 'expo-haptics';
import { cachedAudience, saveAudience, type Audience } from '@/lib/audience';
import {
  bumpSectionEngagement, getRecentEngagement, EngagementKey, EngagementEntry,
} from '@/lib/engagement';

// Soft-load expo-location so a missing dep gracefully degrades.
let Location: any = null;
try { Location = require('expo-location'); } catch { Location = null; }

// ──────────────────────────────────────────────────────────────────────────
// Hero background images — keyed by time-of-day + weather condition
// ──────────────────────────────────────────────────────────────────────────

type HeroKey =
  | 'day-sunny' | 'day-calm' | 'day-rainy' | 'day-windy'
  | 'night-clear' | 'night-rain' | 'night-windy';

const HERO_IMAGES: Record<HeroKey, any> = {
  'day-sunny':    require('@/assets/context-background-images/60-hero-day-sunny.webp'),
  'day-calm':     require('@/assets/context-background-images/60-hero-day-calm.webp'),
  'day-rainy':    require('@/assets/context-background-images/60-hero-day-rainy.webp'),
  'day-windy':    require('@/assets/context-background-images/60-hero-day-windy.webp'),
  'night-clear':  require('@/assets/context-background-images/60-hero-night-clear.webp'),
  'night-rain':   require('@/assets/context-background-images/60-hero-night-rain.webp'),
  'night-windy':  require('@/assets/context-background-images/60-night-windy.webp'),
};

// Open-Meteo free API — no key required. Lerwick, Shetland.
async function fetchShetlandWeather(): Promise<{ code: number; windKph: number } | null> {
  try {
    const res = await fetch(
      'https://api.open-meteo.com/v1/forecast?latitude=60.154&longitude=1.145&current=weather_code,wind_speed_10m&timezone=auto',
      { signal: AbortSignal.timeout(4000) },
    );
    if (!res.ok) return null;
    const json = await res.json();
    return {
      code:    json.current?.weather_code ?? 0,
      windKph: json.current?.wind_speed_10m ?? 0,
    };
  } catch {
    return null;
  }
}

function pickHeroImage(weather: { code: number; windKph: number } | null): HeroKey {
  const h = new Date().getHours();
  const isNight = h >= 21 || h < 6;
  const code = weather?.code ?? -1;
  const windy = (weather?.windKph ?? 0) > 35;
  const rainy = code >= 51 && code <= 99 && code !== 70 && code !== 71
    && code !== 72 && code !== 73 && code !== 74 && code !== 75 && code !== 76 && code !== 77;

  if (isNight) {
    if (rainy)  return 'night-rain';
    if (windy)  return 'night-windy';
    return 'night-clear';
  }
  if (rainy)    return 'day-rainy';
  if (windy)    return 'day-windy';
  if (code === 0) return 'day-sunny';
  return 'day-calm';
}

// (Removed: dead TopBanner component — it was never rendered; the home banner
//  is HeroSection. It referenced ~11 styles that don't exist.)

// ──────────────────────────────────────────────────────────────────────────
// Greeting
// ──────────────────────────────────────────────────────────────────────────

function timeGreeting(): string {
  const h = new Date().getHours();
  if (h < 5)  return 'Up late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
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

/**
 * Each row sports the section's identity — a coloured icon medallion,
 * a coloured "See all" link, and the cards underneath pick up a section-
 * coloured top accent (handled per-row in their own styles).
 */
function SectionRow({
  title, subtitle, action, sectionKey, color, children,
}: {
  title:       string;
  subtitle?:   string;
  action?:     { label: string; onPress: () => void };
  sectionKey?: SectionKey;
  color?:      string;
  children:    React.ReactNode;
}) {
  const accent = color ?? (sectionKey ? SECTIONS[sectionKey].color : colors.navy);
  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <BrushAccent color={accent} />
        <View style={{ flexShrink: 1 }}>
          <Text style={styles.rowTitle}>{title}</Text>
          {subtitle ? <Text style={styles.rowSubtitle}>{subtitle}</Text> : null}
        </View>
        <View style={{ flex: 1 }} />
        {action ? (
          <TouchableOpacity onPress={action.onPress} hitSlop={10} style={styles.rowActionBtn}>
            <Text style={[styles.rowAction, { color: accent }]}>{action.label}</Text>
            <FontAwesome5 name="chevron-right" size={9} color={accent} />
          </TouchableOpacity>
        ) : null}
      </View>
      {children}
    </View>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Hero section — full-bleed Shetland image + greeting + SPIK + alerts
// ──────────────────────────────────────────────────────────────────────────

function HeroSection({
  name, spik, urgent, heroKey,
}: {
  name:    string | null;
  spik:    SpikDaily;
  urgent:  HomeNotice | null;
  heroKey: HeroKey;
}) {
  const router   = useRouter();
  const { profile } = useAuth();
  const insets   = useSafeAreaInsets();
  const { screenHeight, isTablet } = useAppLayout();

  // Live wallet balance shown beside the wallet icon. Refreshes whenever Home
  // regains focus (e.g. after a top-up), and clears when signed out.
  const [walletPence, setWalletPence] = useState<number | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (!profile?.id) { setWalletPence(null); return; }
      fetchWalletBalance(profile.id).then(setWalletPence).catch(() => {});
    }, [profile?.id]),
  );

  const initials = profile?.full_name
    ? profile.full_name.trim().split(/\s+/).slice(0, 2).map((w: string) => w[0]).join('').toUpperCase()
    : '?';

  const today = new Date();
  const dateStr = today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  // Lean navy header — greeting + search + account actions in one row. The
  // brand is already in the sidebar, and the weather now lives in the wide
  // Shetland Today hero card below, so the header stays calm and compact.
  return (
    <View style={styles.hero}>
      <View style={[styles.heroContent, { paddingTop: insets.top + 10 }]}>
        <View style={styles.heroLeanRow}>
          {/* Greeting + date + wird o' da day */}
          <View style={styles.heroLeanGreeting}>
            <DisplayText weight="black" style={styles.heroGreetingTitle}>
              {`${timeGreeting()}${name ? `, ${name.split(' ')[0]}` : ''}`}
            </DisplayText>
            <View style={styles.heroLeanDateRow}>
              <Text style={styles.heroDate}>{dateStr}</Text>
              {spik.word && spik.word !== '…' ? (
                <TouchableOpacity style={styles.heroWirdChip} onPress={() => router.push('/(tabs)/spik')} activeOpacity={0.85}>
                  <Text style={styles.spikChipLabel}>WIRD</Text>
                  <Text style={styles.heroWirdWord} numberOfLines={1}>{spik.word}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>

          {/* Search — fills the middle */}
          <TouchableOpacity
            style={styles.heroSearchWide}
            onPress={() => router.push('/search')}
            activeOpacity={0.85}
            accessibilityLabel="Search"
          >
            <FontAwesome5 name="search" size={15} color={colors.textMuted} />
            <Text style={styles.heroSearchText} numberOfLines={1}>Search Shetland — businesses, events, the fleet…</Text>
          </TouchableOpacity>

          {/* Account actions */}
          <View style={styles.heroHeaderActions}>
            <NotificationBell />
            <TouchableOpacity
              style={styles.walletBtn}
              onPress={() => router.push('/local-wallet')}
              activeOpacity={0.8}
              hitSlop={8}
              accessibilityLabel="My Wallet"
            >
              <FontAwesome5 name="wallet" size={13} color={colors.navy} solid />
              {walletPence != null && (
                <Text style={styles.walletBtnText}>
                  {walletPence % 100 === 0 ? `£${Math.round(walletPence / 100)}` : formatPence(walletPence)}
                </Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.profileAvatar}
              onPress={() => router.push('/(tabs)/me')}
              activeOpacity={0.8}
              hitSlop={8}
              accessibilityLabel="My profile"
              accessibilityRole="button"
            >
              <Text style={styles.profileAvatarText}>{initials}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {urgent ? (
          <TouchableOpacity
            style={[styles.urgentChip, { marginTop: spacing.md, alignSelf: 'flex-start' }]}
            onPress={() => router.push('/(tabs)/whats-on')}
            activeOpacity={0.85}
          >
            <FontAwesome5 name="exclamation-triangle" size={10} color="#fff" solid />
            <Text style={styles.urgentChipText} numberOfLines={1}>{urgent.title}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Phone collapsing header — brand row stays pinned; the welcome (greeting +
// date + SPIK) collapses on scroll so the search pill docks up under the brand.
// ──────────────────────────────────────────────────────────────────────────

function HomeHeader({ name, spik, urgent, scrollY }: {
  name:    string | null;
  spik:    SpikDaily;
  urgent:  HomeNotice | null;
  scrollY: Animated.Value;
}) {
  const router = useRouter();
  const { profile } = useAuth();
  const insets = useSafeAreaInsets();

  const [walletPence, setWalletPence] = useState<number | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (!profile?.id) { setWalletPence(null); return; }
      fetchWalletBalance(profile.id).then(setWalletPence).catch(() => {});
    }, [profile?.id]),
  );

  const initials = profile?.full_name
    ? profile.full_name.trim().split(/\s+/).slice(0, 2).map((w: string) => w[0]).join('').toUpperCase()
    : '?';

  const today = new Date();
  const dateStr = today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  // Measure the welcome block once, then collapse its height + fade it on scroll.
  const [greetH, setGreetH] = useState(0);
  const collapse = greetH > 0 ? greetH : 130;
  const greetingHeight = scrollY.interpolate({
    inputRange: [0, collapse],
    outputRange: [greetH || 130, 0],
    extrapolate: 'clamp',
  });
  const greetingOpacity = scrollY.interpolate({
    inputRange: [0, collapse * 0.6],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  return (
    <View style={styles.hero}>
      <View style={[styles.heroContent, { paddingTop: insets.top + 10 }]}>
        {/* Mark + wordmark + actions — always pinned. The tagline is gone (it's
            marketing copy for someone who hasn't installed it), but the name
            stays so the header still reads as OneShetland. */}
        <View style={styles.heroTopRow}>
          <View style={styles.heroLogoMedallion}>
            <Image source={LOGO} style={styles.heroLogo} resizeMode="contain" />
          </View>
          <DisplayText weight="black" style={styles.heroBrand} numberOfLines={1}>OneShetland</DisplayText>
          <View style={{ flex: 1 }} />
          <View style={styles.heroHeaderActions}>
            <TouchableOpacity style={styles.walletBtn} onPress={() => router.push('/local-wallet')} activeOpacity={0.8} hitSlop={8} accessibilityLabel="My Wallet">
              <FontAwesome5 name="wallet" size={13} color="#fff" solid />
              {walletPence != null && (
                <Text style={styles.walletBtnText}>
                  {walletPence % 100 === 0 ? `£${Math.round(walletPence / 100)}` : formatPence(walletPence)}
                </Text>
              )}
            </TouchableOpacity>
            <NotificationBell size={38} />
            <TouchableOpacity style={styles.profileAvatar} onPress={() => router.push('/(tabs)/me')} activeOpacity={0.8} hitSlop={8}>
              <Text style={styles.profileAvatarText}>{initials}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Collapsing welcome — greeting + date + SPIK */}
        <Animated.View style={[styles.heroCollapse, { opacity: greetingOpacity }, greetH > 0 ? { height: greetingHeight } : null]}>
          <View onLayout={e => { const h = Math.round(e.nativeEvent.layout.height); if (h > 0 && greetH === 0) setGreetH(h); }}>
            <View style={styles.heroGreeting}>
              <DisplayText weight="black" style={styles.heroGreetingTitle}>
                {`${timeGreeting()}${name ? `, ${name.split(' ')[0]}` : ''}`}
              </DisplayText>
              {/* Date + SPIK on one line — SPIK styled lightly like the date, word stands out */}
              <View style={styles.heroDateRow}>
                <Text style={styles.heroDate}>{dateStr}</Text>
                <View style={styles.heroDateDivider} />
                <TouchableOpacity style={styles.spikInline} onPress={() => router.push('/(tabs)/spik')} activeOpacity={0.8} hitSlop={6}>
                  <Text style={styles.spikInlineLabel}>SPIK</Text>
                  <Text style={styles.spikInlineWord}>{spik.word}</Text>
                  {spik.meaning ? <Text style={styles.spikInlineMeaning} numberOfLines={1}>· {spik.meaning}</Text> : null}
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Animated.View>

        {/* Search — persistent; docks under the mark row as the welcome collapses.
            The bell now lives up in the actions row, so this runs full width. */}
        <View style={styles.heroSearchRow}>
          <TouchableOpacity style={[styles.heroSearchFull, { flex: 1 }]} onPress={() => router.push('/search')} activeOpacity={0.85} accessibilityLabel="Search">
            <FontAwesome5 name="search" size={15} color={colors.textMuted} />
            <Text style={styles.heroSearchText} numberOfLines={1}>Search Shetland…</Text>
          </TouchableOpacity>
        </View>

        {/* Deals near you — docked to the bottom of the header, opens a drawer. */}
        <NearbyDealsTicker variant="onDark" style={{ marginTop: spacing.sm }} />

        {urgent ? (
          <TouchableOpacity style={[styles.urgentChip, { marginTop: spacing.sm, alignSelf: 'flex-start' }]} onPress={() => router.push('/(tabs)/whats-on')} activeOpacity={0.85}>
            <FontAwesome5 name="exclamation-triangle" size={10} color="#fff" solid />
            <Text style={styles.urgentChipText} numberOfLines={1}>{urgent.title}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Explore OneShetland — persistent sections grid
// ──────────────────────────────────────────────────────────────────────────

/**
 * A scannable grid of every destination in the app, so older / non-technical
 * users can discover the sections hidden behind the phone "More" sheet (Fetch,
 * Hubs, Spik, Aald Memories, Da Boats, Games, Cruise, Profile, …) rather than
 * relying on the 5-slot bottom bar. Renders from the single nav-model source of
 * truth (NAV + PROFILE) so it can never drift from the rest of navigation.
 * Visual reference: the MoreSheet tiles in components/AppTabBar.tsx.
 */
// Sections grouped into a few human themes — feels curated, not a launcher grid.
// Labels must match the nav-model labels exactly (single source of truth).
// Explore surfaces the sections that AREN'T on the bottom bar (What's On, Local,
// Jobs, Directory all live there already). Da Boats sits in Community & culture.
// Profile is omitted — it's the avatar in the header. Fetch gets its own
// full-width card below the grid (rendered separately).
const EXPLORE_GROUPS: { title: string; labels: string[] }[] = [
  { title: 'Community & culture', labels: ['Spik', 'Games', 'Hubs', 'Aald Memories', 'Da Boats', 'Cruise'] },
];

/**
 * Same cards, visitor order: the dialect, the boats and the cruise calls are
 * what someone new to Shetland actually opens; Hubs is a members' thing.
 * Nothing is added or removed — only the order within the group.
 */
const EXPLORE_GROUPS_VISITING: { title: string; labels: string[] }[] = [
  { title: 'Community & culture', labels: ['Spik', 'Cruise', 'Da Boats', 'Aald Memories', 'Games', 'Hubs'] },
];

interface ExploreLive { lkBoats?: number; stories?: number; runs?: number; runRoute?: string }

// Short live/static caption under each Explore card — the bit of depth that
// stops it feeling like a flat menu.
function exploreCaption(label: string, live: ExploreLive, spikWord?: string): string {
  switch (label) {
    case 'Da Boats':     return live.lkBoats != null ? `${live.lkBoats} LK boats`        : 'Vessel heritage';
    case 'Aald Memories': return live.stories != null ? `${live.stories} stories`         : 'Living memory';
    case 'Fetch':        return live.runs ? `${live.runs} run${live.runs === 1 ? '' : 's'} on now` : 'Get it delivered';
    case 'Spik':         return spikWord && spikWord !== '…' ? `Wird: ${spikWord}`       : 'Shetland dialect';
    case 'Games':        return 'Play & compete';
    case 'Hubs':         return 'Community groups';
    case 'Cruise':       return 'Ships & visitors';
    case 'Profile':      return 'Account & wallet';
    default:             return '';
  }
}

function ExploreGrid({ spikWord, audience }: { spikWord?: string; audience: Audience }) {
  const router = useRouter();
  const items: NavDest[] = [...NAV.filter(d => d.label !== 'Home'), PROFILE];
  const byLabel = (label: string) => items.find(d => d.label === label);

  // Live counts for the Da Boats / Aald Memories / Fetch captions. Each is
  // independent — one failure just falls back to its static caption.
  const [live, setLive] = useState<ExploreLive>({});
  useEffect(() => {
    let active = true;
    (async () => {
      const nowIso = new Date().toISOString();
      const [boats, stories, runs] = await Promise.allSettled([
        supabase.rpc('count_lk_vessels'),
        supabase.from('memories').select('id', { count: 'exact', head: true })
          .eq('visibility', 'public').is('parent_id', null),
        // "Live" runs = open and not yet finished (includes ones scheduled for later today/this week).
        // Pull the route of the soonest one for the "from → to" caption.
        supabase.from('runs')
          .select('id, origin:regions!runs_origin_region_id_fkey(name), destination:regions!runs_destination_region_id_fkey(name)')
          .eq('status', 'open').gte('departure_end', nowIso)
          .order('departure_start', { ascending: true }),
      ]);
      if (!active) return;
      const next: ExploreLive = {};
      if (boats.status === 'fulfilled' && typeof boats.value.data === 'number') next.lkBoats = boats.value.data;
      if (stories.status === 'fulfilled') next.stories = stories.value.count ?? 0;
      if (runs.status === 'fulfilled') {
        const rows = (runs.value.data ?? []) as any[];
        next.runs = rows.length;
        const first = rows[0];
        if (first) {
          const o = Array.isArray(first.origin) ? first.origin[0] : first.origin;
          const d = Array.isArray(first.destination) ? first.destination[0] : first.destination;
          if (o?.name && d?.name) next.runRoute = `${o.name} → ${d.name}`;
        }
      }
      setLive(next);
    })().catch(() => {});
    return () => { active = false; };
  }, []);

  return (
    <SectionRow title="Explore OneShetland">
      <View style={styles.exploreGroups}>
        {(audience === 'visiting' ? EXPLORE_GROUPS_VISITING : EXPLORE_GROUPS).map(group => (
          <View key={group.title} style={styles.exploreGroup}>
            <DisplayText weight="bold" style={styles.exploreGroupTitle}>{group.title}</DisplayText>
            <View style={styles.exploreGrid}>
              {group.labels.map(label => {
                const item = byLabel(label);
                if (!item) return null;
                return (
                  <View key={item.label} style={styles.exploreCardWrap}>
                    <TouchableOpacity
                      style={[styles.exploreCard, { backgroundColor: item.color }]}
                      onPress={() => router.push(item.href)}
                      activeOpacity={0.85}
                      accessibilityLabel={item.label}
                    >
                      {/* Card is the section colour; icon + text in white. Da Boats
                          uses a small-boat icon, not the cruise ship. */}
                      {item.label === 'Da Boats'
                        ? <Ionicons name="boat" size={20} color="#fff" />
                        : <FontAwesome5 name={item.icon as any} size={18} color="#fff" solid />}
                      <Text style={styles.exploreCardName} numberOfLines={1}>{item.label}</Text>
                      <Text style={styles.exploreCardCaption} numberOfLines={1}>
                        {exploreCaption(item.label, live, spikWord)}
                      </Text>
                    </TouchableOpacity>
                  </View>
                );
              })}
            </View>
          </View>
        ))}

        {/* Fetch — full-width feature card with live run count. */}
        {(() => {
          const fetchItem = byLabel('Fetch');
          if (!fetchItem) return null;
          const runs = live.runs ?? 0;
          return (
            <TouchableOpacity
              style={[styles.exploreFetchCard, { backgroundColor: fetchItem.color }]}
              onPress={() => router.push(fetchItem.href)}
              activeOpacity={0.85}
              accessibilityLabel="Fetch"
            >
              <FontAwesome5 name={fetchItem.icon as any} size={22} color="#fff" solid />
              <View style={{ flex: 1 }}>
                <Text style={styles.exploreFetchName}>Fetch</Text>
                <Text style={styles.exploreFetchCaption} numberOfLines={1}>
                  {runs > 0
                    ? (live.runRoute
                        ? `${live.runRoute}${runs > 1 ? `  +${runs - 1} more` : ''}`
                        : `${runs} run${runs === 1 ? '' : 's'} live now`)
                    : 'Get anything delivered across Shetland'}
                </Text>
              </View>
              <FontAwesome5 name="chevron-right" size={13} color="rgba(255,255,255,0.9)" />
            </TouchableOpacity>
          );
        })()}
      </View>
    </SectionRow>
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

function ComingUpRow({ events }: { events: HomeEvent[] }) {
  const router = useRouter();
  const upcoming = useMemo(() => {
    // All upcoming events (featured first, then soonest), not just this week —
    // an image-led carousel that always showcases what's on in Shetland.
    const now = Date.now();
    return events
      .filter(e => new Date(e.starts_at).getTime() >= now - 12 * 3_600_000) // include today
      .sort((a, b) => {
        if ((b.is_featured ? 1 : 0) !== (a.is_featured ? 1 : 0)) return (b.is_featured ? 1 : 0) - (a.is_featured ? 1 : 0);
        return new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime();
      });
  }, [events]);

  const goToEvent = (e: HomeEvent) => {
    if (e.source === 'db') {
      router.push({ pathname: '/events/[id]', params: { id: e.id } });
    } else {
      router.push('/(tabs)/whats-on');
    }
  };

  const EC = SECTIONS.events.color;

  return (
    <SectionRow
      title={SECTIONS.events.label}
      sectionKey="events"
      action={{ label: 'See all', onPress: () => router.push('/(tabs)/whats-on') }}
    >
      {upcoming.length === 0 ? (
        <TouchableOpacity
          style={styles.eventsEmpty}
          onPress={() => router.push('/(tabs)/whats-on')}
          activeOpacity={0.8}
        >
          <View style={[styles.eventsEmptyIcon, { backgroundColor: EC + '18' }]}>
            <FontAwesome5 name="calendar-alt" size={22} color={EC} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.eventsEmptyTitle}>No events listed yet</Text>
            <Text style={styles.eventsEmptyDetail}>Tap to browse all upcoming events in Shetland</Text>
          </View>
          <FontAwesome5 name="chevron-right" size={11} color={colors.textMuted} />
        </TouchableOpacity>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: spacing.sm, paddingHorizontal: spacing.lg }}
        >
          {upcoming.slice(0, 8).map(e => (
            <EventCardCompact key={e.id} event={e} onPress={() => goToEvent(e)} />
          ))}
        </ScrollView>
      )}
    </SectionRow>
  );
}

function EventCardCompact({ event, onPress }: { event: SampleEvent & { source?: string }; onPress: () => void }) {
  const router = useRouter();
  const { cardWidth } = useAppLayout();
  const { day, time } = fmtEventDay(event.starts_at);
  const EC = SECTIONS.events.color;
  const isDb = (event as any).source === 'db';
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={[styles.eventCardCompact, { width: cardWidth(0.46) }]}>
      {event.cover_url ? (
        <Image
          source={{ uri: event.cover_url }}
          style={styles.eventCardCompactImage}
          resizeMode="cover"
        />
      ) : (
        <View style={[styles.eventCardCompactImage, styles.eventCardCompactImagePlaceholder]}>
          <FontAwesome5 name="calendar-alt" size={22} color={EC} />
        </View>
      )}
      {event.is_featured && (
        <View style={styles.eventFeaturedBadge}>
          <Text style={styles.eventFeaturedBadgeText}>Featured</Text>
        </View>
      )}
      <View style={{ padding: spacing.sm, gap: 4 }}>
        <View style={styles.eventDayChip}>
          <Text style={styles.eventDayChipText}>{day.toUpperCase()}</Text>
        </View>
        <Text style={styles.eventCardTitle} numberOfLines={2}>{event.title}</Text>
        <Text style={styles.eventCardMeta} numberOfLines={1}>{time}  ·  {event.venue}</Text>
        {event.price_text && (
          <Text style={[styles.eventCardMeta, { color: EC, fontWeight: '700' }]} numberOfLines={1}>
            {event.price_text}
          </Text>
        )}
        {isDb && event.has_tickets && (
          <TouchableOpacity
            style={styles.eventTicketBtn}
            // Route to the event detail page (not straight to checkout) so the
            // organiser payout-readiness gate + messaging apply before any sale.
            onPress={e => { e.stopPropagation?.(); router.push({ pathname: '/events/[id]', params: { id: event.id } }); }}
            activeOpacity={0.85}
          >
            <FontAwesome5 name="ticket-alt" size={9} color="#fff" solid />
            <Text style={styles.eventTicketBtnText}>Get tickets</Text>
          </TouchableOpacity>
        )}
      </View>
    </TouchableOpacity>
  );
}

function EventCardFull({ event, onPress }: { event: SampleEvent & { source?: string }; onPress: () => void }) {
  const router = useRouter();
  const { day, time } = fmtEventDay(event.starts_at);
  const EC = SECTIONS.events.color;
  const isDb = (event as any).source === 'db';
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={styles.eventCardFull}>
      {event.cover_url && (
        <Image
          source={{ uri: event.cover_url }}
          style={styles.eventCardFullImage}
          resizeMode="cover"
        />
      )}
      <View style={{ padding: spacing.md, gap: 6 }}>
        {event.is_featured && (
          <View style={[styles.eventFeaturedBadge, { alignSelf: 'flex-start' }]}>
            <Text style={styles.eventFeaturedBadgeText}>Featured</Text>
          </View>
        )}
        <View style={[styles.eventDayChip, { alignSelf: 'flex-start' }]}>
          <Text style={styles.eventDayChipText}>{day.toUpperCase()}  ·  {time}</Text>
        </View>
        <Text style={[styles.eventCardTitle, { fontSize: 18 }]} numberOfLines={2}>{event.title}</Text>
        <Text style={styles.eventCardMeta}>{event.venue}  ·  {event.category}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
          {event.price_text ? (
            <Text style={[styles.eventCardMeta, { color: EC, fontWeight: '700' }]}>
              {event.price_text}
            </Text>
          ) : <View />}
          {isDb && event.has_tickets && (
            <TouchableOpacity
              style={styles.eventTicketBtn}
              // Route to the event detail page (not straight to checkout) so the
              // organiser payout-readiness gate + messaging apply before any sale.
              onPress={e => { e.stopPropagation?.(); router.push({ pathname: '/events/[id]', params: { id: event.id } }); }}
              activeOpacity={0.85}
            >
              <FontAwesome5 name="ticket-alt" size={9} color="#fff" solid />
              <Text style={styles.eventTicketBtnText}>Get tickets</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Work in Shetland
// ──────────────────────────────────────────────────────────────────────────

function WorkRow({ jobs, shifts }: { jobs: HomeJob[]; shifts: HomeShift[] }) {
  const router = useRouter();
  const { cardWidth } = useAppLayout();
  const SC = SECTIONS.shifts.color;
  const all: Array<{ id: string; title: string; sub: string; tag: string }> = [
    ...jobs.map(j => ({ id: j.id, title: j.title, sub: `${j.employer}  ·  ${j.pay}`, tag: 'JOB' })),
    ...shifts.map(s => ({ id: s.id, title: s.title, sub: `${s.when}  ·  ${s.pay}`, tag: 'SHIFT' })),
  ];
  return (
    <SectionRow
      title="Work"
      sectionKey="shifts"
      action={{ label: 'See all', onPress: () => router.push('/(tabs)/jobs') }}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: spacing.lg, gap: spacing.sm }}
      >
        {all.map(item => (
          <TouchableOpacity
            key={item.id}
            style={[styles.workTile, { width: cardWidth(0.38) }]}
            onPress={() => router.push('/(tabs)/jobs')}
            activeOpacity={0.85}
          >
            <View style={[styles.workTileTag, { backgroundColor: SC + '18', borderColor: SC + '40' }]}>
              <Text style={[styles.workTileTagText, { color: SC }]}>{item.tag}</Text>
            </View>
            <Text style={styles.workTileTitle} numberOfLines={2}>{item.title}</Text>
            <Text style={styles.workTileSub} numberOfLines={1}>{item.sub}</Text>
          </TouchableOpacity>
        ))}
        {/* "More" tile */}
        <TouchableOpacity
          style={[styles.workTile, styles.workTileMore, { width: cardWidth(0.38), borderColor: SC + '40' }]}
          onPress={() => router.push('/(tabs)/jobs')}
          activeOpacity={0.85}
        >
          <FontAwesome5 name="briefcase" size={20} color={SC} />
          <Text style={[styles.workTileMoreText, { color: SC }]}>See all</Text>
        </TouchableOpacity>
      </ScrollView>
    </SectionRow>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Around Shetland — events + work + featured local, merged into one
// scannable vertical list (replaces three separate carousels).
// ──────────────────────────────────────────────────────────────────────────

interface HappeningItem {
  key: string; tag: string; icon: string; color: string;
  title: string; sub: string; onPress: () => void;
}

/** Interleave several lists round-robin so the feed mixes types for variety. */
function roundRobin<T>(lists: T[][]): T[] {
  const out: T[] = [];
  const max = Math.max(0, ...lists.map(l => l.length));
  for (let i = 0; i < max; i++) {
    for (const l of lists) { if (l[i] !== undefined) out.push(l[i]); }
  }
  return out;
}

function HappeningRow({ events, jobs, shifts, businesses }: {
  events: HomeEvent[]; jobs: HomeJob[]; shifts: HomeShift[]; businesses: LocalBusiness[];
}) {
  const router = useRouter();
  const now = Date.now();

  const eventItems: HappeningItem[] = events
    .filter(e => new Date(e.starts_at).getTime() >= now - 12 * 3_600_000)
    .slice(0, 4)
    .map(e => {
      const { day, time } = fmtEventDay(e.starts_at);
      return {
        key: `ev-${e.id}`, tag: 'EVENT', icon: 'calendar-alt', color: SECTIONS.events.color,
        title: e.title, sub: `${day}  ·  ${time}${e.venue ? `  ·  ${e.venue}` : ''}`,
        onPress: () => (e as any).source === 'db'
          ? router.push({ pathname: '/events/[id]', params: { id: e.id } } as any)
          : router.push('/(tabs)/whats-on'),
      };
    });

  const workItems: HappeningItem[] = [
    ...jobs.slice(0, 2).map(j => ({
      key: `jb-${j.id}`, tag: 'JOB', icon: 'briefcase', color: SECTIONS.jobs.color,
      title: j.title, sub: `${j.employer}  ·  ${j.pay}`,
      onPress: () => router.push('/(tabs)/jobs'),
    })),
    ...shifts.slice(0, 2).map(s => ({
      key: `sh-${s.id}`, tag: 'SHIFT', icon: 'briefcase', color: SECTIONS.shifts.color,
      title: s.title, sub: `${s.when}  ·  ${s.pay}`,
      onPress: () => router.push('/(tabs)/jobs?tab=shifts'),
    })),
  ];

  const bizItems: HappeningItem[] = businesses.slice(0, 3).map(b => ({
    key: `bz-${b.id}`, tag: 'LOCAL', icon: (CATEGORY_ICONS[b.category] ?? 'store'),
    color: SECTIONS.local.color,
    title: b.name, sub: CATEGORY_LABELS[b.category] ?? 'Local business',
    onPress: () => router.push(`/local-business-detail?id=${b.id}`),
  }));

  const items = roundRobin([eventItems, workItems, bizItems]).slice(0, 6);
  if (items.length === 0) return null;

  return (
    <SectionRow title="Around Shetland">
      <View style={styles.happeningCard}>
        {items.map((it, i) => (
          <TouchableOpacity
            key={it.key}
            style={[styles.happeningRow, i < items.length - 1 && styles.happeningRowBorder]}
            onPress={it.onPress}
            activeOpacity={0.7}
          >
            <FontAwesome5 name={it.icon as any} size={16} color={it.color} solid style={{ width: 22, textAlign: 'center' }} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.happeningTitle} numberOfLines={1}>{it.title}</Text>
              <Text style={styles.happeningSub} numberOfLines={1}>{it.sub}</Text>
            </View>
            <Text style={[styles.happeningTag, { color: it.color }]}>{it.tag}</Text>
            <FontAwesome5 name="chevron-right" size={11} color={colors.textLight} />
          </TouchableOpacity>
        ))}
      </View>
    </SectionRow>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Notices
// ──────────────────────────────────────────────────────────────────────────

function NoticesRow({ notices }: { notices: HomeNotice[] }) {
  const router = useRouter();
  const list = notices.slice(0, 3);

  return (
    <SectionRow
      title="Local Notices"
      sectionKey="notices"
      action={{ label: 'See all', onPress: () => router.push('/notices') }}
    >
      <View style={{ paddingHorizontal: spacing.lg, gap: 2 }}>
        {list.map((n, idx) => {
          const isUrgent = n.severity === 'urgent';
          const accent = (n.brand_color && /^#?[0-9a-fA-F]{6}/.test(n.brand_color))
            ? (n.brand_color.startsWith('#') ? n.brand_color : `#${n.brand_color}`)
            : SECTIONS.community.color;
          const c = n.campaign && n.campaign.status === 'active' ? n.campaign : null;
          const pct = c && c.goal_pence > 0 ? Math.min(1, c.raised_pence / c.goal_pence) : 0;
          const open = () => {
            if (n.campaign_id) router.push(`/hub-campaign?id=${n.campaign_id}` as any);
            else if (n.hub_id) router.push(`/hubs/${n.hub_id}` as any);
            else router.push('/(tabs)/whats-on');
          };
          return (
            <TouchableOpacity
              key={n.id}
              onPress={open}
              activeOpacity={0.8}
              style={[
                styles.noticeRow,
                idx === 0 && styles.noticeRowFirst,
                idx === list.length - 1 && styles.noticeRowLast,
              ]}
            >
              <View style={[styles.noticeLogo, { backgroundColor: accent }]}>
                {n.logo_url
                  ? <Image source={{ uri: n.logo_url }} style={styles.noticeLogoImg} />
                  : <FontAwesome5 name={c ? 'hand-holding-heart' : 'bullhorn'} size={14} color="#fff" solid />}
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                {isUrgent && (<Text style={styles.noticeUrgentLabel}>URGENT</Text>)}
                <Text style={styles.noticeTitle} numberOfLines={2}>{n.title}</Text>
                <Text style={styles.noticeMeta} numberOfLines={1}>
                  {n.publisher}{n.locality ? `  ·  ${n.locality}` : ''}
                </Text>
                {c ? (
                  <View style={styles.noticeBarWrap}>
                    <View style={styles.noticeBarTrack}>
                      <View style={[styles.noticeBarFill, { width: `${Math.round(pct * 100)}%`, backgroundColor: accent }]} />
                    </View>
                    <View style={styles.noticeBarMeta}>
                      <Text style={styles.noticeBarText}>{formatPence(c.raised_pence)} of {formatPence(c.goal_pence)}</Text>
                      <Text style={[styles.noticeDonateLink, { color: accent }]} onPress={() => router.push(`/hub-donate?campaign=${c.id}` as any)}>Donate ›</Text>
                    </View>
                  </View>
                ) : null}
              </View>
              <FontAwesome5 name="chevron-right" size={10} color={colors.textMuted} />
            </TouchableOpacity>
          );
        })}

        {/* Community Hubs entry — clubs, groups & organisations */}
        <TouchableOpacity
          style={[styles.hubsLink, { borderColor: SECTIONS.community.color }]}
          onPress={() => router.push('/hubs')}
          activeOpacity={0.85}
        >
          <View style={[styles.hubsLinkIcon, { backgroundColor: SECTIONS.community.color }]}>
            <FontAwesome5 name="users" size={13} color="#fff" solid />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.hubsLinkTitle}>Community Hubs</Text>
            <Text style={styles.hubsLinkSub}>Clubs, groups & organisations in Shetland</Text>
          </View>
          <FontAwesome5 name="chevron-right" size={12} color={SECTIONS.community.color} />
        </TouchableOpacity>
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
    { gid: 'spik_sprint'   as const, title: 'Spik Sprint',   sub: '60 seconds. How many do you ken?', path: '/games' as const },
    { gid: 'guess_da_wird' as const, title: 'Guess Da Wird', sub: "Today's Shetlandic word.",          path: '/games/guess-da-wird' as const },
    { gid: 'map_it'        as const, title: 'Map It',        sub: "Drop a pin near today's place.",    path: '/games/map-it' as const },
    { gid: 'spik_snap'     as const, title: 'Spik Snap',     sub: 'Match the word to its meaning.',    path: '/games' as const },
  ][idx];

  return (
    <SectionRow
      title="Today's game"
      sectionKey="games"
      action={{ label: 'All games', onPress: () => router.push('/games') }}
    >
      <View style={{ paddingHorizontal: spacing.lg }}>
        <TouchableOpacity
          onPress={() => router.push(cfg.path)}
          activeOpacity={0.9}
          style={[styles.gameCard, { backgroundColor: SECTIONS.games.color }]}
        >
          <View style={styles.gameCardArt}>
            <GameArt id={cfg.gid} size={56} radius={14} />
          </View>
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
/**
 * Priority of the OneShetland universe (Darren, Aug 2026):
 *   businesses · What's On · Local · Work · Hubs · Fetch · Aald Memories ·
 *   Cruises · Spik · Da Boats
 * Used to rank the "For you" feed so the lightest-weight sections can't lead
 * it. Deliberately NOT used for navigation or section order.
 */
const SECTION_RANK: Partial<Record<SectionKey, number>> = {
  local: 1, services: 1,      // businesses + the Local section
  events: 2, notices: 2, news: 2,   // What's On, incl. alerts
  shifts: 4, jobs: 4,         // Work
  community: 5,               // Hubs
  fetch: 6,
  memories: 7,                // Aald Memories
  cruise: 8, tourism: 8,
  spik: 9, games: 9,
  daBoats: 10,
};

/**
 * The same feed, ranked for somebody who is here for a week rather than a
 * life. What's On and the shops lead; Work, Hubs and Fetch fall to the back
 * because a visitor can't take a shift or get a parcel run to their hotel.
 * Spik and Da Boats climb — they're the bits people find charming when
 * they're new to the place.
 *
 * Demotion only. Nothing is removed from the feed, and this touches no
 * navigation: every section stays exactly where it was.
 */
const SECTION_RANK_VISITING: Partial<Record<SectionKey, number>> = {
  events: 1, notices: 1, news: 1,   // What's On — the whole reason they're out
  local: 2, services: 2,            // shops, makers, places to eat
  cruise: 3, tourism: 3,
  spik: 4,                          // the dialect is a draw, not a footnote
  daBoats: 5, memories: 5,
  games: 6,
  community: 8,                     // Hubs
  fetch: 9, shifts: 10, jobs: 10,   // resident utility, still reachable
};

/** Tiles about the reader's own live commitments — never demoted by rank. */
const LIVE_TILE_IDS = new Set([
  'my-delivery', 'my-booking', 'my-application', 'my-reward', 'my-gift', 'urgent',
]);

// For You — dynamic, data-driven tiles
// ──────────────────────────────────────────────────────────────────────────

interface ForYouTile {
  id:       string;
  iconKey:  SectionKey;
  tag:      string;       // small label — "NEXT UP" "TONIGHT" "NEARBY" etc.
  headline: string;       // the main thing — vessel name, event title, notice
  detail:   string;       // supporting context — time, location, pay
  onPress:  () => void;
}

function ForYouRow({ tiles }: { tiles: ForYouTile[] }) {
  const { cardWidth } = useAppLayout();
  if (tiles.length === 0) return null;

  // Lead item gets a prominent, full-width "do this now" card in its section
  // colour; the rest sit in the row below.
  const [lead, ...rest] = tiles;
  const leadMeta = SECTIONS[lead.iconKey];

  return (
    <SectionRow title="For you" subtitle="Picked for you right now">
      <View style={{ paddingHorizontal: spacing.lg }}>
        <TouchableOpacity
          onPress={lead.onPress}
          activeOpacity={0.85}
          style={[styles.forYouHero, { backgroundColor: leadMeta.color }]}
        >
          <FontAwesome5 name={leadMeta.icon} size={20} color="#fff" solid />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.forYouHeroTag}>{lead.tag}</Text>
            <Text style={styles.forYouHeroHeadline} numberOfLines={1}>{lead.headline}</Text>
            <Text style={styles.forYouHeroDetail} numberOfLines={1}>{lead.detail}</Text>
          </View>
          <FontAwesome5 name="chevron-right" size={14} color="rgba(255,255,255,0.9)" />
        </TouchableOpacity>
      </View>

      {rest.length > 0 && (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[styles.forYouScroll, { paddingTop: spacing.sm }]}
      >
        {rest.map(t => {
          const meta = SECTIONS[t.iconKey];
          return (
            <TouchableOpacity
              key={t.id}
              onPress={t.onPress}
              activeOpacity={0.85}
              style={[styles.forYouTile, { width: cardWidth(0.42) }]}
            >
              {/* Coloured top accent */}
              <View style={[styles.forYouTileAccent, { backgroundColor: meta.color }]} />

              <View style={styles.forYouTileBody}>
                {/* Icon + tag row */}
                <View style={styles.forYouTileTop}>
                  <View style={[styles.forYouTileIcon, { backgroundColor: meta.color + '18' }]}>
                    <FontAwesome5 name={meta.icon} size={12} color={meta.color} solid />
                  </View>
                  <Text style={[styles.forYouTileTag, { color: meta.color }]}>{t.tag}</Text>
                </View>

                {/* Content */}
                <Text style={styles.forYouTileHeadline} numberOfLines={2}>{t.headline}</Text>
                <Text style={styles.forYouTileDetail} numberOfLines={1}>{t.detail}</Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      )}
    </SectionRow>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Home skeleton — shown on first load before concierge content arrives, so the
// screen has shape instead of a bare gap. Mirrors the rhythm of the real rows.
// ──────────────────────────────────────────────────────────────────────────

function HomeSkeleton() {
  return (
    <View
      style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.lg }}
      accessibilityLabel="Loading"
    >
      {/* Shetland today card */}
      <Skeleton height={120} borderRadius={radius.lg} />
      {[0, 1].map(i => (
        <View key={i} style={{ gap: spacing.sm }}>
          <Skeleton width="45%" height={16} />
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <Skeleton width="46%" height={96} borderRadius={radius.lg} />
            <Skeleton width="46%" height={96} borderRadius={radius.lg} />
          </View>
        </View>
      ))}
    </View>
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
  shifts:   '/(tabs)/jobs?tab=shifts',
  games:    '/games',
  events:   '/(tabs)/whats-on',
  notices:  '/(tabs)/whats-on',
  jobs:     '/(tabs)/jobs',
};


// ── Fresh in the shops — cross-business product rail (Shop Shetland) ───────
function ShopRow({ products }: { products: FreshProduct[] }) {
  const router = useRouter();
  if (products.length === 0) return null;
  return (
    <SectionRow
      title="Fresh in the shops"
      subtitle="Buy from Shetland's makers"
      color={SECTIONS.local.color}
      action={{ label: 'Shop all', onPress: () => router.push('/shop' as never) }}
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: spacing.lg, gap: spacing.sm }}>
        {products.map((pr) => (
          <TouchableOpacity
            key={pr.id}
            activeOpacity={0.85}
            style={{ width: 132 }}
            onPress={() => router.push({ pathname: '/product-detail', params: { id: pr.id } } as never)}
          >
            <Image source={{ uri: pr.photo }} style={{ width: 132, height: 132, borderRadius: radius.lg, backgroundColor: SECTIONS.local.light }} />
            <Text numberOfLines={1} style={{ marginTop: 6, fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary }}>{pr.title}</Text>
            <Text numberOfLines={1} style={{ fontSize: fontSize.xs, color: colors.textMuted }}>{pr.business_name}</Text>
            <Text style={{ fontSize: fontSize.sm, fontWeight: '800', color: SECTIONS.local.color }}>{formatPence(pr.price_pence)}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </SectionRow>
  );
}

export default function HomeScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const { sidePadding, cardWidth, screenHeight, isTablet } = useAppLayout();

  // Living here or visiting — a ranking hint only (lib/audience.ts). Seeded
  // from the cache so the first paint is already in the right order, then
  // corrected from the profile once it loads.
  const [audience, setAudienceState] = useState<Audience>('resident');
  useEffect(() => {
    let alive = true;
    cachedAudience().then(a => { if (alive && a) setAudienceState(a); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!profile) return;
    // The intro asks before anyone has signed in, so that answer lives in the
    // device cache. On first sign-in the profile still says 'resident' (the
    // column default) — which would silently undo a visitor's choice. So when
    // the profile is still at its default and the cache says otherwise, the
    // cache wins and gets written up. After that the profile is the truth.
    void (async () => {
      const cached = await cachedAudience();
      if (profile.audience === 'resident' && cached === 'visiting') {
        setAudienceState('visiting');
        void saveAudience(profile.id, 'visiting');
        return;
      }
      if (profile.audience) setAudienceState(profile.audience);
    })();
  }, [profile?.id, profile?.audience]);

  const toggleAudience = useCallback(() => {
    const next: Audience = audience === 'visiting' ? 'resident' : 'visiting';
    setAudienceState(next);                       // optimistic — it's a display preference
    Haptics.selectionAsync();
    void saveAudience(profile?.id, next);
  }, [audience, profile?.id]);

  const [refreshing, setRefreshing]     = useState(false);
  const [loaded, setLoaded]             = useState(false);
  const [savedBoats, setSavedBoats]     = useState<VesselStub[]>([]);
  const [recentBoats, setRecentBoats]   = useState<VesselStub[]>([]);
  const [engagement, setEngagement]     = useState<Array<{ key: EngagementKey; entry: EngagementEntry }>>([]);
  const [heroKey, setHeroKey]           = useState<HeroKey>(() => pickHeroImage(null));
  const [partnerAlerts, setPartnerAlerts] = useState<PartnerAlert[]>([]);
  const [freshProducts, setFreshProducts] = useState<FreshProduct[]>([]);
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set());

  // Today strip: at rest it's a single line, so the cruise call rides along in
  // its summary rather than stacking a second band underneath. The full cruise
  // card appears alongside once the strip is opened.
  const [cruise, setCruise] = useState<CruiseHomeCard | null>(null);
  const [todayOpen, setTodayOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    getCruiseHomeCard().then(c => { if (alive) setCruise(c); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const cruiseSummary = cruise
    ? `${cruise.ships_count} ${cruise.ships_count === 1 ? 'ship' : 'ships'} ${cruise.isToday ? 'in port' : 'due'}`
    : null;

  // Concierge content fetched from DB with seed fallback.
  useEffect(() => { fetchFreshProducts(10).then(setFreshProducts).catch(() => {}); }, []);
  const [events,  setEvents]  = useState<HomeEvent[]>([]);
  const [notices, setNotices] = useState<HomeNotice[]>([]);
  const [jobs,    setJobs]    = useState<HomeJob[]>([]);
  const [shifts,  setShifts]  = useState<HomeShift[]>([]);
  const [businesses, setBusinesses] = useState<LocalBusiness[]>([]);
  const [spik,    setSpik]    = useState<SpikDaily>({ word: '…', meaning: '' });
  const [nearby,  setNearby]  = useState<NearbyOffer[]>([]);
  // This user's own in-progress items (delivery / booking / application / reward / gift).
  const [personal, setPersonal] = useState<HomeData | null>(null);

  const loadPersonal = useCallback(async () => {
    if (!profile?.id) { setPersonal(null); return; }
    try { setPersonal(await fetchHomeData(profile)); } catch { /* non-fatal */ }
  }, [profile]);

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

  const loadConcierge = useCallback(async () => {
    const viewerParish =
      (profile as any)?.parish ?? null;
    const [evRes, ntRes, jbRes, shRes, spRes, bzRes] = await Promise.all([
      fetchHomeEvents(),
      fetchHomeNotices({ viewerParish }),
      fetchHomeJobs(),
      fetchHomeShifts(),
      fetchTodaysSpik(),
      fetchFeaturedBusinesses(6).catch(() => [] as LocalBusiness[]),
    ]);
    setEvents(evRes);
    setNotices(ntRes);
    setJobs(jbRes);
    setShifts(shRes);
    setSpik(spRes);
    setBusinesses(bzRes);
    setLoaded(true);
  }, [profile]);

  // GPS-aware local offers. Soft-checks current permission state — never
  // pops the OS prompt automatically on Home; if the user's already
  // granted location for another flow (Fetch / Memories), we use it.
  const loadNearby = useCallback(async () => {
    if (!Location) return;
    try {
      const perm = await Location.getForegroundPermissionsAsync?.();
      if (!perm?.granted) return;
      const pos = await Location.getCurrentPositionAsync?.({
        accuracy: Location.Accuracy?.Balanced,
      });
      if (!pos?.coords) return;
      const offers = await fetchNearbyOffers(pos.coords.latitude, pos.coords.longitude, 2);
      setNearby(offers);
    } catch { /* ignore */ }
  }, []);


  // Fetch partner alerts + subscribe to real-time changes.
  // Use a ref so the cleanup always removes the exact channel instance,
  // even if the effect fires twice in React strict mode.
  useEffect(() => {
    fetchActiveAlerts().then(setPartnerAlerts).catch(() => {});

    // Remove any stale channel with this name before creating a new one
    const existing = supabase.getChannels().find(c => c.topic === 'realtime:partner-alerts-home');
    if (existing) supabase.removeChannel(existing);

    const channel = supabase
      .channel('partner-alerts-home')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'partner_alerts' },
        () => { fetchActiveAlerts().then(setPartnerAlerts).catch(() => {}); },
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  useFocusEffect(useCallback(() => {
    void loadPrefs();
    void loadConcierge();
    void loadNearby();
    void loadPersonal();
  }, [loadPrefs, loadConcierge, loadNearby]));

  // ── Build For-you tiles — real data, not placeholders ──────────────────
  const tiles = useMemo<ForYouTile[]>(() => {
    const out: ForYouTile[] = [];
    const now  = Date.now();
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59);

    // ── 0. YOUR in-progress items — highest priority (your live journey) ──
    if (personal?.activeDelivery) {
      const d = personal.activeDelivery;
      const statusText = d.status === 'pending' ? 'Finding you a driver'
        : d.status === 'collected' ? 'On its way to you'
        : 'A driver is on the way';
      out.push({
        id: 'my-delivery',
        iconKey: 'fetch',
        tag: 'YOUR DELIVERY',
        headline: d.destination_area ? `Delivery to ${d.destination_area}` : `Your ${d.category_slug ?? 'delivery'}`,
        detail: statusText,
        onPress: () => router.push('/(tabs)/fetch'),
      });
    }
    if (personal?.upcomingBooking) {
      const b = personal.upcomingBooking;
      const dt = new Date(b.starts_at);
      const isToday = dt.toDateString() === new Date().toDateString();
      const timeStr = dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      const dayStr  = isToday ? 'Today' : dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      out.push({
        id: 'my-booking',
        iconKey: 'local',
        tag: isToday ? 'BOOKING TODAY' : 'YOUR BOOKING',
        headline: b.business_name ? `${b.service_name ?? 'Appointment'} at ${b.business_name}` : (b.service_name ?? 'Your appointment'),
        detail: `${dayStr}  ·  ${timeStr}`,
        onPress: () => router.push('/local-my-bookings'),
      });
    }
    if (personal?.application) {
      const a = personal.application;
      const tag: Record<string, string>    = { accepted: "YOU'RE CONFIRMED", pending: 'APPLICATION IN' };
      const detail: Record<string, string> = { accepted: 'Confirmed', pending: 'Awaiting the employer', rejected: 'Not selected', withdrawn: 'Withdrawn' };
      out.push({
        id: 'my-application',
        iconKey: 'shifts',
        tag: tag[a.status] ?? 'APPLICATION',
        headline: a.title,
        detail: detail[a.status] ?? '',
        onPress: () => router.push('/my-shift-applications'),
      });
    }
    if (personal?.rewardReady) {
      const r = personal.rewardReady;
      out.push({
        id: 'my-reward',
        iconKey: 'local',
        tag: 'REWARD READY',
        headline: r.business_name ? `Free reward at ${r.business_name}` : 'A reward is ready',
        detail: 'Show your card to redeem',
        onPress: () => router.push('/local-my-cards'),
      });
    }
    if (personal?.giftToClaim) {
      out.push({
        id: 'my-gift',
        iconKey: 'local',
        tag: 'A GIFT FOR YOU',
        headline: "You've a gift to use",
        detail: 'Pick a time to book it in',
        onPress: () => router.push('/local-my-gifts'),
      });
    }

    // ── 1. GPS: nearby offer or loyalty card (you are physically here) ──
    if (nearby.length > 0) {
      const withOffer = nearby.find(n => n.offer_title);
      out.push({
        id: 'nearby',
        iconKey: 'local',
        tag: 'NEAR YOU',
        headline: withOffer?.offer_title ?? `${nearby.length} local ${nearby.length === 1 ? 'business' : 'businesses'} close by`,
        detail: withOffer?.business_name ?? nearby.map(n => n.business_name).filter(Boolean).slice(0, 2).join(', '),
        onPress: () => router.push('/(tabs)/local'),
      });
    }

    // ── 2. Something happening TODAY ──────────────────────────────────
    const todayEvent = events.find(e => new Date(e.starts_at) <= todayEnd && new Date(e.starts_at).getTime() > now);
    if (todayEvent) {
      const t = new Date(todayEvent.starts_at);
      const timeStr = t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      out.push({
        id: 'today-event',
        iconKey: 'events',
        tag: 'TODAY',
        headline: todayEvent.title,
        detail: `${timeStr}${todayEvent.venue ? `  ·  ${todayEvent.venue}` : ''}`,
        // Only real DB events have a UUID detail page; seed/sample events route
        // to What's On (their ids like 'e1' aren't valid uuids → 400 + blank page).
        onPress: () => todayEvent.source === 'db'
          ? router.push({ pathname: '/events/[id]', params: { id: todayEvent.id } } as any)
          : router.push('/(tabs)/whats-on'),
      });
    }

    // ── 3. Urgent notice ─────────────────────────────────────────────
    const urgent = notices.find(n => n.severity === 'urgent');
    if (urgent) {
      out.push({
        id: 'urgent',
        iconKey: 'notices',
        tag: 'ALERT',
        headline: urgent.title,
        detail: `${urgent.publisher}${urgent.locality ? `  ·  ${urgent.locality}` : ''}`,
        onPress: () => router.push('/(tabs)/whats-on'),
      });
    }

    // ── 4. Saved boats ───────────────────────────────────────────────
    if (savedBoats.length > 0) {
      const first = savedBoats[0];
      out.push({
        id: 'boats',
        iconKey: 'daBoats',
        tag: 'SAVED',
        headline: first.canonical_name ?? `${savedBoats.length} saved vessel${savedBoats.length === 1 ? '' : 's'}`,
        detail: savedBoats.length > 1 ? `+ ${savedBoats.length - 1} more saved` : 'Tap to track movements',
        onPress: () => router.push('/(tabs)/da-boats'),
      });
    } else if (recentBoats.length > 0) {
      out.push({
        id: 'boats-recent',
        iconKey: 'daBoats',
        tag: 'RECENTLY VIEWED',
        headline: recentBoats[0].canonical_name ?? 'A vessel you looked at',
        detail: 'Tap to see live position',
        onPress: () => router.push('/(tabs)/da-boats'),
      });
    }

    // ── 5. Next upcoming event (if not already shown today's) ────────
    if (!todayEvent) {
      const next = events[0];
      if (next) {
        const d = new Date(next.starts_at);
        const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
        const isTomorrow = d.toDateString() === tomorrow.toDateString();
        const dayLabel = isTomorrow ? 'Tomorrow' : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
        out.push({
          id: 'next-event',
          iconKey: 'events',
          tag: 'COMING UP',
          headline: next.title,
          detail: `${dayLabel}  ·  ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`,
          onPress: () => next.source === 'db'
            ? router.push({ pathname: '/events/[id]', params: { id: next.id } } as any)
            : router.push('/(tabs)/whats-on'),
        });
      }
    }

    // ── 6. A shift happening soon (tonight or this week) ─────────────
    const tonightShift = shifts.find(s =>
      typeof s.when === 'string' && s.when.toLowerCase().includes('tonight'),
    );
    if (tonightShift) {
      out.push({
        id: 'shift',
        iconKey: 'shifts',
        tag: 'TONIGHT',
        headline: tonightShift.title,
        detail: `${tonightShift.when}  ·  ${tonightShift.pay}`,
        onPress: () => router.push('/(tabs)/jobs?tab=shifts'),
      });
    } else if (shifts.length > 0 && engagement.some(e => e.key === 'shifts')) {
      out.push({
        id: 'shift-latest',
        iconKey: 'shifts',
        tag: 'NEW SHIFT',
        headline: shifts[0].title,
        detail: `${shifts[0].when}  ·  ${shifts[0].pay}`,
        onPress: () => router.push('/(tabs)/jobs?tab=shifts'),
      });
    }

    // ── 7. A job posting (if they've engaged with jobs/shifts) ───────
    const wantsWork = engagement.some(e => e.key === 'shifts' || e.key === 'jobs');
    if (wantsWork && jobs.length > 0 && !out.some(t => t.id === 'shift')) {
      out.push({
        id: 'job',
        iconKey: 'shifts',
        tag: 'JOB',
        headline: jobs[0].title,
        detail: `${jobs[0].employer}  ·  ${jobs[0].pay}`,
        onPress: () => router.push('/(tabs)/jobs'),
      });
    }

    // ── 8. Today's game (always a nice light touch) ──────────────────
    if (out.length < 5 || engagement.some(e => e.key === 'games')) {
      out.push({
        id: 'game',
        iconKey: 'games',
        tag: 'DAILY',
        headline: "Today's Shetland challenge",
        detail: 'Guess Da Wird · Spik Sprint · Map It',
        onPress: () => router.push('/games'),
      });
    }

    // Rank by how much of the OneShetland universe each tile speaks for, so a
    // saved vessel can't lead the feed ahead of a business or what's on. Your
    // own live commitments (a delivery in flight, a booking, an alert) ignore
    // the ranking and stay on top — they're about you, not about a section.
    // This orders THIS FEED only; nav and section order are untouched.
    // Someone visiting gets the same tiles in a different order — see
    // SECTION_RANK_VISITING. Their own live commitments still lead: a booking
    // they've made here matters more than any section.
    const table = audience === 'visiting' ? SECTION_RANK_VISITING : SECTION_RANK;
    const rank = (t: ForYouTile) =>
      LIVE_TILE_IDS.has(t.id) ? 0 : (table[t.iconKey] ?? 5);
    return out
      .map((t, i) => ({ t, i }))
      .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)  // stable within a rank
      .map(x => x.t)
      .slice(0, 6);
  }, [personal, savedBoats, recentBoats, engagement, nearby, events, notices, jobs, shifts, router, audience]);

  // ── Personal note in the banner ────────────────────────────────────────
  const personalNote = useMemo(() => {
    if (savedBoats.length === 0) return null;
    return `${savedBoats.length} boat${savedBoats.length === 1 ? '' : 's'} saved`;
  }, [savedBoats]);

  // Only ever show a genuine urgent notice from the data — no sample fallback,
  // so a brand-new user never sees a fake "urgent" alert that looks real.
  const urgentNotice = notices.find(n => n.severity === 'urgent') ?? null;

  // Show the highest-priority active alert that hasn't been dismissed this session
  const visibleAlert = partnerAlerts.find(a => !dismissedAlerts.has(a.id)) ?? null;

  // Drives the phone collapsing header (brand pinned, welcome collapses on scroll).
  const scrollY = useRef(new Animated.Value(0)).current;

  return (
    <SafeAreaView style={styles.container} edges={[]}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Oversized OneShetland ring watermark, bleeding off the edge behind everything */}
      <View pointerEvents="none" style={styles.ringWatermark}>
        <Image source={LOGO} style={styles.ringWatermarkImg} resizeMode="contain" />
      </View>

      {/* Floating alert pill — absolute overlay, appears above hero */}
      {visibleAlert && (
        <AlertPill
          alert={visibleAlert}
          onDismiss={id => setDismissedAlerts(prev => new Set([...prev, id]))}
        />
      )}

      {/* Phone: collapsing header sits OUTSIDE the scroll so the brand bar stays
          pinned and the welcome collapses as you scroll. */}
      {!isTablet && (
        <HomeHeader
          name={profile?.full_name ?? null}
          spik={spik}
          urgent={urgentNotice as unknown as HomeNotice | null}
          scrollY={scrollY}
        />
      )}

      <Animated.ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scroll}
        scrollEventThrottle={16}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: false },
        )}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void Promise.all([loadPrefs(), loadConcierge(), loadNearby(), loadPersonal()]);
            }}
            tintColor={colors.accent}
          />
        }
      >
        {/* Tablet keeps the full hero inside the scroll (its sidebar nav makes a
            collapsing header unnecessary). */}
        {isTablet && (
          <HeroSection
            name={profile?.full_name ?? null}
            spik={spik}
            urgent={urgentNotice as unknown as HomeNotice | null}
            heroKey={heroKey}
          />
        )}

        {/* Sections — white card that sits below the hero, no dark gaps */}
        <View style={[styles.sectionsCard, { paddingHorizontal: sidePadding }]}>
          {!loaded && <HomeSkeleton />}
          {/* Shetland today — weather + daylight with a Lerwick / Near-me toggle.
              Phone only: tablet already shows the weather in the hero. */}
          {/* Shetland today — weather + daylight + tides on the contextual photo.
              Wide horizontal layout on tablet (the header no longer carries the
              weather), the original tall layout on phone. */}
          {/* The two "today" cards are a tight pair (spacing.md between them);
              everything below is on the section rhythm (spacing.xl). */}
          <ShetlandTodayCard
            wide={isTablet}
            extraSummary={cruiseSummary}
            onExpandedChange={setTodayOpen}
            style={{ marginHorizontal: spacing.lg, marginTop: spacing.xl }}
          />
          {/* Cruise detail — only alongside the opened Today card; when the
              strip is collapsed the ship count already rides in its summary. */}
          {(isTablet || todayOpen) && (
            <CruiseTodayCard card={cruise} style={{ marginHorizontal: spacing.lg, marginTop: spacing.md }} />
          )}
          {/* Who this is ranked for. One tap, always visible, never a trap —
              it reorders and nothing more, so there's no state anyone can get
              stuck in and nothing to go looking for afterwards. */}
          <TouchableOpacity
            style={styles.audienceChip}
            onPress={toggleAudience}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={
              audience === 'visiting'
                ? 'Showing the visiting view. Switch to living here.'
                : 'Showing the living here view. Switch to visiting.'
            }
          >
            <FontAwesome5
              name={audience === 'visiting' ? 'suitcase-rolling' : 'home'}
              size={11}
              color={colors.textMuted}
              solid
            />
            <Text style={styles.audienceChipText}>
              {audience === 'visiting' ? 'Visiting Shetland' : 'Living here'}
            </Text>
            <Text style={styles.audienceChipSwap}>Change</Text>
          </TouchableOpacity>

          {/* For you — your personal/contextual items, surfaced high. Hidden when
              there's nothing personal, so the page leads with Explore instead. */}
          <ForYouRow tiles={tiles} />
          <ShopRow products={freshProducts} />
          {/* Explore — persistent grid of every section (discoverability).
              Phone only: on tablet the NavRail sidebar already lists every
              section, so the grid would just be a redundant duplicate. */}
          {!isTablet && <ExploreGrid spikWord={spik.word} audience={audience} />}
          {/* Around Shetland — events, work & featured local merged into one
              scannable vertical feed (replaces three separate carousels). */}
          <HappeningRow events={events} jobs={jobs} shifts={shifts} businesses={businesses} />
          {/* Local notices — kept (already a rich vertical list w/ campaigns) */}
          <NoticesRow notices={notices} />
          {/* 6. Today's game — phone only; on tablet it lives below the left nav */}
          {!isTablet && <GamesRow />}
        </View>
      </Animated.ScrollView>
    </SafeAreaView>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Styles
// ──────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:  { flex: 1, backgroundColor: '#0a1628' },
  ringWatermark: { position: 'absolute', width: 640, height: 640, right: -230, top: '20%', opacity: 0.1, zIndex: 0 },
  ringWatermarkImg: { width: '100%', height: '100%' },
  scrollView: { flex: 1 },
  scroll:     { paddingBottom: spacing.xxl },

  // ── Hero ──────────────────────────────────────────────────────────────
  hero: {
    width: '100%',
    backgroundColor: colors.navy,
  },
  heroOverlay: {
    ...StyleSheet.absoluteFillObject,
    // Bottom-heavy dark gradient effect using solid layers
    backgroundColor: 'rgba(5, 18, 40, 0.35)',
  },
  heroContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    gap: 0,
  },
  // Slim mark + actions row, straight on the navy — no frosted panel to box it in.
  heroTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  heroLogoMedallion: {
    width: 38, height: 38,
    alignItems: 'center', justifyContent: 'center',
  },
  heroLogo: {
    width: 36, height: 36,
  },
  heroBrand: {
    fontSize: 16,
    color: '#fff',
    letterSpacing: -0.2,
    marginLeft: 8,
    flexShrink: 1,
  },
  heroHeaderActions: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    flexShrink: 0,
  },
  walletBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    height: 34, borderRadius: 17, paddingHorizontal: 11,
    backgroundColor: 'rgba(255,255,255,0.16)',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  walletBtnText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  profileAvatar: {
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: colors.accent,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.55)',
  },
  profileAvatarText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  heroLowerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: spacing.lg,
  },
  heroLowerLeft: {
    flex: 1,
  },
  heroGreeting: {
    gap: 3,
    marginBottom: spacing.md,
  },
  heroGreetingTitle: {
    fontSize: 29,
    color: '#fff',
    letterSpacing: -0.6,
    lineHeight: 33,
    textShadowColor: 'rgba(0,0,0,0.4)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  heroDate: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.75)',
    fontWeight: '500',
  },
  heroChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'center',
  },
  spikChip: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  spikChipLabel: {
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1.5,
    color: 'rgba(255,255,255,0.7)',
  },
  spikChipWord: {
    fontSize: 14,
    fontWeight: '900',
    color: '#fff',
    fontStyle: 'italic',
  },
  spikChipMeaning: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.7)',
    maxWidth: 180,
    flexShrink: 1,
  },
  heroSearch: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#fff',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  heroSearchText: { flex: 1, fontSize: fontSize.sm, color: colors.textMuted, fontWeight: '500' },

  // Lean tablet header — greeting + search + actions on one row.
  heroLeanRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  heroLeanGreeting: { flexShrink: 1 },
  heroLeanDateRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4, flexWrap: 'wrap' },
  heroWirdChip: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  heroWirdWord: { color: '#fff', fontSize: 13.5, fontWeight: '700', fontStyle: 'italic' },
  heroSearchWide: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#fff',
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  heroCollapse: { overflow: 'hidden' },
  heroDateRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 1 },
  heroDateDivider: { width: 1, height: 12, backgroundColor: 'rgba(255,255,255,0.25)' },
  spikInline: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 },
  spikInlineLabel: { fontSize: 9, fontWeight: '900', letterSpacing: 1.2, color: 'rgba(255,255,255,0.45)' },
  spikInlineWord: { fontSize: 14, fontWeight: '800', fontStyle: 'italic', color: colors.accent },
  spikInlineMeaning: { fontSize: 13, color: 'rgba(255,255,255,0.6)', flexShrink: 1 },
  heroSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  heroSearchFull: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#fff',
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  urgentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.error,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    maxWidth: 200,
  },
  urgentChipText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#fff',
  },

  // Stale styles kept to avoid unused-variable errors — no longer rendered
  greetingWrap: { paddingHorizontal: spacing.lg },
  greetingTitle: { fontSize: 30, color: colors.textPrimary },
  greetingStatus: { fontSize: 14, color: colors.textSecondary },

  // Sections container — single white block, no dark gaps
  sectionsCard: {
    backgroundColor: colors.screenBackground,
    // No top padding: every section carries its own top margin (spacing.xl),
    // so adding padding here would stack into a void under the hero.
    paddingBottom: spacing.lg,
  },
  searchEntry: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginHorizontal: spacing.lg, marginBottom: spacing.lg,
    backgroundColor: '#fff', borderRadius: radius.full,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 16, paddingVertical: 13,
  },
  searchEntryText: { fontSize: fontSize.sm, color: colors.textMuted, fontWeight: '500' },

  // Explore OneShetland — persistent sections grid
  // Rounded surface that sections Explore off — like the Shetland Today card,
  // minus the photo. Coloured cards pop against the white panel.
  audienceChip: {
    flexDirection: 'row', alignItems: 'center', gap: 7, alignSelf: 'flex-start',
    marginHorizontal: spacing.lg, marginTop: spacing.xl,
    paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: radius.full, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.cardBackground,
  },
  audienceChipText: { fontSize: fontSize.xs, fontWeight: '800', color: colors.textSecondary },
  audienceChipSwap: { fontSize: fontSize.xs, fontWeight: '800', color: colors.accent },

  exploreGroups: {
    marginHorizontal: spacing.lg,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
  },
  exploreGroup: {
    marginBottom: spacing.lg,
  },
  exploreGroupTitle: {
    fontSize: 14,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  exploreChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  // 3-up card grid. Padding-as-gutter (marginHorizontal:-4 + per-card padding:4)
  // gives even thirds with the last partial row left-aligned.
  exploreGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -4,
  },
  exploreCardWrap: {
    width: '33.333%',
    padding: 4,
  },
  exploreCard: {
    borderRadius: radius.lg,
    paddingVertical: 12,
    paddingHorizontal: 11,
    minHeight: 78,
  },
  exploreCardName: {
    fontSize: 13.5,
    fontWeight: '800',
    color: '#fff',
    marginTop: 8,
  },
  exploreCardCaption: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.82)',
    marginTop: 1,
  },
  exploreFetchCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    borderRadius: radius.lg,
    paddingVertical: 14,
    paddingHorizontal: 15,
    marginTop: 4,
  },
  exploreFetchName: {
    fontSize: 15,
    fontWeight: '800',
    color: '#fff',
  },
  exploreFetchCaption: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.88)',
    marginTop: 2,
  },
  sectionDivider: {
    height: 1,
    backgroundColor: colors.border,
    marginHorizontal: spacing.lg,
    marginVertical: spacing.lg,
  },

  // Row chrome — editorial, not widget
  // Every top-level Home section sets its own TOP margin and no bottom one, so
  // the rhythm stays even and a section that renders nothing (For you with no
  // tiles, an empty shop rail) collapses without leaving a double gap.
  row: { gap: spacing.sm, marginTop: spacing.xl },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    gap: 10,
  },
  rowAccentBar: {
    width: 4, height: 20, borderRadius: 2,
  },
  rowTitle: {
    fontSize: 17,
    fontWeight: '900',
    color: colors.textPrimary,
    letterSpacing: -0.3,
  },
  rowSubtitle: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 1,
  },
  rowActionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
  },
  rowAction: {
    fontSize: 13,
    fontWeight: '700',
  },

  eventsEmpty: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginHorizontal: spacing.lg,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  eventsEmptyIcon: {
    width: 48, height: 48, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
  },
  eventsEmptyTitle: {
    fontSize: 14, fontWeight: '700', color: colors.textPrimary,
  },
  eventsEmptyDetail: {
    fontSize: 12, color: colors.textMuted, lineHeight: 16,
  },

  // Event cards
  eventCardCompact: {
    width: 200,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  eventCardCompactImage: {
    width: '100%',
    height: 110,
  },
  eventCardCompactImagePlaceholder: {
    backgroundColor: SECTIONS.events.light,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eventCardFull: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  eventCardFullImage: {
    width: '100%',
    height: 160,
  },
  eventFeaturedBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: SECTIONS.events.color,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  eventFeaturedBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#fff',
    letterSpacing: 0.4,
  },
  eventTicketBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: SECTIONS.events.color,
    borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5,
    alignSelf: 'flex-start',
  },
  eventTicketBtnText: { fontSize: 11, fontWeight: '800', color: '#fff' },
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


  // Notices
  noticeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.white,
    paddingHorizontal: spacing.md,
    paddingVertical: 13,
    borderWidth: 1,
    borderColor: colors.border,
  },
  noticeRowFirst: {
    borderTopLeftRadius: radius.md,
    borderTopRightRadius: radius.md,
  },
  noticeRowLast: {
    borderBottomLeftRadius: radius.md,
    borderBottomRightRadius: radius.md,
  },
  noticeSeverityBar: {
    width: 3, height: 36, borderRadius: 2, flexShrink: 0,
  },
  noticeLogo: {
    width: 40, height: 40, borderRadius: 11, flexShrink: 0,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  noticeLogoImg: { width: 40, height: 40 },
  noticeBarWrap: { marginTop: 6, gap: 4 },
  noticeBarTrack: { height: 7, borderRadius: 999, backgroundColor: '#E9ECF2', overflow: 'hidden' },
  noticeBarFill: { height: 7, borderRadius: 999 },
  noticeBarMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  noticeBarText: { fontSize: 11, color: colors.textMuted, fontWeight: '700' },
  noticeDonateLink: { fontSize: 12, fontWeight: '800' },
  noticeUrgentLabel: {
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1,
    color: colors.error,
  },
  noticeTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.textPrimary,
    lineHeight: 19,
  },
  noticeMeta: {
    fontSize: 12,
    color: colors.textMuted,
  },

  hubsLink: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1,
    padding: 12, marginTop: 8,
  },
  hubsLinkIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  hubsLinkTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  hubsLinkSub: { fontSize: 12, color: colors.textMuted, marginTop: 1 },

  // Work tiles — horizontal scroll
  workTile: {
    width: 150,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 6,
    justifyContent: 'space-between',
    minHeight: 110,
  },
  workTileTag: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: radius.full,
    borderWidth: 1,
  },
  workTileTagText: {
    fontSize: 9, fontWeight: '900', letterSpacing: 1,
  },
  workTileTitle: {
    fontSize: 14, fontWeight: '800', color: colors.textPrimary,
    lineHeight: 18, flex: 1,
  },
  workTileSub: {
    fontSize: 11, color: colors.textMuted,
  },
  workTileMore: {
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'transparent',
    gap: 8,
  },
  workTileMoreText: {
    fontSize: 13, fontWeight: '800',
  },

  // Games
  gameCardArt: { backgroundColor: '#fff', borderRadius: 16, padding: 3 },
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

  // ── For You ───────────────────────────────────────────────────────────
  forYouScroll: {
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  // Lead "For you" item — prominent full-width action card in its section colour.
  forYouHero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    borderRadius: radius.lg,
    paddingVertical: 14,
    paddingHorizontal: 15,
  },
  // Around Shetland — merged vertical feed (white rounded panel + rows).
  happeningCard: {
    marginHorizontal: spacing.lg,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  happeningRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  happeningRowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  happeningTitle: { fontSize: 14, fontWeight: '700', color: colors.navy },
  happeningSub:   { fontSize: 11.5, color: colors.textMuted, marginTop: 1 },
  happeningTag:   { fontSize: 9.5, fontWeight: '800', letterSpacing: 0.6 },
  forYouHeroTag: {
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 0.8,
    color: 'rgba(255,255,255,0.92)',
  },
  forYouHeroHeadline: {
    fontSize: 16,
    fontWeight: '800',
    color: '#fff',
    marginTop: 2,
  },
  forYouHeroDetail: {
    fontSize: 12.5,
    color: 'rgba(255,255,255,0.88)',
    marginTop: 1,
  },
  forYouTile: {
    width: 168,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  forYouTileAccent: {
    height: 4,
    width: '100%',
  },
  forYouTileBody: {
    padding: spacing.sm,
    gap: 5,
  },
  forYouTileTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  forYouTileIcon: {
    width: 24, height: 24, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  forYouTileTag: {
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1,
  },
  forYouTileHeadline: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.textPrimary,
    lineHeight: 18,
  },
  forYouTileDetail: {
    fontSize: 11,
    color: colors.textMuted,
    lineHeight: 15,
  },
});
