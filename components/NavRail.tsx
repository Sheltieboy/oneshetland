/**
 * NavRail
 *
 * A standalone, persistent left navigation rail for tablet — the same look as
 * the sidebar shown inside the (tabs) navigator, but usable on standalone
 * stack screens (e.g. the business / admin dashboards) that live outside the
 * tab navigator and therefore can't use AppTabBar.
 *
 * Renders nothing on phones. On tablets it sits as an absolute full-height
 * rail on the left edge; pair it with `paddingLeft: SIDEBAR_WIDTH` on the
 * screen content so nothing sits underneath it.
 */

import React from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import { useRouter, usePathname, type Href } from 'expo-router';
import { colors, fontSize, spacing, radius, SIDEBAR_WIDTH } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';

const INACTIVE = 'rgba(255,255,255,0.55)';

interface NavItem {
  label:  string;
  icon:   string;
  color:  string;
  href:   Href;
}

// Mirrors the NAV model in AppTabBar so the standalone tablet rail matches the
// in-tab sidebar: Home · Events · Directory · Local · Jobs, then the rest.
const NAV_ITEMS: NavItem[] = [
  { label: 'Home',                  icon: 'home',                 color: colors.accent,           href: '/(tabs)' },
  { label: 'Events',                icon: SECTIONS.events.icon,   color: SECTIONS.events.color,   href: '/(tabs)/whats-on' },
  { label: 'Directory',             icon: SECTIONS.services.icon, color: SECTIONS.services.color, href: '/(tabs)/services' },
  { label: SECTIONS.local.label,    icon: SECTIONS.local.icon,    color: SECTIONS.local.color,    href: '/(tabs)/local' },
  { label: 'Jobs',                  icon: SECTIONS.jobs.icon,     color: SECTIONS.jobs.color,     href: '/(tabs)/jobs' },
  { label: SECTIONS.shifts.label,   icon: SECTIONS.shifts.icon,   color: SECTIONS.shifts.color,   href: '/(tabs)/jobs?tab=shifts' as Href },
  { label: SECTIONS.memories.label, icon: SECTIONS.memories.icon, color: SECTIONS.memories.color, href: '/(tabs)/memories' },
  { label: SECTIONS.spik.label,     icon: SECTIONS.spik.icon,     color: SECTIONS.spik.color,     href: '/(tabs)/spik' },
  { label: SECTIONS.daBoats.label,  icon: SECTIONS.daBoats.icon,  color: SECTIONS.daBoats.color,  href: '/(tabs)/da-boats' },
  { label: SECTIONS.fetch.label,    icon: SECTIONS.fetch.icon,    color: SECTIONS.fetch.color,    href: '/(tabs)/fetch' },
  { label: SECTIONS.community.label, icon: SECTIONS.community.icon, color: SECTIONS.community.color, href: '/hubs' },
  { label: SECTIONS.games.label,    icon: SECTIONS.games.icon,    color: SECTIONS.games.color,    href: '/games' },
];

export function NavRail() {
  const { isTablet } = useAppLayout();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();

  if (!isTablet) return null;

  const isActive = (href: Href) => {
    const h = String(href);
    if (h === '/(tabs)') return pathname === '/' || pathname === '/(tabs)';
    return pathname === h || pathname.startsWith(h + '/');
  };

  return (
    <View style={[styles.sidebar, { paddingTop: insets.top + spacing.md, paddingBottom: insets.bottom + spacing.md }]}>
      <View style={styles.sidebarBrand}>
        <Image source={require('../assets/icon.png')} style={styles.sidebarLogo} resizeMode="contain" />
        <Text style={styles.sidebarBrandText}>OneShetland</Text>
      </View>

      <View style={styles.sidebarDivider} />

      <View style={{ flex: 1, gap: 4 }}>
        {NAV_ITEMS.map(item => {
          const active = isActive(item.href);
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
      </View>
    </View>
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
});

