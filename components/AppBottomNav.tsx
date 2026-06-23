/**
 * AppBottomNav
 *
 * The same navigation as AppTabBar, but for STANDALONE (non-tab) screens such as
 * Hubs, Games and Cruise — so every "More" destination carries the main nav.
 *   iPhone → bottom bar (first 5 destinations + a "More" sheet).
 *   iPad   → the shared NavRail sidebar.
 *
 * Active state is derived from the current pathname (these screens aren't part of
 * the Tabs navigator, so there's no tab state to read). Navigation uses the
 * router, which routes correctly to both tab and standalone destinations.
 */
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import { useRouter, usePathname } from 'expo-router';
import { colors, spacing } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { NAV, PROFILE, PHONE_PRIMARY, isNavActive, type NavDest } from '@/constants/nav-model';
import { NavRail } from '@/components/NavRail';
import { Sheet } from '@/components/ui/Sheet';

const INACTIVE = 'rgba(255,255,255,0.55)';
const PRIMARY = NAV.slice(0, PHONE_PRIMARY);
const MORE_ITEMS = [...NAV.slice(PHONE_PRIMARY), PROFILE];

export function AppBottomNav() {
  const { isTablet } = useAppLayout();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  if (isTablet) return <NavRail />;

  const go = (item: NavDest) => router.navigate(item.href as never);
  const isActive = (item: NavDest) => isNavActive(item.href, pathname);
  const moreActive = MORE_ITEMS.some((i) => isActive(i));

  return (
    <View style={[styles.bottomBar, { height: 60 + insets.bottom, paddingBottom: insets.bottom }]}>
      {PRIMARY.map((item) => {
        const focused = isActive(item);
        return (
          <TouchableOpacity key={item.label} style={styles.bottomItem} onPress={() => go(item)} activeOpacity={0.7}>
            <View style={[styles.bottomChip, { backgroundColor: focused ? item.color : item.color + '26' }]}>
              <FontAwesome5 name={item.icon as any} size={15} color={focused ? '#fff' : item.color} solid />
            </View>
            <Text style={[styles.bottomLabel, { color: focused ? '#fff' : INACTIVE, fontWeight: focused ? '800' : '600' }]} numberOfLines={1}>{item.label}</Text>
          </TouchableOpacity>
        );
      })}

      <TouchableOpacity style={styles.bottomItem} onPress={() => setMoreOpen(true)} activeOpacity={0.7}>
        <View style={[styles.bottomChip, { backgroundColor: moreActive ? colors.accent : 'rgba(255,255,255,0.14)' }]}>
          <FontAwesome5 name="ellipsis-h" size={15} color={moreActive ? '#fff' : INACTIVE} solid />
        </View>
        <Text style={[styles.bottomLabel, { color: moreActive ? '#fff' : INACTIVE, fontWeight: moreActive ? '800' : '600' }]}>More</Text>
      </TouchableOpacity>

      <Sheet visible={moreOpen} onClose={() => setMoreOpen(false)} title="More">
        <View style={styles.moreGrid}>
          {MORE_ITEMS.map((item) => {
            const active = isActive(item);
            return (
              <TouchableOpacity key={item.label} style={styles.moreCell} onPress={() => { setMoreOpen(false); go(item); }} activeOpacity={0.8}>
                <View style={[styles.moreChip, { backgroundColor: active ? item.color : item.color + '1A' }]}>
                  <FontAwesome5 name={item.icon as any} size={20} color={active ? '#fff' : item.color} solid />
                </View>
                <Text style={styles.moreLabel} numberOfLines={1}>{item.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  bottomBar: { flexDirection: 'row', backgroundColor: colors.navy, borderTopWidth: 0 },
  bottomItem: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 5, gap: 3 },
  bottomChip: { minWidth: 42, height: 26, borderRadius: 9, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  bottomLabel: { fontSize: 10, fontWeight: '600' },
  moreGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  moreCell: { width: '25%', alignItems: 'center', gap: 7, marginBottom: spacing.lg },
  moreChip: { width: 54, height: 54, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  moreLabel: { fontSize: 12, fontWeight: '700', color: colors.textPrimary, textAlign: 'center' },
});
