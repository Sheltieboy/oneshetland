/**
 * NavRail
 *
 * The ONE canonical persistent left sidebar for tablet. Rendered both inside
 * the tab navigator (AppTabBar returns it on tablet) and on standalone stack
 * screens (dashboards, hubs, games, boat…) — so every screen shows the exact
 * same sidebar from the shared nav model. Renders nothing on phones.
 *
 * On tablets it sits as an absolute full-height rail on the left edge; pair it
 * with `paddingLeft: SIDEBAR_WIDTH` on standalone screen content (the (tabs)
 * navigator does this for tab scenes via its sceneStyle).
 */

import React from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Image, ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import { useRouter, usePathname } from 'expo-router';
import { colors, fontSize, spacing, radius, SIDEBAR_WIDTH } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { NAV, PROFILE, isNavActive } from '@/constants/nav-model';
import { GameArt } from '@/components/GameArt';

const ITEMS = [...NAV, PROFILE];

export function NavRail() {
  const { isTablet } = useAppLayout();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();

  if (!isTablet) return null;

  return (
    <View style={[styles.sidebar, { paddingTop: insets.top + spacing.md, paddingBottom: insets.bottom + spacing.md }]}>
      <View style={styles.sidebarBrand}>
        <Image source={require('../assets/icon.png')} style={styles.sidebarLogo} resizeMode="contain" />
        <Text style={styles.sidebarBrandText}>OneShetland</Text>
      </View>

      <View style={styles.sidebarDivider} />

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 4 }} showsVerticalScrollIndicator={false}>
        {ITEMS.map(item => {
          const active = isNavActive(item.href, pathname);
          return (
            <TouchableOpacity
              key={item.label}
              style={[styles.sidebarItem, active && styles.sidebarItemActive]}
              onPress={() => router.push(item.href)}
              activeOpacity={0.7}
            >
              <View style={[styles.navChip, { backgroundColor: active ? item.color : item.color + '26' }]}>
                <FontAwesome5 name={item.icon as any} size={14} color={active ? '#fff' : item.color} solid />
              </View>
              <Text style={[styles.sidebarLabel, active ? styles.sidebarLabelActive : null]}>{item.label}</Text>
              {active ? <View style={[styles.activeDot, { backgroundColor: item.color }]} /> : null}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <TodaysGameTile />
    </View>
  );
}

// Compact "Today's game" card pinned to the sidebar's lower space.
function TodaysGameTile() {
  const router = useRouter();
  const idx = new Date().getDate() % 4;
  const cfg = [
    { gid: 'spik_sprint'   as const, title: 'Spik Sprint',   sub: '60 seconds',                 path: '/games' as const },
    { gid: 'guess_da_wird' as const, title: 'Guess Da Wird', sub: "Today's Shetlandic word",     path: '/games/guess-da-wird' as const },
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
  sidebar: {
    position: 'absolute',
    left: 0, top: 0, bottom: 0,
    width: SIDEBAR_WIDTH,
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
});
