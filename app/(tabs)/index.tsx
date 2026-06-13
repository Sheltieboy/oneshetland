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
  RefreshControl, Image, ImageBackground, Platform,
} from 'react-native';

// OneShetland brand mark used in the top app header.
const LOGO = require('@/assets/icon.png');
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect, Stack } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { SECTIONS, SectionKey } from '@/constants/sections';
import { colors, spacing, radius, fontSize } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { GameArt } from '@/components/GameArt';
import { FeaturedBusinessesBar } from '@/components/FeaturedBusinessesBar';
import { TodayAtAGlance } from '@/components/TodayAtAGlance';
import { useAuth } from '@/context/AuthContext';

import DisplayText from '@/components/DisplayText';
import AlertPill from '@/components/AlertPill';

import { fetchActiveAlerts, type PartnerAlert } from '@/lib/alerts-api';
import { supabase } from '@/lib/supabase';
import { fetchWalletBalance, formatPence } from '@/lib/local-api';
import { SAMPLE_URGENT_NOTICE, SampleEvent } from '@/lib/seed-content';
import {
  fetchHomeEvents, fetchHomeNotices, fetchHomeJobs, fetchHomeShifts,
  fetchTodaysSpik, fetchNearbyOffers,
  HomeEvent, HomeNotice, HomeJob, HomeShift, NearbyOffer, SpikDaily,
} from '@/lib/concierge-api';
import { loadSavedBoats, loadRecentBoats, VesselStub } from '@/lib/boats-prefs';
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

// ──────────────────────────────────────────────────────────────────────────
// Top banner
// ──────────────────────────────────────────────────────────────────────────

