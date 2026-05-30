/**
 * (tabs)/fetch.tsx
 *
 * Public-facing Fetch hub.
 * - Signed-in users with a role → routed straight into their dashboard
 * - Anyone else → sees a friendly intro to Fetch with a "Sign in to request" CTA
 */

import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import { TabScreenHeader } from '@/components/TabScreenHeader';
import { supabase } from '@/lib/supabase';

interface LiveRun {
  id: string;
  departure_start: string;
  departure_end: string;
  ferry_crossing: boolean;
  notes: string | null;
  categories_accepted: string[];
}

const S = SECTIONS.fetch;

export default function FetchTab() {
  const router = useRouter();
  const { profile, loading } = useAuth();
  const [runs, setRuns]             = useState<LiveRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);

  // Signed-in users get routed straight to their role's dashboard.
  // Non-signed-in users stay here and see the hub.
  useEffect(() => {
    if (loading || !profile) return;
    if (profile.role === 'admin' || profile.role === 'moderator') {
      router.replace('/(admin)/dashboard');
    } else if (profile.role === 'driver') {
      router.replace('/(driver)/dashboard');
    } else {
      router.replace('/(customer)/dashboard');
    }
  }, [profile, loading]);

  // Always fetch upcoming runs so non-signed-in users see what's available
  useEffect(() => {
    const now = new Date().toISOString();
    supabase
      .from('runs')
      .select('id, departure_start, departure_end, ferry_crossing, notes, categories_accepted')
      .eq('status', 'open')
      .gte('departure_end', now)
      .order('departure_start', { ascending: true })
      .limit(5)
      .then(({ data }) => {
        setRuns((data as LiveRun[]) ?? []);
        setLoadingRuns(false);
      });
  }, []);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <TabScreenHeader
        section={S}
        right={
          <View style={[styles.headerBadge, { backgroundColor: S.color + '22' }]}>
            <View style={[styles.headerBadgeDot, { backgroundColor: S.color }]} />
            <Text style={[styles.headerBadgeText, { color: S.color }]}>Live</Text>
          </View>
        }
      />

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* Hero card */}
        <View style={[styles.heroCard, { backgroundColor: S.color }]}>
          <View style={styles.heroIconWrap}>
            <FontAwesome5 name="shipping-fast" size={28} color="#fff" solid />
          </View>
          <Text style={styles.heroTitle}>Community delivery</Text>
          <Text style={styles.heroSub}>
            Need something collected from Lerwick? Have something to drop off across the isles? Fetch matches you with local drivers already heading that way.
          </Text>
        </View>

        {/* Runs available now */}
        <View style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>Runs available now</Text>
            {runs.length > 0 && (
              <View style={styles.liveCount}>
                <View style={styles.liveCountDot} />
                <Text style={styles.liveCountText}>{runs.length}</Text>
              </View>
            )}
          </View>

          {loadingRuns ? (
            <View style={styles.runEmpty}>
              <ActivityIndicator color={S.color} size="small" />
            </View>
          ) : runs.length === 0 ? (
            <View style={styles.runEmpty}>
              <FontAwesome5 name="anchor" size={20} color={colors.textLight} />
              <Text style={styles.runEmptyText}>No runs scheduled right now</Text>
              <Text style={styles.runEmptySub}>Check back soon — drivers post runs throughout the day.</Text>
            </View>
          ) : (
            <View style={{ gap: 8 }}>
              {runs.map((run) => {
                const start = new Date(run.departure_start);
                const end   = new Date(run.departure_end);
                const today    = new Date();
                const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
                const isToday    = start.toDateString() === today.toDateString();
                const isTomorrow = start.toDateString() === tomorrow.toDateString();
                const dayLabel = isToday ? 'Today' : isTomorrow ? 'Tomorrow' : start.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
                const timeRange = `${start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} – ${end.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
                const noteLines   = (run.notes ?? '').split('\n');
                const origin      = noteLines.find((l) => l.startsWith('Origin:'))?.replace('Origin: ', '') ?? 'Lerwick';
                const destination = noteLines.find((l) => l.startsWith('Destination:'))?.replace('Destination: ', '') ?? '—';

                return (
                  <TouchableOpacity
                    key={run.id}
                    style={styles.runCard}
                    onPress={() => router.push('/(auth)/sign-in')}
                    activeOpacity={0.85}
                  >
                    <View style={styles.runCardTop}>
                      <Text style={styles.runRoute} numberOfLines={1}>{origin} → {destination}</Text>
                      {run.ferry_crossing && (
                        <View style={styles.ferryBadge}>
                          <FontAwesome5 name="ship" size={9} color={colors.navy} solid />
                          <Text style={styles.ferryText}>Ferry</Text>
                        </View>
                      )}
                    </View>
                    <Text style={styles.runTime}>{dayLabel} · {timeRange}</Text>
                    {run.categories_accepted?.length > 0 && (
                      <View style={styles.runCatRow}>
                        {run.categories_accepted.slice(0, 4).map((cat) => (
                          <View key={cat} style={styles.runCat}>
                            <Text style={styles.runCatText}>{cat}</Text>
                          </View>
                        ))}
                        {run.categories_accepted.length > 4 && (
                          <Text style={styles.runCatMore}>+{run.categories_accepted.length - 4}</Text>
                        )}
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        </View>

        {/* How it works */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>How it works</Text>
          {[
            { icon: 'edit', title: 'Create a request', body: 'Tell us what needs collecting, where from, and where it\'s going.' },
            { icon: 'car', title: 'A driver picks it up', body: 'A local driver already heading that way collects your item.' },
            { icon: 'box-open', title: 'Delivered to your door', body: 'You\'re notified when it\'s on its way and when it arrives.' },
          ].map((item, i) => (
            <View key={i} style={styles.howStep}>
              <View style={[styles.howStepLeft, { backgroundColor: S.light }]}>
                <FontAwesome5 name={item.icon as any} size={13} color={S.color} solid />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.howStepTitle}>{item.title}</Text>
                <Text style={styles.howStepText}>{item.body}</Text>
              </View>
            </View>
          ))}
        </View>

        {/* CTAs */}
        <View style={styles.ctaSection}>
          <TouchableOpacity
            style={[styles.primaryBtn, { backgroundColor: S.color }]}
            onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); router.push('/(auth)/sign-in'); }}
            activeOpacity={0.85}
          >
            <FontAwesome5 name="paper-plane" size={14} color="#fff" solid />
            <Text style={styles.primaryBtnText}>Sign in to request a delivery</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={() => router.push('/(auth)/sign-up')}
            activeOpacity={0.75}
          >
            <Text style={styles.secondaryBtnText}>
              Want to drive and earn? <Text style={[styles.secondaryBtnLink, { color: S.color }]}>Become a driver</Text>
            </Text>
          </TouchableOpacity>
        </View>

        {/* What we deliver */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>What we deliver</Text>
          <View style={styles.categoryGrid}>
            {[
              { icon: '🍕', label: 'Takeaway' },
              { icon: '💊', label: 'Pharmacy' },
              { icon: '📦', label: 'Parcels' },
              { icon: '🛍️', label: 'Shopping' },
              { icon: '🛒', label: 'Click & collect' },
              { icon: '📫', label: 'Other' },
            ].map((item) => (
              <View key={item.label} style={styles.categoryChip}>
                <Text style={styles.categoryIcon}>{item.icon}</Text>
                <Text style={styles.categoryLabel}>{item.label}</Text>
              </View>
            ))}
          </View>
          <Text style={styles.fineprint}>
            Goods only. No alcohol, tobacco, or passengers.
          </Text>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: colors.navy },
  scroll:  { flex: 1, backgroundColor: colors.screenBackground },
  content: { paddingBottom: 40 },

  headerBadge:     { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.full },
  headerBadgeDot:  { width: 6, height: 6, borderRadius: 3 },
  headerBadgeText: { fontSize: 11, fontWeight: '700' },

  // Hero
  heroCard: {
    margin: spacing.md, padding: spacing.lg,
    borderRadius: radius.xl, gap: 10,
    shadowColor: S.color, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25, shadowRadius: 12, elevation: 4,
  },
  heroIconWrap: {
    width: 56, height: 56, borderRadius: radius.lg,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 4,
  },
  heroTitle: { color: '#fff', fontSize: fontSize.xl, fontWeight: '900', letterSpacing: -0.4 },
  heroSub:   { color: 'rgba(255,255,255,0.85)', fontSize: fontSize.sm, lineHeight: 22 },

  // Section
  section:          { paddingHorizontal: spacing.md, marginTop: spacing.lg },
  sectionTitle:     { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary, marginBottom: 12 },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },

  // Runs
  liveCount:      { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#DCFCE7', paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full, marginBottom: 12 },
  liveCountDot:   { width: 5, height: 5, borderRadius: 3, backgroundColor: '#22C55E' },
  liveCountText:  { fontSize: 10, fontWeight: '800', color: '#15803D' },

  runCard: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: 12, gap: 4,
    borderLeftWidth: 3, borderLeftColor: S.color,
    borderWidth: 1, borderColor: colors.border,
  },
  runCardTop:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  runRoute:     { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary, flex: 1 },
  ferryBadge:   { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#DBEAFE', paddingHorizontal: 7, paddingVertical: 3, borderRadius: radius.full },
  ferryText:    { fontSize: 10, fontWeight: '800', color: colors.navy },
  runTime:      { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600' },
  runCatRow:    { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 4, alignItems: 'center' },
  runCat:       { backgroundColor: S.light, paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.full },
  runCatText:   { fontSize: 10, fontWeight: '700', color: S.color },
  runCatMore:   { fontSize: 10, color: colors.textLight, fontWeight: '600' },

  runEmpty:     { paddingVertical: 24, alignItems: 'center', gap: 6, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border },
  runEmptyText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  runEmptySub:  { fontSize: fontSize.xs, color: colors.textMuted, textAlign: 'center', paddingHorizontal: spacing.md },

  // How it works
  howStep:      { flexDirection: 'row', gap: 14, marginBottom: spacing.md, alignItems: 'flex-start' },
  howStepLeft:  { width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  howStepTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary, marginBottom: 2 },
  howStepText:  { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 18 },

  // CTAs
  ctaSection: { paddingHorizontal: spacing.md, marginTop: spacing.md, gap: spacing.sm },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    height: 54, borderRadius: radius.lg,
  },
  primaryBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
  secondaryBtn:   { alignItems: 'center', paddingVertical: 8 },
  secondaryBtnText: { color: colors.textMuted, fontSize: fontSize.sm },
  secondaryBtnLink: { fontWeight: '800' },

  // Categories
  categoryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  categoryChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#fff', paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: radius.full, borderWidth: 1, borderColor: colors.border,
  },
  categoryIcon:  { fontSize: 14 },
  categoryLabel: { fontSize: fontSize.xs, color: colors.textPrimary, fontWeight: '700' },

  fineprint: { fontSize: fontSize.xs, color: colors.textLight, marginTop: spacing.md, textAlign: 'center' },
});
