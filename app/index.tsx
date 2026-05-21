import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Image,
  Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { colors, fontSize, spacing, radius, shadow } from '@/constants/theme';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';

interface LiveRun {
  id: string;
  departure_start: string;
  departure_end: string;
  ferry_crossing: boolean;
  notes: string | null;
  categories_accepted: string[];
}

export default function LandingScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const [runs, setRuns] = useState<LiveRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);

  // Hero fade-in
  const heroOpacity = useRef(new Animated.Value(0)).current;
  const heroTranslate = useRef(new Animated.Value(12)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(heroOpacity, { toValue: 1, duration: 600, useNativeDriver: true }),
      Animated.spring(heroTranslate, { toValue: 0, speed: 14, bounciness: 2, useNativeDriver: true }),
    ]).start();

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
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero */}
        <View style={styles.hero}>
          <Animated.View style={{ opacity: heroOpacity, transform: [{ translateY: heroTranslate }] }}>
            <View style={styles.brandRow}>
              <View style={styles.logoCircle}>
                <Image
                  source={require('../assets/icon.png')}
                  style={styles.logoImage}
                  resizeMode="contain"
                />
              </View>
              <View style={styles.communityPill}>
                <View style={styles.liveDot} />
                <Text style={styles.communityText}>COMMUNITY DELIVERY</Text>
              </View>
            </View>

            <Text style={styles.headline}>
              Shetland{'\n'}delivers for{' '}
              <Text style={styles.headlineAccent}>itself.</Text>
            </Text>

            <Text style={styles.tagline}>
              Real deliveries, real neighbours. Request a collection or earn by helping your community.
            </Text>
          </Animated.View>

          {/* Stats strip */}
          <View style={styles.statsRow}>
            <View style={styles.stat}>
              <Text style={styles.statValue}>2min</Text>
              <Text style={styles.statLabel}>AVG MATCH</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.stat}>
              <Text style={styles.statValue}>Local</Text>
              <Text style={styles.statLabel}>DRIVERS</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.stat}>
              <Text style={styles.statValue}>Free</Text>
              <Text style={styles.statLabel}>TO JOIN</Text>
            </View>
          </View>
        </View>

        {/* CTAs */}
        <View style={styles.ctaSection}>
          {session ? (
            <Button
              label="Go to my dashboard"
              onPress={() => router.replace('/(customer)/dashboard')}
              variant="secondary"
              size="lg"
              fullWidth
            />
          ) : (
            <>
              <Button
                label="Request a Delivery"
                onPress={() => router.push('/(auth)/sign-in')}
                variant="secondary"
                size="lg"
                fullWidth
              />
              <View style={{ height: spacing.sm }} />
              <Button
                label="Become a Driver"
                onPress={() => router.push('/(auth)/sign-up')}
                variant="outline"
                size="lg"
                fullWidth
              />
              <TouchableOpacity
                onPress={() => router.push('/(auth)/sign-in')}
                style={styles.signInLink}
              >
                <Text style={styles.signInText}>
                  Already a member? <Text style={styles.signInBold}>Sign in</Text>
                </Text>
              </TouchableOpacity>
            </>
          )}
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
        </View>

        {/* Live runs */}
        <View style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>Runs available now</Text>
            <View style={styles.liveBadge}>
              <View style={styles.liveDotGreen} />
              <Text style={styles.liveBadgeText}>Live</Text>
            </View>
          </View>
          <Text style={styles.sectionSub}>Sign in to book a collection on one of these runs.</Text>

          {loadingRuns ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyText}>Loading runs…</Text>
            </Card>
          ) : runs.length === 0 ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyText}>⛵ No runs right now — check back soon.</Text>
            </Card>
          ) : (
            runs.map((run) => {
              const start = new Date(run.departure_start);
              const end = new Date(run.departure_end);
              const today = new Date();
              const tomorrow = new Date(today);
              tomorrow.setDate(today.getDate() + 1);
              const isToday = start.toDateString() === today.toDateString();
              const isTomorrow = start.toDateString() === tomorrow.toDateString();
              const dayLabel = isToday ? 'Today' : isTomorrow ? 'Tomorrow' : start.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
              const timeRange = `${start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} – ${end.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
              const noteLines = (run.notes ?? '').split('\n');
              const origin = noteLines.find((l) => l.startsWith('Origin:'))?.replace('Origin: ', '') ?? 'Lerwick';
              const destination = noteLines.find((l) => l.startsWith('Destination:'))?.replace('Destination: ', '') ?? '—';

              return (
                <Card key={run.id} style={styles.runCard}>
                  <View style={styles.runHeader}>
                    <Text style={styles.runRoute}>{origin} → {destination}</Text>
                    {run.ferry_crossing && (
                      <View style={styles.ferryBadge}>
                        <Text style={styles.ferryText}>⛴ Ferry</Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.runTime}>{dayLabel}, {timeRange}</Text>
                  {run.categories_accepted?.length > 0 && (
                    <View style={styles.runCategoryRow}>
                      {run.categories_accepted.slice(0, 3).map((cat) => (
                        <View key={cat} style={styles.runCategoryChip}>
                          <Text style={styles.runCategoryText}>{cat}</Text>
                        </View>
                      ))}
                      {run.categories_accepted.length > 3 && (
                        <Text style={styles.runCategoryMore}>+{run.categories_accepted.length - 3} more</Text>
                      )}
                    </View>
                  )}
                  <Button
                    label="Sign in to book"
                    onPress={() => router.push('/(auth)/sign-in')}
                    variant="secondary"
                    size="sm"
                    style={styles.bookButton}
                  />
                </Card>
              );
            })
          )}
        </View>

        {/* How it works */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>How it works</Text>
          {[
            { step: '1', title: 'Create a request', body: "Tell us what needs collecting, where from, and where it's going." },
            { step: '2', title: 'A driver picks it up', body: 'A local driver already heading that way collects your item.' },
            { step: '3', title: 'Delivered to your door', body: "You're notified when it's on its way and when it arrives." },
          ].map((item) => (
            <View key={item.step} style={styles.howStep}>
              <View style={styles.stepNumber}>
                <Text style={styles.stepNumberText}>{item.step}</Text>
              </View>
              <View style={styles.stepBody}>
                <Text style={styles.stepTitle}>{item.title}</Text>
                <Text style={styles.stepText}>{item.body}</Text>
              </View>
            </View>
          ))}
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>OneShetland Fetch · Goods only · No alcohol, tobacco, or passengers</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  scroll: { flex: 1, backgroundColor: colors.screenBackground },
  content: { paddingBottom: spacing.xxl },

  // Hero
  hero: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: 0,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  logoCircle: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoImage: { width: 40, height: 40, borderRadius: 10 },
  communityPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(18,179,214,0.15)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: 'rgba(18,179,214,0.3)',
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.accent,
  },
  communityText: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
  },
  headline: {
    color: colors.white,
    fontSize: 38,
    fontWeight: '800',
    lineHeight: 44,
    letterSpacing: -0.5,
    marginBottom: spacing.md,
  },
  headlineAccent: {
    color: colors.accent,
  },
  tagline: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: fontSize.md,
    lineHeight: 22,
    marginBottom: spacing.xl,
  },

  // Stats
  statsRow: {
    flexDirection: 'row',
    backgroundColor: colors.darkSurface,
    marginHorizontal: -spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.darkBorder,
  },
  stat: { flex: 1, alignItems: 'center' },
  statValue: {
    color: colors.accent,
    fontSize: fontSize.lg,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  statLabel: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
    marginTop: 2,
  },
  statDivider: {
    width: 1,
    backgroundColor: colors.darkBorder,
    marginVertical: 4,
  },

  // CTAs
  ctaSection: {
    padding: spacing.lg,
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  signInLink: { alignItems: 'center', marginTop: spacing.md },
  signInText: { color: colors.textMuted, fontSize: fontSize.sm },
  signInBold: { color: colors.navy, fontWeight: '600' },

  // Sections
  section: { padding: spacing.lg },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  sectionTitle: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: spacing.sm,
    letterSpacing: -0.2,
  },
  sectionSub: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    marginBottom: spacing.md,
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.successLight,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.full,
    marginBottom: spacing.sm,
  },
  liveDotGreen: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.success,
  },
  liveBadgeText: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.successDark,
  },

  // Category chips
  categoryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  categoryChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.white,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.xs,
  },
  categoryIcon: { fontSize: 15 },
  categoryLabel: { fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: '500' },

  // Empty
  emptyCard: { padding: spacing.md },
  emptyText: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },

  // Run cards
  runCard: { marginBottom: spacing.sm },
  runHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  runRoute: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.textPrimary,
    flex: 1,
    letterSpacing: -0.2,
  },
  ferryBadge: {
    backgroundColor: colors.infoLight,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  ferryText: { fontSize: fontSize.xs, color: colors.infoDark, fontWeight: '600' },
  runTime: { fontSize: fontSize.sm, color: colors.textMuted, marginBottom: spacing.sm },
  runCategoryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginBottom: spacing.sm },
  runCategoryChip: {
    backgroundColor: colors.offWhite,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  runCategoryText: { fontSize: fontSize.xs, color: colors.textMuted },
  runCategoryMore: { fontSize: fontSize.xs, color: colors.textLight, alignSelf: 'center' },
  bookButton: { alignSelf: 'flex-start' },

  // How it works
  howStep: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.md },
  stepNumber: {
    width: 32,
    height: 32,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    ...shadow.accent,
  },
  stepNumberText: { color: colors.white, fontWeight: '800', fontSize: fontSize.sm },
  stepBody: { flex: 1 },
  stepTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.textPrimary, marginBottom: 4 },
  stepText: { fontSize: fontSize.sm, color: colors.textMuted, lineHeight: 20 },

  // Footer
  footer: { padding: spacing.lg, alignItems: 'center' },
  footerText: { fontSize: fontSize.xs, color: colors.textLight, textAlign: 'center' },
});
