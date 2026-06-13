/**
 * AppTabBar
 *
 * Adaptive navigation built from a single NAV model:
 *   iPhone → bottom bar with the first 5 destinations + a "More" sheet
 *            holding the rest (Memories, Spik, Da Boats, Fetch, Hubs, Games,
 *            Profile). Five tabs is the most a phone bar can show with
 *            readable labels.
 *   iPad   → left sidebar listing every destination (vertical, has the room).
 *
 * Rendering from the model — not from the raw tab routes — also means hidden
 * utility routes (services/me) can never leak into the bar.
 *
 * Passed as the `tabBar` prop on the Tabs navigator in app/(tabs)/_layout.tsx.
 */

import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Image, ScrollView,
} from 'react-native';
import { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import { useRouter, usePathname, type Href } from 'expo-router';
import { colors, fontSize, spacing, radius, SIDEBAR_WIDTH } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { SECTIONS } from '@/constants/sections';
import { GameArt } from '@/components/GameArt';
import { Sheet } from '@/components/ui/Sheet';

const INACTIVE  = 'rgba(255,255,255,0.55)';
const SIDEBAR_W = SIDEBAR_WIDTH;

/** One navigation destination. `route` = a (tabs) screen; `path` = a stack push. */
interface NavDest {
  label: string;
  icon:  string;
  color: string;
  route?: string;   // name of a screen in the (tabs) navigator
  path?:  Href;     // a route outside the tab navigator
}

// The canonical order. First PHONE_PRIMARY entries are the phone bottom bar;
// everything after spills into the "More" sheet. The tablet sidebar shows all.
const NAV: NavDest[] = [
  { label: 'Home',                  icon: 'home',                 color: colors.accent,           route: 'index' },
  { label: 'Events',                icon: SECTIONS.events.icon,   color: SECTIONS.events.color,   route: 'whats-on' },
  { label: 'Directory',             icon: SECTIONS.services.icon, color: SECTIONS.services.color, route: 'services' },
  { label: 'Local',                 icon: SECTIONS.local.icon,    color: SECTIONS.local.color,    route: 'local' },
  { label: 'Jobs',                  icon: SECTIONS.jobs.icon,     color: SECTIONS.jobs.color,     route: 'jobs' },
  { label: SECTIONS.shifts.label,   icon: SECTIONS.shifts.icon,   color: SECTIONS.shifts.color,   path: '/(tabs)/jobs?tab=shifts' as Href },
  { label: SECTIONS.memories.label, icon: SECTIONS.memories.icon, color: SECTIONS.memories.color, route: 'memories' },
  { label: SECTIONS.spik.label,     icon: SECTIONS.spik.icon,     color: SECTIONS.spik.color,     route: 'spik' },
  { label: SECTIONS.daBoats.label,  icon: SECTIONS.daBoats.icon,  color: SECTIONS.daBoats.color,  route: 'da-boats' },
  { label: SECTIONS.fetch.label,    icon: SECTIONS.fetch.icon,    color: SECTIONS.fetch.color,    route: 'fetch' },
  { label: SECTIONS.community.label, icon: SECTIONS.community.icon, color: SECTIONS.community.color, path: '/hubs' },
  { label: SECTIONS.games.label,    icon: SECTIONS.games.icon,    color: SECTIONS.games.color,    path: '/games' },
];

const PROFILE: NavDest = { label: 'Profile', icon: 'user', color: colors.accent, route: 'me' };

const PHONE_PRIMARY = 5;
const PRIMARY    = NAV.slice(0, PHONE_PRIMARY);
const MORE_ITEMS = [...NAV.slice(PHONE_PRIMARY), PROFILE];

export function AppTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const { isTablet } = useAppLayout();
  const insets       = useSafeAreaInsets();

  if (isTablet) {
    return <SidebarTabBar state={state} descriptors={descriptors} navigation={navigation} insets={insets} />;
  }
  return <BottomTabBar state={state} descriptors={descriptors} navigation={navigation} insets={insets} />;
}

// ── Bottom bar (iPhone) ──────────────────────────────────────────────────────

