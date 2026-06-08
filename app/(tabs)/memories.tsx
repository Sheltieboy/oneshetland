/**
 * app/memories.tsx
 *
 * The Memories section landing page — a living map of Shetland covered
 * in rose-pink pins, one per memory. Tap a pin to open the memory; tap
 * empty water/land to drop a new memory at that lat/lng. Below the map
 * is a feed of the most recent memories across the islands.
 *
 * Designed so it can also be reached as a tab once the tabs layout adds
 * a "memories" tab (wiring left as a follow-up to avoid colliding with
 * an in-flight uncommitted edit to that file).
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator,
  TouchableOpacity, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Stack, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { SECTIONS } from '@/constants/sections';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { useAuth } from '@/context/AuthContext';
import { VIEW_BOUNDS } from '@/lib/shetland-geometry';
import {
  fetchMemoryPins, MemoryPin,
} from '@/lib/memories-api';
import MemoryMapNative from '@/components/MemoryMapNative';
import MemoryCard from '@/components/MemoryCard';

const SECTION = SECTIONS.memories;

export default function MemoriesScreen() {
  const router = useRouter();
  const { profile } = useAuth();

  const [pins, setPins]       = useState<MemoryPin[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchMemoryPins({
        minLat: VIEW_BOUNDS.minLat,
        maxLat: VIEW_BOUNDS.maxLat,
        minLng: VIEW_BOUNDS.minLng,
        maxLng: VIEW_BOUNDS.maxLng,
      });
      setPins(data);
    } catch {
      // Surface to UI? For now silently empty — the empty state is OK to show.
      setPins([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Reload on every focus — coming back from creating a memory should show it.
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  useEffect(() => { void load(); }, [load]);

  const onPinTap = (pin: MemoryPin) => {
    setSelectedId(pin.id);
    router.push(`/memory/${pin.id}`);
  };

  const onDropPin = (point: { lat: number; lng: number }) => {
    if (!profile?.id) {
      router.push('/(auth)/sign-in');
      return;
    }
    router.push({
      pathname: '/memory-new',
      params: { lat: String(point.lat), lng: String(point.lng) },
    });
  };

  const recent = pins.slice(0, 12);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); void load(); }}
            tintColor={SECTION.color}
          />
        }
      >
        {/* ── Hero header ─────────────────────────────────────────────── */}
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.eyebrow}>The living map</Text>
            <Text style={styles.title}>Memories</Text>
          </View>
          <View style={[styles.iconBadge, { backgroundColor: SECTION.light }]}>
            <FontAwesome5 name={SECTION.icon} size={20} color={SECTION.color} />
          </View>
        </View>

        <Text style={styles.intro}>
          Drop a pin anywhere on Shetland. Write a story, leave a voice note,
          attach a photo or a film. Ask the community to help you remember.
        </Text>

        {/* ── The map ─────────────────────────────────────────────────── */}
        <View style={styles.mapWrap}>
          {loading ? (
            <View style={styles.mapLoading}>
              <ActivityIndicator color={SECTION.color} />
            </View>
          ) : (
            <MemoryMapNative
              pins={pins}
              onOpenPin={onPinTap}
              onDropPin={onDropPin}
              selectedId={selectedId}
              height={460}
            />
          )}
        </View>

        {/* CTA underneath the map */}
        <TouchableOpacity
          onPress={() => router.push('/memory-new')}
          style={[styles.dropCta, { backgroundColor: SECTION.color }]}
        >
          <FontAwesome5 name="plus" size={14} color="#fff" />
          <Text style={styles.dropCtaText}>Add a memory</Text>
        </TouchableOpacity>

        {/* ── Recent feed ─────────────────────────────────────────────── */}
        <Text style={styles.sectionHeading}>Latest from the islands</Text>

        {recent.length === 0 && !loading ? (
          <View style={styles.empty}>
            <FontAwesome5 name="book-open" size={28} color={SECTION.color} />
            <Text style={styles.emptyTitle}>No memories yet</Text>
            <Text style={styles.emptyBody}>
              Be the first. Tap anywhere on the map above to drop a pin and start a memory.
            </Text>
          </View>
        ) : (
          <View style={styles.feed}>
            {recent.map(pin => (
              <MemoryCard
                key={pin.id}
                pin={pin}
                onPress={() => router.push(`/memory/${pin.id}`)}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.screenBackground,
  },
  scroll: {
    paddingBottom: spacing.xxl,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.md,
  },
  backBtn: {
    width: 36, height: 36, alignItems: 'center', justifyContent: 'center',
    borderRadius: 18,
  },
  eyebrow: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: SECTION.color,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  title: {
    fontSize: 28,
    fontWeight: '900',
    color: colors.textPrimary,
    marginTop: 2,
  },
  iconBadge: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
  },
  intro: {
    paddingHorizontal: spacing.lg,
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    lineHeight: 19,
    marginBottom: spacing.lg,
  },
  mapWrap: {
    paddingHorizontal: spacing.lg,
  },
  mapLoading: {
    height: 460,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#DCEEFF',
    borderRadius: 12,
  },
  dropCta: {
    marginTop: spacing.md,
    marginHorizontal: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    gap: 10,
  },
  dropCtaText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: fontSize.md,
  },
  sectionHeading: {
    marginTop: spacing.xl,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    fontSize: fontSize.lg,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  feed: {
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  empty: {
    margin: spacing.lg,
    padding: spacing.lg,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emptyTitle: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  emptyBody: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 19,
  },
});