function TopBanner({
  urgent, personalNote, spik,
}: {
  urgent:       HomeNotice | null;
  personalNote: string | null;
  spik:         SpikDaily;
}) {
  const router = useRouter();

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
        <View style={[styles.rowAccentBar, { backgroundColor: accent }]} />
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

  return (
    <ImageBackground
      source={HERO_IMAGES[heroKey]}
      style={[styles.hero, { minHeight: Math.min(isTablet ? 380 : 320, screenHeight * 0.45) }]}
      resizeMode="cover"
    >
      {/* Gradient overlay — top is semi-transparent, bottom is darker */}
      <View style={styles.heroOverlay} />

      <View style={[styles.heroContent, { paddingTop: insets.top + 10 }]}>

        {/* Logo row */}
        <View style={styles.heroTopRow}>
          <View style={styles.heroLogoRow}>
            <Image source={LOGO} style={styles.heroLogo} resizeMode="contain" />
            <View>
              <DisplayText weight="black" style={styles.heroBrand}>OneShetland</DisplayText>
              <Text style={styles.heroBrandTag}>Everything Shetland,{'\n'}in one place</Text>
            </View>
          </View>
          <View style={styles.heroHeaderActions}>
            <TouchableOpacity
              style={styles.walletBtn}
              onPress={() => router.push('/local-wallet')}
              activeOpacity={0.8}
              hitSlop={8}
              accessibilityLabel="My Wallet"
            >
              <FontAwesome5 name="wallet" size={15} color="#fff" solid />
              {walletPence != null && (
                <Text style={styles.walletBtnText}>{formatPence(walletPence)}</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.profileAvatar}
              onPress={() => router.push('/(tabs)/me')}
              activeOpacity={0.8}
              hitSlop={8}
            >
              <Text style={styles.profileAvatarText}>{initials}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Lower hero — greeting + chips on the left; on tablet a calm
            "today at a glance" card fills the open space on the right. */}
        <View style={isTablet ? styles.heroLowerRow : undefined}>
          <View style={isTablet ? styles.heroLowerLeft : undefined}>
            {/* Greeting */}
            <View style={styles.heroGreeting}>
              <DisplayText weight="black" style={styles.heroGreetingTitle}>
                {`${timeGreeting()}${name ? `, ${name.split(' ')[0]}` : ''}`}
              </DisplayText>
              <Text style={styles.heroDate}>{dateStr}</Text>
            </View>

            {/* Chips row — SPIK word + urgent alert */}
            <View style={styles.heroChips}>
              <TouchableOpacity
                style={styles.spikChip}
                onPress={() => router.push('/(tabs)/spik')}
                activeOpacity={0.85}
              >
                <Text style={styles.spikChipLabel}>SPIK</Text>
                <Text style={styles.spikChipWord}>{spik.word}</Text>
                {spik.meaning ? <Text style={styles.spikChipMeaning} numberOfLines={1}>· {spik.meaning}</Text> : null}
              </TouchableOpacity>

              {urgent ? (
                <TouchableOpacity
                  style={styles.urgentChip}
                  onPress={() => router.push('/(tabs)/whats-on')}
                  activeOpacity={0.85}
                >
                  <FontAwesome5 name="exclamation-triangle" size={10} color="#fff" solid />
                  <Text style={styles.urgentChipText} numberOfLines={1}>{urgent.title}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>

          {isTablet && <TodayAtAGlance />}
        </View>

      </View>
    </ImageBackground>
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
      title="Events"
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
          <FontAwesome5 name="chevron-right" size={11} color={colors.textLight} />
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
            onPress={e => { e.stopPropagation?.(); router.push({ pathname: '/event-ticket-checkout', params: { id: event.id } }); }}
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
              onPress={e => { e.stopPropagation?.(); router.push({ pathname: '/event-ticket-checkout', params: { id: event.id } }); }}
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
      title="Work in Shetland"
      sectionKey="shifts"
      action={{ label: 'See all', onPress: () => router.push('/(tabs)/shifts') }}
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
            onPress={() => router.push('/(tabs)/shifts')}
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
          onPress={() => router.push('/(tabs)/shifts')}
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
              <FontAwesome5 name="chevron-right" size={10} color={colors.textLight} />
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
  return (
    <SectionRow title="For you" subtitle="Picked for you right now">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.forYouScroll}
      >
        {tiles.map(t => {
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
  const { sidePadding, cardWidth, screenHeight, isTablet } = useAppLayout();

  const [refreshing, setRefreshing]     = useState(false);
  const [savedBoats, setSavedBoats]     = useState<VesselStub[]>([]);
  const [recentBoats, setRecentBoats]   = useState<VesselStub[]>([]);
  const [engagement, setEngagement]     = useState<Array<{ key: EngagementKey; entry: EngagementEntry }>>([]);
  const [heroKey, setHeroKey]           = useState<HeroKey>(() => pickHeroImage(null));
  const [partnerAlerts, setPartnerAlerts] = useState<PartnerAlert[]>([]);
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set());

  // Concierge content fetched from DB with seed fallback.
  const [events,  setEvents]  = useState<HomeEvent[]>([]);
  const [notices, setNotices] = useState<HomeNotice[]>([]);
  const [jobs,    setJobs]    = useState<HomeJob[]>([]);
  const [shifts,  setShifts]  = useState<HomeShift[]>([]);
  const [spik,    setSpik]    = useState<SpikDaily>({ word: '…', meaning: '' });
  const [nearby,  setNearby]  = useState<NearbyOffer[]>([]);

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
    const [evRes, ntRes, jbRes, shRes, spRes] = await Promise.all([
      fetchHomeEvents(),
      fetchHomeNotices({ viewerParish }),
      fetchHomeJobs(),
      fetchHomeShifts(),
      fetchTodaysSpik(),
    ]);
    setEvents(evRes);
    setNotices(ntRes);
    setJobs(jbRes);
    setShifts(shRes);
    setSpik(spRes);
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

  // Fetch weather once on mount to pick the right hero image
  useEffect(() => {
    fetchShetlandWeather().then(w => setHeroKey(pickHeroImage(w)));
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
  }, [loadPrefs, loadConcierge, loadNearby]));

  // ── Build For-you tiles — real data, not placeholders ──────────────────
  const tiles = useMemo<ForYouTile[]>(() => {
    const out: ForYouTile[] = [];
    const now  = Date.now();
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59);

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
        onPress: () => router.push({ pathname: '/events/[id]', params: { id: todayEvent.id } } as any),
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
        headline: first.name ?? `${savedBoats.length} saved vessel${savedBoats.length === 1 ? '' : 's'}`,
        detail: savedBoats.length > 1 ? `+ ${savedBoats.length - 1} more saved` : 'Tap to track movements',
        onPress: () => router.push('/(tabs)/da-boats'),
      });
    } else if (recentBoats.length > 0) {
      out.push({
        id: 'boats-recent',
        iconKey: 'daBoats',
        tag: 'RECENTLY VIEWED',
        headline: recentBoats[0].name ?? 'A vessel you looked at',
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
          onPress: () => router.push({ pathname: '/events/[id]', params: { id: next.id } } as any),
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
        onPress: () => router.push('/(tabs)/shifts'),
      });
    } else if (shifts.length > 0 && engagement.some(e => e.key === 'shifts')) {
      out.push({
        id: 'shift-latest',
        iconKey: 'shifts',
        tag: 'NEW SHIFT',
        headline: shifts[0].title,
        detail: `${shifts[0].when}  ·  ${shifts[0].pay}`,
        onPress: () => router.push('/(tabs)/shifts'),
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
        onPress: () => router.push('/(tabs)/shifts'),
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

    return out.slice(0, 6);
  }, [savedBoats, recentBoats, engagement, nearby, events, notices, jobs, shifts, router]);

  // ── Personal note in the banner ────────────────────────────────────────
  const personalNote = useMemo(() => {
    if (savedBoats.length === 0) return null;
    return `${savedBoats.length} boat${savedBoats.length === 1 ? '' : 's'} saved`;
  }, [savedBoats]);

  const urgentNotice = notices.find(n => n.severity === 'urgent') ?? SAMPLE_URGENT_NOTICE;

  // Show the highest-priority active alert that hasn't been dismissed this session
  const visibleAlert = partnerAlerts.find(a => !dismissedAlerts.has(a.id)) ?? null;

  return (
    <SafeAreaView style={styles.container} edges={[]}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Floating alert pill — absolute overlay, appears above hero */}
      {visibleAlert && (
        <AlertPill
          alert={visibleAlert}
          onDismiss={id => setDismissedAlerts(prev => new Set([...prev, id]))}
        />
      )}

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void Promise.all([loadPrefs(), loadConcierge(), loadNearby()]);
            }}
            tintColor={colors.accent}
          />
        }
      >
        {/* Full-bleed hero — image changes with time of day + weather */}
        <HeroSection
          name={profile?.full_name ?? null}
          spik={spik}
          urgent={urgentNotice}
          heroKey={heroKey}
        />

        {/* Sections — white card that sits below the hero, no dark gaps */}
        <View style={[styles.sectionsCard, { paddingHorizontal: sidePadding }]}>
          {/* Directory / app search */}
          <TouchableOpacity
            style={styles.searchEntry}
            onPress={() => router.push('/search')}
            activeOpacity={0.8}
          >
            <FontAwesome5 name="search" size={15} color={colors.textMuted} />
            <Text style={styles.searchEntryText}>Search businesses, trades, services…</Text>
          </TouchableOpacity>
          {/* 1. For you */}
          <ForYouRow tiles={tiles} />
          <View style={styles.sectionDivider} />
          {/* 2. Events */}
          <ComingUpRow events={events} />
          <View style={styles.sectionDivider} />
          {/* 3. Directory / featured listings */}
          <FeaturedBusinessesBar />
          <View style={styles.sectionDivider} />
          {/* 4. Work / shifts */}
          <WorkRow jobs={jobs} shifts={shifts} />
          <View style={styles.sectionDivider} />
          {/* 5. Local notices */}
          <NoticesRow notices={notices} />
          {/* 6. Today's game — phone only; on tablet it lives below the left nav */}
          {!isTablet && (
            <>
              <View style={styles.sectionDivider} />
              <GamesRow />
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Styles
// ──────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:  { flex: 1, backgroundColor: '#0a1628' },
  scrollView: { flex: 1 },
  scroll:     { paddingBottom: spacing.xxl },

  // ── Hero ──────────────────────────────────────────────────────────────
  hero: {
    width: '100%',
    minHeight: 320,
  },
  heroOverlay: {
    ...StyleSheet.absoluteFillObject,
    // Bottom-heavy dark gradient effect using solid layers
    backgroundColor: 'rgba(5, 18, 40, 0.35)',
  },
  heroContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl,
    gap: 0,
  },
  heroTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.lg,
  },
  heroLogoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  heroLogo: {
    width: 36, height: 36, borderRadius: 8,
  },
  heroBrand: {
    fontSize: 20,
    color: '#fff',
    letterSpacing: -0.3,
  },
  heroBrandTag: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.7)',
    fontWeight: '500',
    marginTop: -1,
    lineHeight: 14,
  },
  heroHeaderActions: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
  },
  walletBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    height: 40, borderRadius: 20, paddingHorizontal: 13,
    backgroundColor: 'rgba(255,255,255,0.18)',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  walletBtnText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  profileAvatar: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: colors.accent,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  profileAvatarText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.5,
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
    gap: 4,
    marginBottom: spacing.lg,
  },
  heroGreetingTitle: {
    fontSize: 38,
    color: '#fff',
    letterSpacing: -1,
    lineHeight: 42,
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
    paddingTop: spacing.lg,
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
  sectionDivider: {
    height: 1,
    backgroundColor: colors.border,
    marginHorizontal: spacing.lg,
    marginVertical: spacing.lg,
  },

  // Row chrome — editorial, not widget
  row: { gap: spacing.sm },
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
