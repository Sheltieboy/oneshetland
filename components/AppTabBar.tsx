/**
 * AppTabBar
 *
 * Adaptive tab navigation:
 *   iPhone  → standard bottom bar (existing behaviour)
 *   iPad    → left sidebar with icon + label, fixed 220px wide
 *
 * Passed as the `tabBar` prop on the Tabs navigator in app/(tabs)/_layout.tsx.
 */

import React from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Image,
} from 'react-native';
import { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { colors, fontSize, spacing, radius, SIDEBAR_WIDTH } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { SECTIONS } from '@/constants/sections';
import { GameArt } from '@/components/GameArt';

const INACTIVE   = 'rgba(255,255,255,0.55)';
const SIDEBAR_W  = SIDEBAR_WIDTH;

export function AppTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const { isTablet } = useAppLayout();
  const insets       = useSafeAreaInsets();

  if (isTablet) {
    return <SidebarTabBar state={state} descriptors={descriptors} navigation={navigation} insets={insets} />;
  }
  return <BottomTabBar state={state} descriptors={descriptors} navigation={navigation} insets={insets} />;
}

// ── Sidebar (iPad) ─────────────────────────────────────────────────────────────

function SidebarTabBar({ state, descriptors, navigation, insets }: BottomTabBarProps & { insets: any }) {
  const router = useRouter();

  return (
    <View style={[styles.sidebar, { paddingTop: insets.top + spacing.md, paddingBottom: insets.bottom + spacing.md }]}>
      {/* Logo */}
      <View style={styles.sidebarBrand}>
        <Image
          source={require('../assets/icon.png')}
          style={styles.sidebarLogo}
          resizeMode="contain"
        />
        <Text style={styles.sidebarBrandText}>OneShetland</Text>
      </View>

      <View style={styles.sidebarDivider} />

      {/* Nav items */}
      <View style={{ flex: 1, gap: 4 }}>
        {state.routes.map((route, index) => {
          const { options } = descriptors[route.key];
          // Skip hidden/utility routes (href: null) and any route that
          // doesn't define a tab icon (e.g. `services`, `me`).
          if (options.href === null || options.tabBarIcon == null) return null;

          const focused = state.index === index;
          const label   = typeof options.tabBarLabel === 'string'
            ? options.tabBarLabel
            : options.title ?? route.name;
          const itemColor = (options.tabBarActiveTintColor as string) ?? colors.accent;

          const onPress = () => {
            const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
            if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
          };

          return (
            <TouchableOpacity
              key={route.key}
              style={[styles.sidebarItem, focused && styles.sidebarItemActive]}
              onPress={onPress}
              activeOpacity={0.7}
            >
              <View style={[styles.navChip, { backgroundColor: focused ? itemColor : itemColor + '26' }]}>
                {options.tabBarIcon?.({ focused, color: focused ? '#fff' : itemColor, size: 14 })}
              </View>
              <Text style={[styles.sidebarLabel, focused && styles.sidebarLabelActive]}>{label}</Text>
              {focused ? <View style={[styles.activeDot, { backgroundColor: itemColor }]} /> : null}
            </TouchableOpacity>
          );
        })}

        {/* Games + Hubs live outside the tab group — link explicitly */}
        <TouchableOpacity style={styles.sidebarItem} onPress={() => router.push('/games')} activeOpacity={0.7}>
          <View style={[styles.navChip, { backgroundColor: '#10B981' + '26' }]}>
            <FontAwesome5 name="gamepad" size={14} color="#10B981" solid />
          </View>
          <Text style={styles.sidebarLabel}>Games</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.sidebarItem} onPress={() => router.push('/hubs')} activeOpacity={0.7}>
          <View style={[styles.navChip, { backgroundColor: '#6B47BF' + '26' }]}>
            <FontAwesome5 name="users" size={14} color="#6B47BF" solid />
          </View>
          <Text style={styles.sidebarLabel}>Hubs</Text>
        </TouchableOpacity>
      </View>

      {/* Today's game — fills the space below the nav on tablet */}
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

// ── Bottom bar (iPhone) ────────────────────────────────────────────────────────

function BottomTabBar({ state, descriptors, navigation, insets }: BottomTabBarProps & { insets: any }) {
  return (
    <View style={[styles.bottomBar, { height: 60 + insets.bottom, paddingBottom: insets.bottom }]}>
      {state.routes.map((route, index) => {
        const { options } = descriptors[route.key];
        if (options.href === null) return null;

        const focused = state.index === index;
        const label   = typeof options.tabBarLabel === 'string'
          ? options.tabBarLabel
          : options.title ?? route.name;
        const color   = focused
          ? (options.tabBarActiveTintColor as string ?? colors.accent)
          : INACTIVE;

        const onPress = () => {
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
        };

        return (
          <TouchableOpacity
            key={route.key}
            style={styles.bottomItem}
            onPress={onPress}
            activeOpacity={0.7}
          >
            {options.tabBarIcon?.({ focused, color, size: 15 })}
            <Text style={[styles.bottomLabel, { color }]}>{label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  // ── Sidebar ──────────────────────────────────────────────────────────────────
  sidebar: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
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
  sidebarItemActive: {
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
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
    paddingVertical: 6, gap: 3,
  },
  bottomLabel: { fontSize: 9, fontWeight: '600' },
});