function BottomTabBar({ state, navigation, insets }: BottomTabBarProps & { insets: any }) {
  const router = useRouter();
  const [moreOpen, setMoreOpen] = useState(false);
  const focusedName = state.routes[state.index]?.name;

  const go = (item: NavDest) => {
    if (item.route) navigation.navigate(item.route as never);
    else if (item.path) router.push(item.path);
  };

  const moreActive = MORE_ITEMS.some(i => i.route && i.route === focusedName);

  return (
    <View style={[styles.bottomBar, { height: 60 + insets.bottom, paddingBottom: insets.bottom }]}>
      {PRIMARY.map(item => {
        const focused = item.route === focusedName;
        return (
          <TouchableOpacity
            key={item.label}
            style={styles.bottomItem}
            onPress={() => go(item)}
            activeOpacity={0.7}
          >
            <View style={[styles.bottomChip, { backgroundColor: focused ? item.color : item.color + '26' }]}>
              <FontAwesome5 name={item.icon as any} size={15} color={focused ? '#fff' : item.color} solid />
            </View>
            <Text
              style={[styles.bottomLabel, { color: focused ? '#fff' : INACTIVE, fontWeight: focused ? '800' : '600' }]}
              numberOfLines={1}
            >
              {item.label}
            </Text>
          </TouchableOpacity>
        );
      })}

      <TouchableOpacity style={styles.bottomItem} onPress={() => setMoreOpen(true)} activeOpacity={0.7}>
        <View style={[styles.bottomChip, { backgroundColor: moreActive ? colors.accent : 'rgba(255,255,255,0.14)' }]}>
          <FontAwesome5 name="ellipsis-h" size={15} color={moreActive ? '#fff' : INACTIVE} solid />
        </View>
        <Text
          style={[styles.bottomLabel, { color: moreActive ? '#fff' : INACTIVE, fontWeight: moreActive ? '800' : '600' }]}
        >
          More
        </Text>
      </TouchableOpacity>

      <MoreSheet
        open={moreOpen}
        focusedName={focusedName}
        onClose={() => setMoreOpen(false)}
        onSelect={(item) => { setMoreOpen(false); go(item); }}
      />
    </View>
  );
}

