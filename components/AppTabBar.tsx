/**
 * AppTabBar
 *
 * Adaptive navigation built from the single shared NAV model (constants/nav-model):
 *   iPhone → bottom bar with the first 5 destinations + a "More" sheet holding
 *            the rest (Memories, Spik, Da Boats, Fetch, Hubs, Games, Profile).
 *   iPad   → the shared NavRail sidebar (the SAME sidebar standalone screens use,
 *            so the tablet nav is identical everywhere).
 *
 * Passed as the `tabBar` prop on the Tabs navigator in app/(tabs)/_layout.tsx.
 */

import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
} from 'react-native';
import { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { colors, spacing } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { NAV, PROFILE, PHONE_PRIMARY, type NavDest } from '@/constants/nav-model';
import { NavRail } from '@/components/NavRail';
import { Sheet } from '@/components/ui/Sheet';

const INACTIVE = 'rgba(255,255,255,0.55)';

const PRIMARY    = NAV.slice(0, PHONE_PRIMARY);
const MORE_ITEMS = [...NAV.slice(PHONE_PRIMARY), PROFILE];

export function AppTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const { isTablet } = useAppLayout();
  const insets       = useSafeAreaInsets();

  // Tablet uses the same NavRail sidebar that standalone screens render, so the
  // tablet navigation is identical on every screen.
  if (isTablet) return <NavRail />;

  return <BottomTabBar state={state} descriptors={descriptors} navigation={navigation} insets={insets} />;
}

// ── Bottom bar (iPhone) ──────────────────────────────────────────────────────

function BottomTabBar({ state, navigation, insets }: BottomTabBarProps & { insets: any }) {
  const router = useRouter();
  const [moreOpen, setMoreOpen] = useState(false);
  const focusedName = state.routes[state.index]?.name;

  const go = (item: NavDest) => {
    if (item.route) navigation.navigate(item.route as never);
    else router.push(item.href);
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

const styles = StyleSheet.create({
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