function MoreSheet({
  open, focusedName, onClose, onSelect,
}: {
  open: boolean;
  focusedName?: string;
  onClose: () => void;
  onSelect: (item: NavDest) => void;
}) {
  return (
    <Sheet visible={open} onClose={onClose} title="More">
      <View style={styles.moreGrid}>
        {MORE_ITEMS.map(item => {
          const active = item.route === focusedName;
          return (
            <TouchableOpacity
              key={item.label}
              style={styles.moreCell}
              onPress={() => onSelect(item)}
              activeOpacity={0.8}
            >
              <View style={[styles.moreChip, { backgroundColor: active ? item.color : item.color + '1A' }]}>
                <FontAwesome5 name={item.icon as any} size={20} color={active ? '#fff' : item.color} solid />
              </View>
              <Text style={styles.moreLabel} numberOfLines={1}>{item.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </Sheet>
  );
}

// ── Sidebar (iPad) ────────────────────────────────────────────────────────────

function SidebarTabBar({ state, navigation, insets }: BottomTabBarProps & { insets: any }) {
  const router      = useRouter();
  const pathname    = usePathname();
  const focusedName = state.routes[state.index]?.name;

  const isActive = (item: NavDest) => {
    if (item.route) return item.route === focusedName;
    if (item.path)  return pathname === String(item.path) || pathname.startsWith(String(item.path) + '/');
    return false;
  };

  const go = (item: NavDest) => {
    if (item.route) navigation.navigate(item.route as never);
    else if (item.path) router.push(item.path);
  };

  return (
    <View style={[styles.sidebar, { paddingTop: insets.top + spacing.md, paddingBottom: insets.bottom + spacing.md }]}>
      <View style={styles.sidebarBrand}>
        <Image source={require('../assets/icon.png')} style={styles.sidebarLogo} resizeMode="contain" />
        <Text style={styles.sidebarBrandText}>OneShetland</Text>
      </View>
      <View style={styles.sidebarDivider} />

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 4 }} showsVerticalScrollIndicator={false}>
        {[...NAV, PROFILE].map(item => {
          const active = isActive(item);
          return (
            <TouchableOpacity
              key={item.label}
              style={[styles.sidebarItem, active && styles.sidebarItemActive]}
              onPress={() => go(item)}
              activeOpacity={0.7}
            >
              <View style={[styles.navChip, { backgroundColor: active ? item.color : item.color + '26' }]}>
                <FontAwesome5 name={item.icon as any} size={14} color={active ? '#fff' : item.color} solid />
              </View>
              <Text style={[styles.sidebarLabel, active && styles.sidebarLabelActive]}>{item.label}</Text>
              {active ? <View style={[styles.activeDot, { backgroundColor: item.color }]} /> : null}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <TodaysGameTile />
    </View>
  );
}

// Compact "Today's game" card for the tablet sidebar's lower space.
function TodaysGameTile() {
  const router = useRouter();
  const idx = new Date().getDate() % 4;
  const cfg = [
    { gid: 'spik_sprint'   as const, title: 'Spik Sprint',   sub: '60 seconds',                path: '/games' as const },
    { gid: 'guess_da_wird' as const, title: 'Guess Da Wird', sub: "Today's Shetlandic word",    path: '/games/guess-da-wird' as const },
    { gid: 'map_it'        as const, title: 'Map It',        sub: "Drop a pin on today's place", path: '/games/map-it' as const },
    { gid: 'spik_snap'     as const, title: 'Spik Snap',     sub: 'Match word to meaning',       path: '/games' as const },
  ][idx];

  return (
    <TouchableOpacity style={styles.gameTile} onPress={() => router.push(cfg.path)} activeOpacity={0.85}>
      <Text style={styles.gameTileKicker}>TODAY'S GAME</Text>
      <View style={styles.gameTileRow}>
        <GameArt id={cfg.gid} size={40} radius={11} />
        <View style={{ flex: 1 }}>
          <Text style={styles.gameTileTitle} numberOfLines={1}>{cfg.title}</Text>
          <Text style={styles.gameTileSub} numberOfLines={1}>{cfg.sub}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  // ── Sidebar ──────────────────────────────────────────────────────────────────
  sidebar: {
    position: 'absolute',
    left: 0, top: 0, bottom: 0,
    width: SIDEBAR_W,
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.md,
    borderRightWidth: 1,
    borderRightColor: 'rgba(255,255,255,0.08)',
    zIndex: 50,
  },
  sidebarBrand: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.xs, marginBottom: spacing.sm,
  },
  sidebarLogo: { width: 32, height: 32, borderRadius: 8 },
  sidebarBrandText: {
    color: '#fff', fontSize: fontSize.md, fontWeight: '800', letterSpacing: -0.3,
  },
  sidebarDivider: {
    height: 1, backgroundColor: 'rgba(255,255,255,0.08)', marginBottom: spacing.sm,
  },
  sidebarItem: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: spacing.sm, paddingVertical: 8,
    borderRadius: radius.md,
  },
  sidebarItemActive: { backgroundColor: 'rgba(255,255,255,0.08)' },
  navChip: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  sidebarLabel: { flex: 1, fontSize: fontSize.sm, fontWeight: '600', color: 'rgba(255,255,255,0.72)' },
  sidebarLabelActive: { color: '#fff', fontWeight: '800' },
  activeDot: { width: 7, height: 7, borderRadius: 4 },

  // Today's game tile (sidebar bottom)
  gameTile: {
    marginTop: spacing.sm,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderRadius: radius.lg,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
    padding: spacing.sm, gap: 8,
  },
  gameTileKicker: {
    color: 'rgba(255,255,255,0.45)', fontSize: 9, fontWeight: '800', letterSpacing: 0.8,
  },
  gameTileRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  gameTileTitle: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
  gameTileSub: { color: 'rgba(255,255,255,0.55)', fontSize: 11, marginTop: 1 },

  // ── Bottom bar ───────────────────────────────────────────────────────────────
  bottomBar: {
    flexDirection: 'row',
    backgroundColor: colors.navy,
    borderTopWidth: 0,
  },
  bottomItem: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 5, gap: 3,
  },
  bottomChip: {
    minWidth: 42, height: 26, borderRadius: 9,
    paddingHorizontal: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  bottomLabel: { fontSize: 10, fontWeight: '600' },

  // ── More sheet ─────────────────────────────────────────────────────────────
  moreGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  moreCell: { width: '25%', alignItems: 'center', gap: 7, marginBottom: spacing.lg },
  moreChip: { width: 54, height: 54, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  moreLabel: { fontSize: 12, fontWeight: '700', color: colors.textPrimary, textAlign: 'center' },
});
